# stark-onboard-project — Internals

Bootstrap a new project end-to-end — initializes git, creates a GitHub repo in GetEvinced org, connects all 3 GitHub Apps (stark-claude, stark-codex, stark-gemini), then sets up Claude Code (CLAUDE.md, .claude/ directory, memory). Use when the user says "onboard project", "setup claude", "bootstrap claude", "init project", "create repo", "new project", or "stark-onboard-project". Also use when starting work in a directory that has no git repo and no CLAUDE.md.

## Architecture

```mermaid

```

![A clean internal architecture diagram for the stark-onboard-project skill, showing a vertical workflow from bootstrap context through five phases: git initialization, GitHub repository creation, GitHub App connection, Claude Code setup, and final summary. Blue nodes mark workflow phases, purple nodes mark decision gates like “already a git repo?” and “CLAUDE.md exists?”, amber marks final outputs, red highlights manual recovery for GitHub App scope failures, and gray annotations explain external dependencies such as gh CLI, GitHub APIs, org installation settings, and the Python helper scripts. Supporting sections below summarize architecture notes, configuration surfaces, failure modes, and extension points for modifying the skill safely."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-onboard-project/SKILL.md`, then run `/stark-generate-docs --skill stark-onboard-project` to regenerate documentation.
