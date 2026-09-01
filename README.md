# stark-skills

AI-powered development workflow system for Claude Code and Codex, covering the full development lifecycle — from planning through code review, shipping, and maintenance. Optional Gemini support is available through config.

## Quick Start

```bash
# Install the plugins from the marketplace (in Claude Code)
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-gh, stark-ops, ...

# Or install the same bundles in Codex
codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-gh@bifrost
# Start a new Codex thread, then invoke: $cleanup --dry-run

# Start a work session (context loading, health checks, briefing)
/stark-session start

# PR review (1 LLM × triage-selected domains)
/stark-review 42

# End the session (tests, cleanup, push)
/stark-session end
```

All skills are available as `/slash-commands` in Claude Code and `$skill-name` mentions in Codex after installing the plugins. Each plugin is self-contained — it vendors the tools, config, prompts, and support files it needs, so there is nothing to symlink and no local install step.

---

## The Development Lifecycle

The human writes and gates the spec (`/stark-author`). Everything after that gate runs autonomously (`/stark-build`) — branching, implementation, one commit per green task, a draft PR, one cross-vendor advisory review, and exactly one fix round over its medium+ findings. Anything still open dies at the human, not in another loop.

---

## Skills

> Every skill supports `--help` (`/stark-<skill> --help`) — prints its purpose, usage, and arguments without running anything.

### Quality Gates

Review artifacts before they ship. Each review skill dispatches the enabled LLM agents in parallel, classifies findings as real issues vs. noise, and applies fixes autonomously.

| Skill | What it reviews | When to use |
|-------|----------------|-------------|
| `/stark-review` | PR code changes | Triage-selected domains, 1 LLM × N domains — fast, cheap, default agent configurable per domain. |
| [`/stark-review-improvement`](skill/stark-review-improvement/SKILL.md) | Review prompt effectiveness | After reviews produce too many false positives. Tunes agent prompts based on assessment data. |

**Best practice:** Gate the spec at `/stark-author`'s human checklist *before* implementation starts — it's cheaper to fix a spec than to fix code. Use `/stark-review` on every PR.

### Planning and Execution

Author a spec you have actually gated, then implement from it autonomously.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-author`](skill/stark-author/SKILL.md) | Human-gated spec + task DAG in one session | Starting anything non-trivial. Time-boxed recon, structured interview, then a spec you sign off on before a line is written. |
| [`/stark-build`](skill/stark-build/SKILL.md) | Check-gated autonomous implementation from that spec | After the spec is accepted. One fresh session per task, gated by checks the agent cannot edit. |

**Best practice:** The pipeline is two stages — `/stark-author` (you gate the spec) → `/stark-build` (checks gate the code). There is no LLM-reviewing-LLM loop between them, by design: the 2026-07-25 autopsy found those loops burned tokens without converging, and the five-stage chain they powered was demolished on 2026-07-26.

### Refactoring

Plan a restructure of an existing codebase before touching it.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-refactor-plan`](skill/stark-refactor-plan/SKILL.md) | Inspect any repo and emit `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json` | Before a refactor. Planning-only — produces an evidence-based, phased, file-by-file plan another agent can execute. Never modifies source. |

**Best practice:** Run `/stark-refactor-plan` first, review the plan and backlog, then execute the backlog one low-risk PR at a time (feed each task through `/stark-author` → `/stark-build`, or drive it by hand). The plan changes nothing but the two artifacts, so it's always safe to run.

### PR and Shipping

Move code from branch to production.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-release`](skill/stark-release/SKILL.md) | CHANGELOG → version bump → tag → GitHub Release | When a set of changes is ready to ship. Reads CHANGELOG.md to determine bump type. |

**Best practice:** Always run `/stark-release` when shipping — never tag manually.

### Session Management

Start and end your work sessions with consistent context loading and cleanup.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-session start`](skill/stark-session/SKILL.md) | Load context, git state, health checks, briefing | Beginning of every work session. Catches stale branches, failing tests, open PRs. |
| [`/stark-session end`](skill/stark-session/SKILL.md) | Tests, merge PRs, commit docs, push | End of every work session. Ensures nothing is left dangling. |
| [`/stark-persona`](skill/stark-persona/SKILL.md) | Session character voices | Adds personality to sessions. Weighted selection, date-aware combos, catchphrases, feedback loop. |

**Best practice:** Make `/stark-session start` and `/stark-session end` habitual — like opening and closing a shift. The start briefing catches context you'd otherwise miss (someone pushed to your branch, CI is red, a PR needs your review).

### Documentation

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-init-docs`](skill/stark-init-docs/SKILL.md) | Scaffold docs structure (ADRs, runbooks, etc.) | When starting a new project or adding docs to an existing one. Modes: template, backfill, upgrade, clean. |

### Project Management

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-housekeeping`](skill/stark-housekeeping/SKILL.md) | Audit stale issues, merged branches, and worktree remnants | When the repo or project board needs a cleanup pass. Supports dry-run and aggressive modes. |

---

## Typical Workflows

### Starting a new feature (full lifecycle)

```
/stark-session start                          # context + briefing
/stark-author "my feature"                    # spec + task DAG, you gate it
/stark-build docs/specs/2026-01-01-my-feature-spec.md   # autonomous implementation
/stark-session end                            # cleanup + push
```

### Reviewing someone else's PR

```
/stark-review 42                    # PR review: 1 agent × triage-selected domains
```

### Monthly maintenance

```
/stark-housekeeping                 # close stale issues, prune dead branches
```

---

## Architecture

The core engine dispatches the enabled AI agents across the configured review domains:

```
Default install:
├── claude × {architecture, behavior, security, test-coverage, spec-conformance}
└── codex  × {same 5 domains}

Optional:
└── gemini × {same 5 domains} when `models.gemini.enabled` is true
```

Each agent posts a consolidated review via its own GitHub App bot:
- **stark-claude** — architecture, accessibility, spec conformance focus
- **stark-codex** — correctness, behavior, test coverage focus
- **stark-gemini** — security, regression prevention, UI conformance focus

## Repo Structure

```
stark-skills/
├── skill/                        ← one dir per skill (stark-*/SKILL.md)
│   ├── stark-review/SKILL.md
│   ├── stark-persona/SKILL.md
│   └── ...
├── scripts/                      ← shell helpers + JSON (healer_patterns.json)
│   └── *.{sh,json}
├── tools/                        ← TypeScript dispatch infra, agent CLIs, meta-tooling
│   ├── multi_review.ts           ← PR review orchestrator
│   └── ...
├── global/                       ← config + prompts vendored into each plugin
│   ├── config.json               ← global defaults
│   └── prompts/{claude,codex,gemini}/  ← per-agent × per-domain review prompts (6 domains)
├── plugins/stark-gh/             ← local plugin source (packaged by the marketplace)
├── runtime-overrides/codex/      ← Codex-only artifact + support overlays; never shipped to Claude
├── data/                         ← persona roster, review coverage, showcase pages
├── .github/workflows/            ← GitHub Actions (tests, project sync, marketplace-sync)
├── org/evinced/                  ← org config overrides
├── docs/
│   ├── skills/                   ← generated skill docs (Markdown, Mermaid, JSON, and PNG artifacts)
│   ├── adr/                      ← architectural decision records
│   └── specs/                    ← design specs
└── standards/                    ← org-wide doc templates and workflows
```

## Distribution

This repo is the **source of truth** for the skills + tools; they ship as separate self-contained Claude Code and native Codex plugin packages via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace.

- Canonical `skill/`, `plugins/stark-gh/commands/`, and shared support files remain the Claude-authored surface. `runtime-overrides/codex/` contains complete Codex-only variants and their changed support files. Bifrost keeps those inputs and generated packages isolated; a Codex overlay must never enter `dist/claude/`.
- The marketplace `catalog/` is **generated from this repo** by `stark sync`. Bifrost emits Claude packages under `dist/claude/`, native Codex packages under `dist/codex-plugins/`, and host-specific marketplace manifests at the repository root.
- CI auto-publishes on every push to `main` touching a canonical vendored asset root or `runtime-overrides/codex/`.

```
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # then stark-plan, stark-implement, stark-gh, stark-ops, ...
/plugin update  stark-analyze@bifrost   # pull the latest published version

codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-gh@bifrost
# Open a new thread after install/update; invoke cleanup with: $cleanup --dry-run
```

Immutable assets (tools/prompts/config) resolve from the installed plugin root (`${CLAUDE_PLUGIN_ROOT}`) via `tools/asset_root_lib.ts`; mutable state (`history/`, `sessions/`, `locks/`, …) lives under `~/.claude/code-review/` (`stateRoot()`).

## Config Hierarchy

Same merge pattern as CLAUDE.md — most specific wins:

```
~/.claude/code-review/config.json          ← global (from this repo)
~/Code/.code-review/config.json     ← org override (from this repo)
~/Code/some-repo/.code-review/      ← repo override (in each repo)
  ├── config.json
  ├── prompts/                             ← per-agent prompt overrides
  └── domains/                             ← repo-specific domains (shared)
```

Repos can override: agents, domains, severity calibration, test/build commands, and individual prompts.

## Adding a Domain

Add a numbered markdown file to each agent's prompts directory:

```bash
# Global domain (all repos)
touch global/prompts/claude/07-performance.md
touch global/prompts/codex/07-performance.md
touch global/prompts/gemini/07-performance.md

# Repo-specific domain (shared across agents)
mkdir -p ~/Code/some-repo/.code-review/domains
touch ~/Code/some-repo/.code-review/domains/07-db-migrations.md
```

Domains are auto-discovered at startup.

## Prerequisites

- macOS (keychain-based auth)
- `claude`, `codex`, `gemini` CLI tools in PATH
- Node.js (TS tooling runs via `node`)
- GitHub App private keys in macOS Keychain

## Skill Documentation

Each skill documents itself: `skill/<name>/SKILL.md` is the source of truth, and
every skill answers `--help`. There is no generated documentation layer — the
previous one drifted two generations out of date and its generator was deleted,
so it described a pipeline that no longer existed. Read the skill, or run it
with `--help`.
