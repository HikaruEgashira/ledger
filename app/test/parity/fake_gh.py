#!/usr/bin/env python3
"""Scripted `gh` stand-in: replays scenario responses and logs every call."""

import json
import os
import sys

scenario_path = os.environ["FAKE_GH_SCENARIO"]
log_path = os.environ["FAKE_GH_LOG"]
state_path = scenario_path + ".state"

argv = sys.argv[1:]
stdin = sys.stdin.read() if "--input" in argv else None
with open(log_path, "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "stdin": stdin}, ensure_ascii=False, sort_keys=True) + "\n")

with open(scenario_path, encoding="utf-8") as handle:
    rules = json.load(handle)["rules"]
try:
    with open(state_path, encoding="utf-8") as handle:
        counters = json.load(handle)
except FileNotFoundError:
    counters = {}

for index, rule in enumerate(rules):
    prefix = rule["argv_prefix"]
    if argv[: len(prefix)] != prefix:
        continue
    count = counters.get(str(index), 0)
    counters[str(index)] = count + 1
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(counters, handle)
    outputs = rule["outputs"]
    output = outputs[min(count, len(outputs) - 1)]
    stdout = output.get("stdout", "")
    if not isinstance(stdout, str):
        stdout = json.dumps(stdout, ensure_ascii=False)
    sys.stdout.write(stdout)
    sys.stderr.write(output.get("stderr", ""))
    sys.exit(output.get("code", 0))

sys.stderr.write("fake gh: no rule for " + " ".join(argv) + "\n")
sys.exit(1)
