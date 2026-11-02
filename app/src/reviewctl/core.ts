import { spawnSync } from "node:child_process";
import { org } from "../lib/org.ts";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  comparePy,
  isInt,
  isObj,
  isOsError,
  isPyInt,
  MINUTE,
  nowMicros,
  type Micros,
  type Obj,
  osErrorMessage,
  parseTime,
  PyJSONDecodeError,
  pyDumps,
  pyEq,
  pyJsonLoads,
  pyStrip,
  ReviewCtlError,
  rstripSlash,
  sha256,
  timestamp,
  truthy,
} from "../lib/py.ts";

export const SCHEMA_VERSION = 1;
export const ROOT = resolve(import.meta.dirname, "../../..");
export const DEFAULT_LEDGER = join(ROOT, "pull_requests.jsonl");
export const THREAD_METHODS = new Set(["gh", "unavailable"]);
// Hash-locked artifacts recorded before thread verification moved to gh.
export const LEGACY_THREAD_METHODS = new Set(["github-connector", "browser"]);
export const ACTIVE_STATUSES = new Set([
  "queued",
  "reviewing",
  "waiting_ci",
  "changes_requested",
  "ready_to_approve",
  "approval_pending_verification",
  "approved",
  "human_required",
  "merged_waiting_release",
  "release_in_progress",
  "post_release_monitoring",
  "recovering",
  "recovered_monitoring",
  "error",
]);
export const POST_MERGE_STATUSES = new Set([
  "merged_waiting_release",
  "release_in_progress",
  "post_release_monitoring",
  "recovering",
  "recovered_monitoring",
  "completed",
]);
export const ALL_STATUSES = new Set([...ACTIVE_STATUSES, "completed", "closed"]);
export const HUMAN_REASON_CODES = new Set([
  "required-human-identity",
  "business-risk-acceptance",
  "unavailable-evidence",
  "ambiguous-intent",
  "incident-coordination",
]);
export const RECOVERY_HUMAN_REASON_CODES = new Set([
  "irreversible-data-loss",
  "legal-privacy-customer-notification",
  "human-only-production-authentication",
  "unresolved-business-tradeoff",
]);
// Review-gate checks stay red until the agent's own commit-bound approval turns them green.
export const PRE_APPROVAL_REVIEW_CHECKS = new Set(["validate-review", "require-approval"]);
export const CURRENT_APPROVAL_VERIFICATIONS = new Set([
  "pending",
  "post-approval-threads-and-live-state",
]);
const PR_URL_RE =
  /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>[1-9][0-9]*)\/?$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
const GH_HTTP_STATUS_RE = /\(HTTP (?<status>[1-5][0-9]{2})\)/;
const GH_FIELDS = [
  "author",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "isDraft",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "latestReviews",
  "reviews",
  "mergeCommit",
  "mergedAt",
  "state",
  "statusCheckRollup",
  "title",
  "updatedAt",
  "url",
].join(",");

export const isSha = (v: unknown): v is string => typeof v === "string" && SHA_RE.test(v);

export function parsePrUrl(url: unknown): [string, number] {
  const m = typeof url === "string" ? PR_URL_RE.exec(url) : null;
  if (!m?.groups) throw new ReviewCtlError(`invalid GitHub pull request URL: ${url}`);
  if (m.groups.owner !== org())
    throw new ReviewCtlError(`this workspace is restricted to ${org()} pull requests`);
  return [`${m.groups.owner}/${m.groups.repo}`, Number(m.groups.number)];
}

export function readLedger(path: string): Obj[] {
  if (!existsSync(path)) return [];
  const rows: Obj[] = [];
  readFileSync(path, "utf8")
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      if (!pyStrip(raw)) return;
      let row: unknown;
      try {
        row = pyJsonLoads(raw);
      } catch (e) {
        if (!(e instanceof PyJSONDecodeError)) throw e;
        throw new ReviewCtlError(`${path}:${i + 1}: invalid JSON: ${e.msg}`);
      }
      validateRow(row, `${path}:${i + 1}`);
      rows.push(row as Obj);
    });
  if (new Set(rows.map((r) => r.url)).size !== rows.length)
    throw new ReviewCtlError(`${path}: duplicate pull request URL`);
  return rows;
}

export function serializeLedger(rows: Obj[]): string {
  return [...rows]
    .sort(
      (a, b) =>
        a.priority - b.priority || comparePy(a.added_at, b.added_at) || comparePy(a.url, b.url),
    )
    .map((row) => pyDumps(row, { sortKeys: true }) + "\n")
    .join("");
}

export function writeLedger(path: string, rows: Obj[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.tmp${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  writeFileSync(temporary, serializeLedger(rows), { mode: 0o600 });
  renameSync(temporary, path);
}

export function validateRow(row: unknown, where = "ledger row"): void {
  if (!isObj(row)) throw new ReviewCtlError(`${where}: row must be an object`);
  const required = [
    "schema_version",
    "repository",
    "pr_number",
    "url",
    "status",
    "priority",
    "added_at",
  ];
  const missing = required.filter((k) => !(k in row)).sort();
  if (missing.length) throw new ReviewCtlError(`${where}: missing fields: ${missing.join(", ")}`);
  const [repository, number] = parsePrUrl(row.url);
  if (row.schema_version !== SCHEMA_VERSION)
    throw new ReviewCtlError(`${where}: unsupported schema_version`);
  if (row.repository !== repository || row.pr_number !== number)
    throw new ReviewCtlError(`${where}: repository or pr_number does not match URL`);
  if (!ALL_STATUSES.has(row.status))
    throw new ReviewCtlError(`${where}: invalid status: ${row.status}`);
  if (!isPyInt(row.priority) || !(+row.priority >= 0 && +row.priority <= 100))
    throw new ReviewCtlError(`${where}: priority must be an integer from 0 to 100`);
  parseTime(row.added_at);
  const request = row.review_request;
  if (request !== undefined && request !== null) {
    if (!isObj(request)) throw new ReviewCtlError(`${where}: review_request must be an object`);
    const missingRequest = [
      "active",
      "reviewer",
      "observed_at",
      "base_sha",
      "head_sha",
      "pr_updated_at",
    ]
      .filter((k) => !(k in request))
      .sort();
    if (missingRequest.length)
      throw new ReviewCtlError(
        `${where}: review_request missing fields: ` + missingRequest.join(", "),
      );
    if (typeof request.active !== "boolean")
      throw new ReviewCtlError(`${where}: review_request.active must be boolean`);
    if (typeof request.reviewer !== "string" || !request.reviewer)
      throw new ReviewCtlError(`${where}: review_request.reviewer must be a non-empty string`);
    for (const field of ["base_sha", "head_sha"])
      if (!isSha(request[field]))
        throw new ReviewCtlError(`${where}: review_request.${field} must be a 40-hex SHA`);
    parseTime(request.observed_at);
    parseTime(request.pr_updated_at);
  }
}

export function newRow(url: string, priority: number, now?: Micros): Obj {
  const [repository, number] = parsePrUrl(url);
  if (!(priority >= 0 && priority <= 100))
    throw new ReviewCtlError("priority must be from 0 to 100");
  return {
    schema_version: SCHEMA_VERSION,
    repository,
    pr_number: number,
    url: rstripSlash(url),
    status: "queued",
    priority,
    added_at: timestamp(now),
    last_synced_at: null,
    live: null,
    evidence_path: null,
    evidence_sha256: null,
    decision: null,
    approval: null,
    last_error: null,
  };
}

export function findRow(rows: Obj[], url: string): Obj {
  const canonical = rstripSlash(url);
  const row = rows.find((r) => r.url === canonical);
  if (!row) throw new ReviewCtlError(`pull request is not in the ledger: ${canonical}`);
  return row;
}

type CheckState = "success" | "pending" | "failure";
export interface Check {
  name: string;
  state: CheckState;
}

const pyStr = (v: unknown): string => (v === true ? "True" : v === false ? "False" : String(v));

export function normalizeChecks(items: Obj[] | null | undefined): Check[] {
  const latest = new Map<string, [string, number, Obj]>();
  (items ?? []).forEach((item, index) => {
    const name = pyStr(item.name || item.context || "unknown");
    const observedAt = pyStr(item.completedAt || item.startedAt || item.createdAt || "");
    const current = latest.get(name);
    if (
      !current ||
      comparePy(observedAt, current[0]) > 0 ||
      (observedAt === current[0] && index > current[1])
    )
      latest.set(name, [observedAt, index, item]);
  });
  const checks: Check[] = [];
  for (const [name, [, , item]] of latest) {
    if (name === "check-approval") continue;
    let state: CheckState;
    if (item.__typename === "CheckRun" || "conclusion" in item) {
      if (item.status !== "COMPLETED") state = "pending";
      else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(item.conclusion)) state = "success";
      else state = "failure";
    } else {
      const value = item.state;
      if (value === "SUCCESS") state = "success";
      else if (value === "PENDING" || value === "EXPECTED" || value === null || value === undefined)
        state = "pending";
      else state = "failure";
    }
    checks.push({ name, state });
  }
  return checks.sort((a, b) => comparePy(a.name, b.name));
}

export function validateLive(row: Obj, live: unknown): asserts live is Obj {
  if (!isObj(live)) throw new ReviewCtlError("live PR state must be an object");
  if (rstripSlash(live.url ?? "") !== row.url)
    throw new ReviewCtlError("live PR URL does not match the ledger");
  for (const field of ["baseRefOid", "headRefOid"])
    if (!SHA_RE.test(live[field] ?? ""))
      throw new ReviewCtlError(`live ${field} is missing or invalid`);
  if (!["OPEN", "CLOSED", "MERGED"].includes(live.state))
    throw new ReviewCtlError("live PR state is missing or invalid");
  if (typeof live.isDraft !== "boolean")
    throw new ReviewCtlError("live draft state is missing or invalid");
  if (!Array.isArray(live.checks)) throw new ReviewCtlError("live checks are missing or invalid");
  for (const check of live.checks)
    if (
      !isObj(check) ||
      typeof check.name !== "string" ||
      !["success", "pending", "failure"].includes(check.state)
    )
      throw new ReviewCtlError("live check entry is invalid");
}

/** Per author, keep the latest decisive review if it still requests changes. */
export function standingChangeRequests(reviews: Obj[]): { login: string; commit: string }[] {
  const latest = new Map<string, Obj>();
  const sorted = reviews
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => comparePy(a.submittedAt || "", b.submittedAt || "") || i - j)
    .map(([r]) => r);
  for (const review of sorted)
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latest.set(review.author?.login || "", review);
  return [...latest.entries()]
    .sort(([a], [b]) => comparePy(a, b))
    .filter(([, review]) => review.state === "CHANGES_REQUESTED")
    .map(([login, review]) => ({ login, commit: review.commit?.oid || "" }));
}

export interface GhResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

export class GhTimeout extends ReviewCtlError {}

/** Raises Node's spawn errors (e.g. ENOENT) so callers treat them as OSError. */
export function runGh(
  args: string[],
  opts: { input?: string; timeoutSec?: number } = {},
): GhResult | "timeout" {
  // Task runners reorder PATH, so launchd pins the token-injecting gh wrapper explicitly.
  const result = spawnSync(process.env.REVIEWCTL_GH || "gh", args, {
    input: opts.input,
    encoding: "utf8",
    timeout: (opts.timeoutSec ?? 60) * 1000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return "timeout";
    throw result.error;
  }
  return {
    returncode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function ghView(url: string, timeoutSec = 60): Obj {
  const result = runGh(["pr", "view", url, "--json", GH_FIELDS], { timeoutSec });
  if (result === "timeout") throw new GhTimeout("gh pr view timed out");
  if (result.returncode)
    throw new ReviewCtlError(
      pyStrip(result.stderr) || pyStrip(result.stdout) || "gh pr view failed",
    );
  const payload = pyJsonLoads(result.stdout);
  payload.checks = normalizeChecks(payload.statusCheckRollup ?? []);
  delete payload.statusCheckRollup;
  payload.changeRequestReviews = standingChangeRequests(payload.reviews ?? []);
  delete payload.reviews;
  return payload;
}

export function ghReviews(url: string): Obj[] {
  const result = runGh(["pr", "view", url, "--json", "reviews"]);
  if (result === "timeout") throw new ReviewCtlError("gh pr view reviews timed out");
  if (result.returncode)
    throw new ReviewCtlError(
      pyStrip(result.stderr) || pyStrip(result.stdout) || "gh pr view reviews failed",
    );
  let reviews: unknown;
  try {
    const parsed = pyJsonLoads(result.stdout);
    if (!isObj(parsed)) throw new TypeError();
    reviews = parsed.reviews;
  } catch {
    throw new ReviewCtlError("GitHub reviews response was not valid JSON");
  }
  if (!Array.isArray(reviews) || reviews.some((r) => !isObj(r)))
    throw new ReviewCtlError("GitHub reviews response is missing or invalid");
  return reviews;
}

export function ghWrite(args: string[], input?: string): GhResult {
  const result = runGh(args, { input });
  if (result === "timeout") throw new ReviewCtlError("GitHub write command timed out");
  return result;
}

/** A definitive GitHub rejection status; ambiguous writes return null. */
export function rejectedWriteStatus(result: GhResult): number | null {
  const message = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const m = GH_HTTP_STATUS_RE.exec(message);
  if (!m?.groups) return null;
  const status = Number(m.groups.status);
  return status >= 400 && status < 500 && status !== 408 ? status : null;
}

export const failureMessage = (result: GhResult, fallback: string): string =>
  pyStrip(result.stderr) || pyStrip(result.stdout) || fallback;

export function ghCommitReview(
  row: Obj,
  commitSha: string,
  event: string,
  body: string,
): [GhResult, Obj | null] {
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES")
    throw new ReviewCtlError(`unsupported review event: ${event}`);
  if (!isSha(commitSha)) throw new ReviewCtlError("review commit SHA is invalid");
  const [repository, number] = parsePrUrl(row.url);
  const payload = pyDumps({ body, commit_id: commitSha, event });
  const result = ghWrite(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/pulls/${number}/reviews`,
      "--header",
      "Accept: application/vnd.github+json",
      "--input",
      "-",
    ],
    payload,
  );
  if (result.returncode) return [result, null];
  let response: unknown;
  try {
    response = pyJsonLoads(result.stdout);
  } catch {
    throw new ReviewCtlError("GitHub review response was not valid JSON");
  }
  const expectedState = event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED";
  if (!isObj(response) || response.commit_id !== commitSha || response.state !== expectedState)
    throw new ReviewCtlError(
      "GitHub review response did not confirm the requested commit and state",
    );
  return [result, response];
}

export function compactReviewText(value: string, limit: number): string {
  const text = pyStrip(value)
    .split(/[\s\u001c-\u001f\u0085]+/)
    .filter(Boolean)
    .join(" ");
  const chars = [...text];
  if (chars.length <= limit) return text;
  return (
    chars
      .slice(0, limit - 1)
      .join("")
      .replace(/[\s\u001c-\u001f\u0085]+$/, "") + "…"
  );
}

export function approvalBody(artifact: Obj, _live: Obj): string {
  if (artifact.deterministic === true) return "LGTM!";
  const notes = artifact.notes;
  if (typeof notes !== "string" || !pyStrip(notes))
    throw new ReviewCtlError(
      "approval evidence needs a concise Japanese notes summary of the change",
    );
  let summary = compactReviewText(notes, 240);
  for (const delimiter of ["。", ". "]) {
    if (summary.includes(delimiter)) {
      summary = summary.split(delimiter)[0].replace(/。+$/, "");
      break;
    }
  }
  const coverage = artifact.coverage;
  const evidence = ((coverage.test_evidence || []) as string[])
    .filter((item) => !item.startsWith("GitHub current-head checks:"))
    .map((item) => compactReviewText(item, 140))
    .slice(0, 2);
  const verification =
    coverage.tests === "not_applicable"
      ? compactReviewText(coverage.tests_not_applicable_reason, 180)
      : evidence.join("、");
  if (!verification)
    throw new ReviewCtlError("approval evidence needs concrete verification details");
  return ["LGTMです。", `- ${summary}`, `- ${verification}`].join("\n");
}

export function ghDismissReview(
  row: Obj,
  reviewId: number,
  commitSha: string,
  message: string,
): [GhResult, Obj | null] {
  if (!isInt(reviewId) || reviewId < 1)
    throw new ReviewCtlError("review ID must be a positive integer");
  if (!isSha(commitSha)) throw new ReviewCtlError("review commit SHA is invalid");
  const [repository, number] = parsePrUrl(row.url);
  const payload = pyDumps({ event: "DISMISS", message });
  const result = ghWrite(
    [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/pulls/${number}/reviews/${reviewId}/dismissals`,
      "--header",
      "Accept: application/vnd.github+json",
      "--input",
      "-",
    ],
    payload,
  );
  if (result.returncode) return [result, null];
  let response: unknown;
  try {
    response = pyJsonLoads(result.stdout);
  } catch {
    throw new ReviewCtlError("GitHub dismissal response was not valid JSON");
  }
  if (
    !isObj(response) ||
    response.id !== reviewId ||
    response.commit_id !== commitSha ||
    response.state !== "DISMISSED" ||
    response.html_url !== `${row.url}#pullrequestreview-${reviewId}` ||
    typeof response.node_id !== "string"
  )
    throw new ReviewCtlError(
      "GitHub dismissal response did not confirm the requested review and commit",
    );
  return [result, response];
}

function within(root: string, path: string): string | null {
  const rel = relative(realpathOr(root), path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
    ? rel || "."
    : null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Path.resolve(): follow symlinks for the existing prefix, keep the rest lexical. */
function pyResolve(path: string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length).replace(/^\//, ""));
    head = dirname(head);
  }
  return join(realpathOr(head), ...tail);
}

export function loadArtifact(row: Obj, root = ROOT): Obj | null {
  const rel = row.evidence_path;
  if (!rel) return null;
  const path = pyResolve(join(root, rel));
  if (within(root, path) === null) throw new ReviewCtlError("evidence_path escapes the workspace");
  let payload: Buffer;
  let artifact: unknown;
  try {
    payload = readFileSync(path);
    artifact = pyJsonLoads(payload.toString("utf8"));
  } catch (e) {
    throw new ReviewCtlError(
      `cannot read evidence artifact ${rel}: ${isOsError(e) ? osErrorMessage(e) : (e as Error).message}`,
    );
  }
  const expected = row.evidence_sha256;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
    throw new ReviewCtlError("recorded evidence SHA-256 is missing or invalid");
  if (sha256(payload) !== expected)
    throw new ReviewCtlError("evidence artifact changed after it was recorded");
  validateArtifact(artifact, row.url, { recorded: true });
  return artifact as Obj;
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && pyStrip(v) !== "";

export function requireStringList(
  value: unknown,
  field: string,
  opts: { allowEmpty?: boolean } = {},
): void {
  if (
    !Array.isArray(value) ||
    (!opts.allowEmpty && (!value.length || value.some((i) => !nonEmptyString(i))))
  )
    throw new ReviewCtlError(`${field} must be a list of non-empty strings`);
  if (opts.allowEmpty && value.some((i) => !nonEmptyString(i)))
    throw new ReviewCtlError(`${field} must contain only non-empty strings`);
}

export function validateDeliveryPlan(delivery: unknown): void {
  if (!isObj(delivery)) throw new ReviewCtlError("delivery must be an object");
  const { release, monitoring, recovery } = delivery;
  if (![release, monitoring, recovery].every(isObj))
    throw new ReviewCtlError("delivery release, monitoring, and recovery must be objects");
  const mode = release.mode;
  if (!["github-actions", "external", "not_applicable"].includes(mode))
    throw new ReviewCtlError(
      "delivery.release.mode must be github-actions, external, or not_applicable",
    );
  if (mode === "not_applicable") {
    if (!nonEmptyString(release.reason))
      throw new ReviewCtlError("not_applicable release requires a reason");
  } else {
    if (!nonEmptyString(release.identifier))
      throw new ReviewCtlError("applicable release requires an identifier");
    if (!nonEmptyString(release.environment))
      throw new ReviewCtlError("applicable release requires an environment");
  }
  const window = monitoring.window_minutes;
  if (!isInt(window) || !(window >= 30 && window <= 10080))
    throw new ReviewCtlError("delivery monitoring window must be 30..10080 minutes");
  const signals = monitoring.signals;
  if (!Array.isArray(signals) || (mode !== "not_applicable" && !signals.length))
    throw new ReviewCtlError("applicable release requires monitoring signals");
  if (mode === "not_applicable" && signals.length)
    throw new ReviewCtlError("not_applicable release cannot declare monitoring signals");
  const names: string[] = [];
  for (const signal of signals) {
    if (!isObj(signal)) throw new ReviewCtlError("each monitoring signal must be an object");
    for (const field of ["name", "source", "healthy_when", "failure_when"])
      if (!nonEmptyString(signal[field]))
        throw new ReviewCtlError(`monitoring signal ${field} is required`);
    names.push(signal.name);
  }
  if (new Set(names).size !== names.length)
    throw new ReviewCtlError("monitoring signal names must be unique");
  const strategy = recovery.preferred_strategy;
  if (
    !["rollback", "feature-flag", "hotfix", "compatibility", "redeploy", "not_applicable"].includes(
      strategy,
    )
  )
    throw new ReviewCtlError("delivery recovery strategy is invalid");
  if (mode === "not_applicable" && strategy !== "not_applicable")
    throw new ReviewCtlError("non-releasing changes require not_applicable recovery");
  if (mode !== "not_applicable" && strategy === "not_applicable")
    throw new ReviewCtlError("applicable release requires a recovery strategy");
  const allowEmpty = strategy === "not_applicable";
  requireStringList(recovery.procedure ?? [], "delivery.recovery.procedure", { allowEmpty });
  requireStringList(recovery.verification ?? [], "delivery.recovery.verification", { allowEmpty });
  if (
    strategy === "not_applicable" &&
    (truthy(recovery.procedure) || truthy(recovery.verification))
  )
    throw new ReviewCtlError("not_applicable recovery must use empty procedure and verification");
  requireStringList(recovery.human_boundaries ?? [], "delivery.recovery.human_boundaries", {
    allowEmpty: true,
  });
  const boundaries: string[] = recovery.human_boundaries ?? [];
  if (new Set(boundaries).size !== boundaries.length)
    throw new ReviewCtlError("delivery recovery human boundaries must be unique");
  const unknown = [...new Set(boundaries)]
    .filter((b) => !RECOVERY_HUMAN_REASON_CODES.has(b))
    .sort(comparePy);
  if (unknown.length)
    throw new ReviewCtlError(
      "delivery recovery human boundaries contain unsupported reason codes: " + unknown.join(", "),
    );
  if (strategy === "not_applicable" && boundaries.length)
    throw new ReviewCtlError("not_applicable recovery cannot declare human-only boundaries");
}

export const deliveryPlanDigest = (delivery: Obj): string =>
  sha256(pyDumps(delivery, { sortKeys: true, compact: true }));

export function validateArtifact(
  artifact: unknown,
  expectedUrl?: string | null,
  opts: { recorded?: boolean } = {},
): asserts artifact is Obj {
  if (!isObj(artifact)) throw new ReviewCtlError("evidence artifact must be an object");
  const required = [
    "schema_version",
    "url",
    "base_sha",
    "head_sha",
    "reviewed_at",
    "verdict",
    "coverage",
    "review_threads",
    "findings",
    "human_dispatch",
    "delivery",
  ];
  const missing = required.filter((k) => !(k in artifact)).sort();
  if (missing.length) throw new ReviewCtlError(`evidence artifact missing: ${missing.join(", ")}`);
  parsePrUrl(artifact.url);
  if (expectedUrl && rstripSlash(artifact.url) !== rstripSlash(expectedUrl))
    throw new ReviewCtlError("evidence artifact URL does not match ledger URL");
  if (artifact.schema_version !== SCHEMA_VERSION)
    throw new ReviewCtlError("unsupported evidence schema_version");
  if (!isSha(artifact.base_sha) || !isSha(artifact.head_sha))
    throw new ReviewCtlError("base_sha and head_sha must be 40 lowercase hex characters");
  parseTime(artifact.reviewed_at);
  const verdict = artifact.verdict;
  if (!["approve", "changes_requested", "human_required"].includes(verdict))
    throw new ReviewCtlError(`invalid evidence verdict: ${verdict}`);
  const coverage = artifact.coverage;
  if (!isObj(coverage)) throw new ReviewCtlError("coverage must be an object");
  for (const key of ["diff", "security"])
    if (!["pass", "incomplete"].includes(coverage[key]))
      throw new ReviewCtlError(`coverage.${key} must be pass or incomplete`);
  const tests = coverage.tests;
  if (!["pass", "not_applicable", "incomplete"].includes(tests))
    throw new ReviewCtlError("coverage.tests must be pass, not_applicable, or incomplete");
  const testEvidence = coverage.test_evidence;
  if (
    tests === "pass" &&
    (!Array.isArray(testEvidence) ||
      !testEvidence.length ||
      testEvidence.some((i) => !nonEmptyString(i)))
  )
    throw new ReviewCtlError("passing tests require non-empty string test_evidence");
  if (tests === "not_applicable" && !nonEmptyString(coverage.tests_not_applicable_reason))
    throw new ReviewCtlError("not_applicable tests require a reason");
  const threads = artifact.review_threads;
  if (!isObj(threads)) throw new ReviewCtlError("review_threads must be an object");
  const unresolved = threads.unresolved;
  if (unresolved !== undefined && unresolved !== null && (!isInt(unresolved) || unresolved < 0))
    throw new ReviewCtlError("review_threads.unresolved must be null or a non-negative integer");
  const methods = new Set([...THREAD_METHODS, ...(opts.recorded ? LEGACY_THREAD_METHODS : [])]);
  if (!methods.has(threads.method))
    throw new ReviewCtlError("review thread method must be gh or unavailable");
  if (threads.method === "unavailable") {
    if (
      (unresolved ?? null) !== null ||
      (threads.verified_at ?? null) !== null ||
      (threads.pr_updated_at ?? null) !== null
    )
      throw new ReviewCtlError("unavailable review threads must use null values");
  } else {
    parseTime(threads.verified_at);
    parseTime(threads.pr_updated_at);
  }
  if (threads.method === "unavailable" && verdict !== "human_required")
    throw new ReviewCtlError("unavailable review threads require human_required");
  if (!Array.isArray(artifact.findings)) throw new ReviewCtlError("findings must be a list");
  for (const finding of artifact.findings) {
    if (!isObj(finding)) throw new ReviewCtlError("each finding must be an object");
    if (
      !["critical", "high", "medium", "low"].includes(String(finding.severity ?? "").toLowerCase())
    )
      throw new ReviewCtlError("finding severity must be Critical, High, Medium, or Low");
    if (!["open", "resolved"].includes(finding.status))
      throw new ReviewCtlError("finding status must be open or resolved");
    if (!nonEmptyString(finding.summary))
      throw new ReviewCtlError("finding summary must be a non-empty string");
  }
  const dispatch = artifact.human_dispatch;
  if (!isObj(dispatch)) throw new ReviewCtlError("human_dispatch must be an object");
  const requiredHuman = dispatch.required;
  if (typeof requiredHuman !== "boolean")
    throw new ReviewCtlError("human_dispatch.required must be boolean");
  if (verdict === "human_required") {
    if (!requiredHuman || !HUMAN_REASON_CODES.has(dispatch.reason_code))
      throw new ReviewCtlError("human_required needs an allowed human reason code");
    if (!nonEmptyString(dispatch.detail))
      throw new ReviewCtlError("human_required needs dispatch detail");
  } else if (requiredHuman)
    throw new ReviewCtlError("human_dispatch.required conflicts with verdict");
  if (verdict === "approve") {
    for (const key of ["diff", "security"])
      if (coverage[key] !== "pass")
        throw new ReviewCtlError(`approve requires coverage.${key}=pass`);
    if (tests === "incomplete")
      throw new ReviewCtlError("approve requires completed test coverage");
    if (
      !pyEq(threads.unresolved, 0) ||
      threads.method === "unavailable" ||
      (threads.verified_at ?? null) === null ||
      (threads.pr_updated_at ?? null) === null
    )
      throw new ReviewCtlError("approve requires verified zero review threads");
  }
  validateDeliveryPlan(artifact.delivery);
}

export const blockingFindings = (artifact: Obj): Obj[] =>
  artifact.findings.filter(
    (f: Obj) =>
      f.status === "open" && ["critical", "high", "medium"].includes(f.severity.toLowerCase()),
  );

export function deriveDeliveryStatus(receipts: unknown): string {
  if (!Array.isArray(receipts) || receipts.some((r) => !isObj(r)))
    throw new ReviewCtlError("delivery receipts ledger field is invalid");
  const keyed = receipts.map((r, i) => [parseTime(r.observed_at), i, r] as const);
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let status = "merged_waiting_release";
  for (const [, , receipt] of keyed) {
    const type = receipt.type;
    if (type === "release") {
      const next = (
        {
          started: "release_in_progress",
          succeeded: "post_release_monitoring",
          failed: "recovering",
        } as Obj
      )[receipt.status];
      if (next === undefined) throw new Error(`KeyError: '${receipt.status}'`);
      status = next;
    } else if (type === "observation") {
      if (receipt.status === "degraded") status = "recovering";
      else if (receipt.phase === "post_release") status = "post_release_monitoring";
      else status = "recovered_monitoring";
    } else if (type === "incident") status = "recovering";
    else if (type === "recovery")
      status = receipt.status === "succeeded" ? "recovered_monitoring" : "recovering";
    else if (type !== "postmortem")
      throw new ReviewCtlError(`unsupported delivery receipt type: ${type ?? "None"}`);
  }
  return status;
}

export function changeRequestActive(row: Obj, live: Obj): boolean {
  if (live.reviewDecision !== "CHANGES_REQUESTED") return false;
  // An old-head change request is superseded by approving the current head; evidence still forces re-review.
  const cr = row.change_request || {};
  if (
    cr.verification !== "confirmed" ||
    cr.write_outcome !== "confirmed" ||
    pyEq(cr.head_sha, live.headRefOid)
  )
    return true;
  const blocking = live.changeRequestReviews;
  if (blocking === null || blocking === undefined) return true;
  return !blocking.length || blocking.some((r: Obj) => !pyEq(r.commit, cr.head_sha));
}

export function hasConfirmedApproval(row: Obj, live: Obj): boolean {
  const approval = row.approval || {};
  return (
    pyEq(approval.base_sha, live.baseRefOid) &&
    pyEq(approval.head_sha, live.headRefOid) &&
    approval.verification === "post-approval-threads-and-live-state" &&
    pyEq(approval.verified_evidence_sha256, row.evidence_sha256)
  );
}

export type Action =
  | "review"
  | "terminal"
  | "changes_requested"
  | "human_required"
  | "wait_ci"
  | "approve";

export function evaluate(
  row: Obj,
  opts: { root?: string; now?: Micros; maxAgeMinutes?: number } = {},
): [Action, string[]] {
  const root = opts.root ?? ROOT;
  const current = opts.now ?? nowMicros();
  const live = row.live;
  if (!truthy(live)) return ["review", ["live PR state has not been synced"]];
  const state = live.state;
  if (state === "MERGED") return ["terminal", ["pull request is merged"]];
  if (state !== "OPEN") return ["terminal", [`pull request state is ${state || "unknown"}`]];
  const reasons: string[] = [];
  if (truthy(live.isDraft)) reasons.push("pull request is draft");
  if (live.mergeable !== "MERGEABLE")
    reasons.push(`pull request mergeability is ${live.mergeable || "unknown"}`);
  if (!["CLEAN", "BLOCKED", "HAS_HOOKS"].includes(live.mergeStateStatus))
    reasons.push(`pull request merge state is ${live.mergeStateStatus || "unknown"}`);
  const checks: Check[] = live.checks || [];
  const approval = row.approval || {};
  const currentApproval =
    pyEq(approval.base_sha, live.baseRefOid) &&
    pyEq(approval.head_sha, live.headRefOid) &&
    CURRENT_APPROVAL_VERIFICATIONS.has(approval.verification);
  const confirmedApproval = hasConfirmedApproval(row, live);
  // Confirmed evidence stays valid while refs, CI and review state are unchanged; it never expires by age.
  const ignored = currentApproval ? new Set<string>() : PRE_APPROVAL_REVIEW_CHECKS;
  const failed = checks
    .filter((c) => c.state === "failure" && !ignored.has(c.name))
    .map((c) => c.name);
  const pending = checks
    .filter((c) => c.state === "pending" && !ignored.has(c.name))
    .map((c) => c.name);
  let failedReason: string | null = null;
  const pendingReason = pending.length ? "pending checks: " + pending.join(", ") : null;
  if (failed.length) {
    failedReason = "failed checks: " + failed.join(", ");
    reasons.push(failedReason);
  }
  if (changeRequestActive(row, live)) reasons.push("an active review requests changes");
  const artifact = loadArtifact(row, root);
  if (artifact === null) return ["review", [...reasons, "review evidence is missing"]];
  const integrity: string[] = [];
  if (!pyEq(artifact.base_sha, live.baseRefOid)) integrity.push("base SHA changed after review");
  if (!pyEq(artifact.head_sha, live.headRefOid)) integrity.push("head SHA changed after review");
  const ageLimit = (opts.maxAgeMinutes ?? 5) * MINUTE;
  const futureLimit = current + MINUTE;
  const reviewedAt = parseTime(artifact.reviewed_at);
  if (reviewedAt > futureLimit) integrity.push("review evidence timestamp is in the future");
  else if (
    !confirmedApproval &&
    artifact.verdict !== "changes_requested" &&
    !failed.length &&
    !pending.length &&
    current - reviewedAt > ageLimit
  )
    integrity.push("review evidence is stale");
  if (integrity.length) return ["review", [...reasons, ...integrity]];
  if (artifact.verdict === "changes_requested")
    return ["changes_requested", reasons.length ? reasons : ["review evidence requests changes"]];

  const threads = artifact.review_threads;
  const threadReasons: string[] = [];
  if (threads.method !== "unavailable") {
    const verifiedAt = parseTime(threads.verified_at);
    if (verifiedAt > futureLimit)
      threadReasons.push("review-thread verification timestamp is in the future");
    else if (
      !confirmedApproval &&
      !failed.length &&
      !pending.length &&
      current - verifiedAt > MINUTE
    )
      threadReasons.push("review-thread verification is stale");
    if (!pyEq(threads.pr_updated_at, live.updatedAt))
      threadReasons.push("PR activity changed after review-thread verification");
    if (truthy(threads.unresolved))
      threadReasons.push(`${threads.unresolved} unresolved review thread(s)`);
  }

  const blocking = blockingFindings(artifact);
  const onlyCi = (list: string[]) => list.every((r) => r === failedReason || r === pendingReason);
  if (artifact.verdict === "human_required") {
    const dispatch = artifact.human_dispatch;
    const reasonCode = dispatch.reason_code;
    if (reasonCode === "incident-coordination")
      return ["human_required", [reasonCode, dispatch.detail]];
    if (changeRequestActive(row, live) || blocking.length) {
      const blockers = [...reasons, ...threadReasons];
      if (blocking.length) blockers.push(`${blocking.length} unresolved blocking finding(s)`);
      return ["changes_requested", blockers];
    }
    if (failed.length) {
      const blockers = [...reasons, ...threadReasons];
      if (pendingReason) blockers.push(pendingReason);
      return [onlyCi(blockers) ? "wait_ci" : "review", blockers];
    }
    if (pending.length) return ["wait_ci", [pendingReason!]];
    const incomplete = ["diff", "security", "tests"].filter(
      (f) => artifact.coverage[f] === "incomplete",
    );
    if (incomplete.length && !["unavailable-evidence", "ambiguous-intent"].includes(reasonCode))
      threadReasons.push("agent review is incomplete: " + incomplete.join(", "));
    if (reasons.length || threadReasons.length) return ["review", [...reasons, ...threadReasons]];
    return ["human_required", [reasonCode, dispatch.detail]];
  }

  reasons.push(...threadReasons);
  if (blocking.length) reasons.push(`${blocking.length} unresolved blocking finding(s)`);
  if (changeRequestActive(row, live) || blocking.length) return ["changes_requested", reasons];
  if (failed.length) {
    if (pendingReason) reasons.push(pendingReason);
    return [onlyCi(reasons) ? "wait_ci" : "review", reasons];
  }
  if (reasons.length) return ["review", reasons];
  if (pending.length) return ["wait_ci", [pendingReason!]];
  return ["approve", []];
}

export const STATUS_FOR_ACTION: Record<string, string> = {
  approve: "ready_to_approve",
  changes_requested: "changes_requested",
  human_required: "human_required",
  wait_ci: "waiting_ci",
  review: "queued",
  wait: "queued",
};

const DECIDED = new Set(["approved", "approval_pending_verification", "human_required"]);
const namesIn = (checks: Check[] | undefined, state: CheckState) =>
  new Set((checks ?? []).filter((c) => c.state === state).map((c) => c.name));
const newNames = (now: Set<string>, before: Set<string>) =>
  [...now].filter((n) => !before.has(n)).sort(comparePy);

export type Event = Obj & { event: string };

export function applyLive(
  row: Obj,
  live: unknown,
  opts: { now?: Micros; root?: string } = {},
): Event[] {
  validateLive(row, live);
  const previous: Obj = row.live || {};
  const previousStatus = row.status;
  const previousDecision = row.decision?.action ?? null;
  const events: Event[] = [];
  let invalidated = false;
  const invalidate = (event: Event) => {
    row.evidence_path = null;
    row.evidence_sha256 = null;
    row.decision = null;
    row.status = "queued";
    events.push(event);
    invalidated = true;
  };
  const baseChanged =
    truthy(previous.baseRefOid) &&
    truthy(live.baseRefOid) &&
    previous.baseRefOid !== live.baseRefOid;
  const headChanged =
    truthy(previous.headRefOid) &&
    truthy(live.headRefOid) &&
    previous.headRefOid !== live.headRefOid;
  if (baseChanged) invalidate({ event: "BASE_CHANGED", url: row.url, base_sha: live.baseRefOid });
  if (headChanged) invalidate({ event: "HEAD_CHANGED", url: row.url, head_sha: live.headRefOid });
  // Back to draft means the author is still working; drop the verdict so the ready PR is reviewed afresh.
  if (previous.isDraft === false && live.isDraft === true && live.state === "OPEN") {
    if (!invalidated) invalidate({ event: "DRAFTED", url: row.url });
    else events.push({ event: "DRAFTED", url: row.url });
    if (row.approval) row.approval.verification = "pending";
  }
  if (
    truthy(previous) &&
    DECIDED.has(previousStatus) &&
    !pyEq(previous.updatedAt, live.updatedAt) &&
    !baseChanged &&
    !headChanged
  )
    invalidate({ event: "PR_UPDATED", url: row.url });

  const newFailures = newNames(
    namesIn(live.checks, "failure"),
    namesIn(previous.checks, "failure"),
  );
  if (newFailures.length) {
    if (DECIDED.has(previousStatus) && !invalidated)
      invalidate({ event: "CI_INVALIDATED_DECISION", url: row.url });
    events.push({ event: "CI_FAILED", url: row.url, checks: newFailures });
  }
  const newPending = newNames(namesIn(live.checks, "pending"), namesIn(previous.checks, "pending"));
  if (newPending.length && DECIDED.has(previousStatus) && !invalidated)
    invalidate({ event: "CI_PENDING", url: row.url, checks: newPending });

  if (
    live.reviewDecision === "CHANGES_REQUESTED" &&
    previous.reviewDecision !== "CHANGES_REQUESTED"
  ) {
    if (DECIDED.has(previousStatus) && !invalidated)
      invalidate({ event: "REVIEW_INVALIDATED_DECISION", url: row.url });
    events.push({ event: "CHANGES_REQUESTED", url: row.url });
  }

  row.live = live;
  row.last_synced_at = timestamp(opts.now);
  row.last_error = null;
  if (live.state === "MERGED") {
    if (!("delivery" in row)) row.delivery = {};
    const delivery = row.delivery;
    const receipts = delivery.receipts ?? [];
    if (row.status !== "completed")
      row.status = truthy(receipts)
        ? deriveDeliveryStatus(receipts)
        : POST_MERGE_STATUSES.has(row.status)
          ? row.status
          : "merged_waiting_release";
    if (previous.state !== "MERGED") {
      delivery.merge = {
        commit_sha: live.mergeCommit?.oid ?? null,
        merged_at: live.mergedAt ?? null,
        detected_at: timestamp(opts.now),
      };
      events.push({ event: "MERGED", url: row.url, merge_sha: live.mergeCommit?.oid ?? null });
    }
  } else if (live.state !== "OPEN") {
    row.status = "closed";
    events.push({ event: "CLOSED", url: row.url });
  } else if (!DECIDED.has(row.status)) {
    const [action, reasons] = evaluate(row, { root: opts.root, now: opts.now });
    if (action === "approve" && hasConfirmedApproval(row, live)) {
      row.decision = { action: "approved", reasons: [], at: timestamp(opts.now) };
      row.status = "approved";
    } else {
      row.decision = { action, reasons, at: timestamp(opts.now) };
      row.status = STATUS_FOR_ACTION[action] ?? row.status;
    }
    if (action === "approve" && !hasConfirmedApproval(row, live) && previousDecision !== "approve")
      events.push({ event: "APPROVAL_CANDIDATE", url: row.url });
  }
  return events;
}

export type Viewer = (url: string) => Obj;

const syncError = (e: unknown): string | null => {
  if (e instanceof ReviewCtlError) return e.message;
  if (e instanceof SyntaxError) return e.message;
  if (isOsError(e)) return osErrorMessage(e);
  return null;
};

// Credential or network outages are workspace-wide, not per-PR review work.
const UNAVAILABLE_RE =
  /ghtkn|error connecting to api\.github\.com|HTTP 401|TLS handshake timeout|unexpected EOF|connection reset|operation timed out|refresh token|Bad credentials|SAML enforcement|token's access was revoked|gh auth login|GH_TOKEN environment variable|ip-guard:|ipg_check|command not found/;

export interface Outage {
  error: string;
  last_probe_ms: number;
}

export const OUTAGE_PROBE_MS = 10 * 60 * 1000;

/** Monitor-only outage gate: one SYNC_UNAVAILABLE per distinct outage, GitHub probes throttled while it lasts. */
export function monitorWithOutage(
  outage: Outage | null,
  nowMs: number,
  sync: () => Event[],
): { events: Event[]; outage: Outage | null } {
  if (outage && nowMs - outage.last_probe_ms < OUTAGE_PROBE_MS) return { events: [], outage };
  const events = sync();
  const down = events.find((e) => e.event === "SYNC_UNAVAILABLE");
  if (!down) return { events, outage: null };
  const next = { error: String(down.error), last_probe_ms: nowMs };
  return { events: outage?.error === next.error ? events.filter((e) => e !== down) : events, outage: next };
}

export function syncRows(
  rows: Obj[],
  selectedUrl: string | null,
  viewer: Viewer = (u) => ghView(u),
  opts: { now?: Micros; root?: string } = {},
): Event[] {
  const events: Event[] = [];
  const targets = selectedUrl
    ? [findRow(rows, selectedUrl)]
    : rows.filter((r) => ACTIVE_STATUSES.has(r.status) && (r.status !== "error" || UNAVAILABLE_RE.test(r.last_error ?? ""))); // PR-specific errors resume only via --url
  let stalled = 0;
  for (const [i, row] of targets.entries()) {
    if (stalled >= 2) {
      events.push({ event: "SYNC_ABORTED", reason: "GitHub stalled", skipped: targets.length - i });
      break;
    }
    try {
      let live: Obj;
      try {
        live = viewer(row.url);
      } catch (e) {
        if (!(e instanceof GhTimeout)) throw e;
        live = viewer(row.url);
      }
      stalled = 0;
      events.push(...applyLive(row, live, opts));
    } catch (e) {
      // Transient stall: keep the last known status; gate/approve re-fetch live state anyway.
      if (e instanceof GhTimeout) {
        stalled++;
        row.last_error = e.message;
        events.push({ event: "SYNC_DEFERRED", url: row.url, error: e.message });
        continue;
      }
      const message = syncError(e);
      if (message === null) throw e;
      if (UNAVAILABLE_RE.test(message)) {
        events.push({ event: "SYNC_UNAVAILABLE", error: message, skipped: targets.length - i });
        break;
      }
      const repeated = row.status === "error" && row.last_error === message;
      row.last_error = message;
      row.status = "error";
      if (!repeated) events.push({ event: "SYNC_FAILED", url: row.url, error: message });
      events.push({ event: "SYNC_HALTED", url: row.url, skipped: targets.length - i - 1 });
      break;
    }
  }
  return events;
}

export function resolveArtifactPath(raw: string, root = ROOT): [string, string] {
  const resolved = pyResolve(isAbsolute(raw) ? raw : join(root, raw));
  const rel = within(root, resolved);
  if (rel === null) throw new ReviewCtlError("evidence artifact must be inside the workspace");
  return [resolved, rel];
}

export const printJson = (value: unknown): void => {
  process.stdout.write(pyDumps(value, { sortKeys: true }) + "\n");
};
