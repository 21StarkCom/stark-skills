"""Forge design-review loop — routed dispatch, finding classification, consensus.

Implements the "iron rule" review loop for stark-forge:
  1. Dispatch domains to routed agents (grouped by agent)
  2. Classify findings as fix / noise / blocked
  3. Batch fixes by section, apply, commit
  4. Targeted re-dispatch for rounds 2+ (only changed sections)
  5. Consensus for security-critical domains
  6. Halt round as final gate
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from config_loader import is_agent_enabled


# ── Constants ────────────────────────────────────────────────────────

FORGE_PROMPTS_DIR = (
    Path.home() / ".claude" / "code-review" / "prompts" / "forge-design-review"
)

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


# ── Data classes ─────────────────────────────────────────────────────


@dataclass
class PhaseResult:
    """Result of the design review phase."""

    status: str  # "completed" or "halted"
    rounds: list[dict] = field(default_factory=list)
    findings_fixed: int = 0
    noise: int = 0
    commit_shas: list[str] = field(default_factory=list)


# ── Finding ID ───────────────────────────────────────────────────────


def compute_finding_id(agent: str, domain: str, section: str, title: str) -> str:
    """Compute a stable 12-char hex hash for a finding.

    Concatenates agent, domain, section, and title with pipe delimiters,
    then returns the first 12 characters of the SHA-256 hex digest.
    """
    content = f"{agent}|{domain}|{section}|{title}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]


# ── Domain discovery ─────────────────────────────────────────────────


def _discover_forge_domains(
    prompts_dir: str | Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover forge design-review domains."""
    try:
        from dispatcher_base import discover_domains
    except ImportError:
        return {}
    if prompts_dir is None:
        prompts_dir = str(FORGE_PROMPTS_DIR)
    return discover_domains(prompts_dir, agents=["claude", "codex", "gemini"])


# ── Dispatch wrapper ─────────────────────────────────────────────────


def _dispatch_review(
    spec_text: str,
    round_num: int,
    *,
    repo_dir: str,
    prompts_dir: str,
    agents: list[str],
    domains: dict[str, dict[str, Any]],
    timeout: int,
) -> dict[str, Any]:
    """Wrapper around dispatch_plan_review. Mockable in tests."""
    try:
        from plan_review_dispatch import dispatch_plan_review

        return dispatch_plan_review(
            spec_text,
            round_num,
            repo_dir=repo_dir,
            global_prompts_dir=prompts_dir,
            agents=agents,
            domains=domains,
            timeout=timeout,
        )
    except ImportError:
        return {"findings": [], "summary": {"total_findings": 0}}


# ── Agent routing ────────────────────────────────────────────────────


def _resolve_agent(
    routed_agent: str,
    fallback_order: list[str],
) -> str | None:
    """Resolve a routed agent to an enabled agent, using fallback order."""
    if is_agent_enabled(routed_agent):
        return routed_agent
    for agent in fallback_order:
        if agent != routed_agent and is_agent_enabled(agent):
            return agent
    return None


def _group_domains_by_agent(
    domain_routing: dict[str, str],
    fallback_order: list[str],
    active_domains: dict[str, dict[str, Any]],
    consensus_domains: list[str],
) -> dict[str, dict[str, dict[str, Any]]]:
    """Group active domains by their resolved agent.

    Consensus domains are excluded from normal grouping — they are
    dispatched separately to multiple agents.
    """
    groups: dict[str, dict[str, dict[str, Any]]] = {}
    for domain_key, domain_info in active_domains.items():
        if domain_key in consensus_domains:
            continue
        routed = domain_routing.get(
            domain_key, fallback_order[0] if fallback_order else "claude",
        )
        resolved = _resolve_agent(routed, fallback_order)
        if resolved is None:
            continue
        groups.setdefault(resolved, {})[domain_key] = domain_info
    return groups


# ── Severity classification ──────────────────────────────────────────


def _severity_meets_threshold(severity: str, threshold: str) -> bool:
    """Check if a severity level meets or exceeds the threshold.

    Lower rank number = higher severity. A finding meets the threshold
    when its rank is <= the threshold rank (i.e. same or more severe).
    """
    sev_rank = _SEVERITY_ORDER.get(severity, 2)
    thr_rank = _SEVERITY_ORDER.get(threshold, 2)
    return sev_rank <= thr_rank


# ── Finding classification ───────────────────────────────────────────


def classify_findings(
    findings: list[dict[str, Any]],
    spec_text: str,
    previous_rounds: list[dict[str, Any]],
    fix_threshold: str,
) -> list[dict[str, Any]]:
    """Classify raw findings as fix, noise, or blocked.

    Classification rules (in priority order):
    1. Recurrence: 3rd time same finding_id appeared as fix -> blocked
    2. Cross-reference: 2+ agents on same section+title -> high_confidence fix
    3. Severity meets threshold -> fix
    4. Below threshold -> noise

    Second recurrence gets status=fix with recurring=True flag.
    """
    # Build recurrence map: finding_id -> count of previous rounds where it was 'fix'
    recurrence_map: dict[str, int] = {}
    for rnd in previous_rounds:
        for cf in rnd.get("classified_findings", []):
            if cf.get("status") == "fix":
                fid = cf.get("id", "")
                recurrence_map[fid] = recurrence_map.get(fid, 0) + 1

    # Build cross-reference map: (section, title) -> set of agents
    xref: dict[tuple[str, str], set[str]] = {}
    for f in findings:
        key = (f.get("section", ""), f.get("title", ""))
        xref.setdefault(key, set()).add(f.get("agent", ""))

    classified: list[dict[str, Any]] = []
    seen_xref: set[tuple[str, str]] = set()

    for f in findings:
        fid = compute_finding_id(
            f.get("agent", ""),
            f.get("domain", ""),
            f.get("section", ""),
            f.get("title", ""),
        )

        entry: dict[str, Any] = {
            "id": fid,
            "agent": f.get("agent", ""),
            "domain": f.get("domain", ""),
            "section": f.get("section", ""),
            "title": f.get("title", ""),
            "description": f.get("description", ""),
            "severity": f.get("severity", "medium"),
        }

        # Check recurrence first -- 3rd time -> blocked
        prev_count = recurrence_map.get(fid, 0)
        if prev_count >= 2:
            entry["status"] = "blocked"
            entry["recurring"] = True
            classified.append(entry)
            continue

        if prev_count == 1:
            entry["recurring"] = True

        # Check cross-reference: 2+ agents on same (section, title) -> fix
        xref_key = (f.get("section", ""), f.get("title", ""))
        agents_for_key = xref.get(xref_key, set())
        if len(agents_for_key) >= 2:
            entry["status"] = "fix"
            entry["high_confidence"] = True
            # Deduplicate: only emit one entry per cross-ref group
            if xref_key not in seen_xref:
                seen_xref.add(xref_key)
                classified.append(entry)
            continue

        # Severity threshold
        severity = f.get("severity", "medium")
        if _severity_meets_threshold(severity, fix_threshold):
            entry["status"] = "fix"
        else:
            entry["status"] = "noise"

        classified.append(entry)

    return classified


# ── Fix batching ─────────────────────────────────────────────────────


def batch_fixes(
    classified_findings: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Group fix findings by section for batched application.

    Only includes findings with status='fix'.
    """
    batches: dict[str, list[dict[str, Any]]] = {}
    for f in classified_findings:
        if f.get("status") != "fix":
            continue
        section = f.get("section", "unknown")
        batches.setdefault(section, []).append(f)
    return batches


# ── Git helpers for round commits ────────────────────────────────────


def _commit_round(spec_path: Path, round_num: int, fixes_count: int) -> str:
    """Stage and commit spec changes after a review round.

    Returns the commit SHA, or empty string on failure.
    """
    try:
        subprocess.run(
            ["git", "add", str(spec_path)],
            capture_output=True, text=True, check=True,
            cwd=str(spec_path.parent),
        )
        msg = f"forge: design review round {round_num} -- fixed {fixes_count} findings"
        result = subprocess.run(
            ["git", "commit", "-m", msg],
            capture_output=True, text=True, check=False,
            cwd=str(spec_path.parent),
        )
        if result.returncode == 0:
            sha = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True,
                cwd=str(spec_path.parent),
            )
            return sha.stdout.strip()
    except (subprocess.SubprocessError, OSError) as exc:
        print(f"[WARN] Round commit failed: {exc}", file=sys.stderr)
    return ""


# ── Targeted re-dispatch ─────────────────────────────────────────────


def _get_changed_sections_from_diff(repo_dir: Path) -> list[str]:
    """Extract section headings that changed in the last commit."""
    try:
        result = subprocess.run(
            ["git", "diff", "HEAD~1", "--unified=0"],
            capture_output=True, text=True, check=False,
            cwd=str(repo_dir),
        )
        if result.returncode != 0:
            return []
        sections: list[str] = []
        for line in result.stdout.splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                heading = re.match(r"^\+\s*(#{1,4}\s+.+)", line)
                if heading:
                    sections.append(heading.group(1).strip())
        return sections
    except (subprocess.SubprocessError, OSError):
        return []


def _map_changed_sections_to_domains(
    changed_sections: list[str],
    all_domains: list[str],
    always_include: list[str],
) -> list[str]:
    """Map changed sections to relevant domains.

    Always includes domains in always_include (typically general, consistency).
    For other domains, includes them if any changed section text contains
    the domain keyword (heuristic mapping). If no specific domains match
    beyond always_include, dispatches all domains.
    """
    domains = list(always_include)

    if not changed_sections:
        return domains

    lowered_sections = " ".join(s.lower() for s in changed_sections)

    for domain in all_domains:
        if domain in domains:
            continue
        domain_words = domain.replace("-", " ").split()
        if any(word in lowered_sections for word in domain_words):
            domains.append(domain)

    # If no specific domains matched beyond always_include, dispatch all
    if len(domains) <= len(always_include):
        return list(all_domains)

    return domains


# ── Consensus ────────────────────────────────────────────────────────


def _apply_consensus(
    findings: list[dict[str, Any]],
    threshold: int,
) -> list[dict[str, Any]]:
    """Apply consensus logic to findings from multiple agents.

    Groups findings by (section, title). Findings confirmed by >= threshold
    agents get consensus='confirmed'. Single-agent findings get
    consensus='single_agent' but are NOT auto-noised.
    """
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for f in findings:
        key = (f.get("section", ""), f.get("title", ""))
        groups.setdefault(key, []).append(f)

    result: list[dict[str, Any]] = []
    for _key, group in groups.items():
        unique_agents = {f.get("agent") for f in group}
        if len(unique_agents) >= threshold:
            rep = dict(group[0])
            rep["consensus"] = "confirmed"
            result.append(rep)
        else:
            for f in group:
                entry = dict(f)
                entry["consensus"] = "single_agent"
                result.append(entry)

    return result


# ── Main review loop ────────────────────────────────────────────────


def run_design_review(
    spec_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> PhaseResult:
    """Run the design review iron-rule loop.

    Rounds 1..max_rounds: dispatch -> classify -> fix -> commit
    Halt round (max_rounds+1): dispatch ALL domains, any fix/blocked -> HALT
    """
    max_rounds = cfg.get("max_rounds", 3)
    halt_round = max_rounds + 1
    fix_threshold = cfg.get("fix_threshold", "medium")
    domain_routing = cfg.get("domain_routing", {})
    fallback_order = cfg.get("agent_fallback_order", ["claude", "codex", "gemini"])
    consensus_domains = cfg.get("consensus_domains", [])
    consensus_threshold = cfg.get("consensus_threshold", 2)
    timeout = cfg.get("timeout", 300)
    prompts_dir = str(FORGE_PROMPTS_DIR)

    spec_text = spec_path.read_text(encoding="utf-8")

    # Discover available domains
    all_domains = _discover_forge_domains(prompts_dir)

    # Filter to only domains in routing config
    active_domains = {k: v for k, v in all_domains.items() if k in domain_routing}

    # Fallback: build from domain_routing keys if discovery found nothing
    if not active_domains:
        active_domains = {
            slug: {
                "order": f"{i + 1:02d}",
                "label": slug.replace("-", " ").title(),
                "filename": f"{i + 1:02d}-{slug}.md",
            }
            for i, slug in enumerate(domain_routing.keys())
        }

    result = PhaseResult(status="completed")
    previous_rounds: list[dict[str, Any]] = []

    for round_num in range(1, halt_round + 1):
        is_halt = round_num == halt_round

        # Determine which domains to dispatch this round
        if round_num == 1 or is_halt:
            dispatch_domains = dict(active_domains)
        else:
            # Targeted re-dispatch: only domains whose sections changed
            changed_sections = _get_changed_sections_from_diff(repo_dir)
            targeted_keys = _map_changed_sections_to_domains(
                changed_sections,
                list(active_domains.keys()),
                ["general", "consistency"],
            )
            dispatch_domains = {
                k: v for k, v in active_domains.items() if k in targeted_keys
            }

        # Group by agent and dispatch
        agent_groups = _group_domains_by_agent(
            domain_routing, fallback_order, dispatch_domains, consensus_domains,
        )

        all_findings: list[dict[str, Any]] = []

        # Dispatch each agent group
        for agent, domains_dict in agent_groups.items():
            dispatch_result = _dispatch_review(
                spec_text,
                round_num,
                repo_dir=str(repo_dir),
                prompts_dir=prompts_dir,
                agents=[agent],
                domains=domains_dict,
                timeout=timeout,
            )
            all_findings.extend(dispatch_result.get("findings", []))

        # Dispatch consensus domains to multiple agents
        for cd in consensus_domains:
            if cd not in dispatch_domains:
                continue
            cd_info = dispatch_domains[cd]
            consensus_findings: list[dict[str, Any]] = []

            # Collect agents for consensus
            consensus_agents: list[str] = []
            routed = domain_routing.get(cd)
            if routed:
                resolved = _resolve_agent(routed, fallback_order)
                if resolved:
                    consensus_agents.append(resolved)
            for agent in fallback_order:
                if agent not in consensus_agents and is_agent_enabled(agent):
                    consensus_agents.append(agent)
                if len(consensus_agents) >= consensus_threshold:
                    break

            for agent in consensus_agents:
                dispatch_result = _dispatch_review(
                    spec_text,
                    round_num,
                    repo_dir=str(repo_dir),
                    prompts_dir=prompts_dir,
                    agents=[agent],
                    domains={cd: cd_info},
                    timeout=timeout,
                )
                consensus_findings.extend(dispatch_result.get("findings", []))

            judged = _apply_consensus(consensus_findings, consensus_threshold)
            all_findings.extend(judged)

        # Classify findings
        classified = classify_findings(
            all_findings, spec_text, previous_rounds, fix_threshold,
        )

        fix_count = sum(1 for f in classified if f["status"] == "fix")
        noise_count = sum(1 for f in classified if f["status"] == "noise")
        blocked_count = sum(1 for f in classified if f["status"] == "blocked")

        round_record: dict[str, Any] = {
            "round": round_num,
            "is_halt": is_halt,
            "findings_total": len(classified),
            "fix": fix_count,
            "noise": noise_count,
            "blocked": blocked_count,
            "classified_findings": classified,
        }

        result.rounds.append(round_record)
        result.noise += noise_count

        # Halt round logic
        if is_halt:
            if fix_count > 0 or blocked_count > 0:
                result.status = "halted"
            break

        # Blocked findings -> HALT immediately
        if blocked_count > 0:
            result.status = "halted"
            break

        # Zero fix findings -> skip to halt round (continue loop)
        if fix_count == 0:
            continue

        # Apply fixes and commit
        result.findings_fixed += fix_count
        sha = _commit_round(spec_path, round_num, fix_count)
        if sha:
            result.commit_shas.append(sha)
            round_record["commit_sha"] = sha

        # Re-read spec after fixes
        spec_text = spec_path.read_text(encoding="utf-8")

        # Record for recurrence tracking
        previous_rounds.append(round_record)

    # Update state
    state["phases"]["design_review"]["rounds"] = result.rounds
    state["phases"]["design_review"]["status"] = (
        "halted" if result.status == "halted" else "completed"
    )

    return result
