import { expect, test } from "bun:test";
import { assertOrgReadable, ball, classify, mergeCheck, reviewers, stackPlan, toRow, type Reviewers } from "./authored-prs.ts";

const base = { isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", checks: "SUCCESS" };
const rv = (pending: string[], responded: [string, string, boolean?][] = []): Reviewers => ({
  pending,
  responded: responded.map(([login, state, canPush = true]) => ({ login, state, canPush })),
});

test("classify by PR state", () => {
  expect(classify({ ...base, mergeStateStatus: "CLEAN" }, rv([]))).toBe("mergeable");
  expect(classify({ ...base, isDraft: true }, rv(["a"]))).toBe("draft");
  expect(classify({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, rv(["a"]))).toBe("conflicting");
  expect(classify({ ...base, checks: "FAILURE" }, rv(["a"]))).toBe("ci_failed");
});

test("classify by reviewer state", () => {
  expect(classify(base, rv(["a", "team:x"]))).toBe("review_requested");
  expect(classify({ ...base, checks: "PENDING" }, rv(["a"]))).toBe("waiting_ci");
  expect(classify(base, rv(["a"], [["b", "COMMENTED"]]))).toBe("re_request");
  expect(classify(base, rv([], [["b", "DISMISSED"]]))).toBe("re_request");
  expect(classify(base, rv([], [["b", "CHANGES_REQUESTED"]]))).toBe("re_request");
  expect(classify(base, rv([]))).toBe("needs_reviewer");
  expect(classify(base, rv([], [["b", "APPROVED", false]]))).toBe("needs_reviewer");
  expect(classify(base, rv(["a"], [["b", "APPROVED"]]))).toBe("review_requested");
  expect(classify(base, rv([], [["b", "APPROVED"]]))).toBe("blocked");
});

test("reviewers drops bots, self and re-requested reviewers", () => {
  const r = reviewers({
    author: { login: "me" },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "a" } }, { requestedReviewer: { __typename: "Team", slug: "t" } }] },
    latestReviews: {
      nodes: [
        { state: "COMMENTED", authorCanPushToRepository: true, author: { __typename: "User", login: "a" } },
        { state: "COMMENTED", authorCanPushToRepository: false, author: { __typename: "Bot", login: "coderabbitai" } },
        { state: "APPROVED", authorCanPushToRepository: false, author: { __typename: "User", login: "b" } },
      ],
    },
  });
  expect(r).toEqual({ pending: ["a", "team:t"], responded: [{ login: "b", state: "APPROVED", canPush: false }] });
});

test("mergeCheck", () => {
  const live = { url: "u", number: 1, title: "t", isDraft: false, state: "OPEN", headRefOid: "a", author: { login: "me" }, repository: { nameWithOwner: "o/r" }, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" };
  const row = toRow(live, "");
  expect(mergeCheck(row, live, "me", "SQUASH")).toEqual({ ok: true, method: "--squash", now: true });
  const ready = { ...live, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: { enabledAt: "t" } };
  expect(mergeCheck(row, ready, "me", "MERGE")).toEqual({ ok: true, method: "--merge", now: true });
  expect(mergeCheck(row, { ...live, headRefOid: "b" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, live, "other", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, state: "MERGED" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, isDraft: true }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, changedFiles: 0 }, "me", "MERGE")).toEqual({ ok: true, close: true });
  expect(mergeCheck(row, { ...live, changedFiles: 0, isDraft: true }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, changedFiles: 0, headRefOid: "b" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, mergeStateStatus: "BLOCKED", autoMergeRequest: { enabledAt: "t" } }, "me", "MERGE").ok).toBe(false);
});

test("ball", () => {
  expect(ball("mergeable")).toBe("mine_ready_to_merge");
  expect(ball("re_request")).toBe("mine_changes_requested");
  expect(ball("needs_reviewer")).toBe("mine_changes_requested");
  expect(ball("review_requested")).toBe("mine_review_requested");
  expect(ball("waiting_ci")).toBe("mine_review_requested");
});

import { authoredTargets, responded, type AuthoredRow } from "./authored-prs.ts";
const arow = (over: Partial<AuthoredRow>): AuthoredRow =>
  ({ url: "u", head_sha: "h", status: "mine_changes_requested", reason: "ci_failed", pending_reviewers: [], responded_reviewers: [], ...over }) as AuthoredRow;

test("authoredTargets queues my-turn PRs except drafts and dispatched heads", () => {
  const rows = [arow({ url: "a" }), arow({ url: "b", reason: "draft" }), arow({ url: "c", status: "mine_review_requested" }), arow({ url: "d" })];
  const t = authoredTargets(rows, { d: { head: "h", reason: "x", at: "t" } });
  expect(t.map((x) => x.url)).toEqual(["a"]);
  expect(authoredTargets([arow({ url: "d", head_sha: "new" })], { d: { head: "h", reason: "x", at: "t" } }).length).toBe(1);
});

test("conflicting PRs get their own scope so the queue can pick a cheaper model", () => {
  expect(authoredTargets([arow({ reason: "conflicting" })], {})[0].scope).toBe("authored-conflict");
  expect(authoredTargets([arow({ reason: "ci_failed" })], {})[0].scope).toBe("authored");
});

test("responded means the ball left the author", () => {
  expect(responded(arow({}), {})).toBe(false);
  expect(responded(arow({ status: "mine_review_requested" }), {})).toBe(true);
  expect(responded(arow({ status: "mine_ready_to_merge" }), {})).toBe(true);
  expect(responded(arow({}), { u: { head: "h", reason: "x", at: "t" } })).toBe(true);
});

import { mkdtempSync, writeFileSync as wf, mkdirSync as md } from "node:fs";
import { tmpdir } from "node:os";
import { join as pj } from "node:path";
import { CLOSE, HOLD, RETRY, decide, pendingDecisions, readDecisions, readDispatched } from "./authored-prs.ts";

test("decide releases the head except on hold, and rejects stale answers", () => {
  const dir = mkdtempSync(pj(tmpdir(), "dec-"));
  const ledger = pj(dir, "authored_prs.jsonl");
  md(pj(dir, "logs"));
  wf(pj(dir, "logs", "authored-dispatched.json"), JSON.stringify({ u: { head: "h", reason: "A or B?", at: "2026-01-01T00:00:00Z", options: ["A", "B"] } }));
  const row = arow({ url: "u", head_sha: "h" });
  expect(pendingDecisions([row], readDispatched(ledger), {})[0].options).toEqual(["A", "B", RETRY, CLOSE, HOLD]);
  expect(() => decide(ledger, "u", "old", "A")).toThrow();
  expect(() => decide(ledger, "u", "h", "C")).toThrow();
  decide(ledger, "u", "h", HOLD);
  expect(pendingDecisions([row], readDispatched(ledger), readDecisions(ledger))[0].held).toBe(true);
  decide(ledger, "u", "h", "A");
  expect(readDispatched(ledger).u).toBeUndefined();
  expect(authoredTargets([row], readDispatched(ledger), readDecisions(ledger))[0].updated).toContain(readDecisions(ledger).u.at);
});

test("decide accepts free-text answers only when marked custom", () => {
  const dir = mkdtempSync(pj(tmpdir(), "dec-"));
  const ledger = pj(dir, "authored_prs.jsonl");
  md(pj(dir, "logs"));
  wf(pj(dir, "logs", "authored-dispatched.json"), JSON.stringify({ u: { head: "h", reason: "q", at: "t" } }));
  expect(() => decide(ledger, "u", "h", "free text")).toThrow();
  expect(() => decide(ledger, "u", "h", "  ", true)).toThrow();
  expect(decide(ledger, "u", "h", " free text ", true).choice).toBe("free text");
});

test("empty sync is trusted only when the org is readable", () => {
  expect(() => assertOrgReadable({ data: { organization: { repositories: { nodes: [{ nameWithOwner: "o/r" }] } } } })).not.toThrow();
  expect(() => assertOrgReadable({ errors: [{ message: "Resource protected by organization SAML enforcement." }] })).toThrow(/SAML/);
  expect(() => assertOrgReadable({ data: { organization: { repositories: { nodes: [] } } } })).toThrow(/not readable/);
  expect(() => assertOrgReadable({ data: { organization: null } })).toThrow(/not readable/);
});

test("stackPlan merges stacked PRs only together from the top", () => {
  const pr = (n: number, base: string, head: string, reason = "mergeable") =>
    ({ url: `u${n}`, repository: "o/r", pr_number: n, base_ref: base, head_ref: head, default_branch: "main", reason, head_sha: "s" }) as AuthoredRow;
  const a = pr(1, "main", "a"), b = pr(2, "a", "b"), c = pr(3, "b", "c");
  const all = [a, b, c];
  expect(stackPlan(pr(9, "main", "x"), [pr(9, "main", "x")])).toEqual({ kind: "single" });
  expect(stackPlan(a, all).kind).toBe("skip");
  expect(stackPlan(b, all).kind).toBe("skip");
  expect(stackPlan(c, all)).toEqual({ kind: "stack", top: c, members: [a, b, c] });
  const notReady = [a, pr(2, "a", "b", "waiting_ci"), c];
  expect(stackPlan(c, notReady)).toMatchObject({ kind: "skip", reason: expect.stringContaining("#2:waiting_ci") });
  expect(stackPlan(pr(5, "feature", "y"), [pr(5, "feature", "y")]).kind).toBe("skip");
  expect(stackPlan(c, [...all, pr(4, "b", "d")])).toMatchObject({ kind: "skip", reason: "stack branches (not linear)" });
  expect(stackPlan({ ...a, base_ref: undefined }, [a]).kind).toBe("skip");
});

import { escalateStuck } from "./authored-prs.ts";
test("escalateStuck hands an exhausted own PR to a human once", () => {
  const dir = mkdtempSync(pj(tmpdir(), "esc-"));
  const ledger = pj(dir, "authored_prs.jsonl");
  md(pj(dir, "logs"));
  wf(ledger, JSON.stringify(arow({ url: "u", head_sha: "h", reason: "conflicting" })) + "\n");
  const job = { url: "u", kind: "authored" as const, scope: "authored", head: "h", updated: "x", priority: 60, state: "exhausted" as const, attempts: 3, enqueued_at: "" };
  expect(escalateStuck(ledger, { u: { ...job, state: "done" } })).toEqual([]);
  expect(escalateStuck(ledger, { u: job })).toEqual(["u"]);
  expect(readDispatched(ledger).u.reason).toContain("conflicting");
  expect(escalateStuck(ledger, { u: job })).toEqual([]);
});

import { readAuthored, writeAuthored } from "./authored-prs.ts";
test("sync writes are visible to merge's ledger read even after the store holds an older copy", () => {
  const path = pj(mkdtempSync(pj(tmpdir(), "auth-")), "authored_prs.jsonl");
  writeAuthored(path, [{ url: "u1" } as AuthoredRow]);
  writeAuthored(path, [{ url: "u1" } as AuthoredRow, { url: "u2" } as AuthoredRow]);
  expect(readAuthored(path).map((r) => r.url)).toEqual(["u1", "u2"]);
});
