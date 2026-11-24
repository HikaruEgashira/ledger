#!/usr/bin/env bun
// Slack/Jira tasks as an event inbox (tasks.jsonl) on the same queue as PRs: review = they asked me, respond = I asked them.
import * as store from "./lib/store.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BATCH, oneShot, workerCommand } from "./lib/worker.ts";
import { localConfig } from "./lib/org.ts";
import { linkKey } from "../webui/logfilter.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const TASK_LEDGER = join(ROOT, "tasks.jsonl");
export const SYNC_SKILL = "skills/sync-tasks/SKILL.md";
export const RESPOND_SKILL = "skills/respond-tasks/SKILL.md";

export type Source = "slack" | "jira";
/** review: someone asked me (I owe the answer). respond: I asked someone (I owe the follow-up). */
export type Axis = "review" | "respond";
/** Who holds the ball: triage = new thread activity a worker must classify first, mine = worker acts, theirs = wait (until follow_up_at), human = deferred to me, done = closed. */
export type Ball = "triage" | "mine" | "theirs" | "human" | "done";
const BALLS: Ball[] = ["triage", "mine", "theirs", "human", "done"];
export const HOLD = "Hold";
export const RETRY = "Retry";

export interface TaskRow {
  id: string; // dedupe key from the source: slack:<channel>:<thread_ts> / jira:<KEY>
  source: Source;
  axis: Axis;
  url: string;
  title: string;
  counterpart: string;
  ball: Ball;
  /** Source activity key (latest message ts / Jira updated); a change is new work. */
  activity: string;
  summary?: string;
  follow_up_at?: string;
  question?: string;
  options?: string[];
  answer?: { choice: string; at: string; by: "human" | "auto" };
  note?: string;
  intake_at: string;
  synced_at: string;
}

const ID_RE = /^(slack:[A-Z0-9]+:\d+\.\d+|jira:[A-Z][A-Z0-9]+-\d+)$/;
const URL_RE = /^https:\/\/[a-z0-9.-]+\.(slack\.com|atlassian\.net)\//;

export function readTasks(path = TASK_LEDGER): TaskRow[] {
  return (store.readText(path) ?? "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function writeTasks(path: string, rows: TaskRow[]): void {
  rows.sort((a, b) => a.id.localeCompare(b.id));
  store.writeText(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export interface Incoming {
  id: string;
  source: Source;
  axis: Axis;
  url: string;
  title: string;
  counterpart: string;
  activity: string;
  ball: Ball;
  summary?: string;
}
/** The id is derived from the URL, so DLP masking of a raw ts in agent output cannot corrupt the dedupe key. */
export function idFromUrl(url: string): string | null {
  const k = linkKey(url);
  return k === url ? null : k;
}

export function validate(x: any): Incoming {
  x = { ...x, id: idFromUrl(String(x?.url ?? "")) ?? x?.id };
  if (!ID_RE.test(x?.id ?? "")) throw new Error(`invalid id: ${x?.id}`);
  if (!["slack", "jira"].includes(x.source) || !x.id.startsWith(x.source + ":")) throw new Error(`invalid source: ${x.id}`);
  if (!["review", "respond"].includes(x.axis)) throw new Error(`invalid axis: ${x.id}`);
  if (!URL_RE.test(x.url ?? "")) throw new Error(`invalid url: ${x.id}`);
  if (!BALLS.includes(x.ball)) throw new Error(`invalid ball: ${x.id}`);
  if (typeof x.activity !== "string" || !x.activity) throw new Error(`missing activity: ${x.id}`);
  return { ...x, title: String(x.title ?? "").slice(0, 200), counterpart: String(x.counterpart ?? "") };
}

/** Merge one sync result: new activity re-reads the source's ball; unchanged activity keeps the worker's state. */
export function merge(rows: TaskRow[], incoming: Incoming[], now: string): { rows: TaskRow[]; changed: string[] } {
  const by = new Map(rows.map((r) => [r.id, r]));
  const changed: string[] = [];
  for (const i of incoming) {
    const old = by.get(i.id);
    if (!old) {
      by.set(i.id, { ...i, intake_at: now, synced_at: now });
      changed.push(i.id);
    } else if (old.activity !== i.activity && old.ball === "human" && !old.answer) {
      // A pending question waits for the human; new activity is context for the answer, not a reason to act alone.
      by.set(i.id, { ...old, activity: i.activity, title: i.title, synced_at: now });
      changed.push(i.id);
    } else if (old.activity !== i.activity) {
      // A new message is the counterpart moving: drop a stale question and follow-up timer.
      by.set(i.id, { ...old, ...i, question: undefined, options: undefined, answer: undefined, follow_up_at: undefined, synced_at: now });
      changed.push(i.id);
    } else by.set(i.id, { ...old, title: i.title, synced_at: now, ...(i.ball === "done" ? { ball: "done" as Ball } : {}) });
  }
  return { rows: [...by.values()], changed };
}

export interface TaskTarget {
  url: string; // queue key: the task id
  kind: "task";
  scope: Axis;
  head: string;
  updated: string;
  priority: number;
}
/** Tasks a worker should run now: ball mine, an answered deferral, or a due follow-up timer. */
export function taskTargets(rows: TaskRow[], now = Date.now()): TaskTarget[] {
  const out: TaskTarget[] = [];
  for (const r of rows) {
    const due = r.ball === "theirs" && r.follow_up_at && Date.parse(r.follow_up_at) <= now;
    const answered = r.ball === "human" && r.answer && r.answer.choice !== HOLD;
    if (r.ball !== "mine" && r.ball !== "triage" && !due && !answered) continue;
    out.push({
      url: r.id,
      kind: "task",
      scope: r.axis,
      head: r.activity,
      updated: [r.ball, due ? r.follow_up_at : "", r.answer?.at ?? ""].join("|"),
      priority: r.axis === "review" ? 55 : 65,
    });
  }
  return out;
}

export interface PendingTask {
  id: string;
  url: string;
  source: Source;
  axis: Axis;
  title: string;
  question: string;
  options: string[];
  held: boolean;
}
export function pendingTasks(rows: TaskRow[]): PendingTask[] {
  return rows
    .filter((r) => r.ball === "human" && r.question && (!r.answer || r.answer.choice === HOLD))
    .map((r) => ({
      id: r.id,
      url: r.url,
      source: r.source,
      axis: r.axis,
      title: r.title,
      question: r.question!,
      options: [...new Set([...(r.options ?? []), RETRY, HOLD])],
      held: r.answer?.choice === HOLD,
    }));
}

function update(path: string, id: string, f: (r: TaskRow) => TaskRow): TaskRow {
  const rows = readTasks(path);
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) throw new Error(`not in tasks: ${id}`);
  rows[i] = f(rows[i]!);
  writeTasks(path, rows);
  return rows[i]!;
}

export const historyPath = (ledger: string) => join(dirname(ledger), "logs", "task-decisions.jsonl");
export function decideTask(path: string, id: string, choice: string, custom = false, by: "human" | "auto" = "human"): TaskRow {
  return update(path, id, (r) => {
    if (r.ball !== "human" || !r.question) throw new Error("question is stale");
    const allowed = [...(r.options ?? []), RETRY, HOLD];
    const c = choice.trim();
    if (custom ? !c || c.length > 2000 : !allowed.includes(c)) throw new Error(`invalid choice: ${c.slice(0, 80)}`);
    const answer = { choice: c, at: new Date().toISOString(), by };
    store.appendText(historyPath(path), JSON.stringify({ id, question: r.question, options: allowed, ...answer }) + "\n");
    return { ...r, answer };
  });
}

/** Ball left the worker: anything but mine, or an answered question still unconsumed counts as not done. */
export const settled = (r: TaskRow | undefined) => !r || (r.ball !== "mine" && r.ball !== "triage" && !(r.ball === "human" && r.answer && r.answer.choice !== HOLD));

// Keyword searches rotate: a few per run, each only since its own last search, to stay under Slack search rate limits.
export const KEYWORDS_PER_RUN = 3;
const keywordStatePath = (ledger: string) => join(dirname(ledger), "logs", "task-sync-keywords.json");
export function keywordPlan(keywords: string[], last: Record<string, string>, now = Date.now(), perRun = KEYWORDS_PER_RUN): { q: string; after: string }[] {
  const floor = now - 86_400_000;
  const at = (k: string) => Date.parse(last[k] ?? "") || 0;
  return [...keywords]
    .sort((a, b) => at(a) - at(b))
    .slice(0, perRun)
    .map((q) => ({ q, after: new Date(Math.max(at(q), floor)).toISOString() }));
}
function markKeywords(ledger: string, searched: string[], now = new Date().toISOString()): void {
  const state = store.readJson<Record<string, string>>(keywordStatePath(ledger), {});
  for (const k of searched) state[k] = now;
  store.writeJson(keywordStatePath(ledger), state);
}

// Slack coverage watermark: each run scans only from here, so a run never has to cover 14 days of with:me at once.
export const LOOKBACK_MS = 14 * 86_400_000;
const watermarkPath = (ledger: string) => join(dirname(ledger), "logs", "task-sync-watermark.json");
export function readWatermark(ledger: string, now = Date.now()): string {
  try {
    const at = store.readJson<{ slack_covered_until?: string }>(watermarkPath(ledger), {}).slack_covered_until ?? "";
    if (Date.parse(at) > now - LOOKBACK_MS) return at;
  } catch {}
  return new Date(now - LOOKBACK_MS).toISOString();
}
/** Advance only forward: a run reports the newest time it fully covered, never past now. */
export function advance(ledger: string, until: string, now = Date.now()): string {
  const t = Date.parse(until);
  if (Number.isNaN(t) || t > now + 60_000) throw new Error(`invalid --slack-covered-until: ${until}`);
  const cur = readWatermark(ledger, now);
  if (t <= Date.parse(cur)) return cur;
  store.writeJson(watermarkPath(ledger), { slack_covered_until: until });
  return until;
}

function sync(path: string): number {
  // Slack/Jira are reachable only through the worker's MCP connectors; the skill pipes results into `upsert`.
  const since = readWatermark(path);
  // Recent activity first every run, so today's requests never wait behind the backfill.
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  // Extra Slack search terms (own names, watched topics) live in config, not in the published skill.
  const kw: string[] = (localConfig().task_slack_keywords ?? []).filter((k: unknown) => typeof k === "string" && k.trim());
  const plan = keywordPlan(kw, store.readJson<Record<string, string>>(keywordStatePath(path), {}));
  const keywords = plan.length ? ` Slack keyword searches this run: ${JSON.stringify(plan)}.` : "";
  const prompt = `Read ${SYNC_SKILL} and follow it exactly once, then exit. Slack recent window starts at ${recent}; backfill window starts at ${since}.${keywords}`;
  const r = Bun.spawnSync(oneShot(workerCommand(), prompt, BATCH), { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, TASK_LEDGER: path } });
  return r.exitCode ?? 1;
}

if (import.meta.main) {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      ledger: { type: "string", default: process.env.TASK_LEDGER ?? TASK_LEDGER },
      ball: { type: "string" },
      "follow-up": { type: "string" },
      note: { type: "string" },
      reason: { type: "string" },
      option: { type: "string", multiple: true },
      choice: { type: "string" },
      custom: { type: "boolean", default: false },
      "slack-covered-until": { type: "string" },
      "keywords-searched": { type: "string" },
      axis: { type: "string" },
      title: { type: "string" },
    },
  });
  const path = v.ledger!;
  const [cmd = "list", id] = p;
  const need = ["record", "dispatch", "check", "decide", "show"];
  if (!["sync", "upsert", "list", ...need].includes(cmd) || (need.includes(cmd) && !id)) {
    console.error("usage: tasks.ts {sync|upsert [--slack-covered-until ISO] [--keywords-searched JSON] <JSONL|list|show ID|record ID --ball B [--axis A] [--title T] [--follow-up ISO] [--note T]|dispatch ID --reason T [--option T]...|decide ID --choice T|check ID}");
    process.exit(2);
  }
  if (cmd === "sync") process.exit(sync(path));
  if (cmd === "upsert") {
    const now = new Date().toISOString();
    const lines = (await Bun.stdin.text()).split("\n").filter((l) => l.trim());
    const incoming = lines.map((l) => validate(JSON.parse(l))); // all-or-nothing
    const { rows, changed } = merge(readTasks(path), incoming, now);
    writeTasks(path, rows);
    for (const c of changed) console.log(`changed\t${c}`);
    if (v["keywords-searched"]) {
      const ks = JSON.parse(v["keywords-searched"]);
      if (!Array.isArray(ks) || ks.some((k) => typeof k !== "string")) throw new Error("--keywords-searched must be a JSON array of strings");
      markKeywords(path, ks);
    }
    if (v["slack-covered-until"]) console.log(`slack-covered-until\t${advance(path, v["slack-covered-until"])}`);
    process.exit(0);
  }
  if (cmd === "list") {
    for (const r of readTasks(path)) console.log([r.ball, r.axis, r.id, r.url, r.title].join("\t"));
    process.exit(0);
  }
  if (cmd === "show") {
    const r = readTasks(path).find((r) => r.id === id);
    console.log(JSON.stringify(r ?? null, null, 1));
    process.exit(r ? 0 : 1);
  }
  if (cmd === "record") {
    const ball = v.ball as Ball;
    if (!BALLS.includes(ball) || ball === "human" || ball === "triage") throw new Error("--ball must be mine|theirs|done (use dispatch for human)");
    const axis = v.axis as Axis | undefined;
    if (axis && !["review", "respond"].includes(axis)) throw new Error("--axis must be review|respond");
    const fu = v["follow-up"];
    if (fu && Number.isNaN(Date.parse(fu))) throw new Error("--follow-up must be ISO 8601");
    if (ball === "theirs" && !fu) throw new Error("--follow-up is required when the ball is theirs");
    update(path, id!, (r) => ({ ...r, ...(axis ? { axis } : {}), ...(v.title ? { title: v.title.slice(0, 200) } : {}), ball, follow_up_at: fu, note: v.note ?? r.note, question: undefined, options: undefined, answer: undefined }));
    console.log(`recorded\t${id}\t${ball}`);
    process.exit(0);
  }
  if (cmd === "dispatch") {
    if (!v.reason) throw new Error("--reason is required");
    update(path, id!, (r) => ({ ...r, ball: "human", question: v.reason, options: v.option ?? [], answer: undefined, follow_up_at: undefined }));
    console.log(`dispatched\t${id}`);
    process.exit(0);
  }
  if (cmd === "decide") {
    decideTask(path, id!, v.choice ?? "", v.custom);
    console.log(`decided\t${id}`);
    process.exit(0);
  }
  const r = readTasks(path).find((r) => r.id === id);
  const ok = settled(r);
  console.log(`${ok ? "done" : "still-mine"}\t${id}\t${r?.ball ?? "missing"}`);
  process.exit(ok ? 0 : 1);
}

/** Board card: review axis reads like a review request, respond axis like an own PR (same columns, no new panel). */
export function taskCard(r: TaskRow) {
  const review = r.axis === "review";
  const status =
    r.ball === "done" ? "completed"
    : r.ball === "human" ? "human_required"
    : r.ball === "triage" ? "queued"
    : review ? (r.ball === "mine" ? "queued" : "reviewing")
    : r.ball === "mine" ? "mine_changes_requested" : "mine_review_requested";
  const [, scope = "", key = ""] = r.id.split(":");
  const jira = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(scope);
  return {
    kind: review ? ("review" as const) : ("authored" as const),
    url: r.url,
    repository: jira ? `jira/${jira[1]}` : `slack/${scope}`,
    pr_number: jira ? Number(jira[2]) : 0,
    status,
    priority: null,
    title: r.title,
    author: null,
    action: [r.counterpart, r.follow_up_at && r.ball === "theirs" ? `follow-up ${r.follow_up_at.slice(5, 16)}` : null].filter(Boolean).join(" · ") || null,
    last_error: null,
    updated_at: r.synced_at,
    added_at: r.intake_at,
    approved_at: null,
    changes_requested_at: null,
    merged_at: null,
    completed_at: r.ball === "done" ? r.synced_at : null,
    key,
  };
}
