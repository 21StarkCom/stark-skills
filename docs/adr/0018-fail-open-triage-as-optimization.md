# ADR-0018: Fail-Open Triage as Optimization, Not Gate

## Status
Accepted

## Context
Domain triage reduces review cost by skipping irrelevant domains before dispatching to review agents. The key design question: should triage failures (LLM timeout, parse error, agent unavailable) block reviews or silently dispatch all domains?

## Decision
**Fail-open on all triage failures.** Triage is an optimization that reduces cost and latency. It must never prevent a review from running. On any failure after one retry, the engine returns a full-mode fallback result with all domains dispatched and the `error` field set.

Specific fail-open behaviors:
- LLM timeout (45s): retry once after 2s, then full mode
- Parse error: save raw output to debug directory, full mode
- Agent CLI not found: full mode immediately
- Missing domain verdicts: treat as relevant (dispatched)
- Confidence out of range: clamp to [0, 1]
- Zero dispatched domains (when user didn't request it): fall back to full mode with warning

## Consequences
- Reviews are never blocked by triage infrastructure issues
- Triage errors are observable via the `error` field in `triage_decision` events and debug files in `~/.claude/code-review/history/triage-errors/`
- The worst-case failure mode is "no cost savings" (equivalent to not having triage), never "missed review"
- Makes aggressive rollout safer: if the triage model hallucinates, the fallback dispatches everything

## Related
- Design: `docs/superpowers/specs/2026-04-04-domain-triage-design.md`
- Plan tracking: #220-#225
