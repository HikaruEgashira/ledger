import { describe, expect, it } from "bun:test";
import {
  parseTime,
  timestamp,
  stableStringify,
} from "./util.ts";

describe("stableStringify", () => {
  it("sorts keys recursively and keeps UTF-8", () =>
    expect(stableStringify({ b: [1, "日本"], a: { y: null, x: false } })).toBe(
      '{"a":{"x":false,"y":null},"b":[1,"日本"]}',
    ));
  it("drops undefined fields", () => expect(stableStringify({ b: 1, a: undefined })).toBe('{"b":1}'));
});

describe("time", () => {
  it("round-trips microseconds", () =>
    expect(timestamp(parseTime("2026-10-20T12:19:11.921162Z"))).toBe(
      "2026-10-20T12:19:11.921162Z",
    ));
  it("omits zero fractions", () =>
    expect(timestamp(parseTime("2026-10-20T12:19:11+09:00"))).toBe("2026-10-20T03:19:11Z"));
  it("rejects naive timestamps", () =>
    expect(() => parseTime("2026-10-20T12:19:11")).toThrow(
      `timestamp must include a timezone: "2026-10-20T12:19:11"`,
    ));
  it("rejects garbage", () => expect(() => parseTime(null)).toThrow("invalid timestamp: null"));
});
