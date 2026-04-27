#!/usr/bin/env python3
"""Pre-flight environment validation for stark-skills workflows.

Runs named checks and returns a structured result indicating whether the
environment is ready, degraded, or blocked for a given workflow.

Usage:
    python3 scripts/preflight.py --workflow autopilot --json
    python3 scripts/preflight.py --workflow review
    python3 scripts/preflight.py --workflow review --skip-check check_working_dir
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# Ensure scripts/ is on path when run directly.
sys.path.insert(0, str(Path(__file__).parent))

from config_loader import (
    get_models_config,
    is_agent_enabled,
    get_red_team_config,
    get_model_rates,
)
import emit_queue
import github_app
import lock_helpers

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

LOG_PATH = Path.home() / ".claude" / "code-review" / "preflight.jsonl"
HARD_STOP_PATH = Path.home() / ".claude" / "code-review" / "cost-hard-stop"

TOTAL_TIMEOUT_S = 30

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class CheckResult:
    name: str
    status: str        # "pass" | "warn" | "fail" | "skip"
    message: str
    duration_s: float


@dataclass
class PreFlightResult:
    workflow: str
    overall: str       # "ready" | "degraded" | "blocked"
    checks: list[dict]
    recommended_mode: str
    timestamp: str


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------


def _run_cmd(args: list[str], timeout: int = 5) -> tuple[bool, str]:
    """Run a command; return (success, stdout/stderr snippet)."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0:
            return True, (result.stdout.strip() or "ok")
        return False, (result.stderr.strip() or result.stdout.strip() or "non-zero exit")
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    except FileNotFoundError:
        return False, f"not found: {args[0]}"
    except Exception as exc:
        return False, str(exc)


def _timed(fn: Callable[[], tuple[str, str]]) -> tuple[str, str, float]:
    """Call fn() and return (status, message, elapsed_s)."""
    t0 = time.monotonic()
    status, message = fn()
    return status, message, round(time.monotonic() - t0, 3)


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------


def check_cli_claude() -> tuple[str, str]:
    ok, out = _run_cmd(["claude", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_cli_codex() -> tuple[str, str]:
    ok, out = _run_cmd(["codex", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_cli_gemini() -> tuple[str, str]:
    if not is_agent_enabled("gemini"):
        return "skip", "gemini disabled in config"
    ok, out = _run_cmd(["gemini", "--version"], timeout=5)
    return ("pass", out) if ok else ("fail", out)


def check_keychain_claude() -> tuple[str, str]:
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_CLAUDE_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_keychain_codex() -> tuple[str, str]:
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_CODEX_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_keychain_gemini() -> tuple[str, str]:
    if not is_agent_enabled("gemini"):
        return "skip", "gemini disabled in config"
    ok, out = _run_cmd(
        ["security", "find-generic-password", "-s", "STARK_GEMINI_PRIVATE_KEY", "-w"],
        timeout=5,
    )
    return ("pass", "key found") if ok else ("fail", f"keychain: {out}")


def check_github_app() -> tuple[str, str]:
    try:
        token = github_app.get_token()
        return ("pass", "token obtained") if token else ("fail", "empty token returned")
    except SystemExit as exc:
        return "fail", f"get_token() exited: {exc}"
    except Exception as exc:
        return "fail", str(exc)


def check_working_dir() -> tuple[str, str]:
    ok, out = _run_cmd(["git", "status", "--porcelain"], timeout=5)
    if not ok:
        return "warn", f"git status failed: {out}"
    if out.strip():
        return "warn", "working directory has uncommitted changes"
    return "pass", "clean"


_TEAM_REVIEW_WORKFLOWS = frozenset({"stark-team-review"})


def check_model_resolution(workflow: str | None = None) -> tuple[str, str]:
    """Report the agents that will actually dispatch for a review run.

    There are two knobs that gate dispatch and they don't always agree:
      - ``models.<agent>.enabled`` — whether the agent's CLI/auth is configured.
      - ``config.agents`` — the explicit dispatch rotation list.

    The dispatcher only runs an agent when both say yes, so this check
    reports the intersection (the *dispatched* set) and warns when the
    two knobs disagree in the surprising direction (an agent enabled
    in models but excluded from the rotation, where preflight had been
    advertising it as ready and the dispatcher was silently dropping
    it). The opposite direction — an agent listed in the rotation but
    disabled in models — is benign because the dispatcher skips it
    explicitly; we don't warn on that case.

    Empty intersection severity is workflow-aware: ``stark-team-review``
    relies on the rotation as its only dispatch source, so an empty
    intersection there is a hard ``fail``. Single-agent workflows
    (``stark-review`` with ``--agent`` or ``domain_agents``) can still
    dispatch without going through the rotation, so we only ``warn``
    there and let the dispatcher itself error if no agent can run.
    """
    models = get_models_config()
    expected = ["claude", "codex"]
    missing = [a for a in expected if a not in models]
    if missing:
        return "fail", f"missing agent config: {missing}"
    enabled = sorted(
        agent
        for agent, cfg in models.items()
        if isinstance(cfg, dict) and cfg.get("enabled")
    )
    if not enabled:
        return "fail", "no enabled agents in config"
    disabled = sorted(
        agent
        for agent, cfg in models.items()
        if isinstance(cfg, dict) and not cfg.get("enabled")
    )

    # Intersect with the dispatch rotation list (``config.agents``).
    # Failure modes handled distinctly:
    #   - dispatcher_base genuinely absent (older install): fall back
    #     to legacy enabled-only reporting. We narrow the catch to
    #     ImportError-from-this-import specifically so a transitive
    #     ImportError raised from inside dispatcher_base (its own
    #     dependencies broken) doesn't fail open.
    #   - discover_config raising any other exception (malformed JSON,
    #     unreadable file, transitive ImportError, etc.): surface as
    #     ``warn`` (or ``fail`` for team-review).
    #   - ``config.agents`` present but not a list of strings:
    #     ``warn`` for single-agent / unknown workflows, ``fail`` for
    #     team-review (the dispatcher would iterate the malformed value
    #     and produce a clean 0-agent run).
    is_team_workflow = (workflow or "") in _TEAM_REVIEW_WORKFLOWS
    dispatch_list: list[str] | None = None
    discover_warning: str | None = None
    try:
        from dispatcher_base import discover_config  # type: ignore[import]
    except ImportError as exc:
        # Only treat as legacy fallback if the missing module is
        # ``dispatcher_base`` itself; transitive ImportErrors should
        # surface as warnings.
        if getattr(exc, "name", None) == "dispatcher_base":
            pass
        else:
            discover_warning = f"could not import dispatcher_base ({exc})"
    else:
        try:
            cfg = discover_config()
        except Exception as exc:  # noqa: BLE001 — intentional broad catch with warning
            discover_warning = f"could not load review config: {exc}"
        else:
            agents_list = cfg.get("agents")
            if agents_list is None:
                # No override; the dispatcher will use AGENTS keys (all enabled).
                dispatch_list = list(enabled)
            elif isinstance(agents_list, list) and all(isinstance(a, str) for a in agents_list):
                dispatch_list = sorted(set(agents_list))
            else:
                # Don't include the raw value — it goes into preflight.jsonl
                # and the durable event queue, where a misconfigured agents
                # entry could leak whatever the operator pasted in.
                discover_warning = (
                    f"config.agents is malformed (expected list[str], got "
                    f"{type(agents_list).__name__})"
                )

    if discover_warning is not None:
        msg = f"enabled agents: {enabled}"
        if disabled:
            msg += f"; disabled agents: {disabled}"
        # Team-review dispatches strictly off ``config.agents``; bad
        # config there means a clean 0-finding run, which is worse
        # than blocking. Single-agent workflows can still dispatch via
        # ``--agent`` / ``domain_agents``, so warn-and-continue.
        severity = "fail" if is_team_workflow else "warn"
        return severity, f"{discover_warning}; {msg}"

    if dispatch_list is None:
        # ImportError path — legacy report.
        if disabled:
            return "pass", f"enabled agents: {enabled}; disabled agents: {disabled}"
        return "pass", f"enabled agents: {enabled}"

    enabled_set = set(enabled)
    rotation_set = set(dispatch_list)
    dispatched = sorted(enabled_set & rotation_set)
    enabled_but_not_in_rotation = sorted(enabled_set - rotation_set)

    notes: list[str] = [f"dispatched agents: {dispatched}"]
    if enabled_but_not_in_rotation:
        notes.append(
            f"enabled but excluded from config.agents (silently skipped): "
            f"{enabled_but_not_in_rotation}"
        )
    # Disabled-but-in-rotation is *not* a misalignment worth flagging:
    # the dispatcher explicitly checks ``is_agent_enabled`` and drops
    # those, which is exactly the behavior we want. Reporting it as a
    # warning meant a fresh install that disabled gemini got marked
    # ``degraded`` despite being in a perfectly healthy steady state.
    if disabled:
        notes.append(f"disabled in models: {disabled}")

    # Empty intersection severity depends on workflow.
    #
    # Team-review dispatches strictly off ``config.agents`` — an empty
    # rotation/enabled overlap means the entire run produces a clean
    # 0-finding round with no review work done, which is worse than
    # blocking the run. Hard fail.
    #
    # Single-agent workflows (``stark-review`` and friends) can still
    # dispatch via ``--agent`` or per-domain ``domain_agents`` mappings
    # that bypass ``config.agents`` entirely. A warn lets the operator
    # see the misalignment without preventing a perfectly valid run.
    if not dispatched:
        if is_team_workflow:
            return (
                "fail",
                "team-review has no dispatchable agents — config.agents "
                f"({sorted(rotation_set)}) and enabled models "
                f"({sorted(enabled_set)}) don't overlap. Empty rotation "
                "would silently produce a clean 0-finding review.",
            )
        notes.insert(
            0,
            "no agents in the team-review intersection — single-agent dispatch may still work",
        )
        return "warn", "; ".join(notes)

    status = "warn" if enabled_but_not_in_rotation else "pass"
    return status, "; ".join(notes)


def check_cost_hard_stop() -> tuple[str, str]:
    if HARD_STOP_PATH.exists():
        return "fail", f"cost hard-stop active ({HARD_STOP_PATH})"
    return "pass", "no hard stop"


def check_deprecated_config() -> tuple[str, str]:
    """Warn if org/repo overrides still contain deprecated model_pins key."""
    try:
        from config_loader import load_config
        config = load_config()
    except Exception as exc:
        return "warn", f"could not load config: {exc}"

    automation = config.get("automation", {})
    if isinstance(automation, dict) and "model_pins" in automation:
        return (
            "warn",
            "automation.model_pins found in org/repo config override — "
            "remove it; use the 'models' block instead",
        )
    return "pass", "no deprecated config keys"


def check_stale_locks() -> tuple[str, str]:
    """Scan known lock locations for stale lock files."""
    lock_dirs = [
        Path.home() / ".claude" / "code-review",
        Path("/tmp"),
    ]
    stale: list[str] = []
    for lock_dir in lock_dirs:
        if not lock_dir.exists():
            continue
        for lock_file in lock_dir.glob("*.lock"):
            if lock_helpers.is_lock_stale(str(lock_file)):
                stale.append(str(lock_file))

    if stale:
        return "warn", f"stale lock files: {', '.join(stale)}"
    return "pass", "no stale locks"


def check_red_team_model_rates() -> tuple[str, str]:
    """Verify red_team.model has an entry in the top-level model_rates section.

    The _fallback row is deliberately conservative (high rates) so missing
    entries DON'T silently under-count — the preflight must fail blocked
    so operators notice and fix the real rate entry.
    """
    try:
        cfg = get_red_team_config()
    except Exception as exc:
        return "warn", f"could not load red_team config: {exc}"

    if not cfg.get("enabled", True):
        return "skip", "red_team disabled in config"

    model = cfg.get("model")
    if not model:
        return "fail", "red_team.model is not set"

    try:
        rates = get_model_rates()
    except Exception as exc:
        return "warn", f"could not load model_rates: {exc}"

    if model not in rates or model == "_fallback":
        return "fail", (
            f"red_team.model '{model}' has no entry in model_rates — "
            f"add one to global/config.json. _fallback is not accepted."
        )

    return "pass", f"rates found for {model}"


def check_red_team_transport_auth() -> tuple[str, str]:
    """Verify the locked default model's transport has the auth it needs.

    Models in `RESPONSES_API_MODELS` route through the OpenAI Responses API,
    which requires `OPENAI_API_KEY` (or `OPENAI_API_KEY_FILE` +
    `OPENAI_API_KEY_LABEL`) — *not* the codex-CLI keychain. Without this
    check, an install with valid Codex auth and no OpenAI key passes
    preflight and then halts at the design gate with `no OpenAI API key
    available` — surfacing as an unactionable runtime failure long after
    setup. (Round-3 finding 11.)
    """
    try:
        from stark_red_team import RESPONSES_API_MODELS, _resolve_openai_api_key
    except ImportError as exc:
        return "warn", f"could not import stark_red_team: {exc}"

    try:
        cfg = get_red_team_config()
    except Exception as exc:
        return "warn", f"could not load red_team config: {exc}"

    if not cfg.get("enabled", True):
        return "skip", "red_team disabled in config"

    model = cfg.get("model")
    if model not in RESPONSES_API_MODELS:
        return "skip", f"model {model!r} routes through codex CLI, not Responses API"

    if _resolve_openai_api_key(os.environ) is None:
        return "fail", (
            f"red_team.model '{model}' routes through the Responses API but "
            "no OpenAI API key is available. Set OPENAI_API_KEY, or "
            "OPENAI_API_KEY_FILE+OPENAI_API_KEY_LABEL, in the environment."
        )

    return "pass", f"OpenAI API key resolved for {model}"


# ---------------------------------------------------------------------------
# Check registry: (name, fn, is_critical)
# critical=True → a "fail" status sets overall to "blocked"
# ---------------------------------------------------------------------------

_CHECKS: list[tuple[str, Callable[..., tuple[str, str]], bool]] = [
    ("check_cli_claude",       check_cli_claude,       False),
    ("check_cli_codex",        check_cli_codex,        False),
    ("check_cli_gemini",       check_cli_gemini,       False),
    ("check_keychain_claude",  check_keychain_claude,  True),
    ("check_keychain_codex",   check_keychain_codex,   True),
    ("check_keychain_gemini",  check_keychain_gemini,  True),
    ("check_github_app",       check_github_app,       True),
    ("check_working_dir",      check_working_dir,      False),
    ("check_model_resolution", check_model_resolution, True),
    ("check_cost_hard_stop",       check_cost_hard_stop,       True),
    ("check_stale_locks",          check_stale_locks,          False),
    ("check_deprecated_config",    check_deprecated_config,    False),
    ("check_red_team_model_rates", check_red_team_model_rates, True),
    ("check_red_team_transport_auth", check_red_team_transport_auth, True),
]


# ---------------------------------------------------------------------------
# Core runner
# ---------------------------------------------------------------------------


def run_preflight(workflow: str, skip: set[str] | None = None) -> PreFlightResult:
    """Run all registered checks and aggregate into a PreFlightResult."""
    skip = skip or set()
    results: list[CheckResult] = []
    has_critical_fail = False
    has_noncritical_degraded = False

    for name, fn, is_critical in _CHECKS:
        if name in skip:
            print(f"  [SKIP-OVERRIDE] {name}", file=sys.stderr)
            results.append(
                CheckResult(name=name, status="skip",
                            message="skipped via --skip-check", duration_s=0.0)
            )
            continue

        # ``check_model_resolution`` reads the workflow to decide
        # whether an empty rotation/enabled overlap is a hard fail
        # (team-review) or a warn (single-agent). Pass workflow
        # through without overriding the registered function — that
        # way monkeypatching the registry in tests still takes effect.
        if name == "check_model_resolution":
            bound_fn = fn
            timed_callable = lambda: bound_fn(workflow)
        else:
            timed_callable = fn

        status, message, duration_s = _timed(timed_callable)
        results.append(CheckResult(name=name, status=status,
                                   message=message, duration_s=duration_s))

        if status == "fail":
            if is_critical:
                has_critical_fail = True
            else:
                has_noncritical_degraded = True
        elif status == "warn":
            has_noncritical_degraded = True

    if has_critical_fail:
        overall = "blocked"
        recommended_mode = "abort"
    elif has_noncritical_degraded:
        overall = "degraded"
        recommended_mode = "single-agent"
    else:
        overall = "ready"
        recommended_mode = "full"

    return PreFlightResult(
        workflow=workflow,
        overall=overall,
        checks=[asdict(r) for r in results],
        recommended_mode=recommended_mode,
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


# ---------------------------------------------------------------------------
# Logging & event emission
# ---------------------------------------------------------------------------


def _log_result(result: PreFlightResult) -> None:
    """Append the result as a JSON line to the preflight log."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(result)) + "\n")
    except OSError as exc:
        print(f"preflight: warning: failed to write log: {exc}", file=sys.stderr)


def _emit_event(result: PreFlightResult) -> None:
    """Emit a preflight_check event to the durable queue."""
    try:
        event = emit_queue.make_event(
            "preflight_check",
            {
                "workflow": result.workflow,
                "overall": result.overall,
                "recommended_mode": result.recommended_mode,
                "checks": result.checks,
            },
        )
        emit_queue.enqueue(event)
    except Exception as exc:
        print(f"preflight: warning: failed to emit event: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Human-readable output
# ---------------------------------------------------------------------------

_STATUS_SYMBOL = {"pass": "✓", "fail": "✗", "warn": "⚠", "skip": "–"}
_OVERALL_LABEL = {"ready": "READY", "degraded": "DEGRADED", "blocked": "BLOCKED"}


def _print_table(result: PreFlightResult) -> None:
    label = _OVERALL_LABEL.get(result.overall, result.overall.upper())
    print(f"\nPreflight: {result.workflow}  [{label}]")
    print(f"{'Check':<30} {'St':<5} {'Message'}")
    print("-" * 72)
    for check in result.checks:
        sym = _STATUS_SYMBOL.get(check["status"], "?")
        dur = f"({check['duration_s']:.3f}s)" if check["duration_s"] > 0 else ""
        print(f"{check['name']:<30} {sym} {check['status']:<5}  "
              f"{check['message']} {dur}".rstrip())
    print("-" * 72)
    print(f"Recommended mode: {result.recommended_mode}")
    print()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stark preflight environment validator"
    )
    parser.add_argument(
        "--workflow", default="default",
        help="Workflow name (used in log and event payload)"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output PreFlightResult as JSON instead of a table"
    )
    parser.add_argument(
        "--skip-check", action="append", default=[], metavar="NAME",
        help="Skip a named check (repeatable, logs override to stderr)"
    )
    args = parser.parse_args()

    skip = set(args.skip_check)
    result = run_preflight(args.workflow, skip=skip)

    _log_result(result)
    _emit_event(result)

    if args.json:
        print(json.dumps(asdict(result), indent=2))
    else:
        _print_table(result)

    if result.overall == "blocked":
        sys.exit(1)


if __name__ == "__main__":
    main()
