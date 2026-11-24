// SQLite is the source of truth for ledgers and state; callers keep their file paths as keys so CLIs, skills and tests stay unchanged.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const DB_FILE = "review-factory.db";
const ROOT = resolve(import.meta.dir, "../../..");

export function schema(db: Database): Database {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, body TEXT NOT NULL, mtime REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS records (file TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (file, key));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, source TEXT NOT NULL, level TEXT NOT NULL, ts TEXT, msg TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
    CREATE TABLE IF NOT EXISTS log_links (log_id INTEGER NOT NULL REFERENCES logs (id) ON DELETE CASCADE, url TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS log_links_url ON log_links (url);
    CREATE INDEX IF NOT EXISTS log_links_log ON log_links (log_id);
    CREATE TABLE IF NOT EXISTS log_cursor (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_sessions (session_id TEXT PRIMARY KEY, links TEXT NOT NULL);
  `);
  return db;
}

const dbs = new Map<string, Database>();
export function storeDb(dir = ROOT): Database {
  const file = join(dir, DB_FILE);
  let db = dbs.get(file);
  if (!db) dbs.set(file, (db = schema(new Database(file, { create: true, strict: true }))));
  return db;
}

// Repository files live under ROOT; elsewhere (tests, alternate ledgers) the store sits beside the ledger, above any logs/ directory.
function locate(path: string): { db: Database; name: string } {
  const abs = resolve(path);
  let dir = abs.startsWith(ROOT + sep) ? ROOT : dirname(abs);
  if (dir !== ROOT) while (["logs", "review-poller"].includes(basename(dir))) dir = dirname(dir);
  return { db: storeDb(dir), name: relative(dir, abs) };
}

function rowsOf(name: string, body: string): [string, unknown][] {
  try {
    if (name.endsWith(".jsonl"))
      return body.split("\n").filter((l) => l.trim()).map((l, i) => {
        const o = JSON.parse(l);
        return [String(o?.url ?? o?.id ?? i), o];
      });
    if (!name.endsWith(".json")) return [];
    const o = JSON.parse(body);
    return o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o) : [["", o]];
  } catch {
    return [];
  }
}

function put(db: Database, name: string, body: string, mtime: number): void {
  db.query("INSERT INTO files (name, body, mtime) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body, mtime = excluded.mtime").run(name, body, mtime);
  db.query("DELETE FROM records WHERE file = ?").run(name);
  const at = new Date(mtime).toISOString();
  const ins = db.query("INSERT OR REPLACE INTO records (file, key, data, synced_at) VALUES (?, ?, ?, ?)");
  for (const [k, v] of rowsOf(name, body)) ins.run(name, k, JSON.stringify(v), at);
}

type Row = { body: string; mtime: number };
// First touch imports the legacy file once and leaves it as <file>.migrated.
function load(path: string): { db: Database; name: string; row: Row | null } {
  const { db, name } = locate(path);
  const get = () => db.query<Row, [string]>("SELECT body, mtime FROM files WHERE name = ?").get(name);
  let row = get();
  if (row || !existsSync(path)) return { db, name, row };
  let migrated = false;
  db.transaction(() => {
    if ((row = get())) return;
    put(db, name, readFileSync(path, "utf8"), statSync(path).mtimeMs);
    migrated = true;
  }).immediate();
  if (migrated)
    try {
      renameSync(path, `${path}.migrated`);
    } catch {}
  return { db, name, row: get() };
}

export const readText = (path: string): string | null => load(path).row?.body ?? null;
export const exists = (path: string): boolean => load(path).row !== null;
export const mtime = (path: string): number => load(path).row?.mtime ?? 0;

export function writeText(path: string, body: string): void {
  const { db, name } = load(path);
  db.transaction(() => put(db, name, body, Date.now())).immediate();
}

export function appendText(path: string, text: string): void {
  const { db, name } = load(path);
  db.transaction(() => {
    const cur = db.query<Row, [string]>("SELECT body, mtime FROM files WHERE name = ?").get(name);
    put(db, name, (cur?.body ?? "") + text, Date.now());
  }).immediate();
}

/** Read-modify-write under one write transaction (serializes concurrent writers). */
export function updateText(path: string, f: (body: string | null) => string): string {
  const { db, name } = load(path);
  let out = "";
  db.transaction(() => {
    const cur = db.query<Row, [string]>("SELECT body, mtime FROM files WHERE name = ?").get(name);
    out = f(cur?.body ?? null);
    put(db, name, out, Date.now());
  }).immediate();
  return out;
}

export function readJson<T>(path: string, fallback: T): T {
  const t = readText(path);
  if (t === null) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}
export const writeJson = (path: string, v: unknown, indent?: number): void => writeText(path, JSON.stringify(v, null, indent));
