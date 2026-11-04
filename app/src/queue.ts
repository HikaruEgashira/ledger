// node:child_process: Bun.spawn cannot detach workers into their own process group.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./lib/util.ts";
import { escapeRe, localConfig, org } from "./lib/org.ts";

export const CONCURRENCY = 50;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 10 * 60_000;
const POLLER_SOURCE = "review-poller";
const LEGACY_REASON = "team poller";
const DIRECT = "direct";

export type JobState = "waiting" | "running" | "done" | "exhausted";
export interface Job {
  url: string;
  scope: string;
  head: string;
  updated: string;
  priority: number;
  state: JobState;
  attempts: number;
  enqueued_at: string;
  pid?: number;
  started_at?: string;
  finished_at?: string;
  next_at?: string;
  exit_code?: number | null;
  evidence?: string | null;
}
export type Queue = Record<string, Job>;
type Row = Record<string, any>;
export interface Target {
  url: string;
  scope: string;
  head: string;
  updated: string;
  priority: number;
  /** Ledger `evidence_sha256`; only a worker's `record` changes it (sync refreshes `decision` too). */
  evidence?: string | null;
}

export function rowScope(row: Row): string | null {
  const intake = row.intake ?? {};
  if (intake.source === POLLER_SOURCE) return intake.scope ?? null;
  if (String(intake.reason ?? "").includes(LEGACY_REASON)) return "ai-driven-dev";
  return null;
}

/** Rows a worker should process now: scoped or directly requested, queued or awaiting post-approval verification. */
export function targets(rows: Row[]): Target[] {
  const out: Target[] = [];
  for (const r of rows) {
    const scope = rowScope(r) ?? (r.review_request?.active ? DIRECT : null);
    if (!scope) continue;
    if (r.live?.isDraft) continue; // drafts are not ready for review; they re-enter once marked ready
    const head = r.live?.headRefOid ?? r.intake?.head_sha ?? "";
    const updated = r.live?.updatedAt ?? "";
    const approvedHead = r.approval?.head_sha;
    const verifying = r.approval?.verification === "pending";
    const evidence = r.evidence_sha256 ?? null;
    // Re-reviewing an unchanged approved head only risks clobbering its evidence.
    if (r.status === "queued" && !(approvedHead && approvedHead === head && !verifying))
      out.push({ url: r.url, scope, head, updated, priority: r.priority ?? 50, evidence });
    else if (r.status === "approval_pending_verification" && verifying)
      out.push({ url: r.url, scope, head, updated, priority: r.priority ?? 50, evidence });
  }
  return out;
}

/** Pure state transition: settle finished jobs, sync with targets, pick jobs to start. */
export function plan(
  queue: Queue,
  wanted: Target[],
  now: number,
  alive: (pid: number) => boolean,
  limit = CONCURRENCY,
): { queue: Queue; start: Job[] } {
  const iso = new Date(now).toISOString();
  const want = new Map(wanted.map((t) => [t.url, t]));
  const next: Queue = {};
  for (const [url, job] of Object.entries(queue)) {
    const t = want.get(url);
    if (job.state === "running" && job.pid && alive(job.pid)) {
      next[url] = job;
      continue;
    }
    if (!t) continue; // processed: the row left the queue
    // A new head or PR activity (e.g. resolved threads) is new work with a fresh budget.
    if (t.head !== job.head || t.updated !== job.updated) continue;
    if (job.state === "running") {
      // Done only if the worker exited cleanly and recorded evidence; a clean exit without it (e.g. a blocked record) retries.
      const ok = job.exit_code === 0 && (t.evidence ?? null) !== (job.evidence ?? null);
      next[url] = {
        ...job,
        pid: undefined,
        finished_at: iso,
        state: ok ? "done" : job.attempts >= MAX_ATTEMPTS ? "exhausted" : "waiting",
        next_at: ok ? undefined : new Date(now + BACKOFF_MS).toISOString(),
      };
    } else next[url] = { ...job, priority: t.priority, scope: t.scope, evidence: t.evidence };
  }
  for (const t of wanted)
    if (!next[t.url]) next[t.url] = { ...t, state: "waiting", attempts: 0, enqueued_at: iso };
  const running = Object.values(next).filter((j) => j.state === "running").length;
  const ready = Object.values(next)
    .filter((j) => j.state === "waiting" && (!j.next_at || Date.parse(j.next_at) <= now))
    .sort((a, b) => a.priority - b.priority || a.enqueued_at.localeCompare(b.enqueued_at));
  const start = ready.slice(0, Math.max(0, limit - running));
  for (const j of start) {
    j.state = "running";
    j.attempts += 1;
    j.started_at = iso;
    j.finished_at = undefined;
    j.next_at = undefined;
    j.exit_code = undefined;
  }
  return { queue: next, start };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// PIDs get reused (e.g. by a browser), so a live PID only counts if it is still this PR's worker.
function workerAlive(pid: number, q: Queue): boolean {
  if (!pidAlive(pid)) return false;
  const url = Object.values(q).find((j) => j.pid === pid)?.url;
  return !!url && exec(["ps", "-o", "command=", "-p", String(pid)]).stdout.includes(url);
}

export const queuePath = (root: string) => join(root, "logs/queue.json");

export function readQueue(root: string): Queue {
  try {
    return existsSync(queuePath(root)) ? JSON.parse(readFileSync(queuePath(root), "utf8")) : {};
  } catch {
    return {};
  }
}

function writeQueue(root: string, q: Queue) {
  const tmp = queuePath(root) + ".tmp";
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, queuePath(root));
}

function argv(root: string, job: Job): string[] {
  const config = localConfig(join(root, "config/config.toml"));
  const command: string[] = config.worker_command;
  const scope = (config.scopes ?? []).find((s: any) => s.name === job.scope);
  // Direct requests get the full review; only scoped team PRs narrow to their profile.
  const focus = scope ? ` Read ${scope.profile} and check only those viewpoints.` : "";
  return [
    ...command.slice(0, -1),
    command.at(-1) + focus + " Process only this PR this run; skip full-ledger sync and delivery checks: " + job.url,
  ];
}

function recordExit(root: string, url: string, pid: number | undefined, code: number | null) {
  const q = readQueue(root);
  const job = q[url];
  if (!job || job.pid !== pid) return;
  job.exit_code = code;
  writeQueue(root, q);
  console.log(JSON.stringify({ event: code === 0 ? "QUEUE_DONE" : "QUEUE_FAILED", url, exit_code: code, at: new Date().toISOString() }));
}

// Exit codes land in a file so a serve restart cannot lose them and turn a finished review into a retry.
export const exitPath = (root: string, url: string) =>
  join(root, "logs/review-poller/exit", new Bun.CryptoHasher("sha1").update(url).digest("hex"));

/** Fill exit codes of running jobs from durable exit files. */
export function settleExits(q: Queue, read: (url: string) => string | null): Queue {
  for (const job of Object.values(q)) {
    if (job.state !== "running" || job.exit_code != null) continue;
    const raw = read(job.url)?.trim();
    if (raw && /^\d+$/.test(raw)) job.exit_code = Number(raw);
  }
  return q;
}

const readExit = (root: string) => (url: string) => {
  try {
    return readFileSync(exitPath(root, url), "utf8");
  } catch {
    return null;
  }
};

export function tick(root: string, rows: Row[], now = Date.now()): Job[] {
  const q = settleExits(readQueue(root), readExit(root));
  const { queue, start } = plan(q, targets(rows), now, (pid) => workerAlive(pid, q));
  const log = openSync(join(root, "logs/review-poller/worker.log"), "a");
  for (const job of start) {
    const exit = exitPath(root, job.url);
    mkdirSync(join(exit, ".."), { recursive: true });
    rmSync(exit, { force: true });
    const child = spawn("/bin/sh", ["-c", '"$@"; echo $? > "$QUEUE_EXIT_FILE"', "sh", ...argv(root, job)], {
      cwd: root,
      stdio: ["ignore", log, log],
      detached: true,
      env: { ...process.env, QUEUE_EXIT_FILE: exit },
    });
    child.on("error", (e) => console.error(`error: queue spawn ${job.url}: ${e.message}`));
    child.on("exit", (code) => recordExit(root, job.url, child.pid, code));
    child.unref();
    job.pid = child.pid;
    console.log(JSON.stringify({ event: "QUEUE_STARTED", url: job.url, attempt: job.attempts, at: new Date(now).toISOString() }));
  }
  writeQueue(root, queue);
  return start;
}
