#!/usr/bin/env bun
// Answer pending authored-PR questions that match past human answers, once human decisions settle for QUIET_MS.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTHORED_LEDGER,
  CLOSE,
  HOLD,
  decide,
  pendingDecisions,
  readAuthored,
  readDecisions,
  readDispatched,
  readHistory,
  type PendingDecision,
} from "./authored-prs.ts";
import { localConfig } from "./lib/org.ts";
import { exec } from "./lib/util.ts";
import { BATCH, oneShot, workerCommand } from "./lib/worker.ts";

export const QUIET_MS = 10 * 60_000;
const ROOT = resolve(import.meta.dir, "../..");
// Distilled policy from human answers; workers read it before dispatching.
export const memoryPath = (ledger: string) => join(dirname(ledger), "logs", "decision-memory.md");
export function readMemory(ledger = AUTHORED_LEDGER): string {
  try {
    return readFileSync(memoryPath(ledger), "utf8");
  } catch {
    return "";
  }
}
export function writeMemory(ledger: string, rules: string[]): void {
  const body = ["# Decision memory", "", "Generalized from the human's answers on the decide tab (auto-generated; edit freely).", "", ...rules.map((r) => `- ${r}`), ""].join("\n");
  mkdirSync(dirname(memoryPath(ledger)), { recursive: true });
  const tmp = `${memoryPath(ledger)}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, memoryPath(ledger));
}
const statePath = (ledger: string) => join(dirname(ledger), "logs", "auto-decide-state.json");

export interface Example {
  question: string;
  choice: string;
  options: string[];
}
/** Human answers only (auto answers would reinforce themselves); legacy decisions.json seeds the log. */
export function examples(ledger = AUTHORED_LEDGER): { examples: Example[]; last: string | null } {
  const seen = new Set<string>();
  const out: (Example & { at: string })[] = [];
  const legacy = Object.entries(readDecisions(ledger)).map(([url, d]) => ({ ...d, url, options: [] as string[] }));
  for (const h of [...readHistory(ledger), ...legacy]) {
    if (h.by === "auto" || h.choice === HOLD || seen.has(h.url + h.at)) continue;
    seen.add(h.url + h.at);
    out.push({ question: h.question, choice: h.choice, options: h.options, at: h.at });
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return { examples: out.map(({ at: _, ...e }) => e), last: out.at(-1)?.at ?? null };
}

export type Watch = { state: "idle" } | { state: "watching"; due_at: number } | { state: "due"; last: string };
/** Watching starts at a new human answer and fires QUIET_MS after the latest one. */
export function watch(last: string | null, handled: string | null, now: number): Watch {
  if (!last || last === handled) return { state: "idle" };
  const due_at = Date.parse(last) + QUIET_MS;
  return now >= due_at ? { state: "due", last } : { state: "watching", due_at };
}
export function readHandled(ledger = AUTHORED_LEDGER): string | null {
  try {
    return JSON.parse(readFileSync(statePath(ledger), "utf8")).handled ?? null;
  } catch {
    return null;
  }
}
export function writeHandled(ledger: string, handled: string): void {
  mkdirSync(dirname(statePath(ledger)), { recursive: true });
  const tmp = `${statePath(ledger)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ handled }));
  renameSync(tmp, statePath(ledger));
}

export function prompt(ex: Example[], pending: PendingDecision[], memory = ""): string {
  return [
    "You auto-answer questions an agent asked about the user's own pull requests, using only the user's past answers as precedent.",
    "Answer a pending question ONLY when a past question is clearly the same kind of situation and the past choice transfers unambiguously.",
    "The answer must be copied verbatim from that pending question's options. When unsure, omit the question.",
    `Never answer "${HOLD}".`,
    "Also rewrite the decision memory: short, general, reusable rules (Japanese, one line each) that capture the user's policy across past answers, merging the current memory; drop rules past answers contradict.",
    "Reply with only a JSON object: {\"answers\": [{\"url\": string, \"choice\": string, \"precedent\": number}], \"memory\": string[]} where precedent is the index of the past answer.",
    "",
    "CURRENT MEMORY:",
    memory || "(empty)",
    "",
    "PAST ANSWERS:",
    JSON.stringify(ex.map((e, i) => ({ i, question: e.question, choice: e.choice }))),
    "",
    "PENDING QUESTIONS:",
    JSON.stringify(pending.map((p) => ({ url: p.url, repository: p.repository, title: p.title, question: p.question, options: p.options }))),
  ].join("\n");
}

export interface AutoAnswer {
  url: string;
  choice: string;
  precedent: number;
}
export function parseReply(text: string): { answers: unknown; memory: string[] | null } {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const o = JSON.parse(m![0]);
    const memory = Array.isArray(o.memory) && o.memory.every((r: unknown) => typeof r === "string" && r.trim()) ? o.memory.map((r: string) => r.trim().replace(/\s+/g, " ")) : null;
    return { answers: o.answers, memory };
  } catch {
    return { answers: [], memory: null };
  }
}
/** Keep only answers to still-pending questions with a listed option and a real precedent. */
export function parseAnswers(raw: unknown, pending: PendingDecision[], ex: Example[]): AutoAnswer[] {
  if (!Array.isArray(raw)) return [];
  const byUrl = new Map(pending.map((p) => [p.url, p]));
  const done = new Set<string>();
  return raw.filter((a): a is AutoAnswer => {
    const p = byUrl.get(a?.url);
    const ok = !!p && !done.has(p.url) && a.choice !== HOLD && p.options.includes(a.choice) && Number.isInteger(a.precedent) && !!ex[a.precedent];
    if (ok) done.add(p!.url);
    return ok;
  });
}

function ask(text: string): string {
  const r = exec(oneShot(workerCommand(), text, { ...BATCH, json: true }), { timeoutMs: 10 * 60_000, cwd: ROOT });
  if (r.code !== 0) throw new Error(`auto-decide model call failed: ${r.stderr.slice(0, 300)}`);
  try {
    return String(JSON.parse(r.stdout).result ?? "");
  } catch {
    return r.stdout;
  }
}

function closePr(url: string): void {
  const app: unknown = localConfig().authored_auto_merge_app;
  if (typeof app !== "string" || !app) throw new Error("authored_auto_merge_app is not set");
  const r = exec(["gh", "pr", "close", url], { env: { ...process.env, GHTKN_APP: app } });
  if (r.code !== 0) throw new Error(`gh pr close failed: ${r.stderr.trim()}`);
}

export function run(ledger = AUTHORED_LEDGER, model = ask, close = closePr): AutoAnswer[] {
  const { examples: ex } = examples(ledger);
  const pending = pendingDecisions(readAuthored(ledger), readDispatched(ledger), readDecisions(ledger)).filter((p) => !p.held);
  if (!ex.length) return [];
  const reply = parseReply(model(prompt(ex, pending, readMemory(ledger))));
  if (reply.memory?.length) writeMemory(ledger, reply.memory);
  const answers = parseAnswers(reply.answers, pending, ex);
  const applied: AutoAnswer[] = [];
  for (const a of answers) {
    const p = pending.find((x) => x.url === a.url)!;
    try {
      if (a.choice === CLOSE) close(a.url);
      decide(ledger, a.url, p.head, a.choice, false, "auto");
      applied.push(a);
      console.log(JSON.stringify({ event: "AUTO_DECIDED", url: a.url, choice: a.choice, precedent: ex[a.precedent]!.question, at: new Date().toISOString() }));
    } catch (e) {
      console.error(`error: auto-decide ${a.url}: ${(e as Error).message}`);
    }
  }
  return applied;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { ledger: { type: "string", default: AUTHORED_LEDGER } } });
  run(values.ledger!);
}
