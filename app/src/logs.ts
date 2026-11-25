import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { queryLogs } from "./db.ts";
import { join } from "node:path";

import { extractLinks, type Level, type LogEntry } from "../webui/logfilter.ts";
export type { Level, LogEntry };

type LedgerRowLike = Record<string, any>;

const MAX_RETRIES = 3;
const ERROR_RE =
  /\b(error|failed|failure|traceback|exception|timeout|halted)\b|command not found|(?:ip|vpn)-guard:|deny network-outbound|HTTP 5\d\d|gh auth login/i;
const WARN_RE = /\bwarn(ing)?\b|CI_FAILED|retry/i;

export const SOURCES: Record<string, string> = {
  worker: "logs/review-poller/worker.log",
  poller: "logs/review-poller/poller.log",
  "poller.error": "logs/review-poller/poller.error.log",
  sync: "logs/review-request-sync.log",
  "sync.error": "logs/review-request-sync.error.log",
  serve: "logs/reviewctl-serve.log",
  "serve.error": "logs/reviewctl-serve.error.log",
  "retro.error": "logs/review-retro.error.log",
};

export function classify(text: string): Level {
  if (/\bwarning:|CI_FAILED/.test(text)) return "warn";
  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warn";
  return "info";
}

function entry(source: string, msg: string, ts: string | null = null, level?: Level): LogEntry {
  return { source, level: level ?? classify(msg), ts, links: extractLinks(msg), msg };
}

// Worker stream-json is huge; keep only final results and tool outputs that look like failures.
export function parseWorker(lines: string[], fallback: (i: number) => string | null = () => null, started = new Map<string, string[]>()): LogEntry[] {
  const out: LogEntry[] = [];
  for (const [i, line] of lines.entries()) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "system" && o.subtype === "init" && o.session_id) {
      const links = extractLinks(line);
      if (links.length) started.set(o.session_id, links);
      continue;
    }
    if (o.type === "result") {
      const msg = String(o.result ?? o.subtype ?? "");
      const e = entry("worker", msg, o.timestamp ?? fallback(i), o.is_error ? "error" : "info");
      e.links = [...new Set([...(started.get(o.session_id) ?? []), ...e.links])];
      out.push(e);
      continue;
    }
    if (o.type !== "user") continue;
    for (const c of o.message?.content ?? []) {
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      const hit = text.match(/command not found[^\n]*|(?:ip|vpn)-guard:[^\n]*|deny network-outbound [^\s]+/);
      if (hit) {
        const e = entry("worker", hit[0], o.timestamp ?? fallback(i));
        e.links = started.get(o.session_id) ?? [];
        out.push(e);
      }
    }
  }
  return out;
}

export function parseLines(source: string, lines: string[], fallback: (i: number) => string | null = () => null): LogEntry[] {
  return lines.map((line, i) => {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") {
        const ts = o.observed_at ?? o.at ?? o.timestamp ?? fallback(i);
        const e = entry(source, line, ts);
        if (o.event && /FAILED|HALTED|ERROR/.test(o.event) && o.event !== "CI_FAILED") e.level = "error";
        return e;
      }
    } catch {}
    return entry(source, line, fallback(i));
  });
}

// Synthetic alerts: states that only show up as silence in the raw logs.
export function alerts(root: string, rows: readonly LedgerRowLike[], now = new Date().toISOString()): LogEntry[] {
  const out: LogEntry[] = [];
  const qp = join(root, "logs/queue.json");
  const queue: Record<string, any> = existsSync(qp) ? JSON.parse(readFileSync(qp, "utf8")) : {};
  for (const j of Object.values(queue))
    if (j.state === "exhausted")
      out.push({ source: "alert", level: "error", ts: j.finished_at ?? now, links: [j.url], msg: `queue retry exhausted (${j.attempts}/${MAX_RETRIES}); waiting for a new head or another worker to succeed` });
  for (const r of rows)
    if (r.last_error)
      out.push({ source: "alert", level: r.status === "delivery_abandoned" || /delivery monitoring gave up/.test(r.last_error) ? "info" : "error", ts: r.last_error_at ?? r.last_synced_at ?? now, links: [r.url], msg: `ledger last_error: ${JSON.stringify(r.last_error)}` });
  return out;
}

export function readLogs(root: string, rows: readonly LedgerRowLike[], db: Database): LogEntry[] {
  return [...alerts(root, rows), ...queryLogs(db)];
}
