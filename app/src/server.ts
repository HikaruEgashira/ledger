import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readLedger, toCard } from "./ledger.ts";
import { AUTHORED_LEDGER, authoredTargets, CLOSE, decide, pendingDecisions, readAuthored, readDecisions, readDispatched } from "./authored-prs.ts";
import { localConfig } from "./lib/org.ts";
import type { Card } from "../webui/dashboard.ts";
import { readLogs, stampLogs } from "./logs.ts";
import { CONCURRENCY, readQueue, tick } from "./queue.ts";

const ROOT = resolve(import.meta.dir, "../..");
const DIST = resolve(import.meta.dir, "../dist");
const HOSTS = ["127.0.0.1", "localhost", "::1"];
const CSP =
  "default-src 'self'; img-src https://github.com https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'";

const { values: args } = parseArgs({
  options: {
    ledger: { type: "string", default: join(ROOT, "pull_requests.jsonl") },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8765" },
    interval: { type: "string", default: "60" },
  },
});
if (!HOSTS.includes(args.host)) throw new Error(`--host must be one of ${HOSTS.join(", ")}`);
if (!(Number(args.interval) >= 30)) throw new Error("--interval must be at least 30 seconds");

const HEADERS = { "Cache-Control": "no-store", "Content-Security-Policy": CSP };
const json = (body: unknown) => Response.json(body, { headers: HEADERS });
const fail = (e: unknown) => new Response((e as Error).message, { status: 500 });

// Child process keeps synchronous gh calls off the HTTP event loop.
async function monitorTick(): Promise<void> {
  try {
    await Bun.spawn([process.execPath, join(ROOT, "app/src/reviewctl/cli.ts"), "--ledger", args.ledger, "monitor", "--once"], {
      stdio: ["ignore", "inherit", "inherit"],
    }).exited;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
  }
}
// Enabling GitHub auto-merge on own non-draft PRs is opt-in: set authored_auto_merge_app (a write-capable GHTKN app) in config.toml.
const AUTO_MERGE_APP: unknown = localConfig().authored_auto_merge_app;
// Responding to own PRs whose ball is with the author is opt-in: authored_respond = true.
const RESPOND = localConfig().authored_respond === true;
async function authoredTick(): Promise<void> {
  const script = join(ROOT, "app/src/authored-prs.ts");
  try {
    const synced = await Bun.spawn([process.execPath, script, "sync"], { stdio: ["ignore", "ignore", "inherit"] }).exited;
    if (synced !== 0 || typeof AUTO_MERGE_APP !== "string" || !AUTO_MERGE_APP) return;
    await Bun.spawn([process.execPath, script, "merge", "--yes"], {
      env: { ...process.env, GHTKN_APP: AUTO_MERGE_APP },
      stdio: ["ignore", "inherit", "inherit"],
    }).exited;
  } catch (e) {
    console.error(`error: authored sync/merge: ${(e as Error).message}`);
  }
}
async function authoredLoop() {
  for (;;) {
    await authoredTick();
    await Bun.sleep(Math.max(300, Number(args.interval)) * 1000);
  }
}
// Dispatch runs on its own cadence so a slow ledger sync never delays starting workers.
// Consecutive failures mean a broken process (e.g. EBADF); exit so launchd KeepAlive restarts it.
const MAX_TICK_FAILURES = 5;
async function queueLoop() {
  let failures = 0;
  for (;;) {
    try {
      tick(ROOT, readLedger(args.ledger), Date.now(), RESPOND ? authoredTargets(readAuthored(), readDispatched(), readDecisions()) : []);
      failures = 0;
    } catch (e) {
      console.error(`error: queue tick: ${(e as Error).message}`);
      if (++failures >= MAX_TICK_FAILURES) {
        console.error(`fatal: queue tick failed ${failures} times in a row; exiting for restart`);
        process.exit(1);
      }
    }
    await Bun.sleep(15_000);
  }
}
async function loop() {
  for (;;) {
    await monitorTick();
    try {
      stampLogs(ROOT);
    } catch (e) {
      console.error(`error: log stamp: ${(e as Error).message}`);
    }
    await Bun.sleep(Number(args.interval) * 1000);
  }
}

function events(req: Request): Response {
  let seen: number | null = null;
  let timer: Timer;
  const stream = new ReadableStream({
    start(c) {
      timer = setInterval(() => {
        const mtime = [args.ledger, AUTHORED_LEDGER].reduce((m, p) => m + (existsSync(p) ? statSync(p).mtimeMs : 0), 0);
        c.enqueue(mtime !== seen ? "data: changed\n\n" : ": ping\n\n");
        seen = mtime;
      }, 1000);
      req.signal.addEventListener("abort", () => clearInterval(timer));
    },
    cancel: () => clearInterval(timer),
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
}

function rows(): Response {
  const queue = readQueue(ROOT);
  const tag = (url: string) => {
    const j = queue[url];
    return j ? { state: j.state, attempts: j.attempts, started_at: j.started_at ?? null, next_at: j.next_at ?? null } : null;
  };
  const review: Card[] = readLedger(args.ledger).map((row) => ({ kind: "review", ...toCard(row), queue: tag(row.url) }));
  const authored: Card[] = readAuthored().map((r) => ({
    kind: "authored",
    url: r.url,
    repository: r.repository,
    pr_number: r.pr_number,
    status: r.status,
    priority: null,
    title: r.title,
    author: r.author,
    action: [r.reason, r.auto_merge ? "auto-merge" : null].filter(Boolean).join(" · ") || null,
    last_error: null,
    updated_at: r.updated_at,
    added_at: r.created_at,
    approved_at: null,
    changes_requested_at: null,
    merged_at: null,
    completed_at: null,
    queue: tag(r.url),
  }));
  return json([...review, ...authored]);
}

// Answers mutate state, so only same-origin JSON posts from this dashboard are accepted.
async function answer(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method !== "POST" || !req.headers.get("content-type")?.startsWith("application/json") || !origin || new URL(origin).host !== new URL(req.url).host)
    return new Response("forbidden", { status: 403 });
  try {
    const { url, head, choice, custom } = (await req.json()) as { url: string; head: string; choice: string; custom?: boolean };
    if (!custom && choice === CLOSE) {
      if (typeof AUTO_MERGE_APP !== "string" || !AUTO_MERGE_APP) throw new Error("authored_auto_merge_app is not set");
      const r = Bun.spawnSync(["gh", "pr", "close", url], { env: { ...process.env, GHTKN_APP: AUTO_MERGE_APP }, stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`gh pr close failed: ${r.stderr.toString().trim()}`);
    }
    return json(decide(AUTHORED_LEDGER, url, head, String(choice), custom === true));
  } catch (e) {
    return new Response((e as Error).message, { status: 409 });
  }
}

async function asset(pathname: string): Promise<Response> {
  const path = resolve(DIST, "." + (pathname === "/" ? "/index.html" : pathname));
  const file = Bun.file(path);
  if (!path.startsWith(DIST + sep) || !(await file.exists())) return new Response(null, { status: 404 });
  return new Response(file, { headers: HEADERS });
}

Bun.serve({
  hostname: args.host,
  port: Number(args.port),
  idleTimeout: 0,
  routes: {
    "/api/rows": () => { try { return rows(); } catch (e) { return fail(e); } },
    "/api/queue": () => json({ limit: CONCURRENCY, jobs: Object.values(readQueue(ROOT)) }),
    "/api/logs": () => { try { return json(readLogs(ROOT, readLedger(args.ledger))); } catch (e) { return fail(e); } },
    "/api/events": events,
    "/api/decisions": () => { try { return json(pendingDecisions(readAuthored(), readDispatched(), readDecisions())); } catch (e) { return fail(e); } },
    "/api/decide": answer,
  },
  fetch: (req) => asset(new URL(req.url).pathname),
});
console.error(`http://${args.host}:${args.port}/`);
void loop();
void queueLoop();
void authoredLoop();
