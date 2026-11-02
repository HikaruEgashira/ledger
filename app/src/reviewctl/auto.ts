// Deterministic review for PRs fully covered by an operator-defined rule in config/deterministic-review.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import {
  ReviewCtlError,
  type Obj,
} from "../lib/util.ts";
import { type Args, commandApprove, commandRecord } from "./commands.ts";
import { findRow, loadArtifact, printJson, readLedger, ROOT, runGh } from "./core.ts";

export interface Rule {
  repository: string;
  paths: string[];
  max_changed_lines: number;
  delivery: Obj;
}

export const RULES_PATH = join(ROOT, "config/deterministic-review.json");

export function loadRules(path = RULES_PATH): Rule[] {
  if (!existsSync(path)) return [];
  const rules = JSON.parse(readFileSync(path, "utf8")).rules;
  if (!Array.isArray(rules)) throw new ReviewCtlError("deterministic review rules must be a list");
  return rules;
}

export interface PrShape {
  repository: string;
  files: string[];
  changedLines: number;
}

export function matchRule(rules: Rule[], pr: PrShape): Rule | null {
  return (
    rules.find(
      (r) =>
        r.repository === pr.repository &&
        pr.files.length > 0 &&
        pr.changedLines <= r.max_changed_lines &&
        pr.files.every((f) => r.paths.some((p) => matchesGlob(f, p))),
    ) ?? null
  );
}

function gh(args: string[]): Obj {
  const result = runGh(args);
  if (result === "timeout" || result.returncode)
    throw new ReviewCtlError(`gh ${args[0]} failed during deterministic review`);
  return JSON.parse(result.stdout);
}

function prShape(url: string, repository: string): PrShape & Obj {
  const pr = gh(["pr", "view", url, "--json", "files,additions,deletions,updatedAt"]);
  return {
    repository,
    files: pr.files.map((f: Obj) => f.path),
    changedLines: pr.additions + pr.deletions,
    updatedAt: pr.updatedAt,
  };
}

function unresolvedThreads(url: string): number {
  const [, owner, repo, , number] = new URL(url).pathname.split("/");
  const data = gh([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `repo=${repo}`,
    "-F",
    `number=${number}`,
    "-f",
    "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}",
  ]);
  const threads = data.data.repository.pullRequest.reviewThreads;
  if (threads.totalCount > threads.nodes.length) return Number.POSITIVE_INFINITY;
  return threads.nodes.filter((t: Obj) => !t.isResolved).length;
}

function writeArtifact(row: Obj, rule: Rule, updatedAt: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rel = `review-artifacts/${row.repository.replace("/", "--")}--${row.pr_number}.json`;
  const artifact = {
    schema_version: 1,
    url: row.url,
    base_sha: row.live.baseRefOid,
    head_sha: row.live.headRefOid,
    reviewed_at: now,
    verdict: "approve",
    deterministic: true,
    coverage: {
      diff: "pass",
      security: "pass",
      tests: "not_applicable",
      test_evidence: [],
      tests_not_applicable_reason: "deterministic rule",
    },
    review_threads: { unresolved: 0, verified_at: now, method: "gh", pr_updated_at: updatedAt },
    findings: [],
    human_dispatch: { required: false, reason_code: null, detail: null },
    delivery: rule.delivery,
    notes: "deterministic rule",
  };
  writeFileSync(join(ROOT, rel), JSON.stringify(artifact, null, 2) + "\n");
  return rel;
}

/** Records evidence for one rule-covered PR; returns false when the agent must review it. */
function reviewOne(args: Args, url: string, rules: Rule[]): boolean {
  const row = findRow(readLedger(args.ledger), url);
  const shape = prShape(url, row.repository);
  const rule = matchRule(rules, shape);
  if (rule === null || unresolvedThreads(url) !== 0) return false;
  const existing = loadArtifact(row);
  if (existing?.deterministic !== true || existing.head_sha !== row.live.headRefOid)
    commandRecord({
      ledger: args.ledger,
      url,
      artifact: writeArtifact(row, rule, shape.updatedAt),
    });
  const current = findRow(readLedger(args.ledger), url);
  if (current.status !== "ready_to_approve" || !args.execute) return true;
  commandApprove({ ledger: args.ledger, url, execute: true });
  // Post-approval confirmation re-verifies threads against the new updatedAt.
  const after = prShape(url, row.repository);
  if (unresolvedThreads(url) !== 0) return true;
  commandRecord({
    ledger: args.ledger,
    url,
    artifact: writeArtifact(current, rule, after.updatedAt),
  });
  return true;
}

export function commandAutoReview(args: Args): void {
  const rules = loadRules();
  if (!rules.length) return;
  for (const row of readLedger(args.ledger)) {
    if (!["queued", "waiting_ci", "ready_to_approve"].includes(row.status) || !row.live) continue;
    try {
      if (reviewOne(args, row.url, rules)) printJson({ action: "deterministic", url: row.url });
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      printJson({ action: "deterministic_failed", url: row.url, error: e.message });
    }
  }
}
