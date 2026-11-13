#!/usr/bin/env bun
// Sync direct GitHub review requests into the action-scope review ledger.
import { type Program, runProgram } from "./lib/cli.ts";
import { escapeRe, org } from "./lib/org.ts";
import {
  exec,
  ExitCode,
  type Obj,
  parseTime,
  sameValue,
  ReviewCtlError,
  timestamp,
  withLedgerLock,
  stableStringify,
  isBlank,
} from "./lib/util.ts";
import { main as intakeMain } from "./intakectl.ts";
import {
  applyLive,
  DEFAULT_LEDGER,
  ghView,
  isSha,
  newRow,
  prefetchSync,
  readLedger,
  writeLedger,
} from "./reviewctl/core.ts";

const SCHEMA_VERSION = 1;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const prUrlRe = () =>
  new RegExp(`^https://github\\.com/(?<repository>${escapeRe(org())}/[^/]+)/pull/(?<number>[1-9][0-9]*)$`);
const GRAPHQL_SEARCH_MAX = 1000;
const GRAPHQL_SEARCH = `
query($searchQuery: String!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    nodes {
      ... on PullRequest {
        author {
          login
        }
        baseRefOid
        headRefOid
        isDraft
        latestReviews(first: 100) {
          nodes {
            author {
              login
            }
            state
          }
          pageInfo {
            hasNextPage
          }
        }
        number
        repository {
          nameWithOwner
        }
        reviewRequests(first: 100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User {
                login
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        state
        title
        updatedAt
        url
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
`;

export class ReviewRequestError extends Error {}

const printJson = (value: unknown) =>
  process.stdout.write(stableStringify(value) + "\n");
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(command: string[], timeoutSec = 60): { stdout: string } {
  let r;
  try {
    r = exec(command, { timeoutMs: timeoutSec * 1000 });
  } catch (e) {
    throw new ReviewRequestError(`cannot run ${command[0]}: ${(e as Error).message}`);
  }
  if (r.timedOut) throw new ReviewRequestError(`${command[0]} command timed out`);
  if (r.code) throw new ReviewRequestError(r.stderr.trim() || r.stdout.trim() || "command failed");
  return { stdout: r.stdout };
}

function runGh(args: string[], timeoutSec = 60): any {
  const { stdout } = run(["gh", ...args], timeoutSec);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ReviewRequestError("gh returned invalid JSON");
  }
}

function activeLogin(): string {
  const payload = runGh([
    "auth",
    "status",
    "--active",
    "--hostname",
    "github.com",
    "--json",
    "hosts",
  ]);
  const accounts: Obj[] = payload?.hosts?.["github.com"] ?? [];
  const active = accounts.filter((a) => !isBlank(a.active) && a.state === "success");
  if (active.length !== 1)
    throw new ReviewRequestError("exactly one active GitHub account is required");
  const login = active[0].login;
  if (typeof login !== "string" || !LOGIN_RE.test(login))
    throw new ReviewRequestError("active GitHub login is missing or invalid");
  return login;
}

const TRANSIENT = ["HTTP 502", "HTTP 503", "HTTP 504", "TLS handshake timeout", "unexpected EOF"];

function graphqlSearch(query: string, cursor: string | null = null): Obj {
  const args = ["api", "graphql", "-f", `query=${GRAPHQL_SEARCH}`, "-F", `searchQuery=${query}`];
  if (cursor !== null) args.push("-F", `cursor=${cursor}`);
  let payload: any;
  for (let attempt = 0; ; attempt++) {
    try {
      payload = runGh(args, 120);
      break;
    } catch (e) {
      if (
        !(e instanceof ReviewRequestError) ||
        !TRANSIENT.some((m) => e.message.includes(m)) ||
        attempt === 2
      )
        throw e;
      sleepSync(2 ** attempt * 1000);
    }
  }
  const search = payload?.data?.search;
  if (
    search === undefined ||
    typeof search !== "object" ||
    search === null ||
    Array.isArray(search)
  )
    throw new ReviewRequestError("GraphQL search returned an invalid result");
  return search;
}

const casefold = (s: string) => s.toLowerCase().replace(/ß/g, "ss");

const isDict = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function connectionNodes(payload: Obj, field: string): unknown[] {
  const connection = payload[field];
  const nodes = isDict(connection) ? connection.nodes : undefined;
  const page = isDict(connection) ? connection.pageInfo : undefined;
  if (!Array.isArray(nodes) || !isDict(page) || page.hasNextPage !== false)
    throw new ReviewRequestError(`${field} is incomplete for ${String(payload.url ?? "unknown")}`);
  return nodes;
}

export function directRequest(payload: Obj, login: string): Obj | null {
  const requested = connectionNodes(payload, "reviewRequests").some(
    (r) =>
      isDict(r) &&
      isDict(r.requestedReviewer) &&
      r.requestedReviewer.__typename === "User" &&
      casefold(String(r.requestedReviewer.login ?? "")) === casefold(login),
  );
  return requested ? candidate(payload, login) : null;
}

export function dismissedReview(payload: Obj, login: string): Obj | null {
  const dismissed = connectionNodes(payload, "latestReviews").some(
    (r) =>
      isDict(r) &&
      isDict(r.author) &&
      casefold(String(r.author.login ?? "")) === casefold(login) &&
      r.state === "DISMISSED",
  );
  return dismissed ? candidate(payload, login) : null;
}

function candidate(payload: Obj, login: string): Obj {
  const url = String(payload.url ?? "unknown");
  const m = prUrlRe().exec(String(payload.url ?? ""));
  if (!m?.groups || payload.state !== "OPEN" || payload.number !== Number(m.groups.number))
    throw new ReviewRequestError(`live PR identity is invalid for ${url}`);
  const { baseRefOid: baseSha, headRefOid: headSha, updatedAt } = payload;
  if (!isSha(baseSha) || !isSha(headSha))
    throw new ReviewRequestError(`live PR refs are invalid for ${url}`);
  try {
    parseTime(updatedAt);
  } catch (e) {
    if (e instanceof ReviewCtlError)
      throw new ReviewRequestError(`live PR updatedAt is invalid for ${url}`);
    throw e;
  }
  const author = payload.author || {};
  const repository = payload.repository || {};
  if (repository.nameWithOwner !== m.groups.repository)
    throw new ReviewRequestError(`live PR repository is invalid for ${url}`);
  return {
    schema_version: SCHEMA_VERSION,
    repository: m.groups.repository,
    pr_number: Number(m.groups.number),
    url: payload.url,
    reviewer: login,
    author: author.login ?? null,
    title: payload.title ?? null,
    is_draft: payload.isDraft ?? null,
    base_sha: baseSha,
    head_sha: headSha,
    pr_updated_at: updatedAt,
  };
}

const DAY_MS = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Matcher = (payload: Obj, login: string) => Obj | null;

function fetchSearchRange(
  login: string,
  qualifier: string,
  match: Matcher,
  from: number,
  to: number,
): Obj[] {
  const query = `org:${org()} is:pr is:open archived:false ${qualifier}:${login} created:${isoDate(from)}..${isoDate(to)}`;
  const first = graphqlSearch(query);
  const issueCount = first.issueCount;
  if (!Number.isInteger(issueCount) || issueCount < 0)
    throw new ReviewRequestError("GraphQL search issueCount is invalid");
  if (issueCount > GRAPHQL_SEARCH_MAX) {
    if (from >= to)
      throw new ReviewRequestError(
        `GraphQL search exceeds ${GRAPHQL_SEARCH_MAX} results on ${isoDate(from)}`,
      );
    const mid = from + Math.floor((to - from) / DAY_MS / 2) * DAY_MS;
    return [
      ...fetchSearchRange(login, qualifier, match, from, mid),
      ...fetchSearchRange(login, qualifier, match, mid + DAY_MS, to),
    ];
  }
  const requests: Obj[] = [];
  let page = first;
  for (;;) {
    const { nodes, pageInfo } = page;
    if (
      !Array.isArray(nodes) ||
      typeof pageInfo !== "object" ||
      pageInfo === null ||
      Array.isArray(pageInfo)
    )
      throw new ReviewRequestError("GraphQL search page is invalid");
    for (const node of nodes) {
      if (
        typeof node !== "object" ||
        node === null ||
        Array.isArray(node) ||
        !Object.keys(node).length
      )
        throw new ReviewRequestError("GraphQL search returned a non-PR node");
      const request = match(node, login);
      if (request !== null) requests.push(request);
    }
    const { hasNextPage, endCursor } = pageInfo;
    if (hasNextPage === false) break;
    if (hasNextPage !== true || typeof endCursor !== "string" || !endCursor)
      throw new ReviewRequestError("GraphQL search cursor is invalid");
    page = graphqlSearch(query, endCursor);
  }
  return requests;
}

function fetchCandidates(login: string, qualifier: string, match: Matcher): Obj[] {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const requests = fetchSearchRange(login, qualifier, match, Date.UTC(2008, 0, 1), today);
  const unique = new Map(requests.map((r) => [r.url, r]));
  if (unique.size !== requests.length)
    throw new ReviewRequestError("GraphQL search returned duplicate PR URLs");
  return [...unique.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function syncLedger(): void {
  const apply = prefetchSync(readLedger(DEFAULT_LEDGER));
  const events = withLedgerLock(DEFAULT_LEDGER, () => {
    const rows = readLedger(DEFAULT_LEDGER);
    const out = apply(rows);
    writeLedger(DEFAULT_LEDGER, rows);
    return [...out, { event: "SYNC_COMPLETE", records: rows.length }];
  });
  for (const event of events) printJson({ ...event, source: "ledger" });
}

const metadata = (request: Obj, observedAt: string): Obj => ({
  active: true,
  reviewer: request.reviewer,
  observed_at: observedAt,
  base_sha: request.base_sha,
  head_sha: request.head_sha,
  pr_updated_at: request.pr_updated_at,
});

export function compactRequest(row: Obj): Obj {
  const live = row.live || {};
  const request = row.review_request;
  return {
    schema_version: SCHEMA_VERSION,
    repository: row.repository,
    pr_number: row.pr_number,
    url: row.url,
    reviewer: request.reviewer,
    author: live.author?.login ?? null,
    title: live.title ?? null,
    is_draft: live.isDraft ?? null,
    base_sha: request.base_sha,
    head_sha: request.head_sha,
    pr_updated_at: request.pr_updated_at,
  };
}

function syncDirectRequests(current: Obj[], dismissed: Obj[], login: string): [Obj[], number] {
  const observedAt = timestamp();
  const currentByUrl = new Map(current.map((r) => [r.url as string, r]));
  const dismissedUrls = dismissed.map((r) => r.url as string).filter((u) => !currentByUrl.has(u));
  const existing = withLedgerLock(
    DEFAULT_LEDGER,
    () => new Set(readLedger(DEFAULT_LEDGER).map((r) => r.url)),
  );
  const liveAdditions = new Map<string, Obj>();
  const candidates = [...currentByUrl.keys(), ...dismissedUrls];
  for (const url of candidates.filter((u) => !existing.has(u)).sort()) {
    let live: Obj;
    try {
      live = ghView(url);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      throw new ReviewRequestError(
        `direct request could not be prepared for ledger intake: ${url}: ${e.message}`,
      );
    }
    if (live.state !== "OPEN" || live.url !== url)
      throw new ReviewRequestError(`direct request is no longer an open matching PR: ${url}`);
    liveAdditions.set(url, live);
  }
  return withLedgerLock(DEFAULT_LEDGER, () => {
    const events: Obj[] = [];
    let added = 0;
    const rows = readLedger(DEFAULT_LEDGER);
    const byUrl = new Map(rows.map((r) => [r.url as string, r]));
    for (const [url, request] of currentByUrl) {
      let row = byUrl.get(url);
      let ledgerAction = "existing";
      if (!row) {
        const live = liveAdditions.get(url);
        if (!live)
          throw new ReviewRequestError(
            `direct request intake lost its validated live state: ${url}`,
          );
        row = newRow(url, 50);
        row.intake = {
          mode: "direct-personal-review-request",
          reason: `GitHub directly requested review from ${login}`,
          observed_at: observedAt,
          base_sha: live.baseRefOid,
          head_sha: live.headRefOid,
          pr_updated_at: live.updatedAt,
        };
        applyLive(row, live);
        rows.push(row);
        byUrl.set(url, row);
        ledgerAction = "added";
        added++;
      }
      const previous = row.review_request;
      const meta = metadata(request, observedAt);
      row.review_request = meta;
      let event: string;
      if (!!isBlank(previous) || !!isBlank(previous.active)) event = "REQUEST_ADDED";
      else if (
        ["reviewer", "base_sha", "head_sha", "pr_updated_at"].some(
          (f) => !sameValue(previous[f], meta[f]),
        )
      )
        event = "REQUEST_UPDATED";
      else continue;
      events.push({ event, ledger_action: ledgerAction, ...compactRequest(row) });
    }
    for (const url of dismissedUrls) {
      if (byUrl.has(url)) continue;
      const live = liveAdditions.get(url);
      if (!live)
        throw new ReviewRequestError(`dismissed review intake lost its validated live state: ${url}`);
      const row = newRow(url, 50);
      row.intake = {
        mode: "dismissed-own-review",
        reason: `GitHub dismissed the latest review by ${login}`,
        observed_at: observedAt,
        base_sha: live.baseRefOid,
        head_sha: live.headRefOid,
        pr_updated_at: live.updatedAt,
      };
      applyLive(row, live);
      rows.push(row);
      byUrl.set(url, row);
      added++;
      events.push({ event: "DISMISSED_REVIEW_ADDED", ledger_action: "added", url, reviewer: login });
    }
    for (const row of rows) {
      const previous = row.review_request;
      if (!!isBlank(previous) || !!isBlank(previous.active) || currentByUrl.has(row.url)) continue;
      row.review_request = { ...previous, active: false, observed_at: observedAt };
      events.push({ event: "REQUEST_REMOVED", ledger_action: "retained", ...compactRequest(row) });
    }
    writeLedger(DEFAULT_LEDGER, rows);
    return [events, added] as [Obj[], number];
  });
}

interface Args {
  urls: string[];
  priority: number;
  reason: string;
  execute: boolean;
}

const PROGRAM: Program<Args> = {
  prog: "review-requests",
  commands: {
    sync: {
      run: () => {
        syncLedger();
        const login = activeLogin();
        const current = fetchCandidates(login, "review-requested", directRequest);
        const dismissed = fetchCandidates(login, "reviewed-by", dismissedReview);
        const [events, added] = syncDirectRequests(current, dismissed, login);
        for (const event of events) printJson({ ...event, source: "direct_review_requests" });
        printJson({
          direct_request_count: current.length,
          dismissed_review_count: dismissed.length,
          ledger_added_count: added,
          event: "SYNC_COMPLETE",
          observed_at: timestamp(),
          reviewer: login,
          source: "direct_review_requests",
          state: DEFAULT_LEDGER,
        });
      },
    },
    list: {
      run: () => {
        for (const row of readLedger(DEFAULT_LEDGER))
          if (!isBlank(row.review_request?.active)) printJson(compactRequest(row));
      },
    },
    add: {
      positionals: [{ name: "urls", nargs: "+" }],
      options: {
        priority: { kind: "int", default: 50 },
        reason: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: (args) => {
        const argv = [
          "add",
          ...args.urls,
          "--priority",
          String(args.priority),
          "--reason",
          args.reason,
        ];
        if (args.execute) argv.push("--execute");
        const code = intakeMain(argv);
        if (code) throw new ExitCode(code);
      },
    },
  },
};

export const main = (argv: string[]): number =>
  runProgram(PROGRAM, argv, [ReviewRequestError, ReviewCtlError]);

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
