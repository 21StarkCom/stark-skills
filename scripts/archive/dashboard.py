#!/usr/bin/env python3
"""Generate a standalone HTML dashboard from stark metrics.

Usage:
    python3 scripts/dashboard.py [--output PATH] [--json]

Default output: ~/.claude/code-review/dashboard/index.html
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Allow importing metrics from the parent scripts/ directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import metrics as _metrics

DASHBOARD_DIR = Path.home() / ".claude" / "code-review" / "dashboard"
DEFAULT_OUTPUT = DASHBOARD_DIR / "index.html"

# ---------------------------------------------------------------------------
# Status colours
# ---------------------------------------------------------------------------

STATUS_COLOR = {
    "good":     "#16a34a",  # green-700
    "warning":  "#b45309",  # amber-700
    "critical": "#dc2626",  # red-600
    "unknown":  "#6b7280",  # gray-500
}

STATUS_BG = {
    "good":     "#dcfce7",  # green-100
    "warning":  "#fef9c3",  # yellow-100
    "critical": "#fee2e2",  # red-100
    "unknown":  "#f3f4f6",  # gray-100
}

STATUS_BORDER = {
    "good":     "#22c55e",
    "warning":  "#f59e0b",
    "critical": "#ef4444",
    "unknown":  "#9ca3af",
}

KPI_LABELS = {
    "review_coverage":      "Review Coverage",
    "mean_time_to_review":  "Mean Time to Review",
    "finding_density":      "Finding Density",
    "fix_rate":             "Fix Rate",
    "agent_agreement":      "Agent Agreement",
    "validation_pass_rate": "Validation Pass Rate",
    "heal_success_rate":    "Heal Success Rate",
    "skill_adoption":       "Skill Adoption",
}

KPI_DESCRIPTIONS = {
    "review_coverage":      "% of review runs with findings",
    "mean_time_to_review":  "Mean dispatch duration per review",
    "finding_density":      "Avg findings per review run",
    "fix_rate":             "% of findings marked as fixes",
    "agent_agreement":      "% of findings flagged by multiple agents",
    "validation_pass_rate": "% of validation checks that passed",
    "heal_success_rate":    "% of self-heal attempts that succeeded",
    "skill_adoption":       "% of available skills used",
}


# ---------------------------------------------------------------------------
# Value formatting
# ---------------------------------------------------------------------------

def _fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds / 60:.0f}m {seconds % 60:.0f}s"
    return f"{seconds / 3600:.0f}h {(seconds % 3600) / 60:.0f}m"


def _fmt_kpi_value(kpi: dict) -> str:
    v = kpi.get("value")
    unit = kpi.get("unit", "")
    if v is None:
        return "—"
    if unit == "s":
        return _fmt_duration(float(v))
    if unit == "%":
        return f"{v}%"
    if unit == "findings/review":
        return f"{v} /rev"
    return str(v)


def _fmt_trend(kpi: dict) -> str:
    trend = kpi.get("trend")
    if trend is None:
        return ""
    arrow = "▲" if trend >= 0 else "▼"
    sign = "+" if trend >= 0 else ""
    unit = kpi.get("unit", "")
    if unit == "s" and trend != 0:
        return f"{arrow} {_fmt_duration(abs(trend))}"
    return f"{arrow} {sign}{trend}{unit if unit == '%' else ''}"


# ---------------------------------------------------------------------------
# Dashboard data assembly
# ---------------------------------------------------------------------------

def build_dashboard_data(report: dict) -> dict:
    """Extract dashboard-ready data from a full metrics report."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    kpis = report.get("kpis", {})
    ft = report.get("failure_telemetry", {})
    scorecards = report.get("agent_scorecards", {})
    overview = report.get("overview", {})
    fq = report.get("finding_quality", {})

    # Recent activity: filter records within last 7 days
    recent_activity: list[dict] = []
    cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    try:
        all_records = _metrics.load_all_records()
        for r in all_records:
            if r.started_at[:10] >= cutoff:
                recent_activity.append({
                    "date": r.started_at[:10],
                    "skill": r.skill,
                    "repo": r.repo or "—",
                    "outcome": r.outcome,
                    "findings": r.findings.total_raw if r.findings else 0,
                })
        recent_activity.sort(key=lambda x: x["date"], reverse=True)
        recent_activity = recent_activity[:20]
    except Exception:
        pass

    # Failure categories
    failure_cats = ft.get("top_failure_categories", {})

    # Agent comparison rows
    agent_rows = []
    for agent, sc in sorted(scorecards.items()):
        agent_rows.append({
            "agent": agent,
            "dispatched": sc.get("dispatched", 0),
            "failure_rate": sc.get("failure_rate", 0),
            "avg_duration": _fmt_duration(sc.get("avg_duration_s", 0)),
            "avg_findings": sc.get("avg_findings", 0),
        })

    return {
        "generated_at": now_str,
        "overview": {
            "total_runs": overview.get("total_runs", 0),
            "repos_covered": overview.get("repos_covered", 0),
            "date_range": overview.get("date_range", []),
            "signal_to_noise": fq.get("signal_to_noise_pct", 0),
        },
        "kpis": kpis,
        "failure_categories": failure_cats,
        "agent_rows": agent_rows,
        "recent_activity": recent_activity,
    }


def build_empty_dashboard_data() -> dict:
    """Return a no-data placeholder dashboard."""
    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "overview": {"total_runs": 0, "repos_covered": 0, "date_range": [], "signal_to_noise": 0},
        "kpis": {},
        "failure_categories": {},
        "agent_rows": [],
        "recent_activity": [],
    }


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------

def _kpi_card(key: str, kpi: dict) -> str:
    label = KPI_LABELS.get(key, key)
    desc = KPI_DESCRIPTIONS.get(key, "")
    status = kpi.get("status", "unknown")
    val = _fmt_kpi_value(kpi)
    trend = _fmt_trend(kpi)
    color = STATUS_COLOR[status]
    bg = STATUS_BG[status]
    border = STATUS_BORDER[status]

    trend_html = f'<span class="trend">{trend}</span>' if trend else ""

    return f"""
      <div class="kpi-card" style="background:{bg};border-left:4px solid {border};">
        <div class="kpi-label">{label}</div>
        <div class="kpi-value" style="color:{color};">{val}</div>
        <div class="kpi-meta">
          <span class="kpi-status" style="color:{color};">{status}</span>
          {trend_html}
        </div>
        <div class="kpi-desc">{desc}</div>
      </div>"""


def _kpi_no_data_card(key: str) -> str:
    label = KPI_LABELS.get(key, key)
    desc = KPI_DESCRIPTIONS.get(key, "")
    return f"""
      <div class="kpi-card" style="background:#f3f4f6;border-left:4px solid #9ca3af;">
        <div class="kpi-label">{label}</div>
        <div class="kpi-value" style="color:#6b7280;">—</div>
        <div class="kpi-meta"><span class="kpi-status" style="color:#6b7280;">no data</span></div>
        <div class="kpi-desc">{desc}</div>
      </div>"""


def _failure_category_table(cats: dict) -> str:
    if not cats:
        return '<p class="no-data">No failure category data yet.</p>'
    rows = "".join(
        f"<tr><td>{cat}</td><td>{count}</td></tr>"
        for cat, count in sorted(cats.items(), key=lambda x: -x[1])
    )
    return f"""
      <table>
        <thead><tr><th>Category</th><th>Count</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>"""


def _agent_table(agent_rows: list[dict]) -> str:
    if not agent_rows:
        return '<p class="no-data">No agent data yet.</p>'
    rows = "".join(
        f"<tr><td>{r['agent']}</td><td>{r['dispatched']}</td>"
        f"<td>{r['failure_rate']}%</td><td>{r['avg_duration']}</td>"
        f"<td>{r['avg_findings']}</td></tr>"
        for r in agent_rows
    )
    return f"""
      <table>
        <thead><tr>
          <th>Agent</th><th>Dispatched</th><th>Fail %</th>
          <th>Avg Duration</th><th>Avg Findings</th>
        </tr></thead>
        <tbody>{rows}</tbody>
      </table>"""


def _activity_table(recent: list[dict]) -> str:
    if not recent:
        return '<p class="no-data">No activity in the last 7 days.</p>'
    rows = "".join(
        f"<tr><td>{r['date']}</td><td>{r['skill']}</td><td>{r['repo']}</td>"
        f"<td>{r['outcome']}</td><td>{r['findings']}</td></tr>"
        for r in recent
    )
    return f"""
      <table>
        <thead><tr>
          <th>Date</th><th>Skill</th><th>Repo</th><th>Outcome</th><th>Findings</th>
        </tr></thead>
        <tbody>{rows}</tbody>
      </table>"""


def generate_html(data: dict) -> str:
    ov = data["overview"]
    kpis = data["kpis"]
    generated_at = data["generated_at"]

    # Build KPI grid — all 8 in order
    kpi_cards = ""
    for key in KPI_LABELS:
        kpi = kpis.get(key)
        if kpi:
            kpi_cards += _kpi_card(key, kpi)
        else:
            kpi_cards += _kpi_no_data_card(key)

    date_range = ""
    dr = ov.get("date_range", [])
    if len(dr) == 2:
        date_range = f" &nbsp;·&nbsp; {dr[0]} → {dr[1]}"

    has_overview = ov.get("total_runs", 0) > 0
    overview_html = f"""
      <div class="stat-bar">
        <div class="stat"><span class="stat-n">{ov['total_runs']}</span><span class="stat-l">Total Runs</span></div>
        <div class="stat"><span class="stat-n">{ov['repos_covered']}</span><span class="stat-l">Repos Covered</span></div>
        <div class="stat"><span class="stat-n">{ov['signal_to_noise']}%</span><span class="stat-l">Signal-to-Noise</span></div>
      </div>""" if has_overview else '<p class="no-data">No run data available yet. Run a stark skill to populate the dashboard.</p>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stark Metrics Dashboard</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc; color: #1e293b; line-height: 1.5;
    }}
    header {{
      background: #0f172a; color: #f8fafc; padding: 20px 32px;
      display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    }}
    header h1 {{ font-size: 1.4rem; font-weight: 700; }}
    header .meta {{ font-size: 0.8rem; color: #94a3b8; }}
    main {{ max-width: 1200px; margin: 0 auto; padding: 24px 24px 48px; }}
    h2 {{ font-size: 1rem; font-weight: 700; color: #475569; text-transform: uppercase;
          letter-spacing: 0.05em; margin: 32px 0 12px; }}
    /* Stat bar */
    .stat-bar {{ display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }}
    .stat {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
             padding: 12px 20px; min-width: 140px; }}
    .stat-n {{ display: block; font-size: 1.6rem; font-weight: 700; color: #0f172a; }}
    .stat-l {{ font-size: 0.75rem; color: #64748b; }}
    /* KPI grid */
    .kpi-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }}
    .kpi-card {{ border-radius: 8px; padding: 16px; }}
    .kpi-label {{ font-size: 0.8rem; font-weight: 600; color: #475569; margin-bottom: 6px; }}
    .kpi-value {{ font-size: 1.8rem; font-weight: 800; line-height: 1.2; margin-bottom: 4px; }}
    .kpi-meta {{ font-size: 0.75rem; margin-bottom: 4px; }}
    .kpi-status {{ font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }}
    .trend {{ margin-left: 8px; color: #475569; }}
    .kpi-desc {{ font-size: 0.7rem; color: #64748b; }}
    /* Tables */
    table {{ width: 100%; border-collapse: collapse; background: #fff;
             border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }}
    thead {{ background: #f1f5f9; }}
    th {{ text-align: left; padding: 10px 14px; font-size: 0.75rem; font-weight: 600;
          color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }}
    td {{ padding: 9px 14px; font-size: 0.85rem; border-top: 1px solid #f1f5f9; }}
    tr:hover td {{ background: #f8fafc; }}
    /* Misc */
    .no-data {{ color: #94a3b8; font-style: italic; padding: 16px 0; }}
    footer {{ text-align: center; padding: 24px; font-size: 0.75rem; color: #94a3b8; }}
  </style>
</head>
<body>
  <header>
    <h1>Stark Metrics Dashboard</h1>
    <span class="meta">Generated {generated_at}{date_range}</span>
  </header>
  <main>
    <h2>Overview</h2>
    {overview_html}

    <h2>KPI Overview</h2>
    <div class="kpi-grid">
      {kpi_cards}
    </div>

    <h2>Failure Categories</h2>
    {_failure_category_table(data['failure_categories'])}

    <h2>Agent Performance</h2>
    {_agent_table(data['agent_rows'])}

    <h2>Recent Activity (Last 7 Days)</h2>
    {_activity_table(data['recent_activity'])}
  </main>
  <footer>stark-skills &nbsp;·&nbsp; auto-generated — do not edit manually</footer>
</body>
</html>"""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Stark metrics dashboard")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT),
                        help="Output path (default: ~/.claude/code-review/dashboard/index.html)")
    parser.add_argument("--json", action="store_true", help="Output dashboard data as JSON")
    args = parser.parse_args()

    # Try to load metrics; fall back gracefully if no history
    try:
        if not _metrics.HISTORY_DIR.exists():
            raise FileNotFoundError("No history directory")
        all_records = _metrics.load_all_records()
        if not all_records:
            raise ValueError("No records found")
        report = _metrics.compute_report(all_records)
        data = build_dashboard_data(report)
    except Exception:
        data = build_empty_dashboard_data()

    if args.json:
        print(json.dumps(data, indent=2, default=str))
        return

    html = generate_html(data)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    print(f"Dashboard written to {out_path}")


if __name__ == "__main__":
    main()
