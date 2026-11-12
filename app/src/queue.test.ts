import { describe, expect, it } from "bun:test";
import { BACKOFF_MS, MAX_ATTEMPTS, MAX_REVIVALS, plan, settleExits, targets, type Queue, type Target } from "./queue.ts";

const T = (n: number, head = "h1", updated = "u1"): Target => ({ url: `https://github.com/example-org/r/pull/${n}`, scope: "s", head, updated, priority: 50 });
const dead = () => false;
const alive = () => true;

describe("queue plan", () => {
  it("caps concurrency and starts the rest later", () => {
    const { queue, start } = plan({}, [T(1), T(2), T(3)], 0, dead, 2);
    expect(start.length).toBe(2);
    for (const j of start) j.pid = 1;
    expect(Object.values(queue).filter((j) => j.state === "waiting").length).toBe(1);
    const again = plan(queue, [T(1), T(2), T(3)], 1, alive, 2);
    expect(again.start).toEqual([]);
  });
  it("retries a failed run after backoff and stops at the limit", () => {
    let q: Queue = {};
    let now = 0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = plan(q, [T(1)], now, dead);
      expect(r.start.length).toBe(1);
      for (const j of r.start) j.pid = 99;
      q = r.queue;
      now += 1;
      const settled = plan(q, [T(1)], now, dead);
      q = settled.queue;
      expect(settled.start).toEqual([]); // backoff
      now += BACKOFF_MS;
    }
    expect(q[T(1).url].state).toBe("exhausted");
    expect(plan(q, [T(1)], now + BACKOFF_MS, dead).start).toEqual([]);
  });
  it("drops finished jobs and resets the budget on a new head", () => {
    const { queue } = plan({}, [T(1)], 0, dead);
    queue[T(1).url].pid = 1;
    expect(plan(queue, [], 1, dead).queue).toEqual({});
    const exhausted: Queue = { [T(1).url]: { ...T(1), state: "exhausted", attempts: 3, enqueued_at: "" } };
    const r = plan(exhausted, [T(1, "h2")], 2, dead);
    expect(r.start[0].attempts).toBe(1);
  });
});

describe("queue completion", () => {
  const recorded = (n: number, evidence: string | null): Target => ({ ...T(n), evidence });
  it("treats a clean exit with a recorded verdict as done until the PR changes", () => {
    const r = plan({}, [T(1)], 0, dead);
    r.start[0].pid = 5;
    r.start[0].exit_code = 0;
    const settled = plan(r.queue, [recorded(1, "sha-new")], 1, dead);
    expect(settled.queue[T(1).url].state).toBe("done");
    expect(plan(settled.queue, [T(1)], 1 + BACKOFF_MS, dead).start).toEqual([]);
    expect(plan(settled.queue, [T(1, "h1", "u2")], 2, dead).start.length).toBe(1);
  });
  it("treats a clean exit without new evidence as a hold that waits for a PR change", () => {
    for (const [before, after] of [[null, null], ["sha-old", "sha-old"]]) {
      const r = plan({}, [recorded(1, before)], 0, dead);
      r.start[0].pid = 5;
      r.start[0].exit_code = 0;
      const q = plan(r.queue, [recorded(1, after)], 1, dead).queue;
      expect(q[T(1).url].state).toBe("done");
      expect(plan(q, [recorded(1, after)], 1 + BACKOFF_MS, dead).start).toEqual([]);
    }
  });
  it("retries a crash", () => {
    const r = plan({}, [T(1)], 0, dead);
    r.start[0].pid = 5;
    r.start[0].exit_code = 1;
    expect(plan(r.queue, [T(1)], 1, dead).queue[T(1).url].state).toBe("waiting");
  });
});

describe("queue targets", () => {
  const row = (o: object) => ({ url: "https://github.com/example-org/r/pull/1", priority: 50, intake: { source: "review-poller", scope: "s" }, live: { headRefOid: "h" }, ...o });
  it("picks queued scoped rows and pending verifications, skipping approved heads", () => {
    expect(targets([row({ status: "queued" })]).length).toBe(1);
    expect(targets([row({ status: "queued", approval: { head_sha: "h", verification: "confirmed" }, evidence_sha256: "e" })]).length).toBe(0);
    expect(targets([row({ status: "queued", approval: { head_sha: "h", verification: "confirmed" }, evidence_sha256: null })]).length).toBe(1);
    expect(targets([row({ status: "queued", approval: { head_sha: "h", verification: "write-rejected" }, evidence_sha256: "e" })]).length).toBe(1);
    expect(targets([row({ status: "approval_pending_verification", approval: { head_sha: "h", verification: "pending" } })]).length).toBe(1);
    expect(targets([row({ status: "queued", intake: {} })]).length).toBe(0);
    expect(targets([row({ status: "queued", live: { headRefOid: "h", isDraft: true } })]).length).toBe(0);
    expect(targets([row({ status: "queued", intake: {}, review_request: { active: true } })])[0].scope).toBe("direct");
    expect(targets([row({ status: "queued", evidence_sha256: "e" })])[0].evidence).toBe("e");
  });
});

describe("queue exit files", () => {
  const job = (state: any, exit_code?: number | null): Queue => ({
    u: { url: "u", scope: "s", head: "h", updated: "t", priority: 50, state, attempts: 1, enqueued_at: "", exit_code },
  });
  it("recovers a clean exit lost by a server restart, so it is not retried", () => {
    const q = settleExits(job("running"), () => "0\n");
    expect(q.u.exit_code).toBe(0);
    const { queue, start } = plan(q, [{ url: "u", scope: "s", head: "h", updated: "t", priority: 50, evidence: "e" }], 0, () => false);
    expect(queue.u.state).toBe("done");
    expect(start).toEqual([]);
  });
  it("keeps recorded codes and ignores missing or garbage files", () => {
    expect(settleExits(job("running", 1), () => "0").u.exit_code).toBe(1);
    expect(settleExits(job("running"), () => null).u.exit_code).toBeUndefined();
    expect(settleExits(job("running"), () => "x").u.exit_code).toBeUndefined();
    expect(settleExits(job("done"), () => "0").u.exit_code).toBeUndefined();
  });
});

describe("queue outage recovery", () => {
  const exhausted = (revivals = 0): Queue => ({ [T(1).url]: { ...T(1), state: "exhausted", attempts: MAX_ATTEMPTS, enqueued_at: "", revivals } });
  const finishing = (code: number): Queue => {
    const r = plan({}, [T(2)], 0, dead);
    r.start[0].pid = 7;
    r.start[0].exit_code = code;
    return r.queue;
  };
  it("revives exhausted jobs once another worker succeeds", () => {
    const r = plan({ ...exhausted(), ...finishing(0) }, [T(1)], 1, dead);
    expect(r.start.map((j) => j.url)).toEqual([T(1).url]);
    expect(r.start[0].attempts).toBe(1);
    expect(r.queue[T(1).url].revivals).toBe(1);
  });
  it("keeps exhausted jobs while workers still fail or the revival budget is spent", () => {
    expect(plan({ ...exhausted(), ...finishing(1) }, [T(1), T(2)], 1, dead).queue[T(1).url].state).toBe("exhausted");
    expect(plan({ ...exhausted(MAX_REVIVALS), ...finishing(0) }, [T(1)], 1, dead).queue[T(1).url].state).toBe("exhausted");
  });
});

describe("authored jobs", () => {
  it("keeps the kind and retries a failed re-check with backoff", () => {
    const t: Target = { url: "https://github.com/o/r/pull/9", kind: "authored", head: "h", updated: "ci_failed", priority: 60, scope: "authored" };
    const { queue, start } = plan({}, [t], 0, () => false);
    expect(start[0].kind).toBe("authored");
    queue[t.url].exit_code = 1;
    const r = plan(queue, [t], 1, () => false);
    expect(r.queue[t.url].state).toBe("waiting");
    expect(r.queue[t.url].next_at).toBe(new Date(1 + BACKOFF_MS).toISOString());
  });
});
