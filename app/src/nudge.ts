// Periodically remind authors of PRs whose ball is with them (we requested changes, CodeRabbit threads open, CI red).
import { join, resolve } from "node:path";
import * as store from "./lib/store.ts";
import { localConfig, org } from "./lib/org.ts";
import { ghWrite, PRE_APPROVAL_REVIEW_CHECKS, runGh } from "./reviewctl/core.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const NUDGE_STATE = join(ROOT, "nudges.json");
const HOUR = 3_600_000;
const BALL_WITH_AUTHOR = new Set(["changes_requested", "waiting_ci"]);
const CODERABBIT = new Set(["coderabbitai", "coderabbitai[bot]"]);

type Row = Record<string, any>;
export type NudgeState = Record<string, { at: string; head: string }>;
export interface Todo { coderabbit: number; failedChecks: string[]; changesRequested: boolean }

export function nudgeConfig(cfg = localConfig()): { authors: Set<string>; intervalMs: number } {
  const authors = Array.isArray(cfg.nudge_authors) ? cfg.nudge_authors.filter((a: unknown) => typeof a === "string") : [];
  return { authors: new Set(authors), intervalMs: (Number(cfg.nudge_interval_hours) || 24) * HOUR };
}

/** Ledger rows we watch silently whose author is enrolled and has been idle (and un-nudged) for the interval. */
export function candidates(rows: Row[], state: NudgeState, authors: Set<string>, now: number, intervalMs: number): Row[] {
  return rows.filter((r) => {
    const live = r.live ?? {};
    if (!BALL_WITH_AUTHOR.has(r.status) || live.isDraft || live.state !== "OPEN") return false;
    if (!authors.has(live.author?.login)) return false;
    const idle = now - Date.parse(live.updatedAt ?? "") >= intervalMs;
    const last = state[r.url];
    return idle && (!last || now - Date.parse(last.at) >= intervalMs);
  });
}

export function todo(row: Row, threads: Row[]): Todo {
  const coderabbit = threads.filter(
    (t) => !t.isResolved && !t.isOutdated && CODERABBIT.has(t.comments?.nodes?.[0]?.author?.login),
  ).length;
  const checks: Row[] = Array.isArray(row.live?.checks) ? row.live.checks : [];
  const failedChecks = checks.filter((c) => ["failure", "error", "timed_out", "cancelled"].includes(c?.state) && !PRE_APPROVAL_REVIEW_CHECKS.has(c.name))
    .map((c) => c.name);
  return { coderabbit, failedChecks, changesRequested: row.status === "changes_requested" };
}

export function message(author: string, t: Todo): string | null {
  const asks: string[] = [];
  if (t.coderabbit) asks.push(`CodeRabbit の未解決指摘 ${t.coderabbit} 件の対応`);
  if (t.failedChecks.length) asks.push(`CI (${t.failedChecks.join(", ")}) の修正`);
  if (t.changesRequested && !asks.length) asks.push("Request changes の指摘への対応");
  if (!asks.length) return null;
  return `@${author} ${asks.join("と")}をお願いします🙏 対応済みならスレッドを resolve するか返信で教えてください`;
}

function fetchThreads(url: string): Row[] {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m || m[1] !== org()) throw new Error(`out-of-org PR: ${url}`);
  const q = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login}}}}}}}}";
  const r = runGh(["api", "graphql", "-f", `query=${q}`, "-f", `o=${m[1]}`, "-f", `r=${m[2]}`, "-F", `n=${m[3]}`]);
  if (r === "timeout" || r.returncode) throw new Error(`review threads unavailable: ${url}`);
  return JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes ?? [];
}

/** One pass: post at most one reminder per eligible PR per interval. Returns the URLs nudged. */
export function nudgeTick(rows: Row[], now = Date.now()): string[] {
  const { authors, intervalMs } = nudgeConfig();
  if (!authors.size) return [];
  const state = store.readJson<NudgeState>(NUDGE_STATE, {});
  const sent: string[] = [];
  for (const row of candidates(rows, state, authors, now, intervalMs)) {
    try {
      const body = message(row.live.author.login, todo(row, fetchThreads(row.url)));
      // Nothing concrete to ask: record the check so the PR is not re-fetched every loop.
      if (body) {
        const r = ghWrite(["pr", "comment", row.url, "--body", body]);
        if (r.returncode) throw new Error(r.stderr.trim() || "gh pr comment failed");
        sent.push(row.url);
      }
      state[row.url] = { at: new Date(now).toISOString(), head: row.live.headRefOid ?? "" };
    } catch (e) {
      console.error(`error: nudge ${row.url}: ${(e as Error).message}`);
    }
  }
  store.writeJson(NUDGE_STATE, state, 2);
  return sent;
}
