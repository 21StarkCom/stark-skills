# 0005: Parse remote URL dynamically, never hardcode org or host

**Date:** 2026-03-20
**Status:** Accepted

## Context

The rename skill needs to construct replacement patterns for org/repo references, SSH URLs, and HTTPS URLs. These could be hardcoded to specific values (e.g., `GetEvinced`, `github.com`) or derived from the repository's actual remote configuration.

## Decision

Parse HOST, ORG, and repo name from `git remote get-url origin` at runtime. All replacement patterns are built from these parsed values. No hardcoded organization names or hostnames appear in the skill implementation.

## Alternatives Considered

- **Hardcoded org/host values** — Simpler implementation but locks the skill to a single org and host, requiring code changes for any other context.

## Consequences

- **Positive:** Skill works across any GitHub org and host without modification. Correct by construction — patterns always match the actual remote configuration.
- **Negative:** Requires robust URL parsing for both SSH (`git@host:org/repo.git`) and HTTPS (`https://host/org/repo.git`) formats. Currently only tested with github.com.
