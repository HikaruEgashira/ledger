#!/usr/bin/env python3
"""Aggregate one day of review-loop telemetry into logs/retro/<date>.json (stats only, no review artifacts)."""

from __future__ import annotations

import collections
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "logs/reviewctl-serve.log"
STATE = ROOT / "logs/retro/state.json"
ANSI = re.compile(r"\x1b\[[0-9;]*m|\\u001b\[[0-9;]*m")
NOISE = re.compile(r"[0-9a-f]{40}|\d{2}:\d{2}:\d{2}\.\d+|/pull/\d+|\d+")


def error_class(message: str) -> str:
    return NOISE.sub("#", ANSI.sub("", message))[:160]


def main() -> None:
    state = json.loads(STATE.read_text()) if STATE.exists() else {"offset": 0}
    size = LOG.stat().st_size if LOG.exists() else 0
    offset = state["offset"] if state["offset"] <= size else 0
    events: collections.Counter[str] = collections.Counter()
    errors: collections.Counter[str] = collections.Counter()
    per_pr: collections.Counter[str] = collections.Counter()
    if LOG.exists():
        with LOG.open("rb") as f:
            f.seek(offset)
            for raw in f:
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(event, dict) or "event" not in event:
                    continue
                events[event["event"]] += 1
                if event.get("url"):
                    per_pr[event["url"]] += 1
                if event.get("error"):
                    errors[f'{event["event"]}: {error_class(event["error"])}'] += 1
    statuses: collections.Counter[str] = collections.Counter()
    last_errors: collections.Counter[str] = collections.Counter()
    for line in (ROOT / "pull_requests.jsonl").read_text().splitlines():
        row = json.loads(line)
        statuses[row["status"]] += 1
        if row.get("last_error"):
            last_errors[error_class(row["last_error"])] += 1
    today = dt.date.today().isoformat()
    summary = {
        "date": today,
        "events": dict(events.most_common()),
        "event_errors": dict(errors.most_common(20)),
        "noisiest_prs": dict(per_pr.most_common(10)),
        "ledger_status": dict(statuses.most_common()),
        "ledger_last_errors": dict(last_errors.most_common(20)),
    }
    out = ROOT / f"logs/retro/{today}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    STATE.write_text(json.dumps({"offset": size}))
    print(out)


if __name__ == "__main__":
    main()
