# Decisions

## 2026-03-22 — GitHub Projects V2 Integration

- **Date:** 2026-03-22
- **Status:** Decomposed → issues created
- **Tracking:** #3, #4, #5, #6
- **Story Points:** 47 total (14 tasks across 4 phases)
- **Summary:** Replace label-based workflow tracking with GitHub Projects V2 as the canonical state machine. New `github_projects.py` module wraps GraphQL operations. Three GitHub Actions enforce PR-triggered transitions, composite release gates, and stale detection. Five skills modified for project integration. Migration is additive — labels continue alongside fields.
- **Knowledge extracted to:** `docs/adr/0010-graphql-for-projects-v2.md`, `docs/adr/0011-fail-closed-mutations-fail-open-reads.md`, `docs/adr/0012-additive-migration-labels-to-project-fields.md`, `docs/glossary.md`

## 2026-03-25 — Skill Documentation & Visualization System

- **Date:** 2026-03-25
- **Status:** Decomposed → issues created
- **Tracking:** #52, #53, #54, #55, #56, #57
- **Story Points:** 44 total (14 tasks across 6 phases)
- **Summary:** Multi-LLM documentation generator for stark-skills. 3 LLMs compete to generate HTML visualizations per skill, Claude judges PNG screenshots, markdown docs include Mermaid diagrams and PNG embeds. Two audience splits per skill (usage guide + internals). Routing guide with Mermaid decision trees. HTML sanitization via html.parser (not regex). Staleness detection with per-audience quality flags. Flat ThreadPoolExecutor (MAX_WORKERS=6).
- **Knowledge extracted to:** `docs/decisions.md`

## 2026-03-26 — Reusable Tournament Engine (`/stark-tournament`)

- **Date:** 2026-03-26
- **Status:** Decomposed → issues created
- **Tracking:** #85, #86, #87
- **Story Points:** 29 total (9 tasks across 3 phases)
- **Summary:** Extract the tournament pattern from `generate_skill_docs.py` into a reusable `scripts/tournament.py` module. Adds `TournamentConfig` (YAML + dict), `TournamentResult` (dataclass), `Tournament` (orchestrator class) with visual, semantic, and test evaluation strategies. CLI with argparse, `/stark-tournament` skill. Final step refactors `generate_skill_docs.py` to use the Tournament API. Custom evaluation strategy deferred to v2.
- **Knowledge extracted to:** `docs/decisions.md`
