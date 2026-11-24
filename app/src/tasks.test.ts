import { describe, expect, it } from "bun:test";
import { idFromUrl, merge, pendingTasks, settled, taskTargets, validate, type Incoming, type TaskRow } from "./tasks.ts";

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
