import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { errorClass, retro } from "./daily-retro.ts";

describe("daily retro", () => {
  it("normalizes error classes", () => {
    expect(errorClass("\x1b[31mfail\x1b[0m at 12:34:56.789 /pull/12 sha " + "a".repeat(40) + " x42")).toBe(
      "fail at # # sha # x#",
    );
  });

  it("aggregates new log lines and ledger rows, resuming from offset", () => {
    const root = mkdtempSync(join(tmpdir(), "retro-"));
    mkdirSync(join(root, "logs"));
    const log = join(root, "logs/reviewctl-serve.log");
    writeFileSync(log, '{"event":"old"}\n');
    writeFileSync(join(root, "pull_requests.jsonl"), '{"status":"queued"}\n{"status":"queued","last_error":"boom 7"}\n{"status":"completed"}\n');
    const now = new Date(2026, 10, 3, 9);
    retro(root, now);
    appendFileSync(log, 'garbage\n{"event":"tick","url":"u1"}\n{"event":"fail","url":"u1","error":"bad 12"}\n[1]\n');
    const out = retro(root, now);
    expect(out).toBe(join(root, "logs/retro/2026-11-03.json"));
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      date: "2026-11-03",
      events: { tick: 1, fail: 1 },
      event_errors: { "fail: bad #": 1 },
      noisiest_prs: { u1: 2 },
      ledger_status: { queued: 2, completed: 1 },
      ledger_last_errors: { "boom #": 1 },
    });
  });
});
