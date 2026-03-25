# stark-init-docs — Internals

Scaffold dev docs structure into any repo. Modes: --template (empty skeleton), --backfill (generate from git history), --upgrade (migrate existing docs), --clean (remove skeleton). Use when the user says "init docs", "setup docs", "scaffold docs", or invokes /stark-init-docs.

## Architecture

```mermaid

```

![A clean internal architecture diagram for the `stark-init-docs` skill showing a top-down workflow from invocation and mode selection into four branches: template scaffolding, backfill analysis, upgrade migration, and safe cleanup; color-coded boxes distinguish phases, decisions, outputs, failures, and external inputs, with supporting tables for mode matrix, extension points, and observability metrics."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-init-docs/SKILL.md`, then run `/stark-generate-docs --skill stark-init-docs` to regenerate documentation.
