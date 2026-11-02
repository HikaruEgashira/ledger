import { describe, expect, it } from "bun:test";
import { classify, parseLines, parseWorker } from "./logs.ts";
import { filterLogs } from "../webui/logfilter.ts";

describe("logs", () => {
  it("classifies guard and sandbox failures as errors", () => {
    expect(classify("gh:1: command not found: _ipg_check")).toBe("error");
    expect(classify("ip-guard: 現在のIP は社内IPではないため gh pr を停止しました")).toBe("error");
    expect(classify('{"open": 0, "queued": []}')).toBe("info");
  });
  it("marks FAILED events as errors and extracts the PR url", () => {
    const [e] = parseLines("serve", ['{"event": "SYNC_FAILED", "url": "https://github.com/example-org/a/pull/1"}']);
    expect(e.level).toBe("error");
    expect(e.url).toBe("https://github.com/example-org/a/pull/1");
  });
  it("attributes worker tool errors to the PR from the init line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", prompt: "x https://github.com/example-org/b/pull/2" }),
      JSON.stringify({ type: "user", session_id: "s", message: { content: [{ type: "tool_result", content: "gh:1: command not found: _ipg_check" }] } }),
      JSON.stringify({ type: "result", session_id: "s", is_error: false, result: "done" }),
    ];
    const out = parseWorker(lines);
    expect(out.map((e) => [e.level, e.url])).toEqual([
      ["error", "https://github.com/example-org/b/pull/2"],
      ["info", "https://github.com/example-org/b/pull/2"],
    ]);
  });
  it("filters by minimum level, source and text", () => {
    const es = [
      { source: "a", level: "error" as const, ts: null, url: null, msg: "boom" },
      { source: "b", level: "warn" as const, ts: null, url: null, msg: "hmm" },
      { source: "a", level: "info" as const, ts: null, url: null, msg: "ok" },
    ];
    expect(filterLogs(es, { level: "warn", source: "", q: "" }).length).toBe(2);
    expect(filterLogs(es, { level: "all", source: "a", q: "ok" }).map((e) => e.msg)).toEqual(["ok"]);
  });
});

import { groupLogs } from "../webui/logfilter.ts";
describe("groupLogs", () => {
  it("collapses the same failure across PRs", () => {
    const mk = (n: number) => ({ source: "serve", level: "error" as const, ts: null, url: `https://github.com/example-org/a/pull/${n}`, msg: `{"error": "HTTP 401", "url": "https://github.com/example-org/a/pull/${n}"}` });
    const [g, ...rest] = groupLogs([mk(1), mk(2)]);
    expect(rest).toEqual([]);
    expect(g.count).toBe(2);
    expect(g.urls.length).toBe(2);
  });
  it("downgrades CI failures and guard warnings", async () => {
    const { classify } = await import("./logs.ts");
    expect(classify("ip-guard: warning: ONELOGIN_MFA_IP_ADDRESS が未設定です")).toBe("warn");
    expect(classify('{"event": "CI_FAILED"}')).toBe("warn");
  });
});

import { firstSeen, stamp, type Seen } from "./logs.ts";
import { inRange } from "../webui/logfilter.ts";
describe("time range", () => {
  it("stamps only bytes appended after the first observation", () => {
    const seen: Seen = {};
    stamp(seen, "f", 100, "T0");
    expect(firstSeen(seen, "f", 50)).toBeNull();
    stamp(seen, "f", 180, "T1");
    stamp(seen, "f", 250, "T2");
    expect(firstSeen(seen, "f", 120)).toBe("T1");
    expect(firstSeen(seen, "f", 200)).toBe("T2");
    stamp(seen, "f", 10, "T3");
    expect(firstSeen(seen, "f", 0)).toBe("T3");
  });
  it("filters by window and keeps undated entries only for the month view", () => {
    const now = Date.parse("2026-11-03T00:00:00Z");
    const e = (ts: string | null) => ({ source: "s", level: "error" as const, ts, url: null, msg: "" });
    expect(inRange(e("2026-11-02T23:30:00Z"), "h", now)).toBe(true);
    expect(inRange(e("2026-11-02T22:00:00Z"), "h", now)).toBe(false);
    expect(inRange(e("2026-11-02T22:00:00Z"), "d", now)).toBe(true);
    expect(inRange(e(null), "w", now)).toBe(false);
    expect(inRange(e(null), "m", now)).toBe(true);
  });
});
