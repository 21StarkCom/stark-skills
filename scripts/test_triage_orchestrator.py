#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import triage_orchestrator
from domain_triage import DomainVerdict, TriageResult


def _sample_raw_domains() -> dict[str, dict[str, str]]:
    return {
        "architecture": {
            "order": "01",
            "label": "Architecture",
            "filename": "architecture.md",
            "description": "Architecture review",
        },
        "security": {
            "order": "02",
            "label": "Security",
            "filename": "security.md",
            "description": "Security review",
        },
        "testing": {
            "order": "03",
            "label": "Testing",
            "filename": "testing.md",
            "description": "Testing review",
        },
        "accessibility": {
            "order": "04",
            "label": "Accessibility",
            "filename": "accessibility.md",
            "description": "Accessibility review",
        },
        "performance": {
            "order": "05",
            "label": "Performance",
            "filename": "performance.md",
            "description": "Performance review",
        },
    }


def _sample_triage_result() -> TriageResult:
    return TriageResult(
        mode="aggressive",
        agent="claude",
        model="claude-test",
        review_type="pr",
        verdicts=[
            DomainVerdict("architecture", True, 0.98, "Relevant"),
            DomainVerdict("security", True, 0.94, "Relevant"),
            DomainVerdict("testing", True, 0.88, "Relevant"),
            DomainVerdict("accessibility", False, 0.97, "Skip"),
            DomainVerdict("performance", False, 0.91, "Skip"),
        ],
        dispatched_domains=["architecture", "security", "testing"],
        skipped_domains=["accessibility", "performance"],
        duration_s=0.4,
        error=None,
        input_strategy="full",
        content_hash="abc123",
    )


def _dispatch_payload(domains: list[str]) -> dict[str, object]:
    results = []
    findings = []
    for index, domain in enumerate(domains):
        finding = {
            "domain": domain,
            "severity": "high" if index == 0 else "medium",
            "title": f"{domain} finding",
        }
        findings.append(finding)
        results.append(
            {
                "agent": "claude",
                "domain": domain,
                "findings": [finding],
                "findings_count": 1,
                "duration_s": 0.2 + (index * 0.1),
            }
        )
    return {
        "results": results,
        "findings": findings,
        "summary": {
            "succeeded": len(results),
            "failed": 0,
        },
    }


def _completed(stdout: str = "", stderr: str = "", returncode: int = 0) -> SimpleNamespace:
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def _minimal_config() -> dict[str, object]:
    return {
        "triage": {
            "mode": "aggressive",
            "agent": "claude",
            "timeout": 15,
            "conservative_confidence_threshold": 0.8,
            "insights_url": "http://insights.test",
        },
        "disabled_domains": [],
    }


def _run_main(argv: list[str]) -> tuple[int, str, str]:
    captured_stdout = StringIO()
    captured_stderr = StringIO()
    with (
        patch("sys.argv", argv),
        patch("sys.stdout", captured_stdout),
        patch("sys.stderr", captured_stderr),
    ):
        rc = triage_orchestrator.main()
    return rc, captured_stdout.getvalue(), captured_stderr.getvalue()


class _UrlOpenContext:
    def __enter__(self) -> "_UrlOpenContext":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_pr_review_end_to_end(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    dispatched = ["architecture", "security", "testing"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(dispatched))),
    ]

    rc, stdout, _stderr = _run_main(
        ["triage_orchestrator.py", "--type", "pr", "--pr", "42", "--repo", "acme/repo", "--plain"]
    )

    assert rc == 0
    assert "stark-triage · PR Review · acme/repo #42" in stdout
    assert "Dispatching 3/5 domains" in stdout
    assert "[1/3] [RUN] multi:architecture" in stdout
    assert "[1/3] [OK] claude:architecture" in stdout
    assert "3/3 sub-agents succeeded" in stdout

    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert dispatch_argv[1].endswith("multi_review.py")
    assert dispatch_argv[dispatch_argv.index("--domains") + 1] == ",".join(dispatched)


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_plan_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run", return_value=_completed(stdout=json.dumps(_dispatch_payload(["architecture", "security", "testing"]))))
def test_design_review_end_to_end(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        doc_path = Path(tmpdir) / "design.md"
        doc_path.write_text("# Design\n\ncontent\n", encoding="utf-8")

        rc, stdout, _stderr = _run_main(
            ["triage_orchestrator.py", "--type", "design", "--file", str(doc_path), "--plain"]
        )

    assert rc == 0
    assert "stark-triage · Design Review" in stdout
    dispatch_argv = mock_run.call_args.args[0]
    assert dispatch_argv[1].endswith("plan_review_dispatch.py")
    assert dispatch_argv[dispatch_argv.index("--prompts-dir") + 1] == "design-review"


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_plan_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run", return_value=_completed(stdout=json.dumps(_dispatch_payload(["architecture", "security", "testing"]))))
def test_plan_review_end_to_end(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        doc_path = Path(tmpdir) / "plan.md"
        doc_path.write_text("# Plan\n\ncontent\n", encoding="utf-8")

        rc, stdout, _stderr = _run_main(
            ["triage_orchestrator.py", "--type", "plan", "--file", str(doc_path), "--plain"]
        )

    assert rc == 0
    assert "stark-triage · Plan Review" in stdout
    dispatch_argv = mock_run.call_args.args[0]
    assert dispatch_argv[dispatch_argv.index("--prompts-dir") + 1] == "plan-review"


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_shadow_mode_dispatches_all(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    all_domains = ["architecture", "security", "testing", "accessibility", "performance"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(all_domains))),
    ]

    rc, stdout, _stderr = _run_main(
        ["triage_orchestrator.py", "--type", "pr", "--pr", "42", "--repo", "acme/repo", "--shadow", "--json", "--plain"]
    )

    assert rc == 0
    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert dispatch_argv[dispatch_argv.index("--domains") + 1] == ",".join(all_domains)

    # Shadow mode dispatches all domains while preserving the original triage
    # verdicts/skipped_domains so analytics still know which domains *would*
    # have been skipped — without this, shadow telemetry loses signal.
    payload = json.loads(stdout)
    assert payload["triage"]["dispatched_domains"] == all_domains
    skipped_in_verdicts = [
        v["domain"] for v in payload["triage"]["verdicts"] if not v["relevant"]
    ]
    assert sorted(skipped_in_verdicts) == sorted(["accessibility", "performance"])


@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run", return_value=_completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"))
def test_dry_run_triage_only(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
) -> None:
    rc, stdout, _stderr = _run_main(
        ["triage_orchestrator.py", "--type", "pr", "--pr", "42", "--repo", "acme/repo", "--dry-run", "--plain"]
    )

    assert rc == 0
    assert "Dispatching 3/5 domains" in stdout
    assert "[RUN]" not in stdout
    assert mock_run.call_count == 1


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_json_output_schema(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    dispatched = ["architecture", "security", "testing"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(dispatched))),
    ]

    rc, stdout, stderr = _run_main(
        ["triage_orchestrator.py", "--type", "pr", "--pr", "42", "--repo", "acme/repo", "--json", "--plain"]
    )

    assert rc == 0
    payload = json.loads(stdout)
    assert set(payload.keys()) == {"triage", "dispatch", "findings", "summary"}
    assert payload["triage"]["dispatched_domains"] == dispatched
    assert payload["dispatch"]["succeeded"] == 3
    assert "stark-triage · PR Review" in stderr


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_domains_arg_passthrough(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    dispatched = ["architecture", "security", "testing"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(dispatched))),
    ]

    rc, _stdout, _stderr = _run_main(
        [
            "triage_orchestrator.py",
            "--type",
            "pr",
            "--pr",
            "42",
            "--repo",
            "acme/repo",
            "--agents",
            "codex,claude",
            "--plain",
        ]
    )

    assert rc == 0
    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert dispatch_argv[dispatch_argv.index("--domains") + 1] == ",".join(dispatched)


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_agent_arg_plumbed_to_pr_dispatch(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    """`--agent` should keep triage-selected domains and force one PR reviewer."""
    dispatched = ["architecture", "security", "testing"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(dispatched))),
    ]

    rc, _stdout, _stderr = _run_main(
        [
            "triage_orchestrator.py",
            "--type",
            "pr",
            "--pr",
            "42",
            "--repo",
            "acme/repo",
            "--agent",
            "codex",
            "--plain",
        ]
    )

    assert rc == 0
    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert "--single" in dispatch_argv
    assert dispatch_argv[dispatch_argv.index("--agent") + 1] == "codex"
    assert dispatch_argv[dispatch_argv.index("--domains") + 1] == ",".join(dispatched)


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_plan_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run", return_value=_completed(stdout=json.dumps(_dispatch_payload(["architecture", "security", "testing"]))))
def test_agent_arg_plumbed_to_design_dispatch(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    """`--agent` should force one design/plan reviewer through --agents."""
    with tempfile.TemporaryDirectory() as tmpdir:
        doc_path = Path(tmpdir) / "design.md"
        doc_path.write_text("# Design\n\ncontent\n", encoding="utf-8")

        rc, _stdout, _stderr = _run_main(
            [
                "triage_orchestrator.py",
                "--type",
                "design",
                "--file",
                str(doc_path),
                "--agent",
                "codex",
                "--plain",
            ]
        )

    assert rc == 0
    dispatch_argv = mock_run.call_args.args[0]
    assert "--agents" in dispatch_argv
    assert dispatch_argv[dispatch_argv.index("--agents") + 1] == "codex"
    assert "--agent" not in dispatch_argv
    assert "--single" not in dispatch_argv


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value=_sample_raw_domains())
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
def test_round_arg_plumbed_to_dispatch(
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    """`--round N` on the orchestrator must reach multi_review.py as `--round N`."""
    dispatched = ["architecture", "security", "testing"]
    mock_run.side_effect = [
        _completed(stdout="diff --git a/app.py b/app.py\n+print('hi')\n"),
        _completed(stdout=json.dumps(_dispatch_payload(dispatched))),
    ]

    rc, _stdout, _stderr = _run_main(
        [
            "triage_orchestrator.py", "--type", "pr",
            "--pr", "42", "--repo", "acme/repo",
            "--round", "3", "--plain",
        ]
    )

    assert rc == 0
    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert "--round" in dispatch_argv
    assert dispatch_argv[dispatch_argv.index("--round") + 1] == "3"


def test_extract_dispatch_models_prefers_top_level_map() -> None:
    """Top-level ``models`` map (emitted by current dispatchers) wins."""
    payload = {
        "models": {"claude": "claude-opus-4-7", "codex": "gpt-5.5"},
        "results": [{"agent": "claude", "model": "stale", "domain": "x"}],
    }
    result = triage_orchestrator._extract_dispatch_models(
        payload, payload["results"]
    )
    assert result == {"claude": "claude-opus-4-7", "codex": "gpt-5.5"}


def test_extract_dispatch_models_falls_back_to_per_result() -> None:
    """If a child dispatcher only sets per-result ``model`` fields,
    ``_extract_dispatch_models`` must still recover the {agent: model} map.
    """
    results = [
        {"agent": "claude", "model": "claude-opus-4-7", "domain": "security"},
        {"agent": "codex", "model": "gpt-5.5", "domain": "architecture"},
    ]
    payload = {"results": results}
    assert triage_orchestrator._extract_dispatch_models(payload, results) == {
        "claude": "claude-opus-4-7",
        "codex": "gpt-5.5",
    }


def test_extract_dispatch_models_handles_empty() -> None:
    """No model info anywhere → empty dict (no crash)."""
    payload = {"results": [{"agent": "claude", "domain": "x"}]}
    assert triage_orchestrator._extract_dispatch_models(payload, payload["results"]) == {}


def test_shape_triage_decision_payload_surfaces_dispatch_models() -> None:
    """``dispatch.models`` from raw payload must reach the triage_decision envelope."""
    raw = {
        "review_type": "pr",
        "repo": "acme/repo",
        "pr": 42,
        "triage": {
            "mode": "aggressive",
            "agent": "claude",
            "model": "claude-test",
            "content_hash": "abc",
            "input_strategy": "full",
            "dispatched_domains": ["security"],
            "skipped_domains": [],
            "verdicts": [],
            "duration_s": 0.4,
            "error": None,
        },
        "dispatch": {
            "models": {"claude": "claude-opus-4-7"},
            "results": [],
            "succeeded": 0,
            "failed": 0,
        },
    }
    shaped = triage_orchestrator._shape_triage_decision_payload(raw)
    assert shaped["dispatch_models"] == {"claude": "claude-opus-4-7"}


@patch("triage_orchestrator.urllib.request.urlopen", return_value=_UrlOpenContext())
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_review_domains")
@patch("triage_orchestrator.triage_domains", return_value=_sample_triage_result())
@patch("triage_orchestrator.subprocess.run")
@patch("triage_orchestrator.Path.read_text", return_value="# spec body")
def test_design_dispatch_forwards_repo_to_plan_review(
    _mock_read: MagicMock,
    mock_run: MagicMock,
    _mock_triage: MagicMock,
    mock_discover: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
    tmp_path,
) -> None:
    """Design/plan dispatch must forward the detected/forced --repo to
    plan_review_dispatch.py so emitted agent_dispatch / review_finding
    events get attributed to the actual repository, not the 'unknown'
    fallback.
    """
    from domain_triage import DomainMeta
    spec = tmp_path / "spec.md"
    spec.write_text("# Spec")
    mock_discover.return_value = {
        "architecture": DomainMeta(order="01", label="Architecture",
                                    filename="architecture.md", description=""),
        "security": DomainMeta(order="02", label="Security",
                                filename="security.md", description=""),
        "testing": DomainMeta(order="03", label="Testing",
                               filename="testing.md", description=""),
    }
    mock_run.return_value = _completed(
        stdout=json.dumps(_dispatch_payload(["architecture", "security", "testing"]))
    )

    rc, _stdout, _stderr = _run_main([
        "triage_orchestrator.py", "--type", "design",
        "--file", str(spec),
        "--repo", "acme/spec-repo", "--plain",
    ])

    assert rc == 0
    dispatch_argv = mock_run.call_args_list[0].args[0]
    assert "--repo" in dispatch_argv, (
        "plan_review_dispatch must receive --repo so its telemetry is "
        "attributed to the source repository"
    )
    assert dispatch_argv[dispatch_argv.index("--repo") + 1] == "acme/spec-repo"


def test_build_final_payload_includes_dispatch_models() -> None:
    """``_build_final_payload`` must echo dispatch_models into the JSON returned."""
    triage_result = _sample_triage_result()
    payload = triage_orchestrator._build_final_payload(
        triage_result,
        dispatch_results=[],
        findings=[],
        succeeded=0,
        failed=0,
        total_duration_s=0.5,
        dispatch_models={"claude": "claude-opus-4-7", "codex": "gpt-5.5"},
    )
    assert payload["dispatch"]["models"] == {
        "claude": "claude-opus-4-7",
        "codex": "gpt-5.5",
    }
