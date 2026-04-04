#!/usr/bin/env python3
"""Aggregate performance metrics across all stark skill runs.

Reads ~/.claude/code-review/history/, normalizes multiple JSON formats
into unified RunRecords, computes aggregates, and outputs a report.

Usage:
    metrics.py                          # human-readable report
    metrics.py --json                   # JSON output
    metrics.py --repo GetEvinced/foo    # filter by repo
    metrics.py --skill stark-team-review     # filter by skill type
    metrics.py --since 2026-03-15       # filter by date
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class PhaseRecord:
    name: str
    duration_s: float
    status: str = "completed"  # completed | failed | skipped


@dataclass
class AgentResult:
    agent: str
    domain: str
    duration_s: float
    findings_count: int
    error: str | None = None


@dataclass
class AgentSummary:
    dispatched: int
    succeeded: int
    failed: int
    results: list[AgentResult] = field(default_factory=list)


@dataclass
class FindingSummary:
    total_raw: int
    deduplicated: int
    by_outcome: dict[str, int] = field(default_factory=dict)
    by_severity: dict[str, int] = field(default_factory=dict)


@dataclass
class RunRecord:
    skill: str
    started_at: str
    completed_at: str | None = None
    duration_s: float = 0.0
    outcome: str = "success"
    repo: str | None = None
    ref: str | None = None
    mode: str | None = None
    phases: list[PhaseRecord] = field(default_factory=list)
    agents: AgentSummary | None = None
    findings: FindingSummary | None = None
    metrics: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Failure telemetry paths
# ---------------------------------------------------------------------------

HEALER_LOG = Path.home() / ".claude" / "code-review" / "healer.jsonl"
VALIDATION_LOG_DIR = Path.home() / ".claude" / "code-review" / "logs"

# ---------------------------------------------------------------------------
# History loading & normalization
# ---------------------------------------------------------------------------

HISTORY_DIR = Path.home() / ".claude" / "code-review" / "history"

OUTCOME_KEYS = ["fix", "noise", "false_positive", "ignored", "recurring"]
SEVERITY_KEYS = ["critical", "high", "medium", "low"]


def _file_date(p: Path) -> str:
    """ISO date from file mtime."""
    return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%dT%H:%M:%S")


def _normalize_pr_review(data: dict, path: Path) -> RunRecord:
    """Normalize PR review rounds.json (formats A-D)."""
    repo = data.get("repo", "")
    pr = data.get("pr", "")
    mode = data.get("mode", "unknown")
    date = _file_date(path)

    agents_list = data.get("agents", [])
    rounds_count = 0
    stop_reason = data.get("stop_reason", data.get("outcome", ""))

    agent_results: list[AgentResult] = []
    findings = None
    errors: list[str] = []

    # --- Format B: has rounds[].results[] with duration_s ---
    rounds_data = data.get("rounds", [])
    if isinstance(rounds_data, list) and rounds_data:
        first = rounds_data[0] if isinstance(rounds_data[0], dict) else {}

        if "results" in first:
            # Format B — detailed agent results
            rounds_count = len(rounds_data)
            for rnd in rounds_data:
                for r in rnd.get("results", []):
                    ar = AgentResult(
                        agent=r.get("agent", ""),
                        domain=r.get("domain", ""),
                        duration_s=r.get("duration_s", 0.0),
                        findings_count=len(r.get("findings", [])) if isinstance(r.get("findings"), list) else r.get("findings_count", 0),
                        error=r.get("error"),
                    )
                    agent_results.append(ar)
                    if ar.error:
                        errors.append(f"{ar.agent}-{ar.domain}: {ar.error}")

            # Reconstruct findings from individual results
            total_raw = sum(ar.findings_count for ar in agent_results)
            findings = FindingSummary(total_raw=total_raw, deduplicated=0)

        elif "classifications" in first:
            # Format C — summary with per-agent counts
            rounds_count = len(rounds_data)
            for rnd in rounds_data:
                cls = rnd.get("classifications", {})
                findings = FindingSummary(
                    total_raw=rnd.get("total_findings", 0),
                    deduplicated=rnd.get("total_findings", 0),
                    by_outcome={k: cls.get(k, 0) for k in OUTCOME_KEYS},
                )
                for agent_name, agent_data in rnd.get("agents", {}).items():
                    if isinstance(agent_data, dict):
                        agent_results.append(AgentResult(
                            agent=agent_name,
                            domain="all",
                            duration_s=0.0,
                            findings_count=agent_data.get("findings", 0),
                        ))
    elif isinstance(rounds_data, int):
        rounds_count = rounds_data

    # --- Format A: has findings.total_raw + issues[] ---
    findings_data = data.get("findings")
    if isinstance(findings_data, dict):
        findings = FindingSummary(
            total_raw=findings_data.get("total_raw", 0),
            deduplicated=findings_data.get("deduplicated", 0),
            by_outcome=findings_data.get("by_outcome", {}),
            by_severity=findings_data.get("by_severity", {}),
        )

    # --- Format D: minimal top-level counts ---
    if findings is None and "total_raw_findings" in data:
        findings = FindingSummary(
            total_raw=data.get("total_raw_findings", 0),
            deduplicated=data.get("deduplicated_findings", 0),
            by_outcome={"noise": data.get("noise_findings", 0)},
        )

    # Agent summary
    agent_summary = None
    if agent_results:
        agent_summary = AgentSummary(
            dispatched=len(agent_results),
            succeeded=sum(1 for r in agent_results if not r.error),
            failed=sum(1 for r in agent_results if r.error),
            results=agent_results,
        )
    elif agents_list:
        # No results but we know which agents were used
        agent_summary = AgentSummary(
            dispatched=0, succeeded=0, failed=0, results=[],
        )

    # Note if gemini had issues (format D puts this as a top-level string)
    gemini_note = data.get("gemini")
    if isinstance(gemini_note, str):
        errors.append(f"gemini: {gemini_note}")

    return RunRecord(
        skill="stark-team-review",
        started_at=date,
        completed_at=date,
        duration_s=0.0,
        outcome="success",
        repo=repo or None,
        ref=str(pr) if pr else None,
        mode=mode,
        agents=agent_summary,
        findings=findings,
        metrics={
            "rounds": rounds_count,
            "max_rounds": data.get("max_rounds", 0),
            "stop_reason": stop_reason,
            "has_assessment": (path.parent / "prompt-assessment.md").exists(),
        },
        errors=errors,
    )


def _normalize_plan_review(data: dict, path: Path) -> RunRecord:
    """Normalize plan review rounds.json."""
    date = _file_date(path)

    agents_list = data.get("agents", [])
    domains = data.get("domains", [])
    agent_results: list[AgentResult] = []
    errors: list[str] = []

    # Plan reviews can be a single round object or wrapped
    results = data.get("results", [])
    if not results and "round" in data:
        results = data.get("results", [])

    for r in results:
        ar = AgentResult(
            agent=r.get("agent", ""),
            domain=r.get("domain", ""),
            duration_s=r.get("duration_s", 0.0),
            findings_count=r.get("findings_count", 0),
            error=r.get("error"),
        )
        agent_results.append(ar)
        if ar.error:
            errors.append(f"{ar.agent}-{ar.domain}: {ar.error}")

    agent_summary = AgentSummary(
        dispatched=len(agent_results),
        succeeded=sum(1 for r in agent_results if not r.error),
        failed=sum(1 for r in agent_results if r.error),
        results=agent_results,
    ) if agent_results else None

    plan_name = path.parent.name

    return RunRecord(
        skill="stark-team-review-plan",
        started_at=date,
        completed_at=date,
        duration_s=sum(r.duration_s for r in agent_results),
        outcome="success",
        repo=None,
        ref=plan_name,
        mode="plan-review",
        agents=agent_summary,
        findings=FindingSummary(
            total_raw=sum(ar.findings_count for ar in agent_results),
            deduplicated=0,
        ),
        metrics={
            "round": data.get("round", 1),
            "agents": agents_list,
            "domains": domains,
        },
        errors=errors,
    )


def _load_future_runs() -> list[RunRecord]:
    """Load RunRecord JSON files from history/runs/ (future format)."""
    runs_dir = HISTORY_DIR / "runs"
    records = []
    if not runs_dir.exists():
        return records
    for f in sorted(runs_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            records.append(RunRecord(
                skill=data.get("skill", "unknown"),
                started_at=data.get("started_at", _file_date(f)),
                completed_at=data.get("completed_at"),
                duration_s=data.get("duration_s", 0.0),
                outcome=data.get("outcome", "success"),
                repo=data.get("repo"),
                ref=data.get("ref"),
                mode=data.get("mode"),
                phases=[PhaseRecord(**p) for p in data.get("phases", [])],
                agents=_parse_agent_summary(data.get("agents")) if data.get("agents") else None,
                findings=_parse_findings_summary(data.get("findings")) if data.get("findings") else None,
                metrics=data.get("metrics", {}),
                errors=data.get("errors", []),
            ))
        except (json.JSONDecodeError, TypeError, KeyError) as e:
            print(f"Warning: skipping {f}: {e}", file=sys.stderr)
    return records


def _parse_agent_summary(data: dict) -> AgentSummary:
    results = [AgentResult(**r) for r in data.get("results", [])]
    return AgentSummary(
        dispatched=data.get("dispatched", 0),
        succeeded=data.get("succeeded", 0),
        failed=data.get("failed", 0),
        results=results,
    )


def _parse_findings_summary(data: dict) -> FindingSummary:
    return FindingSummary(
        total_raw=data.get("total_raw", 0),
        deduplicated=data.get("deduplicated", 0),
        by_outcome=data.get("by_outcome", {}),
        by_severity=data.get("by_severity", {}),
    )


def load_failure_metrics() -> dict:
    """Parse healer.jsonl and validation logs to compute failure telemetry metrics."""
    result: dict = {
        "validation_pass_rate": None,
        "top_failure_categories": {},
        "heal_success_rate": None,
        "heal_attempts_total": 0,
    }

    # --- Parse healer.jsonl for heal_attempt events ---
    heal_attempts = 0
    heal_successes = 0
    category_counts: Counter = Counter()

    if HEALER_LOG.exists():
        try:
            for line in HEALER_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # failure_classifier entries have "category" field
                category = entry.get("category")
                if category and category != "UNCLASSIFIED":
                    category_counts[category] += 1
                # self_healer entries have "action" + "status"
                action = entry.get("action")
                status = entry.get("status")
                if action and status in ("applied", "suggested", "skipped"):
                    heal_attempts += 1
                    if status == "applied":
                        verify_passed = entry.get("verify_passed", False)
                        if verify_passed:
                            heal_successes += 1
        except OSError:
            pass

    result["heal_attempts_total"] = heal_attempts
    if heal_attempts > 0:
        result["heal_success_rate"] = round(heal_successes / heal_attempts * 100, 1)
    result["top_failure_categories"] = dict(category_counts.most_common(5))

    # --- Parse validation log dir for pass/fail counts ---
    validation_pass = 0
    validation_fail = 0

    if VALIDATION_LOG_DIR.exists():
        try:
            for log_file in sorted(VALIDATION_LOG_DIR.glob("*.stderr")):
                # A non-empty stderr file means the validation failed
                try:
                    content = log_file.read_text(encoding="utf-8", errors="replace")
                    if content.strip():
                        validation_fail += 1
                    else:
                        validation_pass += 1
                except OSError:
                    pass
        except OSError:
            pass

    validation_total = validation_pass + validation_fail
    if validation_total > 0:
        result["validation_pass_rate"] = round(validation_pass / validation_total * 100, 1)

    return result


def load_all_records() -> list[RunRecord]:
    """Load and normalize all history into RunRecords."""
    records: list[RunRecord] = []

    # PR reviews: history/GetEvinced/{repo}/{pr}/rounds.json
    pr_dir = HISTORY_DIR
    for org_dir in sorted(pr_dir.iterdir()):
        if not org_dir.is_dir() or org_dir.name in ("plan-reviews", "parse-errors", "runs"):
            continue
        for repo_dir in sorted(org_dir.iterdir()):
            if not repo_dir.is_dir():
                continue
            for pr_dir_inner in sorted(repo_dir.iterdir()):
                if not pr_dir_inner.is_dir():
                    continue
                rounds_file = pr_dir_inner / "rounds.json"
                if rounds_file.exists():
                    try:
                        data = json.loads(rounds_file.read_text())
                        record = _normalize_pr_review(data, rounds_file)
                        # Fill repo from path if not in JSON
                        if not record.repo:
                            record.repo = f"{org_dir.name}/{repo_dir.name}"
                        if not record.ref:
                            record.ref = pr_dir_inner.name
                        records.append(record)
                    except (json.JSONDecodeError, TypeError) as e:
                        print(f"Warning: skipping {rounds_file}: {e}", file=sys.stderr)

    # Plan reviews: history/plan-reviews/{name}/rounds.json
    plan_dir = HISTORY_DIR / "plan-reviews"
    if plan_dir.exists():
        for plan in sorted(plan_dir.iterdir()):
            if not plan.is_dir():
                continue
            rounds_file = plan / "rounds.json"
            if rounds_file.exists():
                try:
                    data = json.loads(rounds_file.read_text())
                    if isinstance(data, list):
                        # Some plan reviews store an array of rounds; skip
                        print(f"Warning: skipping {rounds_file}: expected object, got array", file=sys.stderr)
                        continue
                    records.append(_normalize_plan_review(data, rounds_file))
                except (json.JSONDecodeError, TypeError) as e:
                    print(f"Warning: skipping {rounds_file}: {e}", file=sys.stderr)

    # Future: history/runs/*.json
    records.extend(_load_future_runs())

    return records


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m {seconds % 60:.0f}s"
    return f"{seconds / 3600:.0f}h {(seconds % 3600) / 60:.0f}m"


def _kpi_status(value: float | None, good: float, warn: float, lower_is_better: bool = False) -> str:
    """Return good/warning/critical/unknown based on thresholds."""
    if value is None:
        return "unknown"
    if lower_is_better:
        if value <= good:
            return "good"
        elif value <= warn:
            return "warning"
        return "critical"
    else:
        if value >= good:
            return "good"
        elif value >= warn:
            return "warning"
        return "critical"


def compute_kpis(records: list[RunRecord], failure_telemetry: dict | None = None) -> dict:
    """Compute 8 KPIs with value, trend (vs previous period), and status."""
    if failure_telemetry is None:
        failure_telemetry = {}

    now = datetime.now()
    cutoff_current = (now - timedelta(days=30)).strftime("%Y-%m-%d")
    cutoff_previous = (now - timedelta(days=60)).strftime("%Y-%m-%d")
    current = [r for r in records if r.started_at[:10] >= cutoff_current]
    previous = [r for r in records if cutoff_previous <= r.started_at[:10] < cutoff_current]
    # Fall back to all records if current period has too few data points
    if len(current) < 2:
        current = records
        previous = []

    def _vals(recs: list[RunRecord]) -> dict:
        review_recs = [r for r in recs if "review" in r.skill.lower()]
        total_review = len(review_recs)

        # 1. review_coverage: % of review runs that produced findings
        if total_review > 0:
            with_findings = sum(1 for r in review_recs if r.findings and r.findings.total_raw > 0)
            review_coverage: float | None = round(with_findings / total_review * 100, 1)
        else:
            review_coverage = None

        # 2. mean_time_to_review: mean dispatch duration across review runs
        durations: list[float] = []
        for r in review_recs:
            if r.agents and r.agents.results:
                d = sum(ar.duration_s for ar in r.agents.results)
                if d > 0:
                    durations.append(d)
            elif r.duration_s > 0:
                durations.append(r.duration_s)
        mean_ttr: float | None = round(statistics.mean(durations), 1) if durations else None

        # 3. finding_density: avg findings per review run
        densities: list[float] = []
        for r in review_recs:
            if r.findings:
                n = r.findings.total_raw if r.findings.total_raw > 0 else r.findings.deduplicated
                densities.append(float(n))
        finding_density: float | None = round(statistics.mean(densities), 1) if densities else None

        # 4. fix_rate: % of classified findings marked "fix"
        total_classified = sum(
            sum(r.findings.by_outcome.values())
            for r in recs if r.findings and r.findings.by_outcome
        )
        fix_count = sum(
            r.findings.by_outcome.get("fix", 0)
            for r in recs if r.findings and r.findings.by_outcome
        )
        fix_rate: float | None = round(fix_count / total_classified * 100, 1) if total_classified > 0 else None

        # 5. agent_agreement: % of raw findings that were duplicates (flagged by multiple agents)
        total_raw = sum(r.findings.total_raw for r in recs if r.findings)
        total_dedup = sum(r.findings.deduplicated for r in recs if r.findings and r.findings.deduplicated > 0)
        if total_raw > 0 and total_dedup > 0:
            agent_agreement: float | None = round((total_raw - total_dedup) / total_raw * 100, 1)
        else:
            agent_agreement = None

        # 8. skill_adoption: distinct skills used as % of skills available
        distinct = len({r.skill for r in recs})
        skills_dir = Path.home() / ".claude" / "skills"
        try:
            total_skills = max(len([p for p in skills_dir.iterdir()]), 1)
        except OSError:
            total_skills = 26  # fallback constant
        skill_adoption: float = round(distinct / total_skills * 100, 1)

        return {
            "review_coverage": review_coverage,
            "mean_time_to_review": mean_ttr,
            "finding_density": finding_density,
            "fix_rate": fix_rate,
            "agent_agreement": agent_agreement,
            "skill_adoption": skill_adoption,
        }

    cur = _vals(current)
    prev = _vals(previous) if previous else {}

    def _trend(key: str) -> float | None:
        c, p = cur.get(key), prev.get(key)
        return round(c - p, 1) if c is not None and p is not None else None

    ft = failure_telemetry

    def _kpi(value: float | None, trend_val: float | None, good: float, warn: float,
             lower: bool = False, unit: str = "") -> dict:
        return {
            "value": value,
            "unit": unit,
            "trend": trend_val,
            "status": _kpi_status(value, good, warn, lower),
        }

    return {
        "review_coverage":      _kpi(cur["review_coverage"],      _trend("review_coverage"),      80,  50,  unit="%"),
        "mean_time_to_review":  _kpi(cur["mean_time_to_review"],  _trend("mean_time_to_review"),  300, 600, lower=True, unit="s"),
        "finding_density":      _kpi(cur["finding_density"],      _trend("finding_density"),      3,   1,   unit="findings/review"),
        "fix_rate":             _kpi(cur["fix_rate"],             _trend("fix_rate"),             20,  10,  unit="%"),
        "agent_agreement":      _kpi(cur["agent_agreement"],      _trend("agent_agreement"),      30,  10,  unit="%"),
        "validation_pass_rate": _kpi(ft.get("validation_pass_rate"), None,                       90,  70,  unit="%"),
        "heal_success_rate":    _kpi(ft.get("heal_success_rate"),    None,                       70,  40,  unit="%"),
        "skill_adoption":       _kpi(cur["skill_adoption"],       _trend("skill_adoption"),       50,  25,  unit="%"),
    }


def compute_report(records: list[RunRecord]) -> dict:
    """Compute all report sections from RunRecords."""
    report: dict = {}

    # --- Overview ---
    skill_counts = Counter(r.skill for r in records)
    repos = {r.repo for r in records if r.repo}
    dates = [r.started_at[:10] for r in records if r.started_at]

    report["overview"] = {
        "total_runs": len(records),
        "by_skill": dict(skill_counts),
        "repos_covered": len(repos),
        "repos": sorted(repos),
        "date_range": [min(dates), max(dates)] if dates else [],
    }

    # --- Agent Scorecards ---
    review_records = [r for r in records if r.agents and r.agents.results]
    agent_stats: dict[str, dict] = defaultdict(lambda: {
        "dispatched": 0, "succeeded": 0, "failed": 0, "timed_out": 0,
        "durations": [], "findings": [], "errors": Counter(),
    })

    for r in review_records:
        for ar in r.agents.results:
            stats = agent_stats[ar.agent]
            stats["dispatched"] += 1
            if ar.error:
                stats["failed"] += 1
                stats["errors"][ar.error] += 1
                if ar.error == "timeout":
                    stats["timed_out"] += 1
            else:
                stats["succeeded"] += 1
            if ar.duration_s > 0:
                stats["durations"].append(ar.duration_s)
            stats["findings"].append(ar.findings_count)

    scorecards = {}
    for agent, stats in sorted(agent_stats.items()):
        scorecards[agent] = {
            "dispatched": stats["dispatched"],
            "succeeded": stats["succeeded"],
            "failed": stats["failed"],
            "timed_out": stats["timed_out"],
            "failure_rate": round(stats["failed"] / max(stats["dispatched"], 1) * 100, 1),
            "avg_duration_s": round(statistics.mean(stats["durations"]), 1) if stats["durations"] else 0,
            "avg_findings": round(statistics.mean(stats["findings"]), 1) if stats["findings"] else 0,
            "error_breakdown": dict(stats["errors"]),
        }
    report["agent_scorecards"] = scorecards

    # --- Finding Quality ---
    all_findings = [r for r in records if r.findings]
    total_raw = sum(f.findings.total_raw for f in all_findings)
    total_deduped = sum(f.findings.deduplicated for f in all_findings)

    outcome_totals: Counter = Counter()
    severity_totals: Counter = Counter()
    for r in all_findings:
        for k, v in r.findings.by_outcome.items():
            outcome_totals[k] += v
        for k, v in r.findings.by_severity.items():
            severity_totals[k] += v

    fix_count = outcome_totals.get("fix", 0)
    recurring_count = outcome_totals.get("recurring", 0)
    fp_count = outcome_totals.get("false_positive", 0)
    noise_count = outcome_totals.get("noise", 0)
    ignored_count = outcome_totals.get("ignored", 0)
    # Issues = real problems (fix + recurring). Noise = not real (FP + noise).
    issue_count = fix_count + recurring_count
    noise_total = fp_count + noise_count
    deduped_total = total_deduped if total_deduped > 0 else sum(outcome_totals.values())

    report["finding_quality"] = {
        "total_raw": total_raw,
        "deduplicated": total_deduped,
        "issues": issue_count,
        "noise": noise_total,
        "ignored": ignored_count,
        "by_outcome": dict(outcome_totals),
        "by_severity": dict(severity_totals),
        "signal_to_noise_pct": round(issue_count / max(issue_count + noise_total, 1) * 100, 1),
        "false_positive_rate_pct": round(fp_count / max(issue_count + noise_total, 1) * 100, 1),
    }

    # Worst FP sources (agent×domain combos)
    fp_sources: Counter = Counter()
    for r in review_records:
        for ar in r.agents.results:
            if ar.error:
                fp_sources[f"{ar.agent}-{ar.domain}"] += 0  # just register
            # We can't distinguish FP per agent×domain from the aggregated data
            # but we can flag domains with high error rates
    report["finding_quality"]["worst_error_sources"] = dict(
        Counter(
            f"{ar.agent}-{ar.domain}"
            for r in review_records
            for ar in r.agents.results
            if ar.error
        ).most_common(5)
    )

    # --- Duration Trends ---
    durations_with_data = [r for r in review_records if r.agents and r.agents.results]
    all_durations = []
    dispatch_durations = []

    for r in durations_with_data:
        run_dur = sum(ar.duration_s for ar in r.agents.results)
        if run_dur > 0:
            all_durations.append(run_dur)
            dispatch_durations.append(run_dur)

    duration_stats = {}
    if all_durations:
        duration_stats = {
            "median_s": round(statistics.median(all_durations), 1),
            "p90_s": round(sorted(all_durations)[int(len(all_durations) * 0.9)], 1) if len(all_durations) >= 2 else round(all_durations[0], 1),
            "min_s": round(min(all_durations), 1),
            "max_s": round(max(all_durations), 1),
            "count": len(all_durations),
        }
    report["duration"] = duration_stats

    # --- Prompt Improvement Impact ---
    assessments_generated = sum(
        1 for r in records if r.metrics.get("has_assessment")
    )
    changelog = Path.home() / "git" / "Evinced" / "stark-skills" / "docs" / "prompt-changelog.md"
    improvements_applied = 0
    if changelog.exists():
        improvements_applied = changelog.read_text().count("## 20")  # count dated entries

    report["prompt_improvements"] = {
        "assessments_generated": assessments_generated,
        "improvements_applied": improvements_applied,
        "unapplied": max(0, assessments_generated - improvements_applied),
    }

    # --- Per-Repo Breakdown ---
    repo_stats: dict[str, dict] = defaultdict(lambda: {
        "runs": 0, "total_findings": 0, "total_raw": 0,
    })
    for r in records:
        if r.repo:
            repo_stats[r.repo]["runs"] += 1
            if r.findings:
                repo_stats[r.repo]["total_findings"] += r.findings.deduplicated
                repo_stats[r.repo]["total_raw"] += r.findings.total_raw
    report["per_repo"] = {
        repo: {
            **stats,
            "findings_per_run": round(stats["total_findings"] / max(stats["runs"], 1), 1),
        }
        for repo, stats in sorted(repo_stats.items())
    }

    # --- Recommendations ---
    recommendations = []

    for agent, sc in scorecards.items():
        if sc["failure_rate"] > 20:
            top_error = max(sc["error_breakdown"], key=sc["error_breakdown"].get) if sc["error_breakdown"] else "unknown"
            recommendations.append(
                f"{agent} failure rate is {sc['failure_rate']}% — "
                f"top error: {top_error} ({sc['error_breakdown'].get(top_error, 0)}×)"
            )

    if report["finding_quality"]["signal_to_noise_pct"] < 30:
        recommendations.append(
            f"Signal-to-noise is {report['finding_quality']['signal_to_noise_pct']}% — "
            "prompts may be too aggressive, consider tuning severity thresholds"
        )

    if report["prompt_improvements"]["unapplied"] > 0:
        n = report["prompt_improvements"]["unapplied"]
        recommendations.append(
            f"{n} prompt assessment(s) not yet applied — run /stark-team-review-improvement"
        )

    # Zero-finding domains
    domain_findings: Counter = Counter()
    domain_dispatches: Counter = Counter()
    for r in review_records:
        for ar in r.agents.results:
            domain_dispatches[ar.domain] += 1
            domain_findings[ar.domain] += ar.findings_count
    for domain, dispatches in domain_dispatches.most_common():
        if domain_findings[domain] == 0 and dispatches >= 3:
            recommendations.append(
                f"Domain '{domain}' has 0 findings across {dispatches} dispatches — "
                "candidate for disabled_domains"
            )

    report["recommendations"] = recommendations

    # --- Failure telemetry (healer + validation logs) ---
    report["failure_telemetry"] = load_failure_metrics()

    # --- KPIs ---
    report["kpis"] = compute_kpis(records, report["failure_telemetry"])

    return report


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------

def _format_kpi_value(kpi: dict) -> str:
    v = kpi.get("value")
    unit = kpi.get("unit", "")
    if v is None:
        return "—"
    if unit == "s":
        return _fmt_duration(float(v))
    if unit == "%":
        return f"{v}%"
    if unit == "findings/review":
        return f"{v} /review"
    return str(v)


_KPI_LABELS = {
    "review_coverage":      "Review Coverage",
    "mean_time_to_review":  "Mean Time to Review",
    "finding_density":      "Finding Density",
    "fix_rate":             "Fix Rate",
    "agent_agreement":      "Agent Agreement",
    "validation_pass_rate": "Validation Pass Rate",
    "heal_success_rate":    "Heal Success Rate",
    "skill_adoption":       "Skill Adoption",
}


def _format_kpis(kpis: dict) -> str:
    lines: list[str] = []
    for key, label in _KPI_LABELS.items():
        kpi = kpis.get(key, {})
        val_str = _format_kpi_value(kpi)
        status = kpi.get("status", "unknown")
        trend = kpi.get("trend")
        if trend is not None:
            sign = "+" if trend >= 0 else ""
            trend_str = f"  ({sign}{trend})"
        else:
            trend_str = ""
        lines.append(f"  {label:<25} {val_str:<22} [{status}]{trend_str}")
    return "\n".join(lines)


def format_human(report: dict) -> str:
    """Format report as human-readable terminal output."""
    lines: list[str] = []
    now = datetime.now().strftime("%Y-%m-%d")

    # Overview
    ov = report["overview"]
    lines.append(f"Stark Metrics Report — {now}")
    lines.append("─" * 40)
    skill_parts = ", ".join(f"{c} {s}" for s, c in sorted(ov["by_skill"].items()))
    lines.append(f"Total runs:     {ov['total_runs']} ({skill_parts})")
    if ov["date_range"]:
        lines.append(f"Date range:     {ov['date_range'][0]} → {ov['date_range'][1]}")
    lines.append(f"Repos covered:  {ov['repos_covered']}")
    lines.append("")

    # Agent Scorecards
    sc = report["agent_scorecards"]
    if sc:
        lines.append("Agent Performance")
        lines.append("─" * 40)
        lines.append(f"{'':14s} {'Runs':>5s} {'OK':>5s} {'Fail':>5s} {'T/O':>5s} {'Avg Dur':>8s} {'Find/Run':>9s}")
        for agent, stats in sorted(sc.items()):
            lines.append(
                f"{agent:14s} {stats['dispatched']:5d} {stats['succeeded']:5d} "
                f"{stats['failed']:5d} {stats['timed_out']:5d} "
                f"{_fmt_duration(stats['avg_duration_s']):>8s} "
                f"{stats['avg_findings']:9.1f}"
            )
        # Error breakdown
        has_errors = any(s["error_breakdown"] for s in sc.values())
        if has_errors:
            lines.append("")
            lines.append("Failure breakdown:")
            for agent, stats in sorted(sc.items()):
                for err, count in stats["error_breakdown"].items():
                    lines.append(f"  {agent}: {count}× {err}")
        lines.append("")

    # Finding Quality
    fq = report["finding_quality"]
    if fq["total_raw"] > 0:
        lines.append("Finding Quality")
        lines.append("─" * 40)
        lines.append(f"Total raw:        {fq['total_raw']}")
        lines.append(f"After dedup:      {fq['deduplicated']}")
        lines.append(f"  Issues:         {fq.get('issues', 0)}  (fix + recurring)")
        lines.append(f"  Noise:          {fq.get('noise', 0)}  (false positive + noise)")
        lines.append(f"  Ignored:        {fq.get('ignored', 0)}  (below threshold)")
        lines.append("Breakdown:")
        for outcome in OUTCOME_KEYS:
            count = fq["by_outcome"].get(outcome, 0)
            if count > 0:
                lines.append(f"  {outcome:16s} {count}")
        lines.append(f"Signal-to-noise:  {fq['signal_to_noise_pct']}%")
        lines.append(f"False positive:   {fq['false_positive_rate_pct']}%")
        if fq.get("worst_error_sources"):
            lines.append("Worst error sources:")
            for src, count in fq["worst_error_sources"].items():
                lines.append(f"  {src}: {count}×")
        lines.append("")

    # Duration
    dur = report["duration"]
    if dur:
        lines.append("Duration (dispatch time)")
        lines.append("─" * 40)
        lines.append(f"Median:   {_fmt_duration(dur['median_s'])}")
        lines.append(f"P90:      {_fmt_duration(dur['p90_s'])}")
        lines.append(f"Min:      {_fmt_duration(dur['min_s'])}")
        lines.append(f"Max:      {_fmt_duration(dur['max_s'])}")
        lines.append(f"Runs:     {dur['count']}")
        lines.append("")

    # Prompt Improvements
    pi = report["prompt_improvements"]
    lines.append("Prompt Improvements")
    lines.append("─" * 40)
    lines.append(f"Assessments generated:  {pi['assessments_generated']}")
    lines.append(f"Improvements applied:   {pi['improvements_applied']}")
    lines.append(f"Unapplied:              {pi['unapplied']}")
    lines.append("")

    # Per-Repo
    pr = report["per_repo"]
    if pr:
        lines.append("Per-Repo Breakdown")
        lines.append("─" * 40)
        lines.append(f"{'Repo':40s} {'Runs':>5s} {'Findings':>9s} {'Find/Run':>9s}")
        for repo, stats in sorted(pr.items()):
            lines.append(
                f"{repo:40s} {stats['runs']:5d} "
                f"{stats['total_findings']:9d} "
                f"{stats['findings_per_run']:9.1f}"
            )
        lines.append("")

    # Failure Telemetry
    ft = report.get("failure_telemetry", {})
    if ft.get("heal_attempts_total", 0) > 0 or ft.get("validation_pass_rate") is not None:
        lines.append("Failure Telemetry")
        lines.append("─" * 40)
        if ft.get("validation_pass_rate") is not None:
            lines.append(f"Validation pass rate:  {ft['validation_pass_rate']}%")
        lines.append(f"Heal attempts:         {ft.get('heal_attempts_total', 0)}")
        if ft.get("heal_success_rate") is not None:
            lines.append(f"Heal success rate:     {ft['heal_success_rate']}%")
        if ft.get("top_failure_categories"):
            lines.append("Top failure categories:")
            for cat, count in ft["top_failure_categories"].items():
                lines.append(f"  {cat:<25} {count}")
        lines.append("")

    # KPIs
    kpis = report.get("kpis", {})
    if kpis:
        lines.append("KPI Dashboard")
        lines.append("─" * 40)
        lines.append(_format_kpis(kpis))
        lines.append("")

    # Recommendations
    recs = report["recommendations"]
    lines.append("Recommendations")
    lines.append("─" * 40)
    if recs:
        for i, rec in enumerate(recs, 1):
            lines.append(f"{i}. {rec}")
    else:
        lines.append("No recommendations — everything looks healthy.")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Stark skill metrics aggregator")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--format", choices=["json", "human"], default=None,
        help="Output format: json or human (overrides --json)",
    )
    parser.add_argument("--repo", help="Filter by repo (e.g., GetEvinced/infra-pulse)")
    parser.add_argument("--skill", help="Filter by skill type (e.g., stark-team-review)")
    parser.add_argument("--since", help="Filter by date (YYYY-MM-DD)")
    parser.add_argument("--kpi", action="store_true", help="Output only KPIs")
    args = parser.parse_args()

    # --format json overrides --json flag; --format human suppresses it
    if args.format == "json":
        args.json = True
    elif args.format == "human":
        args.json = False

    if not HISTORY_DIR.exists():
        print("No history directory found at", HISTORY_DIR, file=sys.stderr)
        sys.exit(1)

    records = load_all_records()

    if not records:
        print("No history data found.", file=sys.stderr)
        sys.exit(1)

    # Apply filters
    if args.repo:
        records = [r for r in records if r.repo and args.repo.lower() in r.repo.lower()]
    if args.skill:
        records = [r for r in records if args.skill.lower() in r.skill.lower()]
    if args.since:
        records = [r for r in records if r.started_at[:10] >= args.since]

    if not records:
        print("No records match the given filters.", file=sys.stderr)
        sys.exit(1)

    report = compute_report(records)

    if args.kpi:
        kpis = report.get("kpis", {})
        if args.json:
            print(json.dumps(kpis, indent=2, default=str))
        else:
            print("KPI Dashboard")
            print("─" * 40)
            print(_format_kpis(kpis))
        return

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(format_human(report))


if __name__ == "__main__":
    main()
