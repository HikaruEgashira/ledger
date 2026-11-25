import { describe, expect, it } from "bun:test";
import { classify, parseLines, parseWorker } from "./logs.ts";
import { filterLogs, normalizeEntry } from "../webui/logfilter.ts";

describe("logs", () => {
  it("classifies guard and sandbox failures as errors", () => {
    expect(classify("gh:1: command not found: _ipg_check")).toBe("error");
    expect(classify("vpn-guard: Prisma Access 未接続のため gh pr を停止しました")).toBe("error");
    expect(classify('{"open": 0, "queued": []}')).toBe("info");
  });
  it("marks FAILED events as errors and extracts the PR url", () => {
    const [e] = parseLines("serve", ['{"event": "SYNC_FAILED", "url": "https://github.com/example-org/a/pull/1"}']);
    expect(e.level).toBe("error");
    expect(e.links).toEqual(["https://github.com/example-org/a/pull/1"]);
  });
  it("attributes worker tool errors to the PR from the init line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", prompt: "x https://github.com/example-org/b/pull/2" }),
      JSON.stringify({ type: "user", session_id: "s", message: { content: [{ type: "tool_result", content: "gh:1: command not found: _ipg_check" }] } }),
      JSON.stringify({ type: "result", session_id: "s", is_error: false, result: "done" }),
    ];
    const out = parseWorker(lines);
    expect(out.map((e) => [e.level, e.links[0]])).toEqual([
      ["error", "https://github.com/example-org/b/pull/2"],
      ["info", "https://github.com/example-org/b/pull/2"],
    ]);
  });
  it("filters by minimum level, source and text", () => {
    const es = [
      { source: "a", level: "error" as const, ts: null, links: [], msg: "boom" },
      { source: "b", level: "warn" as const, ts: null, links: [], msg: "hmm" },
      { source: "a", level: "info" as const, ts: null, links: [], msg: "ok" },
    ];
    expect(filterLogs(es, { level: "warn", source: "", q: "" }).length).toBe(2);
    expect(filterLogs(es, { level: "all", source: "a", q: "ok" }).map((e) => e.msg)).toEqual(["ok"]);
  });
  it("reads entries from the older single-url shape", () => {
    expect(normalizeEntry({ source: "a", level: "error", ts: null, url: "https://github.com/o/r/pull/1", msg: "x" }).links).toEqual(["https://github.com/o/r/pull/1"]);
  });
  it("links Slack threads and Jira tickets and matches them by identity", () => {
    const [e] = parseLines("worker", ["task https://x.slack.com/archives/C01ABC/p1794971997292459?thread_ts=1794971000.000100 and https://x.atlassian.net/browse/PROJ-12 failed"]);
    expect(e.links.length).toBe(2);
    expect(filterLogs([e], { level: "all", source: "", q: "", link: "https://x.slack.com/archives/C01ABC/p1794971000000100" }).length).toBe(1);
    expect(filterLogs([e], { level: "all", source: "", q: "", link: "https://x.atlassian.net/browse/PROJ-12" }).length).toBe(1);
    expect(filterLogs([e], { level: "all", source: "", q: "", link: "https://x.atlassian.net/browse/PROJ-1" }).length).toBe(0);
  });
});

import { groupLogs } from "../webui/logfilter.ts";
describe("groupLogs", () => {
  it("collapses the same failure across PRs", () => {
    const mk = (n: number) => ({ source: "serve", level: "error" as const, ts: null, links: [`https://github.com/example-org/a/pull/${n}`], msg: `{"error": "HTTP 401", "url": "https://github.com/example-org/a/pull/${n}"}` });
    const [g, ...rest] = groupLogs([mk(1), mk(2)]);
    expect(rest).toEqual([]);
    expect(g.count).toBe(2);
    expect(g.links.length).toBe(2);
  });
  it("downgrades CI failures and tool warnings", async () => {
    const { classify } = await import("./logs.ts");
    expect(classify("tool: warning: FOO is not set")).toBe("warn");
    expect(classify('{"event": "CI_FAILED"}')).toBe("warn");
  });
});

import { existsSync, mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestLogs, openDb, queryLogs } from "./db.ts";
import { inRange } from "../webui/logfilter.ts";
describe("sqlite store", () => {
  it("ingests only appended lines and keeps worker session links across passes", () => {
    const root = mkdtempSync(join(tmpdir(), "rf-"));
    mkdirSync(join(root, "logs/review-poller"), { recursive: true });
    const w = join(root, "logs/review-poller/worker.log");
    writeFileSync(w, JSON.stringify({ type: "system", subtype: "init", session_id: "s", prompt: "https://x.atlassian.net/browse/PROJ-3" }) + "\n");
    const db = openDb(root, ":memory:");
    expect(ingestLogs(db, root, "2026-11-24T00:00:00Z")).toBe(0);
    appendFileSync(w, JSON.stringify({ type: "result", session_id: "s", is_error: true, result: "boom" }) + "\npartial");
    expect(ingestLogs(db, root, "2026-11-24T00:01:00Z")).toBe(1);
    expect(ingestLogs(db, root, "2026-11-24T00:02:00Z")).toBe(0);
    const [e] = queryLogs(db);
    expect([e.level, e.ts, e.links]).toEqual(["error", "2026-11-24T00:01:00Z", ["https://x.atlassian.net/browse/PROJ-3"]]);
  });
  it("keeps ledgers in the store, migrating a legacy file once", async () => {
    const store = await import("./lib/store.ts");
    const root = mkdtempSync(join(tmpdir(), "rf-"));
    const p = join(root, "tasks.jsonl");
    writeFileSync(p, JSON.stringify({ id: "jira:A-1", url: "u1", title: "t" }) + "\n");
    expect(store.readText(p)).toContain('"u1"');
    expect(existsSync(p)).toBe(false);
    expect(existsSync(p + ".migrated")).toBe(true);
    store.appendText(join(root, "logs/h.jsonl"), "{}\n");
    expect(store.storeDb(root).query("SELECT file, key, data ->> '$.title' AS t FROM records ORDER BY file").all()).toEqual([
      { file: "logs/h.jsonl", key: "0", t: null },
      { file: "tasks.jsonl", key: "u1", t: "t" },
    ]);
  });
  it("filters by window and keeps undated entries only for the month view", () => {
    const now = Date.parse("2026-11-03T00:00:00Z");
    const e = (ts: string | null) => ({ source: "s", level: "error" as const, ts, links: [], msg: "" });
    expect(inRange(e("2026-11-02T23:30:00Z"), "h", now)).toBe(true);
    expect(inRange(e("2026-11-02T22:00:00Z"), "h", now)).toBe(false);
    expect(inRange(e("2026-11-02T22:00:00Z"), "d", now)).toBe(true);
    expect(inRange(e(null), "w", now)).toBe(false);
    expect(inRange(e(null), "m", now)).toBe(true);
  });
});
