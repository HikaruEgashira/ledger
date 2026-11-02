#!/usr/bin/env python3
"""Record and close merge-to-release delivery lifecycle receipts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import ledger_core as core

RECEIPT_TYPES = {"release", "observation", "incident", "recovery", "postmortem"}
RECOVERY_STRATEGIES = {
    "rollback",
    "feature-flag",
    "hotfix",
    "compatibility",
    "redeploy",
}
POST_MERGE_DISPATCH_STATUSES = core.POST_MERGE_STATUSES - {"completed"}


def nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise core.ReviewCtlError(f"{field} must be a non-empty string")
    return value


def string_list(value: Any, field: str, *, allow_empty: bool = False) -> list[str]:
    core.require_string_list(value, field, allow_empty=allow_empty)
    return value


def merge_info(row: dict[str, Any]) -> tuple[str, dt.datetime]:
    merge = (row.get("delivery") or {}).get("merge") or {}
    commit_sha = merge.get("commit_sha")
    if not isinstance(commit_sha, str) or not core.SHA_RE.fullmatch(commit_sha):
        raise core.ReviewCtlError("a verified merge commit is required")
    merged_at = core.parse_time(merge.get("merged_at"))
    if merged_at > core.utc_now() + dt.timedelta(minutes=1):
        raise core.ReviewCtlError("merge timestamp is in the future")
    return commit_sha, merged_at


def approved_plan(row: dict[str, Any]) -> dict[str, Any]:
    approval = row.get("approval")
    if not isinstance(approval, dict):
        raise core.ReviewCtlError("a frozen approval delivery plan is required")
    delivery_plan = approval.get("delivery_plan")
    expected_digest = approval.get("delivery_plan_sha256")
    if not isinstance(delivery_plan, dict) or not isinstance(expected_digest, str):
        raise core.ReviewCtlError("the frozen approval delivery plan is incomplete")
    if not all(
        isinstance(approval.get(field), str)
        and core.SHA_RE.fullmatch(approval[field])
        for field in ("base_sha", "head_sha")
    ):
        raise core.ReviewCtlError("the frozen approval refs are invalid")
    core.validate_delivery_plan(delivery_plan)
    if core.delivery_plan_digest(delivery_plan) != expected_digest:
        raise core.ReviewCtlError("the frozen approval delivery plan was modified")
    return delivery_plan


def load_plan_correction(entry: dict[str, Any]) -> dict[str, Any]:
    relative = entry.get("path")
    digest = entry.get("sha256")
    if not isinstance(relative, str) or not isinstance(digest, str):
        raise core.ReviewCtlError("delivery plan correction entry is incomplete")
    path = (core.ROOT / relative).resolve()
    try:
        path.relative_to(core.ROOT.resolve())
    except ValueError as exc:
        raise core.ReviewCtlError(
            "delivery plan correction path escapes workspace"
        ) from exc
    try:
        payload = path.read_bytes()
        correction = json.loads(payload)
    except (OSError, json.JSONDecodeError) as exc:
        raise core.ReviewCtlError(
            f"cannot read delivery plan correction {relative}: {exc}"
        ) from exc
    if hashlib.sha256(payload).hexdigest() != digest:
        raise core.ReviewCtlError(f"delivery plan correction changed: {relative}")
    return correction


def validate_plan_correction(
    correction: Any,
    row: dict[str, Any],
    previous_plan: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(correction, dict):
        raise core.ReviewCtlError("delivery plan correction must be an object")
    required = {
        "schema_version",
        "url",
        "type",
        "observed_at",
        "merge_sha",
        "approval_base_sha",
        "approval_head_sha",
        "previous_delivery_plan_sha256",
        "reason_code",
        "delivery_plan",
        "evidence",
    }
    missing = sorted(required - correction.keys())
    if missing:
        raise core.ReviewCtlError(
            "delivery plan correction missing: " + ", ".join(missing)
        )
    if correction["schema_version"] != core.SCHEMA_VERSION:
        raise core.ReviewCtlError(
            "unsupported delivery plan correction schema_version"
        )
    if correction["url"].rstrip("/") != row["url"]:
        raise core.ReviewCtlError(
            "delivery plan correction URL does not match the ledger"
        )
    if correction["type"] != "delivery_plan_correction":
        raise core.ReviewCtlError("invalid delivery plan correction type")
    observed_at = core.parse_time(correction["observed_at"])
    merge_sha, merged_at = merge_info(row)
    if observed_at > core.utc_now() + dt.timedelta(minutes=1):
        raise core.ReviewCtlError("delivery plan correction timestamp is in the future")
    if observed_at < merged_at:
        raise core.ReviewCtlError("delivery plan correction predates the merge")
    if correction["merge_sha"] != merge_sha:
        raise core.ReviewCtlError("delivery plan correction merge SHA does not match")
    approval = row.get("approval") or {}
    if (
        correction["approval_base_sha"] != approval.get("base_sha")
        or correction["approval_head_sha"] != approval.get("head_sha")
    ):
        raise core.ReviewCtlError(
            "delivery plan correction approval refs do not match"
        )
    previous_digest = core.delivery_plan_digest(previous_plan)
    if correction["previous_delivery_plan_sha256"] != previous_digest:
        raise core.ReviewCtlError(
            "delivery plan correction does not match the frozen plan"
        )
    if correction["reason_code"] != "incorrect-release-path":
        raise core.ReviewCtlError("unsupported delivery plan correction reason")
    string_list(correction["evidence"], "delivery plan correction evidence")
    effective_plan = correction["delivery_plan"]
    core.validate_delivery_plan(effective_plan)
    if core.delivery_plan_digest(effective_plan) == previous_digest:
        raise core.ReviewCtlError("delivery plan correction does not change the plan")
    if (
        effective_plan["release"].get("environment")
        != previous_plan["release"].get("environment")
    ):
        raise core.ReviewCtlError(
            "delivery plan correction cannot change the release environment"
        )
    if effective_plan["monitoring"] != previous_plan["monitoring"]:
        raise core.ReviewCtlError(
            "delivery plan correction cannot change monitoring requirements"
        )
    previous_recovery = previous_plan["recovery"]
    effective_recovery = effective_plan["recovery"]
    for field in ("preferred_strategy", "human_boundaries"):
        if effective_recovery[field] != previous_recovery[field]:
            raise core.ReviewCtlError(
                f"delivery plan correction cannot change recovery {field}"
            )
    return effective_plan


def plan(row: dict[str, Any]) -> dict[str, Any]:
    previous_plan = approved_plan(row)
    correction_entry = (row.get("delivery") or {}).get("plan_correction")
    if correction_entry is None:
        return previous_plan
    if not isinstance(correction_entry, dict):
        raise core.ReviewCtlError("delivery plan correction entry is invalid")
    correction = load_plan_correction(correction_entry)
    effective_plan = validate_plan_correction(correction, row, previous_plan)
    if (
        correction_entry.get("previous_delivery_plan_sha256")
        != core.delivery_plan_digest(previous_plan)
        or correction_entry.get("effective_delivery_plan_sha256")
        != core.delivery_plan_digest(effective_plan)
    ):
        raise core.ReviewCtlError("delivery plan correction ledger binding is invalid")
    return effective_plan


def validate_common(
    receipt: Any,
    expected_url: str,
    expected_merge_sha: str,
    merged_at: dt.datetime,
) -> tuple[str, dt.datetime]:
    if not isinstance(receipt, dict):
        raise core.ReviewCtlError("delivery receipt must be an object")
    required = {"schema_version", "url", "type", "observed_at", "merge_sha"}
    missing = sorted(required - receipt.keys())
    if missing:
        raise core.ReviewCtlError("delivery receipt missing: " + ", ".join(missing))
    if receipt["schema_version"] != core.SCHEMA_VERSION:
        raise core.ReviewCtlError("unsupported delivery receipt schema_version")
    if receipt["url"].rstrip("/") != expected_url:
        raise core.ReviewCtlError("delivery receipt URL does not match the ledger")
    receipt_type = receipt["type"]
    if receipt_type not in RECEIPT_TYPES:
        raise core.ReviewCtlError("invalid delivery receipt type")
    observed = core.parse_time(receipt["observed_at"])
    if observed > core.utc_now() + dt.timedelta(minutes=1):
        raise core.ReviewCtlError("delivery receipt timestamp is in the future")
    if observed < merged_at:
        raise core.ReviewCtlError("delivery receipt predates the merge")
    if receipt["merge_sha"] != expected_merge_sha:
        raise core.ReviewCtlError("delivery receipt merge SHA does not match")
    return receipt_type, observed


def repository_path(row: dict[str, Any]) -> Path:
    path = core.ROOT / "repositories" / row["repository"]
    if not (path / ".git").exists():
        path = Path.home() / "ghq" / "github.com" / row["repository"]
    if not (path / ".git").exists():
        raise core.ReviewCtlError(
            f"local repository is unavailable: {path}; create an authenticated "
            "checkout with standard Git tooling"
        )
    return path


def verify_release_ancestry(
    row: dict[str, Any], expected_merge_sha: str, release_commit_sha: str
) -> None:
    path = repository_path(row)
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(path),
                "merge-base",
                "--is-ancestor",
                expected_merge_sha,
                release_commit_sha,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired as exc:
        raise core.ReviewCtlError("release ancestry verification timed out") from exc
    if result.returncode == 1:
        raise core.ReviewCtlError(
            "release commit does not contain the reviewed merge commit"
        )
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise core.ReviewCtlError(
            "release ancestry could not be verified from the local repository"
            + (f": {detail}" if detail else "")
        )


def github_run(row: dict[str, Any], run_id: str, attempt: int) -> dict[str, Any]:
    if not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise core.ReviewCtlError(
            "GitHub Actions release_id must be the numeric workflow run ID"
        )
    try:
        result = subprocess.run(
            [
                "gh",
                "run",
                "view",
                run_id,
                "--attempt",
                str(attempt),
                "--repo",
                row["repository"],
                "--json",
                ("attempt,conclusion,databaseId,headSha,status,url,workflowName"),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise core.ReviewCtlError("GitHub Actions run verification timed out") from exc
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise core.ReviewCtlError(
            "GitHub Actions run verification failed" + (f": {detail}" if detail else "")
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise core.ReviewCtlError(
            "GitHub Actions run response was not valid JSON"
        ) from exc
    if not isinstance(payload, dict):
        raise core.ReviewCtlError("GitHub Actions run response was invalid")
    return payload


def validate_release(
    receipt: dict[str, Any],
    delivery_plan: dict[str, Any],
    row: dict[str, Any],
    expected_merge_sha: str,
) -> None:
    if delivery_plan["release"]["mode"] == "not_applicable":
        raise core.ReviewCtlError(
            "a not_applicable delivery plan cannot have release receipts"
        )
    status = receipt.get("status")
    if status not in {"started", "succeeded", "failed"}:
        raise core.ReviewCtlError(
            "release status must be started, succeeded, or failed"
        )
    release_id = nonempty(receipt.get("release_id"), "release_id")
    release_identifier = nonempty(
        receipt.get("release_identifier"), "release_identifier"
    )
    expected_identifier = delivery_plan["release"]["identifier"]
    if release_identifier != expected_identifier:
        raise core.ReviewCtlError(
            "release identifier does not match the frozen delivery plan"
        )
    environment = nonempty(receipt.get("environment"), "environment")
    if environment != delivery_plan["release"]["environment"]:
        raise core.ReviewCtlError(
            "release environment does not match the frozen delivery plan"
        )
    commit_sha = receipt.get("commit_sha")
    if not isinstance(commit_sha, str) or not core.SHA_RE.fullmatch(commit_sha):
        raise core.ReviewCtlError("release commit_sha must be a 40-hex SHA")
    string_list(receipt.get("evidence"), "release evidence")
    release_url = nonempty(receipt.get("release_url"), "release_url")

    if delivery_plan["release"]["mode"] == "github-actions":
        release_attempt = receipt.get("release_attempt")
        if (
            not isinstance(release_attempt, int)
            or isinstance(release_attempt, bool)
            or release_attempt < 1
        ):
            raise core.ReviewCtlError(
                "GitHub Actions release_attempt must be a positive integer"
            )
        run = github_run(row, release_id, release_attempt)
        if str(run.get("databaseId")) != release_id:
            raise core.ReviewCtlError("GitHub Actions run ID does not match")
        if run.get("attempt") != release_attempt:
            raise core.ReviewCtlError("GitHub Actions run attempt does not match")
        if run.get("workflowName") != expected_identifier:
            raise core.ReviewCtlError(
                "GitHub Actions workflow does not match the frozen release identifier"
            )
        if run.get("headSha") != commit_sha:
            raise core.ReviewCtlError(
                "release commit does not match the GitHub Actions run head SHA"
            )
        if run.get("url") != release_url:
            raise core.ReviewCtlError(
                "release URL does not match the GitHub Actions run"
            )
        if status == "succeeded" and (
            run.get("status") != "completed" or run.get("conclusion") != "success"
        ):
            raise core.ReviewCtlError(
                "GitHub Actions run is not completed successfully"
            )
        if status == "failed" and (
            run.get("status") != "completed"
            or run.get("conclusion") in {None, "success"}
        ):
            raise core.ReviewCtlError(
                "GitHub Actions run does not confirm a failed release"
            )

    if status == "succeeded":
        verify_release_ancestry(row, expected_merge_sha, commit_sha)


def validate_observation(
    receipt: dict[str, Any],
    delivery_plan: dict[str, Any],
    observed: dt.datetime,
    merged_at: dt.datetime,
) -> None:
    if delivery_plan["release"]["mode"] == "not_applicable":
        raise core.ReviewCtlError(
            "a not_applicable delivery plan cannot have observation receipts"
        )
    if receipt.get("phase") not in {"post_release", "post_recovery"}:
        raise core.ReviewCtlError(
            "observation phase must be post_release or post_recovery"
        )
    if receipt.get("status") not in {"healthy", "degraded"}:
        raise core.ReviewCtlError("observation status must be healthy or degraded")
    started = core.parse_time(receipt.get("started_at"))
    ended = core.parse_time(receipt.get("ended_at"))
    if started < merged_at:
        raise core.ReviewCtlError("observation started before the merge")
    if ended < started:
        raise core.ReviewCtlError("observation ended_at precedes started_at")
    if ended > core.utc_now() + dt.timedelta(minutes=1):
        raise core.ReviewCtlError("observation ended_at is in the future")
    if observed < ended:
        raise core.ReviewCtlError("observation observed_at precedes ended_at")
    if receipt.get("log_source") != "siem":
        raise core.ReviewCtlError("observation log_source must be siem")
    issues = receipt.get("issues")
    if not isinstance(issues, list) or any(
        not isinstance(issue, str) or not issue.strip() for issue in issues
    ):
        raise core.ReviewCtlError(
            "observation issues must be a list of non-empty strings"
        )
    signals = receipt.get("signals")
    if not isinstance(signals, list):
        raise core.ReviewCtlError("observation signals must be a list")
    planned_names = {
        signal["name"] for signal in delivery_plan["monitoring"]["signals"]
    }
    observed_names: set[str] = set()
    for signal in signals:
        if not isinstance(signal, dict):
            raise core.ReviewCtlError("each observed signal must be an object")
        name = nonempty(signal.get("name"), "signal name")
        if name in observed_names:
            raise core.ReviewCtlError("observation signal names must be unique")
        observed_names.add(name)
        if signal.get("source") != "siem":
            raise core.ReviewCtlError("observation signal source must be siem")
        if not isinstance(signal.get("healthy"), bool):
            raise core.ReviewCtlError("signal healthy must be boolean")
        nonempty(signal.get("evidence"), "signal evidence")
    if observed_names != planned_names:
        missing = sorted(planned_names - observed_names)
        unexpected = sorted(observed_names - planned_names)
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if unexpected:
            details.append("unexpected: " + ", ".join(unexpected))
        raise core.ReviewCtlError(
            "observation signals do not match the frozen plan ("
            + "; ".join(details)
            + ")"
        )
    if receipt["status"] == "healthy":
        if issues:
            raise core.ReviewCtlError(
                "healthy observation must not contain issues"
            )
        if any(not signal["healthy"] for signal in signals):
            raise core.ReviewCtlError(
                "healthy observation contains an unhealthy signal"
            )
        required = dt.timedelta(
            minutes=max(30, delivery_plan["monitoring"]["window_minutes"])
        )
        if ended - started < required:
            raise core.ReviewCtlError("healthy observation window is too short")
    else:
        if not issues:
            raise core.ReviewCtlError(
                "degraded observation must contain at least one issue"
            )
        if not any(not signal["healthy"] for signal in signals):
            raise core.ReviewCtlError(
                "degraded observation must contain an unhealthy signal"
            )


def validate_incident(receipt: dict[str, Any]) -> None:
    if receipt.get("severity") not in {"SEV1", "SEV2", "SEV3", "SEV4"}:
        raise core.ReviewCtlError("incident severity must be SEV1..SEV4")
    nonempty(receipt.get("impact"), "incident impact")
    string_list(receipt.get("signals"), "incident signals")
    string_list(receipt.get("containment_actions"), "incident containment_actions")
    if not isinstance(receipt.get("suspected_release"), bool):
        raise core.ReviewCtlError("incident suspected_release must be boolean")


def validate_recovery(
    receipt: dict[str, Any],
    delivery_plan: dict[str, Any],
    observed: dt.datetime,
    merged_at: dt.datetime,
) -> None:
    if delivery_plan["recovery"]["preferred_strategy"] == "not_applicable":
        raise core.ReviewCtlError(
            "a not_applicable recovery plan cannot have recovery receipts"
        )
    strategy = receipt.get("strategy")
    if strategy not in RECOVERY_STRATEGIES:
        raise core.ReviewCtlError("invalid recovery strategy")
    status = receipt.get("status")
    if status not in {"started", "succeeded", "failed"}:
        raise core.ReviewCtlError(
            "recovery status must be started, succeeded, or failed"
        )
    started = core.parse_time(receipt.get("started_at"))
    if started < merged_at:
        raise core.ReviewCtlError("recovery started before the merge")
    if started > core.utc_now() + dt.timedelta(minutes=1):
        raise core.ReviewCtlError("recovery started_at is in the future")
    if status == "started":
        if receipt.get("completed_at") is not None:
            raise core.ReviewCtlError("started recovery must not include completed_at")
        if observed < started:
            raise core.ReviewCtlError("recovery observed_at precedes started_at")
    else:
        completed = core.parse_time(receipt.get("completed_at"))
        if completed < started:
            raise core.ReviewCtlError("recovery completed_at precedes started_at")
        if completed > core.utc_now() + dt.timedelta(minutes=1):
            raise core.ReviewCtlError("recovery completed_at is in the future")
        if observed < completed:
            raise core.ReviewCtlError("recovery observed_at precedes completed_at")
    string_list(receipt.get("actions"), "recovery actions")
    string_list(receipt.get("verification"), "recovery verification")
    string_list(receipt.get("evidence"), "recovery evidence")
    preferred = delivery_plan["recovery"]["preferred_strategy"]
    if strategy != preferred:
        nonempty(receipt.get("deviation_reason"), "recovery deviation_reason")


def validate_postmortem(receipt: dict[str, Any]) -> None:
    nonempty(receipt.get("path_or_url"), "postmortem path_or_url")
    nonempty(receipt.get("root_cause"), "postmortem root_cause")
    string_list(receipt.get("actions"), "postmortem actions")


def validate_receipt(
    receipt: Any, row: dict[str, Any], delivery_plan: dict[str, Any]
) -> tuple[str, dt.datetime]:
    expected_merge_sha, merged_at = merge_info(row)
    receipt_type, observed = validate_common(
        receipt,
        row["url"],
        expected_merge_sha,
        merged_at,
    )
    if delivery_plan["release"]["mode"] == "not_applicable":
        raise core.ReviewCtlError(
            "a not_applicable delivery plan cannot have delivery receipts"
        )
    validators = {
        "release": lambda: validate_release(
            receipt, delivery_plan, row, expected_merge_sha
        ),
        "observation": lambda: validate_observation(
            receipt, delivery_plan, observed, merged_at
        ),
        "incident": lambda: validate_incident(receipt),
        "recovery": lambda: validate_recovery(
            receipt, delivery_plan, observed, merged_at
        ),
        "postmortem": lambda: validate_postmortem(receipt),
    }
    validators[receipt_type]()
    return receipt_type, observed


def receipt_summary(receipt: dict[str, Any]) -> dict[str, Any]:
    summary = {"type": receipt["type"], "observed_at": receipt["observed_at"]}
    for field in (
        "status",
        "phase",
        "severity",
        "strategy",
        "release_id",
        "release_attempt",
        "release_identifier",
    ):
        if field in receipt:
            summary[field] = receipt[field]
    return summary


def load_receipt(entry: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(entry, dict):
        raise core.ReviewCtlError("delivery receipt ledger entry is invalid")
    relative = entry.get("path")
    digest = entry.get("sha256")
    if not isinstance(relative, str) or not isinstance(digest, str):
        raise core.ReviewCtlError("delivery receipt ledger entry is incomplete")
    path = (core.ROOT / relative).resolve()
    try:
        path.relative_to(core.ROOT.resolve())
    except ValueError as exc:
        raise core.ReviewCtlError("delivery receipt path escapes workspace") from exc
    try:
        payload = path.read_bytes()
        receipt = json.loads(payload)
    except (OSError, json.JSONDecodeError) as exc:
        raise core.ReviewCtlError(
            f"cannot read delivery receipt {relative}: {exc}"
        ) from exc
    if hashlib.sha256(payload).hexdigest() != digest:
        raise core.ReviewCtlError(f"delivery receipt changed: {relative}")
    return receipt


def receipt_time(receipt: dict[str, Any]) -> dt.datetime:
    return core.parse_time(receipt["observed_at"])


def ordered(receipts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(receipts, key=receipt_time)


def derive_status(receipts: list[dict[str, Any]]) -> str:
    return core.derive_delivery_status(receipts)


def load_valid_receipts(
    row: dict[str, Any], delivery_plan: dict[str, Any]
) -> list[dict[str, Any]]:
    entries = (row.get("delivery") or {}).get("receipts", [])
    if not isinstance(entries, list):
        raise core.ReviewCtlError("delivery receipts ledger field is invalid")
    receipts = []
    seen_times: set[dt.datetime] = set()
    for entry in entries:
        receipt = load_receipt(entry)
        if entry.get("delivery_plan_sha256") != core.delivery_plan_digest(
            delivery_plan
        ):
            raise core.ReviewCtlError(
                "delivery receipt is bound to a different delivery plan"
            )
        _, observed = validate_receipt(receipt, row, delivery_plan)
        if observed in seen_times:
            raise core.ReviewCtlError(
                "delivery receipt observed_at timestamps must be unique"
            )
        seen_times.add(observed)
        receipts.append(receipt)
    return ordered(receipts)


def command_due(args: argparse.Namespace) -> None:
    for row in core.read_ledger(args.ledger):
        if row["status"] in POST_MERGE_DISPATCH_STATUSES:
            core.print_json(
                {
                    "status": row["status"],
                    "url": row["url"],
                    "merge": (row.get("delivery") or {}).get("merge"),
                }
            )


def github_release_runs(row: dict[str, Any], workflow: str) -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                "gh",
                "run",
                "list",
                "--repo",
                row["repository"],
                "--workflow",
                workflow,
                "--limit",
                "50",
                "--json",
                "attempt,conclusion,createdAt,databaseId,headSha,status,updatedAt,url",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise core.ReviewCtlError("GitHub Actions run listing timed out") from exc
    if result.returncode:
        raise core.ReviewCtlError(
            "GitHub Actions run listing failed: " + result.stderr.strip()
        )
    try:
        runs = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise core.ReviewCtlError("GitHub Actions run list was not valid JSON") from exc
    return runs if isinstance(runs, list) else []


def fetch_repository(row: dict[str, Any], fetched: set[str]) -> None:
    if row["repository"] in fetched:
        return
    result = subprocess.run(
        ["git", "-C", str(repository_path(row)), "fetch", "--quiet", "origin"],
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode:
        raise core.ReviewCtlError("repository fetch failed: " + result.stderr.strip())
    fetched.add(row["repository"])


def release_receipt(
    row: dict[str, Any],
    delivery_plan: dict[str, Any],
    merge_sha: str,
    run: dict[str, Any],
    status: str,
    observed_at: str,
) -> dict[str, Any]:
    return {
        "schema_version": core.SCHEMA_VERSION,
        "url": row["url"],
        "type": "release",
        "observed_at": observed_at,
        "merge_sha": merge_sha,
        "status": status,
        "release_id": str(run["databaseId"]),
        "release_attempt": run["attempt"],
        "release_identifier": delivery_plan["release"]["identifier"],
        "environment": delivery_plan["release"]["environment"],
        "commit_sha": run["headSha"],
        "release_url": f"{run['url']}/attempts/{run['attempt']}",
        "evidence": [f"GitHub Actions run {run['url']} ({run.get('conclusion') or run['status']})"],
    }


def write_and_record(ledger: Path, row: dict[str, Any], receipt: dict[str, Any]) -> None:
    directory = core.ROOT / "delivery-artifacts"
    directory.mkdir(exist_ok=True)
    name = row["url"].removeprefix("https://github.com/").replace("/", "--")
    path = directory / f"{name}--release-{receipt['status']}-{receipt['release_id']}.json"
    path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    command_record(argparse.Namespace(ledger=ledger, url=row["url"], receipt=str(path)))


def auto_release(ledger: Path, row: dict[str, Any], delivery_plan: dict[str, Any], fetched: set[str]) -> bool:
    """Records release receipts for the first frozen-workflow run containing the merge."""
    merge_sha, merged_at = merge_info(row)
    entries = (row.get("delivery") or {}).get("receipts") or []
    started = [e for e in entries if e.get("type") == "release" and e.get("status") == "started"]
    if len(entries) > len(started) or len(started) > 1:
        return False
    fetch_repository(row, fetched)
    runs = sorted(
        (
            r
            for r in github_release_runs(row, delivery_plan["release"]["identifier"])
            if core.parse_time(r["createdAt"]) >= merged_at
        ),
        key=lambda r: r["createdAt"],
    )
    for run in runs:
        if started and str(run["databaseId"]) != started[0].get("release_id"):
            continue
        try:
            verify_release_ancestry(row, merge_sha, run["headSha"])
        except core.ReviewCtlError:
            continue
        if not started:
            write_and_record(
                ledger, row, release_receipt(row, delivery_plan, merge_sha, run, "started", run["createdAt"])
            )
        if run["status"] != "completed":
            return True
        final = "succeeded" if run["conclusion"] == "success" else "failed"
        write_and_record(
            ledger, row, release_receipt(row, delivery_plan, merge_sha, run, final, run["updatedAt"])
        )
        return final == "succeeded"
    return bool(started)


def command_due_auto(args: argparse.Namespace) -> None:
    fetched: set[str] = set()
    for row in core.read_ledger(args.ledger):
        if row["status"] not in POST_MERGE_DISPATCH_STATUSES:
            continue
        mode = None
        try:
            delivery_plan = plan(row)
            mode = delivery_plan["release"]["mode"]
            if mode == "not_applicable" and row["status"] == "merged_waiting_release":
                command_complete(argparse.Namespace(ledger=args.ledger, url=row["url"]))
                continue
            if (
                mode == "github-actions"
                and row["status"] in {"merged_waiting_release", "release_in_progress"}
                and auto_release(args.ledger, row, delivery_plan, fetched)
            ):
                continue
        except core.ReviewCtlError as exc:
            if blocker_unchanged(args.ledger, row["url"], str(exc)):
                continue
            core.print_json({"status": row["status"], "url": row["url"], "blocker": str(exc)})
            continue
        except SystemExit:
            pass
        current = core.find_row(core.read_ledger(args.ledger), row["url"])
        # A GitHub Actions release not yet started has no agent work until a run appears.
        if mode == "github-actions" and current["status"] == "merged_waiting_release":
            continue
        core.print_json(
            {
                "status": current["status"],
                "url": current["url"],
                "merge": (current.get("delivery") or {}).get("merge"),
            }
        )


def blocker_unchanged(ledger: Path, url: str, message: str) -> bool:
    """Persists a deterministic blocker so an unchanged one is not dispatched again."""
    with core.ledger_lock(ledger):
        rows = core.read_ledger(ledger)
        row = core.find_row(rows, url)
        if row.get("last_error") == message:
            return True
        row["last_error"] = message
        core.write_ledger(ledger, rows)
    return False


def command_replan(args: argparse.Namespace) -> None:
    path, relative = core.resolve_artifact_path(args.correction)
    try:
        payload = path.read_bytes()
        correction = json.loads(payload)
    except (OSError, json.JSONDecodeError) as exc:
        raise core.ReviewCtlError(
            f"cannot read delivery plan correction: {exc}"
        ) from exc

    with core.ledger_lock(args.ledger):
        rows = core.read_ledger(args.ledger)
        row = core.find_row(rows, args.url)
        previous_plan = approved_plan(row)
        merge_info(row)
        digest = hashlib.sha256(payload).hexdigest()
        delivery = row.setdefault("delivery", {})
        existing = delivery.get("plan_correction")
        if existing is not None:
            if isinstance(existing, dict) and existing.get("sha256") == digest:
                plan(row)
                core.print_json({"action": "already_replanned", "url": row["url"]})
                return
            raise core.ReviewCtlError("a different delivery plan correction exists")
        if row["status"] != "merged_waiting_release":
            raise core.ReviewCtlError(
                "delivery plan correction requires merged_waiting_release"
            )
        receipts = delivery.get("receipts", [])
        if not isinstance(receipts, list):
            raise core.ReviewCtlError("delivery receipts ledger field is invalid")
        if receipts:
            raise core.ReviewCtlError(
                "delivery plan cannot be corrected after recording a receipt"
            )
        effective_plan = validate_plan_correction(correction, row, previous_plan)
        delivery["plan_correction"] = {
            "path": relative,
            "sha256": digest,
            "recorded_at": core.timestamp(),
            "reason_code": correction["reason_code"],
            "previous_delivery_plan_sha256": core.delivery_plan_digest(
                previous_plan
            ),
            "effective_delivery_plan_sha256": core.delivery_plan_digest(
                effective_plan
            ),
        }
        row["last_error"] = None
        core.write_ledger(args.ledger, rows)
    core.print_json({"action": "replanned", "url": row["url"]})


def command_record(args: argparse.Namespace) -> None:
    path, relative = core.resolve_artifact_path(args.receipt)
    try:
        payload = path.read_bytes()
        receipt = json.loads(payload)
    except (OSError, json.JSONDecodeError) as exc:
        raise core.ReviewCtlError(f"cannot read delivery receipt: {exc}") from exc

    with core.ledger_lock(args.ledger):
        rows = core.read_ledger(args.ledger)
        row = core.find_row(rows, args.url)
        delivery_plan = plan(row)
        receipt_type, observed = validate_receipt(receipt, row, delivery_plan)
        existing_receipts = load_valid_receipts(row, delivery_plan)
        digest = hashlib.sha256(payload).hexdigest()
        delivery = row.setdefault("delivery", {})
        entries = delivery.setdefault("receipts", [])
        if any(entry["sha256"] == digest for entry in entries):
            core.print_json({"action": "already_recorded", "url": row["url"]})
            return
        if observed in {receipt_time(item) for item in existing_receipts}:
            raise core.ReviewCtlError(
                "delivery receipt observed_at timestamps must be unique"
            )
        entries.append(
            {
                "path": relative,
                "sha256": digest,
                "recorded_at": core.timestamp(),
                "delivery_plan_sha256": core.delivery_plan_digest(delivery_plan),
                **receipt_summary(receipt),
            }
        )
        row["status"] = derive_status([*existing_receipts, receipt])
        delivery.pop("completed_at", None)
        delivery.pop("completion_sha256", None)
        delivery.pop("completion_sequence", None)
        row["last_error"] = None
        core.write_ledger(args.ledger, rows)
    core.print_json(
        {"action": "recorded", "receipt_type": receipt_type, "url": row["url"]}
    )


def latest_receipt(
    receipts: list[dict[str, Any]], predicate: Any
) -> dict[str, Any] | None:
    matching = [receipt for receipt in receipts if predicate(receipt)]
    return max(matching, key=receipt_time) if matching else None


def completion_gaps(
    receipts: list[dict[str, Any]], delivery_plan: dict[str, Any]
) -> tuple[list[str], list[dict[str, Any]]]:
    gaps: list[str] = []
    if delivery_plan["release"]["mode"] == "not_applicable":
        if receipts:
            gaps.append("not_applicable delivery plan has delivery receipts")
        return gaps, []

    latest_release = latest_receipt(
        receipts, lambda receipt: receipt["type"] == "release"
    )
    if latest_release is None:
        return ["successful release"], []
    if latest_release["status"] != "succeeded":
        gaps.append("latest release receipt is not succeeded")

    release_at = receipt_time(latest_release)
    matching_starts = [
        receipt
        for receipt in receipts
        if receipt["type"] == "release"
        and receipt["status"] == "started"
        and receipt_time(receipt) < release_at
        and receipt.get("release_id") == latest_release.get("release_id")
        and receipt.get("release_attempt") == latest_release.get("release_attempt")
        and receipt.get("release_identifier")
        == latest_release.get("release_identifier")
        and receipt.get("environment") == latest_release.get("environment")
        and receipt.get("commit_sha") == latest_release.get("commit_sha")
    ]
    if not matching_starts:
        gaps.append("matching release started receipt")
    adverse = [
        receipt
        for receipt in receipts
        if (receipt["type"] == "release" and receipt["status"] == "failed")
        or (receipt["type"] == "observation" and receipt["status"] == "degraded")
        or receipt["type"] == "incident"
    ]
    observations = [receipt for receipt in receipts if receipt["type"] == "observation"]

    if not adverse:
        after_release = [
            receipt for receipt in observations if receipt_time(receipt) >= release_at
        ]
        latest_observation = (
            max(after_release, key=receipt_time) if after_release else None
        )
        if (
            latest_observation is None
            or latest_observation["status"] != "healthy"
            or latest_observation["phase"] != "post_release"
        ):
            gaps.append("latest post-release observation is not healthy")
        elif core.parse_time(latest_observation["started_at"]) < release_at:
            gaps.append("post-release observation started before release success")
        return gaps, [latest_release, *(after_release[-1:] if after_release else [])]

    latest_adverse = max(adverse, key=receipt_time)
    incidents = [receipt for receipt in receipts if receipt["type"] == "incident"]
    if not incidents:
        gaps.append("incident impact and containment receipt")

    recoveries_after = [
        receipt
        for receipt in receipts
        if receipt["type"] == "recovery"
        and receipt_time(receipt) > receipt_time(latest_adverse)
    ]
    latest_recovery = (
        max(recoveries_after, key=receipt_time) if recoveries_after else None
    )
    if latest_recovery is None or latest_recovery["status"] != "succeeded":
        gaps.append("latest recovery after the latest adverse event is not succeeded")
        return gaps, [latest_release, latest_adverse]

    recovery_completed = core.parse_time(latest_recovery["completed_at"])
    observation_floor = max(release_at, recovery_completed)
    after_recovery = [
        receipt
        for receipt in observations
        if receipt_time(receipt) >= observation_floor
    ]
    latest_observation = (
        max(after_recovery, key=receipt_time) if after_recovery else None
    )
    if (
        latest_observation is None
        or latest_observation["status"] != "healthy"
        or latest_observation["phase"] != "post_recovery"
    ):
        gaps.append("latest post-recovery observation is not healthy")
    elif core.parse_time(latest_observation["started_at"]) < observation_floor:
        gaps.append(
            "post-recovery observation started before final recovery and release"
        )

    if incidents:
        latest_incident = max(incidents, key=receipt_time)
        postmortem_floor = max(
            receipt_time(latest_incident),
            receipt_time(latest_recovery),
        )
        postmortems = [
            receipt
            for receipt in receipts
            if receipt["type"] == "postmortem"
            and receipt_time(receipt) > postmortem_floor
        ]
        if not postmortems:
            gaps.append("postmortem after the latest incident and recovery")

    sequence = [latest_release, latest_adverse, latest_recovery]
    if latest_observation:
        sequence.append(latest_observation)
    return gaps, sequence


def command_complete(args: argparse.Namespace) -> None:
    with core.ledger_lock(args.ledger):
        rows = core.read_ledger(args.ledger)
        row = core.find_row(rows, args.url)
        delivery_plan = plan(row)
        merge_info(row)
        if delivery_plan["release"]["mode"] == "not_applicable":
            receipts = []
            entries = (row.get("delivery") or {}).get("receipts", [])
            if entries:
                raise core.ReviewCtlError(
                    "not_applicable delivery cannot contain receipts"
                )
        else:
            receipts = load_valid_receipts(row, delivery_plan)
        gaps, sequence = completion_gaps(receipts, delivery_plan)
        if gaps:
            row["status"] = derive_status(receipts)
            core.write_ledger(args.ledger, rows)
            core.print_json(
                {"action": "incomplete", "missing": gaps, "url": row["url"]}
            )
            raise SystemExit(2)
        entries = (row.get("delivery") or {}).get("receipts", [])
        completion_payload = {
            "delivery_plan_sha256": core.delivery_plan_digest(delivery_plan),
            "merge_sha": merge_info(row)[0],
            "receipt_sha256": [entry["sha256"] for entry in entries],
            "sequence": [
                {
                    "type": receipt["type"],
                    "observed_at": receipt["observed_at"],
                    "status": receipt.get("status"),
                }
                for receipt in sequence
            ],
        }
        completion_digest = hashlib.sha256(
            json.dumps(
                completion_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        delivery = row.setdefault("delivery", {})
        if (
            row["status"] == "completed"
            and delivery.get("completion_sha256") == completion_digest
        ):
            core.print_json({"action": "already_completed", "url": row["url"]})
            return
        row["status"] = "completed"
        delivery["completed_at"] = core.timestamp()
        delivery["completion_sha256"] = completion_digest
        delivery["completion_sequence"] = completion_payload["sequence"]
        row["last_error"] = None
        core.write_ledger(args.ledger, rows)
    core.print_json({"action": "completed", "url": row["url"]})


def latest_adverse_entry(
    row: dict[str, Any], delivery_plan: dict[str, Any]
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    entries = (row.get("delivery") or {}).get("receipts", [])
    matching = []
    for entry in entries:
        receipt = load_receipt(entry)
        validate_receipt(receipt, row, delivery_plan)
        if (
            (receipt["type"] == "release" and receipt["status"] == "failed")
            or (receipt["type"] == "observation" and receipt["status"] == "degraded")
            or receipt["type"] == "incident"
        ):
            matching.append((entry, receipt))
    return (
        max(matching, key=lambda pair: receipt_time(pair[1]))
        if matching
        else (
            None,
            None,
        )
    )


def command_reconcile_dispatch(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", args.dispatch_sha256):
        raise core.ReviewCtlError("dispatch_sha256 must be a 64-hex SHA-256")
    evidence = nonempty(args.evidence, "reconciliation evidence")
    if len(evidence.encode()) > 8192:
        raise core.ReviewCtlError("reconciliation evidence is too large")
    if args.execute and args.ledger.resolve() != core.DEFAULT_LEDGER.resolve():
        raise core.ReviewCtlError(
            "executed dispatch reconciliation requires the workspace ledger"
        )
    with core.ledger_lock(args.ledger):
        rows = core.read_ledger(args.ledger)
        row = core.find_row(rows, args.url)
        dispatches = (row.get("delivery") or {}).get("dispatches", [])
        if not isinstance(dispatches, list):
            raise core.ReviewCtlError("post-merge dispatch ledger field is invalid")
        matches = [
            dispatch
            for dispatch in dispatches
            if dispatch.get("dispatch_sha256") == args.dispatch_sha256
            and dispatch.get("write_outcome") == "unknown"
            and not dispatch.get("delivered")
        ]
        if len(matches) != 1:
            raise core.ReviewCtlError(
                "no unique unknown post-merge dispatch is available to reconcile"
            )
        if not args.execute:
            core.print_json(
                {
                    "action": "dispatch_reconcile_not_written",
                    "execute": False,
                    "url": row["url"],
                }
            )
            return
        record = matches[0]
        record["write_outcome"] = "reconciled-not-written"
        record["reconciled_at"] = core.timestamp()
        record["reconciliation"] = {
            "outcome": "not-written",
            "evidence": evidence,
        }
        row["last_error"] = None
        core.write_ledger(args.ledger, rows)
    core.print_json({"action": "dispatch_reconciled_not_written", "url": row["url"]})


def command_dispatch(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", args.reviewer):
        raise core.ReviewCtlError("invalid GitHub reviewer login")
    if args.reason_code not in core.RECOVERY_HUMAN_REASON_CODES:
        raise core.ReviewCtlError("invalid post-merge human reason code")
    detail = nonempty(args.detail, "dispatch detail")
    if len(detail.encode()) > 8192:
        raise core.ReviewCtlError("dispatch detail is too large")
    if args.execute and args.ledger.resolve() != core.DEFAULT_LEDGER.resolve():
        raise core.ReviewCtlError(
            "executed post-merge dispatch requires the workspace ledger"
        )

    with core.ledger_lock(args.ledger):
        rows = core.read_ledger(args.ledger)
        row = core.find_row(rows, args.url)
        delivery_plan = plan(row)
        expected_merge_sha, _ = merge_info(row)
        boundaries = delivery_plan["recovery"]["human_boundaries"]
        if args.reason_code not in boundaries:
            raise core.ReviewCtlError(
                "reason code is not declared in the frozen recovery plan"
            )
        adverse_entry, adverse_receipt = latest_adverse_entry(row, delivery_plan)
        if args.reason_code == "human-only-production-authentication":
            if row["status"] not in POST_MERGE_DISPATCH_STATUSES:
                raise core.ReviewCtlError(
                    "production-authentication dispatch is not due"
                )
        else:
            if row["status"] != "recovering" or adverse_receipt is None:
                raise core.ReviewCtlError(
                    "recovery dispatch requires a current adverse event"
                )
            incidents = [
                receipt
                for receipt in load_valid_receipts(row, delivery_plan)
                if receipt["type"] == "incident"
            ]
            if not incidents:
                raise core.ReviewCtlError(
                    "record impact and containment before human dispatch"
                )

        anchor = adverse_entry["sha256"] if adverse_entry else expected_merge_sha
        dispatch_key = hashlib.sha256(
            json.dumps(
                {
                    "anchor": anchor,
                    "detail": detail,
                    "reason_code": args.reason_code,
                    "reviewer": args.reviewer,
                    "url": row["url"],
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        delivery = row.setdefault("delivery", {})
        dispatches = delivery.setdefault("dispatches", [])
        previous = next(
            (
                dispatch
                for dispatch in dispatches
                if dispatch.get("dispatch_sha256") == dispatch_key
            ),
            None,
        )
        if previous and previous.get("delivered"):
            core.print_json({"action": "already_dispatched", "url": row["url"]})
            return
        if previous and previous.get("write_outcome") == "unknown":
            raise core.ReviewCtlError(
                "post-merge dispatch outcome is unknown; reconcile before retrying"
            )
        if not args.execute:
            core.print_json(
                {
                    "action": "post_merge_human_required",
                    "execute": False,
                    "reason_code": args.reason_code,
                    "reviewer": args.reviewer,
                    "url": row["url"],
                }
            )
            return

        record = previous or {
            "dispatch_sha256": dispatch_key,
            "anchor_sha256": anchor,
            "reason_code": args.reason_code,
            "reviewer": args.reviewer,
            "detail": detail,
            "delivered": False,
        }
        if previous is None:
            dispatches.append(record)
        record["attempted_at"] = core.timestamp()
        record["write_outcome"] = "in_progress"
        core.write_ledger(args.ledger, rows)
        message = (
            f"@{args.reviewer} post-merge human decision required "
            f"(`{args.reason_code}`) for merge `{expected_merge_sha}`.\n\n"
            f"Needed: {detail}\n\n"
            "The agent is continuing safe containment and evidence collection."
        )
        try:
            result = core.gh_write(["pr", "comment", row["url"], "--body", message])
        except core.ReviewCtlError as exc:
            record["write_outcome"] = "unknown"
            row["last_error"] = (
                "post-merge dispatch comment outcome is unknown: " + str(exc)
            )
            core.write_ledger(args.ledger, rows)
            raise
        if result.returncode:
            message = (
                result.stderr.strip()
                or result.stdout.strip()
                or "GitHub comment command failed"
            )
            rejected_status = core.rejected_write_status(result)
            graphql_rejected = any(
                line.startswith("GraphQL:")
                for line in (result.stderr + "\n" + result.stdout).splitlines()
            )
            if rejected_status is not None or graphql_rejected:
                record["write_outcome"] = "rejected"
                if rejected_status is not None:
                    record["http_status"] = rejected_status
                row["last_error"] = (
                    "post-merge dispatch comment was rejected"
                    + (
                        f" (HTTP {rejected_status})"
                        if rejected_status is not None
                        else ""
                    )
                    + ": "
                    + message
                )
            else:
                record["write_outcome"] = "unknown"
                row["last_error"] = (
                    "post-merge dispatch comment outcome is unknown: " + message
                )
            core.write_ledger(args.ledger, rows)
            raise core.ReviewCtlError(row["last_error"])
        record["comment_url"] = result.stdout.strip() or None
        record["delivered_at"] = core.timestamp()
        record["delivered"] = True
        record["write_outcome"] = "confirmed"
        row["last_error"] = None
        core.write_ledger(args.ledger, rows)
    core.print_json(
        {
            "action": "post_merge_human_dispatched",
            "reason_code": args.reason_code,
            "reviewer": args.reviewer,
            "url": row["url"],
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=core.DEFAULT_LEDGER)
    subparsers = parser.add_subparsers(dest="command", required=True)

    due = subparsers.add_parser("due")
    due.add_argument("--auto", action="store_true")
    due.set_defaults(func=lambda a: command_due_auto(a) if a.auto else command_due(a))

    replan = subparsers.add_parser("replan")
    replan.add_argument("url")
    replan.add_argument("correction")
    replan.set_defaults(func=command_replan)

    record = subparsers.add_parser("record")
    record.add_argument("url")
    record.add_argument("receipt")
    record.set_defaults(func=command_record)

    complete = subparsers.add_parser("complete")
    complete.add_argument("url")
    complete.set_defaults(func=command_complete)

    dispatch = subparsers.add_parser("dispatch")
    dispatch.add_argument("url")
    dispatch.add_argument("--reviewer", required=True)
    dispatch.add_argument(
        "--reason-code",
        required=True,
        choices=sorted(core.RECOVERY_HUMAN_REASON_CODES),
    )
    dispatch.add_argument("--detail", required=True)
    dispatch.add_argument("--execute", action="store_true")
    dispatch.set_defaults(func=command_dispatch)

    reconcile_dispatch = subparsers.add_parser("reconcile-dispatch")
    reconcile_dispatch.add_argument("url")
    reconcile_dispatch.add_argument("--dispatch-sha256", required=True)
    reconcile_dispatch.add_argument("--evidence", required=True)
    reconcile_dispatch.add_argument("--execute", action="store_true")
    reconcile_dispatch.set_defaults(func=command_reconcile_dispatch)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except core.ReviewCtlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
