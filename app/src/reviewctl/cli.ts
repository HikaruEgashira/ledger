#!/usr/bin/env node
// Deterministic ledger and approval gate for review-ledger-prs.
import { type Program, runProgram } from "../lib/argparse.ts";
import { comparePy, ReviewCtlError } from "../lib/py.ts";
import { commandAutoReview } from "./auto.ts";
import * as c from "./commands.ts";
import { ALL_STATUSES, DEFAULT_LEDGER } from "./core.ts";

export const PROGRAM: Program<c.Args> = {
  prog: "reviewctl",
  globals: { ledger: { kind: "path", default: DEFAULT_LEDGER } },
  commands: {
    validate: { run: c.commandValidate },
    list: {
      options: { status: { kind: "append", choices: [...ALL_STATUSES].sort(comparePy) } },
      run: c.commandList,
    },
    next: {
      options: { limit: { kind: "int", default: 20 }, summary: { kind: "flag" } },
      run: c.commandNext,
    },
    sync: { positionals: [{ name: "url", nargs: "?" }], run: c.commandSync },
    record: { positionals: [{ name: "url" }, { name: "artifact" }], run: c.commandRecord },
    gate: { positionals: [{ name: "url" }], run: c.commandGate },
    approve: {
      positionals: [{ name: "url" }],
      options: { execute: { kind: "flag" } },
      run: c.commandApprove,
    },
    "request-changes": {
      positionals: [{ name: "url" }, { name: "body_file" }],
      options: { execute: { kind: "flag" } },
      run: c.commandRequestChanges,
    },
    withdraw: {
      positionals: [{ name: "url" }],
      options: {
        "review-id": { kind: "int", required: true },
        "base-sha": { kind: "string", required: true },
        "head-sha": { kind: "string", required: true },
        message: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: c.commandWithdraw,
    },
    dispatch: {
      positionals: [{ name: "url" }],
      options: { reviewer: { kind: "string", required: true }, execute: { kind: "flag" } },
      run: c.commandDispatch,
    },
    reconcile: {
      positionals: [{ name: "url" }],
      options: {
        action: { kind: "string", required: true, choices: ["approve", "request-changes"] },
        evidence: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: c.commandReconcile,
    },
    recover: {
      positionals: [{ name: "url" }, { name: "artifact" }],
      options: {
        reviewer: { kind: "string", required: true },
        evidence: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: c.commandRecover,
    },
    "auto-review": { options: { execute: { kind: "flag" } }, run: commandAutoReview },
    monitor: { options: { once: { kind: "flag", required: true } }, run: c.commandMonitor },
  },
};

export const main = (argv: string[]): number => runProgram(PROGRAM, argv, [ReviewCtlError]);

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
