"""Tests for FU-rt9 collapsible PR comment rendering."""

from __future__ import annotations

from pathlib import Path

import red_team_dispatch_common as common
import stark_red_team as rt


def _finding(persona: str, severity: str, fid: str, *, hr: bool = False, risk_key: str | None = None):
    return rt.RedTeamFinding(
        id=fid,
        persona=persona,
        severity=severity,
        concern=f"{persona} concern: {fid}",
        consequence="something breaks",
        counter_proposal="REQUEST_HUMAN_REVIEW" if hr else "do the other thing",
        trade_off=None if hr else "slower",
        reason_for_uncertainty="depends" if hr else None,
        risk_key=risk_key,
        affected_component=None,
        failure_mode=None,
        concern_hash=f"hash-{persona}-{fid}",
    )


def _result(findings):
    return rt.RedTeamResult(
        stage="design",
        round_num=1,
        synthesis="Top tension: latency vs. cost",
        findings=findings,
        blocking_count=sum(
            1 for f in findings
            if not rt.is_human_review(f) and rt.SEVERITY_RANK[f.severity] >= rt.SEVERITY_RANK["high"]
        ),
        human_review_count=sum(1 for f in findings if rt.is_human_review(f)),
        raw_output="{}",
        duration_s=10.0,
        cost_usd=0.50,
        input_tokens=1000,
        output_tokens=500,
    )


def test_pr_comment_marker_is_keyed_by_stage_and_artifact():
    """PR-#430 review fix #1/#18: marker is keyed by stage + artifact path
    (stable across reruns), NOT by run_id. The find-and-edit flow
    requires the marker to be the same on the second dispatch run."""
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result([]),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
        artifact_relative_path="docs/design.md",
    )
    assert "<!-- stark-red-team: stage=design artifact=docs/design.md -->" in body
    assert body.lstrip().startswith("<!-- stark-red-team: stage=design")


def test_pr_comment_marker_stable_across_reruns():
    """Same artifact + stage → same marker. Different run_id is irrelevant."""
    body_a = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result([]),
        model="gpt-5.5-pro",
        run_id="manual-aaa",
        stage="design",
        artifact_relative_path="docs/design.md",
    )
    body_b = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result([]),
        model="gpt-5.5-pro",
        run_id="manual-bbb",  # different run, same artifact
        stage="design",
        artifact_relative_path="docs/design.md",
    )
    marker_a = body_a.split("\n", 1)[0]
    marker_b = body_b.split("\n", 1)[0]
    assert marker_a == marker_b


def test_pr_comment_groups_findings_into_collapsible_persona_blocks():
    findings = [
        _finding("data", "high", "rt1"),
        _finding("data", "medium", "rt2"),
        _finding("security-trust", "critical", "rt3"),
    ]
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    # One <details> per persona. With 2 personas that's 2 blocks.
    assert body.count("<details>") == 2
    assert body.count("</details>") == 2
    # Persona labels should appear inside the summaries.
    assert "<summary>`data` —" in body
    assert "<summary>`security-trust` —" in body


def test_pr_comment_highlights_block_lists_critical_and_high_only():
    findings = [
        _finding("data", "high", "rt1"),
        _finding("data", "medium", "rt2"),  # excluded from highlights
        _finding("security-trust", "critical", "rt3"),
        _finding("cost-ops", "medium", "rt4"),  # excluded
    ]
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    assert "## Highlights (critical + high)" in body
    # Highlights list contains rt1 and rt3 but not rt2 / rt4.
    highlights_section = body.split("## Highlights")[1].split("## Findings")[0]
    assert "[`rt1`](" in highlights_section
    assert "[`rt3`](" in highlights_section
    assert "[`rt2`](" not in highlights_section
    assert "[`rt4`](" not in highlights_section


def test_pr_comment_skips_highlights_when_no_blocking_findings():
    findings = [_finding("data", "medium", "rt1")]
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    assert "## Highlights" not in body


def test_pr_comment_anchors_are_deterministic_and_match_highlights_links():
    findings = [_finding("data", "high", "rt1")]
    body1 = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    body2 = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    # Same inputs → same anchors. The collapsible version must be byte-stable
    # across runs so an "edit-existing-comment" path doesn't churn.
    assert body1 == body2

    # Anchor in highlights matches the anchor in the persona block.
    import re
    refs = re.findall(r"\(#(rt-[0-9a-f]+)\)", body1)
    targets = re.findall(r'<a id="(rt-[0-9a-f]+)"></a>', body1)
    assert refs == targets


def test_pr_comment_renders_human_review_finding_without_trade_off():
    findings = [_finding("data", "high", "rt1", hr=True)]
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    assert "_Requests human review._" in body
    assert "Trade-off" not in body


def test_pr_comment_renders_structured_metadata_when_present():
    findings = [
        _finding("data", "high", "rt1", risk_key="schema-migration-no-backfill"),
    ]
    body = common.render_pr_comment_body(
        artifact_path=Path("design.md"),
        source_spec_path=None,
        result=_result(findings),
        model="gpt-5.5-pro",
        run_id="manual-abc123",
        stage="design",
    )
    assert "**risk_key:** `schema-migration-no-backfill`" in body
