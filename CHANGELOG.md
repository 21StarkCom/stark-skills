# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
<!-- stark-gh:pr-merge pr=860 runId=ac491710-188f-48a4-b15b-fdb8c114c42c -->
- Add a retrospective on the lost squash-commit ticket prefix, including failure analysis, validation lessons, and follow-up safeguards.
- **`/stark-bury`** — the burial ritual for retiring 21Stark code into the Náströnd graveyard (STARK-300/STARK-307, PRs #866/#867/#868): partial burial of a subsystem or full retirement of a repo, via footprint verification → interment PR → deletion PR → optional sealed dump and table drop, under five non-negotiable laws (bury before delete, the dead stay dead, the living repo stays green, destructive steps operator-gated with a sealed dump before any drop, never commit a raw bundle / unencrypted dump / age identity). `disable-model-invocation: true` and Claude-only — no Codex variant. Now documented in `CLAUDE.md` and `AGENTS.md`, which it had never reached.
- **`/stark-handoff`** — prompt-file handoffs for fresh executors (STARK-197, PR #857): four verbs (`write`/`list`/`use`/`launch`), five types over three skeletons (execution / investigation / inquiry) with the shared six-element spine and the 9-check rubric as `references/` templates; storage root `STARK_HANDOFF_ROOT` env > `handoff.root` config > `~/Code/Handoffs`; greppable header comment drives `list`/bare-`use` repo filtering; `launch` dispatches headless `claude -p` (stdin closed, backgrounded, timestamped log, `acceptEdits`, never skip-permissions) and refuses inquiry types, headerless files, and ambiguous repo matches. The tools smoke test now resolves every skill's `references/*.md` links, permanently; `runtime_overrides.test.ts` gained a `CLAUDE_ONLY_SKILLS` allowlist (stark-handoff ships deliberately without a Codex variant); the bare "handoff" trigger word was reclaimed from both `stark-handover` variants, which now route prompt-file asks to `/stark-handoff`.

### Changed
- models: the default Claude model is now **`claude-opus-5[1m]`** (Opus 5, 1M context) everywhere it was `claude-opus-4-8` — `models.claude.model_id`, the review-doc wing/fixer, copilot/agent_claude/claude_utils dispatch defaults, `red_team.verify.model`, `red_team.fold.model`, the skill-description optimizer, the automation-fleet model, and the sentinel preflight probe. `global/config.json` gains matching `model_rates` ($5/$25 per MTok) and `model_limits` (1M context, 64K max output — read off a live `claude -p --output-format json` run) entries for both `claude-opus-5[1m]` and `claude-opus-5`; the `claude-opus-4-8` rate entry stays so historical run costs still resolve. Red-team provider labels emit `anthropic-claude-opus-5`, with the old label kept in the legacy classification allowlist so already-annotated artifacts don't fail the gate. `--fable` still runs the doc-review lead on `claude-fable-5`.

### Removed
- **The entire `docs/` tree, every diagram, and the inert halves of `automation/` (STARK-346).** 229 files, ~68,500 lines, 7.8 MB. The rule applied was "does anything read it": a tool, test, script, GitHub workflow or skill opening the path at runtime. Nothing did. `docs/` held 66 specs, 63 superpowers design docs, 40 generated skill-doc files, 23 ADRs, 5 retros, 5 calibration files and a prompt changelog — none of it consumed by any code path, and the generator behind the skill docs had itself been deleted, so that part could never be refreshed. Every tracked image went with it, including the front-page lifecycle diagram, which drew a pipeline retired on 2026-07-26 and could only be redrawn by a tool that no longer exists. **`automation/` was left entirely alone** — an initial pass deleted `reports/`, `cli-snapshots/`, `costs/`, `hooks/` and `archive/` as generated output, and a reference sweep caught that as over-deletion before it shipped: the live trigger prompts in `automation/prompts/` read those paths by name, and `reports/templates/*.j2` are inputs, not output. **Kept on proof, not caution:** `data/persona/` (three tests parse the seed roster), `CHANGELOG.md` (`tools/release_changelog.ts` and the stark-gh merge path read it), `standards/` (vendored into every plugin; `standards/help.md` is asserted by the smoke test), and `CLAUDE.md`/`AGENTS.md` (agent-facing operating instructions). Measured before cutting: deleting `docs/`, `data/` and all images in a scratch clone broke exactly 3 tests, all of them the persona roster — so `data/persona/` was carved out and `docs/` was proven inert. Suite after: 1721 tests, 1718 pass, 0 fail, unchanged. `README.md` lost its diagram embed and its six links into the deleted tree; its "Skill Documentation" section now says what is true — each skill is documented by its own `SKILL.md` and its `--help`. Two more pieces of dead weight went with it: **`pytest.ini`**, in a repo with **zero** tracked Python files and a standing ban on adding any; and **`.githooks/pre-commit`**, which stamped a `revision:` into each edited skill by shelling out to `scripts/stamp_skill_revision.py` — a script deleted in the Python migration. The hook exits 0 when the helper is missing, and `core.hooksPath` is unset, so it had been a silent no-op wired to nothing. (The 9 stale `revision:` stamps themselves stay: bifrost's importer reads that field.) The doc-convention rule survives in `CLAUDE.md`/`AGENTS.md` but is reframed as **what `/stark-init-docs` scaffolds into a target repo** (still guarded by `tools/doc_convention.test.ts`), not a layout this repo keeps.

### Added
- **CI finally runs the test suite (STARK-341).** `.github/workflows/tests.yml` runs `cd tools && npm test` on every non-draft PR and every push to `main`. Until now **nothing** ran these 1721 tests — the four existing workflows are heartbeat, marketplace-sync and two project-board syncs, and the "Analyze" checks on PRs are CodeQL code scanning, not tests. That gap is why a broken `runtime_overrides.test.ts` sat red on `main` across three merged PRs. The job needs **no dependency install**: every import in the suite is a `node:` builtin, verified by running the suite from a fresh `--depth 1` clone with no `node_modules`. Typecheck is a second, **advisory** job (`continue-on-error`) because `tsc -p .` reports 3 pre-existing errors; gating on them would make the workflow red on arrival and block unrelated work. The draft guard uses `!= true`, not `== false`, per `standards/workflows/skip-draft-guard.md`: the workflow also runs on `push`, whose payload carries no `pull_request` object, and `undefined == false` is false — a `== false` guard would skip every push run.
- **Two tests stopped depending on the host machine, which is what made CI possible.** Probing the suite under a stripped runner-proxy environment (empty env, temp `HOME`, no `gh`, no `claude`/`codex`, minimal PATH) found 5 real failures. Three were in `agent_utils_lib.test.ts`, where `resolveVertexProject()` falls through to the host's `gcloud config get-value project` — so `assert.ok(settings.security.auth.vertexAi.projectId)` passed **only on a machine with gcloud configured**, and would have gone red on any runner and on any fresh checkout. All four vertex/oauth tests now pin `STARK_GEMINI_VERTEX_PROJECT` (precedence #1, so the same code path is exercised deterministically). The other two were `register_triggers.test.ts`, blocked because `scripts/register_triggers.sh` read `STARK_TRIGGERS_PAT` from the **macOS Keychain** at the top of the script and then **never referenced it again** — the create/update paths are still stubs ("would go here via RemoteTrigger API"), so the script does no authenticated work and the fetch only made it exit 1 on every non-provisioned host, in every mode including `--list` and `--dry-run`. Dead read removed, with a note to re-add it gated per-mode when the API calls land. Result: 1718 pass / 0 fail in the hostile environment **and** locally.

### Removed
- **The four retired pipeline skills' generated docs, and every live doc that still advertised them (STARK-334).** `docs/skills/stark-{phase-execute,plan-to-tasks,review-plan,spec-to-plan}/` — 30 files, 5.5 MB — described skills deleted in the 2026-07-26 demolition, and the generator that produced them (`/stark-generate-docs`) is itself gone, so nothing could ever repair them. Deleting the directories was the easy half; the rot was in what pointed at them. The root `README.md` still documented the demolished five-stage chain **as current**, including a copy-pasteable quick-start telling readers to run `/stark-phase-execute` — its Planning section now describes the two-stage `/stark-author` → `/stark-build` pipeline and links skills that exist. `docs/skills/README.md`'s entire "6-step pipeline" narrative named a retired skill in five of its six steps and was rewritten. Also pruned: 4 rows from `docs/skills/index.md`, 4 keys of dead generator state from `_manifest.json`, and `stark-release`'s related-skills list (markdown + its JSON sidecar in lockstep). Four **pre-existing** dangling links in `index.md` from an earlier retirement (`stark-review-spec`, `stark-red-team-{spec,plan}`, `stark-review-spec-improvement`) went with them — a link check flags them either way, and half-fixing a table invites a second pass. Three `CLAUDE.md` lines claiming `stark-phase-execute` still consumes `self_healer` / `skill_router` / `context_compactor` now say those callers died with it. Two further README claims were corrected in passing because the same edit touched them: the review pipeline is **5** domains, not 6, and `type-safety` was absorbed into `behavior` in the 2026-07-26 prompt rewrite. **Deliberately kept:** `_audit/scores.jsonl` (append-only dated generation log — it records that a run happened, which stays true), every CHANGELOG/ADR/retro/spec mention (dated records; ADRs are immutable by this repo's own rule), and the supersession notes in `stark-author`/`stark-build` that name what they replaced. **Knowingly left behind:** `pipeline.png` and `lifecycle.png` still draw the retired chain — images cannot be edited, only redrawn, and the tool that drew them is gone; `docs/skills/README.md` now carries a note saying so.

### Fixed
- **`findings_review_post.ts` validates review anchors per line, not per file (STARK-329, found by dogfooding the tool shipped hours earlier in STARK-325).** GitHub only accepts a review comment on a line inside a diff hunk. The adapter checked only that the finding's *file* appeared in the diff, so an anchor on an unchanged line reached the API — which **422s naming no index** — and `postReview`'s conservative fallback then posted body-only, demoting every valid anchor in the batch along with the bad one. Measured on PR #870: three of four anchors sat in valid hunks and **none** survived. `anchorableLinesFromPatch` now walks each file's patch and collects the addressable right-side lines (context + added; deleted lines are left-side and cannot be anchored with `side: "RIGHT"`), and a finding outside every hunk has its `line` dropped client-side with `**Location:** file:line (outside this PR's diff)` prepended to its body — it still lands, with its location intact, and costs no other finding its thread. Replaying #870's exact payload: **3 inline + 2 body** where it had been 0 inline + 5 body. A file with no patch (too large, binary) maps to `null` = permissive, degrading to the old behavior rather than refusing every anchor. Context now comes from `gh api .../pulls/N/files --paginate --slurp` rather than `gh pr view --json files`, which omits `patch` entirely — and the pagination matters: a PR over 30 changed files would otherwise expose only page one and silently lose anchors in the rest.
- **`runtime_overrides.test.ts` derives the Codex-target roster from each skill's `runtimes:` frontmatter instead of restating it (STARK-328).** The test kept two hand-maintained arrays — `SKILLS` (27 names that must ship a Codex overlay) and a `CLAUDE_ONLY_SKILLS` allowlist — and asserted their union equalled the `skill/` listing. `stark-bury` declared `runtimes: [claude]` in #867 and never reached the allowlist, so `main` sat **red across three merged PRs** (#866/#867/#868) and nothing caught it, because **no CI job runs this suite** — the only gate is a manual `cd tools && npm test`. The arrays were a second copy of a fact already declared at the site the real consumer reads: bifrost's importer (`artifactTargetsCodex`) decides from `runtimes:` whether a missing overlay is a hard import error. Both sets now derive from that key, so the choice is made once, in the file bifrost reads. Two parser divergences from that owner were caught by probing bifrost's real importer rather than reasoning about it, and both are closed: **`runtimes: []` requires an overlay** (bifrost leaves Runtimes unset when the list is empty, then defaults to `[claude, codex]`), so reading it as an exemption would green a tree `stark sync` rejects — an empty parse returns `null`; and the **bare/comma scalar form** (`runtimes: claude`) is a *supported* authoring form, so rejecting it was a false red. The bidirectional contract is now enforced: a Codex-target skill missing its overlay fails naming both remedies (previously an opaque ENOENT), and a claude-only skill that still ships an overlay fails too — a direction the old union assertion was **blind** to. The now-unfailable union assertion is deleted; `assert.equal(expected.length, 73)` deliberately stays hand-maintained as the only remaining add/delete tripwire. `/stark-bury` also reached `CLAUDE.md` and `AGENTS.md`, which it had never entered, and `CLAUDE.md`'s `skill/` count is corrected (28 `stark-*`, not 29 — the 29th `SKILL.md` is `skill/remember/`).
- **cc-user: `refresh` reports the active seat's stored copy instead of skipping it, and a seat mismatch no longer destroys the credential (STARK-246, PR #863).** Both defects were found by exercising the command shipped in #861 against the real fleet; a max-effort review of the first fix then caught a third, in the fix itself. (1) Skipping the active seat looked safe but is how a profile rots into a revoked token needing a browser login: the live `Claude Code-credentials` item is global and the running CLI rotates it on its own schedule, so the stored copy dies while its own `expiresAt` still reads hours ahead — `classifyRefresh` reports `fresh` and every check calls a dead profile healthy. New `compareActiveCopy` + `planActiveSeat` (pure, tested) compare the stored refresh token against the live one and report `stale-copy`. **They never write**, which is the review's finding: the first cut auto-re-captured, and with two same-plan seats a live item holding seat A's token while `~/.claude.json` still names seat B reads as "stale" purely because the strings differ — `seatIncoherence` compares plan strings and fails open for `team`↔`team`/`max`↔`max`, so the copy would bottle A's token under B's identity and destroy a non-re-derivable refresh token. Nothing local can identify whose token the shared blob is, so detection is the deliverable and repair is deliberate (`add <name>` after quitting other sessions) — which still fixes the original defect, because the original defect was silence. `compareActiveCopy` is tri-state for the same reason: a boolean returned `false` for both "identical" and "could not parse", and the caller printed "stored copy matches the live token" either way — an affirmative health claim over a blob it never read. An unreadable blob on the active seat now reports `corrupt`, as it already did on every other profile. (2) `seatMismatch` warns and **still writes**, under its own `refreshed-mislabeled` status so it is never tallied as a clean renewal: skipping the write discarded the token that had just rotated and killed the profile, which is the outcome this module exists to prevent. The sent token is dead on arrival, so the response is the only live credential for that seat — the registry *label* drifted, not the credential, and re-labelling is `remove` + `add` (a bare `add` replaces the credential rather than the label). For a rotating credential, "refuse to write" is never the safe default. Also: tri-state read of the live item (absent vs unreadable have opposite remedies, and `add` already distinguished them), and the status column widened for the longer status names.
- stark-gh: `/stark-gh:pr-open` now gates the PR **title** on a ticket scope, per-repo opt-in (STARK-247, PR #862) — the front half of the STARK-229 rule, since a title with no ticket gave the merge side nothing to inherit. A repo declares the convention in `.stark-gh.json` (`{"requireTicketScope": true, "ticketKey": "STARK"}`, `ticketKey` mandatory); preflight resolves the ticket from the branch name (case-insensitive, underscore-separated) and pins it into the drafter's prompt + output validation, exit 33 on a missing/mismatched/wrong-case ticket. An explicit `--title` is validated — never rewritten — on create **and** on an existing-PR title edit (exempting that path had bypassed the gate); a present-but-broken `.stark-gh.json` fails **closed** (exit 33), never a silent revert to off; `_` counts as a branch separator and no keyless scan can fabricate a ticket from a version token. Default off, so Evinced/OSS repos are unaffected. Still no CI title check — `lib/ticket.ts` is the only enforcement that runs.
- stark-gh: `/stark-gh:pr-merge`'s squash subject dropped the PR title's `type(STARK-<n>):` prefix, so merged commits on main lost the ticket trail (STARK-229, PR #859) — the drafter wrote the subject from the diff, and the convention's only machine enforcement died with alfred's CI on 2026-08-08. The drafter now extracts the prefix from the PR title and `validateDraft` requires it as a **token**: one space then a non-empty summary, no repeated prefix, an added `!` breaking marker allowed, and the ≤72-char cap measured *after* the prefix so it cannot collide with the length rule inside `driveDraft`'s 2-attempt budget. A miss retries once, then aborts at `DRAFT_INVALID` rather than landing prefix-less on main. The scope must look like a ticket key (`STARK-229`, `EI-1234`) and the type must be lower-case — `docs(adr-0007):`, `feat(gpt-5):`, `chore(node-22):` and `Fix(STARK-7):` mint no requirement, so repos without a ticket convention are never merge-blocked.
- stark-gh: `/stark-gh:pr-merge` died with exit 15 on any repo that keeps no root `CHANGELOG.md`, forcing a bare `gh pr merge --squash` fallback that loses the rebase, secret scans, and OID fences. Absence now skips the changelog step wholesale (plan carries `changelog: null` + `originalChangelogPath: null`, validated null-together; execute anchors rollback at `rebasedHeadOid`); a CHANGELOG that exists but lacks `## [Unreleased]` still exits 15. Codex runtime-override copy fixed identically. Also flipped every live `model: sonnet` command/skill frontmatter to `opus`.
- stark-gh: `/stark-gh:pr-open --ready` immediately followed by `/stark-gh:pr-merge` died on `WATCHER_RUNNING` (exit 34) until pr-open's CI watcher aged out on its own poll cadence — even with every check already green. The `latest.json.lock` mirror carried no owner-kind, so preflight could not distinguish pr-open's **ci-observer** (harmless: it only reports checks on a head the merge is about to invalidate by rebasing and force-pushing) from a **merge-driver** (must not be raced). Locks now carry `kind`; preflight pre-empts a live ci-observer (SIGTERM, SIGKILL after a 2s grace, mirror lock dropped unconditionally so a wedged observer can't block forever) and only reports `STARK_GH_RESUME=attached` for a merge-driver. Locks written before this change classify as `unknown` and stay conservatively attached.
- stark-gh: `/stark-gh:pr-merge`'s watcher polled to its 6h timeout without merging when the PR's **base branch requires no status checks**. The rollup gates on REQUIRED contexts, so an unprotected base yields `required: 0` → a vacuous `wait` on every poll, while the state file showed `status: "watching"` / `lastError: null` and every check run on the head was green. A vacuous rollup is now time-bounded (`decideVacuousTransition`, 5-minute grace — transient right after a push, permanent when it is branch configuration) and terminates with a `no_required_checks` status naming both remedies; the per-poll wait reason, previously computed and discarded, is written as `lastWait`.
- phase-execute: the goal loop's `--model "$(… stark_config_lib.ts --model claude || echo <fallback>)"` passed an **empty** model — `stark_config_lib.ts` had no CLI, so it exited 0 with no output and the `||` fallback never fired. Added the `--model <agent>` CLI (prints the resolved id; exit 1 + empty stdout on an unknown agent, `--help` exits 0) and quoted the fallback so `[1m]` isn't glob-expanded.

### Added
<!-- stark-gh:pr-merge pr=856 runId=1989ffe8-d244-48c2-9d6e-6afe44136fb5 -->
- Removed the obsolete project gate workflow that generated a failed run on every push.
<!-- stark-gh:pr-merge pr=855 runId=8cb32b80-e3f2-4b86-b82c-6e5b018301d5 -->
- Removed the obsolete GitHub Actions workflow for mirroring branches and tags to the former Infra-Group repository.
<!-- stark-gh:pr-merge pr=854 runId=7a6c404f-cda1-4632-a5d0-a9ef2a0ecee0 -->
- Added the `/stark-handoff` specification for creating, validating, listing, and launching prompt-file handoffs with fresh executors.
<!-- stark-gh:pr-merge pr=792 runId=9c0c7296-57bd-45c9-9c98-6075e519169a -->
- Add statusline labels and distinct Max and Team palettes for the third Stark account.
- **cc-user: `refresh` renews a stored profile without a browser (#861).** New `tools/cc_refresh_lib.ts` (pure, 20 tests) + `cmdRefresh`: `POST https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token` and the CLI's own public client id — both read out of the binary, never guessed — returns `expires_in=28800` (8h access) and `refresh_token_expires_in≈2405096` (~28d refresh). This closes the rot that made every profile stale within a day and dead within a month, whose only known repair was `claude /login` per account. **The refresh token rotates**, so a refresh whose result is not persisted destroys the profile — which is exactly the pre-existing bug: `use` restored a snapshot, the CLI refreshed, the rotated token was never written back. Everything follows from that: a lock (`~/.claude/.cc-refresh.lock`), sequential runs, `--dry-run` stops **before** the network call, and the active seat is **refused** rather than warned about (rotating the live login's token surfaces hours later as a forced `/login`). The 200 response carries `account.uuid` + `organization.uuid`, so a profile holding a different seat's token is refused instead of silently re-pointed — the only check that catches a swap between two profiles of the same plan type, which `seatIncoherence`'s plan-string comparison structurally cannot. Live run: 7 of 11 profiles renewed from expired (up to 42h stale) with zero logins.
- **Measured: headless claude authenticates from env vars alone, and that path never refreshes.** `CLAUDE_CODE_OAUTH_TOKEN` (+ `CLAUDE_CODE_OAUTH_SCOPES`) with an empty `HOME` returns a normal result while writing no credentials, leaving `oauthAccount` absent, and not touching the global Keychain item — so a dispatched subprocess can carry its own seat instead of riding the one global login every parallel session fights over. `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` is **inert**: injected with an expired access token the CLI fails `401 OAuth access token has expired` without attempting a refresh (proven twice with the same token — the identical second failure shows it was never consumed). Documented in CLAUDE.md; wiring it into the four dispatch env-builders is the follow-up.

## [v0.10.1] - 2026-07-24

### Changed
- review-doc: `max_fixes_per_round` default raised 8 → 12 (#788) — two default rounds now clear up to 24 findings in-dispatcher; a 25-finding run leaves ~1 for the interactive Phase 5 loop instead of ~9. Convergence math unchanged (still measured on the uncapped count).

### Removed
- auth: the metered-Anthropic-API claude dispatch mode (#787) — `claude_auth_lib` is subscription-only; the legacy `api` mode and its `ANTHROPIC_AGENTS` key injection are gone.

### Added
- tools: symlink-invocation entry-guard regression test (`entry_guard.test.ts`, #734) — spawns every CLI tool through a symlinked path and asserts `main()` actually runs, locking in the #786 `isMainModule` fix.

### Fixed
- marketplace-sync: bundle auto-bump now fires on vendored tools/config/prompts changes too (#789) — detection covers `dist/claude/<bundle>/` diffs, not just `catalog/<b>/{skills,commands}/`, closing the stale-plugin-cache gap (bifrost#103) where tools-only changes shipped under an unchanged version.
- copilot: headless claude subprocesses (goal + non-goal lead, claude wing) now run with an empty MCP roster (`--mcp-config` + `--strict-mcp-config` via `writeEmptyMcpConfig`) — they inherited the host's full MCP server list, where each configured server adds startup latency that compounded into multi-minute hangs before the prompt was even processed.
- copilot: wing verdict findings that arrive as objects (`{file, issue, ...}` — codex does this) are JSON-serialized by `toStringList` instead of collapsing to `[object Object]`, which starved the lead's fix round of the actual finding text.

## [v0.10.0] - 2026-07-24

### Added
- **auth: subscription-mode claude dispatch — stop billing the API by default (#782).** New `tools/claude_auth_lib.ts` is the SSOT for headless-claude model auth: `subscription` mode (default — no `ANTHROPIC_API_KEY` injected; the CLI rides the logged-in account's OAuth credentials via `HOME`, billing the seat instead of the metered API) vs `api` mode (legacy key injection from `ANTHROPIC_AGENTS`). Resolution: `STARK_CLAUDE_AUTH` env > `models.claude.auth` config > `subscription`. All 6 dispatch env-builders route through `applyClaudeAuth`; subscription mode actively strips stale keys so API billing can't silently re-enable. Live-verified keyless dispatch on opus-4-8 and fable-5.
- **auth: gemini oauth mode — dispatch on the Code Assist seat, not per-token Vertex (#783).** New `tools/gemini_auth_lib.ts` (sibling SSOT): `oauth` mode (default — `selectedType: "oauth-personal"` riding the logged-in Google account's Gemini Code Assist seat, `GOOGLE_CLOUD_PROJECT` as the licensing project) vs `vertex` (former hardwired per-token behavior) vs `api-key`. Resolution: `STARK_GEMINI_AUTH` env > `models.gemini.auth` config > `oauth`. All 3 gemini env-builders swept; `agent_gemini` now copies the oauth cred files into its isolated home; Vertex env vars are kept out of non-vertex envs (inside the CLI they override the settings.json auth type). Live-verified `gemini-3.1-pro-preview` on the seat with zero Vertex billing.

## [v0.9.1] - 2026-07-23

### Added
- **stark-copilot: DAG-planned execution with default Workflow wave fan-out (#780).** `/stark-copilot` now plans its own execution before implementing: it builds a **task-level** dependency DAG (issue `## Dependencies` + phase `depends_on`, or plan-text edges; ambiguous ⇒ dependent, fail-closed; an open human-led dependency skips its dependents instead of building on missing work), **chain-collapses** linear task runs into single steps (a fully-linear phase stays exactly one step — zero overhead regression), levels the steps into waves with phase boundaries as barriers, and fans each multi-step wave out concurrently via the Workflow tool — one lead/wing dispatcher loop per step, each in its own worktree, diffs applied in deterministic wave order. Parallelism is on by default; `--sequential` disables it, `--parallel` force-collapses all steps into one wave. Fan-out hardening: atomic §2f apply (reset on failed 3-way; file-copy fallback forbidden in fan-out), clean-tree precondition, seeded re-dispatch (`-r2` step id, diff travels as a file, bounded round, dual cleanup), per-step result files so a multi-hundred-KB `final_diff` never round-trips through model output, and `collectDiff` split into a textual wing-review diff vs a `--binary --full-index` apply diff (+ regression test).

### Fixed
- handover,session: zsh doesn't word-split `$CLI` — use a function (#779)

## [v0.9.0] - 2026-07-20

### Added
- **`/stark-forge` pipeline orchestrator — deterministic core (#736, Phases 1–5).** The spec, plan, and the whole crash-resumable state layer for running the spec→plan→implementation chain end-to-end as one conducted run. **The orchestrator skill itself is not yet wired — Phase 6 lands separately.**
  - **`tools/forge_state_lib.ts` — the pure state machine.** No clock, no disk, no network, no git; every mutating function returns a new `RunState`. Transition matrix (spec §6) with compare-and-set and no-op reprint; attempts-archive with exactly one `Attempt` per episode; `recordOutput` patch semantics (array union-dedup, write-once scalars → `artifact_conflict`, monotonic merge attribution, one-owner `artifact_prs` registry → `adoption_mismatch`); a `running→done` gate enforcing `requiredOutputsFor`, all-artifact-PRs-merged, no-open-fold, and plan-to-tasks's `issue_numbers` marker; and `reconcileRunningStage`, the single writer of a `crashed` attempt, which archives the episode and applies the resolving transition in one call so no episode is ever double-archived.
  - **Chain/merge/threading resolution.** `resolveChain` (6-stage default, 8 with `--red-team`, `--from`/`--until` slicing, input-kind auto-detection), `mergePointsFor` (one merge per artifact at its last touching stage), `renderStageCommand`/`nextInputFor` threading strictly from recorded producer outputs, and `planPathFor`/`parsePlanSlug` as the single owner of the `docs/plans/YYYY-MM-DD-<slug>-plan.md` convention.
  - **Crash-window closure.** `resumeTarget` returns `{state, target}` so the caller persists the reconciliation before acting, over the closed action enum `reinvoke | advance | complete | merge_only | abandon`. A checkpointed merge-point stage retries **only the merge** (never re-running reviews or implementation); dead ends (`author_pr_merged_early`, `artifact_pr_closed`) resolve to `abandon` instead of retrying forever.
  - **`tools/forge_state.ts` — the host module.** All disk I/O (`persistState`/`loadState`/`resolveLatest`/`listResumeCandidates`; `stateRoot()/history/forge/<slug>/<run-id>/`, mode 0600, latest pointer, retention) reusing the existing history helpers rather than reimplementing them — plus nine CLI subcommands: `resolve`, `init`, `record-output`, `transition`, `get`, `abandon`, `summary`, `resume-target`, `driver-block`. Runs are repo-bound and fail closed on a repo mismatch; `init` is retry-idempotent; a host-side preflight refuses any PR whose base/repo/head-branch shape doesn't match the reporting stage (`artifact_pr_unverified`) before it can enter the registry that drives merging.
  - **Driver mode** is fully built and tested (`renderDriverBlock` + `driver-block`), so the chain stays drivable by hand — no shell `timeout` wrapper is ever emitted, and an executable fold-state check precedes every `/stark-gh:pr-merge`.
  - New **`forge_pipeline`** config section (`history_keep_runs`, `merge_timeout_s`), deliberately separate from the existing review-routing `forge` section.
  - 382 tests, zero network (the PR-state reader is injected throughout).
- **Spec §2 command-table amendment:** `/stark-plan-to-tasks` gains `--plan-slug <recorded-plan-slug>` so the recorded slug is passed explicitly on both normal and crash-reentry invocations instead of being re-derived from a filename.

<!-- stark-gh:pr-merge pr=686 runId=d4abae4b-3672-48a1-8077-08a09fd06560 -->
- Add the reviewed implementation plan for the `stark-write-spec` workflow.
<!-- stark-gh:pr-merge pr=685 runId=fa8a1089-bd46-48ab-aaef-eb15553543d9 -->
- Document the bounded authoring-review feedback loop and review lenses in the write-spec contract.
<!-- stark-gh:pr-merge pr=682 runId=156c6897-aac1-41b1-9470-58a61765dab7 -->
- Add the contract-bounded `/stark-write-spec` authoring-stage specification with structured verification, gap resolution, and crash-safe run history.

### Fixed
- tools: symlink-invocation regression test (`entry_guard.test.ts`) — spawns every CLI tool through a symlinked path and asserts it still produces output, locking in the #786 `isMainModule` fix (the raw `pathToFileURL(process.argv[1])` guard never matched through the `~/.claude/code-review/tools` symlink, so `main()` silently never ran and the process **exited 0 having done nothing**).
- stark-gh: the pr-merge self-modifying gate now fires only in the stark-skills repo itself — the generic guarded prefixes (`tools/`, `scripts/`, …) no longer block merges in unrelated repos that happen to have those directories (hit by Atlas PR #162's `tools/CLAUDE.md`).
- stark-gh: the secret scanner scores the two sides of a `NAME=value` token independently (tolerating a leading diff marker), so `KEY=/filesystem/path` doc and `.env`-style lines no longer false-positive as high-entropy; a real 40+-char secret on either side still flags.

## [v0.8.0] - 2026-07-15

### Added
- **Review convergence system (ADR 0022) — no mutation goes unreviewed.** Closes the structural hole where the operator's Phase 5b hand-fixes (the largest, least-constrained edits of a run) landed *after* the final review round. Shipped in slices (#671 plan + ADR):
  - **Coverage honesty (#672):** the receipt tracks per-domain completion across the whole run (`coverage`, `coverage_gaps`) — a domain that never completed a review in any round fails the run (`ok=false`, exit 1, `error.code=coverage_gap`, analytics grade capped at `degraded`) instead of masquerading as clean; transient failures that recovered only warn. Lead timeouts scale with doc size (`scaleTimeoutForDocSize`, cap 3×) and escalate per-domain on retry (`nextDomainTimeout`, 600→1200→1800).
  - **Run-record durability (#673):** doc-review history is per-run (`history/{spec,plan}-reviews/<slug>/<run-id>/` + `latest` pointer + `history_keep_runs` retention) — re-runs never clobber earlier records; `rounds.json` + `analytics.json` persist incrementally after every round via atomic tmp+rename (a killed process leaves partials, `partial:true` until the final write); the full receipt lands as `receipt.json`; write failures surface in receipt `persistence_errors`. **PR-cycle analytics parity:** `buildCodeReviewAnalytics` aggregates each run's `round-N.json` into per-domain time/outcome/classification + coverage gaps (`analytics-rX-rY.{json,md}` + receipt `analytics` block).
  - **Convergence pass (#674):** the receipt records `last_reviewed_sha` (+ `final-reviewed-doc.md` snapshot); `--converge --base <sha>` reviews ONLY the delta since the last-reviewed state (contradiction / broken cross-reference / falsified claim / resolved-in-prose-only; zero findings valid); both doc skills gain **Phase 6 — Converge** with an explicit `Converged / NOT converged` claim (silence is no longer a terminal state), findings flowing through the standard resolvable-thread contract, recursion bounded to one extra pass on `high`/`critical`. The PR cycle mirrors it: a final-round pushed fix triggers one review-only pass over the new HEAD (receipt `convergence` block). Validated by reproducing the original incident — a hand-injected contradiction after the final review was caught as `high`.
- **Process analytics + circuit breakers + coherence pass for doc reviews (#668, #669):** every `/stark-review-spec`·`/stark-review-plan` run computes per-round stats, judges itself (`healthy`/`degraded`/`runaway`, incl. the decline-then-rise `no_net_convergence` flag), writes `analytics.json` + a `<doc>.review-analytics.md` sidecar, and stops pathological loops early; a net-reducing coherence pass runs before the final review round.
- **Findings-on-PR contract for doc reviews:** every finding posts as its own resolvable review thread, gets fixed, gets resolved (`tools/review_doc_findings.ts`, #644); each thread is authored by the reviewing LLM's GitHub App for per-reviewer analytics (#648); posting is rate-limit-resilient with cross-org thread reads (#654); the skills auto-open a PR when none exists and the retired `docs/superpowers/**` tree relocates (#642).
- **Red-team noise war:** per-finding refutation pass — a distinct Claude agent tries to refute each committee finding per lens, drop/downgrade requires a cited verbatim span (#630); persona noise cuts + plan-stage spec-disposition dedup (#629); injection-FP + severity-inflation cuts (#627, #628); fix-plan **fold** subsystem — token-less decider triages each move, patches the doc, never-merged fold PR + audit (#626); challenges auto-open PRs and comment findings via the run's GH App (#611).
- **New skills:** `stark-ssot` (SSOT discipline + auto-fired review domain, #639); `stark-gha-cost` (GHA/GHAS cost optimizer + meridian/bifrost/visibility lesson packs, #659–#663); `stark-refactor-plan` (multi-agent planning-only refactor dispatcher, #607); **multi-agent `stark-terraform-review` + `stark-terragrunt-review`** (#612); `stark-adr` + docs-convention reconcile (#617); `stark-blog-sharpen` (#615); `stark-voice`; `remember` (#636); `stark-logging` + central model-limits registry (#632); `/stark-handover` cross-`/clear` save/resume (#641).
- **`/stark-spec-to-plan` authoring craft (#634):** per-task Interfaces, Global Constraints, right-sizing, named proving Tests, SSOT gate; plans always land on a PR.
- **Draft PRs by default (#662):** every PR-opening path opens a draft (`--ready` opt-out); `pr-merge` un-drafts → CI → squash-merge.
- **Model/agent upgrades:** Gemini enabled with runtime-resolved Vertex project/location (#609); codex default bumped to `gpt-5.6-sol` (#649); `--fable`/`--lead-agent claude` runs doc-review leads on Fable 5 + every skill honors `--help` (#646).
- `/stark-review` auto-detects `test_command` (#610) and runs the fix loop on the final round too; marketplace auto-publish + location-aware skills/tools via the `asset_root_lib` seam (#605); housekeeping self-heals orphaned `~/.claude` asset symlinks (#666); statusline overhaul — per-account-tier gradients, shaded gauges, fork-free hot path (#619–#625).

### Fixed
- **Growth breaker no longer punishes legitimate growth (#675):** growth past the ratio limit alone warns + sets `analytics.growth_ack_required` (operator judges gap-filling vs padding via AskUserQuestion; headless = stop); growth AND non-convergence together hard-stop with a composite reason. A real 2.63× gap-filling spec review no longer aborts.
- Red-team: `openai_token` pattern word-boundaried to stop false positives (#667); pre-dispatch sensitive-gate scans untrusted input only, not the preamble that quotes attack phrases as examples (#628); prompts/config resolve via the asset-root seam instead of hardcoded paths (#613, #616, #655); refutation-table cell sanitization completed (#631).
- Skill frontmatter newline mangled by #664 restored (#665); refactor-planner escapes backslashes before pipes in table cells (#653); copilot goal-mode prompt staged to a file + lead timeout made terminal (#633, #635); agent PATH backfilled to prevent spawn ENOTDIR; stale GetEvinced install-ID assertion updated (#638); `review_doc_findings.ts` null-narrowing tsc errors fixed (in #673) — `tsc -p .` is clean again.

### Changed
- **Marketplace repo renamed** `stark-marketplace` → `stark-bifrost` → **`bifrost`** (#652, #657); GitHub Apps dual-keyed for the `21StarkCom` org rename with a WIF identity SSOT (+ tyr) (#651, #656); workspace paths re-pointed after the `~/Code` reorg (#650); automation fleet re-targeted to the migrated org (#614).
- **Doc-review exit-code semantics (#672):** exit 1 now means terminal failure OR coverage gap; transient dispatch failures that recovered no longer fail the run — the skills' Phase 4 gate blocks on gaps and warns on transients.
- All skills set `disable-model-invocation: true` — explicit invocation only (#664); `stark-*-design` skills renamed to `stark-*-spec` (#618); branch+PR-with-findings-on-PR workflow codified in the docs (#608).
- CI economics: Actions run volume cut (daily stale cron, superseded-run cancellation, #658); daily mirrors to `Infra-Group` for stark-skills + bifrost (#670).

### Removed
- **BREAKING: `install.sh` removed — distribution is now marketplace-only.** The symlink-based local installer (and its `--select` TUI, `--status`, `--uninstall`, git-hook/manifest/infra provisioning) is deleted; skills + tools ship exclusively as self-contained Claude Code plugins via stark-marketplace. Each plugin already vendors `tools/` + `global/`, so no symlinks are needed. Trade-off: editing a file in this repo is no longer instantly live — publish (merge → `marketplace-sync` PR → merge) and `/plugin update <bundle>@stark-marketplace` to pick it up. Assets plugins don't cover (`~/.claude/settings.json`, statusline, output-styles, `org/evinced` overrides, mutable-state dirs, git hooks) are now managed by hand. `asset_root_lib.ts` keeps the `~/.claude/code-review` fallback for direct non-plugin invocations (automation-fleet crons). Docs (README, AGENTS.md, CLAUDE.md) updated to the marketplace-only flow.

## [v0.7.0] - 2026-06-03

### Added
- **Goal-driven implement loops + Workflow parallelism** for `/stark-copilot` and `/stark-phase-execute` (#599). The implement step runs as a Claude Code `/goal` loop (argument-form `claude -p` — stdin does not trigger the loop) that iterates until tests pass, bounded by `--max-budget-usd`; `--no-goal` reverts to the bounded subagent. New `--parallel` mode fans independent tasks/steps out via a Workflow, each in its own worktree. `copilot_dispatch.ts` gains `--goal-condition` / `--goal-max-budget-usd`.
- **`release_changelog.ts` parses the Keep-a-Changelog `### Removed` category** (#603). A Removed-only `[Unreleased]` section no longer reads as empty and falls back to git-log; `removed[]` is threaded through the receipt and rendered, with `### Removed` → patch by default (`**BREAKING:**` → major).
<!-- stark-gh:pr-merge pr=594 runId=8a4f660b-d78c-4027-9856-655cdf7c48b8 -->
- Added the vendored Caveman plugin for token-efficient Claude Code and Codex communication.
- **`/stark-design-to-plan` lead/wing port** — `tools/plan_dispatch.ts` replaces the deleted `scripts/design_to_plan_dispatch.py` (3-agent tournament + cross-review → paired lead/wing loop, sibling of `tools/copilot_dispatch.ts`). Round 1: lead reads design + agent-specific `generate.md`, emits markdown plan draft. Wing reviews via new agent-specific `review.md`, returns `{verdict, blocking_findings[], non_blocking_suggestions[], summary}` JSON. On `revise`, lead receives prior draft + findings + new agent-specific `revise.md`, emits a new draft. Loops until `approve` / `block` / `--max-rounds` exhaustion / empty-draft / unchanged-from-prior. Same final-verdict union + JSON output shape as copilot. Defaults: lead=`claude`, wing=`codex`, max-rounds=4. New `review.md` / `revise.md` prompt files added per agent; `cross-review.md` deleted per agent. SKILL.md rewritten: `--agents` → `--lead`/`--wing`/`--max-rounds`/`--wing-timeout`; Phases 2+3+4 collapsed into one dispatch call; failure-modes table swapped to copilot's set. 15-test TS suite (`plan_dispatch.test.ts`) covers defaults, prompt builders, preflight rejections (lead==wing, invalid agent), and CLI smoke. The 3 design_to_plan-specific tests in `scripts/test_dispatch_routing.py` deleted (Python they tested is gone; equivalent behavior covered by the TS test file). `scripts/dispatcher_base.py` consumer list updated. Bonus: `copilot_dispatch.ts` exports its agent-dispatch primitives (`run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`) so `plan_dispatch.ts` doesn't duplicate them.
<!-- stark-gh:pr-merge pr=580 runId=ccea06f7-93af-4864-887a-c3a0bb7391dd -->
- Added canonical hook tool arguments in settings to match installer output.
<!-- stark-gh:pr-merge pr=579 runId=10021f64-b216-4d1d-84f1-b5f4e7eab425 -->
- Ignore Claude-managed worktree checkouts under `.claude/worktrees/`.
<!-- stark-gh:pr-merge pr=577 runId=19828674-92cb-4b32-9f24-4ce6093e548e -->
- Added Go `stark hook` wiring for Claude Code hooks and removed stale deleted Python hook blocks.
- **stark-session TS data collector** — `tools/stark_session_lib.ts` + `tools/stark_session.ts` collect git/gh/board/alerts/health/queue/healer/persona/skills state into a single JSON payload that `/stark-session` renders directly via Claude. Replaces the deleted Python TUI subsystem.

### Changed
- **Goal-loop budget guard** default raised to $10 and pinned in settings env as `STARK_GOAL_MAX_BUDGET_USD` (#600, #601). A missing/`0`/`NaN` budget never disables the guard — it falls back to the built-in default; the CLI rejects non-positive values.
- **Auto-compaction threshold** set via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (settings env) to 80% filled (#604) — the override is lower-only vs the ~83% default.
- **`github_app`** finalized as TS-only. `scripts/github_app.py` (744 LOC) + `scripts/test_github_app.py` (145 LOC) deleted; `tools/github_app{,_lib}.ts` is now the sole implementation. Remaining Python orchestrators (`scripts/runtime_env.py`, `scripts/multi_review.py`) shell out to `node --experimental-strip-types tools/github_app.ts ... token` for installation-token mints instead of importing the deleted Python module. `scripts/healer_patterns.json::auth-stale.verify_command` swept to the TS CLI; dead `GITHUB_APP` constant in `tournament.py` removed. `scripts/conftest.py` and `scripts/test_runtime_env.py` stub the new `runtime_env._get_token_via_ts` subprocess wrapper instead of monkeypatching the deleted module. The on-disk token cache (`~/.cache/github-app-tokens/`) keeps its JSON shape so any cached tokens minted by the Python remain valid.
- **`self_healer`** ported from Python to TypeScript. `scripts/self_healer.py` (407 LOC) deleted; replaced by `tools/self_healer_lib.ts` + `tools/self_healer.ts`. Python had zero tests for a module that auto-applies fixes to files; the TS port establishes the contract with 28 tests covering every gate (guard, max_per_session, auto-mode allowlist, circuit breaker, suggest/auto branch, requires_confirmation, success/failure circuit updates, critical-alert on circuit trip). Atomic writes for `healer-session.json` + `healer-circuits.json`. `heal_attempt` events emit directly via `tools/emit_queue_lib.ts`; warning/critical alerts emit directly via `tools/alert_delivery_lib.ts` — no Python re-imports. CLI surface preserved (`--pattern-id` / `--stderr-file` / `--mode` / `--json`); result JSON shape unchanged. `scripts/autopilot_dispatch.py` (Python orchestrator) + `skill/stark-phase-execute/SKILL.md` cut over to the TS CLI in the same slice.
- **`healer_canary`** ported from Python to TypeScript + improved. `scripts/healer_canary.py` (310 LOC) deleted; replaced by `tools/healer_canary_lib.ts` + `tools/healer_canary.ts`. Original Python had **zero** tests; the TS port establishes the contract with 44 new tests. Original CLI surface (`--status`, `--promote`, `--demote`, `--json`) preserved with byte-identical `--status` JSON shape. **Improvements:**
  - **Atomic config writes** — the Python's `_write_config` was naive read-modify-write of the multi-writer `~/.claude/code-review/config.json`. The TS version writes a `.tmp` sibling and atomically renames. 100-iteration concurrent-write stress test added.
  - **Configurable promotion gate** via new `config.self_heal.{min_successful_suggests, abort_window_days, circuit_open_hours}` keys (defaults: 5 / 7 / 24 — preserves the Python's hard-coded literals).
  - **New `--check` subcommand**: exits 0 when all auto-mode pattern circuits are closed, exits 2 (with the offender list) when any auto-pattern is tripped. Designed for oncall paging — a suggest-mode trip is normal canary behavior and intentionally does NOT trigger a failure.
  - **New `--close-circuit PATTERN_ID` subcommand**: manually resets a tripped circuit (clears `tripped_at` and `consecutive_failures`, stamps `last_reset_at`, preserves `ever_tripped` as historical record). Replaces "wait 24h or hand-edit `healer-circuits.json`."
  - **New `--explain PATTERN_ID` subcommand**: full audit trail for a single pattern — every matching log entry, current circuit state, computed stats, mode, and (for suggest-mode patterns) eligibility + blockers.
  - **New `healer_canary` insights event type** added to `tools/emit_queue_lib.ts` allowlist. Every promote / demote / close-circuit operation emits one (action + pattern_id + context). Distinct from `heal_attempt` (the per-attempt signal self_healer emits) — this is the canary control-plane signal.
  - `tools/stark_session_lib.ts:collectCanaryStatus` cut over to the TS CLI.
- **`skill_router`** ported from Python to TypeScript. `scripts/skill_router.py` (215 LOC) deleted; replaced by `tools/skill_router_lib.ts` + `tools/skill_router.ts` + 21 new TS tests (no Python tests existed for this module). Inline `skill_activation` config loader — no `config_loader.py` dependency. `skill_suggestion` events emit directly via `tools/emit_queue_lib.ts` (no `scripts/_emit.py` shim). CLI surface preserved (`--context {review|implementation|session|debug} [--json]`), JSON shape unchanged (the internal `_suppressed_count` field still stripped before output). `tools/stark_session_lib.ts:collectSkillSuggestions` + `skill/stark-phase-execute/SKILL.md` cut over to the TS CLI.
- **`alert_delivery`** ported from Python to TypeScript. `tools/alert_delivery_lib.ts` + `tools/alert_delivery.ts` become the TS-canonical implementation; same on-disk contract (`~/.claude/code-review/alerts.jsonl` JSONL log + `alert-{unix-ts}[-{counter}].marker` files in the same dir, including the same-second collision counter). `tools/stark_session_lib.ts:collectAlerts` cut over to the TS CLI. `scripts/alert_delivery.py` stays in place — `scripts/self_healer.py` and `scripts/healer_canary.py` still import `emit_alert` in-process; both sides write/read the same marker dir, so cross-language interop works without any coordination. Verified: a critical emitted by the Python is visible to `--check --json` from the TS CLI, and vice versa.
- **`context_compactor`** ported from Python to TypeScript. `tools/context_compactor_lib.ts` + `tools/context_compactor.ts` replace `scripts/context_compactor.py`. Same checkpoint shape (`checkpoint-{ts}.md` markdown under `sessions/{sanitized-id}/`), same `session_state.last_checkpoint` update on every write, same size cap (`max_checkpoint_size_kb`). `config_loader.py` not pulled in — the `context_compaction` section is loaded inline directly from `~/.claude/code-review/config.json` with the same defaults the Python ships. CLI surface preserved (`[--session-id ID] [--json]`). 4 SKILL.md files cut over (stark-autopilot, stark-copilot, stark-phase-execute, stark-session). Three skill files that still shelled `python3 .../session_state.py --json` (missed in the prior slice) also cut over to the TS CLI.
- **`session_state`** ported from Python to TypeScript. `tools/session_state_lib.ts` + `tools/session_state.ts` replace `scripts/session_state.py` as the source of truth for `~/.claude/code-review/sessions/{id}.json` persistence (same path-traversal sanitization, same on-disk JSON shape, same load/save semantics). New `set --field <name|start_head|last_checkpoint> --value VAL` subcommand replaces the inline `python3 -c "from session_state import …"` blocks in `/stark-session` SKILL.md Phase 3 + Phase 6. `tools/stark_session_lib.ts:collectSessionState` cut over to the TS CLI (drops one Python subprocess hop per `/stark-session start|end`). `scripts/session_state.py` stays in place — `scripts/context_compactor.py` still imports `SessionState` as a Python class; both get deleted in the context-compactor port.
- **`session_id` resolver** ported from Python to TypeScript. `tools/session_id_lib.ts` + `tools/session_id.ts` CLI replace `scripts/session_id.py` as the source of truth for the three-tier resolver (CLAUDE_SESSION_ID > `~/.claude/projects/` newest-mtime marker > uuid4). `tools/emit_queue_lib.ts` now delegates to the shared lib instead of inlining a partial version (drops the `// Skip the projects-dir resolution path` debt, so every TS producer now reports the same session ID the Python session_state machine sees). `/stark-session` SKILL.md preamble cut over to the new CLI. The Python `scripts/session_id.py` stays in place pending the `session_state.py` port — `session_state.py` still imports it — and will be deleted in that slice.
- **`optimize_skill_description`** ported from Python to TypeScript. `scripts/optimize_skill_description.py` (323 lines) + `scripts/test_optimize_skill_description.py` (86 lines) deleted; replaced by `tools/optimize_skill_description.ts` + 14 TS tests covering frontmatter parsing, improve-prompt assembly (with 200-char truncation parity), and the `ANTHROPIC_AGENTS → ANTHROPIC_API_KEY` env allowlist. CLI surface preserved (same flags, same JSON report shape). Scoring still shells out to the skill-creator plugin's Python `run_eval.py` — that lives outside this repo.
- **stark-persona** ported from Python to TypeScript. `scripts/stark_persona.py` (1504 lines) + `scripts/test_stark_persona.py` (1191 lines) deleted; replaced by `tools/stark_persona_lib.ts` + `tools/stark_persona.ts` + 44 TS tests (25 lib + 19 CLI smoke). SKILL.md (and `/stark-session` start/end hooks + `tools/stark_session_lib.ts` collector) cut over to `node --experimental-strip-types tools/stark_persona.ts`. JSON shape of `select --auto` preserved (still parsed by `/stark-session`). Insights events now write directly to `~/.stark-insights/queue.db` via `tools/emit_queue_lib.ts` under the new `persona_event` allowlist entry (no HTTP, no token file, no `_emit.py` shim). Persona DB at `~/.stark-persona/persona.db` and `active.json` schema unchanged — pre-existing rows are reused as-is.

### Removed
- **stark-release Step 5.5 `generate-viz.py` regeneration** (#602) — a dangling reference to a script that only ever existed in consumer repos (no-op here) that failed the skill smoke test.
- **Session TUI subsystem** — `scripts/session_tui.py`, `scripts/session_tui_cli.py`, `scripts/test_session_tui.py`. The structured briefing/end-summary are now produced by Claude from the JSON returned by `tools/stark_session.ts`. `--plain` / `--no-color` CLI flags are gone with the renderer.
- **stark-graph** code, tests, workflows, docs, and config keys (`graph_enriched_domains`, `graph_gate_mode`, `graph_max_parse_workers`, `graph_coverage_threshold`).
- `scripts/stark_persona.py` and `scripts/test_stark_persona.py` — replaced by `tools/stark_persona{,.test,_lib,_lib.test,_writes.test}.ts`.
- `scripts/optimize_skill_description.py` and `scripts/test_optimize_skill_description.py` — replaced by `tools/optimize_skill_description{,.test}.ts`.
- `scripts/context_compactor.py`, `scripts/test_context_compactor.py`, `scripts/session_state.py`, `scripts/test_session_state.py`, `scripts/session_id.py` — all replaced by their `tools/*_lib.ts` + `tools/*.ts` TS counterparts. context_compactor was the last Python consumer of session_state and session_id, so all five files came out in one slice.
- `scripts/skill_router.py` — replaced by `tools/skill_router{,.ts,_lib.ts,_lib.test.ts}`. No Python tests existed; 21 new TS tests added to cover the routing logic.
- `scripts/healer_canary.py` — replaced by `tools/healer_canary{,.ts,_lib.ts,_lib.test.ts}` (the port adds three new subcommands; see `### Changed`).
- `scripts/self_healer.py` — replaced by `tools/self_healer{,.ts,_lib.ts,_lib.test.ts}`.
- `scripts/alert_delivery.py` + `scripts/test_alert_delivery.py` — cascaded by the self_healer port: self_healer was the last consumer of `from alert_delivery import emit_alert`. The TS `tools/alert_delivery_lib.ts` (added earlier) is now the canonical implementation; its on-disk contract (alerts.jsonl + alert-*.marker files) is unchanged.

## [v0.6.2] - 2026-04-24

### Added
- **stark-red-team v1** — architect committee layer for forge pipelines (#310)
- **stark-forged-review** — multi-agent leader + second-opinion PR review skill (#309)
- forged-review: telemetry for auto-vs-explicit invocation source
- forged-review: truncate oversized diffs with head+tail window
- forged-review: cache triage decisions by diff hash
- scripts: Vertex-compatible skill description optimizer + skill optimizer tooling

### Fixed
- forged-review: preserve worktree on `awaiting_fixes` so `--resume` works (#311)
- forged-review: stderr heartbeat keeps parent stream alive during long rounds
- forge: real pipeline dispatch, working fix-loops, classifier word boundaries
- drain_to_buffer v2 schema + surface silent failures (#314)
- honor global red-team locked config
- clean installer and release skill drift
- reasoning-effort validation, reuse-proposal key gate, schema/runtime alignment, delete delta
- mode validation, fence escaping, timeout budget, status docs
- drain_to_buffer/red-team/skill-optimizer review rounds 2–33: envelope types, replay fault tolerance, auth redaction, race guards, recovery preservation, retry fixes, loopback and symlink guards, IPv6 loopback, dead-letter split, dim preservation on replay, permanent/transient split, UUID pass-through, CI-root allowlist, atomic staging, strict v2 probe, and related hardening

### Changed
- chore: un-deprecate `/stark-review`; fix stark-codex installation id (#316)
- Switch Claude to Anthropic API, Gemini to ADC+Vertex; bump to opus-4-7 (#315)
- docs: align stark-review skill with runtime
- docs: skill-optimizer — API mode requires explicit `--skill` target
- docs(stark-forged-review): trim SKILL.md to 71 lines; fix v1 drift in Observability/state/delta sections
- docs(retros): brainstorm-to-merge session pattern retrospective
- install: relax disable-model-invocation validation to warning
- chore: allow stark-data-core PR workflow; merge pending repo cleanup updates

## [v0.6.1] - 2026-04-11

### Added
- **stark-forge** — end-to-end design-to-tasks pipeline: 9 Python modules (`forge_orchestrator`, `forge_classifier`, `forge_review`, `forge_plan`, `forge_tdd`, `forge_tasks`, `forge_audit`, `forge_improve`, `config_loader` extension), isolated prompt trees (`forge-design-review/` with 13 domains, `forge-plan-review/` with 10 domains), seed heuristics, and SKILL.md with `--auto-detect`, `--dry-run`, `--resume`, `--workers` flags
- 3-tier domain classifier: heuristic pattern matching (Tier 1), LLM-based classification with poisoning guard (Tier 2), interactive terminal confirmation (Tier 3)
- Iron Rule review loop: severity-based finding classification, cross-reference high-confidence detection, recurrence tracking (3rd occurrence blocks), targeted re-dispatch for changed sections, consensus judging for security domains
- Crash-safe orchestrator: atomic state writes (`tmp` + `os.replace`), backup mirroring, PID-based lock file with liveness check, spec hash change detection on resume
- Self-improvement module: SNR-threshold prompt improvement queuing, metadata-only firewall, heuristic consolidation trigger
- Forge config section in `global/config.json` with domain routing, plan review routing, consensus settings, and threshold configuration
- `/stark-design` archived in favor of `superpowers:brainstorm` + `/stark-forge`

### Changed
- Skill count updated from 29 to 30
- CLAUDE.md updated with `/stark-forge` in pipeline and skills table

## [v0.6.0] - 2026-04-10

### Added
- Gemini agent enabled with `gemini-3.1-pro-preview` via Vertex AI global endpoint
- **stark-graph** — pluggable dependency graph pipeline (7 phases): Python parser, audit mode, drift validator, graph diff + blast radius, idempotent PR commenting, review integration, CI workflows
- **Domain triage** — context-aware domain dispatch: triage engine, TUI renderer, orchestrator, shadow validation, `--domains` allowlist for dispatch scripts
- **Session TUI** — rich session start/end rendering: `tui_core.py` shared primitives, `session_tui.py` renderer, `session_tui_cli.py` CLI entry point, `SessionState` name/start_head fields
- Interactive TUI skill picker (`mngt-skills --select`) + global CLI entry point
- `analyze_shadow.py` — shadow validation gate metrics for domain triage
- Multi-org GitHub App routing — per-owner installation IDs with dynamic API discovery
- Adaptive timeout and large-diff triage for large PRs
- `tournament.dispatch_agent_prompt()` — generic agent dispatcher for tournament use (fixes broken `dispatch_competitor` call path)
- `conftest.py` autouse fixture to clear `config_loader.load_config` lru_cache between tests

### Changed
- Prompt consolidation: 40 byte-identical domain files collapsed into shared `domains/` directories
- Top 5 skills compressed 44-57% (phase-execute 665→372 lines, housekeeping 555→239)
- Claude dispatch uses `infra-ai-platform` project with global endpoint + opus default
- `config_loader`: `_SECTION_DEFAULTS` registry replaces 7 identical accessor functions; `_merge_dict` warns on non-dict overrides
- `dispatcher_base`: `resolve_model("claude")` returns real model ID via `CLAUDE_MODEL` constant; OSError on config files now warns to stderr
- `plan_review_dispatch`: uses `resolve_model()` instead of hardcoded `CODEX_MODEL`/`GEMINI_MODEL` constants
- `multi_review`: dedup Pass 3 skips `line=0` findings; `all_findings()` cached in summary construction; dead `codex_output_file` removed
- Review skills routed through triage orchestrator with fallback
- Cross-agent dedup, spec context injection, severity overrides expanded
- Test-coverage severity calibration + vendor-webhook SSRF hints in security prompts

### Fixed
- **Security:** `github_app` atomic token cache writes via `tempfile.mkstemp` + `os.replace` (was briefly world-readable); `gemini_utils.make_gemini_env` strips `ANTHROPIC_API_KEY` (was leaking full env); `autopilot_dispatch` `shell=True` → `shlex.split` (command injection); `session_state.load()` path traversal via `_sanitize_id()`
- **Critical:** `multi_review.deduplicate_findings` mutated Finding objects in-place (corrupted descriptions); `multi_review.review_pr` posted comments as disabled agents; `design_to_plan_dispatch` `int()` crash on non-numeric LLM scores; `emit_queue` `time.monotonic()` → `time.time()` for cross-process SQLite; `generate_skill_docs` HTML sanitizer now suppresses all dangerous tags; `plan_to_tasks_validate` Gemini output double-unwrapping
- **Important:** `github_app.get_token()` raises `RuntimeError` instead of `sys.exit(1)`; `github_projects` SingleSelect parser removed incorrect guard; `tournament.select_winner` `.get()` prevents KeyError; `runtime_env` temp dir injected as `STARK_AGENT_TMPDIR` + cleanup runs once per process; `autopilot_dispatch` uses `"implementation"` operation instead of `"review"` for bot token boundary; `flow_layout` uses `model_copy()` instead of in-place Pydantic mutation
- Symlink path bug in `domain_triage` + plan review fixes
- Dispatch routing audit and docs refresh
- Real wall-clock timestamps required in observability protocol

## [v0.5.1] - 2026-04-03

### Fixed
- Codex `model_id` defaulted to `"codex"` instead of `"gpt-5.4"` — caused 100% CLI failures across all 9 review domains
- YAML frontmatter parsing in `generate_skill_docs.py` — replaced fragile regex with `yaml.safe_load`, fixing block scalars (`>-`) and single-quoted values
- Hanging test in `test_plan_review_dispatch.py` — replaced subprocess dispatch with direct argparse validation
- Codex dispatch `cwd` not passed to subprocess — codex refused to run outside a trusted git directory
- Codex CLI error stderr now persisted to `~/.claude/code-review/logs/` for debugging
- Broken `scripts/.venv` (stale interpreter path from repo rename)

### Changed
- Codex `08-ui-design-conformance.md` prompt strengthened — bolded scope rules, explicit backend early-exit (was producing security/correctness findings on pure backend PRs)
- Cross-domain dedup instruction added to both `claude/agent.md` and `codex/agent.md` — agents now defer to specialized domain reviewers instead of duplicating findings
- Scope calibration added to 4 Claude domain prompts for small PRs
- Design-review domain count updated to 12 (new test-plan domain)

## [v0.5.0] - 2026-04-03

### Added
- `/stark-persona` skill — session character voices with weighted selection, date-aware combos, catchphrases, feedback loop, and `--add`/`--off` flags
- Persona roster: 45 characters across standup comics, comedy-action actors, Tarantino characters, and more
- Persona showcase pages: constellation, deck, periodic, roster HTML views
- `scripts/stark_persona.py` — persona CLI with producer-side JSON emission
- `scripts/flow_extractor.py` — scoped workflow extraction from SKILL.md files with flow-override support
- `scripts/flow_layout.py` — dagre layout runner with timeout
- `scripts/flow_schema.py` — FlowDiagram Pydantic model (dagre@0.8.5)
- Golden-file regression tests for flow extraction and layout
- 4 new PR review domains: spec-conformance, ui-design-conformance, regression-prevention (3 agents × 9 domains = 27 sub-agents total)
- Backend stack coverage in security, correctness, and test-coverage prompts
- Tournament results emission to stark-insights
- `generate_skill_docs.py` wired to push updates to stark-data-core
- Automation fleet: 12 CCR triggers across 4 tiers (self-improvement, health/drift, intelligence, reporting)
- Automation operator runbook (`automation/README.md`)
- Automation heartbeat GitHub Action (`.github/workflows/automation-heartbeat.yml`)
- Jinja2 report templates for MD, HTML, MDX automation reports
- Local validation utilities for automation fleet
- `/stark-design` skill — generate design doc from requirements (3 agents generate, 6 cross-reviews)
- `/stark-design-to-plan` skill — generate implementation plan from design doc
- `/stark-autopilot` skill — tournament-per-step implementation with 3 agents competing in worktrees
- `/stark-review-design-improvement` skill — improve design review prompts
- stark-insights event emission wired into 7 skills
- Review lessons embedded into autopilot, review, and pr-flow skills
- `scripts/config_loader.py` — shared config loader with typed accessors and hierarchical defaults (#183)
- `scripts/session_id.py` — authoritative session ID resolver (#184)
- `scripts/runtime_env.py` — isolated subprocess environment builder (#194)
- `scripts/preflight.py` — environment validation checks with timeout (#201)
- `scripts/emit_queue.py` — SQLite-backed event queue with dead-letter (#202)
- `scripts/event_schema.json` — event schema v2 with session awareness (#202)
- `scripts/validation_gate.py` — post-generation code validation chain (#185)
- `scripts/failure_classifier.py` — error categorization with confidence scoring (#186)
- `scripts/self_healer.py` — pattern-based auto-remediation with circuit breaker (#195, #206)
- `scripts/healer_patterns.json` — 8 healer patterns incl. TypeScript patterns (#195, #205)
- `scripts/lock_helpers.py` — exclusive-write locks with operator unlock (#208)
- `scripts/approach_contract.py` — pre-execution goal confirmation (#211)
- `scripts/session_state.py` — persistent session state management (#188)
- `scripts/context_compactor.py` — session checkpoint generation (#198)
- `scripts/learning_capture.py` — corrections and constraints extraction (#199)
- `scripts/skill_router.py` — contextual skill suggestions based on history (#197)
- `scripts/backfill_history.py` — historical data backfill for metrics baselines (#187)
- `scripts/cost_controls.py` — budget tracking, alerts, hard-stop, credential expiry (#210)
- `scripts/alert_delivery.py` — critical system event delivery path (#215)
- `scripts/dashboard.py` — HTML dashboard with 8 KPIs and fallback rendering (#200)
- Canary rollout framework for healer auto-mode (#213)
- Install provisioning for local infrastructure dirs and SQLite DBs (#193)

### Changed
- PR review coverage expanded from 6 to 9 domains per agent (18 → 27 sub-agents)
- README rewritten with pipeline narrative and full skill tables
- Design/plan review split into separate dispatch modes with tournament support
- `stark-onboard-project` now includes `/onboard-service` pointer for GCP services
- `stark-review-design` auto-commits fixes after each review round
- Config-driven agent enablement — agents respect `models.{agent}.enabled` in config (#203)
- Metrics extended with all 8 KPIs from design (#190, #196)
- Automation registry updated with new triggers and migrations (#191)
- Housekeeping expanded: session, checkpoint, lock, log cleanup, artifact archival (#189, #192)
- 6 SKILL.md files updated: session, housekeeping, phase-execute, autopilot, team-review, design-to-plan
- Config deprecation pipeline: add P0, warn P1, remove P2 (#204, #209, #212)
- Session/compactor/router wired into skill entry points (#207, #214)
- Preflight and approach contract wired into automation triggers (#216)

### Fixed
- Regression test failures from config-driven agent enablement
- Stale test assertions for removed GOOGLE_CLOUD_LOCATION hardcoding
- Persona stderr noise, combo rating, weight seeding
- Persona installed path for script invocation
- Autopilot `${pkg_name}` placeholder replaced with `.rglob` from cwd
- Invalid CLI flags found by spec review
- Stale remote-tracking refs via `git fetch --prune`
- `plan_to_tasks_validate` temp file naming with `$RANDOM`

## [v0.4.0] - 2026-03-26

### Added
- `scripts/tournament.py` — reusable tournament engine extracted from `generate_skill_docs.py` (#88)
- `TournamentConfig` and `TournamentResult` dataclasses with YAML config support (#89)
- `Tournament` orchestrator class with semantic and visual evaluation strategies (#90)
- Test evaluation strategy — run LLM-generated code against pytest test suites (#91)
- Tournament CLI with `--config`, `--prompt`, `--dry-run`, `--json` flags (#92)
- `/stark-tournament` skill for multi-LLM competition (#93)

### Changed
- `generate_skill_docs.py` refactored to use Tournament API (#94)
- Updated CLAUDE.md and README.md with `/stark-tournament` (#95)

## [v0.3.0] - 2026-03-25

### Added
- `generate_skill_docs.py` — multi-LLM documentation generator with visualization competition (#59, #60, #61, #62, #63, #64, #65, #66)
- `/stark-generate-docs` skill for ongoing doc maintenance (#69)
- Skill documentation for all 20 skills — Mermaid diagrams, HTML visualizations, PNG screenshots (#67, #68)
- Routing guide with Mermaid decision trees for skill discovery (#66)
- Git LFS tracking for skill documentation PNGs (#58)
- Shared CSS design system for HTML visualizations (#58)

### Changed
- `CLAUDE.md` — added `/stark-generate-docs` to skills tables (#70)

## [v0.2.0] - 2026-03-22

### Added
- `graphql()` function in `github_app.py` with retry support (#8)
- `github_projects.py` — GitHub Projects V2 GraphQL utility module with 13 public functions (#10)
- `setup_project.py` — one-time CLI script to create a Project with all custom fields (#14)
- `project-pr-sync` GitHub Action — PR events trigger project status transitions (#16)
- `project-gate-check` GitHub Action — composite release gate with `release-gate` status check (#18)
- `project-stale` GitHub Action — hourly detection of stuck agent/clarification items (#20)
- GitHub Projects integration in `stark-plan-to-tasks` — issues added to project with 9 fields set (#22)
- Project-based task fetching in `stark-phase-execute` with label fallback (#24)
- Documentation state advisory check in `stark-pr-flow` before merge (#26)
- Review Rounds field tracking in `stark-review` (#28)
- Project-aware session start/end in `stark-session` — briefing and doc state updates (#30)
- End-to-end integration tests for `github_projects.py` (#34)
- ADRs: 0010 (GraphQL for Projects V2), 0011 (fail-closed mutations), 0012 (additive migration)

### Changed
- `install.sh` now verifies `github_projects.py` and `setup_project.py` (#32)
- Comprehensive test suite for `github_projects.py` — 102 unit tests (#12)
