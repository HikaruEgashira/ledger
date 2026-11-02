// Ledger serialization, time, and lock helpers (stable JSON format of pull_requests.jsonl).
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export class ReviewCtlError extends Error {}

/** Exit with a specific code without printing an `error:` line. */
export class ExitCode extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, any>;

/** Canonical JSON: sorted keys, compact separators, UTF-8 (not ASCII-escaped). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
}

export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sha256 = (data: string | Buffer): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

export type Exec = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Run a command synchronously; throws only when it cannot be started. */
export function exec(
  cmd: string[],
  opts: { input?: string; timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Exec {
  const r = Bun.spawnSync(cmd, {
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    timeout: opts.timeoutMs,
    cwd: opts.cwd,
    env: opts.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: !!r.exitedDueToTimeout };
}

/** Microseconds since the epoch (ledger timestamps keep 6 fractional digits). */
export type Micros = number;
const MICRO_PER_MS = 1000;
let lastMicros = 0;

export function nowMicros(): Micros {
  const ms = Date.now();
  // keep sub-millisecond ordering monotonic within a process
  const micros = Math.max(
    ms * MICRO_PER_MS + Math.floor((performance.now() % 1) * 1000),
    lastMicros + 1,
  );
  lastMicros = micros;
  return micros;
}

/** ISO 8601 UTC with microseconds and a trailing Z. */
export function timestamp(value?: Micros): string {
  const micros = value ?? nowMicros();
  const secs = Math.floor(micros / 1e6);
  const frac = micros - secs * 1e6;
  const base = new Date(secs * 1000).toISOString().slice(0, 19);
  return frac ? `${base}.${String(frac).padStart(6, "0")}Z` : `${base}Z`;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)?)?$/;

/** Parse ISO 8601; values without a timezone are rejected. */
export function parseTime(value: unknown): Micros {
  const repr = JSON.stringify(value) ?? String(value);
  const m = typeof value === "string" ? ISO_RE.exec(value) : null;
  if (!m) throw new ReviewCtlError(`invalid timestamp: ${repr}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", tz] = m;
  const fields = [+y, +mo, +d, +h, +mi, +s];
  const date = new Date(
    Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]),
  );
  if (
    date.getUTCFullYear() !== fields[0] ||
    date.getUTCMonth() !== fields[1] - 1 ||
    date.getUTCDate() !== fields[2] ||
    fields[3] > 23 ||
    fields[4] > 59 ||
    fields[5] > 59
  )
    throw new ReviewCtlError(`invalid timestamp: ${repr}`);
  if (!tz) throw new ReviewCtlError(`timestamp must include a timezone: ${repr}`);
  let offset = 0;
  if (tz !== "Z") {
    const digits = tz.slice(1).replace(/:/g, "");
    const sec = Number(digits.slice(4, 6) || 0) + Number("0." + (digits.split(".")[1] ?? "0"));
    offset =
      (tz[0] === "-" ? -1 : 1) *
      ((Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * 60 + sec);
    if (Math.abs(offset) >= 86400) throw new ReviewCtlError(`invalid timestamp: ${repr}`);
  }
  const micros = Number(frac.padEnd(6, "0").slice(0, 6));
  return date.getTime() * MICRO_PER_MS + micros - Math.round(offset * 1e6);
}

export const MINUTE: Micros = 60 * 1e6;

export const rstripSlash = (s: string): string => s.replace(/\/+$/, "");

/** Missing-or-empty JSON value: null, undefined, false, 0, "", [], {}. */
export const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === false ||
  v === 0 ||
  v === "" ||
  (Array.isArray(v) && !v.length) ||
  (isObj(v) && !Object.keys(v).length);

export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Deep equality treating undefined as null (absent JSON field). */
export const sameValue = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a ?? null, b ?? null);

export const isErrno = (e: unknown): e is NodeJS.ErrnoException =>
  typeof (e as NodeJS.ErrnoException)?.code === "string" && !(e instanceof ReviewCtlError);

const LOCK_POLL_MS = 50;
const LOCK_ORPHAN_MS = 10_000;
function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive ledger lock (`<ledger>.lock.d` + owner pid). */
export function withLedgerLock<T>(ledger: string, fn: () => T): T {
  const dir = ledger + ".lock.d";
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(dir + "/pid", String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = NaN;
      try {
        owner = Number(readFileSync(dir + "/pid", "utf8"));
      } catch {
        // owner died between mkdir and writing its pid
        if (Date.now() - statMtime(dir) > LOCK_ORPHAN_MS) owner = 0;
      }
      if (owner === 0 || (Number.isInteger(owner) && owner > 0 && !pidAlive(owner)))
        rmSync(dir, { recursive: true, force: true });
      else sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
