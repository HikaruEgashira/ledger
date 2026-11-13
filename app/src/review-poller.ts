#!/usr/bin/env bun
// Poll open PRs in configured review scopes via GraphQL and trigger ledger review on new heads.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_TOML, escapeRe, localConfig, org } from "./lib/org.ts";
import {
  exec,
  stableStringify,
} from "./lib/util.ts";

export const ROOT = resolve(import.meta.dir, "../..");
export const OVERLAP_MS = 5 * 60 * 1000;
export const MIN_REMAINING = 500;
export const FULL_SWEEP_MS = 6 * 60 * 60 * 1000;
const SOURCE = "review-poller";
export const QUERY = `
query($q: String!, $cursor: String) {
  rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    nodes { ... on PullRequest { url headRefOid author { login } } }
    pageInfo { endCursor hasNextPage }
  }
}
`;

export type Scope = { name: string; profile: string; repo?: string; repos?: string[]; authors?: string[]; exclude_authors?: string[]; title?: string };
export class PollerExit extends Error {}
export type Gh = (args: string[]) => string;
export type Enqueue = (url: string, scope: string) => boolean;

export function loadScopes(config: Record<string, any>, root = ROOT, orgName = org(), where = CONFIG_TOML): Scope[] {
  const scopes: Scope[] = config.scopes ?? [];
  if (!scopes.length) throw new PollerExit(`${where}: scopes is empty`);
  for (const s of scopes) {
    if (!existsSync(join(root, s.profile))) throw new PollerExit(`${where}: scope ${s.name} profile not found`);
    if (Boolean(s.authors?.length) === Boolean(s.repo))
      throw new PollerExit(`${where}: scope ${s.name} needs exactly one of authors or repo`);
    if (s.repo && !s.repo.startsWith(`${orgName}/`))
      throw new PollerExit(`${where}: scope ${s.name} repo must be under ${orgName}`);
    if (s.repos?.length && (!s.authors?.length || !s.repos.every((r) => r.startsWith(`${orgName}/`))))
      throw new PollerExit(`${where}: scope ${s.name} repos needs authors and ${orgName} repos`);
    if (s.title !== undefined && (!s.title.trim() || s.title.includes('"')))
      throw new PollerExit(`${where}: scope ${s.name} title must be non-empty without double quotes`);
    s.exclude_authors = [...(config.exclude_authors ?? []), ...(s.exclude_authors ?? [])];
  }
  return scopes;
}

export function qualifier(s: Scope, orgName = org()): string {
  let base: string;
  if (s.repo) base = `repo:${s.repo}`;
  else {
    const where = s.repos?.length ? s.repos.map((r) => `repo:${r}`).join(" ") : `org:${orgName}`;
    base = where + " " + (s.authors ?? []).map((a) => `author:${a}`).join(" ");
  }
  if (s.title) base += ` in:title "${s.title}"`;
  return [base, ...(s.exclude_authors ?? []).map((a) => `-author:${a}`)].join(" ");
}

const runGh: Gh = (args) => {
  const r = exec(["gh", ...args], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr || (r.timedOut ? "timeout" : "")}`);
  return r.stdout;
};

export function fetchScope(q: string, since: string | null, gh: Gh = runGh, orgName = org()): Map<string, string> {
  const urlRe = new RegExp(`^https://github\\.com/${escapeRe(orgName)}/[^/]+/pull/[1-9][0-9]*$`);
  const query = `${q} is:pr is:open archived:false` + (since ? ` updated:>=${since}` : "");
  const heads = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${query}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const data = JSON.parse(gh(args)).data;
    if (data.rateLimit.remaining < MIN_REMAINING) throw new PollerExit("GraphQL rate limit low; skipping until next poll");
    for (const n of data.search.nodes) if (n && urlRe.test(n.url ?? "")) heads.set(n.url, n.headRefOid);
    if (!data.search.pageInfo.hasNextPage) return heads;
    cursor = data.search.pageInfo.endCursor;
  }
}

/** {url: [head, scope]} for open org PRs (drafts included); earlier scopes win. */
export function fetchOpenPrs(scopes: Scope[], since: string | null, gh: Gh = runGh, orgName = org()): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  for (const s of scopes)
    for (const [url, head] of fetchScope(qualifier(s, orgName), since, gh, orgName))
      if (!found.has(url)) found.set(url, [head, s.name]);
  return found;
}

// intakectl performs live validation; already-listed URLs exit 0 unchanged.
const runEnqueue = (root: string): Enqueue => (url, scope) =>
  exec(["bun", join(root, "app/src/intakectl.ts"), "add", url, "--priority", "50",
    "--reason", `PR in review scope ${scope} detected by review poller`,
    "--source", SOURCE, "--scope", scope, "--execute"], { cwd: root, timeoutMs: 120_000 }).code === 0;

const isoUtc = (d: Date) => d.toISOString().replace("Z", "+00:00");
const sinceStamp = (cursor: string) =>
  new Date(Date.parse(cursor.trim().replace(/(\.\d{3})\d+/, "$1")) - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, "Z");

const ledgerUrls = (root: string): Set<string> => {
  const p = join(root, "pull_requests.jsonl");
  if (!existsSync(p)) return new Set();
  return new Set(readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l).url));
};

export type PollOpts = { root?: string; dryRun?: boolean; full?: boolean; gh?: Gh; enqueue?: Enqueue; now?: Date; config?: Record<string, any>; orgName?: string };

export function poll(opts: PollOpts = {}): string {
  const root = opts.root ?? ROOT;
  const dir = join(root, "logs/review-poller");
  const state = join(dir, "heads.json");
  const cursor = join(dir, "last_poll.txt");
  const sweep = join(dir, "last_full_sweep.txt");
  const orgName = opts.orgName ?? org();
  mkdirSync(dir, { recursive: true });
  const previous: Record<string, string> = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
  const started = opts.now ?? new Date();
  const lastFull = existsSync(sweep) ? Date.parse(readFileSync(sweep, "utf8").trim().replace(/(\.\d{3})\d+/, "$1")) : NaN;
  // Full sweeps catch PRs never updated since a scope was added or the poller was down.
  const full = opts.full || opts.dryRun || !existsSync(cursor) || !(started.getTime() - lastFull < FULL_SWEEP_MS);
  const since = full ? null : sinceStamp(readFileSync(cursor, "utf8"));
  const config = opts.config ?? localConfig(join(root, "config/config.toml"));
  const scopes = loadScopes(config, root, orgName, join(root, "config/config.toml"));
  const current = fetchOpenPrs(scopes, since, opts.gh, orgName);
  const heads = (skip = new Set<string>()) =>
    Object.fromEntries([...current].filter(([u]) => !skip.has(u)).map(([u, [h]]) => [u, h]));
  const listed = full ? ledgerUrls(root) : new Set<string>();
  // intakectl is a no-op for listed URLs, so full sweeps only enqueue unlisted ones.
  const changed = [...current].filter(([u, [h]]) => (full ? !listed.has(u) : previous[u] !== h)).map(([u]) => u);
  if (opts.dryRun)
    return JSON.stringify({ open: current.size, changed: Object.fromEntries(changed.map((u) => [u, current.get(u)![1]])) }, null, 2);
  const enqueue = opts.enqueue ?? runEnqueue(root);
  const queued = changed.filter((u) => enqueue(u, current.get(u)![1]));
  // Failed intakes stay out of state so the next poll retries them.
  const failed = new Set(changed.filter((u) => !queued.includes(u)));
  writeFileSync(state, JSON.stringify({ ...previous, ...heads(failed) }, null, 2));
  if (!failed.size) {
    writeFileSync(cursor, isoUtc(started));
    if (full) writeFileSync(sweep, isoUtc(started));
  }
  // Worker dispatch, retries and concurrency live in reviewctl serve (app/src/queue.ts).
  return stableStringify({ full, open: current.size, queued });
}

export function main(argv: string[]): number {
  const unknown = argv.filter((a) => a !== "--dry-run" && a !== "--full");
  if (unknown.length) {
    console.error(`usage: review-poller.ts [--dry-run] [--full]\nreview-poller.ts: error: unrecognized arguments: ${unknown.join(" ")}`);
    return 2;
  }
  try {
    console.log(poll({ dryRun: argv.includes("--dry-run"), full: argv.includes("--full") }));
    return 0;
  } catch (e) {
    if (e instanceof PollerExit) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
