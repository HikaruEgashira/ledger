#!/usr/bin/env bun
// Work-tool tasks (skills/sources/*: Slack threads, Jira issues, ...) as an event inbox (tasks.jsonl) on the same queue as PRs: review = they asked me, respond = I asked them.
import * as store from "./lib/store.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BATCH, oneShot, workerCommand } from "./lib/worker.ts";
import { localConfig } from "./lib/org.ts";
import { cardRef, loadSources, sourceKey, sourceOf, type SourceDef } from "./lib/sources.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const TASK_LEDGER = join(ROOT, "tasks.jsonl");
export const SYNC_SKILL = "skills/sync-tasks/SKILL.md";
export const RESPOND_SKILL = "skills/respond-tasks/SKILL.md";

/** Name of a connector under skills/sources. */
export type Source = string;
/** review: someone asked me (I owe the answer). respond: I asked someone (I owe the follow-up). */
export type Axis = "review" | "respond";
/** Who holds the ball: triage = new thread activity a worker must classify first, mine = worker acts, theirs = wait (until follow_up_at), human = deferred to me, done = closed. */
export type Ball = "triage" | "mine" | "theirs" | "human" | "done";
const BALLS: Ball[] = ["triage", "mine", "theirs", "human", "done"];
export const HOLD = "Hold";
export const RETRY = "Retry";

export interface TaskRow {
  id: string; // dedupe key derived from the URL by the source: <source>:<id per SOURCE.md>
  source: Source;
  axis: Axis;
  url: string;
  title: string;
  counterpart: string;
  /** Watched person (config task_people name) whose task this is; absent = mine. */
  for?: string;
  ball: Ball;
  /** Source activity key (latest message time, issue updated); a change is new work. */
  activity: string;
  summary?: string;
  follow_up_at?: string;
  question?: string;
  options?: string[];
  answer?: { choice: string; at: string; by: "human" | "auto" };
  note?: string;
  /** Related items (other sources' items, GitHub PRs) this request also lives in; shared links group tasks. */
  links?: string[];
  intake_at: string;
  synced_at: string;
}


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
  for?: string;
  summary?: string;
}
/** The id is derived from the URL, so DLP masking of a raw ts in agent output cannot corrupt the dedupe key. */
export function idFromUrl(url: string): string | null {
  return sourceKey(url);
}

export function validate(x: any): Incoming {
  x = { ...x, id: idFromUrl(String(x?.url ?? "")) ?? x?.id };
  // Only a URL a connector recognizes becomes a task; its id is derived from that URL, never taken from the input.
  if (!idFromUrl(String(x?.url ?? ""))) throw new Error(`invalid url: ${x?.url}`);
  if (sourceOf(x.id)?.name !== x.source) throw new Error(`invalid source: ${x.id}`);
  if (!["review", "respond"].includes(x.axis)) throw new Error(`invalid axis: ${x.id}`);
  if (!BALLS.includes(x.ball)) throw new Error(`invalid ball: ${x.id}`);
  if (typeof x.activity !== "string" || !x.activity) throw new Error(`missing activity: ${x.id}`);
  const people = taskPeople().map((p) => p.name);
  if (x.for != null && !people.includes(x.for)) throw new Error(`invalid for: ${x.id}`);
  return { ...x, title: String(x.title ?? "").slice(0, 200), counterpart: String(x.counterpart ?? "") };
}

/** Merge one sync result: new activity re-reads the source's ball; unchanged activity keeps the worker's state. */
/** Default follow-up for a request intake already finds waiting on its counterpart. */
export const FOLLOW_UP_MS = 2 * 86_400_000;

/** Activity only moves forward: a run that happens to see an older hit of the thread is not new work. */
export function newer(next: string, prev: string): boolean {
  const a = Date.parse(next), b = Date.parse(prev);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a > b;
  const x = Number(next), y = Number(prev); // epoch-style ts (Slack)
  if (Number.isFinite(x) && Number.isFinite(y)) return x > y;
  return next !== prev;
}

export function merge(rows: TaskRow[], incoming: Incoming[], now: string): { rows: TaskRow[]; changed: string[] } {
  const by = new Map(rows.map((r) => [r.id, r]));
  const changed: string[] = [];
  for (const i of incoming) {
    const old = by.get(i.id);
    if (!old) {
      // Waiting on someone from the start still needs a timer, or nobody ever follows up.
      const follow = i.ball === "theirs" ? { follow_up_at: new Date(Date.parse(now) + FOLLOW_UP_MS).toISOString() } : {};
      by.set(i.id, { ...i, ...follow, intake_at: now, synced_at: now });
      changed.push(i.id);
    } else if (newer(i.activity, old.activity) && old.ball === "human" && !old.answer) {
      // A pending question waits for the human; new activity is context for the answer, not a reason to act alone.
      by.set(i.id, { ...old, activity: i.activity, title: i.title, synced_at: now });
      changed.push(i.id);
    } else if (newer(i.activity, old.activity)) {
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
/** Canonical key of a source item or GitHub PR URL; other URLs do not group. */
export function refKey(url: string): string | null {
  const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return gh ? `gh:${gh[1]}#${gh[2]}` : idFromUrl(url);
}

/** One request, many places: tasks sharing a source item or PR form a group led by one primary. */
export function groups(rows: TaskRow[]): Map<string, { primary: string; members: string[] }> {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const owner = new Map<string, string>();
  for (const r of rows)
    for (const k of [r.id, ...(r.links ?? []).map(refKey)].filter(Boolean) as string[]) {
      const o = owner.get(k);
      if (o) parent.set(find(r.id), find(o));
      else owner.set(k, r.id);
    }
  const rank = (r: TaskRow) => (sourceOf(r.id)?.record ? 0 : 1);
  const by = new Map<string, TaskRow[]>();
  for (const r of rows) by.set(find(r.id), [...(by.get(find(r.id)) ?? []), r]);
  const out = new Map<string, { primary: string; members: string[] }>();
  for (const g of by.values()) {
    // The system of record (record: true) leads over conversations, then the earliest intake.
    const [p, ...rest] = [...g].sort((a, b) => rank(a) - rank(b) || a.intake_at.localeCompare(b.intake_at));
    const v = { primary: p!.id, members: rest.map((r) => r.id) };
    for (const r of g) out.set(r.id, v);
  }
  return out;
}
const isPrimary = (gs: ReturnType<typeof groups>, id: string) => gs.get(id)?.primary === id;

export function taskTargets(rows: TaskRow[], now = Date.now()): TaskTarget[] {
  const out: TaskTarget[] = [];
  const gs = groups(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (!isPrimary(gs, r.id)) continue; // a member is worked through its primary
    const members = gs.get(r.id)!.members.map((m) => byId.get(m)!);
    const due = r.ball === "theirs" && r.follow_up_at && Date.parse(r.follow_up_at) <= now;
    const answered = r.ball === "human" && r.answer && r.answer.choice !== HOLD;
    const moved = members.some((m) => m.ball === "triage"); // new activity on a linked thread/issue
    if (r.ball !== "mine" && r.ball !== "triage" && !due && !answered && !(moved && r.ball !== "human")) continue;
    out.push({
      url: r.id,
      kind: "task",
      scope: r.axis,
      head: [r.activity, ...members.map((m) => m.activity)].join("|"),
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
  const gs = groups(rows);
  return rows
    .filter((r) => isPrimary(gs, r.id) && r.ball === "human" && r.question && (!r.answer || r.answer.choice === HOLD))
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

// Keyword searches rotate: a few per run, each only since its own last search, to stay under search rate limits.
export const KEYWORDS_PER_RUN = 3;
const keywordStatePath = (ledger: string) => join(dirname(ledger), "logs", "task-sync-keywords.json");
// Keyword state is per source; bare keys are slack's from before sources were generic.
const kwKey = (source: string, q: string) => (source === "slack" ? q : `${source}:${q}`);
export function keywordPlan(keywords: string[], last: Record<string, string>, now = Date.now(), perRun = KEYWORDS_PER_RUN, source = "slack"): { q: string; after: string }[] {
  const floor = now - 86_400_000;
  const at = (k: string) => Date.parse(last[kwKey(source, k)] ?? "") || 0;
  return [...keywords]
    .sort((a, b) => at(a) - at(b))
    .slice(0, perRun)
    .map((q) => ({ q, after: new Date(Math.max(at(q), floor)).toISOString() }));
}
function markKeywords(ledger: string, source: string, searched: string[], now = new Date().toISOString()): void {
  const state = store.readJson<Record<string, string>>(keywordStatePath(ledger), {});
  for (const k of searched) state[kwKey(source, k)] = now;
  store.writeJson(keywordStatePath(ledger), state);
}

// Coverage cursors per source: each run scans only from here, so a run never has to cover the whole lookback at once.
export const LOOKBACK_MS = 14 * 86_400_000;
const watermarkPath = (ledger: string) => join(dirname(ledger), "logs", "task-sync-watermark.json");
/** Recent pass: the last day is read oldest-first from its own cursor, so a run that stops early never skips the middle. */
export const RECENT_MS = 86_400_000;
export type Pass = "backfill" | "recent";
// Slack's cursors keep their original keys so existing state carries over.
const cursorKey = (source: string, pass: Pass) =>
  source === "slack" ? (pass === "recent" ? "slack_recent_covered_until" : "slack_covered_until") : `${source}_${pass}_covered_until`;
export function readWatermark(ledger: string, now = Date.now(), source = "slack", pass: Pass = "backfill"): string {
  const lookback = pass === "recent" ? RECENT_MS : LOOKBACK_MS;
  try {
    const at = store.readJson<Record<string, string>>(watermarkPath(ledger), {})[cursorKey(source, pass)] ?? "";
    if (Date.parse(at) > now - lookback) return at;
  } catch {}
  return new Date(now - lookback).toISOString();
}
/** Advance only forward: a run reports the newest time it fully covered, never past now. */
export function advance(ledger: string, until: string, now = Date.now(), source = "slack", pass: Pass = "backfill"): string {
  const key = cursorKey(source, pass);
  const t = Date.parse(until);
  if (Number.isNaN(t) || t > now + 60_000) throw new Error(`invalid ${key}: ${until}`);
  const cur = readWatermark(ledger, now, source, pass);
  if (t <= Date.parse(cur)) return cur;
  store.writeJson(watermarkPath(ledger), { ...store.readJson<Record<string, string>>(watermarkPath(ledger), {}), [key]: until });
  return until;
}

/** Enabled connectors: config `task_sources` (names) or every connector under skills/sources. */
export function enabledSources(all = loadSources()): SourceDef[] {
  const want: unknown = localConfig().task_sources;
  return Array.isArray(want) ? all.filter((s) => want.includes(s.name)) : all;
}
/** Extra search terms per source (own names, watched topics) live in config, not in the published connector. */
function sourceList(name: string, key: string): string[] {
  const v: unknown = localConfig()[`task_${name}_${key}`];
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && !!k.trim()) : [];
}
const sourceKeywords = (name: string) => sourceList(name, "keywords");
// Alert channels: every bot alert there is a request to investigate, whoever it mentions.
const sourceAlertChannels = (name: string) => sourceList(name, "alert_channels");

/** Other people whose requests also enter this inbox (visibility only; workers never act as them). */
export interface Person { name: string; slack?: string; email?: string; github?: string }
export function taskPeople(): Person[] {
  const v: unknown = localConfig().task_people;
  return Array.isArray(v) ? v.filter((p): p is Person => typeof p?.name === "string" && !!p.name.trim()) : [];
}

export function syncPrompt(path: string, sources = enabledSources(), now = Date.now()): string {
  const state = store.readJson<Record<string, string>>(keywordStatePath(path), {});
  const plan = sources.map((s) => ({
    source: s.name,
    connector: s.path.slice(ROOT.length + 1),
    mcp: s.mcp,
    recent_from: readWatermark(path, now, s.name, "recent"),
    backfill_from: readWatermark(path, now, s.name, "backfill"),
    keywords: keywordPlan(sourceKeywords(s.name), state, now, KEYWORDS_PER_RUN, s.name),
    alert_channels: sourceAlertChannels(s.name),
  }));
  const people = taskPeople();
  return `Read ${SYNC_SKILL} and follow it exactly once, then exit. Sources this run: ${JSON.stringify(plan)}` + (people.length ? ` People: ${JSON.stringify(people)}` : "");
}

function sync(path: string): number {
  // Work tools are reachable only through the worker's MCP connectors; the skill pipes results into `upsert`.
  const r = Bun.spawnSync(oneShot(workerCommand(), syncPrompt(path), BATCH), { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, TASK_LEDGER: path } });
  return r.exitCode ?? 1;
}

function withLinks(r: TaskRow, add: string[] | undefined): Partial<TaskRow> {
  if (!add?.length) return {};
  for (const u of add) if (!/^https:\/\//.test(u)) throw new Error(`--link must be a URL: ${u}`);
  return { links: [...new Set([...(r.links ?? []), ...add])] };
}

/** The primary's record covers its linked members: they leave triage until their own source moves again. */
function settleMembers(path: string, id: string): void {
  const rows = readTasks(path);
  const g = groups(rows).get(id);
  if (!g || g.primary !== id || !g.members.length) return;
  for (const m of g.members) update(path, m, (r) => (r.ball === "done" ? r : { ...r, ball: "done", note: `grouped into ${id}`, question: undefined, options: undefined }));
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
      "covered-until": { type: "string", multiple: true },
      "recent-covered-until": { type: "string", multiple: true },
      "keywords-searched": { type: "string", multiple: true },
      axis: { type: "string" },
      title: { type: "string" },
      link: { type: "string", multiple: true },
    },
  });
  const path = v.ledger!;
  const [cmd = "list", id] = p;
  const need = ["record", "dispatch", "check", "decide", "show", "link"];
  if (!["sync", "upsert", "list", ...need].includes(cmd) || (need.includes(cmd) && !id)) {
    console.error("usage: tasks.ts {sync|upsert [--covered-until SOURCE=ISO]... [--recent-covered-until SOURCE=ISO]... [--keywords-searched SOURCE=JSON]... <JSONL|list|show ID|record ID --ball B [--axis A] [--title T] [--link URL]...|link ID URL... [--follow-up ISO] [--note T]|dispatch ID --reason T [--option T]...|decide ID --choice T|check ID}");
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
    const names = new Set(loadSources().map((s) => s.name));
    const pair = (flag: string, x: string): [string, string] => {
      const i = x.indexOf("=");
      if (i < 1 || !names.has(x.slice(0, i))) throw new Error(`--${flag} must be SOURCE=VALUE with a known source: ${x}`);
      return [x.slice(0, i), x.slice(i + 1)];
    };
    for (const x of v["keywords-searched"] ?? []) {
      const [src, raw] = pair("keywords-searched", x);
      const ks = JSON.parse(raw);
      if (!Array.isArray(ks) || ks.some((k) => typeof k !== "string")) throw new Error("--keywords-searched must be SOURCE=<JSON array of strings>");
      markKeywords(path, src, ks);
    }
    for (const x of v["recent-covered-until"] ?? []) {
      const [src, at] = pair("recent-covered-until", x);
      console.log(`${src}-recent-covered-until\t${advance(path, at, Date.now(), src, "recent")}`);
    }
    for (const x of v["covered-until"] ?? []) {
      const [src, at] = pair("covered-until", x);
      console.log(`${src}-covered-until\t${advance(path, at, Date.now(), src, "backfill")}`);
    }
    process.exit(0);
  }
  if (cmd === "list") {
    for (const r of readTasks(path)) console.log([r.ball, r.axis, r.id, r.url, r.title].join("\t"));
    process.exit(0);
  }
  if (cmd === "show") {
    const rows = readTasks(path);
    const r = rows.find((r) => r.id === id);
    const g = groups(rows).get(id!);
    // The group is the unit of work: show the primary and every linked member.
    console.log(JSON.stringify(r ? { ...r, group: g && { primary: g.primary, members: [g.primary, ...g.members].filter((m) => m !== id).map((m) => rows.find((x) => x.id === m)) } } : null, null, 1));
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
    update(path, id!, (r) => ({ ...r, ...(axis ? { axis } : {}), ...(v.title ? { title: v.title.slice(0, 200) } : {}), ...withLinks(r, v.link), ball, follow_up_at: fu, note: v.note ?? r.note, question: undefined, options: undefined, answer: undefined }));
    settleMembers(path, id!);
    console.log(`recorded\t${id}\t${ball}`);
    process.exit(0);
  }
  if (cmd === "link") {
    const r = update(path, id!, (r) => ({ ...r, ...withLinks(r, p.slice(2)) }));
    const g = groups(readTasks(path)).get(id!)!;
    console.log(`linked\t${id}\t${(r.links ?? []).length}\tprimary=${g.primary}\tmembers=${g.members.join(",")}`);
    process.exit(0);
  }
  if (cmd === "dispatch") {
    if (!v.reason) throw new Error("--reason is required");
    update(path, id!, (r) => ({ ...r, ...withLinks(r, v.link), ball: "human", question: v.reason, options: v.option ?? [], answer: undefined, follow_up_at: undefined }));
    settleMembers(path, id!);
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
export function taskCards(rows: TaskRow[]) {
  const gs = groups(rows);
  return rows.filter((r) => isPrimary(gs, r.id)).map((r) => {
    const n = gs.get(r.id)!.members.length;
    const c = taskCard(r);
    return n ? { ...c, action: [c.action, `+${n} linked`].filter(Boolean).join(" · ") } : c;
  });
}
export function taskCard(r: TaskRow) {
  const review = r.axis === "review";
  const status =
    r.ball === "done" ? "completed"
    : r.ball === "human" ? "human_required"
    : r.ball === "triage" ? "queued"
    : review ? (r.ball === "mine" ? "queued" : "reviewing")
    : r.ball === "mine" ? "mine_changes_requested" : "mine_review_requested";
  const ref = cardRef(r.id);
  return {
    kind: review ? ("review" as const) : ("authored" as const),
    url: r.url,
    repository: ref.repository,
    pr_number: ref.number,
    status,
    priority: null,
    title: r.title,
    author: null,
    action: [r.for ? `for ${r.for}` : null, r.counterpart, r.follow_up_at && r.ball === "theirs" ? `follow-up ${r.follow_up_at.slice(5, 16)}` : null].filter(Boolean).join(" · ") || null,
    last_error: null,
    updated_at: r.synced_at,
    added_at: r.intake_at,
    approved_at: null,
    changes_requested_at: null,
    merged_at: null,
    completed_at: r.ball === "done" ? r.synced_at : null,
    id: r.id,
  };
}
