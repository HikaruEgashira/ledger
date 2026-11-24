import { describe, expect, it } from "bun:test";
import { advance, idFromUrl, taskCard, LOOKBACK_MS, merge, readWatermark, pendingTasks, settled, taskTargets, validate, type Incoming, type TaskRow } from "./tasks.ts";

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
