#!/usr/bin/env python3
"""Ledger primitives shared by the remaining Python tools; review decisions live in app/src/reviewctl."""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import subprocess
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_config  # noqa: E402
from typing import Any, Iterator

SCHEMA_VERSION = 1


ROOT = Path(__file__).resolve().parents[3]


DEFAULT_LEDGER = ROOT / "pull_requests.jsonl"


ACTIVE_STATUSES = {
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
}


POST_MERGE_STATUSES = {
    "merged_waiting_release",
    "release_in_progress",
    "post_release_monitoring",
    "recovering",
    "recovered_monitoring",
    "completed",
}


ALL_STATUSES = ACTIVE_STATUSES | {"completed", "closed"}


RECOVERY_HUMAN_REASON_CODES = {
    "irreversible-data-loss",
    "legal-privacy-customer-notification",
    "human-only-production-authentication",
    "unresolved-business-tradeoff",
}


PR_URL_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<number>[1-9][0-9]*)/?$"
)


SHA_RE = re.compile(r"^[0-9a-f]{40}$")


GH_HTTP_STATUS_RE = re.compile(r"\(HTTP (?P<status>[1-5][0-9]{2})\)")


class ReviewCtlError(RuntimeError):
    pass


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def timestamp(value: dt.datetime | None = None) -> str:
    return (value or utc_now()).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise ReviewCtlError(f"invalid timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        raise ReviewCtlError(f"timestamp must include a timezone: {value!r}")
    return parsed.astimezone(dt.timezone.utc)


def review_org() -> str:
    try:
        return local_config.review_org()
    except RuntimeError as exc:
        raise ReviewCtlError(str(exc)) from exc


def parse_pr_url(url: str) -> tuple[str, int]:
    match = PR_URL_RE.fullmatch(url)
    if not match:
        raise ReviewCtlError(f"invalid GitHub pull request URL: {url}")
    owner = match.group("owner")
    if owner != review_org():
        raise ReviewCtlError(f"this workspace is restricted to {review_org()} pull requests")
    return f"{owner}/{match.group('repo')}", int(match.group("number"))


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


@contextlib.contextmanager
def ledger_lock(path: Path) -> Iterator[None]:
    """Exclusive lock shared with the TypeScript tools (`<ledger>.lock.d` + owner pid)."""
    lock_dir = path.with_name(path.name + ".lock.d")
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            lock_dir.mkdir()
            (lock_dir / "pid").write_text(str(os.getpid()))
            break
        except FileExistsError:
            try:
                owner = int((lock_dir / "pid").read_text())
            except (OSError, ValueError):
                # owner died between mkdir and writing its pid
                try:
                    orphaned = time.time() - lock_dir.stat().st_mtime > 10
                except OSError:
                    orphaned = False
                owner = 0 if orphaned else -1
            if owner == 0 or (owner > 0 and not _pid_alive(owner)):
                shutil.rmtree(lock_dir, ignore_errors=True)
            else:
                time.sleep(0.05)
    try:
        yield
    finally:
        shutil.rmtree(lock_dir, ignore_errors=True)


def read_ledger(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ReviewCtlError(
                f"{path}:{line_number}: invalid JSON: {exc.msg}"
            ) from exc
        validate_row(row, f"{path}:{line_number}")
        rows.append(row)
    urls = [row["url"] for row in rows]
    if len(urls) != len(set(urls)):
        raise ReviewCtlError(f"{path}: duplicate pull request URL")
    return rows


def write_ledger(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
        for row in sorted(
            rows, key=lambda row: (row["priority"], row["added_at"], row["url"])
        )
    )
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def validate_row(row: Any, where: str = "ledger row") -> None:
    if not isinstance(row, dict):
        raise ReviewCtlError(f"{where}: row must be an object")
    required = {
        "schema_version",
        "repository",
        "pr_number",
        "url",
        "status",
        "priority",
        "added_at",
    }
    missing = sorted(required - row.keys())
    if missing:
        raise ReviewCtlError(f"{where}: missing fields: {', '.join(missing)}")
    repository, number = parse_pr_url(row["url"])
    if row["schema_version"] != SCHEMA_VERSION:
        raise ReviewCtlError(f"{where}: unsupported schema_version")
    if row["repository"] != repository or row["pr_number"] != number:
        raise ReviewCtlError(f"{where}: repository or pr_number does not match URL")
    if row["status"] not in ALL_STATUSES:
        raise ReviewCtlError(f"{where}: invalid status: {row['status']}")
    if not isinstance(row["priority"], int) or not 0 <= row["priority"] <= 100:
        raise ReviewCtlError(f"{where}: priority must be an integer from 0 to 100")
    parse_time(row["added_at"])
    review_request = row.get("review_request")
    if review_request is not None:
        if not isinstance(review_request, dict):
            raise ReviewCtlError(f"{where}: review_request must be an object")
        required_request_fields = {
            "active",
            "reviewer",
            "observed_at",
            "base_sha",
            "head_sha",
            "pr_updated_at",
        }
        missing_request_fields = sorted(
            required_request_fields - review_request.keys()
        )
        if missing_request_fields:
            raise ReviewCtlError(
                f"{where}: review_request missing fields: "
                + ", ".join(missing_request_fields)
            )
        if not isinstance(review_request["active"], bool):
            raise ReviewCtlError(f"{where}: review_request.active must be boolean")
        if (
            not isinstance(review_request["reviewer"], str)
            or not review_request["reviewer"]
        ):
            raise ReviewCtlError(
                f"{where}: review_request.reviewer must be a non-empty string"
            )
        for field in ("base_sha", "head_sha"):
            if not isinstance(review_request[field], str) or not SHA_RE.fullmatch(
                review_request[field]
            ):
                raise ReviewCtlError(
                    f"{where}: review_request.{field} must be a 40-hex SHA"
                )
        parse_time(review_request["observed_at"])
        parse_time(review_request["pr_updated_at"])


def find_row(rows: list[dict[str, Any]], url: str) -> dict[str, Any]:
    canonical = url.rstrip("/")
    for row in rows:
        if row["url"] == canonical:
            return row
    raise ReviewCtlError(f"pull request is not in the ledger: {canonical}")


def gh_write(
    arguments: list[str], *, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["gh", *arguments],
            check=False,
            capture_output=True,
            text=True,
            input=input_text,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise ReviewCtlError("GitHub write command timed out") from exc


def rejected_write_status(result: subprocess.CompletedProcess[str]) -> int | None:
    """Return a definitive GitHub rejection status, preserving ambiguous writes."""
    message = "\n".join(part for part in (result.stderr, result.stdout) if part)
    match = GH_HTTP_STATUS_RE.search(message)
    if not match:
        return None
    status = int(match.group("status"))
    return status if 400 <= status < 500 and status != 408 else None


def require_string_list(value: Any, field: str, *, allow_empty: bool = False) -> None:
    if not isinstance(value, list) or (
        not allow_empty
        and (
            not value
            or any(not isinstance(item, str) or not item.strip() for item in value)
        )
    ):
        raise ReviewCtlError(f"{field} must be a list of non-empty strings")
    if allow_empty and any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise ReviewCtlError(f"{field} must contain only non-empty strings")


def validate_delivery_plan(delivery: Any) -> None:
    if not isinstance(delivery, dict):
        raise ReviewCtlError("delivery must be an object")
    release = delivery.get("release")
    monitoring = delivery.get("monitoring")
    recovery = delivery.get("recovery")
    if not all(isinstance(value, dict) for value in (release, monitoring, recovery)):
        raise ReviewCtlError(
            "delivery release, monitoring, and recovery must be objects"
        )

    mode = release.get("mode")
    if mode not in {"github-actions", "external", "not_applicable"}:
        raise ReviewCtlError(
            "delivery.release.mode must be github-actions, external, or not_applicable"
        )
    if mode == "not_applicable":
        reason = release.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ReviewCtlError("not_applicable release requires a reason")
    else:
        identifier = release.get("identifier")
        environment = release.get("environment")
        if not isinstance(identifier, str) or not identifier.strip():
            raise ReviewCtlError("applicable release requires an identifier")
        if not isinstance(environment, str) or not environment.strip():
            raise ReviewCtlError("applicable release requires an environment")

    window = monitoring.get("window_minutes")
    if (
        not isinstance(window, int)
        or isinstance(window, bool)
        or not 30 <= window <= 10080
    ):
        raise ReviewCtlError("delivery monitoring window must be 30..10080 minutes")
    signals = monitoring.get("signals")
    if not isinstance(signals, list) or (mode != "not_applicable" and not signals):
        raise ReviewCtlError("applicable release requires monitoring signals")
    if mode == "not_applicable" and signals:
        raise ReviewCtlError("not_applicable release cannot declare monitoring signals")
    signal_names: list[str] = []
    for signal in signals:
        if not isinstance(signal, dict):
            raise ReviewCtlError("each monitoring signal must be an object")
        for field in ("name", "source", "healthy_when", "failure_when"):
            if not isinstance(signal.get(field), str) or not signal[field].strip():
                raise ReviewCtlError(f"monitoring signal {field} is required")
        signal_names.append(signal["name"])
    if len(signal_names) != len(set(signal_names)):
        raise ReviewCtlError("monitoring signal names must be unique")

    strategy = recovery.get("preferred_strategy")
    if strategy not in {
        "rollback",
        "feature-flag",
        "hotfix",
        "compatibility",
        "redeploy",
        "not_applicable",
    }:
        raise ReviewCtlError("delivery recovery strategy is invalid")
    if mode == "not_applicable" and strategy != "not_applicable":
        raise ReviewCtlError("non-releasing changes require not_applicable recovery")
    if mode != "not_applicable" and strategy == "not_applicable":
        raise ReviewCtlError("applicable release requires a recovery strategy")
    require_string_list(
        recovery.get("procedure", []),
        "delivery.recovery.procedure",
        allow_empty=strategy == "not_applicable",
    )
    require_string_list(
        recovery.get("verification", []),
        "delivery.recovery.verification",
        allow_empty=strategy == "not_applicable",
    )
    if strategy == "not_applicable" and (
        recovery.get("procedure") or recovery.get("verification")
    ):
        raise ReviewCtlError(
            "not_applicable recovery must use empty procedure and verification"
        )
    require_string_list(
        recovery.get("human_boundaries", []),
        "delivery.recovery.human_boundaries",
        allow_empty=True,
    )
    human_boundaries = recovery.get("human_boundaries", [])
    if len(human_boundaries) != len(set(human_boundaries)):
        raise ReviewCtlError("delivery recovery human boundaries must be unique")
    unknown_boundaries = sorted(set(human_boundaries) - RECOVERY_HUMAN_REASON_CODES)
    if unknown_boundaries:
        raise ReviewCtlError(
            "delivery recovery human boundaries contain unsupported reason codes: "
            + ", ".join(unknown_boundaries)
        )
    if strategy == "not_applicable" and human_boundaries:
        raise ReviewCtlError(
            "not_applicable recovery cannot declare human-only boundaries"
        )


def delivery_plan_digest(delivery: dict[str, Any]) -> str:
    payload = json.dumps(
        delivery, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def derive_delivery_status(receipts: list[dict[str, Any]]) -> str:
    if not isinstance(receipts, list) or any(
        not isinstance(receipt, dict) for receipt in receipts
    ):
        raise ReviewCtlError("delivery receipts ledger field is invalid")
    status = "merged_waiting_release"
    for receipt in sorted(receipts, key=lambda item: parse_time(item["observed_at"])):
        receipt_type = receipt.get("type")
        if receipt_type == "release":
            status = {
                "started": "release_in_progress",
                "succeeded": "post_release_monitoring",
                "failed": "recovering",
            }[receipt["status"]]
        elif receipt_type == "observation":
            if receipt["status"] == "degraded":
                status = "recovering"
            elif receipt["phase"] == "post_release":
                status = "post_release_monitoring"
            else:
                status = "recovered_monitoring"
        elif receipt_type == "incident":
            status = "recovering"
        elif receipt_type == "recovery":
            status = (
                "recovered_monitoring"
                if receipt["status"] == "succeeded"
                else "recovering"
            )
        elif receipt_type != "postmortem":
            raise ReviewCtlError(f"unsupported delivery receipt type: {receipt_type}")
    return status


def resolve_artifact_path(raw: str, root: Path = ROOT) -> tuple[Path, str]:
    path = Path(raw)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ReviewCtlError("evidence artifact must be inside the workspace") from exc
    return resolved, str(relative)


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))

