#!/usr/bin/env python3
"""Differential test: run the Python and TypeScript CLIs on identical workspaces and compare everything observable.

Usage: python3 -I app/test/parity/run_parity.py <python-source-root>
The Python source root must contain skills/review-ledger-prs/scripts/reviewctl.py (e.g. the pre-migration backup).
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[3]
PY_SRC = Path(sys.argv[1]).resolve()
FAKE_GH = Path(__file__).resolve().parent / "fake_gh.py"
NOW_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
SHA = lambda c: c * 40  # noqa: E731
BASE, HEAD, HEAD2 = SHA("a"), SHA("b"), SHA("c")
URL = "https://github.com/example-org/parity/pull/1"
failures: list[str] = []


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def build(kind: str, root: Path, ledger_rows: list[dict] | None, artifacts: dict[str, bytes]) -> Path:
    ws = root / kind
    if kind == "py":
        for rel in ("skills/review-ledger-prs/scripts/reviewctl.py", "skills/add-review-ledger-prs/scripts/intakectl.py"):
            (ws / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PY_SRC / rel, ws / rel)
    else:
        shutil.copytree(WORKSPACE / "app" / "src", ws / "app" / "src")
    if ledger_rows is not None:
        (ws / "pull_requests.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in ledger_rows)
        )
    for rel, data in artifacts.items():
        (ws / rel).parent.mkdir(parents=True, exist_ok=True)
        (ws / rel).write_bytes(data)
    return ws


def command(kind: str, ws: Path, tool: str, args: list[str]) -> list[str]:
    if kind == "py":
        script = {
            "reviewctl": "skills/review-ledger-prs/scripts/reviewctl.py",
            "intakectl": "skills/add-review-ledger-prs/scripts/intakectl.py",
        }[tool]
        return [sys.executable, str(ws / script), *args]
    script = {"reviewctl": "app/src/reviewctl/cli.ts", "intakectl": "app/src/intakectl.ts"}[tool]
    return ["bun", str(ws / script), *args]


def run(kind: str, ws: Path, tool: str, args: list[str], rules: list[dict]) -> dict:
    bindir = ws / ".bin"
    bindir.mkdir(exist_ok=True)
    gh = bindir / "gh"
    gh.write_text(f"#!/bin/sh\nexec {sys.executable} -I {FAKE_GH} \"$@\"\n")
    gh.chmod(0o755)
    scenario = ws / ".scenario.json"
    scenario.write_text(json.dumps({"rules": rules}))
    Path(str(scenario) + ".state").unlink(missing_ok=True)
    log = ws / ".gh.log"
    log.write_text("")
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "REVIEW_ORG": "example-org", "FAKE_GH_SCENARIO": str(scenario), "FAKE_GH_LOG": str(log)}
    proc = subprocess.run(command(kind, ws, tool, [a.replace("{WS}", str(ws)) for a in args]), env=env, capture_output=True, text=True, timeout=120)
    ledger = ws / "pull_requests.jsonl"
    modes = {
        str(p.relative_to(ws)): oct(p.stat().st_mode & 0o777)
        for p in sorted(ws.rglob("*.json"))
        if "review-artifacts" in str(p)
    }
    return {
        "code": proc.returncode,
        "stdout": proc.stdout.replace(str(ws), "<WS>"),
        "stderr": proc.stderr.replace(str(ws), "<WS>"),
        "ledger": ledger.read_text().replace(str(ws), "<WS>") if ledger.exists() else None,
        "gh": log.read_text(),
        "modes": modes,
    }


def normalize(text: str | None, since: datetime) -> str | None:
    if text is None:
        return None

    def repl(m: re.Match[str]) -> str:
        try:
            value = datetime.fromisoformat(m.group(0).replace("Z", "+00:00"))
        except ValueError:
            return m.group(0)
        return "<NOW>" if value >= since - timedelta(seconds=1) else m.group(0)

    return NOW_RE.sub(repl, text)


# Known, accepted differences: JSON parser wording (V8 vs CPython) and argparse usage lines.
JSON_ERROR_RE = re.compile(r'("last_error": |"error": )"[^"]*(?:Expecting|Unexpected|JSON)[^"]*"')


def compare(name: str, rows: list[dict] | None, artifacts: dict[str, bytes], tool: str, args: list[str], rules: list[dict], *, stderr: bool = True) -> dict:
    root = Path(tempfile.mkdtemp(prefix="parity-"))
    results = {}
    for kind in ("py", "ts"):
        ws = build(kind, root, copy.deepcopy(rows), artifacts)
        since = datetime.now(timezone.utc)
        out = run(kind, ws, tool, args, rules)
        results[kind] = {k: normalize(v, since) if isinstance(v, str) else v for k, v in out.items()}
        for k in ("ledger", "stdout"):
            if results[kind][k]:
                results[kind][k] = JSON_ERROR_RE.sub(r'\1"<JSON-ERROR>"', results[kind][k])
    keys = ["code", "stdout", "ledger", "gh", "modes"] + (["stderr"] if stderr else [])
    diffs = [k for k in keys if results["py"][k] != results["ts"][k]]
    if diffs:
        failures.append(name)
        print(f"FAIL {name}: {', '.join(diffs)}")
        for k in diffs:
            for kind in ("py", "ts"):
                print(f"  --- {kind}.{k}\n{str(results[kind][k])[:3000]}")
    else:
        print(f"ok   {name} (exit {results['py']['code']})")
    shutil.rmtree(root, ignore_errors=True)
    return results["py"]


# ---------- fixtures ----------

def raw_view(live: dict) -> dict:
    """Invert gh_view normalisation so the fake returns what real gh would."""
    raw = {k: v for k, v in live.items() if k not in ("checks", "changeRequestReviews")}
    raw["statusCheckRollup"] = [
        {
            "__typename": "CheckRun",
            "name": c["name"],
            "status": "COMPLETED" if c["state"] != "pending" else "IN_PROGRESS",
            "conclusion": {"success": "SUCCESS", "failure": "FAILURE", "pending": None}[c["state"]],
            "completedAt": "2026-01-01T00:00:00Z",
        }
        for c in live.get("checks", [])
    ]
    raw["reviews"] = [
        {"state": "CHANGES_REQUESTED", "author": {"login": r["login"]}, "commit": {"oid": r["commit"]}, "submittedAt": "2026-01-01T00:00:00Z"}
        for r in live.get("changeRequestReviews") or []
    ]
    return raw


def mutate(live: dict, url: str) -> dict:
    """Deterministically perturb live state to exercise apply_live branches."""
    live = copy.deepcopy(live)
    bucket = int(hashlib.sha256(url.encode()).hexdigest(), 16) % 7
    if bucket == 1:
        live["headRefOid"] = SHA("d")
    elif bucket == 2:
        live["state"] = "MERGED"
        live["mergeCommit"] = {"oid": SHA("e")}
        live["mergedAt"] = "2026-10-01T00:00:00Z"
    elif bucket == 3:
        live["state"] = "CLOSED"
    elif bucket == 4:
        live["checks"] = live.get("checks", []) + [{"name": "zz-new", "state": "failure"}, {"name": "zz-pend", "state": "pending"}]
    elif bucket == 5:
        live["reviewDecision"] = "CHANGES_REQUESTED"
        live["updatedAt"] = "2026-10-02T00:00:00Z"
    return live


def live_payload(head: str = HEAD, base: str = BASE, updated: str = "2026-10-20T00:00:00Z", **extra) -> dict:
    payload = {
        "author": {"login": "someone"},
        "baseRefName": "main",
        "baseRefOid": base,
        "headRefName": "feature",
        "headRefOid": head,
        "isDraft": False,
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "BLOCKED",
        "reviewDecision": "REVIEW_REQUIRED",
        "latestReviews": [],
        "reviews": [],
        "mergeCommit": None,
        "mergedAt": None,
        "state": "OPEN",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-10-20T00:00:00Z"},
            {"__typename": "CheckRun", "name": "require-approval", "status": "COMPLETED", "conclusion": "FAILURE", "completedAt": "2026-10-20T00:00:00Z"},
            {"context": "legacy", "state": "SUCCESS"},
        ],
        "title": "パリティ検証 PR",
        "updatedAt": updated,
        "url": URL,
    }
    payload.update(extra)
    return payload


def artifact(verdict: str = "approve", head: str = HEAD, updated: str = "2026-10-20T00:00:00Z", **extra) -> dict:
    now = iso(datetime.now(timezone.utc))
    doc = {
        "schema_version": 1,
        "url": URL,
        "base_sha": BASE,
        "head_sha": head,
        "reviewed_at": now,
        "verdict": verdict,
        "notes": "設定値の検証を追加する変更です。後続の説明。",
        "coverage": {
            "diff": "pass",
            "security": "pass",
            "tests": "pass",
            "test_evidence": ["GitHub current-head checks: green", "unit tests   pass\nfor   parser", "integration ok"],
        },
        "review_threads": {"method": "gh", "unresolved": 0, "verified_at": now, "pr_updated_at": updated},
        "findings": [{"severity": "Low", "status": "open", "summary": "nit"}],
        "human_dispatch": {"required": False},
        "delivery": {
            "release": {"mode": "not_applicable", "reason": "docs only", "identifier": None, "environment": None},
            "monitoring": {"window_minutes": 30, "signals": []},
            "recovery": {"preferred_strategy": "not_applicable", "procedure": [], "verification": [], "human_boundaries": []},
        },
    }
    if verdict == "changes_requested":
        doc["findings"] = [{"severity": "High", "status": "open", "summary": "bug"}]
    if verdict == "human_required":
        doc["human_dispatch"] = {"required": True, "reason_code": "business-risk-acceptance", "detail": "料金影響の承認が必要"}
    doc.update(extra)
    return doc


def row(**extra) -> dict:
    base = {
        "schema_version": 1,
        "repository": "example-org/parity",
        "pr_number": 1,
        "url": URL,
        "status": "queued",
        "priority": 50,
        "added_at": "2026-10-19T00:00:00.123456Z",
        "last_synced_at": None,
        "live": None,
        "evidence_path": None,
        "evidence_sha256": None,
        "decision": None,
        "approval": None,
        "last_error": None,
    }
    base.update(extra)
    return base


def recorded(doc: dict, name: str = "review-artifacts/parity.json") -> tuple[dict, dict[str, bytes]]:
    data = json.dumps(doc, ensure_ascii=False, indent=2).encode()
    return {"evidence_path": name, "evidence_sha256": hashlib.sha256(data).hexdigest()}, {name: data}


def normalized_live(payload: dict) -> dict:
    sys.path.insert(0, str(PY_SRC / "skills/review-ledger-prs/scripts"))
    import reviewctl  # noqa: PLC0415

    live = copy.deepcopy(payload)
    live["checks"] = reviewctl.normalize_checks(live.pop("statusCheckRollup", []))
    live["changeRequestReviews"] = reviewctl.standing_change_requests(live.pop("reviews", []))
    return live


VIEW = ["pr", "view", URL, "--json"]
REVIEWS = ["pr", "view", URL, "--json", "reviews"]
POST = ["api", "--method", "POST"]
PUT = ["api", "--method", "PUT"]


def ok(stdout) -> dict:
    return {"stdout": stdout}


# ---------- scenarios ----------

def real_ledger_scenarios() -> None:
    rows = [json.loads(line) for line in (WORKSPACE / "pull_requests.jsonl").read_text().splitlines() if line.strip()]
    artifacts = {str(p.relative_to(WORKSPACE)): p.read_bytes() for p in (WORKSPACE / "review-artifacts").rglob("*") if p.is_file()}
    compare("validate", rows, artifacts, "reviewctl", ["validate"], [])
    compare("list", rows, artifacts, "reviewctl", ["list"], [])
    compare("list --status x2", rows, artifacts, "reviewctl", ["list", "--status", "completed", "--status", "queued"], [])
    compare("next", rows, artifacts, "reviewctl", ["next"], [])
    compare("next --summary --limit 1", rows, artifacts, "reviewctl", ["next", "--summary", "--limit", "1"], [])
    for r in rows[::7]:
        compare(f"gate {r['url']}", rows, artifacts, "reviewctl", ["gate", r["url"]], [])
    rules = []
    for r in rows:
        if r.get("live"):
            rules.append({"argv_prefix": ["pr", "view", r["url"], "--json"], "outputs": [ok(raw_view(mutate(r["live"], r["url"])))]})
    rules.append({"argv_prefix": ["pr", "view"], "outputs": [{"stderr": "GraphQL: Could not resolve to a PullRequest (HTTP 404)\n", "code": 1}]})
    compare("sync (all rows, mutated live)", rows, artifacts, "reviewctl", ["sync"], rules)
    compare("monitor --once", rows, artifacts, "reviewctl", ["monitor", "--once"], rules)
    compare("sync single url", rows, artifacts, "reviewctl", ["sync", rows[0]["url"]], rules)
    bad = copy.deepcopy(rows)
    bad[3]["priority"] = 101
    compare("validate rejects bad priority", bad, artifacts, "reviewctl", ["validate"], [])


def write_scenarios() -> None:
    live = live_payload()
    nlive = normalized_live(live)
    ev, files = recorded(artifact())
    ready = row(status="ready_to_approve", live=nlive, **ev)
    review_ok = {"id": 991, "html_url": f"{URL}#pullrequestreview-991", "commit_id": HEAD, "state": "APPROVED", "submitted_at": iso(datetime.now(timezone.utc))}

    compare("gate approve", [ready], files, "reviewctl", ["gate", URL], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("approve dry-run", [ready], files, "reviewctl", ["approve", URL], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("approve --execute", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [ok(review_ok)]},
    ])
    compare("approve --execute rejected 422", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [{"stderr": "gh: Unprocessable Entity (HTTP 422)\n", "code": 1}]},
    ])
    compare("approve --execute unknown 502", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [{"stderr": "gh: Bad Gateway (HTTP 502)\n", "code": 1}]},
    ])
    compare("approve --execute bad response", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [ok({"state": "COMMENTED"})]},
    ])
    moved = live_payload(head=HEAD2)
    compare("approve --execute head moved", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live), ok(moved)]},
        {"argv_prefix": POST, "outputs": [ok(review_ok), {"stderr": "boom", "code": 1}]},
    ])
    compare("approve --execute post view fails", [ready], files, "reviewctl", ["approve", URL, "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live), {"stderr": "network down", "code": 1}]},
        {"argv_prefix": POST, "outputs": [ok(review_ok)]},
    ])
    compare("approve sync fails", [ready], files, "reviewctl", ["approve", URL], [
        {"argv_prefix": VIEW, "outputs": [{"stdout": "not json"}]},
    ], stderr=False)
    compare("approve --execute on copy ledger is refused", [ready], files, "reviewctl", ["--ledger", "{WS}/other.jsonl", "approve", URL, "--execute"], [])

    approved_at = iso(datetime.now(timezone.utc) - timedelta(seconds=30))
    plan = artifact()["delivery"]
    pending = row(
        status="approval_pending_verification",
        live=nlive,
        approval={"base_sha": BASE, "head_sha": HEAD, "approved_at": approved_at, "review_id": 991, "review_url": review_ok["html_url"],
                  "write_outcome": "confirmed", "verification": "pending", "delivery_plan": plan,
                  "delivery_plan_sha256": hashlib.sha256(json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()},
        **ev,
    )
    fresh = dict(files)
    fresh["review-artifacts/fresh.json"] = json.dumps(artifact(), ensure_ascii=False).encode()
    compare("record confirms pending approval", [pending], fresh, "reviewctl", ["record", URL, "review-artifacts/fresh.json"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    old = dict(files)
    stale_doc = artifact()
    stale_doc["reviewed_at"] = iso(datetime.now(timezone.utc) - timedelta(minutes=10))
    old["review-artifacts/old.json"] = json.dumps(stale_doc).encode()
    compare("record stale evidence", [pending], old, "reviewctl", ["record", URL, "review-artifacts/old.json"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    changed = dict(files)
    changed_doc = artifact()
    changed_doc["delivery"]["monitoring"]["window_minutes"] = 60
    changed["review-artifacts/changed.json"] = json.dumps(changed_doc).encode()
    compare("record changed plan refused", [pending], changed, "reviewctl", ["record", URL, "review-artifacts/changed.json"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("record outside workspace refused", [ready], files, "reviewctl", ["record", URL, "/etc/hosts"], [])
    compare("record queued row", [row(live=nlive)], fresh, "reviewctl", ["record", URL, "review-artifacts/fresh.json"], [])

    cr_doc = artifact("changes_requested")
    cr_ev, cr_files = recorded(cr_doc, "review-artifacts/cr.json")
    cr_files["review-artifacts/body.md"] = "修正をお願いします。\n".encode()
    cr_row = row(status="changes_requested", live=nlive, **cr_ev)
    cr_ok = {"id": 555, "html_url": f"{URL}#pullrequestreview-555", "commit_id": HEAD, "state": "CHANGES_REQUESTED", "submitted_at": "2026-10-20T01:00:00Z"}
    compare("request-changes dry-run", [cr_row], cr_files, "reviewctl", ["request-changes", URL, "review-artifacts/body.md"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("request-changes --execute", [cr_row], cr_files, "reviewctl", ["request-changes", URL, "review-artifacts/body.md", "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [ok(cr_ok)]},
    ])
    compare("request-changes --execute 403", [cr_row], cr_files, "reviewctl", ["request-changes", URL, "review-artifacts/body.md", "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live)]},
        {"argv_prefix": POST, "outputs": [{"stderr": "Forbidden (HTTP 403)", "code": 1}]},
    ])
    cr_files_empty = dict(cr_files)
    cr_files_empty["review-artifacts/empty.md"] = b"  \n"
    compare("request-changes empty body", [cr_row], cr_files_empty, "reviewctl", ["request-changes", URL, "review-artifacts/empty.md"], [])

    body_digest = hashlib.sha256("修正をお願いします。\n".encode()).hexdigest()
    cr_live = normalized_live(live_payload(reviewDecision="CHANGES_REQUESTED"))
    confirmed = row(
        status="changes_requested",
        live=cr_live,
        change_request={"base_sha": BASE, "head_sha": HEAD, "body_sha256": body_digest, "submitted_at": "2026-10-20T01:00:00Z", "review_id": 555,
                        "review_url": f"{URL}#pullrequestreview-555", "write_outcome": "confirmed", "verification": "confirmed"},
        **cr_ev,
    )
    wd_live = live_payload(reviewDecision="CHANGES_REQUESTED")
    dismissed = {"id": 555, "commit_id": HEAD, "state": "DISMISSED", "html_url": f"{URL}#pullrequestreview-555", "node_id": "PRR_x"}
    wd_args = ["withdraw", URL, "--review-id", "555", "--base-sha", BASE, "--head-sha", HEAD, "--message", "  誤って変更要求しました  "]
    compare("withdraw dry-run", [confirmed], cr_files, "reviewctl", wd_args, [{"argv_prefix": VIEW, "outputs": [ok(wd_live)]}])
    compare("withdraw --execute", [confirmed], cr_files, "reviewctl", [*wd_args, "--execute"], [
        {"argv_prefix": REVIEWS, "outputs": [ok({"reviews": [{"id": "PRR_x", "state": "DISMISSED", "commit": {"oid": HEAD}}]})]},
        {"argv_prefix": VIEW, "outputs": [ok(wd_live), ok(live_payload())]},
        {"argv_prefix": PUT, "outputs": [ok(dismissed)]},
    ])
    compare("withdraw --execute unconfirmed", [confirmed], cr_files, "reviewctl", [*wd_args, "--execute"], [
        {"argv_prefix": REVIEWS, "outputs": [ok({"reviews": []})]},
        {"argv_prefix": VIEW, "outputs": [ok(wd_live)]},
        {"argv_prefix": PUT, "outputs": [ok(dismissed)]},
    ])
    compare("withdraw bad sha", [confirmed], cr_files, "reviewctl", ["withdraw", URL, "--review-id", "555", "--base-sha", "x", "--head-sha", HEAD, "--message", "m"], [])
    compare("withdraw --exec prefix", [confirmed], cr_files, "reviewctl", [*wd_args, "--exec"], [
        {"argv_prefix": REVIEWS, "outputs": [ok({"reviews": [{"id": "PRR_x", "state": "DISMISSED", "commit": {"oid": HEAD}}]})]},
        {"argv_prefix": VIEW, "outputs": [ok(wd_live), ok(live_payload(head=HEAD2))]},
        {"argv_prefix": PUT, "outputs": [ok(dismissed)]},
    ])

    hr_ev, hr_files = recorded(artifact("human_required"), "review-artifacts/hr.json")
    hr_row = row(status="human_required", live=nlive, **hr_ev)
    compare("dispatch dry-run", [hr_row], hr_files, "reviewctl", ["dispatch", URL, "--reviewer", "lead-1"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("dispatch --execute", [hr_row], hr_files, "reviewctl", ["dispatch", URL, "--reviewer", "lead-1", "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live), ok(live_payload(updated="2026-10-20T00:01:00Z")), ok(live_payload(updated="2026-10-20T00:02:00Z"))]},
        {"argv_prefix": ["pr", "comment"], "outputs": [ok("https://github.com/example-org/parity/pull/1#issuecomment-1\n")]},
        {"argv_prefix": ["pr", "edit"], "outputs": [ok("")]},
    ])
    compare("dispatch --execute reviewer fails", [hr_row], hr_files, "reviewctl", ["dispatch", URL, "--reviewer", "lead-1", "--execute"], [
        {"argv_prefix": VIEW, "outputs": [ok(live), ok(live_payload(updated="2026-10-20T00:01:00Z"))]},
        {"argv_prefix": ["pr", "comment"], "outputs": [ok("u\n")]},
        {"argv_prefix": ["pr", "edit"], "outputs": [{"stderr": "not a collaborator", "code": 1}]},
    ])
    compare("dispatch bad login", [hr_row], hr_files, "reviewctl", ["dispatch", URL, "--reviewer=-bad"], [])
    compare("dispatch missing value", [hr_row], hr_files, "reviewctl", ["dispatch", URL, "--reviewer", "-bad"], [], stderr=False)

    unknown = row(status="error", live=nlive, approval={"base_sha": BASE, "head_sha": HEAD, "attempted_at": "2026-10-20T00:00:00Z", "verification": "write-outcome-unknown"}, **ev)
    compare("reconcile dry-run", [unknown], files, "reviewctl", ["reconcile", URL, "--action", "approve", "--evidence", "not written"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("reconcile --execute", [unknown], files, "reviewctl", ["reconcile", URL, "--action", "approve", "--evidence", " not written ", "--execute"], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("reconcile bad choice", [unknown], files, "reviewctl", ["reconcile", URL, "--action", "nope", "--evidence", "x"], [], stderr=False)

    confirmed_approval = row(
        status="approved",
        live=nlive,
        approval={**pending["approval"], "verification": "post-approval-threads-and-live-state", "verified_evidence_sha256": "0" * 64},
        **ev,
    )
    latest = [{"author": {"login": "me"}, "state": "APPROVED", "submittedAt": "2026-10-20T00:00:00Z"}]
    compare("recover dry-run", [confirmed_approval], fresh, "reviewctl", ["recover", URL, "review-artifacts/fresh.json", "--reviewer", "me", "--evidence", "re-bind"], [{"argv_prefix": VIEW, "outputs": [ok(live_payload(latestReviews=latest))]}])
    compare("recover --execute rebind", [confirmed_approval], fresh, "reviewctl", ["recover", URL, "review-artifacts/fresh.json", "--reviewer", "me", "--evidence", "re-bind", "--execute"], [{"argv_prefix": VIEW, "outputs": [ok(live_payload(latestReviews=latest))]}])
    compare("recover --execute reset", [confirmed_approval], fresh, "reviewctl", ["recover", URL, "review-artifacts/fresh.json", "--reviewer", "me", "--evidence", "reset", "--execute"], [{"argv_prefix": VIEW, "outputs": [ok(live_payload())]}])

    compare("intake add dry-run", [], {}, "intakectl", ["add", URL, "--reason", " 依頼 "], [{"argv_prefix": VIEW, "outputs": [ok(live)]}])
    compare("intake add --execute", [ready], files, "intakectl", ["add", "https://github.com/example-org/parity/pull/2/", URL, "--priority", "10", "--reason", "依頼", "--source", "review-poller", "--execute"], [
        {"argv_prefix": ["pr", "view", "https://github.com/example-org/parity/pull/2", "--json"], "outputs": [ok(live_payload(url="https://github.com/example-org/parity/pull/2"))]},
    ])
    compare("intake duplicate", [], {}, "intakectl", ["add", URL, URL + "/", "--reason", "x"], [])
    compare("intake closed PR", [], {}, "intakectl", ["add", URL, "--reason", "x"], [{"argv_prefix": VIEW, "outputs": [ok(live_payload(state="CLOSED"))]}])
    compare("usage error", [], {}, "reviewctl", ["nope"], [], stderr=False)
    compare("missing required", [], {}, "reviewctl", ["withdraw", URL], [], stderr=False)


if __name__ == "__main__":
    real_ledger_scenarios()
    write_scenarios()
    print(f"\n{len(failures)} failing scenario(s)" + (": " + ", ".join(failures) if failures else ""))
    sys.exit(1 if failures else 0)
