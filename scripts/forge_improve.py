#!/usr/bin/env python3
"""Self-improvement module for forge — noise-triggered prompt improvements.

Checks signal-to-noise ratios across domains and queues improvement prompts
when noise exceeds threshold. All prompt construction includes a firewall to
prevent raw spec content or finding descriptions from leaking into improvement
requests.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from forge_audit import get_domain_snr

# Default SNR threshold below which a domain is queued for improvement
_DEFAULT_NOISE_THRESHOLD = 0.33


def maybe_queue_improvements(
    run_summary: dict[str, Any],
    cfg: dict[str, Any],
) -> list[str]:
    """Return a list of domain names whose rolling SNR is below threshold.

    Args:
        run_summary: The structured run summary from ForgeProgress.summary()
                     or any dict containing a 'domain_stats' list with keys
                     'domain', 'signal_count', 'noise_count', 'run_id', etc.
                     Must also contain 'db_path' pointing to the metrics db.
        cfg: Forge config section (from get_forge_config()).  Uses the
             'noise_improvement_threshold' key; falls back to 0.33.

    Returns:
        List of domain slugs where SNR < threshold.
    """
    threshold = cfg.get("noise_improvement_threshold", _DEFAULT_NOISE_THRESHOLD)
    db_path = run_summary.get("db_path")
    if not db_path:
        return []

    domains_to_improve: list[str] = []

    # Collect unique domain names from this run's stats
    domain_stats = run_summary.get("domain_stats", [])
    seen_domains: set[str] = set()
    for stat in domain_stats:
        domain = stat.get("domain")
        if domain and domain not in seen_domains:
            seen_domains.add(domain)

    for domain in seen_domains:
        try:
            snr = get_domain_snr(db_path, domain)
        except Exception:
            # DB unavailable — skip without crashing
            continue
        if snr < threshold:
            domains_to_improve.append(domain)

    return domains_to_improve


def build_improvement_prompt(
    domain: str,
    snr: float,
    current_prompt: str,
    finding_counts: dict[str, int],
) -> str:
    """Build a metadata-only improvement prompt for a noisy domain.

    FIREWALL: This function MUST NOT include raw spec content, finding
    description text, or any user-supplied doc text. Only aggregate
    statistics and the current prompt text are included.

    Args:
        domain: Domain slug (e.g. 'security', 'api-design').
        snr: Current signal-to-noise ratio (0.0–1.0).
        current_prompt: The full text of the current domain prompt file.
        finding_counts: Aggregate counts only, e.g. {'signal': 12, 'noise': 8}.
                        Do NOT pass raw finding descriptions here.

    Returns:
        A prompt string safe to pass to an LLM for prompt improvement.
    """
    total = sum(finding_counts.values())
    signal = finding_counts.get("signal", 0)
    noise = finding_counts.get("noise", 0)

    lines = [
        f"# Prompt Improvement Request: domain={domain!r}",
        "",
        "## Signal-to-Noise Analysis",
        f"- Domain: {domain}",
        f"- Current SNR: {snr:.3f} (signal / total findings)",
        f"- Total findings sampled: {total}",
        f"- Signal findings: {signal}",
        f"- Noise findings: {noise}",
        "",
        "## Task",
        (
            "The domain prompt below is generating too many noise findings "
            f"(SNR={snr:.3f}, threshold=0.33). Revise the prompt to be more "
            "precise so it only surfaces actionable issues."
        ),
        "",
        "## Guidelines",
        "- Tighten scope: remove vague or catch-all language.",
        "- Add negative examples or explicit exclusions if helpful.",
        "- Keep the prompt concise; prefer specificity over coverage.",
        "- Do NOT change the domain or its core intent.",
        "- Output ONLY the revised prompt text — no preamble, no explanation.",
        "",
        "## Current Prompt",
        "```",
        current_prompt,
        "```",
    ]
    return "\n".join(lines)


def create_improvement_pr(
    branch_name: str,
    files: list[str],  # noqa: ARG001 — informational; caller already committed
    title: str,
    body: str,
) -> bool:
    """Create a GitHub PR for prompt improvements.

    Runs ``gh pr create`` after unsetting GH_TOKEN so the PR appears under
    the user's native auth (not the bot).

    Args:
        branch_name: The branch to open the PR from.
        files: List of file paths that were modified (informational; not
               staged here — caller must have already committed them).
        title: PR title.
        body: PR body (markdown).

    Returns:
        True if the PR was created successfully, False on error.
    """
    env_cmd = "unset GH_TOKEN"
    pr_cmd = [
        "gh", "pr", "create",
        "--title", title,
        "--body", body,
        "--head", branch_name,
    ]

    try:
        # Unset GH_TOKEN then create PR in a single shell invocation
        shell_cmd = f"{env_cmd} && " + " ".join(
            _shell_quote(a) for a in pr_cmd
        )
        result = subprocess.run(
            shell_cmd,
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            print(
                f"[forge-improve] gh pr create failed: {result.stderr.strip()}",
            )
            return False
        return True
    except OSError as exc:
        print(f"[forge-improve] subprocess error: {exc}")
        return False


def maybe_consolidate_heuristics(
    heuristics_path: Path,
    threshold: int = 50,
) -> bool:
    """Return True if the heuristics file has accumulated enough patches to warrant consolidation.

    Checks the 'patches_since_consolidation' counter in the heuristics JSON.
    The actual consolidation (merging overlapping heuristics, de-duplication)
    is LLM-driven and is NOT performed here — this is a trigger check only.

    Args:
        heuristics_path: Path to forge_heuristics.json.
        threshold: Minimum number of patches before consolidation is triggered.

    Returns:
        True if patches_since_consolidation > threshold, False otherwise or
        if the file cannot be read.
    """
    import json

    if not heuristics_path.exists():
        return False

    try:
        data = json.loads(heuristics_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False

    patches = data.get("patches_since_consolidation", 0)
    return isinstance(patches, int) and patches > threshold


# ── Internal helpers ──────────────────────────────────────────────────


def _shell_quote(s: str) -> str:
    """Minimal shell quoting — wrap in single quotes, escape embedded ones."""
    return "'" + s.replace("'", "'\\''") + "'"
