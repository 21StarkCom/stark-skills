# stark-gh:cleanup Implementation Plan

## 1. Overview

Build `/stark-gh:cleanup` as a two-stage TypeScript command under `plugins/stark-gh`: **preflight** parses raw slash-command arguments, resolves PR / branch / audit candidates into a secure plan file; **execute** consumes that plan to close stale PRs, delete remote refs, remove worktrees, and delete local branches with per-action failure isolation. The implementation reuses existing stark-gh runtime conventions (`node --experimental-strip-types`, `gh` auth, argv-only subprocess calls, `lib/runtime.ts` 0700/0600 tempdir, `lib/redact.ts` stderr scrubbing) and adds **no new files under `lib/`** — every shared concern lands as additive overloads on existing helpers, per the design.

The key safety constraints, in order: remote SHA-drift re-check at execute time (TOCTOU window); protected-branch eligibility gate before any side effect; fork PRs skipped at preflight; cross-repo `--repo` confines actions to remote-side only; idempotent deletion semantics (404/422-"reference does not exist" treated as success).

Phasing prioritises working increments: Phases 1–4 build the safety surface (types, args, resolution, execute) before features (audit, stale, cross-repo) extend it. Each phase has a runnable end state.

## 2. Prerequisites

Run from the worktree root:

```bash
cd /Users/aryeh/git/Evinced/stark-skills/.claude/worktrees/PLUGINS
node --version
gh auth status
git status --short
./install.sh --status
```

Required tooling: Node with `--experimental-strip-types`, Git, GitHub CLI authenticated as the intended destructive actor, write access to the target repo. No Terraform, cloud, DB, or IAM provisioning.

### Design ambiguities to resolve before coding

These were caught during cross-review and must be reconciled with the design doc. Each has a phase + task target.

1. **`--force` flag mismatch.** `cleanup.md` skeleton's `argument-hint` includes `[--force]`, but the Decisions table omits it ("git refuses to `branch -D` a checked-out branch regardless"). **Resolution:** omit `--force` from `argument-hint`, args parser, and rejection set (Phase 5, Task 1; regression-asserted via `rg`).
2. **`headSha` schema placement.** The plan-file sample puts `headSha` under `local.headSha`, but the drift re-check is remote-side. **Resolution:** add `remote.headSha: string | null` to `CleanupAction.remote` and populate it from `git ls-remote --heads origin` / `gh api .../git/ref/heads/<ref>`. `local.headSha` stays for informational purposes (Phase 1, Task 1).
3. **`authUser` field missing.** "Auth & Identity" says preflight records the auth user; the schema doesn't list it. **Resolution:** add `authUser: string` to `CleanupPlan` (Phase 1, Task 1). Populate via `gh api user` in Phase 2.
4. **Dry-run stdout contract.** Codex's plan proposed a `STARK_GH_CLEANUP_DRY_RUN=1` sentinel; the design specifies path-only stdout. **Resolution:** preflight writes the plan-file as normal and prints the path on stdout; execute is **not invoked** by the wrapper when `--dry-run` is in `$ARGUMENTS`. The wrapper greps `$ARGUMENTS` for `--dry-run` to short-circuit (Phase 5, Task 1). Avoids parsing user args in markdown beyond a literal substring check.
5. **`cross-repo-no-checkout` skip reason.** Machine key is `cross-repo-no-checkout`; human-rendered label is `cross-repo (no local checkout)` (Phase 4, Task 3).
6. **`--no-color` flag.** Documented in the design but absent from both candidate plans. **Resolution:** parse in Phase 2; thread through `lib/output.ts` to suppress ANSI in stderr table; assert via `preflight_no_color.test.ts` and an `execute_no_color.test.ts` snapshot (Phase 4, Task 5).
7. **`--stale-author-self-only` in `argument-hint`.** Defaults on; was missing from the skeleton's `argument-hint`. **Resolution:** include `[--stale-author-self-only[=true|false]]` (Phase 5, Task 1).

### Out-of-band dependency

A sandbox repo with at least one disposable merged/closed PR for the Phase 6 manual smoke. Provision before Phase 6.

## 3. Phases

### Phase 1: Shared schema, exit codes, helpers, plan I/O

**Goal:** typed contracts and reusable argv-safe primitives before any command logic exists.  
**Dependencies:** none.  
**Estimated effort:** M.

#### Tasks

1. **Extend `lib/types.ts`** with `CleanupPlan`, `CleanupAction`, `CleanupSource`, `CleanupSkipReason`, `CleanupStepResult`, `CleanupSummary`, `CleanupFlags`, `CleanupUserArgs`. `schemaVersion: 1` is a literal type. `CleanupSkipReason` is a union of `"protected" | "fork" | "not-found" | "pr-not-found" | "head-sha-drift" | "cross-repo-no-checkout"` for compile-time discipline; `summary.skipReasons` is `Record<string, number>` at runtime (open map for forward-compat). Include `authUser: string` and `remote.headSha: string | null` (see §2 resolutions 2 + 3). Done when `tsc --noEmit` passes and existing PR-open / PR-merge plan tests still pass.

2. **Extend `lib/exit.ts`** with:
   ```ts
   export const CleanupExit = {
     OK: 0, BAD_ARGS: 2, NOTHING_TO_DO: 3,
     PARTIAL_FAILURE: 4, UNRECOVERABLE: 5, BUG: 64,
   } as const;
   ```
   Done when cleanup tools import `CleanupExit` (not `Exit` or `MergeExit`). Exit-code **precedence** at execute end-of-run: unrecoverable startup error first → `EXIT_UNRECOVERABLE`; else any action `error` → `EXIT_PARTIAL`; else `summary.actionable === 0` → `EXIT_NOTHING_TO_DO`; else `EXIT_OK`.

3. **Extend `lib/plan.ts`** to export:
   ```ts
   export function validateCleanupPlan(p: unknown): asserts p is CleanupPlan
   export function readCleanupPlan(filepath: string): CleanupPlan
   export function writeCleanupPlan(filepath: string, plan: CleanupPlan): void
   ```
   If existing `plan.ts` is hard-coded to PR-open/PR-merge shapes, factor the read/write/validate path generically. Done when `plan_io.test.ts` round-trips a hand-written `CleanupPlan` JSON and existing plan tests stay green.

4. **Extend `lib/runtime.ts`** with `cleanupDir(): string`, `ensureCleanupDir(): string`, `mktempInCleanup(template?: string): string`. Path: `~/.claude/code-review/stark-gh/cleanup/<ts>-<rand>.json`, dir mode `0700`, file mode `0600`. Reuse existing tempdir primitives and atomic-write semantics; sandbox fallback mirrors existing pattern. Done when `ls -ld` shows `drwx------` on the dir and `-rw-------` on written plan files.

5. **Extend `lib/branch.ts`** with `validateCleanupBranchName(name: string): ValidationResult`. Accept Unicode and slashes; reject `HEAD`, `@`, `-`, leading `-`, control chars, `..`, empty, and any name that fails `git check-ref-format --branch <name>`. **Do not** replace existing `validateBranchName` — additive only, so PR-open / PR-merge behaviour is unchanged.

6. **Extend `lib/git.ts`** with: `localBranchExists`, `localBranchOid`, `deleteLocalBranch`, `listWorktrees`, `removeWorktree`, `listGoneLocalBranches`, `lsRemoteHeads`, `aheadBehind`. Every helper takes injectable `ExecFn` and builds subprocess calls via argv only.

7. **Extend `lib/gh.ts`** with: `repoView({ repoSlug })`, `ghCurrentUser`, `fetchCleanupPr`, `listClosedPulls`, `listOpenPulls`, `getRemoteHeadRef`, `deleteRemoteHeadRef`, `closePrWithComment`. All argv-only. **Centralise ref-path URL encoding** here (branch names with `#`, `/`, Unicode, `?`) — preflight and execute call the helpers, never construct API paths inline. Done when a dedicated `gh_ref_encoding.test.ts` covers `feat/something-ñ`, `chore/q#5`, `bugfix/?-mark` against `encodeURIComponent`-equivalent semantics.

8. **Scaffold preflight + execute entry points.** Create `gh_cleanup_preflight.ts` and `gh_cleanup_execute.ts` with `main()` stubs that read `--raw-args` / `--plan-file`, round-trip a no-op plan, and exit `0`. No business logic. Done when both stubs run end-to-end with a hand-crafted plan-file.

#### Risks

- Shared helper changes break PR-open / PR-merge: keep old signatures backward-compatible (additive overloads only).
- `lib/plan.ts` too tightly coupled to existing shapes: factor generically in this phase; the refactor is small and pays for itself in Phases 4+.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/plan.test.ts \
  plugins/stark-gh/tools/__tests__/branch.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/plan_io.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/gh_ref_encoding.test.ts
```

### Phase 2: Preflight — arg parsing, repo context, protection, auth

**Goal:** preflight resolves args + repo + auth + protection list with deterministic exit codes. No candidate resolution yet.  
**Dependencies:** Phase 1.  
**Estimated effort:** M.

#### Tasks

1. **`parseRawArgs(raw: string): CleanupUserArgs`** inside `gh_cleanup_preflight.ts` (no new lib file). Tokenise via `lib/shell_quote.ts`. Reject: unknown flags; malformed `--pr` values (regex `^[1-9][0-9]*$`); empty `--pr` / `--branch`; reserved branch names (via `git check-ref-format`); `--stale-days <= 0`; conflicting flags; `--repo` not matching `OWNER/NAME`. Each rejection prints offending token verbatim on stderr; exits `EXIT_BAD_ARGS`. Done when `preflight_args.test.ts` covers `--pr 0`, `--pr -5`, `--pr abc`, empty `--branch`, `--stale-days 0`, unknown flag — each with offending token in stderr.

2. **Repo + auth context.** Use `gh.ts:repoView()` with `--repo` override; use `git remote get-url origin` + `originMatches()` to set `plan.crossRepo` and `plan.cwdRepo`. Resolve `authUser` via `gh.ts:ghCurrentUser()`. **`authUser` resolution failure with `--stale-days` + `--stale-author-self-only=on` (default) → exit `EXIT_UNRECOVERABLE`** (the safety filter cannot be evaluated; we don't silently widen scope). Done when `preflight_cross_repo.test.ts` proves the boundary and an `auth_fail.test.ts` covers the fail-loud path.

3. **Protection list.** Hardcoded `["main", "master", "develop"]` ∪ `repo.defaultBranch` ∪ current HEAD branch (same-repo, non-detached). `protected.currentHead: null` on detached HEAD or cross-repo. Protected branches remain in `plan.actions` as `skip: true, skipReason: "protected"` — not filtered out — so the summary table is faithful.

4. **Mode + flags.** Compute `mode`: `pr` / `branch` / `audit` / `mixed` (≥2 of `--pr`/`--branch`/`--stale-days`). `--repo` does **not** change mode (only affects `crossRepo`). Populate `plan.flags` (`dryRun`, `staleDays`, `includeDrafts`, `allowNoPrMatch`, `auditMaxPrs: 500`, `staleAuthorSelfOnly: true`, `noColor`).

#### Risks

- Wrapper dry-run drift: keep dry-run as a wrapper-level short-circuit (substring check on `$ARGUMENTS`), not a preflight stdout sentinel.
- `gh repo view` / `gh api user` failures pre-mutation should be unrecoverable: map to exit `5`.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_args.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_cross_repo.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_protected.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/auth_fail.test.ts
```

### Phase 3: Candidate resolution and plan writing

**Goal:** resolve `--pr`, `--branch`, `--stale-days`, audit inputs into one deduplicated cleanup plan written to disk.  
**Dependencies:** Phase 2.  
**Estimated effort:** L.

#### Tasks

1. **PR mode.** For each `--pr N`, call `gh.ts:fetchCleanupPr(repo, n)` → state / merged / closed / open / draft, `head.ref`, `head.sha`, `head.repo.full_name`, `base.repo.full_name`, `updated_at`. Build `CleanupAction` with `source.type: "pr"`. Detect forks (`head.repo.full_name !== base.repo.full_name`) → `skip: true, skipReason: "fork"`. 404 → `skip: true, skipReason: "pr-not-found"`; **fail `EXIT_BAD_ARGS` unless `--allow-no-pr-match`**. Record `remote.headSha` from `gh.ts:getRemoteHeadRef` (source of truth for the drift check).

2. **Branch mode.** For each `--branch NAME`, bypass PR lookup. Check remote presence + SHA via `lsRemoteHeads`; check local presence + OID via `localBranchExists`/`localBranchOid`. If neither side exists → `skip: true, skipReason: "not-found"`. Apply protection gate.

3. **Stale-open scan.** When `--stale-days N`, also pull open PRs. Compare `updated_at` against an injected `now` (clock-injection seam — `now: () => Date.now()` default; tests pass `now: () => fakeTime`). Drafts gated by `--include-drafts`. Foreign authors gated by `--stale-author-self-only` (default on, compares against `authUser`). Stale PRs get `needsPrClose: true`.

4. **Audit mode.** When neither `--pr` nor `--branch` is set: paginate `gh.ts:listClosedPulls(repo, perPage=100)` up to `--audit-max-prs`. **Set `summary.truncated: true`** if the cap fires. Same-repo: intersect PR head refs with `lsRemoteHeads(origin)`; include `[gone]` locals from `listGoneLocalBranches`. **Cross-repo: only `audit-pr` candidates** (the `[gone]` concept requires cwd to match the target repo). Empty audit → still write plan; execute will exit `EXIT_NOTHING_TO_DO`.

5. **Deduplication and source merge.** When the same branch arrives via multiple sources (e.g., `--pr 569 --branch feat/orphan --stale-days 30` covers the same branch twice), keep one action; OR the `needsPrClose` flag (any stale source requiring close wins); preserve explicit source metadata as an array `sources: CleanupSource[]` on the action.

6. **Local-branch metadata + worktree enumeration.** For each non-cross-repo action whose local branch exists: populate `local.{exists,headSha,ahead,behind}` via `aheadBehind` (handle "no upstream" → `ahead/behind: null`). Enumerate via `listWorktrees`; populate `action.worktrees: [{ path, dirty }]` (dirty determined by `git -C <path> status --porcelain`). The design does **not** gate cleanup on dirty — recorded for the human table only.

7. **Plan summary + write.** Populate `plan.summary.{candidates,actionable,skipped,skipReasons,truncated}`. Write plan via `writeCleanupPlan` into `cleanupDir()`. **Stdout contract:** final line is the plan-file path (sole stdout output of preflight). Human table on stderr. Token redaction via `lib/redact.ts` on every stderr emission.

#### Risks

- Branch names with `#`, Unicode, slashes break GitHub API paths if encoded inline: centralised in `gh.ts:getRemoteHeadRef` / `deleteRemoteHeadRef` (already in Phase 1) — preflight and execute never construct API paths.
- Large audit on a 10k-PR repo: `--audit-max-prs 500` is the safety valve; one `--paginate` batch of 5 requests stays well under rate limits.
- Clock-injection seam leaks into prod: keep it as a top-level parameter of the stale helper, not a module-level mutable global.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_pr.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_branch.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_audit.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_stale.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_fork.test.ts
```

### Phase 4: Execute engine — ordered actions, drift, dry-run, output

**Goal:** consume a plan and run destructive actions with per-action isolation, idempotency, and SHA-drift protection. Every documented exit code reachable.  
**Dependencies:** Phase 3.  
**Estimated effort:** L.

#### Tasks

1. **`executeCleanupPlan(plan, { exec, planFile }) → CleanupSummary`** in `gh_cleanup_execute.ts`. CLI accepts only `--plan-file`. Invalid plan file → `EXIT_UNRECOVERABLE` without mutation. Read via `readCleanupPlan` (Phase 1).

2. **Ordered action execution** (steps 0–5 per §"Action Semantics" of the design):
   - **Step 0 — Eligibility gate** (preflight-set): respect `skip: true` from plan; do nothing further for that action.
   - **Step 1 — PR closure** (`needsPrClose` only): `gh.ts:closePrWithComment(n, "Closed by /stark-gh:cleanup — stale for <N> days (no activity since <date>).")`. Failure → record `error` on the action; **do NOT proceed to step 3** (stranding an open PR with deleted head is worse than the alternative).
   - **Step 2 — HeadSha drift re-check** (when `remote.exists`): `gh.ts:getRemoteHeadRef(repo, branch)`. SHA mismatch → `skip: true, skipReason: "head-sha-drift"`; no exit escalation; subsequent actions proceed.
   - **Step 3 — Remote ref delete**: `gh.ts:deleteRemoteHeadRef(repo, branch)`. HTTP 200/204/404 → success. HTTP 422 matching `/Reference does not exist/i` → success. Anything else → step failure (record `{code, stderr}`).
   - **Step 4 — Worktree removal** (skip when `plan.crossRepo`): for each `action.worktrees`, `git.ts:removeWorktree(path, force=true)`. Any failure → record + **skip step 5 for this action** (a still-attached worktree blocks `branch -D`).
   - **Step 5 — Local branch delete** (skip when `plan.crossRepo`): `git.ts:deleteLocalBranch(name, force=true)`. Failure → record; loop continues.

3. **Cross-repo gating.** Steps 4 and 5 skipped when `plan.crossRepo === true`. Skipped local steps are recorded on the action as `skipReason: "cross-repo-no-checkout"` (machine) / human label `cross-repo (no local checkout)`. Done when `execute_cross_repo.test.ts` (explicit file) asserts zero `git.ts` mutation calls when `crossRepo: true` and step 3 still fires.

4. **Dry-run.** `flags.dryRun` → execute writes the same human table to stderr describing what *would* run, with every per-action `status: "would-run"` (or `"would-skip"`). No mutation calls. Stdout JSON still emitted; `exitCode: 0`. Plan-file not unlinked. (The wrapper short-circuits before invoking execute on dry-run — this path covers running execute manually for debug.)

5. **Output contract.**
   - **Stdout:** single-line JSON `{"event":"cleanup-complete","exitCode":N,"counts":{actionable,succeeded,failed,skipped},"actions":[{id,branch,status,error?},...]}`.
   - **Stderr:** human table, columns `# | source | branch | remote | local | worktree | action | status`. **`--no-color` (or absent TTY) → no ANSI codes**; thread `plan.flags.noColor || !isTTY(stderr)` through `lib/output.ts`. Token redaction via `lib/redact.ts` on every stderr write.
   - Done when `execute_happy.test.ts` parses stdout JSON, snapshots stderr table; `execute_no_color.test.ts` asserts no ANSI.

6. **Per-action error capture.** Every step wraps work in `try { ... } catch (e) { action.error = { code, stderr }; action.failed = true; break; }`. Outer loop never aborts.

7. **Exit-code computation** (precedence from Phase 1 Task 2). Done when one test per exit code (0/3/4/5) drives the relevant state.

8. **Plan-file lifecycle.** `EXIT_OK` and `EXIT_NOTHING_TO_DO` (clean run, no errors) → `unlink(planFile)`. Any error path → leave on disk and print path on stderr.

#### Risks

- Local branch TOCTOU between preflight + execute: git refuses `branch -D` on a checked-out branch in any worktree → step 5 fails cleanly, recorded, loop continues. **Acceptable.**
- Concurrent `/stark-gh:cleanup` runs against the same repo: idempotent by construction — 404/422 success and head-sha-drift skip absorb the race. Document in Phase 5 README that concurrent runs may produce inflated per-action failure counts in the loser's summary; behaviour is correct.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/execute_happy.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_partial_failure.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_dry_run.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_worktree.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_pr_close_failure.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_head_sha_drift.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_cross_repo.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_no_color.test.ts
```

### Phase 5: Slash-command wrapper and README

**Goal:** expose the command via the plugin discovery surface and document safe operation.  
**Dependencies:** Phase 4.  
**Estimated effort:** S.

#### Tasks

1. **`plugins/stark-gh/commands/cleanup.md`.** Frontmatter `name: cleanup`, `allowed-tools: Bash, Read`, `model: sonnet`. `argument-hint`: `[--pr N[,N,...]] [--branch NAME[,NAME,...]] [--repo OWNER/NAME] [--stale-days N] [--include-drafts] [--stale-author-self-only[=true|false]] [--dry-run] [--allow-no-pr-match] [--audit-max-prs N] [--no-color]` (**no `--force`**; §2 resolution 1). Body:
   ```bash
   TOOLS="$HOME/.claude/plugins/stark-gh/tools"
   PLAN_FILE=$(node --experimental-strip-types "$TOOLS/gh_cleanup_preflight.ts" \
     --raw-args "$ARGUMENTS" --emit-plan-path)
   if [ -z "$PLAN_FILE" ]; then exit 1; fi
   # Dry-run short-circuit: wrapper-level substring check on $ARGUMENTS;
   # no execute invocation. Preflight already wrote and reported the plan.
   case " $ARGUMENTS " in
     *' --dry-run '*) echo "Dry-run plan written to: $PLAN_FILE"; exit 0 ;;
   esac
   node --experimental-strip-types "$TOOLS/gh_cleanup_execute.ts" --plan-file "$PLAN_FILE"
   ```
   No LLM dispatch. No bash-side arg parsing past the dry-run substring check. **Regression assertion:** `rg -n -- '--force|codex exec|Agent\\(' plugins/stark-gh/commands/cleanup.md` must produce zero hits.

2. **Update `plugins/stark-gh/README.md`.** Replace the manual `gh api -X DELETE … + git branch -D …` placeholder (currently around lines 35–39). New sections:
   - One-line description + use cases.
   - Argument surface table (mirror the design's table).
   - Exit code table.
   - Stdout/stderr contract one-liner.
   - Cross-repo mode behaviour.
   - Audit mode behaviour, with the `--audit-max-prs 500` cap noted.
   - Smoke runbook (from design's smoke section, verbatim).
   - Squash-merge recovery note (from design, verbatim — reflog + `git update-ref refs/keep/<name>` advice).
   - `--stale-days` public-comment warning under operator's identity; safety rail is `--stale-author-self-only` default.
   - Concurrent-runs note: safe-by-construction, may inflate per-action failure counts in the loser's summary.
   - Operational maintenance command for retained failed plans: `find ~/.claude/code-review/stark-gh/cleanup -type f -name '*.json' -mtime +14 -print`.

3. **Verify install discovery.** `./install.sh --status` reports `cleanup` as installed. No `install.sh` change required — the plugin loop already discovers new commands under `plugins/stark-gh/commands/`.

#### Risks

- Wrapper accidentally drops stdout JSON via command substitution: capture full output, extract plan path on the final line, print the execute JSON intact.
- README smoke runbook leaves commits in the sandbox repo's `main`: label it sandbox/disposable only.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/integration.test.ts
rg -n -- '--force|codex exec|Agent\(' plugins/stark-gh/commands/cleanup.md
./install.sh --status
```

### Phase 6: Regression and manual smoke

**Goal:** prove cleanup works end-to-end without regressing existing stark-gh commands.  
**Dependencies:** Phase 5.  
**Estimated effort:** M.

#### Tasks

**6a — Automated regression** (CI gate).

1. **Targeted cleanup suite.** Run all `plugins/stark-gh/tools/__tests__/cleanup/*.test.ts` — every preflight, execute, and integration test from Phases 1–5.
2. **Existing stark-gh regression.** Run plan, branch, shell-quote, PR-open arg, PR-merge arg/plan tests at minimum. Additive helper changes must not break previous commands.

**6b — Manual smoke** (documented checklist; reviewer-executed before merge).

3. In a sandbox repo with a disposable merged PR:
   ```bash
   /stark-gh:cleanup --pr <N> --dry-run     # → exit 0, plan path printed
   /stark-gh:cleanup --pr <N>               # → remote, local, worktree gone
   /stark-gh:cleanup --pr <N>               # → exit 3, nothing to do
   ```
4. Cross-repo dry-run check: from repo A, target a stale PR on repo B with `--repo OWNER/B --pr N --dry-run`. Plan shows remote-only actions; no local-side steps.

6a is the merge gate. 6b is the merge precondition (reviewer-attested checkbox in the PR description).

#### Risks

- Manual smoke destructive: sandbox repo + disposable PR only.
- Existing tests rely on old branch validation: `validateCleanupBranchName` is additive; `validateBranchName` unchanged.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/*.test.ts \
  plugins/stark-gh/tools/__tests__/*.test.ts
```

## 4. Integration Points

- **Plan-file** is the only preflight ↔ execute contract. Execute never re-parses raw args. `schemaVersion: 1` rejection at execute boundary; future v2 must be additive or coordinated.
- **Wrapper ↔ stages:** `cleanup.md` forwards `$ARGUMENTS` verbatim as one quoted `--raw-args` value. Only bash logic is the dry-run substring short-circuit (§2 resolution 4).
- **`gh.ts`** owns all GitHub API shapes and the active `gh` auth identity (including ref-path URL encoding).
- **`git.ts`** owns all local branch / worktree mutations.
- **`lib/output.ts`** owns the human table renderer and `--no-color` / TTY gating.
- **`lib/redact.ts`** scrubs every stderr emission; test snapshots must not leak tokens.
- **Incomplete preflight breaks safety gates; incomplete execute leaves partial deletion; incomplete README leaves operators unaware of squash-merge commit loss.**

## 5. Testing Strategy

- **Mock at `lib/gh.ts` and `lib/git.ts`** — never hit real network or run real `git` in unit tests.
- **Risk-first order:** exit codes, eligibility gates, SHA drift before audit / stale features.
- **Snapshot stderr tables** — they are part of the contract; pin and update intentionally.
- **No flaky time tests** — `--stale-days` uses the clock-injection seam (`now: () => Date.now()` default).
- **Integration is the gatekeeper** — `integration.test.ts` covers full preflight → plan-file → execute round-trip via shimmed `gh` and `git`, asserting stdout JSON, exit codes, and plan-file lifecycle.

Test focus per phase:

| Phase | New tests |
|-------|-----------|
| 1 | `plan_io.test.ts`, `gh_ref_encoding.test.ts` (+ extend `branch.test.ts`) |
| 2 | `preflight_args.test.ts`, `preflight_cross_repo.test.ts`, `preflight_protected.test.ts`, `auth_fail.test.ts` |
| 3 | `preflight_pr.test.ts`, `preflight_branch.test.ts`, `preflight_audit.test.ts`, `preflight_stale.test.ts`, `preflight_fork.test.ts` |
| 4 | `execute_happy.test.ts`, `execute_partial_failure.test.ts`, `execute_dry_run.test.ts`, `execute_worktree.test.ts`, `execute_pr_close_failure.test.ts`, `execute_head_sha_drift.test.ts`, `execute_cross_repo.test.ts`, `execute_no_color.test.ts` |
| 5 | `integration.test.ts` |
| 6a | full suite |
| 6b | manual checklist |

## 6. Rollback Plan

Each phase is rollback-safe in isolation because cleanup is a new command surface — no existing code paths are mutated, only extended additively.

- **Phase 1:** revert `types.ts` / `exit.ts` / `plan.ts` / `runtime.ts` / `branch.ts` / `git.ts` / `gh.ts` additions; delete the scaffold `.ts` files. Existing PR-open / PR-merge tests stay green by construction (additive-only).
- **Phase 2:** revert preflight; Phase-1 scaffolds remain inert (no command discovers them yet).
- **Phase 3:** revert preflight resolution; preflight scaffold from Phase 2 remains harmless.
- **Phase 4:** revert execute; no slash-command discovers it yet.
- **Phase 5:** delete `commands/cleanup.md` first — the slash command becomes undiscoverable. Then revert README. Tools and plan-files on disk are inert; users can `rm -rf ~/.claude/code-review/stark-gh/cleanup/` if desired.
- **Phase 6:** docs-only; revert if smoke uncovers an impl bug, then re-attempt.

**Post-merge rollback:** remove `commands/cleanup.md` to disable invocation; revert TS files in a follow-up. Failed plan files are inert JSON and can be retained for debugging.

**Destructive-run rollback is not provided by the command.** GitHub's 90-day branch-restore window and local `git reflog` (~30 days) are the only paths back from an *executed* run. The README's squash-merge note warns about this.
