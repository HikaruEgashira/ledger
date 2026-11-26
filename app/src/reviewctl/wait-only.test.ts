import { describe, expect, it } from "bun:test";
import { waitOnly } from "./core.ts";

const pending = "pending checks: plan-approval";
describe("waitOnly", () => {
  it("waits on UNKNOWN mergeability instead of re-reviewing", () => {
    expect(waitOnly(["pull request mergeability is UNKNOWN", "pull request merge state is UNKNOWN", pending], [null, pending])).toBe(true);
  });
  it("still reviews conflicts and other blockers", () => {
    expect(waitOnly(["pull request mergeability is CONFLICTING", pending], [null, pending])).toBe(false);
    expect(waitOnly(["pull request merge state is DIRTY"], [null, null])).toBe(false);
    expect(waitOnly(["1 unresolved review thread(s)", pending], [null, pending])).toBe(false);
  });
});
