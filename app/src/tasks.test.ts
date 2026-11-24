import { describe, expect, it } from "bun:test";
import { advance, groups, idFromUrl, keywordPlan, taskCard, taskCards, LOOKBACK_MS, merge, readWatermark, pendingTasks, settled, taskTargets, validate, type Incoming, type TaskRow } from "./tasks.ts";

const I = (o: Partial<Incoming> = {}): Incoming => ({
  id: "jira:PROJ-1",
  source: "jira",
  axis: "review",
  url: "https://example.atlassian.net/browse/PROJ-1",
  title: "t",
  counterpart: "a",
  activity: "1",
  ball: "mine",
  ...o,
});
const now = "2026-11-24T00:00:00Z";

describe("tasks", () => {
  it("validates ids and urls", () => {
    expect(() => validate(I())).not.toThrow();
    expect(() => validate(I({ source: "slack" }))).toThrow(); // source mismatch with url
    expect(() => validate(I({ url: "https://evil.example/x" }))).toThrow();
  });
  it("derives ids from urls so a masked id is ignored", () => {
    const url = "https://x.slack.com/archives/C01ABC/p1794971997292459";
    expect(validate(I({ source: "slack", id: "slack:C01ABC:1794971997.292459", url })).id).toBe("slack:C01ABC:1794971997.292459");
    expect(idFromUrl(url + "?thread_ts=1794971000.000100&cid=C01ABC")).toBe("slack:C01ABC:1794971000.000100");
    expect(idFromUrl("https://x.atlassian.net/browse/OPS2-8420")).toBe("jira:OPS2-8420");
  });
  it("keeps worker state until activity changes", () => {
    let { rows } = merge([], [I()], now);
    rows = rows.map((r) => ({ ...r, ball: "theirs", follow_up_at: "2026-11-26T00:00:00Z" }) as TaskRow);
    expect(merge(rows, [I()], now).rows[0]!.ball).toBe("theirs");
    const moved = merge(rows, [I({ activity: "2" })], now);
    expect(moved.rows[0]!.ball).toBe("mine");
    expect(moved.rows[0]!.follow_up_at).toBeUndefined();
    expect(moved.changed).toEqual(["jira:PROJ-1"]);
  });
  it("targets mine, due timers and answered questions", () => {
    const base = merge([], [I()], now).rows[0]!;
    const t = Date.parse("2026-11-25T00:00:00Z");
    expect(taskTargets([base], t).length).toBe(1);
    expect(taskTargets([{ ...base, ball: "theirs", follow_up_at: "2026-11-26T00:00:00Z" }], t)).toEqual([]);
    expect(taskTargets([{ ...base, ball: "theirs", follow_up_at: "2026-11-24T12:00:00Z" }], t).length).toBe(1);
    const asked: TaskRow = { ...base, ball: "human", question: "q" };
    expect(taskTargets([asked], t)).toEqual([]);
    expect(pendingTasks([asked]).length).toBe(1);
    const answered = { ...asked, answer: { choice: "A", at: now, by: "human" as const } };
    expect(taskTargets([answered], t).length).toBe(1);
    expect(settled(answered)).toBe(false);
    expect(settled({ ...base, ball: "done" })).toBe(true);
  });
});

describe("watermark", () => {
  it("defaults to 14 days and only moves forward", () => {
    const { mkdtempSync } = require("node:fs");
    const ledger = `${mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/tasks-`)}/tasks.jsonl`;
    const t = Date.parse("2026-11-24T00:00:00Z");
    expect(readWatermark(ledger, t)).toBe(new Date(t - LOOKBACK_MS).toISOString());
    expect(advance(ledger, "2026-11-20T00:00:00Z", t)).toBe("2026-11-20T00:00:00Z");
    expect(advance(ledger, "2026-11-19T00:00:00Z", t)).toBe("2026-11-20T00:00:00Z");
    expect(() => advance(ledger, "2026-12-01T00:00:00Z", t)).toThrow();
  });
});

describe("triage and cards", () => {
  it("queues triage threads and maps them to board columns", () => {
    const row = merge([], [I({ id: "slack:C01ABC:1794971997.292459", source: "slack", url: "https://x.slack.com/archives/C01ABC/p1794971997292459", ball: "triage" })], "2026-11-24T00:00:00Z").rows[0]!;
    expect(taskTargets([row]).length).toBe(1);
    expect(settled(row)).toBe(false);
    expect(taskCard(row)).toMatchObject({ kind: "review", status: "queued", repository: "slack/C01ABC", pr_number: 0 });
    expect(taskCard({ ...row, id: "jira:OPS2-8420", axis: "respond", ball: "theirs" })).toMatchObject({ kind: "authored", status: "mine_review_requested", repository: "jira/OPS2", pr_number: 8420 });
  });
});

describe("human hold", () => {
  it("keeps an unanswered question through new activity", () => {
    const base = merge([], [I()], "2026-11-24T00:00:00Z").rows[0]!;
    const asked: TaskRow = { ...base, ball: "human", question: "q" };
    const r = merge([asked], [I({ activity: "2", ball: "triage" })], "2026-11-24T01:00:00Z").rows[0]!;
    expect(r.ball).toBe("human");
    expect(r.question).toBe("q");
    expect(r.activity).toBe("2");
  });
});

describe("keyword rotation", () => {
  it("picks the least recently searched keywords and bounds the window to 24h", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const plan = keywordPlan(["a", "b", "c", "d"], { a: "2026-11-24T11:00:00Z", b: "2026-11-20T00:00:00Z" }, now, 2);
    expect(plan.map((p) => p.q)).toEqual(["c", "d"]);
    expect(plan[0]!.after).toBe("2026-11-23T12:00:00.000Z");
    const next = keywordPlan(["a", "b", "c", "d"], { a: "2026-11-24T11:00:00Z", b: "2026-11-20T00:00:00Z", c: "2026-11-24T12:00:00Z", d: "2026-11-24T12:00:00Z" }, now, 2);
    expect(next).toEqual([{ q: "b", after: "2026-11-23T12:00:00.000Z" }, { q: "a", after: "2026-11-24T11:00:00.000Z" }]);
  });
});

describe("intake follow-up", () => {
  it("gives a request intaken as theirs a follow-up timer", () => {
    const r = merge([], [I({ ball: "theirs" })], "2026-11-24T00:00:00.000Z").rows[0]!;
    expect(r.follow_up_at).toBe("2026-11-26T00:00:00.000Z");
    expect(taskTargets([r], Date.parse("2026-11-26T00:00:01Z")).length).toBe(1);
  });
});

describe("groups", () => {
  const T = (id: string, source: "slack" | "jira", links: string[] = [], o: Partial<TaskRow> = {}): TaskRow =>
    ({ id, source, axis: "review", url: "u", title: id, counterpart: "", ball: "mine", activity: "1", intake_at: "2026-11-24T00:00:00Z", synced_at: "", links, ...o }) as TaskRow;
  it("groups tasks that link each other or the same PR, led by Jira", () => {
    const rows = [
      T("slack:C1:1.1", "slack", ["https://x.atlassian.net/browse/PSIRT-1"]),
      T("jira:PSIRT-1", "jira"),
      T("slack:C2:2.2", "slack", ["https://github.com/o/r/pull/5"]),
      T("slack:C3:3.3", "slack", ["https://github.com/o/r/pull/5"], { intake_at: "2026-11-25T00:00:00Z" }),
      T("slack:C4:4.4", "slack"),
    ];
    const g = groups(rows);
    expect(g.get("slack:C1:1.1")).toEqual({ primary: "jira:PSIRT-1", members: ["slack:C1:1.1"] });
    expect(g.get("slack:C3:3.3")!.primary).toBe("slack:C2:2.2");
    expect(g.get("slack:C4:4.4")).toEqual({ primary: "slack:C4:4.4", members: [] });
    expect(taskTargets(rows).map((t) => t.url).sort()).toEqual(["jira:PSIRT-1", "slack:C2:2.2", "slack:C4:4.4"]);
    expect(taskCards(rows).length).toBe(3);
  });
  it("reopens a settled primary when a linked member gets new activity", () => {
    const rows = [T("jira:PSIRT-1", "jira", [], { ball: "theirs", follow_up_at: "2099-01-01T00:00:00Z" }), T("slack:C1:1.1", "slack", ["https://x.atlassian.net/browse/PSIRT-1"], { ball: "triage" })];
    expect(taskTargets(rows).map((t) => t.url)).toEqual(["jira:PSIRT-1"]);
  });
});

describe("monotonic activity", () => {
  it("ignores an older activity seen by a later run", () => {
    const base = { ...merge([], [I({ activity: "2026-11-24T08:00:00Z" })], "2026-11-24T08:00:00Z").rows[0]!, ball: "done" as const };
    expect(merge([base], [I({ activity: "2026-11-24T07:00:00Z", ball: "triage" })], "2026-11-24T09:00:00Z").rows[0]!.ball).toBe("done");
    expect(merge([base], [I({ activity: "2026-11-24T09:00:00Z", ball: "triage" })], "2026-11-24T09:00:00Z").rows[0]!.ball).toBe("triage");
  });
});
