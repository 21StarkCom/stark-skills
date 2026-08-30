# AGENTS.md — stark-skills

**This is the Codex / Cursor / non-Claude entry point.** Claude Code reads `CLAUDE.md`, not this file — so the two must never disagree. This one is a **routing index**, deliberately kept small; `CLAUDE.md` is the full reference — an order of magnitude longer — and is the source of truth on any conflict. Codex caps its combined instruction chain at 32 KiB, so do not grow this file toward that limit — add depth to `CLAUDE.md` and a pointer here.

## What This Is

The stark skills + tools fleet:

- **A two-stage development pipeline** — `/stark-author` (human-gated spec+plan) → `/stark-build` (check-gated implementation). No LLM-reviews-LLM loops, per the 2026-07-25 autopsy.
- **A single-agent PR code reviewer** — `/stark-review`, evidence-contract prompts, 5 triage-selected domains.
- **Multi-agent IaC review** — `/stark-terraform-review`, `/stark-terragrunt-review`.
- **The ops/session tier** — session, handover, housekeeping, release, persona, GitHub identity swap.

Claude, Codex and Gemini are all enabled (Gemini → `gemini-3.1-pro-preview`, default auth `oauth`). Vertex project/location resolve at runtime via `tools/vertex_config_lib.ts` — **never hardcoded or committed**. Hierarchical config: global → org → repo.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **Branch + PR for everything — no exceptions.** Every change lands on a branch and merges through a PR. **Never commit or push to `main` directly.** "Ship straight to main" means *merge once the PR is green* — it does **not** mean bypass the PR. (This file said "Ship straight to main" with no branch+PR rule until 2026-08-07. That was wrong, and it was wrong only for you — Claude read the correct rule the whole time.)
- **No rollout ceremony.** Skip soaking, gating, smoking, canary and gradual-rollout patterns. Merge once green.
- **Every review's findings get posted on the PR.** Inline where anchored, summary comment otherwise. This repo *is* the review system — `stark_review.ts` already does the posting. Don't drop, downgrade or summarize findings away, and don't merge with open findings unaddressed: fix them, or reply on the thread saying why not.
- **Draft PRs by default.** Every PR-opening path opens a **draft**, so WIP stays out of draft-guarded CI. Test locally, then un-draft to merge. Opt out per-run with `--ready` (alias `--no-draft`). You cannot merge a draft, so the merge paths run `gh pr ready` first — which fires target CI via `ready_for_review` — then wait for green, then squash-merge. Target repos need the skip-draft guard for "no CI on WIP" to hold: `standards/workflows/skip-draft-guard.md`.
  - **But never guard a workflow whose check is REQUIRED** (STARK-357). A guarded job reports `skipped`, GitHub counts that as satisfying the required check, and it looks identical to a pass — so the guard turns "CI did not run" into "CI is green". PR #877 merged that way; the suite never ran against what landed. Nothing repairs it after the fact: a re-run replays the original payload and skips again, and a `workflow_dispatch` run never joins the PR's status rollup. `.github/workflows/tests.yml` is deliberately unguarded and runs both suites (`tools/` and `plugins/stark-gh/`, the latter never covered by CI before). The merge paths refuse a skipped required check, naming it; `--allow-skipped-checks` opts back in for path-filtered checks that skip by design.
- **Every PR action is `aryeh-stark`; bots only post reviews.** Opening a PR, commenting, resolving a thread, un-drafting, merging, opening an issue — all go through `gh`, logged in as `aryeh-stark`. The `stark-{claude,codex,gemini}` **21S** Apps exist for exactly one reason: posting multi-LLM review findings, where three distinct bot authors make "which model said this" readable. `tools/github_app{,_lib}.ts` therefore exposes reads plus `pr review` / `pr comment` and **nothing that authors** — `pr create`, `pr ready`, `pr merge` and `issue create` were removed 2026-08-04 and exit `2` naming the `gh` command to run. **Never re-add a bot PR-create path.**
  - **CI is the one exception** — a workflow has no human token, so `marketplace-sync.yml` mints an app token and uses it to open the bifrost sync PR **and merge it once bifrost's CI is green** (#852). GitHub Actions only; never anything running on this Mac.
  - **`/stark-gh-user` is the other exception, and it is human-invoked only.** It moves `gh` to a relief account when `aryeh-stark`'s rate bucket runs dry. `disable-model-invocation: true`, and **no tool, skill or hook may call `tools/user_token.ts`** — it exports `GH_TOKEN`, which overrides `gh`'s keyring for every later call in that shell, so an automated swap silently re-authors whatever runs next.
- **Language: Go for backend, TypeScript for scripts.** **No new Python.** The repo's tooling is TypeScript-only under `tools/`; the former Python orchestrators and dispatch infra under `scripts/` were migrated out and deleted. If you find a `scripts/*.py` path named in any doc, it is stale — delete the reference, don't recreate the file.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Update docs in the same change.** Any change to behavior, structure, commands, env vars or operations updates the relevant docs — **this file and `CLAUDE.md` both**.
- **GCP worktree scope stays local and narrow.** `tools/gcp_scope.ts install` owns each mapped repo's generated `.envrc` block and the exact `.envrc` row in `.worktreeinclude`; `check` validates both. Preserve other include rows/comments and never add credentials or broad globs. Codex-managed worktrees consume the file; plain Git-worktree helpers must copy the explicitly named safe files themselves.

## Repo Layout

- `tools/` — **all** TypeScript tooling: dispatchers, agent utilities, session/state, GitHub App auth, skill meta-tooling. The only executable surface.
- `skill/` — all skills (`skill/*/SKILL.md`, **30** skills: 27 `stark-*` plus `simple-gate`, `team-leader-agent`, `team-minion-agent`), packaged as marketplace plugins
- `global/` — global config + prompts, vendored into each plugin
- `scripts/` — shell helpers + JSON only (`healer_patterns.json`). **No Python lives here any more.**
- `plugins/stark-gh/` — local plugin source, packaged by the marketplace
- `runtime-overrides/codex/` — **your tree.** Complete Codex-only skill/command variants plus changed support files; mirrors source-relative paths. Bifrost imports it as runtime overrides into a separate `dist/codex-plugins/` surface. **Never** make a canonical Claude file "portable" to satisfy Codex, and **never** layer a Codex override into `dist/claude/`.
- `org/evinced/` — Evinced org config overrides
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `standards/` — org-wide doc templates and workflows
- `docs/` — specs, ADRs, retrospectives, generated skill docs
- `.github/workflows/` — tests, project sync, stale detection, `marketplace-sync`

## Skills

All skills live in `skill/*/SKILL.md`. Full per-skill detail — arguments, failure modes, the reasons behind each guard — is in `CLAUDE.md § Skills`. This is the index.

**Pipeline (in order)**

| Skill | What it does |
|---|---|
| `/stark-author <intent>` | Stage 1 — human-gated spec + plan in one session. Emits `docs/specs/YYYY-MM-DD-<slug>-spec.md` + a `.human.md` operator digest, pins an `accepted-base`, opens a draft spec PR. |
| `/stark-build <spec-path>` | Stage 2 — autonomous implementation from an accepted spec. One fresh headless session per task, gated by hooks the agent cannot edit. Abort is a first-class success. |
| `/stark-copilot <plan\|prompt>` | Paired lead/wing implementation with a task DAG, wave parallelism, one fix round. |
| `/stark-review [PR]` | Single-agent PR review, triage-selected domains, auto-detected test command. |
| `/stark-terraform-review` · `/stark-terragrunt-review` | Multi-agent IaC review over `.tf` / `.hcl`. |
| `/stark-review-improvement` | Improve prompts from review assessment. |

**Workflow & ops**

| Skill | What it does |
|---|---|
| `/stark-gh:pr-open` · `pr-merge` · `cleanup` | The PR lifecycle. Open draft → un-draft + squash-merge on green → sweep branches/worktrees. |
| `/simple-gate [spec-path]` | Walk the human sign-off gate in short, jargon-free language; Codex uses structured choices when available and a one-question conversational fallback otherwise. |
| `/stark-session [start\|end]` | Briefing on start, cleanup on end. |
| `/stark-handover [save\|resume\|status]` | Cross-`/clear` continuity under `~/Code/Handovers/`. |
| `/stark-bury <corpse>` | Retire code into the Náströnd graveyard — a subsystem of a living repo, or a whole repo. Footprint verification, interment PR **before** any deletion, deletion PR, optional sealed dump + table drop. The fleet's only destructive ritual: five non-negotiable laws, operator-gated at every prod mutation. The Codex override is model-discoverable; Claude and Codex variants share the same mutation gates. |
| `/stark-fresh-eyes <doc>` | One-shot zero-context review of a doc before it ships. One dispatch per revision, never a round 2. |
| `/stark-ssot [area]` | Give a duplicated value/rule one owner; route the copies through it. |
| `/stark-housekeeping` | Stale issues, dead branches, worktree remnants, asset-symlink self-heal. |
| `/stark-release [patch\|minor\|major]` | Changelog, tag, GitHub Release. |
| `/stark-persona` | Session character voices. |
| `/stark-refactor-plan [dir]` | Planning-only refactor analysis. Never modifies source. |
| `/stark-gh-user` | Human-only GitHub identity swap. See the rule above. |
| `/stark-init-docs` | Scaffold dev docs. |

**Claude Code account rotation is not a skill here — run `idun cc`** (the `/stark-cc-user` wrapper was retired in STARK-1697; the engine went native in STARK-1614, idun ADR 0010). One piece stays in this repo and must not be mistaken for dead code: `config/statusline-command.sh` is the **only** writer of `~/.claude/.cc-usage-<account>_<org>`, since the 5h/7d percentages arrive only in the statusline stdin payload — `idun cc limits` / `next --best` have no other source of headroom for an inactive seat. Cross-language wire contract with `idun/src/cc/cc_lib.ts`; see the comment block above the writer, and `CLAUDE.md`.

**Every skill honors `--help`** — a standalone `--help` / `-h` / `help` token prints purpose + usage + arguments and stops, with no preflight and no phases. Guarded by `skill_smoke_test.test.ts`.

## Distribution

Skills + tools ship as separate self-contained **Claude Code** and native **Codex** plugin packages via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace.

```
# Codex
codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-gh@bifrost
# Start a new thread, then invoke: $cleanup --dry-run

# Claude Code
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-gh, stark-ops, ...
/plugin update  stark-analyze@bifrost
```

Canonical `skill/`, `plugins/stark-gh/commands/` and shared assets are the Claude-authored source. Host-specific Codex behavior belongs **only** under `runtime-overrides/codex/`. `.github/workflows/marketplace-sync.yml` auto-publishes changes to either source surface.

**Local dev is not live.** Editing a file here does nothing until it is published (merge to `main` → `marketplace-sync` PR → merge) and the plugin is updated. To test an in-progress edit against a real install, run `stark sync` in the marketplace repo, then `/plugin update` locally.

## Conventions

- **Docs live with the code** under `docs/`, folder per type — `adr/` (`NNNN-<topic>.md`, immutable: supersede, don't edit), `specs/` (`YYYY-MM-DD-<topic>-spec.md`), `retros/` (`YYYY-MM-DD-<topic>-retro.md`). **That is what `/stark-init-docs` scaffolds into a target repo, guarded by `tools/doc_convention.test.ts` — it is not a layout this repo keeps.** stark-skills carries no `docs/` tree; each skill is documented by its own `SKILL.md` and its `--help`.
- **There is never a `docs/plans/`.** Since `/stark-author` (2026-08-01) the spec carries the plan — task DAG, done-whens, closing verification command.
- Tier by blast radius: trivial → PR only · feature → spec · architectural → ADR + spec.
- Prompts are per-agent, one version of each domain per LLM. Domain IDs are slugs from filenames (`01-architecture.md` → `architecture`). Config is JSON, prompts are markdown. Agent preambles in `agent.md`, domain prompts in `NN-domain.md`.

## GitHub Apps

Source of truth is the `APPS` map in `tools/github_app_lib.ts`. All three are the **21S** apps on org `21-Stark-AI`, each also installed on `GetEvinced`. The old `GetEvinced`-era apps (app IDs `30667xx`, pre-`_21S` keychain entries) are **retired** — minting against them 404s.

**They do NOT act as `aryeh-stark`.** An installation token authors as the bot (`app/stark-claude[bot]`). Their only sanctioned use is posting review findings.

| App (display name) | App ID | Install (21-Stark-AI) | Install (GetEvinced) | Keychain |
|---|---|---|---|---|
| stark-claude (Stark Claude 21S) | 4094779 | 141330560 | 141330785 | `STARK_CLAUDE_PRIVATE_KEY_21S` |
| stark-codex (Stark Codex 21S) | 4094776 | 141330526 | 141330738 | `STARK_CODEX_PRIVATE_KEY_21S` |
| stark-gemini (Stark Gemini 21S) | 4094781 | 141330618 | 141330831 | `STARK_GEMINI_PRIVATE_KEY_21S` |

The Keychain stores **base64-of-PEM** (`github_app_lib` decodes it). For CI secrets, set the **decoded** PEM:

```
security find-generic-password -s STARK_CLAUDE_PRIVATE_KEY_21S -w | base64 -D | gh secret set STARK_CLAUDE_PRIVATE_KEY --repo 21-Stark-AI/stark-skills
```

## Where to go deeper

`CLAUDE.md` in this directory. It carries the per-tool reference (every `tools/*.ts`, what it replaced, its gotchas), the full skill documentation with failure modes, the prompt architecture, and the auth SSOTs. When this file and `CLAUDE.md` disagree, **`CLAUDE.md` wins** — and the disagreement is a bug: fix it in the same PR.
