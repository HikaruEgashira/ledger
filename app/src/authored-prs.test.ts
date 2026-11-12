import { expect, test } from "bun:test";
import { ball, classify, mergeCheck, reviewers, toRow, type Reviewers } from "./authored-prs.ts";

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
  expect(mergeCheck(row, live, "me", "SQUASH")).toEqual({ ok: true, method: "--squash" });
  expect(mergeCheck(row, { ...live, headRefOid: "b" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, live, "other", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, state: "MERGED" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, isDraft: true }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, autoMergeRequest: { enabledAt: "t" } }, "me", "MERGE").ok).toBe(false);
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

test("responded means the ball left the author", () => {
  expect(responded(arow({}), {})).toBe(false);
  expect(responded(arow({ status: "mine_review_requested" }), {})).toBe(true);
  expect(responded(arow({ status: "mine_ready_to_merge" }), {})).toBe(true);
  expect(responded(arow({}), { u: { head: "h", reason: "x", at: "t" } })).toBe(true);
});
