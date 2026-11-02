import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parseTime, pyDumps, PyJSONDecodeError, pyJsonLoads, timestamp } from "./py.ts";

const cases: [string, string | null, string?][] = JSON.parse(
  readFileSync(new URL("../../test/parity/json_errors.json", import.meta.url), "utf8"),
);

describe("pyJsonLoads", () => {
  it.each(cases)("%j matches CPython", (doc, message, msg) => {
    if (message === null) return void expect(() => pyJsonLoads(doc)).not.toThrow();
    try {
      pyJsonLoads(doc);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PyJSONDecodeError);
      expect([(e as PyJSONDecodeError).message, (e as PyJSONDecodeError).msg]).toEqual([
        message,
        msg,
      ]);
    }
  });
  it("parses nested values", () =>
    expect(pyJsonLoads(' {"a": [1, -2.5e3, "\\u3042\\ud83d\\ude00", null, true]} ')).toEqual({
      a: [1, -2500, "あ😀", null, true],
    }));
});

describe("pyDumps", () => {
  it("matches json.dumps(sort_keys=True, ensure_ascii=False)", () =>
    expect(pyDumps({ b: [1, "日本"], a: { y: null, x: false } }, { sortKeys: true })).toBe(
      '{"a": {"x": false, "y": null}, "b": [1, "日本"]}',
    ));
  it("supports compact separators", () =>
    expect(pyDumps({ b: 1, a: [2] }, { sortKeys: true, compact: true })).toBe('{"a":[2],"b":1}'));
});

describe("time", () => {
  it("round-trips microseconds", () =>
    expect(timestamp(parseTime("2026-10-20T12:19:11.921162Z"))).toBe(
      "2026-10-20T12:19:11.921162Z",
    ));
  it("omits zero fractions like isoformat", () =>
    expect(timestamp(parseTime("2026-10-20T12:19:11+09:00"))).toBe("2026-10-20T03:19:11Z"));
  it("rejects naive timestamps", () =>
    expect(() => parseTime("2026-10-20T12:19:11")).toThrow(
      "timestamp must include a timezone: '2026-10-20T12:19:11'",
    ));
  it("rejects garbage", () => expect(() => parseTime(null)).toThrow("invalid timestamp: None"));
});
