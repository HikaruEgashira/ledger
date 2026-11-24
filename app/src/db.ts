// Raw process logs are ingested incrementally into the store so history survives rotation and DuckDB can query it.
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { schema, storeDb } from "./lib/store.ts";
import { join } from "node:path";
import type { Level, LogEntry } from "../webui/logfilter.ts";
import { parseLines, parseWorker, SOURCES } from "./logs.ts";

export { DB_FILE } from "./lib/store.ts";
const FIRST_INGEST_BYTES = 2_000_000;
const RETENTION_DAYS = 90;

export const openDb = (root: string, file?: string): Database => (file ? schema(new Database(file, { create: true, strict: true })) : storeDb(root));

function readFrom(path: string, offset: number): { text: string; end: number } {
  const size = statSync(path).size;
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const cut = text.lastIndexOf("\n") + 1; // keep a partial last line for the next pass
  return { text: text.slice(0, cut), end: offset + Buffer.byteLength(text.slice(0, cut)) };
}

// Before the DB, first-seen times per byte range lived in logs/.logview-seen.json; reuse them on the first ingest.
function legacySeen(root: string): (rel: string, off: number) => string | null {
  let seen: Record<string, { segs: [number, string][] }> = {};
  try {
    seen = JSON.parse(readFileSync(join(root, "logs/.logview-seen.json"), "utf8"));
  } catch {}
  return (rel, off) => {
    const segs = seen[rel]?.segs ?? [];
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i][0] <= off) return segs[i][1];
    return null;
  };
}

export function ingestLogs(db: Database, root: string, now = new Date().toISOString()): number {
  const getCur = db.query<{ offset: number }, [string]>("SELECT offset FROM log_cursor WHERE path = ?");
  const setCur = db.query("INSERT INTO log_cursor (path, offset) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET offset = excluded.offset");
  const insLog = db.query<{ id: number }, [string, string, string | null, string]>("INSERT INTO logs (source, level, ts, msg) VALUES (?, ?, ?, ?) RETURNING id");
  const insLink = db.query("INSERT INTO log_links (log_id, url) VALUES (?, ?)");
  const getSess = db.query<{ session_id: string; links: string }, []>("SELECT session_id, links FROM worker_sessions");
  const setSess = db.query("INSERT OR REPLACE INTO worker_sessions (session_id, links) VALUES (?, ?)");
  let added = 0;
  const legacy = legacySeen(root);
  db.transaction(() => {
    for (const [name, rel] of Object.entries(SOURCES)) {
      const path = join(root, rel);
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      let offset = getCur.get(rel)?.offset ?? Math.max(0, size - FIRST_INGEST_BYTES);
      if (size < offset) offset = 0; // truncated or rotated
      if (size === offset) continue;
      const { text, end } = readFrom(path, offset);
      const first = !getCur.get(rel);
      const lines: string[] = [];
      const offs: number[] = [];
      let off = offset;
      for (const raw of text.split("\n")) {
        if (raw.trim() && !(first && offset > 0 && off === offset)) (lines.push(raw), offs.push(off)); // first line of a cut tail is partial
        off += Buffer.byteLength(raw) + 1;
      }
      const ts = (i: number) => (first ? legacy(rel, offs[i]) : null) ?? now;
      let entries: LogEntry[];
      if (name === "worker") {
        const started = new Map(getSess.all().map((s) => [s.session_id, JSON.parse(s.links) as string[]]));
        entries = parseWorker(lines, ts, started);
        for (const [id, links] of started) setSess.run(id, JSON.stringify(links));
      } else entries = parseLines(name, lines, ts);
      for (const e of entries) {
        const id = insLog.get(e.source, e.level, e.ts, e.msg)!.id;
        for (const u of e.links) insLink.run(id, u);
      }
      added += entries.length;
      setCur.run(rel, end);
    }
    db.query("DELETE FROM logs WHERE ts < ?").run(new Date(Date.parse(now) - RETENTION_DAYS * 86_400_000).toISOString());
  })();
  return added;
}

export function queryLogs(db: Database, limit = 20_000): LogEntry[] {
  const rows = db
    .query<{ id: number; source: string; level: Level; ts: string | null; msg: string; links: string | null }, [number]>(
      `SELECT l.id, l.source, l.level, l.ts, l.msg, (SELECT json_group_array(url) FROM log_links WHERE log_id = l.id) AS links
       FROM logs l ORDER BY l.id DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => ({ source: r.source, level: r.level, ts: r.ts, msg: r.msg, links: r.links ? JSON.parse(r.links) : [] }));
}
