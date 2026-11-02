import { readFileSync, existsSync } from "node:fs";
import { org } from "./lib/org.ts";
import type { Card } from "../webui/dashboard.ts";

export const SCHEMA_VERSION = 1;
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
export const ALL_STATUSES = new Set([...ACTIVE_STATUSES, "completed", "closed"]);
const PR_URL_RE =
  /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>[1-9][0-9]*)\/?$/;
const REQUIRED = [
  "schema_version",
  "repository",
  "pr_number",
  "url",
  "status",
  "priority",
  "added_at",
];

export type Row = Record<string, any>;

export class LedgerError extends Error {}

export function parsePrUrl(url: string): [string, number] {
  const m = PR_URL_RE.exec(url);
  if (!m?.groups) throw new LedgerError(`invalid GitHub pull request URL: ${url}`);
  if (m.groups.owner !== org())
    throw new LedgerError(`this workspace is restricted to ${org()} pull requests`);
  return [`${m.groups.owner}/${m.groups.repo}`, Number(m.groups.number)];
}

export function validateRow(row: unknown, where = "ledger row"): asserts row is Row {
  if (typeof row !== "object" || row === null || Array.isArray(row))
    throw new LedgerError(`${where}: row must be an object`);
  const r = row as Row;
  const missing = REQUIRED.filter((k) => !(k in r)).sort();
  if (missing.length) throw new LedgerError(`${where}: missing fields: ${missing.join(", ")}`);
  const [repository, number] = parsePrUrl(r.url);
  if (r.schema_version !== SCHEMA_VERSION)
    throw new LedgerError(`${where}: unsupported schema_version`);
  if (r.repository !== repository || r.pr_number !== number)
    throw new LedgerError(`${where}: repository or pr_number does not match URL`);
  if (!ALL_STATUSES.has(r.status)) throw new LedgerError(`${where}: invalid status: ${r.status}`);
}

export function parseLedger(text: string, path = "ledger"): Row[] {
  const rows: Row[] = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch (e) {
      throw new LedgerError(`${path}:${i + 1}: invalid JSON: ${(e as Error).message}`);
    }
    validateRow(row, `${path}:${i + 1}`);
    rows.push(row);
  });
  if (new Set(rows.map((r) => r.url)).size !== rows.length)
    throw new LedgerError(`${path}: duplicate pull request URL`);
  return rows;
}

export function readLedger(path: string): Row[] {
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8"), path) : [];
}

export function toCard(row: Row): Card {
  return {
    url: row.url,
    repository: row.repository,
    pr_number: row.pr_number,
    status: row.status,
    priority: row.priority ?? null,
    title: row.live?.title ?? null,
    author: row.live?.author?.login ?? null,
    action: row.decision?.action ?? null,
    last_error: row.last_error ?? null,
    updated_at: row.last_synced_at ?? null,
    added_at: row.added_at ?? null,
    approved_at: row.approval?.approved_at ?? null,
    changes_requested_at: row.change_request?.submitted_at ?? null,
    merged_at: row.delivery?.merge?.merged_at ?? null,
    completed_at: row.delivery?.completed_at ?? null,
  };
}
