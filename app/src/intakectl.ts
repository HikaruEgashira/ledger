#!/usr/bin/env bun
// Trusted exact-URL intake for the review-ledger-prs workspace.
import { type Program, runProgram } from "./lib/cli.ts";
import {
  type Micros,
  nowMicros,
  type Obj,
  ReviewCtlError,
  timestamp,
  withLedgerLock,
} from "./lib/util.ts";
import {
  applyLive,
  DEFAULT_LEDGER,
  ghView,
  newRow,
  parsePrUrl,
  printJson,
  readLedger,
  writeLedger,
} from "./reviewctl/core.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

interface Args {
  ledger: string;
  urls: string[];
  priority: number;
  reason: string;
  source: string | null;
  scope: string | null;
  execute: boolean;
}

export function canonicalUrls(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const [repository, number] = parsePrUrl(value);
    const url = `https://github.com/${repository}/pull/${number}`;
    if (seen.has(url)) throw new ReviewCtlError(`duplicate input URL: ${url}`);
    seen.add(url);
    return url;
  });
}

export function validateReason(value: string): string {
  const reason = value.trim();
  if (!reason) throw new ReviewCtlError("exact-URL intake reason must not be empty");
  if (Buffer.byteLength(reason) > 4096)
    throw new ReviewCtlError("exact-URL intake reason is too large");
  return reason;
}

export function intakeRecord(
  url: string,
  priority: number,
  reason: string,
  live: Obj,
  now: Micros,
  source?: string | null,
  scope?: string | null,
): Obj {
  if (live.state !== "OPEN")
    throw new ReviewCtlError(`exact-URL intake requires an open PR: ${url}`);
  const row = newRow(url, priority, now);
  row.intake = {
    mode: "trusted-exact-url",
    reason,
    observed_at: timestamp(now),
    base_sha: live.baseRefOid,
    head_sha: live.headRefOid,
    pr_updated_at: live.updatedAt,
  };
  if (source) row.intake.source = source;
  if (scope) row.intake.scope = scope;
  applyLive(row, live, { now });
  return row;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function commandAdd(args: Args): void {
  if (!(args.priority >= 0 && args.priority <= 100))
    throw new ReviewCtlError("priority must be from 0 to 100");
  if (args.execute && real(args.ledger) !== real(DEFAULT_LEDGER))
    throw new ReviewCtlError("executed exact-URL intake requires the workspace ledger");
  const urls = canonicalUrls(args.urls);
  const reason = validateReason(args.reason);
  const now = nowMicros();
  const results = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const existing = new Set(rows.map((r) => r.url));
    const additions: Obj[] = [];
    const out: Obj[] = [];
    for (const url of urls) {
      if (existing.has(url)) {
        out.push({ action: "already_listed", url });
        continue;
      }
      const live = ghView(url);
      additions.push(intakeRecord(url, args.priority, reason, live, now, args.source, args.scope));
      out.push({
        action: args.execute ? "added" : "would_add",
        base_sha: live.baseRefOid,
        head_sha: live.headRefOid,
        priority: args.priority,
        url,
      });
    }
    if (args.execute && additions.length) writeLedger(args.ledger, [...rows, ...additions]);
    return out;
  });
  for (const result of results) printJson(result);
}

const PROGRAM: Program<Args> = {
  prog: "intakectl",
  globals: { ledger: { kind: "path", default: DEFAULT_LEDGER } },
  commands: {
    validate: {
      run: (args) => {
        const rows = readLedger(args.ledger);
        printJson({ ledger: args.ledger, records: rows.length, valid: true });
      },
    },
    add: {
      positionals: [{ name: "urls", nargs: "+" }],
      options: {
        priority: { kind: "int", default: 50 },
        reason: { kind: "string", required: true },
        source: { kind: "string" },
        scope: { kind: "string" },
        execute: { kind: "flag" },
      },
      run: commandAdd,
    },
  },
};

export const main = (argv: string[]): number => runProgram(PROGRAM, argv, [ReviewCtlError]);

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
