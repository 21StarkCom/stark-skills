# stark-init-docs — Internals

Scaffold dev docs structure into any repo. Modes: --template (empty skeleton), --backfill (generate from git history), --upgrade (migrate existing docs), --clean (remove skeleton). Use when the user says "init docs", "setup docs", "scaffold docs", or invokes /stark-init-docs.

## Architecture

```mermaid

```

![A light-themed internal architecture diagram for the stark-init-docs skill, showing a top-down workflow from invocation and precondition checks into mode resolution, then branching responsibilities for template, backfill, upgrade, and clean. Blue phase nodes mark execution stages, purple nodes mark decision gates like no-arg prompting and clean confirmation, green nodes mark mode/config blocks, gray boxes show external dependencies such as git, templates, gh, and repo manifests, and amber boxes show outputs like docs/, mkdocs navigation, generated ADRs, specs, guides, and observability metrics. Below the main flow are a four-column mode matrix, a data-flow table mapping repo inputs to generated artifacts, internals cards describing control plane and extension points, and risk cards highlighting missing templates, classification drift, and history-quality dependence."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-init-docs/SKILL.md`, then run `/stark-generate-docs --skill stark-init-docs` to regenerate documentation.
