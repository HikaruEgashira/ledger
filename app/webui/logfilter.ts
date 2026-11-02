export type Level = "error" | "warn" | "info";
export type LogEntry = { source: string; level: Level; ts: string | null; url: string | null; msg: string };
export type LevelFilter = "error" | "warn" | "all";
export type Range = "h" | "d" | "w" | "m";
export type LogFilter = { level: LevelFilter; source: string; q: string; range?: Range };

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
      (!q || e.msg.toLowerCase().includes(q) || (e.url ?? "").toLowerCase().includes(q)),
  );
}

export const countErrors = (entries: LogEntry[]) => entries.filter((e) => e.level === "error").length;

export type LogGroup = LogEntry & { count: number; urls: string[] };

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
    if (!g) map.set(k, { ...e, count: 1, urls: e.url ? [e.url] : [] });
    else {
      g.count++;
      if (e.url && !g.urls.includes(e.url)) g.urls.push(e.url);
    }
  }
  return [...map.values()];
}
