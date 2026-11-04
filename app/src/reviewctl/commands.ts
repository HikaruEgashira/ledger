import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyLive,
  approvalBody,
  DEFAULT_LEDGER,
  deliveryPlanDigest,
  deriveDeliveryStatus,
  evaluate,
  type Event,
  failureMessage,
  findRow,
  ghCommitReview,
  ghDismissReview,
  ghReviews,
  ghView,
  ghWrite,
  HUMAN_REASON_CODES,
  isSha,
  loadArtifact,
  printJson,
  readLedger,
  rejectedWriteStatus,
  resolveArtifactPath,
  STATUS_FOR_ACTION,
  syncRows,
  monitorWithOutage,
  outageProbeDue,
  prefetchSync,
  validateArtifact,
  validateLive,
  writeLedger,
} from "./core.ts";
import {
  compareStrings,
  ExitCode,
  isErrno,
  type Obj,
  parseTime,
  sameValue,
  ReviewCtlError,
  sha256,
  timestamp,
  withLedgerLock,
  isBlank,
} from "../lib/util.ts";

export interface Args {
  ledger: string;
  [key: string]: any;
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const isWorkspaceLedger = (ledger: string) => realOr(ledger) === realOr(DEFAULT_LEDGER);

function requireWorkspaceLedger(args: Args, message: string): void {
  if (args.execute && !isWorkspaceLedger(args.ledger)) throw new ReviewCtlError(message);
}

function readArtifactFile(raw: string): [string, string, Buffer, unknown] {
  const [path, rel] = resolveArtifactPath(raw);
  let payload: Buffer;
  let artifact: unknown;
  try {
    payload = readFileSync(path);
    artifact = JSON.parse(payload.toString("utf8"));
  } catch (e) {
    throw new ReviewCtlError(
      `cannot read evidence artifact: ${isErrno(e) ? (e as Error).message : (e as Error).message}`,
    );
  }
  return [path, rel, payload, artifact];
}

// Recorded evidence points at an immutable content-addressed copy, so later rewrites of the working file cannot invalidate it.
function freezeArtifact(path: string, rel: string, payload: Buffer): [string, string] {
  const digest = sha256(payload);
  const name = `${basename(rel, ".json")}.${digest.slice(0, 16)}.json`;
  const frozenRel = join(dirname(rel), "records", name);
  const frozen = join(dirname(path), "records", name);
  if (!existsSync(frozen)) {
    mkdirSync(dirname(frozen), { recursive: true });
    writeFileSync(frozen, payload, { mode: 0o444 });
  }
  return [frozen, frozenRel];
}

const syncFailed = (events: Event[]) => events.some((e) => e.event === "SYNC_FAILED");

export function commandValidate(args: Args): void {
  const rows = readLedger(args.ledger);
  printJson({ ledger: args.ledger, records: rows.length, valid: true });
}

export function commandList(args: Args): void {
  for (const row of readLedger(args.ledger))
    if (!args.status?.length || args.status.includes(row.status)) printJson(row);
}

export function changeRequestSuperseded(row: Obj): boolean {
  const cr = row.change_request || {};
  const head = row.live?.headRefOid;
  return (
    row.status === "changes_requested" &&
    cr.verification === "confirmed" &&
    !isBlank(head) &&
    !sameValue(cr.head_sha, head)
  );
}

export function commandNext(args: Args): void {
  const actionable = readLedger(args.ledger).filter(
    (r) => ["queued", "reviewing", "error"].includes(r.status) || changeRequestSuperseded(r),
  );
  const due = actionable.slice(
    0,
    Math.max(0, args.limit < 0 ? actionable.length + args.limit : args.limit),
  );
  if (actionable.length > due.length)
    process.stderr.write(
      `WARNING: ${actionable.length - due.length} actionable rows beyond --limit\n`,
    );
  if (args.summary) {
    for (const row of due)
      process.stdout.write(
        `${row.status}\t${row.url}\t${row.last_error || row.decision?.action || ""}\n`,
      );
    process.stdout.write(`TOTAL\t${actionable.length}\n`);
    return;
  }
  for (const row of due) printJson(row);
}

export function commandSync(args: Args): void {
  let rows: Obj[] = [];
  const apply = args.url ? null : prefetchSync(readLedger(args.ledger));
  const events = withLedgerLock(args.ledger, () => {
    rows = readLedger(args.ledger);
    const out = apply ? apply(rows) : syncRows(rows, args.url);
    writeLedger(args.ledger, rows);
    return out;
  });
  for (const event of events) printJson(event);
  printJson({ event: "SYNC_COMPLETE", records: rows.length });
}

export function commandRecord(args: Args): void {
  const [workPath, workRel, payload, artifact] = readArtifactFile(args.artifact);
  validateArtifact(artifact, args.url);
  const [path, rel] = freezeArtifact(workPath, workRel, payload);
  const decision = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const pendingApproval = row.approval?.verification === "pending";
    if (row.status === "approval_pending_verification" || pendingApproval) {
      const prior = { path: row.evidence_path, sha: row.evidence_sha256 };
      // The refresh reloads recorded evidence, so a replaced artifact must be in place first.
      row.evidence_path = rel;
      row.evidence_sha256 = sha256(payload);
      if (syncFailed(syncRows(rows, row.url))) {
        row.evidence_path = prior.path;
        row.evidence_sha256 = prior.sha;
        writeLedger(args.ledger, rows);
        throw new ReviewCtlError("live refresh failed; approval confirmation is blocked");
      }
    }
    const approval: Obj = row.approval || {};
    const live: Obj = row.live || {};
    const refsMatch =
      sameValue(approval.base_sha, live.baseRefOid) && sameValue(approval.head_sha, live.headRefOid);
    const pendingConfirmation = refsMatch && approval.verification === "pending";
    const frozenPlan = approval.delivery_plan_sha256;
    if (refsMatch && !isBlank(frozenPlan) && deliveryPlanDigest(artifact.delivery) !== frozenPlan) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("the approved delivery plan cannot be changed");
    }
    const digest = sha256(payload);
    const verified = approval.verified_evidence_sha256;
    if (
      refsMatch &&
      approval.verification === "post-approval-threads-and-live-state" &&
      !isBlank(verified) &&
      row.evidence_path !== null &&
      row.evidence_path !== undefined &&
      digest !== verified
    ) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("verified approval evidence cannot be changed");
    }
    row.evidence_path = rel;
    row.evidence_sha256 = digest;
    let [action, reasons]: [string, string[]] = evaluate(row);
    if (action === "approve" && pendingConfirmation) {
      const approvedAt = parseTime(approval.approved_at);
      const threadsVerifiedAt = parseTime(artifact.review_threads.verified_at);
      const reviewedAt = parseTime(artifact.reviewed_at);
      const confirmation: string[] = [];
      if (threadsVerifiedAt < approvedAt)
        confirmation.push("review threads were not verified after approval");
      if (reviewedAt < approvedAt)
        confirmation.push("review evidence was not refreshed after approval");
      if (confirmation.length) {
        action = "approval_pending_verification";
        reasons = confirmation;
        row.status = "approval_pending_verification";
      } else {
        action = "approved";
        row.status = "approved";
        approval.verified_at = timestamp();
        approval.verification = "post-approval-threads-and-live-state";
        approval.verified_evidence_sha256 = digest;
        row.approval = approval;
        chmodSync(path, 0o444);
      }
    } else if (pendingConfirmation) {
      action = "approval_pending_verification";
      if (live.state === "MERGED" && row.status !== "completed")
        row.status = deriveDeliveryStatus(row.delivery?.receipts ?? []);
      else row.status = "approval_pending_verification";
    } else if (
      action === "approve" &&
      refsMatch &&
      approval.verification === "post-approval-threads-and-live-state"
    ) {
      action = "approved";
      row.status = "approved";
      approval.verified_at = timestamp();
      approval.verified_evidence_sha256 = digest;
      row.approval = approval;
      chmodSync(path, 0o444);
    } else {
      const map: Obj = { ...STATUS_FOR_ACTION };
      delete map.wait;
      row.status = map[action] ?? row.status;
    }
    row.decision = { action, reasons, at: timestamp() };
    writeLedger(args.ledger, rows);
    return row.decision;
  });
  printJson(decision);
}

export function commandGate(args: Args): void {
  const row = findRow(readLedger(args.ledger), args.url);
  const [action, reasons] = evaluate(row);
  printJson({ action, reasons, url: row.url });
  if (action !== "approve") throw new ExitCode(2);
}

export function commandApprove(args: Args): void {
  requireWorkspaceLedger(args, "executed approvals require the workspace ledger");
  const done = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const events = syncRows(rows, row.url);
    if (syncFailed(events)) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live refresh failed; approval is blocked");
    }
    const [action, reasons] = evaluate(row);
    if (action !== "approve") {
      writeLedger(args.ledger, rows);
      printJson({ action, reasons, url: row.url });
      throw new ExitCode(2);
    }
    if (!args.execute) {
      writeLedger(args.ledger, rows);
      printJson({ action: "approve", execute: false, url: row.url });
      return null;
    }
    const approval: Obj = row.approval || {};
    const sameRefs =
      sameValue(approval.base_sha, row.live.baseRefOid) && sameValue(approval.head_sha, row.live.headRefOid);
    if (sameRefs && approval.verification === "write-outcome-unknown") {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(
        "a commit-bound approval write has an unknown outcome; reconcile that attempt before retrying",
      );
    }
    if (sameRefs && approval.verification === "pending") {
      writeLedger(args.ledger, rows);
      printJson({ action: "approval_pending_verification", url: row.url });
      throw new ExitCode(2);
    }
    if (sameRefs && approval.verification === "post-approval-threads-and-live-state") {
      writeLedger(args.ledger, rows);
      printJson({ action: "already_approved", url: row.url });
      return null;
    }
    const baseSha: string = row.live.baseRefOid;
    const headSha: string = row.live.headRefOid;
    const artifact = loadArtifact(row);
    if (artifact === null) throw new Error("AssertionError");
    const plan = artifact.delivery;
    const body = approvalBody(artifact, row.live);
    let result, response;
    try {
      [result, response] = ghCommitReview(row, headSha, "APPROVE", body);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      row.approval = {
        base_sha: baseSha,
        head_sha: headSha,
        attempted_at: timestamp(),
        verification: "write-outcome-unknown",
        delivery_plan: plan,
        delivery_plan_sha256: deliveryPlanDigest(plan),
      };
      row.last_error = "commit-bound approval write outcome is unknown: " + e.message;
      row.status = "error";
      writeLedger(args.ledger, rows);
      throw e;
    }
    if (result.returncode) {
      const rejected = rejectedWriteStatus(result);
      const record: Obj = {
        base_sha: baseSha,
        head_sha: headSha,
        attempted_at: timestamp(),
        delivery_plan: plan,
        delivery_plan_sha256: deliveryPlanDigest(plan),
      };
      const message = failureMessage(result, "GitHub review command failed");
      if (rejected !== null) {
        record.verification = "write-rejected";
        record.http_status = rejected;
        row.last_error = `commit-bound approval write was rejected (HTTP ${rejected}): ${message}`;
      } else {
        record.verification = "write-outcome-unknown";
        row.last_error = "commit-bound approval write outcome is unknown: " + message;
      }
      row.approval = record;
      row.status = "error";
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    if (response === null) throw new Error("AssertionError");
    const approvedAt = response.submitted_at || timestamp();
    parseTime(approvedAt);
    row.approval = {
      base_sha: baseSha,
      head_sha: headSha,
      approved_at: approvedAt,
      review_id: response.id ?? null,
      review_url: response.html_url ?? null,
      write_outcome: "confirmed",
      verification: "pending",
      delivery_plan: plan,
      delivery_plan_sha256: deliveryPlanDigest(plan),
    };
    let post: Obj;
    try {
      post = ghView(row.url);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      row.status = "error";
      row.evidence_path = null;
      row.evidence_sha256 = null;
      row.last_error = `post-approval verification failed: ${e.message}`;
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    if (post.baseRefOid !== baseSha || post.headRefOid !== headSha) {
      applyLive(row, post);
      row.approval.verification = "invalidated-ref-change";
      row.approval.observed_base_sha = post.baseRefOid;
      row.approval.observed_head_sha = post.headRefOid;
      let compensationError: string | null = null;
      if (post.state === "OPEN") {
        try {
          const [compensation] = ghCommitReview(
            row,
            post.headRefOid,
            "REQUEST_CHANGES",
            "The pull request changed during approval. The prior commit-bound approval does not cover this head; re-review is required.",
          );
          if (compensation.returncode)
            compensationError = failureMessage(compensation, "compensating review failed");
        } catch (e) {
          if (!(e instanceof ReviewCtlError)) throw e;
          compensationError = e.message;
        }
      }
      row.last_error = compensationError
        ? `PR changed during commit-bound approval; the new head remains unreviewed and compensating review failed: ${compensationError}`
        : "PR changed during commit-bound approval; the old-head approval was invalidated and the new head requires re-review";
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    row.live = post;
    row.last_synced_at = timestamp();
    row.status = "approval_pending_verification";
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return { events, headSha, url: row.url };
  });
  if (!done) return;
  for (const event of done.events) printJson(event);
  printJson({ action: "approval_pending_verification", head_sha: done.headSha, url: done.url });
}

export function commandRequestChanges(args: Args): void {
  requireWorkspaceLedger(args, "executed reviews require the workspace ledger");
  const [bodyPath] = resolveArtifactPath(args.body_file);
  let body: Buffer;
  try {
    body = readFileSync(bodyPath);
  } catch (e) {
    throw new ReviewCtlError(`cannot read review body: ${(e as Error).message}`);
  }
  if (
    !body.toString("latin1").replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "") ||
    body.length > 65536
  )
    throw new ReviewCtlError("review body must contain 1..65536 bytes");
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ReviewCtlError("review body must be UTF-8");
  }
  const bodyDigest = sha256(body);

  const out = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    if (syncFailed(syncRows(rows, row.url))) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live refresh failed; request-changes is blocked");
    }
    const [action, reasons] = evaluate(row);
    if (action !== "changes_requested") {
      writeLedger(args.ledger, rows);
      printJson({ action, reasons, url: row.url });
      throw new ExitCode(2);
    }
    const headSha: string = row.live.headRefOid;
    const previous: Obj = row.change_request || {};
    const same =
      sameValue(previous.base_sha, row.live.baseRefOid) &&
      sameValue(previous.head_sha, headSha) &&
      sameValue(previous.body_sha256, bodyDigest);
    if (same && previous.write_outcome === "unknown") {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(
        "a commit-bound request-changes write has an unknown outcome; reconcile that attempt before retrying",
      );
    }
    if (same && previous.write_outcome === "confirmed" && previous.verification === "confirmed") {
      writeLedger(args.ledger, rows);
      printJson({ action: "already_requested", url: row.url });
      return null;
    }
    if (!args.execute) {
      writeLedger(args.ledger, rows);
      printJson({ action: "request_changes", execute: false, head_sha: headSha, url: row.url });
      return null;
    }
    const baseSha: string = row.live.baseRefOid;
    let result, response;
    try {
      [result, response] = ghCommitReview(row, headSha, "REQUEST_CHANGES", bodyText);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      row.status = "error";
      row.change_request = {
        base_sha: baseSha,
        head_sha: headSha,
        body_sha256: bodyDigest,
        attempted_at: timestamp(),
        write_outcome: "unknown",
      };
      row.last_error = "commit-bound request-changes outcome is unknown: " + e.message;
      writeLedger(args.ledger, rows);
      throw e;
    }
    if (result.returncode) {
      const rejected = rejectedWriteStatus(result);
      row.status = "error";
      const changeRequest: Obj = {
        base_sha: baseSha,
        head_sha: headSha,
        body_sha256: bodyDigest,
        attempted_at: timestamp(),
      };
      const message = failureMessage(result, "GitHub review command failed");
      if (rejected !== null) {
        changeRequest.write_outcome = "rejected";
        changeRequest.http_status = rejected;
        row.last_error = `commit-bound request-changes write was rejected (HTTP ${rejected}): ${message}`;
      } else {
        changeRequest.write_outcome = "unknown";
        row.last_error = "commit-bound request-changes outcome is unknown: " + message;
      }
      row.change_request = changeRequest;
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    if (response === null) throw new Error("AssertionError");
    row.change_request = {
      base_sha: baseSha,
      head_sha: headSha,
      body_sha256: bodyDigest,
      submitted_at: response.submitted_at || timestamp(),
      review_id: response.id ?? null,
      review_url: response.html_url ?? null,
      write_outcome: "confirmed",
      verification: "pending-live-refresh",
    };
    let post: Obj;
    try {
      post = ghView(row.url);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      row.status = "error";
      row.last_error = "request-changes was submitted, but live verification failed: " + e.message;
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    if (post.baseRefOid !== baseSha || post.headRefOid !== headSha) {
      applyLive(row, post);
      row.change_request.verification = "stale-ref";
      row.change_request.observed_base_sha = post.baseRefOid;
      row.change_request.observed_head_sha = post.headRefOid;
      row.last_error =
        "PR refs changed while request-changes was submitted; re-review the current head";
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    row.live = post;
    row.last_synced_at = timestamp();
    row.status = "changes_requested";
    row.change_request.verification = "confirmed";
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return { action: "changes_requested", head_sha: headSha, url: row.url };
  });
  if (out) printJson(out);
}

export function commandWithdraw(args: Args): void {
  requireWorkspaceLedger(args, "executed withdrawals require the workspace ledger");
  const reviewId: number = args.review_id;
  if (!Number.isInteger(reviewId) || reviewId < 1)
    throw new ReviewCtlError("review ID must be a positive integer");
  if (!isSha(args.base_sha) || !isSha(args.head_sha))
    throw new ReviewCtlError("expected base and head must be 40-character SHAs");
  const message = args.message.trim();
  if (!message || Buffer.byteLength(message) > 1024)
    throw new ReviewCtlError("withdrawal message must contain 1..1024 UTF-8 bytes");
  const messageDigest = sha256(message);

  const out = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const events = syncRows(rows, row.url);
    if (syncFailed(events)) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live refresh failed; review withdrawal is blocked");
    }
    const live = row.live;
    if (live.baseRefOid !== args.base_sha || live.headRefOid !== args.head_sha) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live PR refs do not match the explicitly expected withdrawal refs");
    }
    const expectedReviewUrl = `${row.url}#pullrequestreview-${reviewId}`;
    const previous: Obj = row.withdrawal || {};
    const same =
      previous.base_sha === args.base_sha &&
      previous.head_sha === args.head_sha &&
      previous.review_id === reviewId;
    if (same && !sameValue(previous.message_sha256, messageDigest)) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("withdrawal message changed for the same review and refs");
    }
    if (same && previous.write_outcome === "confirmed" && previous.verification === "confirmed") {
      writeLedger(args.ledger, rows);
      printJson({
        action: "already_withdrawn",
        base_sha: args.base_sha,
        head_sha: args.head_sha,
        review_id: reviewId,
        url: row.url,
      });
      return null;
    }
    if (same && previous.write_outcome === "unknown") {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(
        "the guarded review withdrawal has an unknown outcome; verify it externally before retrying",
      );
    }
    const resume = same && previous.write_outcome === "confirmed";
    const changeRequest: Obj = row.change_request || {};
    if (
      changeRequest.base_sha !== args.base_sha ||
      changeRequest.head_sha !== args.head_sha ||
      changeRequest.review_id !== reviewId ||
      changeRequest.review_url !== expectedReviewUrl ||
      changeRequest.write_outcome !== "confirmed" ||
      changeRequest.verification !== "confirmed"
    ) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("target is not the row's current confirmed change request");
    }
    if (!resume && live.reviewDecision !== "CHANGES_REQUESTED") {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("the current live PR decision is not CHANGES_REQUESTED");
    }
    if (!args.execute) {
      writeLedger(args.ledger, rows);
      printJson({
        action: resume ? "verify_withdrawal" : "withdraw",
        base_sha: args.base_sha,
        execute: false,
        head_sha: args.head_sha,
        message_sha256: messageDigest,
        review_id: reviewId,
        review_url: expectedReviewUrl,
        url: row.url,
      });
      return null;
    }
    let withdrawal: Obj;
    if (resume) withdrawal = previous;
    else {
      withdrawal = {
        base_sha: args.base_sha,
        head_sha: args.head_sha,
        review_id: reviewId,
        review_url: expectedReviewUrl,
        message_sha256: messageDigest,
        attempted_at: timestamp(),
        write_outcome: "unknown",
        verification: "write-outcome-unknown",
      };
      row.withdrawal = withdrawal;
      row.status = "error";
      row.last_error = "guarded review withdrawal started; write outcome is not yet confirmed";
      writeLedger(args.ledger, rows);
      let result, response;
      try {
        [result, response] = ghDismissReview(row, reviewId, args.head_sha, message);
      } catch (e) {
        if (!(e instanceof ReviewCtlError)) throw e;
        row.last_error = "guarded review withdrawal outcome is unknown: " + e.message;
        writeLedger(args.ledger, rows);
        throw e;
      }
      if (result.returncode) {
        const rejected = rejectedWriteStatus(result);
        const text = failureMessage(result, "GitHub review dismissal failed");
        if (rejected !== null) {
          withdrawal.write_outcome = "rejected";
          withdrawal.verification = "write-rejected";
          withdrawal.http_status = rejected;
          row.last_error = `guarded review withdrawal was rejected (HTTP ${rejected}): ${text}`;
        } else {
          withdrawal.write_outcome = "unknown";
          withdrawal.verification = "write-outcome-unknown";
          row.last_error = "guarded review withdrawal outcome is unknown: " + text;
        }
        row.withdrawal = withdrawal;
        row.status = "error";
        writeLedger(args.ledger, rows);
        throw new ReviewCtlError(row.last_error);
      }
      if (response === null) throw new Error("AssertionError");
      withdrawal.dismissed_at = timestamp();
      withdrawal.response_node_id = response.node_id;
      withdrawal.write_outcome = "confirmed";
      withdrawal.verification = "pending-live-refresh";
      row.withdrawal = withdrawal;
      writeLedger(args.ledger, rows);
    }
    let post: Obj;
    let postReviews: Obj[];
    try {
      post = ghView(row.url);
      postReviews = ghReviews(row.url);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      withdrawal.verification = "dismissed-response-live-outcome-unknown";
      row.status = "error";
      row.last_error = "review dismissal was confirmed, but live verification failed: " + e.message;
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    const matching = postReviews.filter((r) => sameValue(r.id, withdrawal.response_node_id));
    if (
      matching.length !== 1 ||
      matching[0].state !== "DISMISSED" ||
      matching[0].commit?.oid !== args.head_sha
    ) {
      withdrawal.verification = "dismissed-response-live-review-unconfirmed";
      row.status = "error";
      row.last_error =
        "GitHub did not expose the exact dismissed review in the live pull-request review list";
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    withdrawal.verification = "confirmed";
    withdrawal.live_review_state = "DISMISSED";
    withdrawal.verified_at = timestamp();
    changeRequest.verification = "withdrawn";
    changeRequest.withdrawn_at = withdrawal.verified_at;
    row.change_request = changeRequest;
    row.withdrawal = withdrawal;
    const refsChanged = post.baseRefOid !== args.base_sha || post.headRefOid !== args.head_sha;
    if (refsChanged) {
      withdrawal.observed_base_sha = post.baseRefOid;
      withdrawal.observed_head_sha = post.headRefOid;
      events.push(...applyLive(row, post));
      row.evidence_path = null;
      row.evidence_sha256 = null;
      row.last_error = null;
      writeLedger(args.ledger, rows);
    } else {
      row.live = post;
      row.last_synced_at = timestamp();
      row.evidence_path = null;
      row.evidence_sha256 = null;
      const [action, reasons] = evaluate(row);
      row.decision = { action, reasons, at: timestamp() };
      row.status = STATUS_FOR_ACTION[action] ?? row.status;
      row.last_error = null;
      writeLedger(args.ledger, rows);
    }
    return {
      events,
      result: {
        action: refsChanged ? "withdrawn_stale_ref" : "withdrawn",
        base_sha: args.base_sha,
        head_sha: args.head_sha,
        live_review_decision: post.reviewDecision ?? null,
        review_id: reviewId,
        review_url: expectedReviewUrl,
        url: row.url,
      },
    };
  });
  if (!out) return;
  for (const event of out.events) printJson(event);
  printJson(out.result);
}

const REVIEWER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function commandDispatch(args: Args): void {
  if (!REVIEWER_RE.test(args.reviewer)) throw new ReviewCtlError("invalid GitHub reviewer login");
  requireWorkspaceLedger(args, "executed dispatch requires the workspace ledger");
  const out = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    if (syncFailed(syncRows(rows, row.url))) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live refresh failed; human dispatch is blocked");
    }
    const live = row.live;
    const baseSha: string = live.baseRefOid;
    let headSha: string = live.headRefOid;
    const previous: Obj = row.dispatch || {};
    const same =
      previous.base_sha === baseSha &&
      previous.head_sha === headSha &&
      previous.reviewer === args.reviewer;
    if (same && !isBlank(previous.delivered)) {
      writeLedger(args.ledger, rows);
      printJson({ action: "already_dispatched", url: row.url });
      return null;
    }
    if (same && String(previous.write_outcome).includes("unknown")) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(
        "a human dispatch write has an unknown outcome; reconcile it before retrying",
      );
    }
    const resumePartial =
      same &&
      !isBlank(previous.comment_delivered) &&
      !!isBlank(previous.reviewer_requested) &&
      sameValue(previous.expected_updated_at, live.updatedAt) &&
      HUMAN_REASON_CODES.has(previous.reason_code) &&
      typeof previous.detail === "string" &&
      previous.detail.trim() !== "";
    let dispatch: Obj;
    if (resumePartial) dispatch = { reason_code: previous.reason_code, detail: previous.detail };
    else {
      const [action, reasons] = evaluate(row);
      if (action !== "human_required") {
        writeLedger(args.ledger, rows);
        printJson({ action, reasons, url: row.url });
        throw new ExitCode(2);
      }
      const artifact = loadArtifact(row);
      if (artifact === null) throw new Error("AssertionError");
      dispatch = artifact.human_dispatch;
    }
    const reasonCode = dispatch.reason_code;
    const detail: string = dispatch.detail;
    const detailDigest = sha256(detail);
    const samePayload =
      same && sameValue(previous.reason_code, reasonCode) && sameValue(previous.detail_sha256, detailDigest);
    if (same && !samePayload) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("dispatch payload changed for the same reviewed refs");
    }
    headSha = row.live.headRefOid;
    if (!args.execute) {
      writeLedger(args.ledger, rows);
      printJson({
        action: "human_required",
        execute: false,
        reason_code: reasonCode,
        reviewer: args.reviewer,
        url: row.url,
      });
      return null;
    }
    const record: Obj = samePayload ? previous : {};
    Object.assign(record, {
      base_sha: baseSha,
      head_sha: headSha,
      reason_code: reasonCode,
      detail,
      detail_sha256: detailDigest,
      reviewer: args.reviewer,
      started_at: record.started_at || timestamp(),
      comment_delivered: !isBlank(record.comment_delivered),
      reviewer_requested: !isBlank(record.reviewer_requested),
      delivered: false,
      expected_updated_at:
        "expected_updated_at" in record ? record.expected_updated_at : (live.updatedAt ?? null),
      write_outcome: "in_progress",
    });
    row.dispatch = record;
    writeLedger(args.ledger, rows);

    const message =
      `@${args.reviewer} human decision required (\`${reasonCode}\`) for \`${headSha}\`.\n\n` +
      `Needed: ${detail}\n\n` +
      "The agent completed all currently agent-owned review work.";
    const staleRefs = (post: Obj) => {
      applyLive(row, post);
      record.write_outcome = "stale-ref";
      record.observed_base_sha = post.baseRefOid;
      record.observed_head_sha = post.headRefOid;
      row.dispatch = record;
      row.last_error =
        "PR refs changed during human dispatch; re-review before dispatching the current head";
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    };
    if (!record.comment_delivered) {
      let comment;
      try {
        comment = ghWrite(["pr", "comment", row.url, "--body", message]);
      } catch (e) {
        if (!(e instanceof ReviewCtlError)) throw e;
        record.write_outcome = "unknown";
        row.status = "error";
        row.last_error = "human dispatch comment outcome is unknown: " + e.message;
        writeLedger(args.ledger, rows);
        throw e;
      }
      if (comment.returncode) {
        record.write_outcome = "unknown";
        row.status = "error";
        row.last_error =
          "human dispatch comment outcome is unknown: " +
          failureMessage(comment, "GitHub comment command failed");
        writeLedger(args.ledger, rows);
        throw new ReviewCtlError(row.last_error);
      }
      record.comment_delivered = true;
      record.comment_url = comment.stdout.trim() || null;
      record.commented_at = timestamp();
      let post: Obj;
      try {
        post = ghView(row.url);
      } catch (e) {
        if (!(e instanceof ReviewCtlError)) throw e;
        record.write_outcome = "comment-confirmed-live-outcome-unknown";
        row.status = "error";
        row.last_error = `dispatch comment was delivered, but live verification failed: ${e.message}`;
        writeLedger(args.ledger, rows);
        throw new ReviewCtlError(row.last_error);
      }
      if (post.baseRefOid !== baseSha || post.headRefOid !== headSha) staleRefs(post);
      row.live = post;
      row.last_synced_at = timestamp();
      record.expected_updated_at = post.updatedAt;
      row.status = "human_required";
      writeLedger(args.ledger, rows);
    }
    if (!record.reviewer_requested) {
      let request;
      try {
        request = ghWrite(["pr", "edit", row.url, "--add-reviewer", args.reviewer]);
      } catch (e) {
        if (!(e instanceof ReviewCtlError)) throw e;
        record.write_outcome = "unknown";
        row.status = "error";
        row.last_error = "formal reviewer-request outcome is unknown: " + e.message;
        writeLedger(args.ledger, rows);
        throw e;
      }
      if (request.returncode) {
        record.write_outcome = "reviewer-request-failed";
        row.status = "human_required";
        row.last_error = failureMessage(request, "reviewer request failed");
        writeLedger(args.ledger, rows);
        throw new ReviewCtlError(`formal reviewer request failed: ${row.last_error}`);
      }
      record.reviewer_requested = true;
      record.reviewer_requested_at = timestamp();
      record.delivered = true;
      record.delivered_at = timestamp();
      record.write_outcome = "writes-confirmed-pending-live";
      writeLedger(args.ledger, rows);
    }
    let post: Obj;
    try {
      post = ghView(row.url);
    } catch (e) {
      if (!(e instanceof ReviewCtlError)) throw e;
      record.write_outcome = "writes-confirmed-live-outcome-unknown";
      row.status = "human_required";
      row.last_error = "dispatch writes succeeded, but live verification failed: " + e.message;
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(row.last_error);
    }
    if (post.baseRefOid !== baseSha || post.headRefOid !== headSha) staleRefs(post);
    row.live = post;
    row.last_synced_at = timestamp();
    row.status = "human_required";
    record.expected_updated_at = post.updatedAt;
    record.dispatched_at = timestamp();
    record.delivered = true;
    record.write_outcome = "confirmed";
    row.dispatch = record;
    row.last_error = null;
    writeLedger(args.ledger, rows);
    return {
      action: "human_dispatched",
      reason_code: reasonCode,
      reviewer: args.reviewer,
      url: row.url,
    };
  });
  if (out) printJson(out);
}


export function commandReconcile(args: Args): void {
  requireWorkspaceLedger(args, "executed reconciliations require the workspace ledger");
  const evidence = args.evidence.trim();
  if (!evidence || [...evidence].length > 1024)
    throw new ReviewCtlError("reconciliation evidence must contain 1..1024 characters");
  const out = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const events = syncRows(rows, row.url);
    if (syncFailed(events)) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError("live refresh failed; reconciliation is blocked");
    }
    const live = row.live;
    const key = args.action === "approve" ? "approval" : "change_request";
    const record: Obj = row[key] || {};
    const unknown =
      args.action === "approve"
        ? record.verification === "write-outcome-unknown"
        : record.write_outcome === "unknown";
    if (
      !sameValue(record.base_sha, live.baseRefOid) ||
      !sameValue(record.head_sha, live.headRefOid) ||
      !unknown
    ) {
      writeLedger(args.ledger, rows);
      throw new ReviewCtlError(
        `no current-ref unknown ${args.action} write is available to reconcile`,
      );
    }
    if (!args.execute) {
      writeLedger(args.ledger, rows);
      printJson({
        action: "reconcile_not_written",
        execute: false,
        review_action: args.action,
        url: row.url,
      });
      return null;
    }
    if (args.action === "approve") record.verification = "write-rejected";
    else record.write_outcome = "rejected";
    record.reconciled_at = timestamp();
    record.reconciliation = { outcome: "not-written", evidence };
    row[key] = record;
    row.last_error = null;
    const [action, reasons] = evaluate(row);
    row.decision = { action, reasons, at: timestamp() };
    row.status = STATUS_FOR_ACTION[action] ?? row.status;
    writeLedger(args.ledger, rows);
    return { events, url: row.url };
  });
  if (!out) return;
  for (const event of out.events) printJson(event);
  printJson({ action: "reconciled_not_written", review_action: args.action, url: out.url });
}

/** Rebind a row whose confirmed-approval evidence broke, on unchanged refs. */
export function commandRecover(args: Args): void {
  requireWorkspaceLedger(args, "executed recoveries require the workspace ledger");
  const reason = args.evidence.trim();
  if (!reason || [...reason].length > 1024)
    throw new ReviewCtlError("recovery evidence must contain 1..1024 characters");
  const [workPath, workRel, payload, artifact] = readArtifactFile(args.artifact);
  validateArtifact(artifact, args.url);
  const digest = sha256(payload);
  const out = withLedgerLock(args.ledger, () => {
    const rows = readLedger(args.ledger);
    const row = findRow(rows, args.url);
    const approval: Obj = row.approval || {};
    if (approval.verification !== "post-approval-threads-and-live-state")
      throw new ReviewCtlError("row has no confirmed approval to recover");
    const live = ghView(row.url);
    validateLive(row, live);
    if (
      live.state !== "OPEN" ||
      !sameValue(approval.base_sha, live.baseRefOid) ||
      !sameValue(approval.head_sha, live.headRefOid)
    )
      throw new ReviewCtlError("refs changed or PR is not open; re-review instead of recovering");
    if (!sameValue(deliveryPlanDigest(artifact.delivery), approval.delivery_plan_sha256))
      throw new ReviewCtlError("the approved delivery plan cannot be changed");
    const reviews = ((live.latestReviews || []) as Obj[])
      .map((r, i) => [r, i] as const)
      .sort(([a, i], [b, j]) => compareStrings(a.submittedAt || "", b.submittedAt || "") || i - j)
      .map(([r]) => r)
      .filter(
        (r) =>
          r.author?.login === args.reviewer &&
          ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state),
      );
    const approvalLive = reviews.length > 0 && reviews.at(-1)!.state === "APPROVED";
    const previous = {
      at: timestamp(),
      evidence_sha256: row.evidence_sha256 ?? null,
      verified_evidence_sha256: approval.verified_evidence_sha256 ?? null,
      reason,
    };
    const outcome = approvalLive ? "rebind-evidence" : "reset-dismissed-approval";
    if (!args.execute) {
      printJson({ action: "recover_not_written", execute: false, outcome, url: row.url });
      return null;
    }
    row.live = live;
    row.last_synced_at = timestamp();
    row.last_error = null;
    const [path, rel] = freezeArtifact(workPath, workRel, payload);
    row.evidence_path = rel;
    row.evidence_sha256 = digest;
    if (!("recoveries" in approval)) approval.recoveries = [];
    approval.recoveries.push(previous);
    if (approvalLive) approval.verified_evidence_sha256 = digest;
    else {
      approval.verification = "write-rejected";
      delete approval.verified_evidence_sha256;
    }
    row.approval = approval;
    let [action, reasons]: [string, string[]] = evaluate(row);
    if (approvalLive && action === "approve") {
      action = "approved";
      row.status = "approved";
      chmodSync(path, 0o444);
    } else row.status = STATUS_FOR_ACTION[action] ?? "queued";
    row.decision = { action, reasons, at: timestamp() };
    writeLedger(args.ledger, rows);
    return { action, outcome, reasons, url: row.url };
  });
  if (out) printJson(out);
}

export function monitorTick(ledger: string): Event[] {
  const marker = join(dirname(resolve(ledger)), "logs", "sync-outage.json");
  const prior = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
  const now = Date.now();
  const apply = outageProbeDue(prior, now) ? prefetchSync(readLedger(ledger), (url) => ghView(url, 15)) : () => [];
  return withLedgerLock(ledger, () => {
    const rows = readLedger(ledger);
    const { events, outage } = monitorWithOutage(prior, now, () => apply(rows));
    if (outage) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, JSON.stringify(outage));
    } else if (prior) rmSync(marker, { force: true });
    writeLedger(ledger, rows);
    return events;
  });
}

export function commandMonitor(args: Args): void {
  for (const event of monitorTick(args.ledger)) printJson(event);
}
