# stark-pr-flow — Internals

End-to-end PR workflow for GetEvinced repos — push, create PR, post self-review via stark-claude bot, present summary, and squash-merge with --admin on approval. Use when the user says "open PR", "create PR", "merge this", "ship it", or "stark-pr-flow".

## Architecture

```mermaid

```

![A clean internal architecture diagram for the stark-pr-flow skill showing a vertical PR workflow from prerequisites through push, diff analysis, PR creation, bot-based self-review, a hard stop for manual approval, an advisory documentation-state check, and final squash-admin merge with branch cleanup. Blue phase nodes form the main path, purple nodes mark approval decisions, green nodes mark configuration and auth boundaries, amber highlights the stop-and-summary output, and red annotations call out abort and recovery paths like dirty worktrees, main-branch misuse, diverged pushes, auth failures, and merge conflicts."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-pr-flow/SKILL.md`, then run `/stark-generate-docs --skill stark-pr-flow` to regenerate documentation.
