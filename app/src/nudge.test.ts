import { describe, expect, it } from "bun:test";
import { candidates, message, todo } from "./nudge.ts";

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
  it("skips other authors, active PRs, drafts and our own turn", () => {
    expect(candidates([row({ live: { author: { login: "x" } } })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ live: { updatedAt: new Date(now - H).toISOString() } })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ live: { isDraft: true } })], {}, authors, now, 24 * H)).toHaveLength(0);
    expect(candidates([row({ status: "queued" })], {}, authors, now, 24 * H)).toHaveLength(0);
  });
  it("waits an interval after the last nudge", () => {
    const state = { [row().url]: { at: new Date(now - H).toISOString(), head: "" } };
    expect(candidates([row()], state, authors, now, 24 * H)).toHaveLength(0);
  });
});

describe("todo/message", () => {
  const thread = (login: string, isResolved = false) => ({ isResolved, isOutdated: false, comments: { nodes: [{ author: { login } }] } });
  it("counts open CodeRabbit threads and real CI failures, not our review gate", () => {
    const r = row({ live: { checks: [{ name: "validate-review", state: "failure" }, { name: "test", state: "failure" }] } });
    const t = todo(r, [thread("coderabbitai"), thread("coderabbitai", true), thread("someone")]);
    expect(t).toEqual({ coderabbit: 1, failedChecks: ["test"], changesRequested: true });
    expect(message("luckylat", t)).toContain("CodeRabbit の未解決指摘 1 件の対応とCI (test) の修正");
  });
  it("stays silent with nothing concrete on a CI wait", () => {
    expect(message("luckylat", { coderabbit: 0, failedChecks: [], changesRequested: false })).toBeNull();
  });
});
