# Decisions

## 2026-03-22 — GitHub Projects V2 Integration

- **Date:** 2026-03-22
- **Status:** Decomposed → issues created
- **Tracking:** #3, #4, #5, #6
- **Story Points:** 47 total (14 tasks across 4 phases)
- **Summary:** Replace label-based workflow tracking with GitHub Projects V2 as the canonical state machine. New `github_projects.py` module wraps GraphQL operations. Three GitHub Actions enforce PR-triggered transitions, composite release gates, and stale detection. Five skills modified for project integration. Migration is additive — labels continue alongside fields.
- **Knowledge extracted to:** `docs/adr/0010-graphql-for-projects-v2.md`, `docs/adr/0011-fail-closed-mutations-fail-open-reads.md`, `docs/adr/0012-additive-migration-labels-to-project-fields.md`, `docs/glossary.md`
