import { describe, expect, it } from "vite-plus/test";
import { LedgerError, parseLedger, toCard } from "./ledger.ts";

const row = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    repository: "example-org/x",
    pr_number: 1,
    url: "https://github.com/example-org/x/pull/1",
    status: "queued",
    priority: 0,
    added_at: "2026-10-01T00:00:00Z",
    ...over,
  });

describe("parseLedger", () => {
  it("parses valid rows and skips blank lines", () =>
    expect(parseLedger(row() + "\n\n")).toHaveLength(1));
  it.each([
    ["invalid JSON", "{"],
    ["non example-org owner", row({ url: "https://github.com/other/x/pull/1", repository: "other/x" })],
    ["URL mismatch", row({ pr_number: 2 })],
    ["unknown status", row({ status: "nope" })],
    ["missing field", JSON.stringify({ url: "https://github.com/example-org/x/pull/1" })],
    ["duplicate URL", row() + "\n" + row()],
  ])("rejects %s", (_, text) => expect(() => parseLedger(text)).toThrow(LedgerError));
});

describe("toCard", () => {
  it("flattens nested timestamps", () => {
    const c = toCard({
      ...JSON.parse(row()),
      approval: { approved_at: "a" },
      delivery: { merge: { merged_at: "m" }, completed_at: "c" },
      live: { title: "t", author: { login: "u" } },
    });
    expect([c.approved_at, c.merged_at, c.completed_at, c.title, c.author]).toEqual([
      "a",
      "m",
      "c",
      "t",
      "u",
    ]);
  });
});
