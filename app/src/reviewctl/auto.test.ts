import { describe, expect, it } from "bun:test";
import { matchRule, type Rule } from "./auto.ts";

const rule: Rule = {
  repository: "example-org/x",
  paths: ["deps/**", "package.json"],
  max_changed_lines: 10,
  delivery: {},
};

describe("matchRule", () => {
  it("matches when every file and the size are covered", () => {
    expect(
      matchRule([rule], { repository: "example-org/x", files: ["deps/a.lock"], changedLines: 4 }),
    ).toBe(rule);
  });
  it("rejects a file outside the rule", () => {
    expect(
      matchRule([rule], { repository: "example-org/x", files: ["deps/a", "src/a.ts"], changedLines: 4 }),
    ).toBeNull();
  });
  it("rejects an oversized diff, another repository, or an empty file list", () => {
    expect(
      matchRule([rule], { repository: "example-org/x", files: ["package.json"], changedLines: 11 }),
    ).toBeNull();
    expect(
      matchRule([rule], { repository: "example-org/y", files: ["package.json"], changedLines: 1 }),
    ).toBeNull();
    expect(matchRule([rule], { repository: "example-org/x", files: [], changedLines: 0 })).toBeNull();
  });
});
