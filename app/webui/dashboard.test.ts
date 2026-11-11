import { describe, expect, it } from "bun:test";
import { aggregate, stageAt, type Card, type Stage } from "./dashboard.ts";

const card = (over: Partial<Card>): Card => ({
  url: "https://github.com/example-org/x/pull/1",
  repository: "example-org/x",
  pr_number: 1,
  status: "queued",
  priority: 0,
  title: null,
  author: null,
  action: null,
  last_error: null,
  updated_at: null,
  added_at: null,
  approved_at: null,
  changes_requested_at: null,
  merged_at: null,
  completed_at: null,
  ...over,
});

describe("stageAt", () => {
  const r = card({
    added_at: "2026-10-01T00:00:00Z",
    approved_at: "2026-10-02T00:00:00Z",
    merged_at: "2026-10-03T00:00:00Z",
    completed_at: "2026-10-04T00:00:00Z",
  });
  it.each([
    ["2026-10-01T00:00:00Z", null],
    ["2026-10-01T12:00:00Z", "added"],
    ["2026-10-02T12:00:00Z", "approved"],
    ["2026-10-03T12:00:00Z", "merged"],
    ["2026-10-04T12:00:00Z", "done"],
  ] as [string, Stage | null][])("at %s is %s", (t, want) => expect(stageAt(r, new Date(t))).toBe(want));

  it("treats closed rows as done at updated_at", () => {
    const c = card({
      status: "closed",
      added_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
    });
    expect(stageAt(c, new Date("2026-10-03T00:00:00Z"))).toBe("done");
  });
});

describe("aggregate", () => {
  it("open equals the non-done stage bands", () => {
    const rows = [
      card({ added_at: "2026-10-10T00:00:00Z" }),
      card({ url: "u2", added_at: "2026-10-10T00:00:00Z", merged_at: "2026-10-11T00:00:00Z" }),
      card({ url: "u3", added_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-12T00:00:00Z" }),
    ];
    for (const d of aggregate(rows, "day", new Date("2026-10-20T12:00:00Z")))
      expect(d.open).toBe(d.stage.added + d.stage.approved + d.stage.merged);
  });
});

describe("stageAt authored", () => {
  const t = new Date("2026-10-05T00:00:00Z");
  it("splits added by whose turn it is", () => {
    expect(stageAt(card({ kind: "authored", added_at: "2026-10-01T00:00:00Z", status: "mine_changes_requested" }), t)).toBe("need_respond");
    expect(stageAt(card({ kind: "authored", added_at: "2026-10-01T00:00:00Z", status: "mine_review_requested" }), t)).toBe("responded");
    expect(stageAt(card({ added_at: "2026-10-01T00:00:00Z" }), t)).toBe("added");
  });
});
