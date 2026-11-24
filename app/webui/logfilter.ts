export type Level = "error" | "warn" | "info";
export type LogEntry = { source: string; level: Level; ts: string | null; links: string[]; msg: string };

const LINK_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}(?:\?[^\s"'<>)\\]*)?|https:\/\/[\w-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/g;

/** Same identity for every URL form of a ticket: slack:<channel>:<thread_ts> / jira:<KEY>; PR URLs are already canonical. */
export function linkKey(url: string): string {
  const s = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(?:.*&)?thread_ts=(\d+\.\d+))?/.exec(url);
  if (s) return `slack:${s[1]}:${s[4] ?? `${s[2]}.${s[3]}`}`;
  const j = /\/browse\/([A-Z][A-Z0-9]+-\d+)(?:$|[?#/])/.exec(url);
  return j ? `jira:${j[1]}` : url;
}

/** Accepts entries from a server still emitting the single `url` field. */
export function normalizeEntry(e: Partial<LogEntry> & { url?: string | null }): LogEntry {
  const links = Array.isArray(e.links) ? e.links : e.url ? [e.url] : [];
  return { source: e.source ?? "", level: e.level ?? "info", ts: e.ts ?? null, links, msg: e.msg ?? "" };
}

export function extractLinks(text: string): string[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(LINK_RE)) if (!out.has(linkKey(m[0]))) out.set(linkKey(m[0]), m[0]);
  return [...out.values()];
}

export function linkLabel(url: string): string {
  const k = linkKey(url);
  if (k.startsWith("jira:")) return k.slice(5);
  if (k.startsWith("slack:")) return `slack/${k.split(":")[1]}`;
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
