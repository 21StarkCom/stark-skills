# stark-skills

> **Superseded by [`21StarkCom/bifrost`](https://github.com/21StarkCom/bifrost).**
> The skill source tree (`skill/ tools/ standards/ global/ scripts/ data/ config/
> runtime-overrides/`) now lives in bifrost, which is the single repo to edit.
> The marketplace generation pipeline this repo used to drive — `marketplace-sync.yml`
> and the bifrost coverage gate — has been removed, so nothing here publishes any more.
> This repo is kept for history only.

AI-powered development workflow system for Claude Code and Codex, covering the full development lifecycle — from planning through code review, shipping, and maintenance. Optional Gemini support is available through config.

## Quick Start

```bash
# Install the plugins from the marketplace (in Claude Code)
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-ops, ...

# Or install the same bundles in Codex
codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-plan@bifrost
# Start a new Codex thread, then invoke: $stark-author --help

# Start a work session (context loading, health checks, briefing)
/stark-session start

# Review a PR, then publish the findings on it as one anchored review
/code-review xhigh --fix
node tools/findings_review_post.ts --repo ORG/REPO --pr 42 --findings findings.json

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

Review artifacts before they ship.

| Skill | What it reviews | When to use |
|-------|----------------|-------------|
| [`/stark-fresh-eyes`](skill/stark-fresh-eyes/SKILL.md) | A prompt, brief, spec or doc | Before it ships. ONE zero-context subagent re-verifies every checkable claim by a *different* method than the doc's own, and reports defects only. |
| [`/stark-terraform-review`](skill/stark-terraform-review/SKILL.md) | Terraform / OpenTofu HCL | Multi-agent, cross-validated, with host scanners (`fmt`, `validate`, `tflint`, `trivy`, `checkov`) as evidence. |
| [`/stark-terragrunt-review`](skill/stark-terragrunt-review/SKILL.md) | Terragrunt orchestration | include/dependency/generate/remote_state, mock-output schema, DAG cycles, state isolation. |

**PR code review is `/code-review xhigh --fix`** — Claude Code's built-in reviewer, which every change passes before merge. To publish its findings on the PR as ONE anchored review (instead of N zero-body ones), pipe the `ReportFindings` payload through `tools/findings_review_post.ts`.

**Best practice:** Gate the spec at `/stark-author`'s human checklist *before* implementation starts — it's cheaper to fix a spec than to fix code.

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
/code-review xhigh --fix            # the review itself
node tools/findings_review_post.ts --repo ORG/REPO --pr 42 --findings -
```

---

## Architecture

Skills are thin protocol wrappers over TypeScript dispatchers in `tools/`. A
dispatcher resolves the enabled agents from config, spawns each as its own
headless subprocess with a credential-scrubbed env, parses the structured
output, and merges the results:

```
/stark-terraform-review ─┐
/stark-terragrunt-review ─┼─→ iac_review.ts   ─→ codex, gemini (parallel, read-only)
/stark-refactor-plan ─────┴─→ refactor_planner.ts ─→ 10 focused subagents
/stark-jury ──────────────→ jury_dispatch.ts  ─→ claude, codex, gemini panel
```

PR findings — from `/code-review` or any of the above — reach GitHub through
`findings_review_post.ts` → `review_post_lib.ts::postReview`: ONE anchored
`COMMENT` review, inline where the anchor falls inside a diff hunk and in the
body otherwise, with a no-drop fallback so a rejected anchor never costs a
finding.

Everything posts through the operator's existing `gh` login as `aryeh-stark`.
Each review identifies its models in the text.

## Repo Structure

```
stark-skills/
├── skill/                        ← one dir per skill (stark-*/SKILL.md)
│   ├── stark-author/SKILL.md
│   ├── stark-persona/SKILL.md
│   └── ...
├── scripts/                      ← shell helpers + JSON (healer_patterns.json)
│   └── *.{sh,json}
├── tools/                        ← TypeScript dispatch infra, agent CLIs, meta-tooling
│   ├── findings_review_post.ts   ← publish findings on a PR as one anchored review
│   ├── review_post_lib.ts        ← the REST gh transport + postReview
│   ├── iac_review.ts             ← multi-agent Terraform/Terragrunt reviewer
│   └── ...
├── global/                       ← config + prompts vendored into each plugin
│   ├── config.json               ← global defaults
│   └── prompts/{iac-review,refactor-planner}/  ← per-dispatcher rubrics
├── runtime-overrides/codex/      ← Codex-only artifact + support overlays; never shipped to Claude
├── data/persona/                 ← persona roster
├── .github/workflows/            ← GitHub Actions (tests, project sync, marketplace-sync)
└── standards/                    ← org-wide doc templates and workflows
```

## Distribution

This repo is the **source of truth** for the skills + tools; they ship as separate self-contained Claude Code and native Codex plugin packages via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace.

- Canonical `skill/` and shared support files remain the Claude-authored surface. `runtime-overrides/codex/` contains complete Codex-only variants and their changed support files. Bifrost keeps those inputs and generated packages isolated; a Codex overlay must never enter `dist/claude/`.
- The marketplace `catalog/` is **generated from this repo** by `stark sync`. Bifrost emits Claude packages under `dist/claude/`, native Codex packages under `dist/codex-plugins/`, and host-specific marketplace manifests at the repository root.
- CI auto-publishes on every push to `main` touching a canonical vendored asset root or `runtime-overrides/codex/`.

```
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # then stark-plan, stark-implement, stark-ops, ...
/plugin update  stark-analyze@bifrost   # pull the latest published version

codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-plan@bifrost
# Open a new thread after install/update; invoke with: $stark-author --help
```

Immutable assets (tools/prompts/config) resolve from the installed plugin root (`${CLAUDE_PLUGIN_ROOT}`) via `tools/asset_root_lib.ts`; mutable state (`history/`, `sessions/`, `locks/`, …) lives under `~/.claude/code-review/` (`stateRoot()`).

## Config Hierarchy

Same merge pattern as CLAUDE.md — most specific wins:

```
~/.claude/code-review/config.json   ← global (from this repo)
~/Code/.code-review/config.json     ← org override
~/Code/some-repo/.code-review/config.json   ← repo override
```

Repos can override the enabled agents and the per-dispatcher sections
(`iac_review`, `runtime`, `models`, …). The per-agent prompt and per-domain
override layers are gone: they belonged to `/stark-review`, which was buried in
STARK-6098. Dispatcher rubrics now live once under
`global/prompts/<dispatcher>/` and are shared by every agent that runs them.

## Prerequisites

- macOS
- `claude`, `codex`, `gemini` CLI tools in PATH
- Node.js ≥ 24 (TypeScript and SQLite tooling runs via plain `node`)
- GitHub CLI authenticated as `aryeh-stark`

## Skill Documentation

Each skill documents itself: `skill/<name>/SKILL.md` is the source of truth, and
every skill answers `--help`. There is no generated documentation layer — the
previous one drifted two generations out of date and its generator was deleted,
so it described a pipeline that no longer existed. Read the skill, or run it
with `--help`.
