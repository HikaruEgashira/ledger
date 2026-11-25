// Serves the built web UI with generated demo data (no ledger, GitHub or workers) for README screenshots.
import { parseArgs } from "node:util";
import { resolve, sep } from "node:path";

const DIST = resolve(import.meta.dir, "../dist");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "8799" } } });
const HEADERS = { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" };

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const REPOS = ["acme/api", "acme/web", "acme/infra", "acme/billing", "acme/mobile"];
const TITLES = [
  "Add retry to payment webhook", "Bump node to 22", "Fix N+1 in invoice list", "Rotate signing key", "Tighten S3 bucket policy",
  "Add audit log for role changes", "Migrate cron to EventBridge", "Remove legacy feature flag", "Cache exchange rates", "Paginate export API",
  "Harden CSP headers", "Split monolith worker queue", "Add SLO alert for checkout", "Upgrade Terraform provider", "Fix timezone in reports",
];
const AUTHORS = ["ghost"];
const REVIEW_STATUSES: [string, number][] = [
  ["completed", 30], ["queued", 6], ["reviewing", 2], ["waiting_ci", 2], ["changes_requested", 3], ["approved", 3],
  ["human_required", 2], ["post_release_monitoring", 2], ["recovering", 1], ["closed", 4], ["delivery_abandoned", 3],
];
const AUTHORED_STATUSES: [string, number][] = [["mine_review_requested", 4], ["mine_changes_requested", 2], ["mine_ready_to_merge", 1], ["completed", 5]];

function rows() {
  const out: Record<string, unknown>[] = [];
  let n = 100;
  const add = (kind: string, status: string) => {
    const repo = pick(REPOS);
    const num = n++;
    const added = now - (2 + rand() * 28) * DAY;
    const approved = ["approved", "post_release_monitoring", "recovering", "completed"].includes(status) ? added + rand() * DAY : null;
    const merged = approved && status !== "approved" ? approved + rand() * DAY : null;
    const completed = status === "completed" && merged ? Math.min(now, merged + rand() * DAY) : null;
    out.push({
      kind, url: `https://github.com/${repo}/pull/${num}`, repository: repo, pr_number: num, status, priority: 50,
      title: pick(TITLES), author: pick(AUTHORS), action: null, last_error: status === "human_required" ? "needs business risk acceptance" : null,
      updated_at: iso(completed ?? merged ?? approved ?? added + DAY), added_at: iso(added),
      approved_at: approved && iso(approved), changes_requested_at: status === "changes_requested" ? iso(added + DAY / 2) : null,
      merged_at: merged && iso(merged), completed_at: completed && iso(completed), queue: null,
    });
  };
  for (const [s, c] of REVIEW_STATUSES) for (let i = 0; i < c; i++) add("review", s);
  for (const [s, c] of AUTHORED_STATUSES) for (let i = 0; i < c; i++) add("authored", s);
  (out.find((r) => r.status === "queued")!).queue = { state: "running", attempts: 1, started_at: iso(now - 4 * 60_000) };
  for (const [repo, num, status, title] of [["slack/C0DEMO", 0, "queued", "Question about log retention"], ["jira/OPS", 4211, "mine_review_requested", "Confirm firewall change window"]] as const)
    out.push({ kind: status.startsWith("mine") ? "authored" : "review", url: `https://example.com/${repo}/${num}`, repository: repo, pr_number: num, status, priority: 50, title, author: "ghost", action: null, last_error: null, updated_at: iso(now - DAY), added_at: iso(now - 2 * DAY), approved_at: null, changes_requested_at: null, merged_at: null, completed_at: null, queue: null });
  return out;
}
const ROWS = rows();
const LOGS = Array.from({ length: 40 }, (_, i) => {
  const r = pick(ROWS);
  const [level, msg] = pick([["info", "review recorded: ready_to_approve"], ["info", "HEAD_CHANGED: queued for re-review"], ["warn", "CI_PENDING: waiting for required checks"], ["info", "MERGED: delivery plan frozen"], ["error", "SYNC_FAILED: GitHub API timeout"]]);
  return { source: pick(["serve", "queue", "worker"]), level, ts: iso(now - i * 37 * 60_000), links: [r.url], msg };
});
const ASKS = [
  ["business-risk-acceptance", "This removes a deprecated endpoint still called by one partner. Accept the risk and approve?", ["Approve", "Request changes", "Hold"]],
  ["ambiguous-intent", "The PR changes retention from 90 to 30 days but the linked ticket says 60. Which is intended?", ["30 days", "60 days", "Ask the author"]],
] as const;
const DECISIONS = ROWS.filter((r) => r.status === "human_required").map((r, i) => ({
  url: r.url, repository: r.repository, pr_number: r.pr_number, title: r.title, reason: ASKS[i % 2]![0], head: "0".repeat(40),
  question: ASKS[i % 2]![1], options: [...ASKS[i % 2]![2]], asked_at: iso(now - DAY), held: false,
}));

const json = (body: unknown) => Response.json(body, { headers: HEADERS });
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  routes: {
    "/api/rows": () => json(ROWS),
    "/api/queue": () => json({ limit: 50, jobs: [] }),
    "/api/logs": () => json(LOGS),
    "/api/decisions": () => json(DECISIONS),
    "/api/tasks": () => json({ tasks: [], pending: [] }),
    "/api/sync": () => json({ ok: true }),
    "/api/events": () => new Response("data: changed\n\nevent: sync\ndata: {\"running\":false,\"next_at\":null}\n\n", { headers: { ...HEADERS, "Content-Type": "text/event-stream" } }),
  },
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const path = resolve(DIST, "." + (p === "/" ? "/index.html" : p));
    const file = Bun.file(path);
    return path.startsWith(DIST + sep) && (await file.exists()) ? new Response(file, { headers: HEADERS }) : new Response(null, { status: 404 });
  },
});
console.error(`demo: http://127.0.0.1:${args.port}/`);
