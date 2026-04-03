# ADR-0017: PID-Aware Exclusive Write Locks

**Date:** 2026-04-03
**Status:** Accepted
**Context:** Workflow Improvement plan — concurrent agent collision prevention

## Decision

Use JSON lease files at `~/.claude/code-review/locks/{repo}-{path-hash}.lock` for exclusive write protection of shared directories (migrations, lockfiles). Each lock records: PID, process start time, timestamp, worktree path.

Staleness detection uses **both PID liveness AND process start time** to handle PID reuse on long-running systems. On macOS (no `/proc`), process start time is read via `ps -o lstart= -p {pid}`.

**TTL behavior:** TTL expiry only releases locks where the PID is dead OR start time mismatches. A live writer with matching start time is **never evicted by TTL** — instead, a `LOCK_TTL_EXCEEDED` warning is logged. Operators can force-release with `--force-unlock`.

## Rationale

- Autopilot and phase-execute run concurrent agents that can write to the same migration directory.
- Simple file-based locking avoids external dependencies (no Redis, no flock).
- PID-only staleness check fails when PIDs are recycled (common on macOS with short-lived processes).
- Start time comparison eliminates PID reuse false positives.
- Never evicting a live writer prevents data corruption even when TTL is too short.

## Alternatives Considered

- **flock-based locking:** Platform-specific, doesn't survive across worktrees.
- **PID-only staleness:** Vulnerable to PID reuse. Rejected.
- **Advisory locks in SQLite:** Over-engineered for file-based workflows.

## Consequences

- Lock scanning in preflight adds ~1s to startup.
- Operators must use `--force-unlock` if a lock is stuck (rare: only when process start time check fails).
- macOS-specific `ps` parsing adds a platform dependency.
