import { createServer, type ServerResponse } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readLedger, toCard } from "./ledger.ts";
import { readLogs, stampLogs } from "./logs.ts";
import { CONCURRENCY, readQueue, tick } from "./queue.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const DIST = resolve(import.meta.dirname, "../dist");
const HOSTS = ["127.0.0.1", "localhost", "::1"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
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

function send(res: ServerResponse, body: string | Buffer, type: string) {
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
  });
  res.end(body);
}

// Child process keeps synchronous gh calls off the HTTP event loop.
function monitorTick(): Promise<void> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "app/src/reviewctl/cli.ts"), "--ledger", args.ledger, "monitor", "--once"],
      { stdio: "inherit" },
    );
    child.on("error", (e) => {
      console.error(`error: ${e.message}`);
      done();
    });
    child.on("exit", () => done());
  });
}
// Dispatch runs on its own cadence so a slow ledger sync never delays starting workers.
async function queueLoop() {
  for (;;) {
    try {
      tick(ROOT, readLedger(args.ledger));
    } catch (e) {
      console.error(`error: queue tick: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
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
    await new Promise((r) => setTimeout(r, Number(args.interval) * 1000));
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/api/rows") {
    try {
      const queue = readQueue(ROOT);
      const cards = readLedger(args.ledger).map((row) => {
        const j = queue[row.url];
        return { ...toCard(row), queue: j ? { state: j.state, attempts: j.attempts, started_at: j.started_at ?? null, next_at: j.next_at ?? null } : null };
      });
      send(res, JSON.stringify(cards), "application/json");
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
    return;
  }
  if (path === "/api/queue") {
    send(res, JSON.stringify({ limit: CONCURRENCY, jobs: Object.values(readQueue(ROOT)) }), "application/json");
    return;
  }
  if (path === "/api/logs") {
    try {
      send(res, JSON.stringify(readLogs(ROOT, readLedger(args.ledger))), "application/json");
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
    return;
  }
  if (path === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    let seen: number | null = null;
    const timer = setInterval(() => {
      const mtime = existsSync(args.ledger) ? statSync(args.ledger).mtimeMs : 0;
      res.write(mtime !== seen ? "data: changed\n\n" : ": ping\n\n");
      seen = mtime;
    }, 1000);
    req.on("close", () => clearInterval(timer));
    return;
  }
  const file = resolve(DIST, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  send(res, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
});

server.listen(Number(args.port), args.host, () =>
  console.error(`http://${args.host}:${args.port}/`),
);
void loop();
void queueLoop();
