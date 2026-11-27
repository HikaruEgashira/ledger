import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "./core.ts";

const URL = "https://github.com/example-org/x/pull/1";
const A = "a".repeat(40);
const B = "b".repeat(40);
const T = "2026-11-27T00:00:00Z";

function setup(live: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "lazy-"));
  const artifact = {
    schema_version: 1, url: URL, base_sha: A, head_sha: B, reviewed_at: T, verdict: "approve",
    coverage: { diff: "pass", security: "pass", tests: "not_applicable", tests_not_applicable_reason: "config" },
    review_threads: { method: "gh", unresolved: 0, verified_at: T, pr_updated_at: T },
    findings: [], human_dispatch: { required: false },
    delivery: { release: { mode: "not_applicable", reason: "none" }, monitoring: { window_minutes: 30, signals: [] }, recovery: { preferred_strategy: "not_applicable" } },
  };
  const body = JSON.stringify(artifact);
  writeFileSync(join(root, "a.json"), body);
  const row = {
    url: URL, evidence_path: "a.json", evidence_sha256: createHash("sha256").update(body).digest("hex"),
    live: { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: [], baseRefOid: A, headRefOid: B, updatedAt: T, ...live },
  };
  return { row, root };
}

describe("evaluate with lazily computed mergeability", () => {
  it("waits instead of re-reviewing when only UNKNOWN blocks", () => {
    const { row, root } = setup({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
    expect(evaluate(row, { root, now: Date.parse(T) * 1000 })[0]).toBe("wait_ci");
  });
  it("still re-reviews on conflicts", () => {
    const { row, root } = setup({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    expect(evaluate(row, { root, now: Date.parse(T) * 1000 })[0]).toBe("review");
  });
  it("approves when clean", () => {
    const { row, root } = setup({});
    expect(evaluate(row, { root, now: Date.parse(T) * 1000 })[0]).toBe("approve");
  });
});
