#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from domain_triage import DomainMeta, TriageResult, triage_domains
from multi_review import AGENTS, _discover_domains, discover_config
from plan_review_dispatch import _discover_plan_domains
from triage_tui import (
    TUIConfig,
    make_config,
    render_banner,
    render_dispatch_progress,
    render_insights,
    render_summary,
    render_triage,
    render_zero_domains,
)


SCRIPTS_DIR = Path(__file__).parent
MULTI_REVIEW = SCRIPTS_DIR / "multi_review.py"
PLAN_REVIEW_DISPATCH = SCRIPTS_DIR / "plan_review_dispatch.py"


def _log(message: str) -> None:
    print(f"triage_orchestrator: {message}", file=sys.stderr)


def _split_csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _make_tui_config(no_color: bool, plain: bool, json_output: bool) -> TUIConfig:
    config = make_config(no_color=no_color, plain=plain, json_mode=False)
    if not json_output:
        return config
    no_color_env = bool(os.environ.get("NO_COLOR"))
    stderr_tty = hasattr(sys.stderr, "isatty") and sys.stderr.isatty()
    return TUIConfig(
        color=bool(stderr_tty and not no_color and not no_color_env and not plain),
        plain=plain,
        json_mode=False,
    )


def _emit_tui(text: str, *, json_output: bool) -> None:
    if not text:
        return
    print(text, file=sys.stderr if json_output else sys.stdout)


def _deep_merge_dicts(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(merged.get(key), dict) and isinstance(value, dict):
            merged[key] = _deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def _detect_repo() -> str:
    result = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
    )
    url = result.stdout.strip()
    if not url:
        raise RuntimeError("Could not detect git remote origin. Use --repo.")
    if url.startswith("git@"):
        path = url.split(":", 1)[1].removesuffix(".git")
        return path
    parts = url.removesuffix(".git").rsplit("/", 2)
    if len(parts) < 2:
        raise RuntimeError("Could not parse git remote origin. Use --repo.")
    return f"{parts[-2]}/{parts[-1]}"


def _load_triage_config(config: dict[str, Any], review_type: str) -> dict[str, Any]:
    base_triage = config.get("triage", {})
    if review_type == "design":
        type_triage = config.get("design_review", {}).get("triage", {})
    elif review_type == "plan":
        type_triage = config.get("plan_review", {}).get("triage", {})
    else:
        type_triage = {}
    return _deep_merge_dicts(base_triage, type_triage)


def _read_input_content(args: argparse.Namespace, repo: str | None) -> tuple[str, str]:
    if args.review_type == "pr":
        if args.pr is None:
            raise ValueError("--pr is required for --type pr")
        if not repo:
            raise ValueError("--repo is required for --type pr")
        result = subprocess.run(
            ["gh", "pr", "diff", str(args.pr), "--repo", repo],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            raise RuntimeError(f"Failed to fetch PR diff: {stderr or 'gh returned non-zero exit'}")
        return result.stdout, f"{repo}#{args.pr}"

    if not args.file:
        raise ValueError("--file is required for design/plan review")
    path = Path(args.file)
    return path.read_text(encoding="utf-8"), str(path)


def _discover_review_domains(review_type: str) -> dict[str, DomainMeta]:
    if review_type == "pr":
        raw_domains = _discover_domains()
    else:
        prompts_dir = "design-review" if review_type == "design" else "plan-review"
        global_prompts_dir = str(Path.home() / ".claude" / "code-review" / "prompts" / prompts_dir)
        raw_domains = _discover_plan_domains(global_prompts_dir=global_prompts_dir)

    return {
        domain: DomainMeta(
            order=str(meta.get("order", "99")),
            label=str(meta.get("label", domain.replace("-", " ").title())),
            filename=str(meta.get("filename", f"{domain}.md")),
            description=str(meta.get("description", "")),
        )
        for domain, meta in raw_domains.items()
    }


def _ordered_domain_keys(domains: dict[str, DomainMeta]) -> list[str]:
    return [
        domain
        for domain, _ in sorted(domains.items(), key=lambda item: (item[1].get("order", "99"), item[0]))
    ]


def _serialize_triage(triage_result: TriageResult) -> dict[str, Any]:
    return {
        "mode": triage_result.mode,
        "agent": triage_result.agent,
        "model": triage_result.model,
        "review_type": triage_result.review_type,
        "content_hash": f"sha256:{triage_result.content_hash}",
        "input_strategy": triage_result.input_strategy,
        "dispatched_domains": list(triage_result.dispatched_domains),
        "skipped_domains": list(triage_result.skipped_domains),
        "verdicts": [
            {
                "domain": verdict.domain,
                "relevant": verdict.relevant,
                "confidence": verdict.confidence,
                "reason": verdict.reason,
            }
            for verdict in triage_result.verdicts
        ],
        "duration_s": triage_result.duration_s,
        "error": triage_result.error,
    }


def _build_dispatch_argv(args: argparse.Namespace, repo: str | None, domains: list[str]) -> list[str]:
    domain_csv = ",".join(domains)
    if args.review_type == "pr":
        if args.pr is None or not repo:
            raise ValueError("PR dispatch requires --pr and --repo")
        argv = [
            sys.executable,
            str(MULTI_REVIEW),
            "--pr",
            str(args.pr),
            "--repo",
            repo,
            "--domains",
            domain_csv,
            "--json-only",
        ]
        if args.single:
            argv.append("--single")
        if args.base:
            argv.extend(["--base", args.base])
        if args.round is not None:
            _log("warning: ignoring --round for PR dispatch; multi_review.py does not support it")
        if args.agents:
            _log("warning: ignoring --agents for PR dispatch; multi_review.py does not support it")
        if args.timeout is not None:
            _log("warning: ignoring --timeout for PR dispatch; multi_review.py does not support it")
        return argv

    if not args.file:
        raise ValueError("Design/plan dispatch requires --file")
    prompts_dir = "design-review" if args.review_type == "design" else "plan-review"
    argv = [
        sys.executable,
        str(PLAN_REVIEW_DISPATCH),
        "--file",
        args.file,
        "--prompts-dir",
        prompts_dir,
        "--domains",
        domain_csv,
        "--json-only",
    ]
    if args.round is not None:
        argv.extend(["--round", str(args.round)])
    if args.agents:
        argv.extend(["--agents", args.agents])
    if args.timeout is not None:
        argv.extend(["--timeout", str(args.timeout)])
    return argv


def _run_dispatch(argv: list[str]) -> dict[str, Any]:
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.stderr.strip():
        print(result.stderr, file=sys.stderr, end="" if result.stderr.endswith("\n") else "\n")
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip() or "dispatch failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse dispatch JSON: {exc}") from exc


def _normalize_dispatch_payload(dispatch_data: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, int]:
    if "rounds" in dispatch_data:
        rounds = dispatch_data.get("rounds", [])
        results: list[dict[str, Any]] = []
        findings: list[dict[str, Any]] = []
        for round_entry in rounds:
            if not isinstance(round_entry, dict):
                continue
            for result in round_entry.get("results", []):
                if isinstance(result, dict):
                    results.append(result)
                    findings.extend(result.get("findings", []))
        succeeded = sum(1 for result in results if not result.get("error"))
        failed = len(results) - succeeded
        return results, findings, succeeded, failed

    results = [result for result in dispatch_data.get("results", []) if isinstance(result, dict)]
    findings = [finding for finding in dispatch_data.get("findings", []) if isinstance(finding, dict)]
    summary = dispatch_data.get("summary", {})
    succeeded = int(summary.get("succeeded", sum(1 for result in results if not result.get("error"))))
    failed = int(summary.get("failed", len(results) - succeeded))
    return results, findings, succeeded, failed


def _count_by_severity(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for finding in findings:
        severity = str(finding.get("severity", "unknown"))
        counts[severity] = counts.get(severity, 0) + 1
    return counts


def _emit_insights(
    insights_url: str,
    payload: dict[str, Any],
) -> tuple[bool, str | None]:
    url = f"{insights_url.rstrip('/')}/events"
    body = json.dumps({"event_type": "triage_decision", "payload": payload}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5):
            return True, None
    except (TimeoutError, urllib.error.URLError, OSError) as exc:
        warning = str(exc)
        _log(f"warning: failed to emit insights event: {warning}")
        return False, warning


def _build_final_payload(
    triage_result: TriageResult,
    dispatch_results: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    succeeded: int,
    failed: int,
    total_duration_s: float,
) -> dict[str, Any]:
    return {
        "triage": _serialize_triage(triage_result),
        "dispatch": {
            "results": dispatch_results,
            "succeeded": succeeded,
            "failed": failed,
        },
        "findings": findings,
        "summary": {
            "total_findings": len(findings),
            "by_severity": _count_by_severity(findings),
            "total_duration_s": round(total_duration_s, 3),
        },
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Triage orchestrator — intelligent domain dispatch")
    parser.add_argument("--type", required=True, choices=["pr", "design", "plan"], dest="review_type")
    parser.add_argument("--pr", type=int, help="PR number (for pr type)")
    parser.add_argument("--repo", help="GitHub repo (owner/repo). Auto-detect from git remote")
    parser.add_argument("--file", help="Document path (for design/plan type)")
    parser.add_argument("--base", default="main", help="Base branch for PR diff")
    parser.add_argument("--triage", choices=["aggressive", "conservative", "full"], help="Triage mode override")
    parser.add_argument("--triage-agent", choices=["claude", "codex"], help="Agent for triage override")
    parser.add_argument("--agents", help="Review agents (comma-separated)")
    parser.add_argument("--disabled-domains", help="Static domain exclusions (comma-separated)")
    parser.add_argument("--timeout", type=int, help="Per sub-agent timeout (seconds)")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--plain", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--single", action="store_true", help="Single-agent mode")
    parser.add_argument("--shadow", action="store_true", help="Triage + dispatch ALL domains")
    parser.add_argument("--round", type=int, help="Review round number (passthrough)")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    started_at = time.monotonic()
    tui_config = _make_tui_config(args.no_color, args.plain, args.json_output)

    try:
        config = discover_config()
        triage_config = _load_triage_config(config, args.review_type)

        repo = args.repo
        if repo is None:
            try:
                repo = _detect_repo()
            except Exception:
                if args.review_type == "pr":
                    raise
                repo = None

        mode = args.triage or triage_config.get("mode", "conservative")
        triage_agent = args.triage_agent or triage_config.get("agent", "claude")
        timeout = args.timeout or triage_config.get("timeout", 15)
        confidence_threshold = triage_config.get("conservative_confidence_threshold", 0.8)
        insights_url = triage_config.get("insights_url", "http://localhost:7420")
        disabled_domains = _split_csv(args.disabled_domains) or list(config.get("disabled_domains", []))

        _log("resolving review input")
        content, banner_target = _read_input_content(args, repo)

        _log("discovering candidate domains")
        candidate_domains = _discover_review_domains(args.review_type)
        if not candidate_domains:
            raise RuntimeError("No review domains discovered.")

        banner_repo = repo or banner_target
        banner = render_banner(
            tui_config,
            review_type=args.review_type,
            repo=banner_repo,
            pr_number=args.pr if args.review_type == "pr" else None,
            mode=mode,
            agent=triage_agent,
            model="pending",
        )

        _log(f"running triage across {len(candidate_domains)} domains")
        triage_result = triage_domains(
            content=content,
            review_type=args.review_type,
            domains=candidate_domains,
            mode=mode,
            agent=triage_agent,
            disabled_domains=disabled_domains,
            timeout=timeout,
            confidence_threshold=confidence_threshold,
        )

        banner = render_banner(
            tui_config,
            review_type=args.review_type,
            repo=banner_repo,
            pr_number=args.pr if args.review_type == "pr" else None,
            mode=triage_result.mode,
            agent=triage_result.agent,
            model=triage_result.model,
        )
        _emit_tui(banner, json_output=args.json_output)
        _emit_tui(render_triage(tui_config, triage_result), json_output=args.json_output)

        ordered_domains = _ordered_domain_keys(candidate_domains)
        candidate_dispatch_domains = [domain for domain in ordered_domains if domain not in set(disabled_domains)]

        if args.shadow:
            triage_result.dispatched_domains = list(candidate_dispatch_domains)
            triage_result.skipped_domains = [
                domain for domain in candidate_dispatch_domains if domain not in set(triage_result.dispatched_domains)
            ]

        if args.dry_run:
            _log("dry-run enabled; skipping dispatch")
            payload = _build_final_payload(
                triage_result,
                dispatch_results=[],
                findings=[],
                succeeded=0,
                failed=0,
                total_duration_s=time.monotonic() - started_at,
            )
            if args.json_output:
                print(json.dumps(payload, indent=2))
            return 0

        if not triage_result.dispatched_domains:
            _emit_tui(render_zero_domains(tui_config), json_output=args.json_output)
            insights_payload = {
                "review_type": args.review_type,
                "repo": repo,
                "pr": args.pr,
                "file": args.file,
                "shadow": args.shadow,
                "zero_domains": True,
                "triage": _serialize_triage(triage_result),
                "dispatch": {"results": [], "succeeded": 0, "failed": 0},
            }
            insights_ok, insights_error = _emit_insights(insights_url, insights_payload)
            _emit_tui(render_insights(tui_config, insights_ok, insights_error), json_output=args.json_output)
            payload = _build_final_payload(
                triage_result,
                dispatch_results=[],
                findings=[],
                succeeded=0,
                failed=0,
                total_duration_s=time.monotonic() - started_at,
            )
            if args.json_output:
                print(json.dumps(payload, indent=2))
            return 0

        dispatch_argv = _build_dispatch_argv(args, repo, triage_result.dispatched_domains)
        _log(f"dispatching {len(triage_result.dispatched_domains)} domains")
        for index, domain in enumerate(triage_result.dispatched_domains, start=1):
            agent_label = args.agents or ("single" if args.single else "multi")
            _emit_tui(
                render_dispatch_progress(
                    tui_config,
                    index=index,
                    total=len(triage_result.dispatched_domains),
                    agent=agent_label,
                    domain=domain,
                    status="running",
                ),
                json_output=args.json_output,
            )

        dispatch_started = time.monotonic()
        dispatch_data = _run_dispatch(dispatch_argv)
        dispatch_results, findings, succeeded, failed = _normalize_dispatch_payload(dispatch_data)

        for index, result in enumerate(dispatch_results, start=1):
            finding_list = result.get("findings", [])
            findings_count = result.get("findings_count")
            if findings_count is None and isinstance(finding_list, list):
                findings_count = len(finding_list)
            _emit_tui(
                render_dispatch_progress(
                    tui_config,
                    index=index,
                    total=len(dispatch_results),
                    agent=str(result.get("agent", "?")),
                    domain=str(result.get("domain", "?")),
                    status="failure" if result.get("error") else "success",
                    findings_count=int(findings_count) if findings_count is not None else None,
                    duration=float(result.get("duration_s", 0.0)) if result.get("duration_s") is not None else None,
                ),
                json_output=args.json_output,
            )

        total_duration_s = time.monotonic() - started_at
        by_severity = _count_by_severity(findings)
        _emit_tui(
            render_summary(
                tui_config,
                total_findings=len(findings),
                by_severity=by_severity,
                succeeded=succeeded,
                failed=failed,
                total_duration=total_duration_s,
                triage_duration=triage_result.duration_s,
            ),
            json_output=args.json_output,
        )

        insights_payload = {
            "review_type": args.review_type,
            "repo": repo,
            "pr": args.pr,
            "file": args.file,
            "shadow": args.shadow,
            "dry_run": args.dry_run,
            "dispatch_duration_s": round(time.monotonic() - dispatch_started, 3),
            "triage": _serialize_triage(triage_result),
            "dispatch": {
                "results": dispatch_results,
                "succeeded": succeeded,
                "failed": failed,
            },
            "summary": {
                "total_findings": len(findings),
                "by_severity": by_severity,
                "total_duration_s": round(total_duration_s, 3),
            },
        }
        insights_ok, insights_error = _emit_insights(insights_url, insights_payload)
        _emit_tui(render_insights(tui_config, insights_ok, insights_error), json_output=args.json_output)

        if args.json_output:
            print(
                json.dumps(
                    _build_final_payload(
                        triage_result,
                        dispatch_results=dispatch_results,
                        findings=findings,
                        succeeded=succeeded,
                        failed=failed,
                        total_duration_s=total_duration_s,
                    ),
                    indent=2,
                )
            )
        return 0
    except Exception as exc:
        _log(f"error: {exc}")
        if args.json_output:
            error_hash = hashlib.sha256(str(exc).encode("utf-8")).hexdigest()
            print(
                json.dumps(
                    {
                        "triage": {
                            "mode": args.triage or "conservative",
                            "agent": args.triage_agent or "claude",
                            "model": None,
                            "review_type": args.review_type,
                            "content_hash": f"sha256:{error_hash}",
                            "input_strategy": "full",
                            "dispatched_domains": [],
                            "skipped_domains": [],
                            "verdicts": [],
                            "duration_s": 0.0,
                            "error": str(exc),
                        },
                        "dispatch": {"results": [], "succeeded": 0, "failed": 0},
                        "findings": [],
                        "summary": {"total_findings": 0, "by_severity": {}, "total_duration_s": 0.0},
                    },
                    indent=2,
                )
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
