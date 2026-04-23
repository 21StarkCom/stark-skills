#!/usr/bin/env python3
"""Idempotent PR commenter for stark-graph reports.

Posts or updates a single comment on a GitHub PR containing a DiffReport
and/or ValidationReport rendered as Markdown. Uses a hidden HTML marker to
detect an existing comment and update it instead of creating a duplicate.

Exit codes:
    0 — success
    1 — argument / auth error
    2 — API retry budget exhausted
"""

from __future__ import annotations

import html
import json
import logging
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

import requests

if TYPE_CHECKING:
    from graph.model import DiffReport, ValidationReport

# Hidden HTML comment used to find our comment for idempotent updates
MARKER = "<!-- stark-graph-comment -->"
MAX_COMMENT_CHARS = 60_000
MAX_DETAILS_ITEMS = 100
MAX_VALIDATION_ITEMS = 100

# Retry / timeout settings
MAX_TOTAL_SLEEP = 120   # seconds budget per request's retry loop
PER_REQUEST_TIMEOUT = 10  # seconds per individual HTTP call

API = "https://api.github.com"

log = logging.getLogger(__name__)


# ── Markdown rendering ───────────────────────────────────────────────────


def _esc(text: str) -> str:
    """HTML-escape repo-derived content to prevent injection."""
    return html.escape(str(text))


def _details_table(title: str, items: list[str], limit: int = MAX_DETAILS_ITEMS) -> str:
    """Render a collapsed <details> block with items as a single-column table."""
    if not items:
        return ""
    shown = items[:limit]
    rows = "\n".join(f"| `{_esc(item)}` |" for item in shown)
    if len(items) > limit:
        rows += f"\n| _... {len(items) - limit} more omitted from comment_ |"
    return (
        f"\n<details><summary>{_esc(title)} ({len(items)})</summary>\n\n"
        f"| ID |\n|----|\n{rows}\n\n"
        f"</details>\n"
    )


def _limited_bullets(items: list[str], limit: int = MAX_VALIDATION_ITEMS) -> list[str]:
    rows = [f"- {_esc(item)}\n" for item in items[:limit]]
    if len(items) > limit:
        rows.append(f"- _... {len(items) - limit} more omitted from comment_\n")
    return rows


def _fit_comment(body: str) -> str:
    if len(body) <= MAX_COMMENT_CHARS:
        return body
    suffix = (
        "\n\n_Comment truncated to stay under GitHub's size limit. "
        "See uploaded graph artifacts for the full report._\n"
    )
    return body[: MAX_COMMENT_CHARS - len(suffix)] + suffix


def render_markdown(
    diff: "DiffReport | None" = None,
    validation: "ValidationReport | None" = None,
) -> str:
    """Render DiffReport and/or ValidationReport as GitHub-flavored Markdown."""
    parts: list[str] = [MARKER, "\n## stark-graph\n"]

    if diff is not None:
        parts.append(
            f"\n### Diff `{_esc(diff.base_ref)}` → `{_esc(diff.head_ref)}`\n\n"
            f"| | Nodes | Edges |\n|---|---|---|\n"
            f"| ➕ Added | {len(diff.added_nodes)} | {len(diff.added_edges)} |\n"
            f"| ➖ Removed | {len(diff.removed_nodes)} | {len(diff.removed_edges)} |\n"
        )
        parts.append(_details_table("Added nodes", diff.added_nodes))
        parts.append(_details_table("Removed nodes", diff.removed_nodes))
        parts.append(_details_table("Added edges", diff.added_edges))
        parts.append(_details_table("Removed edges", diff.removed_edges))

        br = diff.blast_radius
        impacted = sorted(set(br.direct + br.transitive + br.event_subscribers))
        if impacted:
            cap_note = " _(depth cap reached)_" if br.depth_cap_reached else ""
            parts.append(f"\n**Blast radius**{cap_note}: {len(impacted)} node(s)\n")
            parts.append(_details_table("Impacted nodes", impacted))

    if validation is not None:
        parts.append(
            f"\n### Validation `{_esc(validation.graph_repo)}`\n\n"
            f"Nodes: {validation.node_count} | Edges: {validation.edge_count}\n"
        )
        if validation.errors:
            parts.append(f"\n**Errors** ({len(validation.errors)}):\n")
            parts.extend(_limited_bullets(validation.errors))
        if validation.warnings:
            parts.append(f"\n**Warnings** ({len(validation.warnings)}):\n")
            parts.extend(_limited_bullets(validation.warnings))
        if not validation.errors and not validation.warnings:
            parts.append("\n✅ No errors or warnings.\n")

    return _fit_comment("".join(parts))


# ── HTTP with retry ──────────────────────────────────────────────────────


def _request_with_retry(
    method: str,
    url: str,
    headers: dict,
    json_body: dict | None = None,
    params: dict | None = None,
) -> requests.Response:
    """Make an HTTP request with exponential backoff on 429 / 5xx.

    Each call has its own MAX_TOTAL_SLEEP budget.
    Exits with code 2 when the budget is exhausted or a timeout occurs.
    """
    backoff = 1
    total_slept = 0

    while True:
        try:
            resp = requests.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=params,
                timeout=PER_REQUEST_TIMEOUT,
            )
        except requests.exceptions.Timeout:
            log.error("Request timed out: %s %s", method, url)
            sys.exit(2)

        if resp.status_code == 429 or resp.status_code >= 500:
            retry_after = int(resp.headers.get("Retry-After", 0))
            sleep_time = max(backoff, retry_after)

            if total_slept + sleep_time > MAX_TOTAL_SLEEP:
                log.error(
                    "Retry budget exhausted after %ds total sleep (last status: %d)",
                    total_slept,
                    resp.status_code,
                )
                sys.exit(2)

            log.warning(
                "Status %d — retrying in %ds (budget used: %ds)",
                resp.status_code,
                sleep_time,
                total_slept,
            )
            time.sleep(sleep_time)
            total_slept += sleep_time
            backoff = min(backoff * 2, 60)
            continue

        return resp


# ── GitHub API interaction ───────────────────────────────────────────────


def _find_marker_comment_id(repo: str, pr_number: int, headers: dict) -> int | None:
    """Scan issue comments for one containing MARKER. Returns comment id or None."""
    for page in range(1, 11):  # cap at 1000 comments (10 pages × 100)
        resp = _request_with_retry(
            "GET",
            f"{API}/repos/{repo}/issues/{pr_number}/comments",
            headers,
            params={"per_page": 100, "page": page},
        )
        resp.raise_for_status()
        comments = resp.json()
        for c in comments:
            if MARKER in c.get("body", ""):
                return c["id"]
        if len(comments) < 100:
            break
    return None


def post_comment(
    repo: str,
    pr_number: int,
    body: str,
    token: str,
) -> dict:
    """Post or idempotently update the stark-graph comment on a PR.

    Returns a dict with keys:
        url    — HTML URL of the created/updated comment
        action — "created" or "updated"
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }

    existing_id = _find_marker_comment_id(repo, pr_number, headers)

    if existing_id is not None:
        resp = _request_with_retry(
            "PATCH",
            f"{API}/repos/{repo}/issues/comments/{existing_id}",
            headers,
            json_body={"body": body},
        )
        resp.raise_for_status()
        return {"url": resp.json()["html_url"], "action": "updated"}

    resp = _request_with_retry(
        "POST",
        f"{API}/repos/{repo}/issues/{pr_number}/comments",
        headers,
        json_body={"body": body},
    )
    resp.raise_for_status()
    return {"url": resp.json()["html_url"], "action": "created"}


# ── CLI entry point ──────────────────────────────────────────────────────


def main() -> None:
    import argparse

    # Allow running from scripts/graph/ or scripts/
    _scripts_dir = Path(__file__).parent.parent
    if str(_scripts_dir) not in sys.path:
        sys.path.insert(0, str(_scripts_dir))

    p = argparse.ArgumentParser(description="Post or update a stark-graph PR comment")
    p.add_argument("--repo", required=True, help="GitHub org/repo (e.g. GetEvinced/myrepo)")
    p.add_argument("--pr", type=int, required=True, help="PR number")
    p.add_argument("--diff", help="Path to diff_report.json")
    p.add_argument("--validation", help="Path to validation_report.json")
    args = p.parse_args()

    if not args.diff and not args.validation:
        p.error("At least one of --diff or --validation is required")

    diff = None
    if args.diff:
        from graph.model import DiffReport
        diff = DiffReport.model_validate_json(Path(args.diff).read_text())

    validation = None
    if args.validation:
        from graph.model import ValidationReport
        validation = ValidationReport.model_validate_json(Path(args.validation).read_text())

    import github_app
    token = github_app.get_token()

    body = render_markdown(diff=diff, validation=validation)
    result = post_comment(args.repo, args.pr, body, token)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
