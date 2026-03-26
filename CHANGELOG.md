# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `scripts/tournament.py` — reusable tournament engine extracted from `generate_skill_docs.py` (#88)
- `TournamentConfig` and `TournamentResult` dataclasses with YAML config support (#89)
- `Tournament` orchestrator class with semantic and visual evaluation strategies (#90)
- Test evaluation strategy — run LLM-generated code against pytest test suites (#91)
- Tournament CLI with `--config`, `--prompt`, `--dry-run`, `--json` flags (#92)
- `/stark-tournament` skill for multi-LLM competition (#93)

### Changed
- `generate_skill_docs.py` refactored to use Tournament API (#94)
- Updated CLAUDE.md and README.md with `/stark-tournament` (#95)

## [v0.3.0] - 2026-03-25

### Added
- `generate_skill_docs.py` — multi-LLM documentation generator with visualization competition (#59, #60, #61, #62, #63, #64, #65, #66)
- `/stark-generate-docs` skill for ongoing doc maintenance (#69)
- Skill documentation for all 20 skills — Mermaid diagrams, HTML visualizations, PNG screenshots (#67, #68)
- Routing guide with Mermaid decision trees for skill discovery (#66)
- Git LFS tracking for skill documentation PNGs (#58)
- Shared CSS design system for HTML visualizations (#58)

### Changed
- `CLAUDE.md` — added `/stark-generate-docs` to skills tables (#70)

## [v0.2.0] - 2026-03-22

### Added
- `graphql()` function in `github_app.py` with retry support (#8)
- `github_projects.py` — GitHub Projects V2 GraphQL utility module with 13 public functions (#10)
- `setup_project.py` — one-time CLI script to create a Project with all custom fields (#14)
- `project-pr-sync` GitHub Action — PR events trigger project status transitions (#16)
- `project-gate-check` GitHub Action — composite release gate with `release-gate` status check (#18)
- `project-stale` GitHub Action — hourly detection of stuck agent/clarification items (#20)
- GitHub Projects integration in `stark-plan-to-tasks` — issues added to project with 9 fields set (#22)
- Project-based task fetching in `stark-phase-execute` with label fallback (#24)
- Documentation state advisory check in `stark-pr-flow` before merge (#26)
- Review Rounds field tracking in `stark-review` (#28)
- Project-aware session start/end in `stark-session` — briefing and doc state updates (#30)
- End-to-end integration tests for `github_projects.py` (#34)
- ADRs: 0010 (GraphQL for Projects V2), 0011 (fail-closed mutations), 0012 (additive migration)

### Changed
- `install.sh` now verifies `github_projects.py` and `setup_project.py` (#32)
- Comprehensive test suite for `github_projects.py` — 102 unit tests (#12)
