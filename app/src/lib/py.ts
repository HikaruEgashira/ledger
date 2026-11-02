// Byte-compatible helpers for data shared with the remaining Python tools.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export class ReviewCtlError extends Error {}

/** Exit without the generic `error:` prefix, like Python's SystemExit. */
export class ExitCode extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, any>;

const pyString = (value: string): string => JSON.stringify(value);

function pyNumber(value: number): string {
  if (!Number.isFinite(value))
    return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  return String(value);
}

/** json.dumps(value, ensure_ascii=False, sort_keys=...) with default or compact separators. */
export function pyDumps(
  value: unknown,
  opts: { sortKeys?: boolean; compact?: boolean } = {},
): string {
  const item = opts.compact ? "," : ", ";
  const kv = opts.compact ? ":" : ": ";
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return pyNumber(v);
    if (typeof v === "string") return pyString(v);
    if (Array.isArray(v)) return "[" + v.map(walk).join(item) + "]";
    const keys = Object.keys(v as Obj).filter((k) => (v as Obj)[k] !== undefined);
    if (opts.sortKeys) keys.sort(comparePy);
    return "{" + keys.map((k) => pyString(k) + kv + walk((v as Obj)[k])).join(item) + "}";
  };
  return walk(value);
}

/** Python str ordering compares code points, not UTF-16 units. */
export function comparePy(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

export const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Microseconds since the epoch; JS Date alone loses Python's precision. */
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

/** datetime.isoformat() in UTC with a trailing Z. */
export function timestamp(value?: Micros): string {
  const micros = value ?? nowMicros();
  const secs = Math.floor(micros / 1e6);
  const frac = micros - secs * 1e6;
  const base = new Date(secs * 1000).toISOString().slice(0, 19);
  return frac ? `${base}.${String(frac).padStart(6, "0")}Z` : `${base}Z`;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)?)?$/;

/** datetime.fromisoformat() that rejects naive values, as parse_time does. */
export function parseTime(value: unknown): Micros {
  const repr =
    typeof value === "string"
      ? `'${value}'`
      : value === null || value === undefined
        ? "None"
        : String(value);
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

/** Python str.strip()/split() whitespace. */
export const pyStrip = (s: string): string =>
  s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, "");
export const rstripSlash = (s: string): string => s.replace(/\/+$/, "");

/** Python truthiness for JSON values. */
export const truthy = (v: unknown): boolean =>
  !(
    v === null ||
    v === undefined ||
    v === false ||
    v === 0 ||
    v === "" ||
    (Array.isArray(v) && !v.length) ||
    (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as Obj).length)
  );

/** isinstance(v, int) including bool, as Python treats it. */
export const isPyInt = (v: unknown): boolean =>
  typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v));
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const pyEq = (a: unknown, b: unknown): boolean =>
  (a === undefined ? null : a) === (b === undefined ? null : b);

/** str(OSError) as Python renders it. */
export function osErrorMessage(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  const known: Record<string, [number, string]> = {
    ENOENT: [2, "No such file or directory"],
    EACCES: [13, "Permission denied"],
    EISDIR: [21, "Is a directory"],
    ENOTDIR: [20, "Not a directory"],
    EPERM: [1, "Operation not permitted"],
  };
  const hit = err?.code ? known[err.code] : undefined;
  if (hit && err.path) return `[Errno ${hit[0]}] ${hit[1]}: '${err.path}'`;
  return err?.message ?? String(e);
}

export const isOsError = (e: unknown): boolean =>
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

/** Exclusive ledger lock shared with ledger_core.py (`<ledger>.lock.d` + owner pid). */
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

/** json.JSONDecodeError: `msg` alone, `message` with Python's position suffix. */
export class PyJSONDecodeError extends SyntaxError {
  readonly msg: string;
  constructor(msg: string, doc: string[], pos: number) {
    const before = doc.slice(0, pos).join("");
    const lineno = before.split("\n").length;
    const colno = pos - before.lastIndexOf("\n");
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.msg = msg;
  }
}

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_RE = /^(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** json.loads() with CPython's C-scanner error messages and positions (counted in code points). */
export function pyJsonLoads(text: string): any {
  const s = [...text];
  const fail = (msg: string, pos: number): never => {
    throw new PyJSONDecodeError(msg, s, pos);
  };
  const ws = (i: number) => {
    while (i < s.length && WS.has(s[i])) i++;
    return i;
  };
  class Stop {
    readonly pos: number;
    constructor(pos: number) {
      this.pos = pos;
    }
  }
  const str = (begin: number): [string, number] => {
    let out = "";
    let i = begin + 1;
    for (;;) {
      if (i >= s.length) fail("Unterminated string starting at", begin);
      const ch = s[i];
      if (ch === '"') return [out, i + 1];
      if (ch !== "\\") {
        if (ch.codePointAt(0)! < 0x20) fail("Invalid control character at", i);
        out += ch;
        i++;
        continue;
      }
      const esc = s[i + 1];
      if (esc === undefined) fail("Unterminated string starting at", begin);
      if (esc !== "u") {
        if (!(esc in ESCAPES)) fail("Invalid \\escape", i);
        out += ESCAPES[esc];
        i += 2;
        continue;
      }
      const hex = s.slice(i + 2, i + 6).join("");
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\uXXXX escape", i + 1);
      let code = parseInt(hex, 16);
      i += 6;
      if (code >= 0xd800 && code <= 0xdbff && s[i] === "\\" && s[i + 1] === "u") {
        const low = s.slice(i + 2, i + 6).join("");
        if (!/^[0-9a-fA-F]{4}$/.test(low)) fail("Invalid \\uXXXX escape", i + 1);
        const lo = parseInt(low, 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
          i += 6;
        }
      }
      out += String.fromCodePoint(code);
    }
  };
  const value = (i: number): [unknown, number] => {
    const ch = s[i];
    if (ch === '"') return str(i);
    if (ch === "{") {
      const obj: Record<string, unknown> = {};
      let j = ws(i + 1);
      if (s[j] === "}") return [obj, j + 1];
      if (s[j] !== '"') fail("Expecting property name enclosed in double quotes", j);
      for (;;) {
        const [key, afterKey] = str(j);
        j = ws(afterKey);
        if (s[j] !== ":") fail("Expecting ':' delimiter", j);
        j = ws(j + 1);
        let v: unknown;
        try {
          [v, j] = value(j);
        } catch (e) {
          if (e instanceof Stop) fail("Expecting value", e.pos);
          throw e;
        }
        obj[key] = v;
        j = ws(j);
        if (s[j] === "}") return [obj, j + 1];
        if (s[j] !== ",") fail("Expecting ',' delimiter", j);
        const comma = j;
        j = ws(j + 1);
        if (s[j] === "}") fail("Illegal trailing comma before end of object", comma);
        if (s[j] !== '"') fail("Expecting property name enclosed in double quotes", j);
      }
    }
    if (ch === "[") {
      const arr: unknown[] = [];
      let j = ws(i + 1);
      if (s[j] === "]") return [arr, j + 1];
      for (;;) {
        let v: unknown;
        try {
          [v, j] = value(j);
        } catch (e) {
          if (e instanceof Stop) fail("Expecting value", e.pos);
          throw e;
        }
        arr.push(v);
        j = ws(j);
        if (s[j] === "]") return [arr, j + 1];
        if (s[j] !== ",") fail("Expecting ',' delimiter", j);
        const comma = j;
        j = ws(j + 1);
        if (s[j] === "]") fail("Illegal trailing comma before end of array", comma);
      }
    }
    const rest = s.slice(i, i + 40).join("");
    for (const [word, v] of [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ] as const)
      if (rest.startsWith(word)) return [v, i + word.length];
    const m = NUMBER_RE.exec(s.slice(i, i + 400).join(""));
    if (m) return [Number(m[0]), i + [...m[0]].length];
    throw new Stop(i);
  };
  let result: unknown;
  let end: number;
  try {
    [result, end] = value(ws(0));
  } catch (e) {
    if (e instanceof Stop) fail("Expecting value", e.pos);
    throw e;
  }
  end = ws(end);
  if (end !== s.length) fail("Extra data", end);
  return result;
}
