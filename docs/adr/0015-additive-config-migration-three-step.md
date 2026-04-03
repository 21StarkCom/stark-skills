# ADR-0015: Additive Config Migration (Three-Step)

**Date:** 2026-04-03
**Status:** Accepted
**Context:** Workflow Improvement plan — config evolution from flat keys to structured blocks

## Decision

Migrate `global/config.json` from flat keys (`agents`, `model_pins`) to structured blocks (`models`, `runtime`, `self_heal`, etc.) using a three-step additive approach:

1. **P0:** Add new blocks alongside existing keys. Existing keys remain functional. Scripts fall back to old keys if new ones are absent.
2. **P1:** Emit deprecation warnings when both old and new keys are present. No behavior change.
3. **P2:** Remove old keys and all fallback code paths.

A shared config loader (`scripts/config_loader.py`) centralizes path resolution, caching, and typed accessors. No script independently hardcodes the config path after P0.

## Rationale

- Additive migration means any phase can be rolled back without data loss.
- Fallback paths ensure backward compat during the transition — old scripts/branches still work.
- Centralized loader prevents the "N scripts × M config paths" problem.
- Three steps give bake time between each behavior change.

## Alternatives Considered

- **Big-bang migration:** Replace all keys at once. Rejected: no rollback path, breaks concurrent branches.
- **Config versioning field:** Add `config_version: 2` and branch on it. Rejected: adds permanent branching complexity for a one-time migration.

## Consequences

- For 2 phases (~4 weeks), both old and new keys coexist. Config is larger than necessary.
- All P0+ scripts must import from `config_loader.py`, not parse JSON directly.
- After P2 completes, old config consumers in sibling repos must also be updated.
