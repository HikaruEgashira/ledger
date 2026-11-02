#!/usr/bin/env bun
// Record and close merge-to-release delivery lifecycle receipts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Program, runProgram } from "./lib/cli.ts";
import {
  exec,
  ExitCode,
  isObj,
  isInt,
  MINUTE,
  type Micros,
  nowMicros,
  type Obj,
  parseTime,
  ReviewCtlError,
  rstripSlash,
  sha256,
  timestamp,
  withLedgerLock,
  stableStringify,
} from "./lib/util.ts";
import {
  DEFAULT_LEDGER,
  deliveryPlanDigest,
  deriveDeliveryStatus,
  findRow,
  isSha,
  POST_MERGE_STATUSES,
  printJson,
  resolveReal,
  readLedger,
  RECOVERY_HUMAN_REASON_CODES,
  rejectedWriteStatus,
  requireStringList,
  resolveArtifactPath,
  ROOT,
  runGh,
  SCHEMA_VERSION,
  validateDeliveryPlan,
  within,
  writeLedger,
  ghWrite,
} from "./reviewctl/core.ts";

export interface Args {
  ledger: string;
  auto?: boolean;
  url: string;
  correction: string;
  receipt: string;
  reviewer: string;
  reason_code: string;
  detail: string;
  dispatch_sha256: string;
  evidence: string;
  execute?: boolean;
}

const RECEIPT_TYPES = new Set(["release", "observation", "incident", "recovery", "postmortem"]);
const RECOVERY_STRATEGIES = new Set(["rollback", "feature-flag", "hotfix", "compatibility", "redeploy"]);
const POST_MERGE_DISPATCH_STATUSES = new Set([...POST_MERGE_STATUSES].filter((s) => s !== "completed"));
const ADVERSE = (r: Obj) =>
  (r.type === "release" && r.status === "failed") ||
  (r.type === "observation" && r.status === "degraded") ||
  r.type === "incident";

let root = ROOT;
let defaultLedger = DEFAULT_LEDGER;
/** Test hook: relocate the workspace root (artifacts, repositories, default ledger). */
export function setRoot(path: string): void {
  root = path;
  defaultLedger = join(path, "pull_requests.jsonl");
}

const fail = (message: string): never => {
  throw new ReviewCtlError(message);
};
const future = (t: Micros) => t > nowMicros() + MINUTE;
const time = (value: unknown): Micros => parseTime(value);

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value as string;
}

function stringList(value: unknown, field: string): string[] {
  requireStringList(value, field);
  return value as string[];
}

function mergeInfo(row: Obj): [string, Micros] {
  const merge = (row.delivery || {}).merge || {};
  if (!isSha(merge.commit_sha)) fail("a verified merge commit is required");
  const mergedAt = time(merge.merged_at);
  if (future(mergedAt)) fail("merge timestamp is in the future");
  return [merge.commit_sha, mergedAt];
}

function approvedPlan(row: Obj): Obj {
  const approval = row.approval;
  if (!isObj(approval)) fail("a frozen approval delivery plan is required");
  const plan = approval.delivery_plan;
  if (!isObj(plan) || typeof approval.delivery_plan_sha256 !== "string")
    fail("the frozen approval delivery plan is incomplete");
  if (!isSha(approval.base_sha) || !isSha(approval.head_sha)) fail("the frozen approval refs are invalid");
  validateDeliveryPlan(plan);
  if (deliveryPlanDigest(plan) !== approval.delivery_plan_sha256)
    fail("the frozen approval delivery plan was modified");
  return plan;
}

function readBound(entry: Obj, kind: string): unknown {
  const rel = entry.path;
  if (typeof rel !== "string" || typeof entry.sha256 !== "string") fail(`${kind} entry is incomplete`);
  const path = resolveReal(isAbsolute(rel) ? rel : join(root, rel));
  if (within(root, path) === null) fail(`${kind} path escapes workspace`);
  let payload: Buffer;
  let value: unknown;
  try {
    payload = readFileSync(path);
    value = JSON.parse(payload.toString("utf8"));
  } catch (e) {
    return fail(`cannot read ${kind} ${rel}: ${(e as Error).message}`);
  }
  if (sha256(payload) !== entry.sha256) fail(`${kind} changed: ${rel}`);
  return value;
}

function validatePlanCorrection(correction: unknown, row: Obj, previous: Obj): Obj {
  if (!isObj(correction)) fail("delivery plan correction must be an object");
  const c = correction as Obj;
  const required = [
    "schema_version", "url", "type", "observed_at", "merge_sha", "approval_base_sha",
    "approval_head_sha", "previous_delivery_plan_sha256", "reason_code", "delivery_plan", "evidence",
  ];
  const missing = required.filter((k) => !(k in c)).sort();
  if (missing.length) fail("delivery plan correction missing: " + missing.join(", "));
  if (c.schema_version !== SCHEMA_VERSION) fail("unsupported delivery plan correction schema_version");
  if (rstripSlash(String(c.url)) !== row.url) fail("delivery plan correction URL does not match the ledger");
  if (c.type !== "delivery_plan_correction") fail("invalid delivery plan correction type");
  const observed = time(c.observed_at);
  const [mergeSha, mergedAt] = mergeInfo(row);
  if (future(observed)) fail("delivery plan correction timestamp is in the future");
  if (observed < mergedAt) fail("delivery plan correction predates the merge");
  if (c.merge_sha !== mergeSha) fail("delivery plan correction merge SHA does not match");
  const approval = row.approval || {};
  if (c.approval_base_sha !== approval.base_sha || c.approval_head_sha !== approval.head_sha)
    fail("delivery plan correction approval refs do not match");
  const previousDigest = deliveryPlanDigest(previous);
  if (c.previous_delivery_plan_sha256 !== previousDigest)
    fail("delivery plan correction does not match the frozen plan");
  if (c.reason_code !== "incorrect-release-path") fail("unsupported delivery plan correction reason");
  stringList(c.evidence, "delivery plan correction evidence");
  const effective = c.delivery_plan;
  validateDeliveryPlan(effective);
  if (deliveryPlanDigest(effective) === previousDigest) fail("delivery plan correction does not change the plan");
  if (effective.release.environment !== previous.release.environment)
    fail("delivery plan correction cannot change the release environment");
  if (stableStringify(effective.monitoring) !== stableStringify(previous.monitoring))
    fail("delivery plan correction cannot change monitoring requirements");
  for (const field of ["preferred_strategy", "human_boundaries"])
    if (JSON.stringify(effective.recovery[field]) !== JSON.stringify(previous.recovery[field]))
      fail(`delivery plan correction cannot change recovery ${field}`);
  return effective;
}

function plan(row: Obj): Obj {
  const previous = approvedPlan(row);
  const entry = (row.delivery || {}).plan_correction;
  if (entry === undefined || entry === null) return previous;
  if (!isObj(entry)) fail("delivery plan correction entry is invalid");
  const effective = validatePlanCorrection(readBound(entry, "delivery plan correction"), row, previous);
  if (
    entry.previous_delivery_plan_sha256 !== deliveryPlanDigest(previous) ||
    entry.effective_delivery_plan_sha256 !== deliveryPlanDigest(effective)
  )
    fail("delivery plan correction ledger binding is invalid");
  return effective;
}

function validateCommon(receipt: unknown, url: string, mergeSha: string, mergedAt: Micros): [string, Micros] {
  if (!isObj(receipt)) fail("delivery receipt must be an object");
  const r = receipt as Obj;
  const missing = ["schema_version", "url", "type", "observed_at", "merge_sha"].filter((k) => !(k in r)).sort();
  if (missing.length) fail("delivery receipt missing: " + missing.join(", "));
  if (r.schema_version !== SCHEMA_VERSION) fail("unsupported delivery receipt schema_version");
  if (rstripSlash(String(r.url)) !== url) fail("delivery receipt URL does not match the ledger");
  if (!RECEIPT_TYPES.has(r.type)) fail("invalid delivery receipt type");
  const observed = time(r.observed_at);
  if (future(observed)) fail("delivery receipt timestamp is in the future");
  if (observed < mergedAt) fail("delivery receipt predates the merge");
  if (r.merge_sha !== mergeSha) fail("delivery receipt merge SHA does not match");
  return [r.type, observed];
}

function repositoryPath(row: Obj): string {
  let path = join(root, "repositories", row.repository);
  if (!existsSync(join(path, ".git"))) path = join(homedir(), "ghq", "github.com", row.repository);
  if (!existsSync(join(path, ".git")))
    fail(`local repository is unavailable: ${path}; create an authenticated checkout with standard Git tooling`);
  return path;
}

function git(args: string[], timeoutSec: number) {
  const r = exec(["git", ...args], { timeoutMs: timeoutSec * 1000 });
  if (r.timedOut) return "timeout" as const;
  return { returncode: r.code, stdout: r.stdout, stderr: r.stderr };
}

function verifyReleaseAncestry(row: Obj, mergeSha: string, releaseSha: string): void {
  const r = git(["-C", repositoryPath(row), "merge-base", "--is-ancestor", mergeSha, releaseSha], 30);
  if (r === "timeout") return fail("release ancestry verification timed out");
  if (r.returncode === 1) fail("release commit does not contain the reviewed merge commit");
  if (r.returncode) {
    const detail = r.stderr.trim() || r.stdout.trim();
    fail("release ancestry could not be verified from the local repository" + (detail ? `: ${detail}` : ""));
  }
}

function ghJson(args: string[], what: string, failure: (r: { stderr: string; stdout: string }) => string): unknown {
  const r = runGh(args);
  if (r === "timeout") return fail(`${what} timed out`);
  if (r.returncode) fail(failure(r));
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fail(`${what === "GitHub Actions run verification" ? "GitHub Actions run response" : "GitHub Actions run list"} was not valid JSON`);
  }
}

function githubRun(row: Obj, runId: string, attempt: number): Obj {
  if (!/^[1-9][0-9]*$/.test(runId)) fail("GitHub Actions release_id must be the numeric workflow run ID");
  const payload = ghJson(
    ["run", "view", runId, "--attempt", String(attempt), "--repo", row.repository, "--json",
      "attempt,conclusion,databaseId,headSha,status,url,workflowName"],
    "GitHub Actions run verification",
    (r) => {
      const detail = r.stderr.trim() || r.stdout.trim();
      return "GitHub Actions run verification failed" + (detail ? `: ${detail}` : "");
    },
  );
  if (!isObj(payload)) fail("GitHub Actions run response was invalid");
  return payload as Obj;
}

function validateRelease(r: Obj, p: Obj, row: Obj, mergeSha: string): void {
  if (p.release.mode === "not_applicable") fail("a not_applicable delivery plan cannot have release receipts");
  const status = r.status;
  if (!["started", "succeeded", "failed"].includes(status)) fail("release status must be started, succeeded, or failed");
  const releaseId = nonempty(r.release_id, "release_id");
  const identifier = nonempty(r.release_identifier, "release_identifier");
  if (identifier !== p.release.identifier) fail("release identifier does not match the frozen delivery plan");
  if (nonempty(r.environment, "environment") !== p.release.environment)
    fail("release environment does not match the frozen delivery plan");
  if (!isSha(r.commit_sha)) fail("release commit_sha must be a 40-hex SHA");
  stringList(r.evidence, "release evidence");
  const releaseUrl = nonempty(r.release_url, "release_url");
  if (p.release.mode === "github-actions") {
    const attempt = r.release_attempt;
    if (!isInt(attempt) || typeof attempt === "boolean" || attempt < 1)
      fail("GitHub Actions release_attempt must be a positive integer");
    const run = githubRun(row, releaseId, attempt);
    if (String(run.databaseId) !== releaseId) fail("GitHub Actions run ID does not match");
    if (run.attempt !== attempt) fail("GitHub Actions run attempt does not match");
    if (run.workflowName !== p.release.identifier)
      fail("GitHub Actions workflow does not match the frozen release identifier");
    if (run.headSha !== r.commit_sha) fail("release commit does not match the GitHub Actions run head SHA");
    if (run.url !== releaseUrl) fail("release URL does not match the GitHub Actions run");
    if (status === "succeeded" && (run.status !== "completed" || run.conclusion !== "success"))
      fail("GitHub Actions run is not completed successfully");
    if (status === "failed" && (run.status !== "completed" || run.conclusion == null || run.conclusion === "success"))
      fail("GitHub Actions run does not confirm a failed release");
  }
  if (status === "succeeded") verifyReleaseAncestry(row, mergeSha, r.commit_sha);
}

function validateObservation(r: Obj, p: Obj, observed: Micros, mergedAt: Micros): void {
  if (p.release.mode === "not_applicable") fail("a not_applicable delivery plan cannot have observation receipts");
  if (!["post_release", "post_recovery"].includes(r.phase)) fail("observation phase must be post_release or post_recovery");
  if (!["healthy", "degraded"].includes(r.status)) fail("observation status must be healthy or degraded");
  const started = time(r.started_at);
  const ended = time(r.ended_at);
  if (started < mergedAt) fail("observation started before the merge");
  if (ended < started) fail("observation ended_at precedes started_at");
  if (future(ended)) fail("observation ended_at is in the future");
  if (observed < ended) fail("observation observed_at precedes ended_at");
  if (r.log_source !== "siem") fail("observation log_source must be siem");
  const issues = r.issues;
  if (!Array.isArray(issues) || issues.some((i) => typeof i !== "string" || !i.trim()))
    fail("observation issues must be a list of non-empty strings");
  const signals = r.signals;
  if (!Array.isArray(signals)) fail("observation signals must be a list");
  const planned = new Set<string>(p.monitoring.signals.map((s: Obj) => s.name));
  const seen = new Set<string>();
  for (const s of signals) {
    if (!isObj(s)) fail("each observed signal must be an object");
    const name = nonempty(s.name, "signal name");
    if (seen.has(name)) fail("observation signal names must be unique");
    seen.add(name);
    if (s.source !== "siem") fail("observation signal source must be siem");
    if (typeof s.healthy !== "boolean") fail("signal healthy must be boolean");
    nonempty(s.evidence, "signal evidence");
  }
  const missing = [...planned].filter((n) => !seen.has(n)).sort();
  const unexpected = [...seen].filter((n) => !planned.has(n)).sort();
  if (missing.length || unexpected.length) {
    const details = [];
    if (missing.length) details.push("missing: " + missing.join(", "));
    if (unexpected.length) details.push("unexpected: " + unexpected.join(", "));
    fail("observation signals do not match the frozen plan (" + details.join("; ") + ")");
  }
  if (r.status === "healthy") {
    if (issues.length) fail("healthy observation must not contain issues");
    if (signals.some((s: Obj) => !s.healthy)) fail("healthy observation contains an unhealthy signal");
    if (ended - started < Math.max(30, p.monitoring.window_minutes) * MINUTE)
      fail("healthy observation window is too short");
  } else {
    if (!issues.length) fail("degraded observation must contain at least one issue");
    if (!signals.some((s: Obj) => !s.healthy)) fail("degraded observation must contain an unhealthy signal");
  }
}

function validateIncident(r: Obj): void {
  if (!["SEV1", "SEV2", "SEV3", "SEV4"].includes(r.severity)) fail("incident severity must be SEV1..SEV4");
  nonempty(r.impact, "incident impact");
  stringList(r.signals, "incident signals");
  stringList(r.containment_actions, "incident containment_actions");
  if (typeof r.suspected_release !== "boolean") fail("incident suspected_release must be boolean");
}

function validateRecovery(r: Obj, p: Obj, observed: Micros, mergedAt: Micros): void {
  if (p.recovery.preferred_strategy === "not_applicable")
    fail("a not_applicable recovery plan cannot have recovery receipts");
  if (!RECOVERY_STRATEGIES.has(r.strategy)) fail("invalid recovery strategy");
  if (!["started", "succeeded", "failed"].includes(r.status)) fail("recovery status must be started, succeeded, or failed");
  const started = time(r.started_at);
  if (started < mergedAt) fail("recovery started before the merge");
  if (future(started)) fail("recovery started_at is in the future");
  if (r.status === "started") {
    if (r.completed_at !== undefined && r.completed_at !== null) fail("started recovery must not include completed_at");
    if (observed < started) fail("recovery observed_at precedes started_at");
  } else {
    const completed = time(r.completed_at);
    if (completed < started) fail("recovery completed_at precedes started_at");
    if (future(completed)) fail("recovery completed_at is in the future");
    if (observed < completed) fail("recovery observed_at precedes completed_at");
  }
  stringList(r.actions, "recovery actions");
  stringList(r.verification, "recovery verification");
  stringList(r.evidence, "recovery evidence");
  if (r.strategy !== p.recovery.preferred_strategy) nonempty(r.deviation_reason, "recovery deviation_reason");
}

function validatePostmortem(r: Obj): void {
  nonempty(r.path_or_url, "postmortem path_or_url");
  nonempty(r.root_cause, "postmortem root_cause");
  stringList(r.actions, "postmortem actions");
}

function validateReceipt(receipt: unknown, row: Obj, p: Obj): [string, Micros] {
  const [mergeSha, mergedAt] = mergeInfo(row);
  const [type, observed] = validateCommon(receipt, row.url, mergeSha, mergedAt);
  if (p.release.mode === "not_applicable") fail("a not_applicable delivery plan cannot have delivery receipts");
  const r = receipt as Obj;
  ({
    release: () => validateRelease(r, p, row, mergeSha),
    observation: () => validateObservation(r, p, observed, mergedAt),
    incident: () => validateIncident(r),
    recovery: () => validateRecovery(r, p, observed, mergedAt),
    postmortem: () => validatePostmortem(r),
  })[type as "release"]();
  return [type, observed];
}

function receiptSummary(r: Obj): Obj {
  const out: Obj = { type: r.type, observed_at: r.observed_at };
  for (const f of ["status", "phase", "severity", "strategy", "release_id", "release_attempt", "release_identifier"])
    if (f in r) out[f] = r[f];
  return out;
}

function loadReceipt(entry: unknown): Obj {
  if (!isObj(entry)) fail("delivery receipt ledger entry is invalid");
  return readBound(entry as Obj, "delivery receipt") as Obj;
}

const receiptTime = (r: Obj) => time(r.observed_at);
const ordered = (rs: Obj[]) => [...rs].sort((a, b) => receiptTime(a) - receiptTime(b));
const latest = (rs: Obj[]): Obj | null =>
  rs.reduce<Obj | null>((m, r) => (m === null || receiptTime(r) > receiptTime(m) ? r : m), null);

function loadValidReceipts(row: Obj, p: Obj): Obj[] {
  const entries = (row.delivery || {}).receipts ?? [];
  if (!Array.isArray(entries)) fail("delivery receipts ledger field is invalid");
  const receipts: Obj[] = [];
  const seen = new Set<Micros>();
  for (const entry of entries) {
    const receipt = loadReceipt(entry);
    if (entry.delivery_plan_sha256 !== deliveryPlanDigest(p))
      fail("delivery receipt is bound to a different delivery plan");
    const [, observed] = validateReceipt(receipt, row, p);
    if (seen.has(observed)) fail("delivery receipt observed_at timestamps must be unique");
    seen.add(observed);
    receipts.push(receipt);
  }
  return ordered(receipts);
}

const dueLine = (row: Obj) => ({ status: row.status, url: row.url, merge: (row.delivery || {}).merge ?? null });

export function commandDue(args: Args): void {
  if (args.auto) return commandDueAuto(args);
  for (const row of readLedger(args.ledger)) if (POST_MERGE_DISPATCH_STATUSES.has(row.status)) printJson(dueLine(row));
}

function githubReleaseRuns(row: Obj, workflow: string): Obj[] {
  const runs = ghJson(
    ["run", "list", "--repo", row.repository, "--workflow", workflow, "--limit", "50", "--json",
      "attempt,conclusion,createdAt,databaseId,headSha,status,updatedAt,url"],
    "GitHub Actions run listing",
    (r) => "GitHub Actions run listing failed: " + r.stderr.trim(),
  );
  return Array.isArray(runs) ? runs : [];
}

function fetchRepository(row: Obj, fetched: Set<string>): void {
  if (fetched.has(row.repository)) return;
  const r = git(["-C", repositoryPath(row), "fetch", "--quiet", "origin"], 120);
  if (r === "timeout") throw new Error("repository fetch timed out");
  if (r.returncode) fail("repository fetch failed: " + r.stderr.trim());
  fetched.add(row.repository);
}

function releaseReceipt(row: Obj, p: Obj, mergeSha: string, run: Obj, status: string, observedAt: string): Obj {
  return {
    schema_version: SCHEMA_VERSION,
    url: row.url,
    type: "release",
    observed_at: observedAt,
    merge_sha: mergeSha,
    status,
    release_id: String(run.databaseId),
    release_attempt: run.attempt,
    release_identifier: p.release.identifier,
    environment: p.release.environment,
    commit_sha: run.headSha,
    release_url: `${run.url}/attempts/${run.attempt}`,
    evidence: [`GitHub Actions run ${run.url} (${run.conclusion || run.status})`],
  };
}

function writeAndRecord(ledger: string, row: Obj, receipt: Obj): void {
  const dir = join(root, "delivery-artifacts");
  mkdirSync(dir, { recursive: true });
  const name = row.url.replace(/^https:\/\/github\.com\//, "").replaceAll("/", "--");
  const path = join(dir, `${name}--release-${receipt.status}-${receipt.release_id}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n");
  commandRecord({ ledger, url: row.url, receipt: path } as Args);
}

function autoRelease(ledger: string, row: Obj, p: Obj, fetched: Set<string>): boolean {
  const [mergeSha, mergedAt] = mergeInfo(row);
  const entries: Obj[] = (row.delivery || {}).receipts || [];
  const started = entries.filter((e) => e.type === "release" && e.status === "started");
  if (entries.length > started.length || started.length > 1) return false;
  fetchRepository(row, fetched);
  const runs = githubReleaseRuns(row, p.release.identifier)
    .filter((r) => time(r.createdAt) >= mergedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const run of runs) {
    if (started.length && String(run.databaseId) !== started[0].release_id) continue;
    try {
      verifyReleaseAncestry(row, mergeSha, run.headSha);
    } catch (e) {
      if (e instanceof ReviewCtlError) continue;
      throw e;
    }
    if (!started.length) writeAndRecord(ledger, row, releaseReceipt(row, p, mergeSha, run, "started", run.createdAt));
    if (run.status !== "completed") return true;
    const final = run.conclusion === "success" ? "succeeded" : "failed";
    writeAndRecord(ledger, row, releaseReceipt(row, p, mergeSha, run, final, run.updatedAt));
    return final === "succeeded";
  }
  return started.length > 0;
}

function commandDueAuto(args: Args): void {
  const fetched = new Set<string>();
  for (const row of readLedger(args.ledger)) {
    if (!POST_MERGE_DISPATCH_STATUSES.has(row.status)) continue;
    let mode: string | null = null;
    try {
      const p = plan(row);
      mode = p.release.mode;
      if (mode === "not_applicable" && row.status === "merged_waiting_release") {
        commandComplete({ ledger: args.ledger, url: row.url } as Args);
        continue;
      }
      if (
        mode === "github-actions" &&
        (row.status === "merged_waiting_release" || row.status === "release_in_progress") &&
        autoRelease(args.ledger, row, p, fetched)
      )
        continue;
    } catch (e) {
      if (e instanceof ReviewCtlError) {
        if (blockerUnchanged(args.ledger, row.url, e.message)) continue;
        printJson({ status: row.status, url: row.url, blocker: e.message });
        continue;
      }
      if (!(e instanceof ExitCode)) throw e;
    }
    const current = findRow(readLedger(args.ledger), row.url);
    // A GitHub Actions release not yet started has no agent work until a run appears.
    if (mode === "github-actions" && current.status === "merged_waiting_release") continue;
    printJson(dueLine(current));
  }
}

function blockerUnchanged(ledger: string, url: string, message: string): boolean {
  return withLedgerLock(ledger, () => {
    const rows = readLedger(ledger);
    const row = findRow(rows, url);
    if (row.last_error === message) return true;
    row.last_error = message;
    writeLedger(ledger, rows);
    return false;
  });
}

function readArtifact(raw: string, kind: string): [string, Buffer, unknown] {
  const [path, rel] = resolveArtifactPath(raw, root);
  try {
    const payload = readFileSync(path);
    return [rel, payload, JSON.parse(payload.toString("utf8"))];
  } catch (e) {
    return fail(`cannot read ${kind}: ${(e as Error).message}`);
  }
}

export function commandReplan(args: Args): void {
  const [rel, payload, correction] = readArtifact(args.correction, "delivery plan correction");
  const url = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const previous = approvedPlan(row);
    mergeInfo(row);
    const digest = sha256(payload);
    const delivery = (row.delivery ??= {});
    const existing = delivery.plan_correction;
    if (existing !== undefined && existing !== null) {
      if (isObj(existing) && existing.sha256 === digest) {
        plan(row);
        printJson({ action: "already_replanned", url: row.url });
        return null;
      }
      fail("a different delivery plan correction exists");
    }
    if (row.status !== "merged_waiting_release") fail("delivery plan correction requires merged_waiting_release");
    const receipts = delivery.receipts ?? [];
    if (!Array.isArray(receipts)) fail("delivery receipts ledger field is invalid");
    if (receipts.length) fail("delivery plan cannot be corrected after recording a receipt");
    const effective = validatePlanCorrection(correction, row, previous);
    delivery.plan_correction = {
      path: rel,
      sha256: digest,
      recorded_at: timestamp(),
      reason_code: (correction as Obj).reason_code,
      previous_delivery_plan_sha256: deliveryPlanDigest(previous),
      effective_delivery_plan_sha256: deliveryPlanDigest(effective),
    };
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return row.url;
  });
  if (url) printJson({ action: "replanned", url });
}

export function commandRecord(args: Args): void {
  const [rel, payload, receipt] = readArtifact(args.receipt, "delivery receipt");
  const done = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const p = plan(row);
    const [type, observed] = validateReceipt(receipt, row, p);
    const existing = loadValidReceipts(row, p);
    const digest = sha256(payload);
    const delivery = (row.delivery ??= {});
    const entries: Obj[] = (delivery.receipts ??= []);
    if (entries.some((e) => e.sha256 === digest)) {
      printJson({ action: "already_recorded", url: row.url });
      return null;
    }
    if (existing.some((r) => receiptTime(r) === observed))
      fail("delivery receipt observed_at timestamps must be unique");
    entries.push({
      path: rel,
      sha256: digest,
      recorded_at: timestamp(),
      delivery_plan_sha256: deliveryPlanDigest(p),
      ...receiptSummary(receipt as Obj),
    });
    row.status = deriveDeliveryStatus([...existing, receipt]);
    delete delivery.completed_at;
    delete delivery.completion_sha256;
    delete delivery.completion_sequence;
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return { type, url: row.url };
  });
  if (done) printJson({ action: "recorded", receipt_type: done.type, url: done.url });
}

export function completionGaps(receipts: Obj[], p: Obj): [string[], Obj[]] {
  const gaps: string[] = [];
  if (p.release.mode === "not_applicable") {
    if (receipts.length) gaps.push("not_applicable delivery plan has delivery receipts");
    return [gaps, []];
  }
  const latestRelease = latest(receipts.filter((r) => r.type === "release"));
  if (latestRelease === null) return [["successful release"], []];
  if (latestRelease.status !== "succeeded") gaps.push("latest release receipt is not succeeded");
  const releaseAt = receiptTime(latestRelease);
  const starts = receipts.filter(
    (r) =>
      r.type === "release" &&
      r.status === "started" &&
      receiptTime(r) < releaseAt &&
      ["release_id", "release_attempt", "release_identifier", "environment", "commit_sha"].every(
        (f) => r[f] === latestRelease[f],
      ),
  );
  if (!starts.length) gaps.push("matching release started receipt");
  const adverse = receipts.filter(ADVERSE);
  const observations = receipts.filter((r) => r.type === "observation");

  if (!adverse.length) {
    const after = observations.filter((r) => receiptTime(r) >= releaseAt);
    const obs = latest(after);
    if (obs === null || obs.status !== "healthy" || obs.phase !== "post_release")
      gaps.push("latest post-release observation is not healthy");
    else if (time(obs.started_at) < releaseAt) gaps.push("post-release observation started before release success");
    return [gaps, [latestRelease, ...after.slice(-1)]];
  }

  const latestAdverse = latest(adverse)!;
  const incidents = receipts.filter((r) => r.type === "incident");
  if (!incidents.length) gaps.push("incident impact and containment receipt");
  const recovery = latest(
    receipts.filter((r) => r.type === "recovery" && receiptTime(r) > receiptTime(latestAdverse)),
  );
  if (recovery === null || recovery.status !== "succeeded") {
    gaps.push("latest recovery after the latest adverse event is not succeeded");
    return [gaps, [latestRelease, latestAdverse]];
  }
  const floor = Math.max(releaseAt, time(recovery.completed_at));
  const obs = latest(observations.filter((r) => receiptTime(r) >= floor));
  if (obs === null || obs.status !== "healthy" || obs.phase !== "post_recovery")
    gaps.push("latest post-recovery observation is not healthy");
  else if (time(obs.started_at) < floor)
    gaps.push("post-recovery observation started before final recovery and release");
  if (incidents.length) {
    const pmFloor = Math.max(receiptTime(latest(incidents)!), receiptTime(recovery));
    if (!receipts.some((r) => r.type === "postmortem" && receiptTime(r) > pmFloor))
      gaps.push("postmortem after the latest incident and recovery");
  }
  const sequence = [latestRelease, latestAdverse, recovery];
  if (obs) sequence.push(obs);
  return [gaps, sequence];
}

export function commandComplete(args: Args): void {
  const url = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const p = plan(row);
    mergeInfo(row);
    let receipts: Obj[];
    if (p.release.mode === "not_applicable") {
      receipts = [];
      if (((row.delivery || {}).receipts ?? []).length) fail("not_applicable delivery cannot contain receipts");
    } else receipts = loadValidReceipts(row, p);
    const [gaps, sequence] = completionGaps(receipts, p);
    if (gaps.length) {
      row.status = deriveDeliveryStatus(receipts);
      writeLedger(args.ledger, rows);
      printJson({ action: "incomplete", missing: gaps, url: row.url });
      throw new ExitCode(2);
    }
    const entries: Obj[] = (row.delivery || {}).receipts ?? [];
    const payload = {
      delivery_plan_sha256: deliveryPlanDigest(p),
      merge_sha: mergeInfo(row)[0],
      receipt_sha256: entries.map((e) => e.sha256),
      sequence: sequence.map((r) => ({ type: r.type, observed_at: r.observed_at, status: r.status ?? null })),
    };
    const digest = sha256(stableStringify(payload));
    const delivery = (row.delivery ??= {});
    if (row.status === "completed" && delivery.completion_sha256 === digest) {
      printJson({ action: "already_completed", url: row.url });
      return null;
    }
    row.status = "completed";
    delivery.completed_at = timestamp();
    delivery.completion_sha256 = digest;
    delivery.completion_sequence = payload.sequence;
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return row.url;
  });
  if (url) printJson({ action: "completed", url });
}

function latestAdverseEntry(row: Obj, p: Obj): [Obj | null, Obj | null] {
  let best: [Obj, Obj] | null = null;
  for (const entry of (row.delivery || {}).receipts ?? []) {
    const receipt = loadReceipt(entry);
    validateReceipt(receipt, row, p);
    if (ADVERSE(receipt) && (best === null || receiptTime(receipt) > receiptTime(best[1]))) best = [entry, receipt];
  }
  return best ?? [null, null];
}

const requireWorkspace = (args: Args, message: string) => {
  if (args.execute && resolveReal(args.ledger) !== resolveReal(defaultLedger)) fail(message);
};

export function commandReconcileDispatch(args: Args): void {
  if (!/^[0-9a-f]{64}$/.test(args.dispatch_sha256)) fail("dispatch_sha256 must be a 64-hex SHA-256");
  const evidence = nonempty(args.evidence, "reconciliation evidence");
  if (Buffer.byteLength(evidence) > 8192) fail("reconciliation evidence is too large");
  requireWorkspace(args, "executed dispatch reconciliation requires the workspace ledger");
  const url = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const dispatches = (row.delivery || {}).dispatches ?? [];
    if (!Array.isArray(dispatches)) fail("post-merge dispatch ledger field is invalid");
    const matches = dispatches.filter(
      (d: Obj) => d.dispatch_sha256 === args.dispatch_sha256 && d.write_outcome === "unknown" && !d.delivered,
    );
    if (matches.length !== 1) fail("no unique unknown post-merge dispatch is available to reconcile");
    if (!args.execute) {
      printJson({ action: "dispatch_reconcile_not_written", execute: false, url: row.url });
      return null;
    }
    const record = matches[0];
    record.write_outcome = "reconciled-not-written";
    record.reconciled_at = timestamp();
    record.reconciliation = { outcome: "not-written", evidence };
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return row.url;
  });
  if (url) printJson({ action: "dispatch_reconciled_not_written", url });
}

export function commandDispatch(args: Args): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(args.reviewer)) fail("invalid GitHub reviewer login");
  if (!RECOVERY_HUMAN_REASON_CODES.has(args.reason_code)) fail("invalid post-merge human reason code");
  const detail = nonempty(args.detail, "dispatch detail");
  if (Buffer.byteLength(detail) > 8192) fail("dispatch detail is too large");
  requireWorkspace(args, "executed post-merge dispatch requires the workspace ledger");

  const url = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const p = plan(row);
    const [mergeSha] = mergeInfo(row);
    if (!p.recovery.human_boundaries.includes(args.reason_code))
      fail("reason code is not declared in the frozen recovery plan");
    const [adverseEntry, adverseReceipt] = latestAdverseEntry(row, p);
    if (args.reason_code === "human-only-production-authentication") {
      if (!POST_MERGE_DISPATCH_STATUSES.has(row.status)) fail("production-authentication dispatch is not due");
    } else {
      if (row.status !== "recovering" || adverseReceipt === null)
        fail("recovery dispatch requires a current adverse event");
      if (!loadValidReceipts(row, p).some((r) => r.type === "incident"))
        fail("record impact and containment before human dispatch");
    }
    const anchor = adverseEntry ? adverseEntry.sha256 : mergeSha;
    const key = sha256(
      stableStringify(
        { anchor, detail, reason_code: args.reason_code, reviewer: args.reviewer, url: row.url }),
    );
    const delivery = (row.delivery ??= {});
    const dispatches: Obj[] = (delivery.dispatches ??= []);
    const previous = dispatches.find((d) => d.dispatch_sha256 === key);
    if (previous?.delivered) {
      printJson({ action: "already_dispatched", url: row.url });
      return null;
    }
    if (previous?.write_outcome === "unknown")
      fail("post-merge dispatch outcome is unknown; reconcile before retrying");
    if (!args.execute) {
      printJson({
        action: "post_merge_human_required",
        execute: false,
        reason_code: args.reason_code,
        reviewer: args.reviewer,
        url: row.url,
      });
      return null;
    }
    const record: Obj = previous ?? {
      dispatch_sha256: key,
      anchor_sha256: anchor,
      reason_code: args.reason_code,
      reviewer: args.reviewer,
      detail,
      delivered: false,
    };
    if (!previous) dispatches.push(record);
    record.attempted_at = timestamp();
    record.write_outcome = "in_progress";
    writeLedger(args.ledger, rows);
    const body =
      `@${args.reviewer} post-merge human decision required (\`${args.reason_code}\`) for merge \`${mergeSha}\`.\n\n` +
      `Needed: ${detail}\n\n` +
      "The agent is continuing safe containment and evidence collection.";
    let result;
    try {
      result = ghWrite(["pr", "comment", row.url, "--body", body]);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      record.write_outcome = "unknown";
      row.last_error = "post-merge dispatch comment outcome is unknown: " + e.message;
      writeLedger(args.ledger, rows);
      throw e;
    }
    if (result.returncode) {
      const message = result.stderr.trim() || result.stdout.trim() || "GitHub comment command failed";
      const rejected = rejectedWriteStatus(result);
      const graphql = (result.stderr + "\n" + result.stdout).split(/\r?\n/).some((l) => l.startsWith("GraphQL:"));
      if (rejected !== null || graphql) {
        record.write_outcome = "rejected";
        if (rejected !== null) record.http_status = rejected;
        row.last_error =
          "post-merge dispatch comment was rejected" + (rejected !== null ? ` (HTTP ${rejected})` : "") + ": " + message;
      } else {
        record.write_outcome = "unknown";
        row.last_error = "post-merge dispatch comment outcome is unknown: " + message;
      }
      writeLedger(args.ledger, rows);
      fail(row.last_error);
    }
    record.comment_url = result.stdout.trim() || null;
    record.delivered_at = timestamp();
    record.delivered = true;
    record.write_outcome = "confirmed";
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return row.url;
  });
  if (url)
    printJson({ action: "post_merge_human_dispatched", reason_code: args.reason_code, reviewer: args.reviewer, url });
}

export const PROGRAM: Program<Args> = {
  prog: "deliveryctl",
  globals: { ledger: { kind: "path", default: DEFAULT_LEDGER } },
  commands: {
    due: { options: { auto: { kind: "flag" } }, run: commandDue },
    replan: { positionals: [{ name: "url" }, { name: "correction" }], run: commandReplan },
    record: { positionals: [{ name: "url" }, { name: "receipt" }], run: commandRecord },
    complete: { positionals: [{ name: "url" }], run: commandComplete },
    dispatch: {
      positionals: [{ name: "url" }],
      options: {
        reviewer: { kind: "string", required: true },
        "reason-code": { kind: "string", required: true, choices: [...RECOVERY_HUMAN_REASON_CODES].sort() },
        detail: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: commandDispatch,
    },
    "reconcile-dispatch": {
      positionals: [{ name: "url" }],
      options: {
        "dispatch-sha256": { kind: "string", required: true },
        evidence: { kind: "string", required: true },
        execute: { kind: "flag" },
      },
      run: commandReconcileDispatch,
    },
  },
};

export const main = (argv: string[]): number => runProgram(PROGRAM, argv, [ReviewCtlError]);

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
