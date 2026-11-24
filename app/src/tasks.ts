#!/usr/bin/env bun
// Slack/Jira tasks as an event inbox (tasks.jsonl) on the same queue as PRs: review = they asked me, respond = I asked them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BATCH, oneShot, workerCommand } from "./lib/worker.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const TASK_LEDGER = join(ROOT, "tasks.jsonl");
export const SYNC_SKILL = "skills/sync-tasks/SKILL.md";
export const RESPOND_SKILL = "skills/respond-tasks/SKILL.md";

export type Source = "slack" | "jira";
/** review: someone asked me (I owe the answer). respond: I asked someone (I owe the follow-up). */
export type Axis = "review" | "respond";
/** Who holds the ball: mine = worker acts, theirs = wait (until follow_up_at), human = deferred to me, done = closed. */
export type Ball = "mine" | "theirs" | "human" | "done";
const BALLS: Ball[] = ["mine", "theirs", "human", "done"];
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
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function writeTasks(path: string, rows: TaskRow[]): void {
  const tmp = join(dirname(path), `.tmp-tasks-${process.pid}`);
  rows.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(tmp, path);
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
export function validate(x: any): Incoming {
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
    if (r.ball !== "mine" && !due && !answered) continue;
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
    mkdirSync(dirname(historyPath(path)), { recursive: true });
    appendFileSync(historyPath(path), JSON.stringify({ id, question: r.question, options: allowed, ...answer }) + "\n");
    return { ...r, answer };
  });
}

/** Ball left the worker: anything but mine, or an answered question still unconsumed counts as not done. */
export const settled = (r: TaskRow | undefined) => !r || (r.ball !== "mine" && !(r.ball === "human" && r.answer && r.answer.choice !== HOLD));

function sync(path: string): number {
  // Slack/Jira are reachable only through the worker's MCP connectors; the skill pipes results into `upsert`.
  const prompt = `Read ${SYNC_SKILL} and follow it exactly once, then exit.`;
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
    },
  });
  const path = v.ledger!;
  const [cmd = "list", id] = p;
  const need = ["record", "dispatch", "check", "decide", "show"];
  if (!["sync", "upsert", "list", ...need].includes(cmd) || (need.includes(cmd) && !id)) {
    console.error("usage: tasks.ts {sync|upsert <JSONL|list|show ID|record ID --ball B [--follow-up ISO] [--note T]|dispatch ID --reason T [--option T]...|decide ID --choice T|check ID}");
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
    if (!BALLS.includes(ball) || ball === "human") throw new Error("--ball must be mine|theirs|done (use dispatch for human)");
    const fu = v["follow-up"];
    if (fu && Number.isNaN(Date.parse(fu))) throw new Error("--follow-up must be ISO 8601");
    if (ball === "theirs" && !fu) throw new Error("--follow-up is required when the ball is theirs");
    update(path, id!, (r) => ({ ...r, ball, follow_up_at: fu, note: v.note ?? r.note, question: undefined, options: undefined, answer: undefined }));
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
