# stark-skills

AI-powered development workflow system for Claude Code. 20 skills covering the full development lifecycle — from planning through code review, shipping, and maintenance. Built on 3 competing AI agents (Claude, Codex, Gemini) that cross-validate each other's work.

## Quick Start

```bash
# Clone and install
git clone git@github.com:GetEvinced/stark-skills.git ~/git/Evinced/stark-skills
cd ~/git/Evinced/stark-skills
./install.sh

# Start a work session (context loading, health checks, briefing)
/stark-session start

# Review a PR with 3 LLMs × 6 domains
/stark-review 42

# End the session (tests, cleanup, push)
/stark-session end
```

All skills are available as `/slash-commands` in Claude Code after installing.

---

## Skills

### Quality Gates

Review artifacts before they ship. Each review skill dispatches 3 LLMs in parallel, classifies findings as real issues vs. noise, and applies fixes autonomously.

| Skill | What it reviews | When to use |
|-------|----------------|-------------|
| [`/stark-review`](docs/skills/stark-review/usage.md) | PR code changes | Before merging any PR. The core skill — 3 LLMs × 6 domains, autonomous fix loop. |
| [`/stark-review-plan`](docs/skills/stark-review-plan/usage.md) | Design docs and specs | Before implementing. Stress-tests plans across 7 domains (architecture, security, operations, etc.). |
| [`/stark-review-deployment-plan`](docs/skills/stark-review-deployment-plan/usage.md) | Infrastructure and migration plans | Before deploying. Adversarial SRE review across 10 failure vectors. |
| [`/stark-review-improvement`](docs/skills/stark-review-improvement/usage.md) | Review prompt effectiveness | After reviews produce too many false positives. Tunes agent prompts based on assessment data. |

**Best practice:** Run `/stark-review-plan` on specs *before* implementation starts. It's cheaper to fix a plan than to fix code. Use `/stark-review` on every PR — the autonomous fix loop handles most findings without human intervention.

### Planning and Execution

Turn ideas into tracked, phased GitHub issues, then execute them autonomously.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-plan-to-tasks`](docs/skills/stark-plan-to-tasks/usage.md) | Decompose a spec into phased GitHub issues | After a spec/plan is reviewed and approved. 3 LLM passes: quality gate → decomposition → validation. |
| [`/stark-phase-execute`](docs/skills/stark-phase-execute/usage.md) | Autonomously implement all tasks in a phase | When you have GitHub issues ready. Branches, implements, PRs, reviews, merges — zero intervention. |

**Best practice:** The full pipeline is: write spec → `/stark-review-plan` → fix → `/stark-plan-to-tasks` → `/stark-phase-execute`. Each step feeds the next. Don't skip the review step — unreviewed plans produce ambiguous issues that block autonomous execution.

### PR and Shipping

Move code from branch to production.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-pr-flow`](docs/skills/stark-pr-flow/usage.md) | Push → create PR → self-review → merge | When you want the full PR lifecycle in one command. Includes multi-agent review. |
| [`/stark-release`](docs/skills/stark-release/usage.md) | CHANGELOG → version bump → tag → GitHub Release | When a set of changes is ready to ship. Reads CHANGELOG.md to determine bump type. |
| [`/stark-pr-status`](docs/skills/stark-pr-status/usage.md) | PR analytics dashboard | When you want to understand review cycles, merge times, or finding quality for specific PRs. |

**Best practice:** Use `/stark-pr-flow` for routine work. For larger efforts, `/stark-phase-execute` handles PR creation internally. Always run `/stark-release` when shipping — never tag manually.

### Session Management

Start and end your work sessions with consistent context loading and cleanup.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-session start`](docs/skills/stark-session/usage.md) | Load context, git state, health checks, briefing | Beginning of every work session. Catches stale branches, failing tests, open PRs. |
| [`/stark-session end`](docs/skills/stark-session/usage.md) | Tests, merge PRs, commit docs, push | End of every work session. Ensures nothing is left dangling. |
| [`/stark-session-insights`](docs/skills/stark-session-insights/usage.md) | Analyze session history for patterns | Periodically. Shows which skills you use most, common corrections, preference patterns. |

**Best practice:** Make `/stark-session start` and `/stark-session end` habitual — like opening and closing a shift. The start briefing catches context you'd otherwise miss (someone pushed to your branch, CI is red, a PR needs your review).

### Documentation

Generate, scaffold, and maintain project documentation.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-init-docs`](docs/skills/stark-init-docs/usage.md) | Scaffold docs structure (ADRs, runbooks, etc.) | When starting a new project or adding docs to an existing one. Modes: template, backfill, upgrade, clean. |
| [`/stark-extract-docs`](docs/skills/stark-extract-docs/usage.md) | Extract knowledge from specs/reviews into ADRs, retros, glossary | After a spec is implemented. Captures decisions and learnings before they're forgotten. |
| [`/stark-generate-docs`](docs/skills/stark-generate-docs/usage.md) | Generate skill visualizations with multi-LLM competition | After modifying a SKILL.md. 3 LLMs compete, Claude judges screenshots, best wins. |
| [`/stark-claude-md-improver`](docs/skills/stark-claude-md-improver/usage.md) | Analyze and improve CLAUDE.md files | When CLAUDE.md feels stale or incomplete. Checks for missing conventions, outdated paths, etc. |

**Best practice:** Run `/stark-extract-docs` after every major feature or incident. The specs and review artifacts contain decisions and context that belong in permanent docs — ADRs, runbooks, glossary terms. If you wait, the context is lost.

### Project Management

Bootstrap, rename, and maintain projects.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-onboard-project`](docs/skills/stark-onboard-project/usage.md) | Bootstrap a new project: git, GitHub repo, apps, CLAUDE.md | When creating a new repo. Sets up everything in one shot. |
| [`/stark-rename-project`](docs/skills/stark-rename-project/usage.md) | Rename project locally + GitHub + sibling repo references | When a project needs renaming. Updates all cross-repo references. |
| [`/stark-update-deps`](docs/skills/stark-update-deps/usage.md) | Audit and update dependency versions | Monthly, or when you notice stale deps. Checks PyPI, npm, Docker Hub, etc. |

### Analytics

Understand how the system is performing.

| Skill | What it does | When to use |
|-------|-------------|-------------|
| [`/stark-metrics`](docs/skills/stark-metrics/usage.md) | Agent scorecards, finding quality, duration trends | After a batch of reviews. Shows which agents find real issues vs. noise. |
| [`/stark-skill-analytics`](docs/skills/stark-skill-analytics/usage.md) | Skill usage patterns and adoption metrics | Periodically. Shows which skills are used, quality trends, recommendations. |

**Best practice:** Check `/stark-metrics` after every phase execution or batch of reviews. If an agent's noise rate exceeds 20%, run `/stark-review-improvement` to tune its prompts.

---

## Typical Workflows

### Starting a new feature (full lifecycle)

```
/stark-session start                          # context + briefing
                                              # write spec.md
/stark-review-plan docs/specs/my-feature.md   # 3-LLM adversarial review
                                              # fix spec based on findings
/stark-plan-to-tasks docs/specs/my-feature.md # decompose into GitHub issues
/stark-phase-execute my-feature               # autonomous implementation
/stark-session end                            # cleanup + push
```

### Reviewing someone else's PR

```
/stark-review 42        # multi-agent review with fix loop
/stark-pr-status 42     # analytics: rounds, findings, signal quality
```

### Monthly maintenance

```
/stark-update-deps                  # check for outdated packages
/stark-metrics                      # review system performance
/stark-skill-analytics              # skill adoption trends
/stark-claude-md-improver           # keep CLAUDE.md current
/stark-generate-docs --check        # are skill docs stale?
```

### Onboarding a new repo

```
cd ~/git/Evinced/new-repo
/stark-onboard-project              # git init, GitHub repo, apps, CLAUDE.md
/stark-init-docs --template         # scaffold docs structure
```

---

## Architecture

The core engine dispatches 3 AI agents across N domain specializations:

```
3 agents × 6 domains = 18 parallel sub-agent reviews

├── claude × {architecture, accessibility, correctness, type-safety, security, test-coverage}
├── codex  × {same 6 domains}
└── gemini × {same 6 domains}
```

Each agent posts a consolidated review via its own GitHub App bot:
- **stark-claude** — architecture, accessibility, token integrity focus
- **stark-codex** — correctness, type safety, test coverage focus
- **stark-gemini** — security, error handling, consistency focus

## Repo Structure

```
stark-skills/
├── install.sh                    ← symlinks everything to install locations
├── skill/                        ← → ~/.claude/skills/
│   ├── stark-review/SKILL.md     ← one dir per skill (20 total)
│   ├── stark-session/SKILL.md
│   └── ...
├── scripts/                      ← → ~/.claude/code-review/scripts/
│   ├── multi_review.py           ← review orchestrator (ThreadPoolExecutor, 3×N)
│   ├── generate_skill_docs.py    ← documentation generator (3-LLM competition)
│   └── github_app.py             ← multi-app GitHub auth
├── global/                       ← → ~/.claude/code-review/
│   ├── config.json               ← global defaults
│   └── prompts/{claude,codex,gemini}/  ← per-agent × per-domain review prompts
├── org/evinced/                  ← → ~/git/Evinced/.code-review/
├── docs/
│   ├── skills/                   ← generated skill docs (HTML viz + Mermaid + PNGs)
│   ├── adr/                      ← architectural decision records
│   └── specs/                    ← design specs
└── standards/                    ← → ~/.claude/code-review/standards/
```

## Install Locations

The installer creates symlinks — files stay in this repo. `git pull` updates everything.

| Repo path | Installed at | Purpose |
|-----------|-------------|---------|
| `global/config.json` | `~/.claude/code-review/config.json` | Global defaults |
| `global/orchestrator.md` | `~/.claude/code-review/orchestrator.md` | Fix-review loop |
| `global/prompts/` | `~/.claude/code-review/prompts/` | Agent × domain prompts |
| `scripts/` | `~/.claude/code-review/scripts/` | Python scripts |
| `org/evinced/` | `~/git/Evinced/.code-review/` | Org config |

```bash
./install.sh              # install (symlink)
./install.sh --status     # check what's linked
./install.sh --uninstall  # remove symlinks
```

## Config Hierarchy

Same merge pattern as CLAUDE.md — most specific wins:

```
~/.claude/code-review/config.json          ← global (from this repo)
~/git/Evinced/.code-review/config.json     ← org override (from this repo)
~/git/Evinced/some-repo/.code-review/      ← repo override (in each repo)
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
mkdir -p ~/git/Evinced/some-repo/.code-review/domains
touch ~/git/Evinced/some-repo/.code-review/domains/07-db-migrations.md
```

Domains are auto-discovered at startup.

## Prerequisites

- macOS (keychain-based auth)
- `claude`, `codex`, `gemini` CLI tools in PATH
- Python 3.10+ with `PyJWT` and `requests`
- GitHub App private keys in macOS Keychain

Run `./install.sh` to check all dependencies.

## Skill Documentation

Every skill has auto-generated documentation with visual workflow diagrams:

- **[Skill Routing Guide](docs/skills/README.md)** — Mermaid decision trees: "which skill do I use?"
- **[Skill Index](docs/skills/index.md)** — Full list with links to usage and internals docs
- **Per-skill docs** — Each skill has `usage.md` (how to use) and `internals.md` (how it works), plus HTML visualizations and PNG screenshots

The docs are generated by [`/stark-generate-docs`](docs/skills/stark-generate-docs/usage.md) — 3 LLMs compete to produce HTML visualizations, Claude judges the screenshots, and the best one wins.

## Design Specs

- `docs/specs/2026-03-16-multi-agent-code-review-system-design.md` — code review engine design
- `docs/superpowers/specs/` — design specs for individual skills
