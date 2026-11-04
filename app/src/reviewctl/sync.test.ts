import { describe, expect, it } from "bun:test";
import {
  ReviewCtlError,
} from "../lib/util.ts";
import { GhTimeout, monitorWithOutage, OUTAGE_PROBE_MS, outageProbeDue, prefetchSync, syncRows } from "./core.ts";

const row = (n: number) => ({ url: `https://github.com/example-org/x/pull/${n}`, status: "queued" });
const stall = () => {
  throw new GhTimeout("gh pr view timed out");
};

describe("syncRows on GitHub stalls", () => {
  it("keeps status and defers a timed-out row", () => {
    const rows = [row(1)];
    expect(syncRows(rows, null, stall)).toEqual([
      { event: "SYNC_DEFERRED", url: rows[0].url, error: "gh pr view timed out" },
    ]);
    expect(rows[0]).toMatchObject({ status: "queued", last_error: "gh pr view timed out" });
  });
  it("retries a timeout once", () => {
    let calls = 0;
    const viewer = () => {
      if (!calls++) stall();
      throw new ReviewCtlError("boom");
    };
    const rows = [row(1)];
    expect(syncRows(rows, null, viewer)[0]).toMatchObject({ event: "SYNC_FAILED", error: "boom" });
    expect(calls).toBe(2);
  });
  it("aborts the pass after two consecutive stalls", () => {
    const rows = [row(1), row(2), row(3), row(4)];
    expect(syncRows(rows, null, stall).map((e) => e.event)).toEqual([
      "SYNC_DEFERRED",
      "SYNC_DEFERRED",
      "SYNC_ABORTED",
    ]);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
  });
  it("stops the pass once on a credential outage without marking rows error", () => {
    const rows = [row(1), row(2)];
    const viewer = () => {
      throw new ReviewCtlError("ghtkn failed: the ghtkn agent is locked");
    };
    expect(syncRows(rows, null, viewer).map((e) => e.event)).toEqual(["SYNC_UNAVAILABLE"]);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
  });
  it("treats SAML-revoked or bad-credential tokens as a workspace outage", () => {
    for (const msg of [
      "GraphQL: Resource protected by organization SAML enforcement. Your token's access was revoked.",
      "HTTP 401: Bad credentials (https://api.github.com/graphql)",
      "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.",
    ]) {
      const rows = [row(1), row(2)];
      const viewer = () => {
        throw new ReviewCtlError(msg);
      };
      expect(syncRows(rows, null, viewer).map((e) => e.event)).toEqual(["SYNC_UNAVAILABLE"]);
      expect(rows.every((r) => r.status === "queued")).toBe(true);
    }
  });
  it("auto-resumes rows errored by a logged-out gh CLI", () => {
    const rows = [{ ...row(1), status: "error", last_error: "To get started with GitHub CLI, please run:  gh auth login" }];
    let calls = 0;
    syncRows(rows as never, null, () => {
      calls++;
      throw new ReviewCtlError("boom");
    });
    expect(calls).toBe(1);
  });
  it("halts on the first row failure and skips error rows on later ticks", () => {
    const rows = [row(1), row(2)];
    let calls = 0;
    const viewer = () => {
      calls++;
      throw new ReviewCtlError("boom");
    };
    expect(syncRows(rows, null, viewer).map((e) => e.event)).toEqual(["SYNC_FAILED", "SYNC_HALTED"]);
    expect(rows.map((r) => r.status)).toEqual(["error", "queued"]);
    syncRows(rows, null, viewer);
    expect(calls).toBe(2);
  });
});

describe("syncRows on outage-errored rows", () => {
  const live = () => {
    throw new ReviewCtlError("boom");
  };
  it("auto-resumes rows errored by a credential outage", () => {
    const rows = [{ url: "https://github.com/example-org/x/pull/1", status: "error", last_error: "GraphQL: Resource protected by organization SAML enforcement." }];
    expect(syncRows(rows, null, live).map((e) => e.event)).toContain("SYNC_FAILED");
  });
  it("leaves PR-specific error rows for explicit --url", () => {
    const rows = [{ url: "https://github.com/example-org/x/pull/1", status: "error", last_error: "boom" }];
    expect(syncRows(rows, null, live)).toEqual([]);
  });
});

describe("monitorWithOutage", () => {
  const down = { event: "SYNC_UNAVAILABLE", error: "HTTP 401: Bad credentials", skipped: 3 };
  it("reports a new outage once and records it", () => {
    const r = monitorWithOutage(null, 0, () => [down]);
    expect(r.events).toEqual([down]);
    expect(r.outage).toEqual({ error: down.error, last_probe_ms: 0 });
  });
  it("skips GitHub until the probe interval elapses", () => {
    let calls = 0;
    const r = monitorWithOutage({ error: down.error, last_probe_ms: 0 }, OUTAGE_PROBE_MS - 1, () => (calls++, []));
    expect(calls).toBe(0);
    expect(r.events).toEqual([]);
  });
  it("silences a repeated identical outage", () => {
    const r = monitorWithOutage({ error: down.error, last_probe_ms: 0 }, OUTAGE_PROBE_MS, () => [down]);
    expect(r.events).toEqual([]);
    expect(r.outage?.last_probe_ms).toBe(OUTAGE_PROBE_MS);
  });
  it("clears the outage after a successful probe", () => {
    const ok = { event: "PR_UPDATED", url: "u" };
    const r = monitorWithOutage({ error: down.error, last_probe_ms: 0 }, OUTAGE_PROBE_MS, () => [ok]);
    expect(r).toEqual({ events: [ok], outage: null });
  });
});

describe("prefetchSync", () => {
  const boom = () => {
    calls++;
    throw new ReviewCtlError("boom");
  };
  let calls = 0;
  it("fetches before apply and replays the results without calling GitHub again", () => {
    calls = 0;
    const apply = prefetchSync([row(1)], boom);
    expect(calls).toBe(1);
    const fresh = [row(1)];
    expect(apply(fresh)[0]).toMatchObject({ event: "SYNC_FAILED", error: "boom" });
    expect(fresh[0]).toMatchObject({ status: "error", last_error: "boom" });
    expect(calls).toBe(1);
  });
  it("replays a timeout retry in order", () => {
    let n = 0;
    const apply = prefetchSync([row(1)], () => {
      if (!n++) stall();
      throw new ReviewCtlError("boom");
    });
    expect(apply([row(1)])[0]).toMatchObject({ event: "SYNC_FAILED", error: "boom" });
  });
  it("leaves rows changed or added during the fetch for the next pass", () => {
    calls = 0;
    const apply = prefetchSync([row(1)], boom);
    const fresh = [{ ...row(1), decision: { action: "wait_ci" } }, row(2)];
    expect(apply(fresh)).toEqual([]);
    expect(fresh.map((r) => r.status)).toEqual(["queued", "queued"]);
  });
  it("does not mutate the unlocked snapshot", () => {
    const snapshot = [row(1)];
    prefetchSync(snapshot, boom);
    expect(snapshot[0]).toEqual(row(1));
  });
});

describe("outageProbeDue", () => {
  it("probes without an outage or once the throttle elapses", () => {
    expect(outageProbeDue(null, 0)).toBe(true);
    expect(outageProbeDue({ error: "x", last_probe_ms: 0 }, OUTAGE_PROBE_MS - 1)).toBe(false);
    expect(outageProbeDue({ error: "x", last_probe_ms: 0 }, OUTAGE_PROBE_MS)).toBe(true);
  });
});
