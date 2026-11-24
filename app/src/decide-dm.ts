#!/usr/bin/env bun
// Slack DM is the decide channel: only pending decisions are posted there, and the user's thread reply is the answer.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AUTHORED_LEDGER, decide, pendingDecisions, readAuthored, readDecisions, readDispatched } from "./authored-prs.ts";
import { decideTask, pendingTasks, readTasks, TASK_LEDGER } from "./tasks.ts";
import { localConfig } from "./lib/org.ts";
import { oneShot, workerCommand } from "./lib/worker.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const SKILL = "skills/decide-dm/SKILL.md";
const STATE = join(ROOT, "logs", "decide-dm.json");

export interface Open {
  key: string; // stable per question: a new question (new head / new dispatch) gets a new key
  kind: "authored" | "task";
  ref: string;
  url: string;
  title: string;
  question: string;
  options: string[];
}
export interface Posted {
  channel: string;
  ts: string;
  at: string;
}
export type State = Record<string, Posted>;

const hash = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 12);

export function openDecisions(): Open[] {
  const authored = pendingDecisions(readAuthored(), readDispatched(), readDecisions())
    .filter((d) => !d.held)
    .map((d) => ({
      key: `authored:${d.url}@${d.head}:${hash(d.asked_at)}`,
      kind: "authored" as const,
      ref: d.url,
      url: d.url,
      title: d.title,
      question: d.question,
      options: d.options,
    }));
  const tasks = pendingTasks(readTasks())
    .filter((t) => !t.held)
    .map((t) => ({
      key: `task:${t.id}:${hash(t.question)}`,
      kind: "task" as const,
      ref: t.id,
      url: t.url,
      title: t.title,
      question: t.question,
      options: t.options,
    }));
  return [...authored, ...tasks];
}

/** A reply is an option by number or exact text; anything else is a free-text instruction. */
export function parseReply(reply: string, options: string[]): { choice: string; custom: boolean } {
  const r = reply.trim();
  const n = /^(\d+)[.)]?$/.exec(r);
  if (n && Number(n[1]) >= 1 && Number(n[1]) <= options.length) return { choice: options[Number(n[1]) - 1]!, custom: false };
  const exact = options.find((o) => o === r);
  return exact ? { choice: exact, custom: false } : { choice: r, custom: true };
}

export function readState(path = STATE): State {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}
function writeState(state: State, path = STATE): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

/** What the DM agent must do this run: post new questions, read replies on posted ones; answered/withdrawn keys drop out. */
export function plan(open: Open[], state: State): { post: Open[]; watch: (Open & Posted)[]; stale: string[] } {
  const keys = new Set(open.map((o) => o.key));
  return {
    post: open.filter((o) => !state[o.key]),
    watch: open.filter((o) => state[o.key]).map((o) => ({ ...o, ...state[o.key]! })),
    stale: Object.keys(state).filter((k) => !keys.has(k)),
  };
}

function answer(key: string, reply: string): string {
  const o = openDecisions().find((x) => x.key === key);
  if (!o) throw new Error(`not pending: ${key}`);
  const { choice, custom } = parseReply(reply, o.options);
  if (o.kind === "authored") {
    const head = /@([0-9a-f]+):/.exec(key)?.[1] ?? "";
    decide(AUTHORED_LEDGER, o.ref, head, choice, custom);
  } else decideTask(TASK_LEDGER, o.ref, choice, custom);
  return choice;
}

function sync(): number {
  const user = localConfig().notify_slack_user;
  if (typeof user !== "string" || !user) throw new Error("notify_slack_user is not set");
  const state = readState();
  const p = plan(openDecisions(), state);
  for (const k of p.stale) delete state[k];
  writeState(state);
  if (!p.post.length && !p.watch.length) return 0;
  const prompt = `Read ${SKILL} and follow it exactly once, then exit. DM user: ${user}. Plan: ${JSON.stringify({ post: p.post, watch: p.watch })}`;
  // A small model is enough: posting and reading replies needs no judgment.
  const r = Bun.spawnSync(oneShot(workerCommand(), prompt, { model: "sonnet", effort: "low" }), { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  return r.exitCode ?? 1;
}

if (import.meta.main) {
  const [cmd, key, ...rest] = process.argv.slice(2);
  if (cmd === "sync") process.exit(sync());
  if (cmd === "list") {
    console.log(JSON.stringify(plan(openDecisions(), readState()), null, 1));
    process.exit(0);
  }
  if (cmd === "posted" && key && rest.length === 2) {
    const state = readState();
    state[key] = { channel: rest[0]!, ts: rest[1]!, at: new Date().toISOString() };
    writeState(state);
    console.log(`posted\t${key}`);
    process.exit(0);
  }
  if (cmd === "answer" && key && rest.length) {
    console.log(`decided\t${key}\t${answer(key, rest.join(" "))}`);
    process.exit(0);
  }
  console.error("usage: decide-dm.ts {sync|list|posted KEY CHANNEL TS|answer KEY REPLY}");
  process.exit(2);
}
