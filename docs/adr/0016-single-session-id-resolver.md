# ADR-0016: Single Session ID Resolver

**Date:** 2026-04-03
**Status:** Accepted
**Context:** Workflow Improvement plan — session identity across components

## Decision

Implement one authoritative session ID resolver (`scripts/session_id.py`) used by all session-aware code. Resolution priority:

1. `CLAUDE_SESSION_ID` environment variable (set by Claude Code runtime)
2. Active session markers in `~/.claude/projects/{project-slug}/`
3. `uuid4()` fallback (ephemeral session)

Result is cached per-process via `functools.lru_cache`. For `/clear` resume, `resolve_from_checkpoint()` reads the session ID from checkpoint files rather than generating a new one.

## Rationale

- Multiple components need session identity: event emitters, session state, context compactor, learning capture.
- Without a single resolver, each component would generate its own ID, making cross-component correlation impossible.
- Cache-per-process ensures a single session ID throughout a skill execution, even if the environment changes mid-run.
- Checkpoint-based resume preserves the original session ID across `/clear`, enabling continuous session tracking.

## Consequences

- All session-aware code imports from `session_id.py` — no independent session ID generation.
- Ephemeral sessions (uuid4 fallback) have limited cross-run correlation.
