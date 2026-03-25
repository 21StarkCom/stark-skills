# stark-update-deps

Audit and update all dependency versions across a project to their latest stable releases. Scans pyproject.toml, package.json, requirements.txt, Dockerfile, docker-compose.yml, go.mod, Cargo.toml, and any other dependency manifest. Looks up each dependency on official sources (PyPI, npm, Docker Hub, GitHub releases) via WebSearch, checks for compatibility blockers and breaking changes, updates versions in-place, then re-verifies every updated version to ensure accuracy. Use when the user says "update dependencies", "check for outdated packages", "upgrade versions", "are my deps current", "stark-update-deps", or any variation of wanting to bring project dependencies up to date. Also use proactively when you notice stale or outdated versions during other work.

## Workflow Overview

```mermaid

```

![A clean single-page workflow diagram for the `stark-update-deps` skill, showing how a user invokes it with phrases like “update dependencies,” then moves through Discovery, Research, Compatibility Analysis, Update, Verification, and Final Report. Blue nodes represent workflow phases, a green node marks invocation, a purple node marks classification into Safe, Review, Blocked, and Skip, a red node shows the revert path for unverified versions, and an amber node shows the final output. Supporting tables explain scanned inputs and produced outputs, while cards highlight common workflows such as routine refreshes, major upgrade triage, and Docker tag verification."}}](usage.png)

## When to Use

Audit and update all dependency versions across a project to their latest stable releases. Scans pyproject.toml, package.json, requirements.txt, Dockerfile, docker-compose.yml, go.mod, Cargo.toml, and any other dependency manifest. Looks up each dependency on official sources (PyPI, npm, Docker Hub, GitHub releases) via WebSearch, checks for compatibility blockers and breaking changes, updates versions in-place, then re-verifies every updated version to ensure accuracy. Use when the user says "update dependencies", "check for outdated packages", "upgrade versions", "are my deps current", "stark-update-deps", or any variation of wanting to bring project dependencies up to date. Also use proactively when you notice stale or outdated versions during other work.

## Prerequisites

*See SKILL.md*

## Arguments

`(no args — auto-discovers all dependency manifests)`



## Quick Start

/stark-update-deps

## Common Patterns



## Troubleshooting



## Related Skills


