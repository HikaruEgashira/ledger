#!/usr/bin/env python3
"""Poll open PRs in configured review scopes via GraphQL and trigger ledger review on new heads."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "review-scopes.json"
INTAKE = ROOT / "app" / "src" / "intakectl.ts"
LOG_DIR = ROOT / "logs" / "review-poller"
STATE = LOG_DIR / "heads.json"
CURSOR = LOG_DIR / "last_poll.txt"
OVERLAP = dt.timedelta(minutes=5)
MIN_REMAINING = 500
SOURCE = "review-poller"
sys.path.insert(0, str(ROOT / "skills" / "review-ledger-prs" / "scripts"))
import local_config  # noqa: E402

LOCAL = local_config.load()
ORG = local_config.review_org()
PR_URL_RE = re.compile(rf"^https://github\.com/{re.escape(ORG)}/[^/]+/pull/[1-9][0-9]*$")
QUERY = """
query($q: String!, $cursor: String) {
  rateLimit { cost remaining }
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    nodes { ... on PullRequest { url headRefOid author { login } } }
    pageInfo { endCursor hasNextPage }
  }
}
"""


def load_scopes() -> list[dict[str, Any]]:
    config = json.loads(CONFIG.read_text())
    scopes = config.get("scopes", [])
    if not scopes:
        raise SystemExit(f"{CONFIG}: scopes is empty")
    for scope in scopes:
        if not (ROOT / scope["profile"]).is_file():
            raise SystemExit(f"{CONFIG}: scope {scope['name']} profile not found")
        if bool(scope.get("authors")) == bool(scope.get("repo")):
            raise SystemExit(f"{CONFIG}: scope {scope['name']} needs exactly one of authors or repo")
        if scope.get("repo") and not scope["repo"].startswith(f"{ORG}/"):
            raise SystemExit(f"{CONFIG}: scope {scope['name']} repo must be under {ORG}")
        if scope.get("repos") and (not scope.get("authors") or not all(r.startswith(f"{ORG}/") for r in scope["repos"])):
            raise SystemExit(f"{CONFIG}: scope {scope['name']} repos needs authors and {ORG} repos")
        scope["exclude_authors"] = [*LOCAL.get("exclude_authors", []), *scope.get("exclude_authors", [])]
    return scopes


def qualifier(scope: dict[str, Any]) -> str:
    if scope.get("repo"):
        base = f"repo:{scope['repo']}"
    else:
        where = " ".join(f"repo:{r}" for r in scope["repos"]) if scope.get("repos") else f"org:{ORG}"
        base = where + " " + " ".join(f"author:{a}" for a in scope["authors"])
    return " ".join([base, *(f"-author:{a}" for a in scope.get("exclude_authors", []))])


def fetch_open_prs(scopes: list[dict[str, Any]], since: str | None = None) -> dict[str, tuple[str, str]]:
    """Return {url: (head_sha, scope_name)} for open org PRs (drafts included); earlier scopes win."""
    found: dict[str, tuple[str, str]] = {}
    for scope in scopes:
        for url, head in fetch_scope(qualifier(scope), since).items():
            found.setdefault(url, (head, scope["name"]))
    return found


def fetch_scope(scope: str, since: str | None) -> dict[str, str]:
    query = f"{scope} is:pr is:open"
    if since:
        query += f" updated:>={since}"
    heads: dict[str, str] = {}
    cursor: str | None = None
    while True:
        args = ["gh", "api", "graphql", "-f", f"query={QUERY}", "-f", f"q={query}"]
        if cursor:
            args += ["-f", f"cursor={cursor}"]
        result = subprocess.run(args, capture_output=True, text=True, timeout=60, check=True)
        data = json.loads(result.stdout)["data"]
        if data["rateLimit"]["remaining"] < MIN_REMAINING:
            raise SystemExit("GraphQL rate limit low; skipping until next poll")
        search = data["search"]
        for node in search["nodes"]:
            if node and PR_URL_RE.match(node.get("url", "")):
                heads[node["url"]] = node["headRefOid"]
        if not search["pageInfo"]["hasNextPage"]:
            return heads
        cursor = search["pageInfo"]["endCursor"]


def enqueue(url: str, scope: str) -> bool:
    # intakectl performs live validation; already-listed URLs exit 0 unchanged.
    result = subprocess.run(
        ["bun", str(INTAKE), "add", url, "--priority", "50",
         "--reason", f"PR in review scope {scope} detected by review poller",
         "--source", SOURCE, "--scope", scope, "--execute"],
        cwd=ROOT, capture_output=True, text=True, timeout=120, check=False,
    )
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    started = dt.datetime.now(dt.timezone.utc)
    since = None
    if CURSOR.exists() and not args.dry_run:
        since = (dt.datetime.fromisoformat(CURSOR.read_text().strip()) - OVERLAP).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Incremental polls only fetch PRs updated since the last poll, usually 0 nodes.
    scope_list = load_scopes()
    current = fetch_open_prs(scope_list, since)
    if not STATE.exists() and not args.dry_run:
        # First run only records a baseline so pre-existing PRs are not bulk-queued.
        STATE.write_text(json.dumps({u: h for u, (h, _) in current.items()}, indent=2))
        CURSOR.write_text(started.isoformat())
        print(json.dumps({"open": len(current), "baseline": True}))
        return 0
    changed = [url for url, (head, _) in current.items() if previous.get(url) != head]
    if args.dry_run:
        print(json.dumps({"open": len(current), "changed": {u: current[u][1] for u in changed}}, indent=2))
        return 0
    queued = [url for url in changed if enqueue(url, current[url][1])]
    # Failed intakes stay out of state so the next poll retries them.
    failed = set(changed) - set(queued)
    STATE.write_text(json.dumps({**previous, **{u: h for u, (h, _) in current.items() if u not in failed}}, indent=2))
    if not failed:
        CURSOR.write_text(started.isoformat())
    # Worker dispatch, retries and concurrency live in reviewctl serve (app/src/queue.ts).
    print(json.dumps({"open": len(current), "queued": queued}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
