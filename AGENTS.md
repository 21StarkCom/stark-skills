# AGENTS.md — stark-skills

**This is the Codex / Cursor / non-Claude entry point.** Claude Code reads `CLAUDE.md`, not this file — so the two must never disagree. This one is a **routing index**, deliberately kept small; `CLAUDE.md` is the full reference — an order of magnitude longer — and is the source of truth on any conflict. Codex caps its combined instruction chain at 32 KiB, so do not grow this file toward that limit — add depth to `CLAUDE.md` and a pointer here.

## What This Is

The stark skills + tools fleet:

- **A two-stage development pipeline** — `/stark-author` (human-gated spec+plan) → `/stark-build` (check-gated implementation). No LLM-reviews-LLM loops, per the 2026-07-25 autopsy.
- **A single-agent PR code reviewer** — `/stark-review`, evidence-contract prompts, 5 triage-selected domains.
- **Multi-agent IaC review** — `/stark-terraform-review`, `/stark-terragrunt-review`.
- **The ops/session tier** — session, handover, release, persona, GitHub identity swap.

Claude, Codex and Gemini are all enabled (Gemini → `gemini-3.1-pro-preview`, default auth `oauth`). Vertex project/location resolve at runtime via `tools/vertex_config_lib.ts` — **never hardcoded or committed**. Hierarchical config: global → org → repo.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **Branch + PR for everything — no exceptions.** Every change lands on a branch and merges through a PR. **Never commit or push to `main` directly.** "Ship straight to main" means *merge once the PR is green* — it does **not** mean bypass the PR. (This file said "Ship straight to main" with no branch+PR rule until 2026-08-07. That was wrong, and it was wrong only for you — Claude read the correct rule the whole time.)
- **No rollout ceremony.** Skip soaking, gating, smoking, canary and gradual-rollout patterns. Merge once green.
- **Every review's findings get posted on the PR.** Inline where anchored, summary comment otherwise. This repo *is* the review system — `stark_review.ts` already does the posting. Don't drop, downgrade or summarize findings away, and don't merge with open findings unaddressed: fix them, or reply on the thread saying why not.
- **Draft PRs by default.** Every PR-opening path opens a **draft**, so WIP stays out of draft-guarded CI. Test locally, then un-draft to merge. Opt out per-run with `--ready` (alias `--no-draft`). You cannot merge a draft, so the merge paths run `gh pr ready` first — which fires target CI via `ready_for_review` — then wait for green, then squash-merge. Target repos need the skip-draft guard for "no CI on WIP" to hold: `standards/workflows/skip-draft-guard.md`.
  - **But never guard a workflow whose check is REQUIRED** (STARK-357). A guarded job reports `skipped`, GitHub counts that as satisfying the required check, and it looks identical to a pass — so the guard turns "CI did not run" into "CI is green". PR #877 merged that way; the suite never ran against what landed. Nothing repairs it after the fact: a re-run replays the original payload and skips again, and a `workflow_dispatch` run never joins the PR's status rollup. `.github/workflows/tests.yml` is deliberately unguarded and runs the `tools/` suite. The merge paths (`idun gh pr-merge`) refuse a skipped required check, naming it; `--allow-skipped-checks` opts back in for path-filtered checks that skip by design.
  - **`main`'s required checks live in a RULESET, and `branches/main/protection` lies about it** (STARK-5008). That endpoint returns `404 Branch not protected` on a repo that IS gated, because it does not report rulesets — audit with `gh api repos/O/R/rulesets`, or `repos/O/R/rules/branches/main` for what the ref actually enforces. Here: ruleset **20607400**, `active`, four contexts — `Analyze (go)`, `Analyze (javascript-typescript)`, `test`, `typecheck`. A `PUT` replaces the rule's parameters wholesale, so read → append → write back; overwriting drops a gate while looking like it added one.
  - **And never require a check whose step carries `continue-on-error: true`** — it reports SUCCESS regardless of the step, so requiring it satisfies the gate unconditionally. `typecheck` was stuck in that loop until STARK-5008 (left out of the ruleset for being advisory, advisory because of the flag) while `node --test` could never catch a type error anyway — Node strips types instead of checking them. Flag dropped, then context required. `tools/typecheck_gate.test.ts` pins the job set plus the absence of `continue-on-error`, of any `if:` (job **or** step — a guarded step leaves the job green with nothing run), of a job-level `name:` (renames the check-run so the required context never reports), and of a trigger/path narrowing; so a third job in `tests.yml` fails the suite until its check is decided. The step runs `npm run typecheck`, not `npx tsc` — headless `npx` downloads a missing package instead of failing.
- **Every PR action uses `gh` as `aryeh-stark`.** This includes review posting and release operations. Review text identifies the model; authentication never changes with model choice. Both the canonical and Codex-mirror dispatch libraries strip ambient credentials from Gemini environments while keeping the process-variable floor (`USER` included); reviewer subprocesses also exclude database connection strings. Review Apps are retired. CI alone uses the separate `stark-meridian-ci` App in `marketplace-sync.yml`.
  - **`idun user` is the other exception, and it is human-invoked only** (moved out of stark-skills in STARK-2215). It moves `gh` to a relief account when `aryeh-stark`'s rate bucket runs dry — `export GH_TOKEN=$(idun user --swap)`. **No tool, skill or hook may invoke it** — it exports `GH_TOKEN`, which overrides `gh`'s keyring for every later call in that shell, so an automated swap silently re-authors whatever runs next.
- **Language: Go for backend, TypeScript for scripts.** **No new Python.** The repo's tooling is TypeScript-only under `tools/`; the former Python orchestrators and dispatch infra under `scripts/` were migrated out and deleted. If you find a `scripts/*.py` path named in any doc, it is stale — delete the reference, don't recreate the file.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Update docs in the same change.** Any change to behavior, structure, commands, env vars or operations updates the relevant docs — **this file and `CLAUDE.md` both**.
- **GCP worktree scope stays local and narrow.** `tools/gcp_scope.ts install` owns each mapped repo's generated `.envrc` block and the exact `.envrc` row in `.worktreeinclude`; `check` validates both. Preserve other include rows/comments and never add credentials or broad globs. Codex-managed worktrees consume the file; plain Git-worktree helpers must copy the explicitly named safe files themselves.

## Repo Layout

- `tools/` — **all** TypeScript tooling: dispatchers, agent utilities, session/state, GitHub transport, skill meta-tooling. The only executable surface.
- `skill/` — all skills (`skill/*/SKILL.md`, **26** skills: 24 `stark-*` plus `gru`, `minion`), packaged as marketplace plugins
- `global/` — global config + prompts, vendored into each plugin
- `scripts/` — shell helpers + JSON only (`healer_patterns.json`). **No Python lives here any more.**
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
| `/stark-author <intent>` | Stage 1 — spec + plan in one session; the operator decides. Agent does all technical QA and asks only operator-oracle questions, then ends with a dead-simple three-layer intent read-back + plain-language sign-off. Emits `docs/specs/YYYY-MM-DD-<slug>-spec.md` + a `.human.md` operator digest, pins an `accepted-base`, opens a draft spec PR. |
| `/stark-build <spec-path>` | Stage 2 — autonomous implementation from an accepted spec. One fresh headless session per task, gated by hooks the agent cannot edit. Abort is a first-class success. |
| `/stark-review [PR]` | Single-agent PR review, triage-selected domains, auto-detected test command. |
| `/stark-terraform-review` · `/stark-terragrunt-review` | Multi-agent IaC review over `.tf` / `.hcl`. |
| `/stark-review-improvement` | Improve prompts from review assessment. |

**Workflow & ops**

| Skill | What it does |
|---|---|
| `idun gh pr-open` · `pr-merge` · `cleanup` · `watch` | The PR lifecycle — **moved to idun** (STARK-2211). Open draft → un-draft + squash-merge on green → sweep branches/worktrees. Not a stark-skills skill any more. |
| `/stark-session [start\|end]` | Briefing on start, cleanup on end. |
| `/stark-handover [save\|resume\|status]` | Cross-`/clear` continuity under `~/Code/Handovers/`. |
| `/gru start\|status\|resume\|stop` | **Gru**, the active Minion leader. Explicit concurrency/recovery limits, durable ownership, Hermod transport, Alfred tickets, verified integration. Codex uses `$gru` from its native override. |
| `/minion` | Gru's worker intake, reporting, and integration contract. Separate Claude and Codex variants. |
| `/stark-bury <corpse>` | Retire code into the Náströnd graveyard — a subsystem of a living repo, or a whole repo. Footprint verification, interment PR **before** any deletion, deletion PR, optional sealed dump + table drop. The fleet's only destructive ritual: five non-negotiable laws, operator-gated at every prod mutation. The Codex override is model-discoverable; Claude and Codex variants share the same mutation gates. |
| `/stark-fresh-eyes <doc>` | One-shot zero-context review of a doc before it ships. One dispatch per revision, never a round 2. |
| `/stark-memory [--project <slug>\|--all] [--dry-run] [--apply]` | Keep Claude auto-memory under the load/recall caps: `memory_tidy.ts` measures each `MEMORY.md` + topic file (200 lines/25KB index, 200 lines/4KB per file) and flags cross-repo facts; Claude shortens index lines, splits over-cap files, moves foreign-repo facts to their own memory dir. **Dry-run is the default; `--apply` writes.** |
| `/stark-release [patch\|minor\|major]` | Changelog, tag, GitHub Release. |
| `/stark-persona` | Session character voices. |
| `/stark-refactor-plan [dir]` | Planning-only refactor analysis. Never modifies source. |
| `idun user` | Human-only GitHub identity swap — **moved to idun** (STARK-2215). `export GH_TOKEN=$(idun user --swap)`; `idun user gh seed\|remove\|status`. Not a stark-skills skill any more. |
| `/stark-init-docs` | Scaffold dev docs. |

Gru preserves session worktrees and ownership after completion. Native worker observations use that worker's provider view; unavailable providers retain their own uncertainty. Opaque identities and leadership transfers still require complete discovery. Lifecycle changes require fresh Hermod observations. Unknown startups remain reserved; replacement retains pending merge locks and bases; termination requires matching session, surface, and PID evidence with `alive=false`. A retained merge settles only until the replacement attaches, or after cancellation froze an in-flight integration — never during an uncertain reconnect, intake, or implementation, and cancelling a working replacement keeps it resumable rather than verifiable. Verified workers release slots when freshly observed idle, dead, or confirmed retired. Verification uses invocation-owned `refs/gru/verification/<uuid>/*` without writing `FETCH_HEAD`, runs declared checks in order (each bounded by `checkTimeoutMs`, default 30 minutes), and removes only its disposable checkout. Cleanup errors remain visible without replacing a failed check. Late workers can attach during cancellation. Native Codex startup and complete briefing have been exercised with Hermod v0.17.0 (STARK-4911). Dependency release was demonstrated live on 2026-09-16: a dependent task stayed refused after its prerequisites merged and released only on Gru's own verification events. Full acceptance remains incomplete — bounded recovery is unproven, and native Codex leadership is still unevaluated because that run used a Claude leader. `receive` requires Hermod-confirmed delivery, so a Claude leader acks each inbound report first; `resume --limits-file` replaces operating limits that a leadership transfer left stale. Codex sessions yield while awaiting queued reports. Review fixes receive final-diff validation without automatic review loops.

**Claude Code account rotation is not a skill here — run `idun cc`** (the `/stark-cc-user` wrapper was retired in STARK-1697; the engine went native in STARK-1614, idun ADR 0010). One piece stays in this repo and must not be mistaken for dead code: `config/statusline-command.sh` is the **only** writer of `~/.claude/.cc-usage-<account>_<org>`, since the 5h/7d percentages arrive only in the statusline stdin payload — `idun cc limits` / `next --best` have no other source of headroom for an inactive seat. Cross-language wire contract with `idun/src/cc/cc_lib.ts`; see the comment block above the writer, and `CLAUDE.md`. The 5H/7D **render** is a usage bar per window (STARK-2807), filled by the idun daemon's live poll of the current seat and falling back to the payload reading when the daemon has no fresh entry. The payload windows are frozen to the launch seat, so after a mid-session rotation they belong to the rotated-away seat; rather than gate them (the retired `resolve_startseat`/`usage_windows_stale`/`.statusline-procseat-<sid>` machinery — STARK-2652, now deleted), the render reads the idun daemon's live poll of the current seat from `~/.claude/.idun-daemon-state.json` (same `accountUuid:organizationUuid` seat key) and uses it as each bar's value, falling back to the frozen payload only when the daemon has no fresh entry — the live number without a restart. The daemon read is fork-free; its `== *"<seat>": {*` presence guard is load-bearing (a missing seat would leak a different seat's percentages, and one account can hold seats in two orgs). The bar renders dim-empty with `—` only when neither source has a value (a daemon value < 0 is treated as absent). Separate from the snapshot-write's `.statusline-seat-current` marker guard. STARK-2206 once had the writer block also fire `idun daemon send --from-file` to feed the `idun daemon` quota watcher; **STARK-2807 removed that push** (idun >= 0.26.0 dropped the socket + `send` verb — the daemon now polls the usage endpoint itself for the active seat's real figures). The snapshot WRITE stays (it is still the daemon's boot seed and `idun cc limits`' only source); do not re-add a `daemon send`.

**Every skill honors `--help`** — a standalone `--help` / `-h` / `help` token prints purpose + usage + arguments and stops, with no preflight and no phases. Guarded by `skill_smoke_test.test.ts`.

## Distribution

PR landing retains `--lead` as a compatibility argument, echoed in dry-run output only when supplied, and requires `--body` like every other documented-required flag. Authentication patterns return `skipped` with `operator_action_required` in auto mode, before guard commands, verification, budgets, or circuit accounting; in suggest mode they return `suggested` like any other pattern, so canary promotion history is real — while `healer_canary` refuses to promote that action, since auto mode would only ever refuse it. Both runtimes carry the same gate. Read-only GraphQL operations may retry once; uncertain mutations never retry.

Skills + tools ship as separate self-contained **Claude Code** and native **Codex** plugin packages via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace.

```
# Codex
codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-plan@bifrost
# Start a new thread, then invoke: $stark-author --help

# Claude Code
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-ops, ...
/plugin update  stark-analyze@bifrost
```

Canonical `skill/` and shared assets are the Claude-authored source. Host-specific Codex behavior belongs **only** under `runtime-overrides/codex/`. `.github/workflows/marketplace-sync.yml` prepares versioned release notes and opens a draft Bifrost sync PR. It waits up to 20 minutes for `aryeh-stark`'s completed review attestation on the exact head, then runs the ready/CI/merge chain. CI alone never authorizes publication. See the [review attestation contract](skill/gru/references/operations.md#verification-and-integration). Every changed runtime advances Bifrost's root release version, including Claude-only changes.

**Local dev is not live.** Editing a file here does nothing until it is published (merge to `main` → `marketplace-sync` PR → merge) and the plugin is updated. To test an in-progress edit against a real install, run `stark sync` in the marketplace repo, then `/plugin update` locally.

## Conventions

Gru's explicit `takeover --file` repairs orphaned worker ownership only with a
direct operator instruction and complete fresh Hermod absence checks. It fences
old tokens, preserves budgets, PR evidence and worktrees, and never calls an
unknown worker dead. See [the takeover contract](skill/gru/references/operations.md#operator-takeover-when-runtime-records-are-gone).

- **Docs live with the code** under `docs/`, folder per type — `adr/` (`NNNN-<topic>.md`, immutable: supersede, don't edit), `specs/` (`YYYY-MM-DD-<topic>-spec.md`), `retros/` (`YYYY-MM-DD-<topic>-retro.md`). **That is what `/stark-init-docs` scaffolds into a target repo, guarded by `tools/doc_convention.test.ts` — it is not a layout this repo keeps.** stark-skills carries no `docs/` tree; each skill is documented by its own `SKILL.md` and its `--help`.
- **There is never a `docs/plans/`.** Since `/stark-author` (2026-08-01) the spec carries the plan — task DAG, done-whens, closing verification command.
- Tier by blast radius: trivial → PR only · feature → spec · architectural → ADR + spec.
- Prompts are per-agent, one version of each domain per LLM. Domain IDs are slugs from filenames (`01-architecture.md` → `architecture`). Config is JSON, prompts are markdown. Agent preambles in `agent.md`, domain prompts in `NN-domain.md`.

## GitHub authentication

Local tools use the operator's existing `gh` login as `aryeh-stark`.
Reviews use `COMMENT` events and identify models in their text.
No review App keys, token minting, or Keychain checks are required.
The separate `stark-meridian-ci` App serves GitHub Actions only.

## Where to go deeper

`CLAUDE.md` in this directory. It carries the per-tool reference (every `tools/*.ts`, what it replaced, its gotchas), the full skill documentation with failure modes, the prompt architecture, and the auth SSOTs. When this file and `CLAUDE.md` disagree, **`CLAUDE.md` wins** — and the disagreement is a bug: fix it in the same PR.
