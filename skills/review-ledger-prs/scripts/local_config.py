"""Loader for config/config.toml (machine / organization specific settings)."""
from __future__ import annotations

import ast
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONFIG_TOML = ROOT / "config" / "config.toml"


def _parse(text: str) -> dict:
    try:
        import tomllib
        return tomllib.loads(text)
    except ImportError:
        pass
    # Python < 3.11 fallback: top-level `key = "str"` / `key = ["str", ...]` only.
    out: dict = {}
    for m in re.finditer(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(".*?"|\[.*?\])\s*$', re.sub(r"(?m)^\s*#.*$", "", text), re.M | re.S):
        out[m.group(1)] = ast.literal_eval(m.group(2))
    return out


def load() -> dict:
    return _parse(CONFIG_TOML.read_text()) if CONFIG_TOML.exists() else {}


def review_org() -> str:
    value = os.environ.get("REVIEW_ORG") or load().get("org", "")
    if not re.fullmatch(r"[A-Za-z0-9-]+", value or ""):
        raise RuntimeError(f"GitHub org is not configured: set REVIEW_ORG or org in {CONFIG_TOML}")
    return value
