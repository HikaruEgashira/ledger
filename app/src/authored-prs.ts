#!/usr/bin/env bun
// Sync the authenticated user's own open PRs into authored_prs.jsonl (separate from the review ledger).
import { renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { org } from "./lib/org.ts";
import { exec } from "./lib/util.ts";

export const AUTHORED_LEDGER = join(resolve(import.meta.dir, "../.."), "authored_prs.jsonl");
const QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 10, after: $cursor) {
    nodes {
      ... on PullRequest {
        url number title isDraft createdAt updatedAt headRefOid
        author { login }
        repository { nameWithOwner }
        mergeable mergeStateStatus reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Fine-grained reason; the board groups it into GitHub-style review states.
export type Reason = "mergeable" | "draft" | "conflicting" | "changes_requested" | "ci_failed" | "waiting_ci" | "review_required" | "blocked";
export type AuthoredStatus = "mine_ready_to_merge" | "mine_changes_requested" | "mine_review_requested";
const AUTHOR_ACTION = new Set<Reason>(["draft", "conflicting", "changes_requested", "ci_failed"]);
export const ball = (r: Reason): AuthoredStatus =>
  r === "mergeable" ? "mine_ready_to_merge" : AUTHOR_ACTION.has(r) ? "mine_changes_requested" : "mine_review_requested";
export interface AuthoredRow {
  url: string;
  repository: string;
  pr_number: number;
  title: string;
  author: string;
  status: AuthoredStatus;
  reason: Reason;
  head_sha: string;
  mergeable: string;
  merge_state: string;
  review_decision: string | null;
  checks: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

// CLEAN/HAS_HOOKS means GitHub already evaluated branch protection as satisfied.
export function classify(n: { isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string | null; checks: string | null }): Reason {
  if (n.isDraft) return "draft";
  if (n.mergeable === "CONFLICTING" || n.mergeStateStatus === "DIRTY") return "conflicting";
  if (n.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (n.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(n.mergeStateStatus)) return "mergeable";
  if (n.checks === "FAILURE" || n.checks === "ERROR") return "ci_failed";
  if (n.checks === "PENDING" || n.checks === "EXPECTED") return "waiting_ci";
  if (n.reviewDecision === "REVIEW_REQUIRED") return "review_required";
  return "blocked";
}

export function toRow(n: any, now: string): AuthoredRow {
  const checks = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  const reason = classify({ ...n, checks });
  return {
    url: n.url,
    repository: n.repository.nameWithOwner,
    pr_number: n.number,
    title: n.title,
    author: n.author?.login ?? "",
    status: ball(reason),
    reason,
    head_sha: n.headRefOid,
    mergeable: n.mergeable,
    merge_state: n.mergeStateStatus,
    review_decision: n.reviewDecision ?? null,
    checks,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    synced_at: now,
  };
}

function fetchAll(): any[] {
  const out: any[] = [];
  let cursor: string | null = null;
  for (;;) {
    const args = ["gh", "api", "graphql", "-f", `query=${QUERY}`, "-F", `q=is:pr is:open author:@me archived:false org:${org()}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    let r = exec(args, { timeoutMs: 120_000 });
    for (let i = 0; r.code !== 0 && i < 5 && (r.timedOut || /HTTP 5\d\d|timeout/i.test(r.stderr)); i++) {
      Bun.sleepSync(2 ** i * 1000);
      r = exec(args, { timeoutMs: 120_000 });
    }
    if (r.code !== 0) throw new Error(`gh api graphql failed${r.timedOut ? " (timeout)" : ""}: ${r.stderr.trim()}`);
    const s = JSON.parse(r.stdout)?.data?.search;
    if (!s) throw new Error("unexpected GraphQL response");
    out.push(...s.nodes.filter((n: any) => n?.url));
    if (!s.pageInfo.hasNextPage) return out;
    cursor = s.pageInfo.endCursor;
  }
}

export function readAuthored(path = AUTHORED_LEDGER): AuthoredRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function sync(path: string): AuthoredRow[] {
  const now = new Date().toISOString();
  const rows = fetchAll().map((n) => toRow(n, now)).sort((a, b) => a.url.localeCompare(b.url));
  const tmp = join(dirname(path), `.tmp-authored-${process.pid}`);
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, path);
  return rows;
}

const VIEW = `
query($owner: String!, $repo: String!, $n: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    viewerDefaultMergeMethod
    pullRequest(number: $n) {
      url number title isDraft createdAt updatedAt headRefOid state
      author { login }
      repository { nameWithOwner }
      mergeable mergeStateStatus reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;
const METHOD: Record<string, string> = { MERGE: "--merge", SQUASH: "--squash", REBASE: "--rebase" };

export type MergeCheck = { ok: true; method: string } | { ok: false; reason: string };
// Merge only what is still the user's own, open, CLEAN PR at the exact head recorded in the list.
export function mergeCheck(row: AuthoredRow, live: any, viewer: string, defaultMethod: string): MergeCheck {
  if (!live || live.state !== "OPEN") return { ok: false, reason: `not open (${live?.state ?? "missing"})` };
  if (live.author?.login !== viewer) return { ok: false, reason: "not authored by viewer" };
  if (live.headRefOid !== row.head_sha) return { ok: false, reason: "head changed since sync" };
  const status = toRow(live, "").reason;
  if (status !== "mergeable") return { ok: false, reason: `live status ${status} (${live.mergeStateStatus})` };
  const method = METHOD[defaultMethod];
  if (!method) return { ok: false, reason: `unknown merge method ${defaultMethod}` };
  return { ok: true, method };
}

function gh(args: string[]): string {
  let r = exec(["gh", ...args], { timeoutMs: 120_000 });
  for (let i = 0; args[0] === "api" && r.code !== 0 && i < 3 && (r.timedOut || /HTTP 5\d\d|timeout/i.test(r.stderr)); i++) {
    Bun.sleepSync(2 ** i * 1000);
    r = exec(["gh", ...args], { timeoutMs: 120_000 });
  }
  if (r.code !== 0) throw new Error(`gh ${args[0]} failed${r.timedOut ? " (timeout)" : ""}: ${r.stderr.split("\n").filter((l) => !/WRN|ipg_check|agent-guard/.test(l)).join(" ").trim()}`);
  return r.stdout;
}

function merge(path: string, urls: string[], yes: boolean): number {
  const all = readAuthored(path);
  const targets = urls.length ? urls.map((u) => all.find((r) => r.url === u) ?? ({ url: u } as AuthoredRow)) : all.filter((r) => r.reason === "mergeable");
  let failed = 0;
  for (const row of targets) {
    if (!row.head_sha) {
      console.log(`skip\t${row.url}\tnot in authored list (run sync)`);
      failed++;
      continue;
    }
    const [owner, repo] = row.repository.split("/");
    let d: any;
    try {
      d = JSON.parse(gh(["api", "graphql", "-f", `query=${VIEW}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `n=${row.pr_number}`])).data;
    } catch (e) {
      console.log(`skip\t${row.url}\t${(e as Error).message}`);
      failed++;
      continue;
    }
    const c = mergeCheck(row, d.repository.pullRequest, d.viewer.login, d.repository.viewerDefaultMergeMethod);
    if (!c.ok) {
      console.log(`skip\t${row.url}\t${c.reason}`);
      failed++;
      continue;
    }
    if (!yes) {
      console.log(`would-merge\t${row.url}\t${c.method}\t${row.title}`);
      continue;
    }
    try {
      gh(["pr", "merge", row.url, c.method, "--match-head-commit", row.head_sha]);
      console.log(`merged\t${row.url}\t${c.method}`);
    } catch (e) {
      console.log(`fail\t${row.url}\t${(e as Error).message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ledger: { type: "string", default: AUTHORED_LEDGER }, all: { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
  });
  const cmd = positionals[0] ?? "list";
  if (!["sync", "list", "merge"].includes(cmd)) {
    console.error("usage: authored-prs.ts [--ledger PATH] {sync|list [--all]|merge [--yes] [URL...]}");
    process.exit(2);
  }
  if (cmd === "merge") process.exit(merge(values.ledger!, positionals.slice(1), values.yes!));
  const rows = cmd === "sync" ? sync(values.ledger!) : readAuthored(values.ledger!);
  for (const r of rows.filter((r) => values.all || r.reason === "mergeable")) console.log(`${r.reason}\t${r.url}\t${r.title}`);
}
