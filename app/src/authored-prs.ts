#!/usr/bin/env bun
// Sync the authenticated user's own open PRs into authored_prs.jsonl (separate from the review ledger).
import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { org } from "./lib/org.ts";
import { exec } from "./lib/util.ts";

export const AUTHORED_LEDGER = join(resolve(import.meta.dir, "../.."), "authored_prs.jsonl");
const PR_FIELDS = `
  url number title isDraft createdAt updatedAt headRefOid state
  author { login }
  repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision
  autoMergeRequest { enabledAt }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } } } }
  latestReviews(first: 30) { nodes { state authorCanPushToRepository author { __typename login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
const QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 10, after: $cursor) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const ONE = `
query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $n) { ${PR_FIELDS} } }
}`;

// Fine-grained reason; the board groups it into GitHub-style review states.
export type Reason =
  | "mergeable"
  | "draft"
  | "conflicting"
  | "ci_failed"
  | "re_request"
  | "needs_reviewer"
  | "waiting_ci"
  | "review_requested"
  | "blocked";
export type AuthoredStatus = "mine_ready_to_merge" | "mine_changes_requested" | "mine_review_requested";
const AUTHOR_ACTION = new Set<Reason>(["draft", "conflicting", "ci_failed", "re_request", "needs_reviewer"]);
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
  pending_reviewers: string[];
  responded_reviewers: string[];
  auto_merge: boolean;
  head_sha: string;
  mergeable: string;
  merge_state: string;
  review_decision: string | null;
  checks: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string;
}

export interface Review {
  login: string;
  state: string;
  canPush: boolean;
}
export interface Reviewers {
  pending: string[];
  responded: Review[];
}

// Pending (yellow) = currently requested; responded = latest human review whose author is not re-requested.
export function reviewers(n: any): Reviewers {
  const pending = (n.reviewRequests?.nodes ?? [])
    .map((x: any) => x?.requestedReviewer)
    .filter(Boolean)
    .map((r: any) => (r.__typename === "Team" ? `team:${r.slug}` : r.login));
  const self = n.author?.login;
  const responded = (n.latestReviews?.nodes ?? [])
    .filter((r: any) => r?.author && r.author.__typename !== "Bot" && r.author.login !== self && !pending.includes(r.author.login))
    .map((r: any) => ({ login: r.author.login, state: r.state, canPush: !!r.authorCanPushToRepository }));
  return { pending, responded };
}

// CLEAN/HAS_HOOKS means GitHub already evaluated branch protection as satisfied.
export function classify(n: { isDraft: boolean; mergeable: string; mergeStateStatus: string; checks: string | null }, rv: Reviewers): Reason {
  if (n.isDraft) return "draft";
  if (n.mergeable === "CONFLICTING" || n.mergeStateStatus === "DIRTY") return "conflicting";
  if (n.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(n.mergeStateStatus)) return "mergeable";
  if (n.checks === "FAILURE" || n.checks === "ERROR") return "ci_failed";
  // A counted approval needs no follow-up; any other non-yellow review needs a response and re-request.
  const counted = rv.responded.filter((r) => r.state === "APPROVED" && r.canPush);
  if (rv.responded.some((r) => r.state !== "APPROVED")) return "re_request";
  if (!rv.pending.length && !counted.length) return "needs_reviewer";
  if (n.checks === "PENDING" || n.checks === "EXPECTED") return "waiting_ci";
  if (rv.pending.length) return "review_requested";
  return "blocked";
}

export function toRow(n: any, now: string): AuthoredRow {
  const checks = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  const rv = reviewers(n);
  const reason = classify({ ...n, checks }, rv);
  return {
    url: n.url,
    repository: n.repository.nameWithOwner,
    pr_number: n.number,
    title: n.title,
    author: n.author?.login ?? "",
    status: ball(reason),
    reason,
    pending_reviewers: rv.pending,
    responded_reviewers: rv.responded.map((r) => `${r.login}:${r.state}${r.canPush ? "" : ":no-push"}`),
    auto_merge: !!n.autoMergeRequest,
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

function writeAuthored(path: string, rows: AuthoredRow[]): void {
  const tmp = join(dirname(path), `.tmp-authored-${process.pid}`);
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, path);
}

function sync(path: string): AuthoredRow[] {
  const now = new Date().toISOString();
  const rows = fetchAll().map((n) => toRow(n, now)).sort((a, b) => a.url.localeCompare(b.url));
  writeAuthored(path, rows);
  return rows;
}

// Heads a worker handed to a human (intent change); the PR waits for the human, not the queue.
const dispatchPath = (ledger: string) => join(dirname(ledger), "logs", "authored-dispatched.json");
export interface Dispatch {
  head: string;
  reason: string;
  at: string;
  options?: string[];
}
export function readDispatched(path = AUTHORED_LEDGER): Record<string, Dispatch> {
  try {
    return JSON.parse(readFileSync(dispatchPath(path), "utf8"));
  } catch {
    return {};
  }
}

export const isDispatched = (row: AuthoredRow, d: ReturnType<typeof readDispatched>) => d[row.url]?.head === row.head_sha;

/** The response is complete once the ball is with the reviewers (or a human took it over). */
export const responded = (row: AuthoredRow, d: ReturnType<typeof readDispatched>) =>
  row.status !== "mine_changes_requested" || isDispatched(row, d);

// Activity key: a new push or a new reviewer response is new work; the worker's own comments are not.
export const activityKey = (row: AuthoredRow) => [row.reason, ...row.pending_reviewers, ...row.responded_reviewers].join(",");

export interface AuthoredTarget {
  url: string;
  scope: "authored";
  head: string;
  updated: string;
  priority: number;
}
/** Own PRs whose ball is with the author; drafts stay the author's choice. */
export function authoredTargets(rows: AuthoredRow[], d: ReturnType<typeof readDispatched>, dec: Decisions = {}): AuthoredTarget[] {
  return rows
    .filter((r) => r.status === "mine_changes_requested" && r.reason !== "draft" && !isDispatched(r, d))
    .map((r) => ({ url: r.url, scope: "authored", head: r.head_sha, updated: [activityKey(r), dec[r.url]?.at ?? ""].join("|"), priority: 60 }));
}

// Human answers to dispatched questions; an answer at the current head re-queues the worker with it.
export interface Decision {
  head: string;
  question: string;
  choice: string;
  at: string;
}
export type Decisions = Record<string, Decision>;
export const HOLD = "保留";
export const CLOSE = "PRをclose";
export const RETRY = "自動対応で再試行";
const decisionPath = (ledger: string) => join(dirname(ledger), "logs", "authored-decisions.json");
export function readDecisions(path = AUTHORED_LEDGER): Decisions {
  try {
    return JSON.parse(readFileSync(decisionPath(path), "utf8"));
  } catch {
    return {};
  }
}
function writeJson(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 1));
  renameSync(tmp, file);
}

export interface PendingDecision {
  url: string;
  repository: string;
  pr_number: number;
  title: string;
  reason: Reason;
  head: string;
  question: string;
  options: string[];
  asked_at: string;
  held: boolean;
}
/** Dispatched heads still waiting for the human; held ones stay listed but sort last. */
export function pendingDecisions(rows: AuthoredRow[], d: Record<string, Dispatch>, dec: Decisions): PendingDecision[] {
  return rows
    .filter((r) => r.status === "mine_changes_requested" && r.reason !== "draft" && isDispatched(r, d))
    .map((r) => {
      const q = d[r.url];
      const a = dec[r.url];
      const answered = a?.head === r.head_sha && a.at >= q.at;
      return { r, q, answered, held: answered && a.choice === HOLD };
    })
    .filter((x) => !x.answered || x.held)
    .map(({ r, q, held }) => ({
      url: r.url,
      repository: r.repository,
      pr_number: r.pr_number,
      title: r.title,
      reason: r.reason,
      head: r.head_sha,
      question: q.reason,
      options: [...new Set([...(q.options ?? []), RETRY, CLOSE, HOLD])],
      asked_at: q.at,
      held,
    }))
    .sort((a, b) => Number(a.held) - Number(b.held) || a.asked_at.localeCompare(b.asked_at));
}

/** Record an answer; any choice but HOLD releases the head so the queue picks it up again. */
export function decide(path: string, url: string, head: string, choice: string): Decision {
  const d = readDispatched(path);
  const q = d[url];
  if (!q || q.head !== head) throw new Error("question is stale (new push or not dispatched)");
  const allowed = [...(q.options ?? []), RETRY, CLOSE, HOLD];
  if (!allowed.includes(choice)) throw new Error(`unknown choice: ${choice}`);
  const dec = readDecisions(path);
  const a = { head, question: q.reason, choice, at: new Date().toISOString() };
  dec[url] = a;
  writeJson(decisionPath(path), dec);
  if (choice !== HOLD) {
    delete d[url];
    writeJson(dispatchPath(path), d);
  }
  return a;
}

/** Re-fetch one PR, store it, and exit 0 only when the ball left the author. */
function check(path: string, url: string): number {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
  if (!m) throw new Error(`invalid PR URL: ${url}`);
  const live = JSON.parse(gh(["api", "graphql", "-f", `query=${ONE}`, "-F", `owner=${m[1]}`, "-F", `repo=${m[2]}`, "-F", `n=${m[3]}`])).data.repository.pullRequest;
  const rows = readAuthored(path).filter((r) => r.url !== url);
  if (live.state !== "OPEN") {
    writeAuthored(path, rows);
    console.log(`done\t${url}\t${live.state}`);
    return 0;
  }
  const row = toRow(live, new Date().toISOString());
  writeAuthored(path, [...rows, row].sort((a, b) => a.url.localeCompare(b.url)));
  const ok = responded(row, readDispatched(path));
  console.log(`${ok ? "done" : "still-mine"}\t${url}\t${row.status}\t${row.reason}`);
  return ok ? 0 : 1;
}

function dispatch(path: string, url: string, reason: string, options: string[]): void {
  const row = readAuthored(path).find((r) => r.url === url);
  if (!row) throw new Error(`not in authored list: ${url}`);
  const d = readDispatched(path);
  d[url] = { head: row.head_sha, reason, at: new Date().toISOString(), ...(options.length ? { options } : {}) };
  writeJson(dispatchPath(path), d);
  console.log(`dispatched\t${url}`);
}

const VIEW = `
query($owner: String!, $repo: String!, $n: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    viewerDefaultMergeMethod
    pullRequest(number: $n) { ${PR_FIELDS} }
  }
}`;
const METHOD: Record<string, string> = { MERGE: "--merge", SQUASH: "--squash", REBASE: "--rebase" };

export type MergeCheck = { ok: true; method: string; now: boolean } | { ok: false; reason: string };
// Enable auto-merge only on the user's own open, non-draft PR at the exact head recorded in the list.
export function mergeCheck(row: AuthoredRow, live: any, viewer: string, defaultMethod: string): MergeCheck {
  if (!live || live.state !== "OPEN") return { ok: false, reason: `not open (${live?.state ?? "missing"})` };
  if (live.author?.login !== viewer) return { ok: false, reason: "not authored by viewer" };
  if (live.headRefOid !== row.head_sha) return { ok: false, reason: "head changed since sync" };
  if (live.isDraft) return { ok: false, reason: "draft" };
  // Ready PRs merge directly so repos without auto-merge (or a stuck auto-merge) still land.
  const now = live.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(live.mergeStateStatus);
  if (live.autoMergeRequest && !now) return { ok: false, reason: "auto-merge already enabled" };
  const method = METHOD[defaultMethod];
  if (!method) return { ok: false, reason: `unknown merge method ${defaultMethod}` };
  return { ok: true, method, now };
}

// Heads whose enable attempt failed (e.g. auto-merge disallowed); retried only after a new push.
const failedPath = (ledger: string) => join(dirname(ledger), "logs", "authored-auto-merge-failed.json");
function readFailed(ledger: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(failedPath(ledger), "utf8"));
  } catch {
    return {};
  }
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
  const failedHeads = readFailed(path);
  const targets = urls.length
    ? urls.map((u) => all.find((r) => r.url === u) ?? ({ url: u } as AuthoredRow))
    : all.filter((r) => r.reason === "mergeable" || (r.reason !== "draft" && !r.auto_merge && failedHeads[r.url] !== r.head_sha));
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
      console.log(`${c.now ? "would-merge" : "would-enable"}\t${row.url}\t${c.method}\t${row.title}`);
      continue;
    }
    try {
      try {
        gh(["pr", "merge", row.url, ...(c.now ? [] : ["--auto"]), c.method, "--match-head-commit", row.head_sha]);
      } catch (e) {
        // Merge-queue branches reject an explicit strategy; enqueue instead.
        if (!c.now || !/merge queue/i.test((e as Error).message)) throw e;
        const id = gh(["pr", "view", row.url, "--json", "id", "-q", ".id"]).trim();
        gh(["api", "graphql", "-f", "query=mutation($id: ID!, $sha: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $sha }) { clientMutationId } }", "-F", `id=${id}`, "-F", `sha=${row.head_sha}`]);
      }
      console.log(`${c.now ? "merged" : "auto-merge"}\t${row.url}\t${c.method}`);
    } catch (e) {
      console.log(`fail\t${row.url}\t${(e as Error).message}`);
      if (!c.now) failedHeads[row.url] = row.head_sha;
      failed++;
    }
  }
  if (yes) {
    mkdirSync(dirname(failedPath(path)), { recursive: true });
    writeFileSync(failedPath(path), JSON.stringify(failedHeads, null, 1));
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ledger: { type: "string", default: AUTHORED_LEDGER },
      all: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      reason: { type: "string" },
      option: { type: "string", multiple: true },
    },
  });
  const cmd = positionals[0] ?? "list";
  if (!["sync", "list", "merge", "check", "dispatch", "decision"].includes(cmd) || (["check", "dispatch", "decision"].includes(cmd) && !positionals[1]) || (cmd === "dispatch" && !values.reason)) {
    console.error("usage: authored-prs.ts [--ledger PATH] {sync|list [--all]|merge [--yes] [URL...]|check URL|dispatch URL --reason TEXT [--option TEXT]...|decision URL}");
    process.exit(2);
  }
  if (cmd === "check") process.exit(check(values.ledger!, positionals[1]));
  if (cmd === "dispatch") process.exit((dispatch(values.ledger!, positionals[1], values.reason!, values.option ?? []), 0));
  if (cmd === "decision") {
    const a = readDecisions(values.ledger!)[positionals[1]];
    if (a) console.log(`question\t${a.question}\nchoice\t${a.choice}\nhead\t${a.head}\nat\t${a.at}`);
    process.exit(a ? 0 : 1);
  }
  if (cmd === "merge") process.exit(merge(values.ledger!, positionals.slice(1), values.yes!));
  const rows = cmd === "sync" ? sync(values.ledger!) : readAuthored(values.ledger!);
  for (const r of rows.filter((r) => values.all || r.reason === "mergeable")) console.log(`${r.reason}\t${r.url}\t${r.title}`);
}
