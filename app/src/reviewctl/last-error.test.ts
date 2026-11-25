import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRow, readLedger, writeLedger } from "./core.ts";

const row = (last_error: string | null) => ({ ...newRow("https://github.com/example-org/x/pull/1", 50), last_error });

describe("writeLedger last_error", () => {
  it("strips ANSI colour and stamps last_error_at only when the text changes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "le-")), "pull_requests.jsonl");
    writeLedger(path, [row("\u001b[91mERR\u001b[0m boom")]);
    const first = readLedger(path)[0];
    expect(first.last_error).toBe("ERR boom");
    expect(first.last_error_at).toBeTruthy();
    writeLedger(path, [{ ...first, last_error_at: "kept" }]);
    expect(readLedger(path)[0].last_error_at).toBe("kept");
    writeLedger(path, [{ ...first, last_error: null }]);
    expect(readLedger(path)[0].last_error_at).toBeUndefined();
  });
});
