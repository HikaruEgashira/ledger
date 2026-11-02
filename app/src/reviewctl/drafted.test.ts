import { describe, expect, it } from "vite-plus/test";
import { applyLive } from "./core.ts";

const URL = "https://github.com/example-org/x/pull/1";
const A = "a".repeat(40);
const B = "b".repeat(40);
const live = (isDraft: boolean) => ({ url: URL, baseRefOid: A, headRefOid: B, state: "OPEN", isDraft, checks: [], updatedAt: "t" });
const row = () => ({
  url: URL,
  status: "approved",
  decision: { action: "approved", reasons: [], at: "t" },
  evidence_path: "review-artifacts/records/x.json",
  evidence_sha256: "f".repeat(64),
  approval: { head_sha: B, base_sha: A, verification: "post-approval-threads-and-live-state" },
  live: live(false),
});

describe("applyLive on ready -> draft", () => {
  it("resets the verdict and marks the approval for re-verification", () => {
    const r: Record<string, any> = row();
    const events = applyLive(r, live(true));
    expect(events.map((e) => e.event)).toContain("DRAFTED");
    expect(r.status).toBe("queued");
    expect(r.evidence_path).toBeNull();
    expect(r.approval.verification).toBe("pending");
  });
  it("ignores PRs that stay draft or become ready", () => {
    const stay: Record<string, any> = { ...row(), status: "queued", evidence_path: null, evidence_sha256: null, live: live(true) };
    expect(applyLive(stay, live(true)).map((e) => e.event)).not.toContain("DRAFTED");
    const ready: Record<string, any> = { ...row(), status: "queued", evidence_path: null, evidence_sha256: null, live: live(true) };
    expect(applyLive(ready, live(false)).map((e) => e.event)).not.toContain("DRAFTED");
  });
});
