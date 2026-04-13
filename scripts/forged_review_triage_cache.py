"""On-disk triage cache for stark-forged-review.

The triage LLM call reads the PR diff, changed file list, and PR body to
decide which review domains are worth running. For a given (diff, files,
body) tuple the answer is deterministic enough that re-running the same
prompt within a short window is wasted cost — especially on `--resume`
runs, `--dry-run` iterations, and back-to-back eval sessions.

This module keeps a small JSON cache keyed by a SHA1 of the triage
inputs with a 24-hour TTL and FIFO eviction at 100 entries. Hit rates
save one LLM call per cached run; misses transparently fall through.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

DEFAULT_CACHE_PATH = Path.home() / ".claude" / "code-review" / "history" / "forged-review" / "triage-cache.json"
DEFAULT_TTL_S = 24 * 60 * 60  # 24 hours
DEFAULT_MAX_ENTRIES = 100


def compute_triage_key(
    pr_diff: str,
    changed_files: list[str],
    pr_description: str,
    *,
    body_char_limit: int = 500,
) -> str:
    """Return a deterministic SHA1 hex digest for the triage inputs.

    The body is truncated to `body_char_limit` because triage prompts
    typically only skim the description — small edits to a long body
    shouldn't invalidate the cache, which would defeat --resume usage.
    """
    hasher = hashlib.sha1()
    hasher.update((pr_diff or "").encode("utf-8", errors="replace"))
    hasher.update(b"\x00")
    for f in sorted(changed_files or []):
        hasher.update(f.encode("utf-8", errors="replace"))
        hasher.update(b"\x00")
    hasher.update((pr_description or "")[:body_char_limit].encode("utf-8", errors="replace"))
    return hasher.hexdigest()


def _load_cache_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"entries": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"entries": {}}
    if not isinstance(data, dict) or "entries" not in data:
        return {"entries": {}}
    return data


def _save_cache_file(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_cached_triage(
    key: str,
    *,
    cache_path: Path | None = None,
    ttl_s: int = DEFAULT_TTL_S,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Return the cached triage result for `key`, or None on miss/expired."""
    cache_path = cache_path or DEFAULT_CACHE_PATH
    data = _load_cache_file(cache_path)
    entry = data.get("entries", {}).get(key)
    if not isinstance(entry, dict):
        return None
    cached_at = entry.get("cached_at")
    if not isinstance(cached_at, (int, float)):
        return None
    current = now if now is not None else time.time()
    if current - cached_at > ttl_s:
        return None
    result = entry.get("result")
    if not isinstance(result, dict):
        return None
    return result


def save_cached_triage(
    key: str,
    result: dict[str, Any],
    *,
    cache_path: Path | None = None,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    now: float | None = None,
) -> None:
    """Record the triage result under `key`, evicting oldest entries past cap."""
    cache_path = cache_path or DEFAULT_CACHE_PATH
    data = _load_cache_file(cache_path)
    entries: dict[str, Any] = data.setdefault("entries", {})
    entries[key] = {
        "cached_at": now if now is not None else time.time(),
        "result": result,
    }
    if len(entries) > max_entries:
        # FIFO-by-cached_at eviction. Stable across runs because insertion
        # order in Python dicts is preserved, but we sort to be defensive.
        ordered = sorted(
            entries.items(),
            key=lambda kv: kv[1].get("cached_at", 0) if isinstance(kv[1], dict) else 0,
        )
        keep = dict(ordered[-max_entries:])
        data["entries"] = keep
    _save_cache_file(cache_path, data)
