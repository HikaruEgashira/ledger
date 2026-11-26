// Periodically tell authors what they need to do on PRs whose ball is with them (conflicts, red CI, change requests, open threads).
import { join, resolve } from "node:path";
import * as store from "./lib/store.ts";
import { localConfig, org } from "./lib/org.ts";
import { runGh } from "./reviewctl/core.ts";
import { exec } from "./lib/util.ts";

const ROOT = resolve(import.meta.dir, "../..");
export const NUDGE_STATE = join(ROOT, "nudges.json");
const HOUR = 3_600_000;
// Pre-merge states where the agent only waits; approved/human_required/post-merge rows are not the author's turn.
const WATCHED = new Set(["queued", "waiting_ci", "changes_requested"]);
const CODERABBIT = new Set(["coderabbitai", "coderabbitai[bot]"]);

type Row = Record<string, any>;
export type NudgeState = Record<string, { at: string; head: string }>;

export function nudgeConfig(cfg = localConfig()): { authors: Set<string>; intervalMs: number } {
  const authors = Array.isArray(cfg.nudge_authors) ? cfg.nudge_authors.filter((a: unknown) => typeof a === "string") : [];
  return { authors: new Set(authors), intervalMs: (Number(cfg.nudge_interval_hours) || 24) * HOUR };
}

/** Watched non-draft ledger rows whose enrolled author has been idle (and un-nudged) for the interval. */
export function candidates(rows: Row[], state: NudgeState, authors: Set<string>, now: number, intervalMs: number): Row[] {
  return rows.filter((r) => {
    const live = r.live ?? {};
    if (!WATCHED.has(r.status) || live.state !== "OPEN" || live.isDraft || !authors.has(live.author?.login)) return false;
    const idle = now - Date.parse(live.updatedAt ?? "") >= intervalMs;
    const last = state[r.url];
    return idle && (!last || now - Date.parse(last.at) >= intervalMs);
  });
}

/** Author-actionable asks from the sync verdict's blockers plus open review threads; agent-side reasons map to nothing. */
export function asks(row: Row, threads: Row[]): string[] {
  const out: string[] = [];
  for (const r of (row.decision?.reasons ?? []) as string[]) {
    if (r === "pull request mergeability is CONFLICTING") out.push("base ブランチとのコンフリクト解消");
    else if (r === "pull request merge state is BEHIND") out.push("base ブランチの取り込み");
    else if (r.startsWith("failed checks: ")) out.push(`CI (${r.slice(15)}) の修正`);
    else if (r === "an active review requests changes" || /unresolved blocking finding/.test(r)) out.push("Request changes の指摘への対応");
  }
  const open = threads.filter((t) => !t.isResolved && !t.isOutdated);
  if (open.length) {
    const cr = open.filter((t) => CODERABBIT.has(t.comments?.nodes?.[0]?.author?.login)).length;
    out.push(`未解決のレビュースレッド ${open.length} 件${cr ? `（うち CodeRabbit ${cr} 件）` : ""}への修正か返信・resolve`);
  }
  return [...new Set(out)];
}

export function message(author: string, list: string[]): string | null {
  if (!list.length) return null;
  return `@${author} 以下の対応をお願いします🙏\n${list.map((a) => `- ${a}`).join("\n")}`;
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
      const body = message(row.live.author.login, asks(row, fetchThreads(row.url)));
      // Nothing concrete to ask: record the check so the PR is not re-fetched every loop.
      if (body) {
        // The server's gh token is read-only; post with the write-capable app.
        const app = localConfig().nudge_app ?? localConfig().authored_auto_merge_app;
        if (typeof app !== "string" || !app) throw new Error("nudge_app / authored_auto_merge_app is not set");
        const r = exec(["gh", "pr", "comment", row.url, "--body", body], { env: { ...process.env, GHTKN_APP: app } });
        if (r.code) throw new Error(r.stderr.trim() || "gh pr comment failed");
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
