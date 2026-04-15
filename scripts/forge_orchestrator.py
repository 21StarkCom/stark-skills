"""Forge orchestrator — worktree lifecycle, state, resume, and progress.

Entrypoint for the stark-forge pipeline. Creates an isolated git worktree,
manages atomic state persistence with crash-safe resume, and renders
progress to the terminal via tui_core primitives.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ── Git helpers ───────────────────────────────────────────────────────


def _git_current_branch() -> str:
    """Return the current git branch name, or empty string on failure."""
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except OSError:
        return ""


def _git_root() -> str:
    """Return the git repo root directory."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except OSError:
        return ""


# ── Branch name derivation ────────────────────────────────────────────

# Matches YYYY-MM-DD- prefix
_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")


def derive_branch_name(spec_path: Path) -> str:
    """Derive a forge branch name from a spec file path.

    - Uses only the filename (not parent dirs)
    - Strips YYYY-MM-DD- date prefix
    - Strips file extension
    - Replaces spaces and underscores with hyphens
    - Truncates the slug portion to 50 characters
    """
    stem = spec_path.stem
    # Strip date prefix
    stem = _DATE_PREFIX_RE.sub("", stem)
    # Replace spaces and underscores with hyphens
    stem = stem.replace(" ", "-").replace("_", "-")
    # Truncate to 50 chars
    stem = stem[:50]
    return f"forge/{stem}"


# ── Atomic state management ──────────────────────────────────────────


def write_state_atomic(
    state_path: Path,
    state: dict[str, Any],
    backup_dir: Path | None = None,
) -> None:
    """Write state to disk atomically via tmp + os.replace().

    Optionally mirrors to backup_dir/state-backup.json.
    """
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_path.with_suffix(".json.tmp")
    content = json.dumps(state, indent=2)
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(str(tmp_path), str(state_path))

    if backup_dir is not None:
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_file = backup_dir / "state-backup.json"
        backup_file.write_text(content, encoding="utf-8")


def load_state(
    state_path: Path,
    backup_path: Path | None = None,
) -> dict[str, Any]:
    """Load state from state_path, falling back to backup_path.

    Raises FileNotFoundError if neither file is readable.
    """
    # Try primary
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError):
            pass

    # Try backup
    if backup_path is not None and backup_path.exists():
        try:
            data = json.loads(backup_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError):
            pass

    raise FileNotFoundError(
        f"No valid state found at {state_path}"
        + (f" or {backup_path}" if backup_path else "")
    )


def init_state(spec_path: Path, spec_hash: str) -> dict[str, Any]:
    """Create the initial forge state schema.

    Includes a 'tdd' phase with status='pending' for v2 compatibility.
    """
    now = datetime.now(timezone.utc).isoformat()
    return {
        "version": 1,
        "spec_path": str(spec_path),
        "spec_hash": spec_hash,
        "phases": {
            "classify": {"status": "pending"},
            "design_review": {"status": "pending", "rounds": []},
            "plan": {"status": "pending"},
            "plan_review": {"status": "pending", "rounds": []},
            "tdd": {"status": "pending"},
            "tasks": {"status": "pending"},
        },
        "created_at": now,
        "updated_at": now,
    }


def _spec_hash(spec_path: Path) -> str:
    """Compute SHA-256 of a spec file's content."""
    return hashlib.sha256(spec_path.read_bytes()).hexdigest()


# ── Lock file ─────────────────────────────────────────────────────────


def acquire_lock(lock_path: Path) -> bool:
    """Acquire a forge lock file. Returns True on success, False on conflict.

    If the lock exists but the recorded PID is dead, the stale lock is
    cleaned and re-acquired.
    """
    if lock_path.exists():
        try:
            data = json.loads(lock_path.read_text(encoding="utf-8"))
            pid = data.get("pid")
            if pid is not None and _pid_alive(pid):
                return False
            # Stale lock — clean it
        except (json.JSONDecodeError, OSError):
            pass

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(
        json.dumps({"pid": os.getpid(), "acquired_at": time.time()}),
        encoding="utf-8",
    )
    return True


def release_lock(lock_path: Path) -> None:
    """Release the forge lock file. No-op if absent."""
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass


def _pid_alive(pid: int) -> bool:
    """Check whether a process with the given PID exists (signal 0)."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# ── Resume helpers ────────────────────────────────────────────────────

# Phase execution order
_PHASE_ORDER = [
    "classify",
    "design_review",
    "plan",
    "plan_review",
    "tdd",
    "tasks",
]


def _phases_to_run(state: dict[str, Any]) -> list[str]:
    """Determine which phases still need to run.

    - 'completed' phases are skipped
    - 'starting' phases are re-run (crash recovery)
    - 'pending' phases run normally
    """
    to_run: list[str] = []
    for phase in _PHASE_ORDER:
        phase_data = state["phases"].get(phase, {})
        status = phase_data.get("status", "pending")
        if status != "completed":
            to_run.append(phase)
    return to_run


def _check_spec_hash(state: dict[str, Any], current_hash: str) -> None:
    """Warn to stderr if the spec has changed since the run started."""
    original = state.get("spec_hash", "")
    if original and original != current_hash:
        print(
            "[WARN] Spec has changed since this forge run started. "
            "Continuing with current spec.",
            file=sys.stderr,
        )


# ── Worktree setup ───────────────────────────────────────────────────


def _setup_worktree(
    git_root: str, branch_name: str, spec_path: Path
) -> tuple[Path, str]:
    """Create a git worktree and copy the spec into it.

    Returns (worktree_path, branch_name).
    """
    slug = branch_name.split("/", 1)[1] if "/" in branch_name else branch_name
    worktree_path = Path(git_root) / ".worktrees" / f"forge-{slug}"

    if not worktree_path.exists():
        subprocess.run(
            ["git", "worktree", "add", str(worktree_path), "-b", branch_name],
            capture_output=True,
            text=True,
            check=True,
        )

    # Copy spec into worktree
    dest = worktree_path / spec_path.name
    if not dest.exists():
        shutil.copy2(str(spec_path), str(dest))

    return worktree_path, branch_name


def _find_existing_worktree(branch_name: str) -> Path | None:
    """Find an existing worktree for the given branch via git worktree list."""
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None

        current_path = None
        for line in result.stdout.splitlines():
            if line.startswith("worktree "):
                current_path = line[len("worktree ") :]
            elif line.startswith("branch ") and current_path:
                branch = line[len("branch refs/heads/") :]
                if branch == branch_name:
                    return Path(current_path)
                current_path = None
        return None
    except OSError:
        return None


# ── Progress rendering ────────────────────────────────────────────────


class ForgeProgress:
    """Terminal progress renderer for forge pipeline.

    Writes rich text labels to stderr always.
    Collects events for JSON summary on non-TTY stdout.
    """

    def __init__(self, is_tty: bool | None = None):
        self._is_tty = is_tty if is_tty is not None else (
            hasattr(sys.stderr, "isatty") and sys.stderr.isatty()
        )
        self._events: list[dict[str, str]] = []

    def _emit(self, label: str, phase: str, detail: str) -> None:
        """Write a progress line to stderr and record the event."""
        print(f"{label} {phase}: {detail}", file=sys.stderr)
        self._events.append(
            {"label": label.strip("[] "), "phase": phase, "detail": detail}
        )

    def ok(self, phase: str, detail: str) -> None:
        self._emit("[OK]", phase, detail)

    def fail(self, phase: str, detail: str) -> None:
        self._emit("[FAIL]", phase, detail)

    def skip(self, phase: str, detail: str) -> None:
        self._emit("[SKIP]", phase, detail)

    def halt(self, phase: str, detail: str) -> None:
        self._emit("[HALT]", phase, detail)

    def detect(self, phase: str, detail: str) -> None:
        self._emit("[DETECT]", phase, detail)

    def run(self, phase: str, detail: str) -> None:
        self._emit("[RUN]", phase, detail)

    def summary(self) -> dict[str, Any]:
        """Return structured JSON summary of all events."""
        return {"events": list(self._events)}


# ── Pipeline dispatcher ───────────────────────────────────────────────

# Exit codes propagated to ``run_forge``:
#   0 — success
#   1 — halted by iron-rule loop (findings unresolved)
#   2 — dispatch/infrastructure error in a phase
#
# ``_run_pipeline`` threads ``cfg`` (loaded once from ``get_forge_config``)
# through every phase, persists state after *every* phase transition, and
# halts the pipeline as soon as any phase returns ``status != "completed"``.
# Earlier versions of this function were a stub that reported ``ok`` for
# every phase without dispatching anything.


def _spec_path_in_worktree(worktree_path: Path, state: dict[str, Any]) -> Path:
    """Resolve the spec file inside the worktree.

    The spec was copied in by ``_setup_worktree`` — prefer the worktree
    copy so edits from fix-loops land on the right file.
    """
    raw = state.get("spec_path", "")
    if not raw:
        return Path("")
    original = Path(raw)
    candidate = worktree_path / original.name
    if candidate.exists():
        return candidate
    return original


def _write_phase_state(
    state: dict[str, Any],
    state_path: Path,
    phase: str,
    status: str,
    *,
    backup_dir: Path | None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Update a phase's status and persist state atomically."""
    state["phases"][phase]["status"] = status
    if extra:
        state["phases"][phase].update(extra)
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    write_state_atomic(state_path, state, backup_dir=backup_dir)


def _run_pipeline(
    worktree_path: Path,
    state: dict[str, Any],
    state_path: Path,
    progress: ForgeProgress,
    *,
    dry_run: bool = False,
    workers: int = 3,
    backup_dir: Path | None = None,
) -> int:
    """Run the forge pipeline phases in order, persisting state after each.

    Halts as soon as any phase returns a non-``completed`` status. Returns:
      0 — all phases completed
      1 — a phase halted (findings unresolved)
      2 — a phase raised an exception
    """
    del workers  # honored by individual phases via cfg["workers"]

    try:
        from config_loader import get_forge_config  # noqa: PLC0415
        cfg = get_forge_config()
    except ImportError:
        cfg = {}

    spec_path = _spec_path_in_worktree(worktree_path, state)
    phases = _phases_to_run(state)

    for phase in phases:
        # Mark phase as starting BEFORE dispatch so a crash mid-phase is
        # recoverable — _phases_to_run re-runs 'starting' phases on resume.
        _write_phase_state(state, state_path, phase, "starting", backup_dir=backup_dir)
        progress.run(phase, "dispatching")

        try:
            status, extra = _dispatch_phase(
                phase,
                spec_path=spec_path,
                worktree_path=worktree_path,
                state=state,
                cfg=cfg,
                dry_run=dry_run,
            )
        except Exception as exc:  # noqa: BLE001
            progress.fail(phase, f"{type(exc).__name__}: {exc}")
            _write_phase_state(
                state, state_path, phase, "error",
                backup_dir=backup_dir,
                extra={"error": f"{type(exc).__name__}: {exc}"},
            )
            return 2

        _write_phase_state(
            state, state_path, phase, status,
            backup_dir=backup_dir, extra=extra,
        )

        if status == "completed":
            progress.ok(phase, "completed")
        elif status == "skipped":
            progress.skip(phase, extra.get("reason", "skipped") if extra else "skipped")
        else:
            progress.halt(phase, extra.get("reason", status) if extra else status)
            return 1

        if dry_run and phase == "design_review":
            # Mirror the prior stub's dry-run contract: stop after design_review.
            break

    return 0


def _dispatch_phase(
    phase: str,
    *,
    spec_path: Path,
    worktree_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    dry_run: bool,
) -> tuple[str, dict[str, Any]]:
    """Run a single phase and return ``(status, extra_state)``.

    ``status`` is one of ``completed``, ``halted``, ``skipped``, ``error``.
    ``extra_state`` holds phase-specific fields to merge into state on exit.
    """
    if phase == "classify":
        return _dispatch_classify(spec_path, cfg)
    if phase == "design_review":
        if dry_run:
            return "skipped", {"reason": "dry-run"}
        return _dispatch_design_review(spec_path, state, cfg, worktree_path)
    if phase == "plan":
        return _dispatch_plan(spec_path, state, cfg, worktree_path)
    if phase == "plan_review":
        return _dispatch_plan_review(state, cfg, worktree_path)
    if phase == "tdd":
        return _dispatch_tdd()
    if phase == "tasks":
        return _dispatch_tasks(state, cfg, worktree_path)
    return "error", {"reason": f"unknown phase: {phase}"}


def _dispatch_classify(
    spec_path: Path, cfg: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    from forge_classifier import classify_spec  # noqa: PLC0415

    content = spec_path.read_text(encoding="utf-8")
    result = classify_spec(content, spec_path, auto_detect=True, cfg=cfg)
    return "completed", {
        "domains": list(result.domains),
        "skipped_domains": list(result.skipped_domains),
        "design_type": result.design_type,
        "tier_used": result.tier_used,
        "confidence": result.confidence,
    }


def _dispatch_design_review(
    spec_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> tuple[str, dict[str, Any]]:
    from forge_review import run_design_review  # noqa: PLC0415

    phase_result = run_design_review(spec_path, state, cfg, repo_dir)
    status = "completed" if phase_result.status == "completed" else "halted"
    extra: dict[str, Any] = {
        "findings_fixed": phase_result.findings_fixed,
        "noise": phase_result.noise,
        "commit_shas": list(phase_result.commit_shas),
    }
    if status == "halted":
        extra["reason"] = "design review findings unresolved"
    return status, extra


def _dispatch_plan(
    spec_path: Path,
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> tuple[str, dict[str, Any]]:
    from forge_plan import run_plan_phase  # noqa: PLC0415

    phase_result = run_plan_phase(spec_path, state, cfg, repo_dir)
    status = "completed" if phase_result.status == "completed" else "halted"
    extra: dict[str, Any] = {
        "commit_shas": list(phase_result.commit_shas),
    }
    if phase_result.plan_path is not None:
        extra["plan_path"] = str(phase_result.plan_path)
    if status == "halted":
        extra["reason"] = "plan generation halted"
    return status, extra


def _dispatch_plan_review(
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> tuple[str, dict[str, Any]]:
    from forge_plan import run_plan_review  # noqa: PLC0415

    plan_path_str = state.get("phases", {}).get("plan", {}).get("plan_path")
    if not plan_path_str:
        return "halted", {"reason": "no plan_path in state — did the plan phase run?"}
    plan_path = Path(plan_path_str)
    if not plan_path.exists():
        return "halted", {"reason": f"plan file missing: {plan_path}"}

    phase_result = run_plan_review(plan_path, state, cfg, repo_dir)
    status = "completed" if phase_result.status == "completed" else "halted"
    extra: dict[str, Any] = {
        "findings_fixed": phase_result.findings_fixed,
        "noise": phase_result.noise,
        "commit_shas": list(phase_result.commit_shas),
    }
    if phase_result.plan_hash:
        extra["plan_hash"] = phase_result.plan_hash
    if status == "halted":
        extra["reason"] = "plan review findings unresolved"
    return status, extra


def _dispatch_tdd() -> tuple[str, dict[str, Any]]:
    from forge_tdd import skip_tdd_phase  # noqa: PLC0415

    result = skip_tdd_phase()
    return "completed", {"skipped": result.get("skipped", True)}


def _dispatch_tasks(
    state: dict[str, Any],
    cfg: dict[str, Any],
    repo_dir: Path,
) -> tuple[str, dict[str, Any]]:
    from forge_tasks import run_tasks_phase  # noqa: PLC0415

    plan_path_str = state.get("phases", {}).get("plan", {}).get("plan_path")
    if not plan_path_str:
        return "halted", {"reason": "no plan_path in state — did the plan phase run?"}
    plan_path = Path(plan_path_str)
    if not plan_path.exists():
        return "halted", {"reason": f"plan file missing: {plan_path}"}

    phase_result = run_tasks_phase(plan_path, state, cfg, repo_dir)
    status = "completed" if phase_result.status == "completed" else "halted"
    extra: dict[str, Any] = {}
    if status == "halted":
        extra["reason"] = "task decomposition failed after retries"
    return status, extra


# ── Main entrypoint ──────────────────────────────────────────────────


def run_forge(
    spec_path: Path,
    *,
    auto_detect: bool = False,
    dry_run: bool = False,
    resume: bool = False,
    workers: int = 3,
) -> int:
    """Main forge entrypoint. Returns exit code.

    Exit codes:
        0 — success
        1 — general error
        3 — main branch guard / lock conflict
    """
    # ── Main branch guard ──
    branch = _git_current_branch()
    if branch in ("main", "master"):
        print(
            f"[FAIL] Cannot run forge on '{branch}' branch. "
            "Switch to a feature branch first.",
            file=sys.stderr,
        )
        return 3

    # ── Resolve git root ──
    git_root = _git_root()
    if not git_root:
        print("[FAIL] Not inside a git repository.", file=sys.stderr)
        return 1

    # ── Derive branch name ──
    branch_name = derive_branch_name(spec_path)

    # ── Resume or fresh start ──
    worktree_path: Path | None = None
    if resume:
        worktree_path = _find_existing_worktree(branch_name)

    if worktree_path is None:
        worktree_path, branch_name = _setup_worktree(
            git_root, branch_name, spec_path
        )

    # ── Lock ──
    lock_path = worktree_path / ".forge-lock"
    if not acquire_lock(lock_path):
        print(
            "[FAIL] Another forge run is active for this worktree. "
            "If stale, remove the lock file manually.",
            file=sys.stderr,
        )
        return 3

    # Register cleanup
    atexit.register(release_lock, lock_path)

    try:
        # ── State ──
        state_path = worktree_path / ".forge-state.json"
        backup_dir = worktree_path / ".forge-backup"
        backup_path = backup_dir / "state-backup.json"

        if resume and (state_path.exists() or backup_path.exists()):
            state = load_state(state_path, backup_path)
            current_hash = _spec_hash(spec_path)
            _check_spec_hash(state, current_hash)
        else:
            current_hash = _spec_hash(spec_path)
            state = init_state(spec_path, current_hash)
            write_state_atomic(state_path, state, backup_dir=backup_dir)

        # ── Progress renderer ──
        is_tty = hasattr(sys.stderr, "isatty") and sys.stderr.isatty()
        progress = ForgeProgress(is_tty=is_tty)

        # ── Run pipeline ──
        exit_code = _run_pipeline(
            worktree_path,
            state,
            state_path,
            progress,
            dry_run=dry_run,
            workers=workers,
            backup_dir=backup_dir,
        )

        # ── JSON summary for non-TTY ──
        stdout_tty = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
        if not stdout_tty:
            json.dump(progress.summary(), sys.stdout)
            sys.stdout.write("\n")

        return exit_code

    finally:
        release_lock(lock_path)
        # Unregister atexit handler (already cleaned up)
        try:
            atexit.unregister(release_lock)
        except Exception:
            pass


# ── Red-team integration (v1 design stage) ────────────────────────────
#
# Added by Task 16 of stark-red-team. This is the active v1 plug point.
# It runs the red team on a finalized design artifact and returns a
# status dict the caller can use to halt or proceed.
#
# v1 ships a single-round integration; the iterative refinement loop
# (regen → re-review → re-red-team) lands when forge auto-apply matures.
# The forge pipeline currently does NOT call this automatically — that
# happens in a follow-up integration task once the surrounding pipeline
# can act on the halt return values cleanly.

from pathlib import Path as _RT_Path  # alias to avoid clobbering existing imports
from typing import Any as _RT_Any


def run_red_team_design_stage(
    design_path: _RT_Path,
    source_spec_text: str,
    pr_diff: str | None,
    cwd: str | None,
    run_id: str,
    caller: str = "forge",
) -> dict[str, _RT_Any]:
    """Run the red-team layer against a design artifact at convergence time.

    Returns a status dict shaped as:
        {"status": str, "rounds": [...], "halt_reason": str | None}

    Pipeline callers should halt on {"halted_human_review", "halted",
    "error"} and proceed on {"clean", "disabled"}.

    v1 single-round: no auto-regen, no stability re-check. Future versions
    will iterate within the function.
    """
    from config_loader import get_red_team_config, get_model_rates
    import stark_red_team as _rt
    import red_team_audit

    cfg = get_red_team_config()
    if not cfg.get("enabled", True) or not cfg.get("stages", {}).get("design", {}).get("enabled", False):
        return {"status": "disabled", "rounds": [], "halt_reason": None}

    model_rates = get_model_rates()
    artifact = _RT_Path(design_path).read_text(encoding="utf-8")

    result = _rt.run_red_team(
        stage="design",
        artifact=artifact,
        source_spec=source_spec_text,
        pr_diff=pr_diff,
        personas=cfg["personas"],
        model=cfg["model"],
        model_rates=model_rates,
        cwd=cwd,
        timeout_s=cfg["timeout_s"],
        min_severity_to_block=cfg["min_severity_to_block"],
        max_input_chars=cfg["max_input_chars"],
        round_num=1,
    )

    # Audit
    try:
        red_team_audit.init_red_team_tables()
        red_team_audit.record_red_team_run({
            "run_id": run_id,
            "stage": "design",
            "rounds_used": 1,
            "final_status": (
                "clean"
                if result.blocking_count == 0 and result.human_review_count == 0
                else "halted"
            ),
            "total_findings": len(result.findings),
            "critical_count": sum(1 for f in result.findings if f.severity == "critical"),
            "high_count": sum(1 for f in result.findings if f.severity == "high"),
            "medium_count": sum(1 for f in result.findings if f.severity == "medium"),
            "human_review_count": result.human_review_count,
            "duration_s": result.duration_s,
            "cost_usd": result.cost_usd,
            "model": cfg["model"],
            "caller": caller,
        })
        if result.findings:
            red_team_audit.record_findings([
                {
                    "run_id": run_id,
                    "stage": "design",
                    "round_num": 1,
                    "finding_id": f.id,
                    "persona": f.persona,
                    "severity": f.severity,
                    "concern": f.concern,
                    "consequence": f.consequence,
                    "counter_proposal": f.counter_proposal,
                    "trade_off": f.trade_off,
                    "reason_for_uncertainty": f.reason_for_uncertainty,
                }
                for f in result.findings
            ])
    except Exception:  # pragma: no cover - audit must never break the pipeline
        pass

    if result.error:
        return {"status": "error", "rounds": [result], "halt_reason": result.error}
    if result.human_review_count > 0:
        return {"status": "halted_human_review", "rounds": [result], "halt_reason": "human_review_requested"}
    if result.blocking_count > 0:
        return {"status": "halted", "rounds": [result], "halt_reason": "findings_unresolved"}
    return {"status": "clean", "rounds": [result], "halt_reason": None}
