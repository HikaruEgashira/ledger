#!/usr/bin/env bun
// Self-improving model routing: each scope is a module whose model is promoted to haiku or demoted back only through a verifier gate.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
export const OUTCOMES = join(ROOT, "logs/tiers/outcomes.jsonl");
export const LEARNED = join(ROOT, "logs/tiers/learned.json");

export interface Tier {
  model: string;
  effort: string;
}
export const HAIKU: Tier = { model: "haiku", effort: "high" };
// Seeds; learned entries override them, including demotions back to worker_command.
export const SCOPE_MODEL: Record<string, Tier> = {
  "authored-conflicting": HAIKU,
};
// Only kinds whose exit code is a live re-check (the ball left the author / task closed) are a trustworthy verifier.
export const GATED_KINDS = new Set(["authored", "task"]);
export const PROMOTE = { min: 10, rate: 0.9 };
export const DEMOTE = { min: 5, rate: 0.7 };
export const COOLDOWN_MS = 14 * 86_400_000;

export interface Outcome {
  scope: string;
  kind: string;
  model: string;
  ok: boolean;
  at: string;
}
export interface Learned {
  [scope: string]: { tier: Tier | null; at: string; reason: string };
}

export function tierFor(scope: string, learned: Learned = readLearned()): Tier | undefined {
  const l = learned[scope];
  return l ? (l.tier ?? undefined) : SCOPE_MODEL[scope];
}

export function record(o: Outcome, path = OUTCOMES) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(o) + "\n");
}

export function readLearned(path = LEARNED): Learned {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const rate = (xs: Outcome[]) => xs.filter((x) => x.ok).length / xs.length;

/** One gated step per scope: judge only outcomes since its last change, so a new tier is evaluated on its own runs. */
export function evolve(outcomes: Outcome[], learned: Learned, now = Date.now()): { learned: Learned; changes: string[] } {
  const next = { ...learned };
  const changes: string[] = [];
  const scopes = new Map<string, Outcome[]>();
  for (const o of outcomes) if (GATED_KINDS.has(o.kind)) scopes.set(o.scope, [...(scopes.get(o.scope) ?? []), o]);
  for (const [scope, all] of scopes) {
    const since = learned[scope]?.at ?? "";
    const cur = tierFor(scope, learned);
    const onHaiku = cur?.model === HAIKU.model;
    const runs = all.filter((o) => o.at > since && (o.model === HAIKU.model) === onHaiku);
    if (!runs.length) continue;
    const r = rate(runs);
    const at = new Date(now).toISOString();
    if (onHaiku && runs.length >= DEMOTE.min && r < DEMOTE.rate) {
      next[scope] = { tier: null, at, reason: `demote: haiku ok ${runs.filter((x) => x.ok).length}/${runs.length}` };
      changes.push(`${scope}: haiku -> default (${next[scope]!.reason})`);
    } else if (!onHaiku && runs.length >= PROMOTE.min && r >= PROMOTE.rate) {
      if (learned[scope]?.tier === null && now - Date.parse(learned[scope]!.at) < COOLDOWN_MS) continue;
      next[scope] = { tier: HAIKU, at, reason: `promote: default ok ${runs.filter((x) => x.ok).length}/${runs.length}` };
      changes.push(`${scope}: default -> haiku (${next[scope]!.reason})`);
    }
  }
  return { learned: next, changes };
}

export function readOutcomes(path = OUTCOMES): Outcome[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Outcome];
      } catch {
        return [];
      }
    });
}

if (import.meta.main) {
  const { learned, changes } = evolve(readOutcomes(), readLearned());
  mkdirSync(dirname(LEARNED), { recursive: true });
  writeFileSync(LEARNED, JSON.stringify(learned, null, 2) + "\n");
  console.log(changes.length ? changes.join("\n") : "tiers: no change");
}
