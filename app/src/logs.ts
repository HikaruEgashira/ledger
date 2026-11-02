import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Level = "error" | "warn" | "info";
export type LogEntry = { source: string; level: Level; ts: string | null; url: string | null; msg: string };

type LedgerRowLike = Record<string, any>;

const TAIL_BYTES = 2_000_000;
const MAX_RETRIES = 3;
const ERROR_RE =
  /\b(error|failed|failure|traceback|exception|timeout|halted)\b|command not found|ip-guard:|deny network-outbound|HTTP 5\d\d|gh auth login/i;
const WARN_RE = /\bwarn(ing)?\b|CI_FAILED|retry/i;
const URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

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

type Line = { text: string; off: number };

function tail(path: string, bytes = TAIL_BYTES): Line[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const out: Line[] = [];
  let off = start;
  for (const raw of buf.toString("utf8").split("\n")) {
    if (raw.trim() && !(start > 0 && off === start)) out.push({ text: raw, off }); // first line of a cut tail is partial
    off += Buffer.byteLength(raw) + 1;
  }
  return out;
}

// Most log lines carry no timestamp; remember when each byte range first appeared instead.
export type Seen = Record<string, { size: number; segs: [number, string][] }>;

export function stamp(seen: Seen, key: string, size: number, now: string): void {
  const rec = seen[key];
  if (!rec) seen[key] = { size, segs: [] };
  else if (size < rec.size) seen[key] = { size, segs: [[0, now]] };
  else if (size > rec.size) {
    rec.segs.push([rec.size, now]);
    rec.size = size;
    const keep = rec.segs.findLastIndex(([o]) => o <= size - TAIL_BYTES);
    if (keep > 0) rec.segs.splice(0, keep);
  }
}

export function firstSeen(seen: Seen, key: string, off: number): string | null {
  const segs = seen[key]?.segs ?? [];
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i][0] <= off) return segs[i][1];
  return null;
}

function seenPath(root: string) {
  return join(root, "logs/.logview-seen.json");
}

export function stampLogs(root: string, now = new Date().toISOString()): Seen {
  const p = seenPath(root);
  let seen: Seen = {};
  try {
    seen = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {}
  for (const rel of Object.values(SOURCES)) {
    const f = join(root, rel);
    stamp(seen, rel, existsSync(f) ? statSync(f).size : 0, now);
  }
  writeFileSync(p, JSON.stringify(seen));
  return seen;
}

function entry(source: string, msg: string, ts: string | null = null, level?: Level): LogEntry {
  return { source, level: level ?? classify(msg), ts, url: msg.match(URL_RE)?.[0] ?? null, msg };
}

// Worker stream-json is huge; keep only final results and tool outputs that look like failures.
export function parseWorker(lines: string[], fallback: (i: number) => string | null = () => null): LogEntry[] {
  const out: LogEntry[] = [];
  const started = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "system" && o.subtype === "init" && o.session_id) {
      const prompt = line.match(URL_RE)?.[0];
      if (prompt) started.set(o.session_id, prompt);
      continue;
    }
    if (o.type === "result") {
      const msg = String(o.result ?? o.subtype ?? "");
      const e = entry("worker", msg, o.timestamp ?? fallback(i), o.is_error ? "error" : "info");
      e.url = started.get(o.session_id) ?? e.url;
      out.push(e);
      continue;
    }
    if (o.type !== "user") continue;
    for (const c of o.message?.content ?? []) {
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
      const hit = text.match(/command not found[^\n]*|ip-guard:[^\n]*|deny network-outbound [^\s]+/);
      if (hit) {
        const e = entry("worker", hit[0], o.timestamp ?? fallback(i));
        e.url = started.get(o.session_id) ?? null;
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
      out.push({ source: "alert", level: "error", ts: j.finished_at ?? now, url: j.url, msg: `queue retry exhausted (${j.attempts}/${MAX_RETRIES}); waiting for a new head` });
  for (const r of rows)
    if (r.last_error)
      out.push({ source: "alert", level: "error", ts: r.last_synced_at ?? now, url: r.url, msg: `ledger last_error: ${JSON.stringify(r.last_error)}` });
  return out;
}

export function readLogs(root: string, rows: readonly LedgerRowLike[]): LogEntry[] {
  const seen = stampLogs(root);
  const rest: LogEntry[] = [];
  for (const [name, rel] of Object.entries(SOURCES)) {
    const all = tail(join(root, rel));
    const lines = name === "worker" ? all : all.slice(-2000);
    const texts = lines.map((l) => l.text);
    const fb = (i: number) => firstSeen(seen, rel, lines[i].off);
    rest.push(...(name === "worker" ? parseWorker(texts, fb) : parseLines(name, texts, fb)).reverse());
  }
  return [...alerts(root, rows), ...rest];
}
