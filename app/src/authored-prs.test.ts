import { expect, test } from "bun:test";
import { classify, mergeCheck, toRow } from "./authored-prs.ts";

const base = { isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: "SUCCESS" };

test("classify", () => {
  expect(classify(base)).toBe("mine_mergeable");
  expect(classify({ ...base, mergeStateStatus: "HAS_HOOKS" })).toBe("mine_mergeable");
  expect(classify({ ...base, isDraft: true })).toBe("mine_draft");
  expect(classify({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })).toBe("mine_conflicting");
  expect(classify({ ...base, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" })).toBe("mine_changes_requested");
  expect(classify({ ...base, mergeStateStatus: "BLOCKED", checks: "PENDING" })).toBe("mine_waiting_ci");
  expect(classify({ ...base, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" })).toBe("mine_review_required");
  expect(classify({ ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toBe("mine_blocked");
});

test("mergeCheck", () => {
  const live = { url: "u", number: 1, title: "t", isDraft: false, state: "OPEN", headRefOid: "a", author: { login: "me" }, repository: { nameWithOwner: "o/r" }, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" };
  const row = toRow(live, "");
  expect(mergeCheck(row, live, "me", "SQUASH")).toEqual({ ok: true, method: "--squash" });
  expect(mergeCheck(row, { ...live, headRefOid: "b" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, live, "other", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, state: "MERGED" }, "me", "MERGE").ok).toBe(false);
  expect(mergeCheck(row, { ...live, mergeStateStatus: "BLOCKED" }, "me", "MERGE").ok).toBe(false);
});
