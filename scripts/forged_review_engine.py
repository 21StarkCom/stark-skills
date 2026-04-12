"""Pure logic for stark-forged-review: no subprocess, no network, no sqlite.

Everything here is deterministic and unit-testable:
- merge_findings — combine leader output + second-opinion output into tagged buckets
- compute_gate — decide light path vs forge path from actionable findings
- scope_delta_rereview — scope next round to affected domains + changed files
- select_domains_from_triage — validate and order selected domains

See docs/specs/2026-04-12-stark-forged-review-design.md for the design rationale.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Iterable

VERDICT_CONFIRMED = "confirmed"
VERDICT_DISPUTED = "disputed"
VERDICT_LEADER_ONLY = "leader_only"
VERDICT_SECOND_ONLY = "second_only"

VALID_VERDICTS = {
    VERDICT_CONFIRMED,
    VERDICT_DISPUTED,
    VERDICT_LEADER_ONLY,
}

PATH_LIGHT = "light"
PATH_FORGE = "forge"

SEVERITY_CRITICAL = "critical"


# ── Finding merge ──────────────────────────────────────────────────────


def merge_findings(
    leader_findings: list[dict[str, Any]],
    second_result: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    """Merge leader + second-opinion outputs into four tagged buckets.

    Inputs
    ------
    leader_findings : list of {id, severity, file, line, title, detail, suggestion}
    second_result : {
        "decisions": [{"id": ..., "verdict": "confirmed|disputed|leader_only", "reason": ...}],
        "second_only": [{"severity", "file", "line", "title", "detail", "suggestion"}],
    }

    Returns
    -------
    {
        "confirmed":   [... leader findings marked confirmed ...],
        "disputed":    [... leader findings marked disputed ...],
        "leader_only": [... leader findings with no/unknown second verdict ...],
        "second_only": [... findings raised only by the second agent ...],
    }

    Unknown leader IDs in `decisions` are ignored. Missing decisions default
    to `leader_only` (safe fallback — leader finding is tracked but not acted on).
    """
    decisions_by_id: dict[str, str] = {}
    for d in second_result.get("decisions") or []:
        fid = d.get("id")
        verdict = d.get("verdict")
        if fid and verdict in VALID_VERDICTS:
            decisions_by_id[fid] = verdict

    confirmed: list[dict[str, Any]] = []
    disputed: list[dict[str, Any]] = []
    leader_only: list[dict[str, Any]] = []

    for finding in leader_findings:
        fid = finding.get("id")
        verdict = decisions_by_id.get(fid, VERDICT_LEADER_ONLY) if fid else VERDICT_LEADER_ONLY
        if verdict == VERDICT_CONFIRMED:
            confirmed.append(finding)
        elif verdict == VERDICT_DISPUTED:
            disputed.append(finding)
        else:
            leader_only.append(finding)

    second_only = list(second_result.get("second_only") or [])

    return {
        "confirmed": confirmed,
        "disputed": disputed,
        "leader_only": leader_only,
        "second_only": second_only,
    }


def actionable_from_merged(merged: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Return the list of findings that count toward the forge gate."""
    return list(merged.get("confirmed", [])) + list(merged.get("second_only", []))


# ── Gate decision ──────────────────────────────────────────────────────


def compute_gate(
    actionable_findings: list[dict[str, Any]],
    forge_threshold: int,
    force_escalate: bool = False,
    no_escalate: bool = False,
) -> dict[str, Any]:
    """Decide whether to take the light path or the forge path.

    Returns {path, reason, actionable_count, critical_count}.

    Rules (in order):
      1. force_escalate and no_escalate are mutually exclusive — ValueError if both.
      2. force_escalate → forge path.
      3. no_escalate → light path.
      4. ≥1 critical finding → forge path.
      5. actionable_count ≥ forge_threshold → forge path.
      6. else → light path.
    """
    if force_escalate and no_escalate:
        raise ValueError("force_escalate and no_escalate are mutually exclusive")

    actionable_count = len(actionable_findings)
    critical_count = sum(
        1 for f in actionable_findings if (f.get("severity") or "").lower() == SEVERITY_CRITICAL
    )

    if force_escalate:
        return {
            "path": PATH_FORGE,
            "reason": "force_escalate flag",
            "actionable_count": actionable_count,
            "critical_count": critical_count,
        }
    if no_escalate:
        return {
            "path": PATH_LIGHT,
            "reason": "no_escalate flag",
            "actionable_count": actionable_count,
            "critical_count": critical_count,
        }
    if critical_count >= 1:
        return {
            "path": PATH_FORGE,
            "reason": f"{critical_count} critical finding(s)",
            "actionable_count": actionable_count,
            "critical_count": critical_count,
        }
    if actionable_count >= forge_threshold:
        return {
            "path": PATH_FORGE,
            "reason": f"{actionable_count} actionable findings ≥ threshold {forge_threshold}",
            "actionable_count": actionable_count,
            "critical_count": critical_count,
        }
    return {
        "path": PATH_LIGHT,
        "reason": f"{actionable_count} actionable findings < threshold {forge_threshold}",
        "actionable_count": actionable_count,
        "critical_count": critical_count,
    }


# ── Delta re-review scoping ────────────────────────────────────────────


def scope_delta_rereview(
    prior_round: dict[str, Any],
    fix_commits: list[str],
    repo_root: Path | str | None = None,
) -> dict[str, Any]:
    """Scope the next round to domains that had findings and files touched.

    Returns {"domains": [...], "files": [...]}.

    - Domains include any where prior_round['domain_findings'][domain] has
      any actionable findings (confirmed or second_only).
    - Files come from `git diff --name-only <first>^..<last>` over fix_commits.
      If only one commit, `git show --name-only`.
      If zero commits, returns files == [] and all domains that had findings.
    """
    domain_findings = prior_round.get("domain_findings") or {}
    domains: list[str] = []
    for domain, buckets in domain_findings.items():
        confirmed = buckets.get("confirmed") or []
        second_only = buckets.get("second_only") or []
        if confirmed or second_only:
            domains.append(domain)

    files: list[str] = []
    if fix_commits:
        cwd = str(repo_root) if repo_root else None
        try:
            if len(fix_commits) == 1:
                out = subprocess.run(
                    ["git", "show", "--name-only", "--pretty=format:", fix_commits[0]],
                    capture_output=True, text=True, check=True, cwd=cwd, timeout=10,
                )
            else:
                rev_range = f"{fix_commits[0]}^..{fix_commits[-1]}"
                out = subprocess.run(
                    ["git", "diff", "--name-only", rev_range],
                    capture_output=True, text=True, check=True, cwd=cwd, timeout=10,
                )
            files = [line for line in out.stdout.splitlines() if line.strip()]
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            files = []

    return {"domains": sorted(set(domains)), "files": sorted(set(files))}


# ── Triage post-processing ─────────────────────────────────────────────


def select_domains_from_triage(
    triage_output: Any,
    always_on: Iterable[str],
    all_domains: Iterable[str],
) -> list[str]:
    """Validate triage output and return ordered selected domains.

    - Always includes every `always_on` domain (regardless of triage).
    - Preserves the order defined by `all_domains`.
    - Drops any domain not in `all_domains` (with no error — triage may hallucinate).
    - Raises ValueError if triage_output is missing `selected_domains` or is malformed.
    """
    if not isinstance(triage_output, dict):
        raise ValueError("triage_output must be a dict")
    selected = triage_output.get("selected_domains")
    if not isinstance(selected, list):
        raise ValueError("triage_output.selected_domains must be a list")

    all_set = list(all_domains)
    selected_set = {s for s in selected if isinstance(s, str)}
    required = {a for a in always_on if a in all_set}
    effective = selected_set | required
    return [d for d in all_set if d in effective]
