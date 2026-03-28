"""Prepend-only markdown log utilities for automation fleet."""

from __future__ import annotations

import re
from pathlib import Path


def prepend_run_record(log_path: Path, run_markdown: str) -> None:
    """Insert a run record after the schema_version comment (or first H1)."""
    content = log_path.read_text() if log_path.exists() else ""
    lines = content.split("\n")

    insert_idx = None
    for i, line in enumerate(lines):
        if "<!-- schema_version: 1 -->" in line:
            insert_idx = i + 1
            break

    if insert_idx is None:
        for i, line in enumerate(lines):
            if line.startswith("# "):
                insert_idx = i + 1
                break

    if insert_idx is None:
        insert_idx = 0

    insertion = run_markdown + "\n---\n"
    lines.insert(insert_idx, insertion)
    log_path.write_text("\n".join(lines))


def parse_run_history(log_path: Path) -> list[dict]:
    """Parse a prepend-only markdown log into structured run records."""
    if not log_path.exists():
        return []

    content = log_path.read_text()
    # Split on ## Run headers
    blocks = re.split(r"(?=^## Run )", content, flags=re.MULTILINE)

    records = []
    for block in blocks:
        block = block.strip()
        if not block.startswith("## Run "):
            continue

        record: dict = {}

        # Timestamp from header
        ts_match = re.match(r"## Run (.+)", block)
        if ts_match:
            record["timestamp"] = ts_match.group(1).strip()

        # Key-value fields
        status = re.search(r"[*-]\s*\*?\*?Status\*?\*?:\s*(.+)", block)
        if status:
            record["status"] = status.group(1).strip()

        duration = re.search(r"[*-]\s*\*?\*?Duration\*?\*?:\s*([\d.]+)", block)
        if duration:
            record["duration_s"] = float(duration.group(1))

        prompt_tok = re.search(r"[*-]\s*\*?\*?Prompt tokens\*?\*?:\s*(\d+)", block)
        completion_tok = re.search(r"[*-]\s*\*?\*?Completion tokens\*?\*?:\s*(\d+)", block)
        total_tok = re.search(r"[*-]\s*\*?\*?Total tokens\*?\*?:\s*(\d+)", block)
        if prompt_tok or completion_tok or total_tok:
            record["tokens"] = {
                "prompt": int(prompt_tok.group(1)) if prompt_tok else 0,
                "completion": int(completion_tok.group(1)) if completion_tok else 0,
                "total": int(total_tok.group(1)) if total_tok else 0,
            }

        cost = re.search(r"[*-]\s*\*?\*?Cost\*?\*?:\s*\$?([\d.]+)", block)
        if cost:
            record["cost_usd"] = float(cost.group(1))

        findings = re.search(r"[*-]\s*\*?\*?Findings\*?\*?:\s*(\d+)", block)
        if findings:
            record["findings"] = int(findings.group(1))

        actions = re.search(r"[*-]\s*\*?\*?Actions\*?\*?:\s*(.+)", block)
        if actions:
            record["actions"] = actions.group(1).strip()

        error = re.search(r"[*-]\s*\*?\*?Error\*?\*?:\s*(.+)", block)
        if error:
            record["error"] = error.group(1).strip()

        records.append(record)

    return records
