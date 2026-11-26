import { describe, expect, it } from "bun:test";
import { asks, candidates, message } from "./nudge.ts";

const H = 3_600_000;
const now = Date.parse("2026-11-26T00:00:00Z");
const row = (o: Record<string, any> = {}) => ({
  url: "https://github.com/o/r/pull/1",
  status: "changes_requested",
  ...o,
  live: { state: "OPEN", isDraft: false, author: { login: "luckylat" }, updatedAt: new Date(now - 48 * H).toISOString(), checks: [], ...o.live },
});
const authors = new Set(["luckylat"]);

describe("candidates", () => {
  it("picks idle enrolled authors whose ball it is", () => {
    expect(candidates([row()], {}, authors, now, 24 * H)).toHaveLength(1);
  });
  it("includes queued PRs but never drafts", () => {
    expect(candidates([row({ status: "queued" })], {}, authors, now, 24 * H)).toHaveLength(1);
    expect(candidates([row({ status: "queued", live: { isDraft: true } })], {}, authors, now, 24 * H)).toHaveLength(0);
  });
  it("skips other authors, active PRs and our own turn", () => {
    expect(candidates([row({ live: { author: { login: "x" } } })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ live: { updatedAt: new Date(now - H).toISOString() } })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ status: "approved" })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ status: "human_required" })], {}, authors, now, 24 * H)).toHaveLength(0);
  });
  it("waits an interval after the last nudge", () => {
    const state = { [row().url]: { at: new Date(now - H).toISOString(), head: "" } };
    expect(candidates([row()], state, authors, now, 24 * H)).toHaveLength(0);
  });
});

describe("asks/message", () => {
  const thread = (login: string, isResolved = false) => ({ isResolved, isOutdated: false, comments: { nodes: [{ author: { login } }] } });
  it("turns author-side blockers and open threads into asks", () => {
    const r = row({ decision: { reasons: ["pull request is draft", "pull request mergeability is CONFLICTING", "pull request merge state is DIRTY", "failed checks: test", "an active review requests changes", "review evidence is missing"] } });
    expect(asks(r, [thread("coderabbitai"), thread("someone"), thread("x", true)])).toEqual([
      "base ブランチとのコンフリクト解消",
      "CI (test) の修正",
      "Request changes の指摘への対応",
      "未解決のレビュースレッド 2 件（うち CodeRabbit 1 件）への修正か返信・resolve",
    ]);
  });
  it("stays silent when only the agent has work", () => {
    const r = row({ status: "queued", decision: { reasons: ["review evidence is missing", "pull request mergeability is UNKNOWN"] } });
    expect(message("luckylat", asks(r, []))).toBeNull();
  });
});
