#!/usr/bin/env bun
// Aggregate one day of review-loop telemetry into logs/retro/<date>.json (stats only, no review artifacts).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
const ANSI = /\x1b\[[0-9;]*m|\\u001b\[[0-9;]*m/g;
const NOISE = /[0-9a-f]{40}|\d{2}:\d{2}:\d{2}\.\d+|\/pull\/\d+|\d+/g;

export const errorClass = (message: string): string =>
  [...message.replace(ANSI, "").replace(NOISE, "#")].slice(0, 160).join("");

class Counter {
  m = new Map<string, number>();
  add(k: string) {
    this.m.set(k, (this.m.get(k) ?? 0) + 1);
  }
  // Stable sort keeps first-seen order for ties, like collections.Counter.most_common.
  top(n?: number): Record<string, number> {
    return Object.fromEntries([...this.m].sort((a, b) => b[1] - a[1]).slice(0, n));
  }
}

function readFrom(path: string, offset: number): string {
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.max(0, size - offset));
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function retro(root = ROOT, now = new Date()): string {
  const log = join(root, "logs/reviewctl-serve.log");
  const statePath = join(root, "logs/retro/state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { offset: 0 };
  const size = existsSync(log) ? statSync(log).size : 0;
  const offset = state.offset <= size ? state.offset : 0;
  const events = new Counter(), errors = new Counter(), perPr = new Counter();
  if (existsSync(log))
    for (const raw of readFrom(log, offset).split("\n")) {
      let event: any;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object" || Array.isArray(event) || !("event" in event)) continue;
      events.add(event.event);
      if (event.url) perPr.add(event.url);
      if (event.error) errors.add(`${event.event}: ${errorClass(event.error)}`);
    }
  const statuses = new Counter(), lastErrors = new Counter();
  for (const line of readFileSync(join(root, "pull_requests.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    statuses.add(row.status);
    if (row.last_error) lastErrors.add(errorClass(row.last_error));
  }
  const today = localDate(now);
  const summary = {
    date: today,
    events: events.top(),
    event_errors: errors.top(20),
    noisiest_prs: perPr.top(10),
    ledger_status: statuses.top(),
    ledger_last_errors: lastErrors.top(20),
  };
  const out = join(root, `logs/retro/${today}.json`);
  mkdirSync(join(root, "logs/retro"), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(statePath, JSON.stringify({ offset: size }));
  return out;
}

if (import.meta.main) console.log(retro());
