import { describe, expect, it } from "vitest";
import { BACKOFF_MS, MAX_ATTEMPTS, plan, targets, type Queue, type Target } from "./queue.ts";

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
  it("treats a clean exit as done until the PR changes", () => {
    const r = plan({}, [T(1)], 0, dead);
    r.start[0].pid = 5;
    r.start[0].exit_code = 0;
    const settled = plan(r.queue, [T(1)], 1, dead);
    expect(settled.queue[T(1).url].state).toBe("done");
    expect(plan(settled.queue, [T(1)], 1 + BACKOFF_MS, dead).start).toEqual([]);
    expect(plan(settled.queue, [T(1, "h1", "u2")], 2, dead).start.length).toBe(1);
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
    expect(targets([row({ status: "queued", approval: { head_sha: "h", verification: "confirmed" } })]).length).toBe(0);
    expect(targets([row({ status: "approval_pending_verification", approval: { head_sha: "h", verification: "pending" } })]).length).toBe(1);
    expect(targets([row({ status: "queued", intake: {} })]).length).toBe(0);
    expect(targets([row({ status: "queued", live: { headRefOid: "h", isDraft: true } })]).length).toBe(0);
    expect(targets([row({ status: "queued", intake: {}, review_request: { active: true } })])[0].scope).toBe("direct");
  });
});
