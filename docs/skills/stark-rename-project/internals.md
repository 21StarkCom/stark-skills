# stark-rename-project — Internals

Rename a project locally and on GitHub, update all references in sibling repos, and reinstall symlinks. Use when the user says "rename project", "rename repo", "rename this to", or invokes /stark-rename-project.

## Architecture

```mermaid

```

![Internal architecture visualization for the stark-rename-project skill, showing an eight-phase rename pipeline from validation and resumable state detection through GitHub rename, local directory move, symlink cleanup, reference rewrites in the main and sibling repos, symlink reinstall, verification, and final summary; side panels call out deterministic vs heuristic replacement rules, failure gates, resume states, extension points, and operator-facing outputs."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-rename-project/SKILL.md`, then run `/stark-generate-docs --skill stark-rename-project` to regenerate documentation.
