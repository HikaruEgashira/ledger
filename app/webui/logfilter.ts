import { keyLabel, sourceKey, type SourceRule } from "./sourcekey.ts";

export type Level = "error" | "warn" | "info";
export type LogEntry = { source: string; level: Level; ts: string | null; links: string[]; msg: string };

const URL_RE = /https:\/\/[^\s"'<>)\\]+/g;
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

// Connector URL rules (skills/sources): the server loads them, the browser receives them from /api/sources.
let SOURCES: SourceRule[] = [];
export function setSources(rules: SourceRule[]): void {
  SOURCES = rules;
}

/** Same identity for every URL form of an item: <source>:<id>; PR URLs are already canonical. */
export function linkKey(url: string): string {
  return sourceKey(url, SOURCES) ?? url;
}

/** Accepts entries from a server still emitting the single `url` field. */
export function normalizeEntry(e: Partial<LogEntry> & { url?: string | null }): LogEntry {
  const links = Array.isArray(e.links) ? e.links : e.url ? [e.url] : [];
  return { source: e.source ?? "", level: e.level ?? "info", ts: e.ts ?? null, links, msg: e.msg ?? "" };
}

export function extractLinks(text: string): string[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:]+$/, "");
    const pr = PR_RE.exec(u)?.[0];
    const link = pr ?? (sourceKey(u, SOURCES) ? u : null);
    if (link && !out.has(linkKey(link))) out.set(linkKey(link), link);
  }
  return [...out.values()];
}

export function linkLabel(url: string): string {
  const k = linkKey(url);
  if (k !== url) return keyLabel(k);
  return url.replace(/^https:\/\/github\.com\/[^/]+\//, "");
}
export type LevelFilter = "error" | "warn" | "all";
export type Range = "h" | "d" | "w" | "m";
export type LogFilter = { level: LevelFilter; source: string; q: string; range?: Range; link?: string };

const RANGE_MS: Record<Range, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 };

// Entries without a known time cannot be placed in a window, so only the widest range shows them.
export function inRange(e: LogEntry, range: Range | undefined, now = Date.now()): boolean {
  if (!range) return true;
  if (!e.ts) return range === "m";
  return now - Date.parse(e.ts) <= RANGE_MS[range];
}

const RANK: Record<Level, number> = { error: 2, warn: 1, info: 0 };
const MIN: Record<LevelFilter, number> = { error: 2, warn: 1, all: 0 };

export function filterLogs(entries: LogEntry[], f: LogFilter): LogEntry[] {
  const q = f.q.trim().toLowerCase();
  return entries.filter(
    (e) =>
      RANK[e.level] >= MIN[f.level] &&
      inRange(e, f.range) &&
      (!f.source || e.source === f.source) &&
      (!f.link || e.links.some((u) => linkKey(u) === linkKey(f.link!))) &&
      (!q || e.msg.toLowerCase().includes(q) || e.links.some((u) => u.toLowerCase().includes(q))),
  );
}

export const countErrors = (entries: LogEntry[]) => entries.filter((e) => e.level === "error").length;

export type LogGroup = LogEntry & { count: number };

// Same failure repeated per PR/run collapses into one row so new kinds of errors stand out.
export const signature = (e: LogEntry) =>
  `${e.source}|${e.level}|${e.msg
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{7,40}/g, "<sha>")
    .replace(/\d+/g, "<n>")
    .slice(0, 160)}`;

export function groupLogs(entries: LogEntry[]): LogGroup[] {
  const map = new Map<string, LogGroup>();
  for (const e of entries) {
    const k = signature(e);
    const g = map.get(k);
    if (!g) map.set(k, { ...e, links: [...e.links], count: 1 });
    else {
      g.count++;
      for (const u of e.links) if (!g.links.some((x) => linkKey(x) === linkKey(u))) g.links.push(u);
    }
  }
  return [...map.values()];
}
