import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSE, HOLD, readDecisions, readDispatched, readHistory } from "./authored-prs.ts";
import { QUIET_MS, examples, parseAnswers, parseReply, readMemory, run, watch } from "./auto-decide.ts";

test("watch fires QUIET_MS after the latest unhandled human answer", () => {
  const t = "2026-01-01T00:00:00.000Z";
  expect(watch(null, null, 0).state).toBe("idle");
  expect(watch(t, t, Date.parse(t) + QUIET_MS).state).toBe("idle");
  expect(watch(t, null, Date.parse(t) + QUIET_MS - 1)).toEqual({ state: "watching", due_at: Date.parse(t) + QUIET_MS });
  expect(watch(t, "older", Date.parse(t) + QUIET_MS)).toEqual({ state: "due", last: t });
});

const pend = (url: string, options: string[]) => ({ url, repository: "o/r", pr_number: 1, title: "t", reason: "conflict" as any, head: "h", question: "q", options, asked_at: "a", held: false });
test("parseAnswers keeps only listed, non-hold options with a precedent, once per PR", () => {
  const p = [pend("u", ["A", HOLD]), pend("v", ["B"])];
  const ex = [{ question: "q", choice: "A", options: [] }];
  const out = parseAnswers(JSON.parse('[{"url":"u","choice":"A","precedent":0},{"url":"u","choice":"A","precedent":0},{"url":"v","choice":"Z","precedent":0},{"url":"v","choice":"B","precedent":5},{"url":"w","choice":"A","precedent":0}]'), p, ex);
  expect(out).toEqual([{ url: "u", choice: "A", precedent: 0 }]);
  expect(parseAnswers([{ url: "u", choice: HOLD, precedent: 0 }], p, ex)).toEqual([]);
  expect(parseAnswers("nope", p, ex)).toEqual([]);
  expect(parseReply("nope")).toEqual({ answers: [], memory: null });
  expect(parseReply('x {"answers":[],"memory":["a", 1]}').memory).toBeNull();
});

test("run answers by precedent, logs it as auto, and learns only from human answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-"));
  const ledger = join(dir, "authored_prs.jsonl");
  mkdirSync(join(dir, "logs"));
  const row = (url: string) => JSON.stringify({ url, repository: "o/r", pr_number: 1, title: "t", status: "mine_changes_requested", reason: "conflict", head_sha: "h", pending_reviewers: [], responded_reviewers: [] });
  writeFileSync(ledger, [row("u"), row("v")].join("\n") + "\n");
  writeFileSync(join(dir, "logs", "authored-decisions.json"), JSON.stringify({ old: { head: "x", question: "empty diff, close?", choice: CLOSE, at: "2026-01-01T00:00:00Z" } }));
  const at = "2026-01-02T00:00:00Z";
  writeFileSync(join(dir, "logs", "authored-dispatched.json"), JSON.stringify({ u: { head: "h", reason: "empty diff again", at }, v: { head: "h", reason: "unrelated", at } }));
  const closed: string[] = [];
  const out = run(ledger, () => JSON.stringify({ answers: [{ url: "u", choice: CLOSE, precedent: 0 }], memory: ["差分が空のPRはcloseする"] }), (u) => closed.push(u));
  expect(readMemory(ledger)).toContain("- 差分が空のPRはcloseする");
  expect(out.map((a) => a.url)).toEqual(["u"]);
  expect(closed).toEqual(["u"]);
  expect(readDispatched(ledger).u).toBeUndefined();
  expect(readDispatched(ledger).v).toBeDefined();
  expect(readDecisions(ledger).u.by).toBe("auto");
  expect(readHistory(ledger).at(-1)).toMatchObject({ url: "u", by: "auto" });
  expect(examples(ledger).examples).toHaveLength(1);
});
