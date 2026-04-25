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
        ["triage_orchestrator.py", "--type", "pr", "--pr", "42", "--repo", "acme/repo", "--shadow", "--plain"]
    )

    assert rc == 0
    assert "Dispatching 3/5 domains" in stdout
    assert "[5/5] [RUN] multi:performance" in stdout
    dispatch_argv = mock_run.call_args_list[1].args[0]
    assert dispatch_argv[dispatch_argv.index("--domains") + 1] == ",".join(all_domains)


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
