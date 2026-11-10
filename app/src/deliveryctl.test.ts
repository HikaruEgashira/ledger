import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { completionGaps, main, setRoot } from "./deliveryctl.ts";
import {
  MINUTE,
  nowMicros,
  timestamp,
} from "./lib/util.ts";
import { deliveryPlanDigest, newRow, readLedger, writeLedger } from "./reviewctl/core.ts";

const URL = "https://github.com/example-org/x/pull/1";
const A = "a".repeat(40);
const B = "b".repeat(40);
const ago = (min: number) => timestamp(nowMicros() - min * MINUTE);

let root: string;
let ledger: string;
let out: string[];

function git(...args: string[]): string {
  return execFileSync("git", ["-C", join(root, "repositories/example-org/x"), ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function plan(mode: "github-actions" | "not_applicable") {
  return mode === "not_applicable"
    ? {
        release: { mode, reason: "docs only" },
        monitoring: { window_minutes: 30, signals: [] },
        recovery: { preferred_strategy: "not_applicable", procedure: [], verification: [], human_boundaries: [] },
      }
    : {
        release: { mode, identifier: "deploy", environment: "production" },
        monitoring: {
          window_minutes: 30,
          signals: [{ name: "errors", source: "siem", healthy_when: "low", failure_when: "high" }],
        },
        recovery: {
          preferred_strategy: "rollback",
          procedure: ["revert"],
          verification: ["check"],
          human_boundaries: ["irreversible-data-loss"],
        },
      };
}

function seed(mode: "github-actions" | "not_applicable", mergeSha: string, status = "merged_waiting_release", mergedMin = 180) {
  const p = plan(mode);
  const row = {
    ...newRow(URL, 50),
    status,
    approval: { base_sha: A, head_sha: B, delivery_plan: p, delivery_plan_sha256: deliveryPlanDigest(p) },
    delivery: { merge: { commit_sha: mergeSha, merged_at: ago(mergedMin) } },
  };
  writeLedger(ledger, [row]);
}

function receipt(name: string, body: object): string {
  const path = join(root, "delivery-artifacts", name);
  writeFileSync(path, JSON.stringify({ schema_version: 1, url: URL, ...body }));
  return path;
}

const run = (...argv: string[]) => main(["--ledger", ledger, ...argv]);
const lastJson = () => JSON.parse(out.at(-1)!);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "deliveryctl-")));
  ledger = join(root, "pull_requests.jsonl");
  setRoot(root);
  mkdirSync(join(root, "delivery-artifacts"));
  mkdirSync(join(root, "repositories/example-org/x"), { recursive: true });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "merge");
  git("commit", "-q", "--allow-empty", "-m", "release");
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1 $2" in\n"run view") cat "${root}/run.json";;\n"pr comment") echo "${URL}#issuecomment-1";;\n*) exit 1;;\nesac\n`,
  );
  chmodSync(gh, 0o755);
  process.env.REVIEWCTL_GH = gh;
  out = [];
  spyOn(process.stdout, "write").mockImplementation((s: unknown) => (out.push(String(s).trim()), true));
  spyOn(process.stderr, "write").mockImplementation((s: unknown) => (out.push(String(s).trim()), true));
});

afterEach(() => {
  mock.restore();
  delete process.env.REVIEWCTL_GH;
});

describe("deliveryctl", () => {
  it("completes a not_applicable delivery from due --auto", () => {
    seed("not_applicable", A);
    expect(run("due", "--auto")).toBe(0);
    expect(lastJson()).toEqual({ action: "completed", url: URL });
    expect(readLedger(ledger)[0].status).toBe("completed");
  });

  it("gives up monitoring deliveries merged more than 3 days ago", () => {
    seed("github-actions", A, "post_release_monitoring", 4 * 24 * 60);
    expect(run("due", "--auto")).toBe(0);
    expect(run("due")).toBe(0);
    expect(out).toEqual([]);
    expect(readLedger(ledger)[0].last_error).toContain("gave up");
  });

  it("records a GitHub Actions release and observation, then completes", () => {
    const merge = git("rev-parse", "HEAD~1");
    const release = git("rev-parse", "HEAD");
    seed("github-actions", merge);
    const runUrl = "https://github.com/example-org/x/actions/runs/7";
    const rel = { type: "release", merge_sha: merge, release_id: "7", release_attempt: 1, release_identifier: "deploy", environment: "production", commit_sha: release, release_url: runUrl, evidence: ["run"] };
    writeFileSync(join(root, "run.json"), JSON.stringify({ attempt: 1, conclusion: "success", databaseId: 7, headSha: release, status: "completed", url: runUrl, workflowName: "deploy" }));
    expect(run("record", URL, receipt("s.json", { ...rel, observed_at: ago(120), status: "started" }))).toBe(0);
    expect(readLedger(ledger)[0].status).toBe("release_in_progress");
    expect(run("record", URL, receipt("ok.json", { ...rel, observed_at: ago(100), status: "succeeded" }))).toBe(0);
    expect(readLedger(ledger)[0].status).toBe("post_release_monitoring");

    expect(run("complete", URL)).toBe(2);
    expect(lastJson().missing).toEqual(["latest post-release observation is not healthy"]);

    const obs = receipt("obs.json", {
      type: "observation", merge_sha: merge, observed_at: ago(50), phase: "post_release", status: "healthy",
      started_at: ago(95), ended_at: ago(55), log_source: "siem", issues: [],
      signals: [{ name: "errors", source: "siem", healthy: true, evidence: "flat" }],
    });
    expect(run("record", URL, obs)).toBe(0);
    expect(run("record", URL, obs)).toBe(0);
    expect(lastJson().action).toBe("already_recorded");
    expect(run("complete", URL)).toBe(0);
    expect(lastJson()).toEqual({ action: "completed", url: URL });
    expect(run("complete", URL)).toBe(0);
    expect(lastJson().action).toBe("already_completed");
    expect(run("due")).toBe(0);
  });

  it("rejects a release whose commit does not contain the merge", () => {
    const merge = git("rev-parse", "HEAD");
    const older = git("rev-parse", "HEAD~1");
    seed("github-actions", merge);
    writeFileSync(join(root, "run.json"), JSON.stringify({ attempt: 1, conclusion: "success", databaseId: 7, headSha: older, status: "completed", url: "u", workflowName: "deploy" }));
    const path = receipt("bad.json", { type: "release", merge_sha: merge, observed_at: ago(10), status: "succeeded", release_id: "7", release_attempt: 1, release_identifier: "deploy", environment: "production", commit_sha: older, release_url: "u", evidence: ["e"] });
    expect(run("record", URL, path)).toBe(1);
    expect(out.at(-1)).toBe("error: release commit does not contain the reviewed merge commit");
  });

  it("dry-runs and refuses non-workspace execution for dispatch", () => {
    seed("github-actions", A, "post_release_monitoring");
    expect(run("dispatch", URL, "--reviewer", "alice", "--reason-code", "irreversible-data-loss", "--detail", "d")).toBe(1);
    expect(out.at(-1)).toBe("error: recovery dispatch requires a current adverse event");
    const other = join(root, "other.jsonl");
    writeLedger(other, readLedger(ledger));
    expect(main(["--ledger", other, "dispatch", URL, "--reviewer", "alice", "--reason-code", "irreversible-data-loss", "--detail", "d", "--execute"])).toBe(1);
    expect(out.at(-1)).toBe("error: executed post-merge dispatch requires the workspace ledger");
    expect(run("reconcile-dispatch", URL, "--dispatch-sha256", "f".repeat(64), "--evidence", "e")).toBe(1);
    expect(out.at(-1)).toBe("error: no unique unknown post-merge dispatch is available to reconcile");
    expect(run("dispatch", URL, "--reviewer", "alice", "--reason-code", "bogus", "--detail", "d")).toBe(2);
  });

  it("requires recovery, postmortem and post-recovery observation after an adverse event", () => {
    const p = plan("github-actions");
    const r = (min: number, x: object) => ({ observed_at: ago(min), ...x });
    const rel = { type: "release", release_id: "7", release_attempt: 1, release_identifier: "deploy", environment: "production", commit_sha: A };
    const receipts = [r(100, { ...rel, status: "started" }), r(90, { ...rel, status: "succeeded" }), r(80, { type: "incident" })];
    const [gaps] = completionGaps(receipts, p);
    expect(gaps).toEqual(["latest recovery after the latest adverse event is not succeeded"]);
  });
});
