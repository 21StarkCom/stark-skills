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
4. **Dry-run stdout contract.** Codex's plan proposed a `STARK_GH_CLEANUP_DRY_RUN=1` sentinel; the design specifies path-only stdout. **Resolution (revised after plan-review round 1):** preflight emits a **single-line JSON envelope** on stdout: `{"planFile":"<path>","dryRun":true|false,"truncated":bool}`. The wrapper parses that JSON, propagates preflight's exit code if non-zero, and skips execute when `dryRun` is true. **Substring-matching `$ARGUMENTS` is rejected** — it misfires on `--branch '--dry-run'` and on `--dry-run=value` forms (plan-review M2/M9/M18/M46/M58). The preflight CLI flag stays `--emit-plan-path` for naming continuity but the *content* is now JSON; rename internally to `emitMachineEnvelope` if desirable (Phase 1 Task 8, Phase 5 Task 1).
5. **`cross-repo-no-checkout` skip reason.** Machine key is `cross-repo-no-checkout`; human-rendered label is `cross-repo (no local checkout)` (Phase 4, Task 3).
6. **`--no-color` flag.** Documented in the design but absent from both candidate plans. **Resolution:** parse in Phase 2; thread through `lib/output.ts` to suppress ANSI in stderr table; assert via `preflight_no_color.test.ts` and an `execute_no_color.test.ts` snapshot (Phase 4, Task 5).
7. **`--stale-author-self-only` in `argument-hint`.** Defaults on; was missing from the skeleton's `argument-hint`. **Resolution:** include `[--stale-author-self-only[=true|false]]` (Phase 5, Task 1). **Setting `--stale-author-self-only=false` requires also passing `--allow-foreign-authors`** as an explicit power-user acknowledgement (plan-review H8). Both flags together print a one-line stderr warning at preflight: `"WARNING: --stale-author-self-only=false will close PRs from other authors under your gh identity (<authUser>). This is visible publicly. Pass --allow-foreign-authors to confirm."` Preflight exits `EXIT_BAD_ARGS` if `--stale-author-self-only=false` is set without `--allow-foreign-authors`.
8. **PR-state eligibility.** The design's PR-mode flow records `state` (merged / closed / open / draft) but never specified what happens for `--pr N` on an *open non-stale* PR. Cross-review (round 1) flagged this as a critical viability hole: silent remote-delete with the PR still open. **Resolution:** add `pr-open` to the skip-reason union and gate explicitly: **merged / closed → action; open + non-stale → skip `pr-open`; open + stale (via `--stale-days` + filter pass) → `needsPrClose: true`; draft → require `--include-drafts`** (Phase 3, Task 1). Plan-review C53/H28/H35/H36/H42/H54.
9. **Ref-path encoding shape.** Phase 1 Task 7 originally specified `encodeURIComponent`-equivalent semantics, which would encode `/` as `%2F` and break the GitHub `/repos/{o}/{r}/git/refs/heads/{ref}` path. **Resolution:** **per-segment encoding** — split branch on `/`, `encodeURIComponent` each segment, rejoin with literal `/`. `feat/foo-ñ` → `feat/foo-%C3%B1`, not `feat%2Ffoo-%C3%B1`. Update `gh_ref_encoding.test.ts` assertions accordingly (plan-review C41).
10. **Branch-reuse / stale PR head identity.** A closed PR's head ref name can be reused for an unrelated branch (someone created `feat/x` again after the original was deleted and a new PR opened on it). The design conflates "branch name" with "PR head identity." **Resolution:** when resolving a PR-mode action, the *current* remote head SHA (`gh.ts:getRemoteHeadRef`) MUST equal `pr.head.sha` recorded on the PR — if not, skip with `branch-reused` (Phase 3, Task 1; new skip reason in Phase 1 Task 1). Plan-review C52.
11. **Stale-PR closure freshness re-check.** `closePrWithComment` ran before remote-SHA drift re-check, so an author who pushed activity between preflight and execute could have their PR closed under stale data. **Resolution:** Phase 4's execute step ordering moves the drift re-check (and an additional PR-state re-fetch for `needsPrClose` actions) **before** PR closure (Phase 4, Task 2). Step 1 becomes "Stale-freshness re-check" and Step 2 becomes "PR closure"; the prior Step 1/2 swap. Plan-review C53/H28/H35.
12. **`--stale-days` triggers audit unexpectedly.** The plan's mode-resolution said audit fires when neither `--pr` nor `--branch` is set, which meant `/stark-gh:cleanup --stale-days 30` *also* triggered a closed-PR audit. **Resolution:** audit fires only when **none of `--pr`, `--branch`, `--stale-days`** is set (Phase 2, Task 4). Plan-review H37.
13. **Worktree branch scoping.** Phase 3 Task 6 enumerated `listWorktrees()` and stored *all* worktrees on each action; a worktree on a different branch could end up on action `feat/x` if `listWorktrees` returned global data. **Resolution:** filter strictly to worktrees whose checked-out branch equals the action's branch; exclude the main worktree (`bare: false, path === plan.cwdToplevel`) (Phase 3, Task 6). Plan-review H55.
14. **`git check-ref-format --branch` resolves shortcuts.** Using `--branch` interprets `@{-N}`, `@{u}`, `HEAD~1` and similar rev-parse shortcuts rather than validating the literal name. **Resolution:** use `git check-ref-format refs/heads/<name>` (no `--branch` flag) — validates the literal ref name (Phase 1, Task 5). Plan-review H45.
15. **Case-sensitive protected list.** Hardcoded `["main", "master", "develop"]` misses repos with `Main`/`Master` or refs that differ only by case. **Resolution:** lowercase-fold both the hardcoded set and each candidate before set-membership comparison (Phase 2, Task 3). Plan-review M24.
16. **PR-close atomicity** (revised after plan-review H7/H13/H25 final round). `closePrWithComment` was originally specified as atomic via a claimed "single GraphQL mutation"; that claim is unsubstantiated. **Final resolution:** the safety mechanism is **re-fetch-then-act**, not atomicity:
    - Phase 1 Task 7 pins the implementation to `gh pr close <n> --comment "..." --repo <repo>` (single invocation).
    - On non-zero exit, `closePrWithComment` re-fetches the PR state. If now `closed`/`merged`, return `"already-closed"` (a mid-network failure landed the close server-side; `gh` lost the response). Otherwise return `{ error }`.
    - Phase 4 Step 2 treats `"already-closed"` as success and proceeds to remote delete; treats `{ error }` as failure and does NOT proceed to remote delete (the open-PR-no-branch safety invariant).
    - Worst case is a "Closed by /stark-gh:cleanup" comment surfacing on a still-open PR — visible on the next re-run, where the same `closePrWithComment` retries and either confirms close or surfaces a persistent error. The operator can manually close + comment-delete if surprised.
    Cross-repo PR closure MUST pass `--repo` explicitly. Plan-review H7/H13/H25/H30/M17/M26/M50/H39.
17. **Execute defense-in-depth.** Cross-review flagged that execute trusts the plan file unconditionally (identity, protected set, cwd/origin). Plan file lives at mode-0600 between processes, but that protects against other OS users, not against stale retained plans, hand-crafted plans, or identity swaps between preflight and execute. **Resolution:** Phase 4 gains an explicit **execute pre-flight re-validation task** (new Task 1 below the read-plan task). Steps: `ghCurrentUser()` must equal `plan.authUser`; `chdir(plan.cwdToplevel)`; `git remote get-url origin` must equal `plan.originUrl`; re-derive protected list and short-circuit any action whose branch is now protected — regardless of plan flags. Plan-review H0/H1/H23/H30/C52.
18. **Self-worktree removal.** If the operator launched `/stark-gh:cleanup` from inside a worktree that is now a candidate for removal, `git worktree remove --force` would yank the cwd out from under the running process. **Resolution:** Phase 4 Step 4 skips a worktree whose `path.resolve()` equals `path.resolve(plan.cwdToplevel)` with `skipReason: "current-worktree"` and a clear stderr warning telling the operator to re-run from a different worktree (Phase 4, Task 2 Step 4 + new skip reason in Phase 1 Task 1). Plan-review M7.

### Design refinements proposed by plan review

Plan-review round 1 raised legitimate safety concerns about the design's blanket "always `git worktree remove --force` + `git branch -D`" decision. The design accepted this risk in the context of explicitly-named candidates (`--pr N`, `--branch NAME`) but the same default applied transitively to **auto-discovered** candidates (audit mode, stale-open mode) — where the operator never named the branch and therefore did not knowingly opt into destruction.

**This plan tightens the default for auto-discovered candidates only**, preserving the design's behaviour for user-named candidates:

| Candidate source | Dirty worktree | `local.ahead > 0` |
|---|---|---|
| `--pr N` (explicit) | force-remove (design) — preflight emits a stderr **warning line per action** | force-`branch -D` (design) — same warning |
| `--branch NAME` (explicit) | same as above | same as above |
| `audit-pr` / `audit-gone-branch` (auto) | **skip** with `skipReason: "worktree-dirty"` | **skip** with `skipReason: "local-ahead"` |
| stale-open (auto, via `--stale-days`) | **skip** with `"worktree-dirty"` | **skip** with `"local-ahead"` |

Operators can flip auto-discovered candidates back to destructive with `--include-dirty` (covers both dirty worktrees and ahead-branches). The design's force-remove semantics are unchanged for explicit candidates. Plan-review C33/H13/H31/H34/H43/H44/H56.

New skip-reason union members for this refinement: `worktree-dirty`, `local-ahead`. New summary counters: `summary.dirtyWorktrees`, `summary.localAhead`. New flag: `--include-dirty` (default off; Phase 2, Task 1; Phase 5, Task 1 argument-hint).

### Design-level decisions retained against plan-review pressure

Some plan-review findings argued for further safety tightening beyond what the design specifies. These are explicit decisions to honour the original design intent:

- **Explicit `--pr N` / `--branch NAME` on dirty worktrees or local-ahead branches still force-removes** (plan-review C0/C33/H13/H43/H56 carried across rounds). The design says "always `git worktree remove --force`, mirroring `/clean_gone`. The user accepted this risk." When the operator names a branch explicitly, they have selected it for destruction — the dirty/ahead default-skip applies to **auto-discovered** candidates only (audit + stale modes; see §2 refinements). To prevent surprise, preflight emits one stderr warning per dirty/ahead explicit action (`"WARNING: --pr <N> targets <branch> with dirty worktree at <path>; force-removing per design."`) so the operator sees the cost before execute starts. Reviewers' suggestion to require `--include-dirty` even for explicit modes is rejected: it would make the most common cleanup path (just-merged PR with local worktree still up) need a second flag the operator probably wouldn't think to add. If post-deployment usage shows operators actually losing work this way, revisit in v2.

### Deferred to v2 (acknowledged plan-review findings)

The following plan-review findings are acknowledged as real concerns but deferred:

- **GitHub branch protection / rulesets query** (plan-review H57). Querying `gh api repos/.../branches/<name>/protection` for every candidate adds an API round-trip per action plus permissions complexity. v1 relies on the hardcoded list + repo default + current HEAD. Operators with custom long-lived release branches should add them to the hardcoded list. Re-evaluate after first month of production use.
- **Per-subprocess timeout + SIGINT handler** (plan-review M19). Cleanup runs interactively under a user shell; the operator can `Ctrl-C` the parent. A hung `gh api` will be visible. The action-start audit line (plan-review M15) provides post-hoc visibility into which action was in-flight at SIGINT. v2 should add per-step timeouts via the existing `ExecFn` boundary if real cases emerge.
- **Node minimum version preflight check** (plan-review M49). `gh ≥2.40` is now preflight-checked (Phase 2 Task 2) because `gh pr close --comment` requires it. Node + git version checks remain README-documented only — Node ≥22.6 for `--experimental-strip-types`, git ≥2.30 — because their failure modes are immediately diagnostic (Node prints `unknown option --experimental-strip-types`; git prints unknown-flag errors). Hard version-mismatch exits for Node/git deferred to v2.

### Out-of-band dependency

A sandbox repo with at least one disposable merged/closed PR for the Phase 6 manual smoke. Provision before Phase 6.

## 3. Phases

### Phase 1: Shared schema, exit codes, helpers, plan I/O

**Goal:** typed contracts and reusable argv-safe primitives before any command logic exists.  
**Dependencies:** none.  
**Estimated effort:** M.

#### Tasks

1. **Extend `lib/types.ts`** with the full schema. `schemaVersion: 1` is a literal type. `CleanupSkipReason` is a union of the safety/discovery reasons:

   ```ts
   type CleanupSkipReason =
     | "protected" | "fork" | "not-found" | "pr-not-found"
     | "head-sha-drift" | "cross-repo-no-checkout"
     | "pr-open"             // §2 resolution 8
     | "branch-reused"       // §2 resolution 10 (remote-side)
     | "local-branch-reused" // plan-review C44 (local-side)
     | "freshness-changed"   // §2 resolution 11 — stale PR no longer stale at execute
     | "worktree-dirty"      // §2 refinements (auto-discovered candidates)
     | "local-ahead"         // §2 refinements
     | "current-worktree"    // §2 resolution 18
     | "already-clean"       // plan-review H25 (re-run of cleaned PR — nothing to do)
     | "live-dirty"          // plan-review H18 (live dirty re-check at execute)
     | "live-ahead";         // plan-review H18 (live ahead re-check at execute)
   ```

   `summary.skipReasons` is `Record<string, number>` at runtime (open map for forward-compat).

   **`CleanupSource` shape** (plan-review round-6 critical):

   ```ts
   type CleanupSourceType =
     | "pr"                  // explicit --pr N
     | "branch"              // explicit --branch NAME
     | "audit-pr"            // audit mode, closed PR head ref still on remote
     | "audit-gone-branch"   // audit mode, [gone] local branch
     | "stale-only";         // --stale-days discovery (only open PRs older than cutoff)

   interface CleanupSource {
     type: CleanupSourceType;
     prNumber?: number;      // present for pr / audit-pr / stale-only
     prState?: "open" | "closed" | "merged";
     prUpdatedAt?: string;
     prMergedAt?: string | null;
     prAuthor?: string;      // PR author login (used for --stale-author-self-only filter)
     prHeadSha?: string;     // pr.head.sha at preflight (used for branch-reuse + local identity)
     prMergeCommitSha?: string | null;  // for merged PRs (informational; NOT used for identity per C2)
   }
   ```

   **`CleanupAction` shape (enumerated exhaustively — plan-review H10):**

   ```ts
   interface CleanupAction {
     id: string;                              // stable monotonic id within plan
     branchName: string;
     sources: CleanupSource[];                // ordered: explicit (pr|branch) first, auto-discovered second (M16/M24)
     primaryPrSource: CleanupSource | null;   // pinned for needsPrClose; null when no PR involved
     needsPrClose: boolean;
     remote: { exists: boolean; headSha: string | null };
     local:  { exists: boolean; headSha: string | null;
               ahead: number | null; behind: number | null;
               hasUpstream: boolean } | null;  // null in cross-repo mode
     worktrees: WorktreeInfo[];               // branch-scoped, non-main (M6 production path: filesystem re-check on remove)
     dirtyWorktreesForGate: WorktreeInfo[];   // ALL branch-matching incl. main (plan-review H23) — used by dirty-gate only
     skip: boolean;
     skipReason: CleanupSkipReason | null;
     error: { code: string; stderr: string } | null;
     prClosureSkippedReason?: "already-closed";   // when needsPrClose but PR already terminal
   }
   ```

   **`CleanupPlan` top-level fields (enumerated exhaustively):**

   ```ts
   interface CleanupPlan {
     schemaVersion: 1;
     createdAt: string;                       // ISO8601
     command: "stark-gh:cleanup";
     repo: { owner: string; name: string; nameWithOwner: string;
             defaultBranch: string; nodeId: string };   // plan-review M9: GitHub repo node ID for identity stability
     cwdRepo: string;                         // owner/name
     cwdGitDir: string;                       // absolute path from git rev-parse --git-dir
     cwdToplevel: string;                     // absolute realpath of git rev-parse --show-toplevel
     originUrl: string;                       // canonicalised + credential-free (see H0/H9/H23/H29 resolution below)
     authUser: string;
     crossRepo: boolean;
     mode: "pr" | "branch" | "audit" | "mixed";
     flags: CleanupFlags;
     protected: {
       branches: string[];                     // hardcoded ∪ defaultBranch (lowercased)
       defaultBranch: string;
       currentHead: string | null;             // snapshotted at preflight — execute does NOT re-derive (plan-review C0)
     };
     actions: CleanupAction[];
     summary: CleanupSummary;
   }
   ```

   **`CleanupFlags` (every accepted CLI flag persisted; plan-review M8/M14/M19/M22/M27/M28):**

   ```ts
   interface CleanupFlags {
     dryRun: boolean;
     staleDays: number | null;
     includeDrafts: boolean;
     staleAuthorSelfOnly: boolean;
     allowForeignAuthors: boolean;            // required when staleAuthorSelfOnly === false
     staleAuthorAllowlist: string[];          // --stale-author <login[,login...]> (plan-review M5)
     allowNoPrMatch: boolean;
     auditMaxPrs: number;                     // parsed from --audit-max-prs N (plan-review M19/M22)
     includeDirty: boolean;
     noColor: boolean;
   }
   ```

   **`CleanupUserArgs` (the raw parsed surface — comma-lists supported per plan-review M27):** `prs: number[]`, `branches: string[]`, `repo: string | null`, plus all the `CleanupFlags` fields. Comma splitting for `--pr` and `--branch` happens in `parseRawArgs` before per-item validation; repeated flags are merged (last-wins for scalar, append for array).

   **`CleanupSummary`:** `candidates`, `actionable`, `skipped`, `skipReasons: Record<string, number>`, `dirtyWorktrees`, `localAhead`, `staleFiltered: { byAuthor: number; byDraft: number }`, `truncated: boolean`, `prunedPlans: number` (count of expired plans removed in this preflight; plan-review M2/M13).

   Done when `tsc --noEmit` passes; existing PR-open / PR-merge plan tests still pass; every field above is exercised by at least one test in `__tests__/cleanup/`.

2. **Extend `lib/exit.ts`** with:
   ```ts
   export const CleanupExit = {
     OK: 0, BAD_ARGS: 2, NOTHING_TO_DO: 3,
     PARTIAL_FAILURE: 4, UNRECOVERABLE: 5, BUG: 64,
   } as const;
   ```
   Done when cleanup tools import `CleanupExit` (not `Exit` or `MergeExit`). Exit-code **precedence** at execute end-of-run, evaluated in this order:
   1. Unrecoverable startup error (gh auth fail, identity mismatch, origin URL mismatch, plan-file IO fail) → `EXIT_UNRECOVERABLE`.
   2. Any action with `error` → `EXIT_PARTIAL`.
   3. `summary.candidates > 0 && summary.actionable === 0 && summary.skipReasons["pr-not-found"] === summary.candidates && !flags.allowNoPrMatch` → `EXIT_BAD_ARGS` (plan-review M8: every input resolved to not-found PRs).
   4. `summary.actionable === 0` → `EXIT_NOTHING_TO_DO`.
   5. Otherwise → `EXIT_OK`.

3. **Extend `lib/plan.ts`** to export:
   ```ts
   export function validateCleanupPlan(p: unknown): asserts p is CleanupPlan
   export function readCleanupPlan(filepath: string): CleanupPlan
   export function writeCleanupPlan(filepath: string, plan: CleanupPlan): void
   ```
   If existing `plan.ts` is hard-coded to PR-open/PR-merge shapes, factor the read/write/validate path generically. Done when `plan_io.test.ts` round-trips a hand-written `CleanupPlan` JSON and existing plan tests stay green.

4. **Extend `lib/runtime.ts`** with the cleanup-specific helpers:
   - `cleanupDir(): string` / `ensureCleanupDir(): string` / `mktempInCleanup(template?: string): string`. Dir mode `0700`, file mode `0600`.
   - **`pruneOldPlans(maxAgeDays = 30): { pruned: number; failed: number }`** — deletes plan-files in `cleanupDir()` matching `<ts>-<rand>.json` whose mtime is older than `maxAgeDays`. **Race safety** (plan-review M2): files younger than **1 hour** are NEVER pruned, even if their mtime appears stale, so a concurrent execute run cannot lose its plan-file to a sibling preflight's prune. **Failure semantics** (plan-review M13): best-effort — catch all errors internally, log each failure as a single stderr warning (`"pruneOldPlans: could not remove <path>: <error>"`), continue. Returns counts; the `pruned` value is recorded in `plan.summary.prunedPlans` so the audit log captures it. Each pruned path is printed on its own stderr line (plan-review M2) so the operator sees what was removed.
   - `auditLogPath(): string` — returns `<cleanupDir>/.audit.jsonl` (mode `0600`).
   - `appendAuditLine(entry: object): void` — implements the lockfile + rotation semantics from Phase 4 Task 10.

   Path: `~/.claude/code-review/stark-gh/cleanup/<ts>-<rand>.json`. Reuse existing tempdir primitives and atomic-write semantics; sandbox fallback mirrors existing pattern. Done when `ls -ld` shows `drwx------` on the dir and `-rw-------` on written plan files / audit log, and `plan_retention.test.ts` asserts:
   - Old plans pruned on a successful preflight (M16).
   - Plans newer than 1h NOT pruned (M2 race).
   - Failed prune (e.g., `sudo`-owned file) → warning on stderr + `failed` counter increments + run continues (M13).

5. **Extend `lib/branch.ts`** with `validateCleanupBranchName(name: string): ValidationResult`. Accept Unicode and slashes; reject `HEAD`, `@`, `-`, leading `-`, control chars, `..`, empty. Validate the literal ref form via **`git check-ref-format refs/heads/<name>`** (not `git check-ref-format --branch <name>` — the `--branch` form resolves rev-parse shortcuts like `@{-N}`, `@{u}`, `HEAD~1` rather than validating the literal name; §2 resolution 14, plan-review H45). **Do not** replace existing `validateBranchName` — additive only, so PR-open / PR-merge behaviour is unchanged. Add `branch_validation.test.ts` cases for `@{-1}`, `@{u}`, `HEAD~1`, valid Unicode + slash names.

6. **Extend `lib/git.ts`** with: `localBranchExists`, `localBranchOid`, `deleteLocalBranch(name, force, cwd)`, **`listWorktrees(cwd): WorktreeInfo[]`** where `WorktreeInfo = { path: string; branch: string | null; bare: boolean; isMain: boolean; dirty: boolean }` (dirty computed via `git -C <wt.path> status --porcelain` non-empty; plan-review H32/H37/H43), `removeWorktree(path, force, cwd)`, `listGoneLocalBranches(cwd)`, `lsRemoteHeads(cwd)`, `aheadBehind(branch, cwd): { ahead: number | null; behind: number | null; hasUpstream: boolean }`. Every helper takes an injectable `cwd` argument (no process-global `chdir`) and an injectable `ExecFn`. Subprocess calls are argv-only.

7. **Extend `lib/gh.ts`** with:
   - **`repoView({ repoSlug })`** — returns `{ nameWithOwner, defaultBranch, cloneUrl, nodeId, ... }`. Includes `nodeId` for identity stability (plan-review M9).
   - **`ghCurrentUser()`** — returns the current `gh` user login.
   - **`ghVersion()`** — runs `gh --version`, parses the leading `gh version X.Y.Z`, returns `{ major, minor, patch }`. Used by Phase 2 Task 2's version probe.
   - **`canonicaliseOrigin(url): string`** — credential-strip + SSH-to-canonical + host alias resolution + lowercase + `.git` strip (see Phase 4 Task 2 details).
   - **`fetchCleanupPr(repoSlug, number): CleanupPr | null`** (returns `null` for 404):
     ```ts
     interface CleanupPr {
       number: number;
       state: "open" | "closed" | "merged"; // "merged" is a derived synthetic state when mergedAt != null
       mergedAt: string | null;
       mergeCommitSha: string | null;       // for merged PRs (plan-review H19/M18); null for closed-not-merged
       updatedAt: string;
       isDraft: boolean;
       head: { ref: string; sha: string;
               repo: { fullName: string } | null };  // head.repo nullable for deleted forks (plan-review H11)
       base: { ref: string; repo: { fullName: string } };
       author: { login: string };
     }
     ```
     When `head.repo === null` (deleted fork), preflight treats it as automatic `skipReason: "fork"` — no way to verify identity against base.
   - **`listClosedPulls(repoSlug, opts)`**, **`listOpenPulls(repoSlug, opts)`** — both `--paginate --per-page=100`, capped by `auditMaxPrs`. **Stale mode sort:** `listOpenPulls` accepts `{ sort: "updated", direction: "asc" }` for stale scans so the OLDEST PRs come first within the cap (plan-review M26). Audit mode uses default desc sort.
   - **`getRemoteHeadRef(repoSlug, branch)`** — returns `{ sha: string; committerDate: string } | null` (404 → `null`). `committerDate` is used for force-push-to-same-SHA detection (plan-review H8 — a ref that points at the PR's head SHA but with a `committerDate` newer than `pr.merged_at` indicates a re-created branch on the same commit).
   - **`deleteRemoteHeadRef(repoSlug, branch)`** — returns success / 404-treated-as-success / 422-"Reference does not exist"-treated-as-success / failure.
   - **`closePrWithComment({ repoSlug, number, comment }): "closed" | "already-closed" | { error }`** — implemented as **single `gh pr close <n> --comment "..." --repo <repo>` invocation**. The atomicity behaviour is conservative (plan-review H7/H13/H25): on non-zero exit from `gh`, **re-fetch the PR state** (`fetchCleanupPr`) and:
     - If state is now `closed` or `merged` → return `"already-closed"` (the close succeeded server-side; `gh` lost the response). Caller proceeds to remote delete.
     - If state is still `open` → return `{ error }`. Caller records the error and does NOT proceed to remote delete (the safety invariant).
     This pattern uses re-fetch-then-act as the actual safety mechanism; we do NOT rely on any claimed atomicity of `gh pr close --comment`. The PR comment is durable server-side once the API call lands; if `gh` mid-network failure leaves a "Closed by /stark-gh:cleanup" comment on a still-open PR, the operator sees it on re-run when the same action's `closePrWithComment` retries (idempotent via the re-fetch path).

   All argv-only. **Centralise ref-path URL encoding** here — **per-segment encoding** (§2 resolution 9; plan-review C41): branch names are split on `/`, each segment runs through `encodeURIComponent`, then rejoined with literal `/`. Preflight and execute call these helpers, never construct API paths inline. Done when `gh_ref_encoding.test.ts` asserts: literal `/` preserved, `#`/`?`/non-ASCII encoded per-segment, multi-slash refs (`release/2026/q1`) round-trip cleanly.

8. **Scaffold preflight + execute + audit-append entry points + minimal `validateExecutionContext` seam.** Create `gh_cleanup_preflight.ts`, `gh_cleanup_execute.ts`, and `gh_cleanup_audit_append.ts` (one-shot audit-log writer used by the wrapper-handoff path; argv: `--stage <stage> --plan-file <path> [--dry-run <bool>]`) with `main()` stubs. Preflight reads `--raw-args`, accepts `--emit-plan-path`, and emits a **single-line JSON envelope** on stdout: `{"planFile":"<path>","dryRun":bool,"truncated":bool}` (§2 resolution 4). Execute reads `--plan-file`.

    **`validateExecutionContext(plan, { exec }): void`** ships in Phase 1 as a tiny helper in `gh_cleanup_execute.ts` (initial implementation: returns immediately — no checks). Phase 4 Task 2 fills in the body (auth identity, cwd anchor, self-worktree gate, protected re-derivation). The Phase 1 stub test calls this helper and asserts it does not throw (plan-review H20/H24/M20: Phase 1 deliverable does NOT depend on Phase 4 implementation; Phase 4 layers logic into the existing helper).

    Both stubs round-trip a no-op plan and exit `0`. No business logic beyond plan I/O and the empty `validateExecutionContext`. Done when both stubs run end-to-end with a hand-crafted plan-file, `wrapper_envelope.test.ts` asserts preflight stdout parses as JSON with the three required keys, and `validate_execution_context.test.ts` asserts the helper exists and is callable.

#### Risks

- Shared helper changes break PR-open / PR-merge: keep old signatures backward-compatible (additive overloads only).
- `lib/plan.ts` too tightly coupled to existing shapes: factor generically in this phase; the refactor is small and pays for itself in Phases 4+.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/plan.test.ts \
  plugins/stark-gh/tools/__tests__/branch.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/plan_io.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/gh_ref_encoding.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/branch_validation.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/plan_retention.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/wrapper_envelope.test.ts
```

### Phase 2: Preflight — arg parsing, repo context, protection, auth

**Goal:** preflight resolves args + repo + auth + protection list with deterministic exit codes. No candidate resolution yet.  
**Dependencies:** Phase 1.  
**Estimated effort:** M.

#### Tasks

1. **`parseRawArgs(raw: string): CleanupUserArgs`** inside `gh_cleanup_preflight.ts` (no new lib file). Tokenise via `lib/shell_quote.ts`. **Comma-list parsing** (plan-review M27): `--pr 1,2,3` and `--branch foo,bar` are split on `,` before per-item validation; repeated flags append (`--pr 1 --pr 2,3` → `[1,2,3]`); whitespace around commas is trimmed.

   **Accepted flags** (every flag mentioned in this plan; plan-review M14/M19/M22/M28):

   | Flag | Validation | Default |
   |---|---|---|
   | `--pr N[,N,...]` | each post-split value `^[1-9][0-9]*$` | (empty) |
   | `--branch NAME[,NAME,...]` | each value passes `git check-ref-format refs/heads/<name>` and is not in reject set (`HEAD`, `@`, `-`, leading `-`, `..`, control chars) | (empty) |
   | `--repo OWNER/NAME` | matches `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` | cwd origin |
   | `--stale-days N` | positive integer | off |
   | `--include-drafts` | bare flag | false |
   | `--stale-author-self-only[=true|false]` | boolean; setting `=false` REQUIRES `--allow-foreign-authors` | true |
   | `--allow-foreign-authors` | bare flag — gates `--stale-author-self-only=false` | false |
   | `--stale-author <login[,login,...]>` | extra allowed authors (plan-review M5) | [] |
   | `--include-dirty` | bare flag — bypasses auto-discovered dirty/ahead default-skip | false |
   | `--dry-run` | bare flag only; `--dry-run=anything` rejected | false |
   | `--allow-no-pr-match` | bare flag | false |
   | `--audit-max-prs N` | positive integer (plan-review M19/M22) | 500 |
   | `--no-color` | bare flag | false |

   Any other flag → reject with offending token verbatim on stderr; exit `EXIT_BAD_ARGS`. Done when `preflight_args.test.ts` covers each rejection case AND positive cases for `--pr 1,2,3`, `--branch a,b`, `--audit-max-prs 1000`, `--stale-author bot1,bot2`, `--stale-author-self-only=false --allow-foreign-authors`.

2. **Repo + auth context + cwd anchoring.** Use `gh.ts:repoView()` with `--repo` override; this MUST also return `node_id` so `plan.repo.nodeId` is populated (plan-review M9 — repo identity stability across renames/deletions). Compute `plan.crossRepo` via `canonicaliseOrigin(git remote get-url origin) !== canonicaliseOrigin(plan.repo.cloneUrl)`.

   **Record cwd + origin invariants:**
   - `plan.cwdGitDir` ← `git rev-parse --git-dir` (absolute).
   - `plan.cwdToplevel` ← `fs.realpathSync(git rev-parse --show-toplevel)` (resolves symlinks; plan-review H2).
   - `plan.originUrl` ← `canonicaliseOrigin(git remote get-url origin)` — credential-free canonical form ONLY. The raw URL is never persisted in the plan, audit log, or stdout. This is the single contract; Phase 4's re-validation reads `plan.originUrl` and compares to `canonicaliseOrigin(live origin)`. Plan-review H0/H9/H23/H29.

   Resolve `authUser` via `gh.ts:ghCurrentUser()`. **`authUser` resolution failure with `--stale-days` + `--stale-author-self-only=on` (default) → exit `EXIT_UNRECOVERABLE`** (the safety filter cannot be evaluated; we don't silently widen scope).

   **`gh` version probe** (plan-review M10): run `gh --version` and parse the leading `gh version X.Y.Z` line. If the resolved version is `< 2.40` AND (`--stale-days` is set OR any candidate ends up with `needsPrClose: true`) → exit `EXIT_UNRECOVERABLE` with `"gh CLI >=2.40 required for stale-PR closure (single 'gh pr close --comment' form). Detected: <version>."` Cleanup without `needsPrClose` actions tolerates older `gh`.

   Done when `preflight_cross_repo.test.ts` proves the boundary, `auth_fail.test.ts` covers the fail-loud path, `preflight_cwd_anchor.test.ts` asserts cwd/origin fields round-trip into the plan (with symlinked toplevel and credentialled origin fixtures), and `preflight_gh_version.test.ts` covers gh ≥2.40 / <2.40 with/without `--stale-days`.

3. **Protection list — snapshotted at preflight** (plan-review C0). Compute `plan.protected.{branches, defaultBranch, currentHead}` ONCE at preflight and serialise to the plan-file. Execute reads this snapshot via `validateExecutionContext` and re-derives only the deterministic portion (`["main","master","develop"]` + `defaultBranch`), unioned with the snapshotted `currentHead`. Execute does NOT call `git rev-parse --abbrev-ref HEAD` at validate time — the operator could have legitimately moved HEAD between preflight and execute.
   - Hardcoded list: `["main", "master", "develop"]`.
   - `repo.defaultBranch` (from `gh.ts:repoView`) is added.
   - Same-repo + non-detached HEAD: `plan.protected.currentHead = git rev-parse --abbrev-ref HEAD`.
   - Detached HEAD or cross-repo: `plan.protected.currentHead = null` (plan-review M12).
   - **Lowercase-fold both the protected set and each candidate branch before set-membership comparison** (§2 resolution 15, plan-review M24): `Main`, `Master`, `Develop` are protected too.
   - Protected branches remain in `plan.actions` as `skip: true, skipReason: "protected"` — not filtered out — so the summary table is faithful.

   Add `preflight_protected.test.ts` cases for `Main`, mixed-case `Develop`, detached HEAD, default-branch-renamed.

4. **Mode + flags.** Compute `mode`: `pr` / `branch` / `audit` / `mixed` (≥2 of `--pr`/`--branch`/`--stale-days`). **Audit fires only when none of `--pr`, `--branch`, `--stale-days`** is set (§2 resolution 12, plan-review H37) — `--stale-days 30` alone is *stale-open mode*, not audit. `--repo` does **not** change mode (only affects `crossRepo`). Populate `plan.flags`: `dryRun`, `staleDays`, `includeDrafts`, `allowNoPrMatch`, `auditMaxPrs: 500`, `staleAuthorSelfOnly: true`, `includeDirty: false`, `noColor`.

#### Risks

- Wrapper dry-run drift: dry-run is signalled by the **JSON envelope** emitted by preflight on stdout (§2 resolution 4 revised). The wrapper parses that envelope; no `$ARGUMENTS` substring matching anywhere.
- `gh repo view` / `gh api user` failures pre-mutation should be unrecoverable: map to exit `5`.
- **originUrl credential leak risk** (plan-review H0/H9/H14/H23/H29/H45): `git remote get-url origin` may return `https://user:token@github.com/...`. **Resolution:** `plan.originUrl` is stored in **canonicalised + credential-free** form ONLY — the output of `canonicaliseOrigin(rawUrl)`. The raw URL is never written to the plan-file, audit log, stderr, or stdout. The same contract applies to any reporting: if execute needs to display the origin in an error message, it uses `plan.originUrl` (already canonicalised) and never re-reads the live raw URL into a user-facing message. `lib/redact.ts` provides an additional safety net for stderr emission of any string that might transit credentials (e.g., `gh` error messages), but the primary safeguard is the canonicalisation contract. Verify in `preflight_cwd_anchor.test.ts` with HTTPS-with-creds and SSH-form fixtures; assert `plan.originUrl` matches the canonical form and never contains the credential.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_args.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_cross_repo.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_protected.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_cwd_anchor.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/auth_fail.test.ts
```

### Phase 3: Candidate resolution and plan writing

**Goal:** resolve `--pr`, `--branch`, `--stale-days`, audit inputs into one deduplicated cleanup plan written to disk.  
**Dependencies:** Phase 2.  
**Estimated effort:** L.

#### Tasks

1. **PR mode** (eligibility matrix per §2 resolution 8 + branch-reuse check per §2 resolution 10). For each `--pr N`, call `gh.ts:fetchCleanupPr(repo, n)` → state, `merged_at`, `head.ref`, `head.sha`, `head.repo.full_name`, `base.repo.full_name`, `updated_at`, `isDraft`, `author.login`. Build `CleanupAction` with `source.type: "pr"`.

   Apply the eligibility matrix:

   | PR state | Without `--stale-days` (or `--stale-days` doesn't include it) | With `--stale-days` selecting it |
   |---|---|---|
   | `merged` | action (eligible) | action |
   | `closed` (not merged) | action | action |
   | `open` (non-draft) | **skip `pr-open`** | action with `needsPrClose: true` |
   | `open` (draft) | **skip `pr-open`** (no `--include-drafts`) or **skip `pr-open`** (with `--include-drafts` but not stale) | action with `needsPrClose: true` (only if `--include-drafts`) |

   Detect forks (`head.repo.full_name !== base.repo.full_name`) → `skip: true, skipReason: "fork"`. 404 → `skip: true, skipReason: "pr-not-found"`; **fail `EXIT_BAD_ARGS` unless `--allow-no-pr-match`** (see Phase 1 Task 2's exit-code precedence row covering all-not-found).

   **Branch-reuse check** (revised for merged PRs — plan-review H2). For eligible (non-skipped) PR actions, call `gh.ts:getRemoteHeadRef(repo, head.ref)`. The expected SHA depends on PR state:

   | PR state | Baseline for comparison |
   |---|---|
   | `merged` | The PR's pre-merge head SHA (`pr.head.sha`). After squash/rebase merge this commit is no longer reachable from the head ref — so if the ref *still* points at it, the branch was orphaned (expected post-merge). **If the ref has moved to a *different* SHA**, someone created a new branch with the same name post-merge → skip `"branch-reused"`. **If the ref is missing** (404), the branch is gone (expected post-merge with "Auto-delete head branches" on) → proceed to local cleanup. **If the ref still points at `pr.head.sha`** (auto-delete off), proceed normally. |
   | `closed` (not merged) | `pr.head.sha` exactly. Mismatch → `"branch-reused"`; 404 → proceed to local cleanup. |
   | `open` (stale) | `pr.head.sha`. Mismatch → `"branch-reused"`. 404 should not happen for open PRs. |

   The general invariant: **the ref must EITHER match `pr.head.sha` or be missing (404)** — anything else is a reused branch.

   **Branch-reuse via "other open PRs on this head ref" check** (plan-review C1 — supersedes the unsound committerDate check). Commit `committerDate` is metadata of the *commit*, not the ref-creation/update time, so a ref that points at `pr.head.sha` cannot be proven new-or-old by inspecting it. Instead, for merged or closed PRs whose remote ref still exists, **query `gh api repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open`**: if there are any open PRs whose `head.ref === action.branchName`, the ref is currently in use by an active PR (reused) → skip with `skipReason: "branch-reused"`. This is a deterministic safety signal and does not depend on commit timestamps.

   **Deleted-fork null head.repo** (plan-review H11). The GitHub PR API returns `head.repo: null` when the head fork has been deleted. Treat `head.repo === null` as automatic `skipReason: "fork"` — there is no way to verify identity against base; the safest interpretation is "do not touch."

   Record the resolved SHA (or `null` for 404) in `remote.headSha` for the Phase 4 drift check. Add `preflight_open_pr.test.ts` for the open-PR skip, `preflight_branch_reused.test.ts` for SHA-mismatch skip and the open-PR-on-same-head-ref detection (mock `gh api .../pulls?head=...&state=open` returns non-empty), `preflight_null_head_repo.test.ts` for the deleted-fork case, and `preflight_merged_gone_ref.test.ts` for the merged-PR-with-gone-ref happy path.

   **Transient gh failures during preflight resolution** (plan-review H12). Any non-404 HTTP failure or network error from `gh.ts` during candidate resolution (`fetchCleanupPr`, `listClosedPulls`, `listOpenPulls`, `getRemoteHeadRef`) → exit `EXIT_UNRECOVERABLE` with a stderr line naming the failing call and the affected source (e.g. `"--pr 3: gh fetchCleanupPr failed (502 Bad Gateway). Aborting before plan write."`). Do NOT write a partial plan, do NOT continue with fewer candidates. The operator re-runs once the transient issue clears.

   **Already-clean short-circuit deferred to post-Task-6** (plan-review H16). The already-clean rule (`remote.exists === false && local.exists === false → skip "already-clean"`) requires `action.local` to be populated, which only happens in Task 6. Therefore: the already-clean evaluation runs **after Task 6 (local-branch metadata + worktree enumeration) for ALL candidate sources**, as a final pre-write pass over the action list. This is documented as a new Task 6.5 below.

   **Local branch identity check** (plan-review C44, revised after C2). For PR-sourced actions where `action.local.exists === true`, compare `action.local.headSha` to `pr.head.sha` ONLY. **Do NOT accept `pr.merge_commit_sha` as proof of identity** — for squash/rebase merges, the merge commit is on `main`, not on the PR branch; a local branch that happens to point at the merge commit is almost certainly a re-used branch name, not the original PR branch (plan-review C2). If `action.local.headSha !== pr.head.sha` → skip with `skipReason: "local-branch-reused"`. The user explicitly named `--branch NAME` is exempt — they accepted the risk. Squash-merge case where the local branch advanced to the merge commit is documented in the README's squash-merge recovery section (operator runs `git update-ref refs/keep/<name> <branch>` before cleanup if they want a backup, then accepts deletion of the local branch). Add `preflight_local_branch_reused.test.ts` covering: `local.headSha === pr.head.sha` → proceed; `local.headSha === pr.merge_commit_sha` → skip `local-branch-reused`; `local.headSha === <unrelated commit>` → skip `local-branch-reused`.

2. **Branch mode.** For each `--branch NAME`, bypass PR lookup. **In same-repo mode**: check remote presence + SHA via `lsRemoteHeads(origin)`; check local presence + OID via `localBranchExists`/`localBranchOid`. **In cross-repo mode** (`plan.crossRepo === true`): resolve remote presence + SHA via `gh.ts:getRemoteHeadRef(plan.repo.nameWithOwner, name)` — NOT `lsRemoteHeads(origin)`, which would query the wrong remote (§2 resolution 13 inferred; plan-review H38). Skip the local lookup in cross-repo mode. If neither side exists → `skip: true, skipReason: "not-found"`. Apply protection gate.

3. **Stale-open scan.** **Mode-dependent behaviour** (plan-review H21):
   - When `--stale-days N` is set AND **neither** `--pr` nor `--branch` is supplied → **discovery mode**: paginate `listOpenPulls(repo, { sort: "updated", direction: "asc", perPage: 100, max: auditMaxPrs })` — **oldest first** so the cap retains the relevant stale tail (plan-review M26). All returned PRs that pass the staleness filter become actions.
   - When `--stale-days N` is set AND `--pr` and/or `--branch` is supplied → **filter mode**: do NOT scan the whole repo. Instead, for each explicit `--pr N` candidate, evaluate the staleness rule against the already-fetched PR (`pr.state === "open"`, `pr.updatedAt` older than cutoff, draft + author filters); set `needsPrClose: true` on matching candidates. Explicit `--branch` candidates have no PR to evaluate and are unaffected by `--stale-days`. Plan-review H21.

   Compare `updated_at` against an injected `now` (clock-injection seam — `now: () => Date.now()` default; tests pass `now: () => fakeTime`).

   **Filters and counters:**
   - Drafts gated by `--include-drafts` (skipped PRs count to `summary.staleFiltered.byDraft`).
   - Foreign authors gated by `--stale-author-self-only` (default on; the allowed-author set is `{authUser, ...flags.staleAuthorAllowlist}` — `--stale-author` augments via plan-review M5; the `=false` opt-out additionally requires `--allow-foreign-authors`).
   - Stale PRs get `needsPrClose: true`.
   - The two counters (`byAuthor`, `byDraft`) surface in the human table footer and the stdout JSON.

   **Multiple stale PRs on the same head ref** (plan-review H22). Two open PRs from `feature/x` to different bases would normally dedup into one action with one `primaryPrSource`. **Resolution:** when more than one PR targets the same head ref AND all are stale, store ALL PR sources in `action.sources` (as `type: "pr"` or `type: "stale-only"` entries with their own `prNumber`); `action.primaryPrSource` points to the most-recently-updated one for the close-comment template. **Phase 4 Step 2 iterates `action.sources.filter(s => s.prNumber)` and closes EACH** (with freshness re-check per PR), not just the primary. Branch deletion (Step 3) runs only if every PR closure succeeded (or returned `"already-closed"`). If any closure failed → record `error` on the action; do NOT delete the branch (would strand the remaining open PRs).

4. **Audit mode.** When **none of `--pr`, `--branch`, `--stale-days`** is set (§2 resolution 12): paginate `gh.ts:listClosedPulls(repo, perPage=100, max=auditMaxPrs)`. **Set `summary.truncated: true`** if the cap fires. Same-repo: intersect PR head refs with `lsRemoteHeads(origin)`; include `[gone]` locals from `listGoneLocalBranches`. **Cross-repo: only `audit-pr` candidates** (the `[gone]` concept requires cwd to match the target repo). Empty audit → still write plan; execute will exit `EXIT_NOTHING_TO_DO`.

   **Cap-aware advisory + escalation** (plan-review H5/M6/M48). When `truncated: true`:
   - Emit a stderr advisory **at preflight** (not waiting for execute): `"Audit truncated at <N> PRs. Branches from older closed PRs may not be cleaned. Re-run with --audit-max-prs M --pr <num> to widen scope or target specific PRs."`
   - If `truncated: true` AND `summary.actionable === 0` (the cap fired AND every scanned candidate was skipped — most likely the actionable older ones are beyond the cap) → exit `EXIT_BAD_ARGS` instead of `EXIT_NOTHING_TO_DO` with the advisory. This forces the operator to widen `--audit-max-prs` or target specific `--pr` numbers rather than silently doing nothing. Plan-review H5.

**Cross-cutting gates applied to ALL candidate sources** (Tasks 1, 2, 3, 4 — plan-review H30/H36/H42):

1. **Fork detection.** `audit-pr` and stale-mode actions are also subject to `head.repo.full_name !== base.repo.full_name → skip "fork"`. The fork gate is not unique to explicit `--pr` mode.
2. **Branch-reuse check.** For every PR-sourced action (explicit `--pr`, `audit-pr`, stale), the current remote head SHA (`gh.ts:getRemoteHeadRef`) MUST equal `pr.head.sha`. Mismatch → skip `"branch-reused"`.
3. **Protection gate.** Every candidate (explicit, stale, audit-pr, audit-gone-branch, branch) runs through the protected-list check (Phase 2 Task 3 — lowercase-folded set). Protected branches surface as `skip: true, skipReason: "protected"`.

Implementation: factor the three gates into helpers (`isForkPr(pr)`, `verifyPrHeadIdentity(pr, currentRemoteSha)`, `isProtected(branch, plan.protected)`) and call them in each candidate builder. Add `preflight_audit_gates.test.ts` asserting fork + branch-reuse + protection all apply to audit-pr; `preflight_stale_gates.test.ts` for stale-mode.

5. **Deduplication and source merge.** When the same branch arrives via multiple sources (e.g., `--pr 569 --branch feat/orphan --stale-days 30` covers the same branch twice), keep one action; OR the `needsPrClose` flag (any stale source requiring close wins); preserve explicit source metadata as an array `sources: CleanupSource[]` on the action.

   **PR-number preservation on dedup** (plan-review H46): when `needsPrClose: true` on the merged action, the **primary PR source** (the one whose `state === "open"` and matched the stale filter) is also recorded as `action.primaryPrSource: CleanupSource`. Phase 4 Step 2 reads `action.primaryPrSource.prNumber` (NOT `action.primaryPrSource.prNumber`, which no longer exists — sources are now plural). If multiple PR sources are stale, pick the most-recently-updated one; record the rest in `sources[]` for the summary table.

   **Dedup protection invariant** (plan-review M20): protection is computed from branch name, not from source. After source merge, an action is `skip: true, skipReason: "protected"` iff its branch is protected — regardless of how many sources surfaced it. Tested in `preflight_protected.test.ts`: `--branch main --pr <merged-PR-targeting-main>` produces one action with `skip: true`.

6. **Local-branch metadata + worktree enumeration** (cross-repo: skipped — populate `local: null`, `worktrees: []`).
   - For each same-repo action whose local branch exists: populate `local.{exists, headSha, ahead, behind, hasUpstream}` via `aheadBehind` (handle "no upstream" → `ahead: null, behind: null, hasUpstream: false`). Operate via `git.ts` helpers with `cwd: plan.cwdToplevel`.
   - **Worktree enumeration is branch-scoped** (§2 resolution 13; plan-review H55): run `listWorktrees(cwd: plan.cwdToplevel)` which returns `{ path, branch, bare, isMain, dirty }` (Phase 1 Task 6 declares the **`dirty`** field — see below). Filter strictly to `wt.branch === action.branchName && !wt.isMain` before assigning to `action.worktrees`. The main worktree is **never** in `action.worktrees`. `dirty` is computed inside `listWorktrees` via `git -C <wt.path> status --porcelain` returning non-empty (plan-review H32/H37/H43 — the production code path for dirty detection is `listWorktrees` itself, not a separate per-action probe).
   - **Default-safe behavior on auto-discovered candidates** (§2 refinements):
     - When `action.sources[0].type` is `audit-pr`, `audit-gone-branch`, or stale-only (i.e., not explicitly named by `--pr`/`--branch`) AND **any** of `action.worktrees` has `dirty: true` AND `flags.includeDirty: false` → `skip: true, skipReason: "worktree-dirty"`; increment `summary.dirtyWorktrees`.
     - When `action.sources[0].type` is auto AND `action.local.hasUpstream && action.local.ahead > 0` AND `flags.includeDirty: false` → `skip: true, skipReason: "local-ahead"`; increment `summary.localAhead`. **Exception for `audit-gone-branch`**: by definition these branches have `hasUpstream: false` (their upstream is gone — that's why they're candidates). They are NOT skipped on the ahead rule — there's no upstream to be ahead of. Plan-review H19. They are still subject to the dirty-worktree rule.
     - When **any** of `action.sources` has type `pr` (explicit `--pr`) or `branch` (explicit `--branch`): no skip — destructive default per design (the `isExplicit = sources.some(s => s.type === "pr" || s.type === "branch")` check; plan-review M16/M24). But **emit a stderr warning line** for each dirty / ahead action so the user sees the risk before execute.
     - **Dirty main worktree counts for the gate** (plan-review H23): `action.dirtyWorktreesForGate` is the full set of branch-matching worktrees including the main one; `action.worktrees` excludes the main worktree (only that subset is destructively removed). The dirty-gate evaluates `action.dirtyWorktreesForGate.some(w => w.dirty)` — so a dirty main worktree on the action's branch still triggers the auto-skip.

6.5. **Already-clean short-circuit** (plan-review H16/H25 — runs AFTER Task 6 for all candidate sources, AND AFTER `needsPrClose` evaluation). For each action whose `skip` is still `false` AND `needsPrClose === false` (a stale open PR still needs to be closed even when the branch is gone — plan-review codex:sequencing "already-clean can skip required stale PR closure"): if `remote.exists === false && (action.local === null || action.local.exists === false)` (the ref is gone everywhere and no local copy exists), mark `skip: true, skipReason: "already-clean"`. The empty action is preserved in the plan for visibility but execute treats it as no-op. The Phase 6 smoke runbook's third-run-exits-3 expectation depends on this: when all candidates are `already-clean`, `liveActionable === 0` → `EXIT_NOTHING_TO_DO`.

7. **Plan summary + write.** Populate `plan.summary.{candidates, actionable, skipped, skipReasons, truncated, dirtyWorktrees, localAhead, staleFiltered}`. Write plan via `writeCleanupPlan` into `cleanupDir()`. Before the write, call `runtime.ts:pruneOldPlans(30)` to garbage-collect stale plans (plan-review M16).

   **Stdout contract** (§2 resolution 4, revised): preflight emits a **single-line JSON envelope** on stdout: `{"planFile":"<path>","dryRun":<bool>,"truncated":<bool>}`. Nothing else on stdout. Human table on stderr. Token redaction via `lib/redact.ts` on every stderr emission. Add `preflight_envelope.test.ts` to assert the JSON shape and `preflight_dry_run.test.ts` to assert `dryRun: true` propagates through the envelope.

#### Risks

- Branch names with `#`, Unicode, slashes break GitHub API paths if encoded inline: centralised in `gh.ts:getRemoteHeadRef` / `deleteRemoteHeadRef` (already in Phase 1) — preflight and execute never construct API paths.
- Large audit on a 10k-PR repo: `--audit-max-prs 500` is the safety valve; one `--paginate` batch of 5 requests stays well under rate limits.
- Clock-injection seam leaks into prod: keep it as a top-level parameter of the stale helper, not a module-level mutable global.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_pr.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_open_pr.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_branch_reused.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_branch.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_audit.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_stale.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_stale_visibility.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_fork.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_worktree_scope.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_dirty_auto_skip.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_envelope.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/preflight_dry_run.test.ts
```

### Phase 4: Execute engine — ordered actions, drift, dry-run, output

**Goal:** consume a plan and run destructive actions with per-action isolation, idempotency, and SHA-drift protection. Every documented exit code reachable.  
**Dependencies:** Phase 3.  
**Estimated effort:** L.

#### Tasks

1. **`executeCleanupPlan(plan, { exec, planFile, now? }) → CleanupSummary`** in `gh_cleanup_execute.ts` (plan-review M17 — `now` clock seam: `() => Date.now()` default; tests pass `now: () => fakeTime` for deterministic Step 2 freshness comparisons). CLI accepts only `--plan-file`. Invalid plan file → `EXIT_UNRECOVERABLE` without mutation. Read via `readCleanupPlan` (Phase 1). On startup, also verify `plan.flags.staleAuthorSelfOnly === true || plan.flags.allowForeignAuthors === true` (plan-review M8 — defense-in-depth against a hand-edited plan that flipped the safety filter); mismatch → `EXIT_UNRECOVERABLE`.

2. **Execute pre-flight re-validation** (defense-in-depth gate — runs ONCE before the action loop; §2 resolution 17, plan-review H0/H1/H23/H30/C28/H6/H18/L1). Each check below exits `EXIT_UNRECOVERABLE` on mismatch, with a clear stderr message naming the mismatch field. **Nothing has been mutated yet** at this point. **Order matters** (plan-review L1): protected-list re-derivation runs **before** the self-worktree gate, so a protected branch is flagged as `protected` (the more critical safety property) rather than `current-worktree`.
   - **Auth identity:** `gh.ts:ghCurrentUser()` MUST equal `plan.authUser`. Prevents an identity swap between preflight and execute from running destructive ops under unexpected privilege.
   - **Repository identity (cross-repo too):** re-fetch `repoView({ repoSlug: plan.repo.nameWithOwner })` and verify the returned `nodeId` equals `plan.repo.nodeId` (plan-review M9). Catches: rename + new repo created on the old slug; delete + recreate; permission change. Mismatch → `EXIT_UNRECOVERABLE` (we don't act on a different repo than preflight resolved).
   - **Cwd anchor (same-repo only — `!plan.crossRepo`):** **do not call `process.chdir`** — it's process-global and unsafe in shared event loops (plan-review H6). Commit fully to the injected-`cwd` pattern: every `git.ts` helper accepts a `cwd` arg (Phase 1 Task 6) and execute passes `plan.cwdToplevel` to every call. The cwd anchor check itself uses `fs.realpathSync(plan.cwdToplevel)` (resolves symlinks; plan-review H2) and verifies it is a git toplevel (`git -C <toplevel> rev-parse --show-toplevel` returns the same realpath). Then **canonicalise both origin URLs before comparison** (plan-review H14/H23/H45/M7/M11). `plan.originUrl` is already stored in canonicalised+credential-free form (single contract — see Phase 2 Task 2 below; no `raw vs scrubbed` ambiguity). Execute compares `canonicaliseOrigin(git -C plan.cwdToplevel remote get-url origin) === plan.originUrl`. If either mismatches → exit `EXIT_UNRECOVERABLE`. Catches the operator running execute from a different clone, after the repo moved, or with credentials that have rotated.

     **`canonicaliseOrigin(url): string` contract** (in `lib/gh.ts`):
     - Parses HTTPS-form (`https://[user[:pass]@]host/owner/repo[.git]`) and SSH-form (`[user@]host:owner/repo[.git]` — including SSH `Host` aliases via `ssh_config` resolution).
     - Strips userinfo (credentials).
     - Lowercases host AND the owner/repo path (GitHub names are case-insensitive in URLs; plan-review M11).
     - Strips `.git` suffix.
     - Emits `host/owner/repo` (no scheme, no `://`, no `.git`) — minimal canonical form.
     - For SSH `Host` aliases, resolves via `ssh -G <alias>` to the real hostname so `git@my-github:o/r` and `git@github.com:o/r` canonicalise to the same value when the alias points to github.com (plan-review M7).

     Add `gh_canonicalise_origin.test.ts` covering: HTTPS-with-creds, SSH-form, SSH `Host` alias, GHE host, mixed-case host + path, `.git` suffix on one side only, multi-segment owner (e.g. `o/r-spike-2026`).
   - **Protected list re-derivation — uses `plan.protected.currentHead` snapshotted at preflight, NOT a live HEAD read** (plan-review C0). Rebuild from `["main","master","develop"]` (lowercase-folded) ∪ `gh.ts:repoView().defaultBranch` (lowercase-folded; same-repo + cross-repo both query this) ∪ (`plan.protected.currentHead` if same-repo and non-null). Detached HEAD at preflight → `plan.protected.currentHead === null` → omit from set entirely (plan-review M12). **Cross-repo: omit `currentHead` regardless** — irrelevant to the target repo (plan-review H18). For every `action` with `skip === false`, if `action.branchName.toLowerCase()` is in the recomputed set → force `action.skip = true, action.skipReason = "protected"` in memory (not written back to disk). Defense-in-depth against a hand-crafted or stale plan that flipped a protected branch's `skip` flag.
   - **Self-worktree gate** (plan-review C28/L1 — runs AFTER protected re-derivation): for every action with `skip === false`, compute `selfReal = fs.realpathSync(plan.cwdToplevel)`. For each `wt` in `action.worktrees`, attempt `wtReal = fs.realpathSync(wt.path)`. If `fs.realpathSync` throws (path no longer exists; plan-review high), treat the worktree as absent — do not include it in the match check; the Step 4 worktree removal will re-verify via `fs.existsSync` and treat missing-path as success (M6). If `wtReal === selfReal` → force `action.skip = true, action.skipReason = "current-worktree"`, emit a stderr warning naming the worktree. This precedes Step 1 (drift), Step 2 (PR close), and Step 3 (remote delete). The original Step 4 self-worktree check is dropped.

2.5. **Live local safety re-check** (plan-review H18 — runs AFTER Task 2's gates, BEFORE the action loop, same-repo only). For each `action` with `skip === false && action.local !== null`:
   - Re-enumerate worktrees branch-scoped via `listWorktrees(plan.cwdToplevel)` filtered to `wt.branch === action.branchName`. If the live set has any `wt.dirty === true` (regardless of whether preflight saw it dirty) AND the action was auto-discovered (`!isExplicit`) AND `!flags.includeDirty` → force `skip: true, skipReason: "live-dirty"`. Catches in-flight modifications between preflight and execute.
   - Re-compute `aheadBehind(branch, cwd: plan.cwdToplevel)`. If live `ahead > 0` AND `hasUpstream === true` AND `!isExplicit` AND `!flags.includeDirty` → force `skip: true, skipReason: "live-ahead"`.

   Add `execute_live_local_recheck.test.ts` covering: clean-at-preflight then dirty-at-execute → `live-dirty`; clean-at-preflight then ahead-at-execute → `live-ahead`; explicit `--branch` is not affected. Also extend `execute_revalidate.test.ts` to cover: nodeId mismatch (M9), realpath symlink resolution (H2), detached-HEAD protected-list exclusion (M12), protected-before-self-worktree ordering (L1).

3. **Ordered action execution** (steps 0–6 per §"Action Semantics" of the design, **revised** to put freshness/drift before any mutation; §2 resolution 11):
   - **Step 0 — Eligibility gate** (plan-derived): respect `skip: true` from plan (after Task 2 re-derivation); do nothing further for that action.
   - **Step 1 — HeadSha drift re-check** (when `action.remote.exists`): `gh.ts:getRemoteHeadRef(plan.repo.nameWithOwner, action.branchName)`.
     - SHA mismatch → `skip: true, skipReason: "head-sha-drift"`; no exit escalation; subsequent actions proceed.
     - `null` (404 — remote ref already gone): set `action.remote.exists = false, action.remote.headSha = null`; **continue to Step 2** (which may still need to close the PR for `needsPrClose: true` actions — plan-review H17); Step 3 (remote delete) will then be skipped automatically because `action.remote.exists === false`; Step 4/5 still run for local cleanup.
   - **Step 2 — Stale freshness re-check + PR closure** (only when `action.needsPrClose`).
     - First, **re-fetch** `gh.ts:fetchCleanupPr(plan.repo.nameWithOwner, action.primaryPrSource.prNumber)`. Then branch on state (plan-review H17/H44):
       - **PR already closed or merged** (someone else closed it, or it got merged after preflight): treat the close-step as a no-op success — the PR is already in the desired terminal state — and **proceed to step 3** (remote ref delete). This is retry-idempotent. Record `prClosureSkippedReason: "already-closed"` on the action for the summary table.
       - **Still open, but `updated_at` newer than `(now - staleDays*86400)`** — the author has activity since preflight; safety filter no longer applies → **skip with `skipReason: "freshness-changed"`**; no closure, no remote delete.
       - **Still open, no longer matching draft filter** (was draft, became ready, `--include-drafts` not set) → skip with `"freshness-changed"`.
       - **Still open, author filter no longer matches** → skip with `"freshness-changed"`.
       - **Still open AND still stale** → run `gh.ts:closePrWithComment({ repoSlug: plan.repo.nameWithOwner, number, comment: "Closed by /stark-gh:cleanup — stale for <N> days (no activity since <updated_at>)." })`. Per §2 resolution 16 the helper returns `"closed"`, `"already-closed"`, or `{ error }`:
         - `"closed"` or `"already-closed"` → continue to the next PR in `action.sources` (multi-PR case; plan-review H22). Record `action.prClosureSkippedReason = "already-closed"` for the summary table in the latter case.
         - `{ error }` → record `action.error`; do NOT proceed to Step 3 (stranding an open PR with deleted head is worse than the alternative; plan-review M17/M26/M50/H7/H13/H25).
       - **Multi-PR iteration** (plan-review H22 + round-6 multi-PR-recurrence): Step 2 iterates `action.sources.filter(s => s.prNumber != null)` and applies the re-fetch + freshness + close logic to EACH PR. Only after ALL PRs are confirmed closed (`"closed"` or `"already-closed"` for every one) does the action proceed to Step 3. Any single failure aborts the action at that PR; previously-closed PRs in the iteration remain closed (acceptable — they were stale and the operator opted into closure).
       - **PR-already-closed-or-merged path verification** (plan-review H3): when the re-fetch in this Step shows ANY PR is now closed/merged, also re-validate `remote.headSha` against the PR's `head.sha` before proceeding past this PR. If they no longer match (someone deleted and re-created the branch on a different commit graph), skip the entire action with `skipReason: "branch-reused"` instead of running Step 3 or further closures.
   - **Step 3 — Remote ref delete** (only when `action.remote.exists === true && action.remote.headSha != null`; plan-review H29). `gh.ts:deleteRemoteHeadRef(plan.repo.nameWithOwner, branch)`. HTTP 200/204/404 → success. HTTP 422 matching `/Reference does not exist/i` → success. Anything else → step failure (record `{code, stderr}`).
   - **Step 4 — Worktree removal** (skip when `plan.crossRepo`).
     - Self-worktree guard is in Task 2 (pre-action). By the time Step 4 runs, any worktree pointing at `plan.cwdToplevel` is already off the action via `current-worktree` skip.
     - For each `wt` in `action.worktrees`, attempt `git.ts:removeWorktree(wt.path, force=true, cwd: plan.cwdToplevel)`. **"Already-gone" detection by filesystem re-check, not stderr substring match** (plan-review M6): if `removeWorktree` throws, check `fs.existsSync(wt.path)`. If the path no longer exists → success. Otherwise → step failure (record + **skip step 5 for this action** — still-attached worktree blocks `branch -D`).
     - The dirty-worktree gate (Phase 3 Task 6 + Task 2.5 live re-check) is preflight-authoritative.
   - **Step 5 — Local branch delete** (skip when `plan.crossRepo`): `git.ts:deleteLocalBranch(name, force=true, cwd: plan.cwdToplevel)`. **"Already-gone" detection by post-call re-check** (plan-review M6): if `deleteLocalBranch` throws, check `git.ts:localBranchExists(name, cwd)`. If `false` → success. Otherwise → record failure; loop continues.

4. **Cross-repo gating.** Steps 4 and 5 skipped when `plan.crossRepo === true`. Skipped local steps are recorded on the action as `skipReason: "cross-repo-no-checkout"` (machine) / human label `cross-repo (no local checkout)`. Done when `execute_cross_repo.test.ts` (explicit file) asserts zero `git.ts` mutation calls when `crossRepo: true` and step 3 still fires.

5. **Dry-run.** The wrapper (Phase 5) short-circuits before invoking execute on `--dry-run`. This task only covers running execute directly (debug path): when `plan.flags.dryRun === true`, execute writes the same human table to stderr describing what *would* run, with every per-action `status: "would-run"` / `"would-skip"`. No mutation calls. Stdout JSON still emitted; `exitCode: 0`. **Plan-file is NOT unlinked on dry-run** even though exit is 0 (plan-review H11; see Task 8 below).

6. **Output contract** (machine-stable; plan-review M4 — all counter fields ALWAYS present, zero-valued when no skips of that kind).
   - **Stdout:** single-line JSON:
     ```json
     {
       "event": "cleanup-complete",
       "exitCode": N,
       "authUser": "...",
       "auditDropped": 0,
       "counts": {
         "actionable": N, "succeeded": N, "failed": N, "skipped": N,
         "dirtyWorktrees": N, "localAhead": N
       },
       "truncated": true|false,
       "staleFiltered": { "byAuthor": N, "byDraft": N },
       "actions": [{"id":"...","branch":"...","status":"...","error":{...}|null}]
     }
     ```
     ALL fields above present-and-zero-valued even when the run produced no values of that kind. `summary.skipReasons` is an open map at preflight write time but the per-action `status` field on stdout uses a fixed string vocabulary so downstream scripts can pattern-match (plan-review M4).
   - **Stderr:** human table, columns `# | source | branch | remote | local | worktree | action | status`. **Header line** includes `Auth: <plan.authUser>` and (when applicable) `Repo: <repo>` and `[cross-repo]`. **`--no-color` (or absent TTY) → no ANSI codes**; thread `plan.flags.noColor || !isTTY(stderr)` through `lib/output.ts`. Same renderer used by **preflight** for the dry-run path (plan-review M21 — dry-run output must also honour `--no-color`). Token redaction via `lib/redact.ts` on every stderr write.
   - **Truncation banner:** when `summary.truncated === true`, emit a stderr line: `WARNING: audit truncated at <auditMaxPrs> PRs — re-run with --audit-max-prs M to widen scope.`
   - Done when `execute_happy.test.ts` parses stdout JSON, snapshots stderr table; `execute_no_color.test.ts` asserts no ANSI (both execute and preflight); `execute_truncated_banner.test.ts` asserts the WARNING line; `stdout_json_shape.test.ts` asserts all counter fields are always present with zero values when no skips of that kind occurred.

7. **Per-action error capture and mid-action skip mechanism** (plan-review H38). Mid-action skip and error pathways are explicit, not implicit.

   ```ts
   class SkipAction extends Error {
     constructor(public reason: CleanupSkipReason) { super(reason); }
   }
   class StepFailed extends Error {
     constructor(public code: string, public stderr: string) { super(code); }
   }

   for (const action of plan.actions) {
     if (action.skip) { continue; }
     try {
       step1_drift_recheck(action);   // throws SkipAction("head-sha-drift") or marks action.remote.exists=false
       step2_freshness_and_close(action); // throws SkipAction("freshness-changed") or StepFailed
       step3_remote_delete(action);   // throws StepFailed
       step4_worktree_remove(action); // throws StepFailed
       step5_local_delete(action);    // throws StepFailed
     } catch (e) {
       if (e instanceof SkipAction) {
         action.skip = true;
         action.skipReason = e.reason;
       } else if (e instanceof StepFailed) {
         action.error = { code: e.code, stderr: e.stderr };
         action.failed = true;
       } else {
         throw e; // genuinely unexpected — propagate, exits EXIT_UNRECOVERABLE
       }
     }
   }
   ```

   Each step is a function that either runs to completion, throws `SkipAction(reason)`, or throws `StepFailed(code, stderr)`. The outer loop catches both and updates the action. No `if/else` chains for skip status inside the steps — control flow is exception-based for clarity. Outer loop never aborts on `SkipAction` or `StepFailed`.

8. **Exit-code computation** (precedence from Phase 1 Task 2). **Re-derive `summary.actionable` from the live action array after all mid-action skips** — preflight's `summary.actionable` is the starting count, but execute may further skip (head-sha-drift, freshness-changed, current-worktree, protected-on-revalidation, branch-reused). The exit-code computation reads `liveActionable = plan.actions.filter(a => !a.skip && !a.error).length` — not `plan.summary.actionable` (plan-review H24). Done when one test per exit code (0/3/4/5/`EXIT_BAD_ARGS`-all-not-found) drives the relevant state, plus an explicit test that mid-action skips bring `liveActionable` to 0 → `EXIT_NOTHING_TO_DO`.

9. **Plan-file lifecycle.** Rule, explicit (plan-review H11/H14/H29):
   - **Ordering:** audit-log execute-summary append (Task 10) ALWAYS runs first; then plan-file unlink (if eligible). The audit log must reflect the run regardless of unlink outcome.
   - `EXIT_OK AND NOT flags.dryRun` → `fs.unlinkSync(planFile)`.
   - `EXIT_NOTHING_TO_DO AND NOT flags.dryRun AND no action errors` → `fs.unlinkSync(planFile)`.
   - Otherwise (including all dry-run exits) → leave on disk and print path on stderr.
   - **Unlink failure handling** (plan-review H14): if `fs.unlinkSync` throws (race with concurrent run, FS read-only, chmod-ed `cleanupDir`), emit a single stderr warning `"Cleanup plan executed successfully but plan-file removal failed at <path>: <error>; safe to delete manually"`, append a `stage: "cleanup-fail"` audit line, and keep the exit code at `EXIT_OK` (the actual cleanup succeeded; the leftover plan-file is cosmetic clutter).

10. **Audit log** (plan-review M25/H1/H6/H7/H12/H15/H28/H29/M1/M25/L0): **preflight, every action start, every action completion, execute end, and wrapper-handoff** each append one JSON line to `runtime.ts:auditLogPath()` (`<cleanupDir>/.audit.jsonl`, mode `0600`).
    - **Wrapper-handoff line** (`stage: "wrapper-handoff", planFile, dryRun, timestamp`): emitted by the wrapper itself before `exec node ... execute` (one extra ~50ms `node -e` invocation; plan-review H4). Guarantees the audit log shows that the wrapper successfully handed off to execute, even if execute crashes before its own append.
    - **Preflight line** (`stage: "preflight"`): repo, flags, candidate counts, skipReasons, `planFile` path, `prunedPlans` count.
    - **Per-action-start line** (`stage: "action-start", actionId, branch`): emitted **before each action begins steps**. Lets post-hoc readers spot interrupted/crashed actions: action-start without action-end → interrupted (plan-review M15).
    - **Per-action-end line** (`stage: "action", actionId, branch, status, error?`): emitted on every step completion (success, skip, or fail), within the action loop.
    - **Execute-summary line** (`stage: "execute", exitCode, counts, duration`): final summary.

    **Atomicity contract — dependency-free `O_CREAT | O_EXCL` lockfile** (plan-review H1/H6/H12/H28/M25, no native binding required):
    - `runtime.ts:appendAuditLine(entry)` acquires `<auditLog>.lock` via `fs.openSync(lockPath, "wx")` (atomic `O_CREAT | O_EXCL`). The lock file content is `{pid, hostname, startedAt}`. On `EEXIST`, retry every 50ms up to **2 s** (not 5 s; plan-review livelock concern). Stale-lock cleanup: if the lock file mtime is > **30 s** old AND the recorded pid does not exist on the local host (`process.kill(pid, 0)` throws ESRCH), `unlink` and retry once.
    - **Lock acquisition failure after 2 s** → emit one stderr line `"AUDIT WARNING: lock held by pid <X> for >2s; skipping audit append for this action"`, increment `auditDropped`, and **continue without writing** (plan-review livelock + H6 trade-off revised: refusing to run on contention is worse than skipping one audit line; the action-start lines from concurrent runs interleave but each is atomic per-line via `O_APPEND`). The operator can detect dropped lines via `auditDropped > 0` in the final summary.
    - **Test contract reconciliation**: `audit_log.test.ts` covers (a) single-write happy path, (b) concurrent two-process writes (both lines land), (c) stale-lock recovery (pid not alive + mtime > 30s), (d) lock-held-by-live-pid > 2s → warning + `auditDropped++` + no crash (NOT EXIT_UNRECOVERABLE — round-5 spec said exit-unrecoverable; revised in round-6 to warning-and-continue based on the livelock concern). (e) rotation at 10 MB and 90 days under lock.
    - **Open/write failure (after lock acquired)** — `ENOSPC`, `EACCES`, etc. (plan-review H15): emit one stderr line `"AUDIT FAILURE: <error> — destructive actions may have run without trace at <path>"`, increment `auditDropped`, release the lock. Do NOT abort the run mid-action.
    - **Entry redaction** (plan-review high — `error.stderr` may contain tokens): every entry passes through `lib/redact.ts` before serialisation. `error.stderr` fields specifically are redacted; branch names and PR titles are NOT redacted (they're user-visible identifiers). Add `audit_log_redaction.test.ts` covering a synthetic action with a token-bearing stderr → asserts the token doesn't appear in the audit line.

    **Audit log rotation** (plan-review M1/L0): before each append, check the audit log file size. If `> 10 MB` OR `mtime - createdAt > 90 days`, rotate via `fs.renameSync(auditLog, "<auditLog>.<YYYY-MM-DD>")`, then continue writing to a fresh `auditLog`. Keep the last **3** rotated files; older rotated files are removed by `pruneOldPlans` (which now also handles `.audit.jsonl.YYYY-MM-DD` siblings). This is an automatic background-O(1) operation; operators don't need to manage retention manually. Document the policy in the README.

    `audit_log.test.ts` covers: single-write, concurrent-write via two child processes (asserts both lines land with no interleaving), stale-lock recovery (mocked `mtime - 65s`), lock-acquisition fail after 5s → `EXIT_UNRECOVERABLE`, `ENOSPC` open/write failure → stderr warning + `auditDropped++` + continue, rotation at 10 MB and 90 days.

#### Risks

- Local branch TOCTOU between preflight + execute: git refuses `branch -D` on a checked-out branch in any worktree → step 5 fails cleanly, recorded, loop continues. **Acceptable.**
- Concurrent `/stark-gh:cleanup` runs against the same repo: idempotent by construction — 404/422 success and head-sha-drift skip absorb the race. Document in Phase 5 README that concurrent runs may produce inflated per-action failure counts in the loser's summary; behaviour is correct.
- Residual drift→delete race (plan-review M5): even with Step 1's re-check, another push can land between `getRemoteHeadRef` and `deleteRemoteHeadRef`. `gh api -X DELETE` on a ref does not accept an `If-Match` SHA. Window is small; document the residual race in §4 Integration Points so operators don't expect strict atomicity.

#### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/cleanup/execute_happy.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_revalidate.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_partial_failure.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_dry_run.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_worktree.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_self_worktree.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_pr_close_failure.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_freshness_changed.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_head_sha_drift.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_remote_gone.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_cross_repo.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_truncated_banner.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/execute_no_color.test.ts \
  plugins/stark-gh/tools/__tests__/cleanup/audit_log.test.ts
```

### Phase 5: Slash-command wrapper and README

**Goal:** expose the command via the plugin discovery surface and document safe operation.  
**Dependencies:** Phase 4.  
**Estimated effort:** S.

#### Tasks

1. **`plugins/stark-gh/commands/cleanup.md`.** Frontmatter `name: cleanup`, `allowed-tools: Bash, Read`, `model: sonnet`. `argument-hint`: `[--pr N[,N,...]] [--branch NAME[,NAME,...]] [--repo OWNER/NAME] [--stale-days N] [--include-drafts] [--stale-author-self-only[=true|false]] [--include-dirty] [--dry-run] [--allow-no-pr-match] [--audit-max-prs N] [--no-color]` (**no `--force`**; §2 resolution 1; includes `--include-dirty` per §2 refinements).

   Body — **JSON envelope** parse, not substring match (§2 resolution 4 revised; plan-review M2/M9/M18/M46/M58). The shebang and all syntax MUST be POSIX-portable (plan-review H0 — no `<<<` here-strings, no `[[`). The Claude Code skill harness invokes the body via `bash -e`; the explicit `#!/usr/bin/env bash` line documents the dependency. **`jq` is a hard prerequisite** (plan-review M3) — fail loudly with a clear message if missing. **`$ARGUMENTS` is trusted-by-harness** (plan-review M0): the slash-command harness passes operator input verbatim under double-quotes; argv-only thereafter via the TS tools. Any harness change that alters this trust requires re-auditing this surface.

   ```bash
   #!/usr/bin/env bash
   set -eu
   TOOLS="$HOME/.claude/plugins/stark-gh/tools"

   # --- Prereq check: jq is required ---
   command -v jq >/dev/null 2>&1 || { echo "stark-gh:cleanup requires jq; install via 'brew install jq' or your package manager" >&2; exit 5; }

   # --- Preflight ---
   # Capture stdout + exit code; propagate preflight exit code unchanged.
   PFRC=0
   ENVELOPE=$(node --experimental-strip-types "$TOOLS/gh_cleanup_preflight.ts" \
     --raw-args "$ARGUMENTS" --emit-plan-path) || PFRC=$?
   [ "$PFRC" -ne 0 ] && exit "$PFRC"

   # --- Parse JSON envelope ---
   PLAN_FILE=$(printf '%s' "$ENVELOPE" | jq -r '.planFile')
   DRY_RUN=$(printf '%s' "$ENVELOPE"  | jq -r '.dryRun')
   [ -z "$PLAN_FILE" ] && { echo "stark-gh:cleanup: preflight returned empty plan path" >&2; exit 5; }

   if [ "$DRY_RUN" = "true" ]; then
     echo "Dry-run plan written to: $PLAN_FILE"
     exit 0
   fi

   # --- Audit-log wrapper-handoff line (plan-review H4) ---
   # Append a small JSON line before exec'ing execute, so the audit log shows handoff
   # even if execute crashes immediately. Tolerates audit-append failure (warning only).
   node --experimental-strip-types "$TOOLS/gh_cleanup_audit_append.ts" \
        --stage wrapper-handoff --plan-file "$PLAN_FILE" --dry-run false 2>/dev/null || true

   # --- Execute (propagate exit code via direct exec, NOT command substitution) ---
   # `exec` replaces the wrapper process with execute, so execute's exit code is the
   # wrapper's exit code. No stdout interception, no exit-code drop (plan-review H13).
   exec node --experimental-strip-types "$TOOLS/gh_cleanup_execute.ts" --plan-file "$PLAN_FILE"
   ```

   No LLM dispatch. No bash-side arg parsing — the dry-run signal comes from the envelope, not from re-tokenising `$ARGUMENTS`. **Regression assertion:** `rg -n -- '--force|codex exec|Agent\\(' plugins/stark-gh/commands/cleanup.md` must produce zero hits. Add `wrapper_dry_run_envelope.test.ts` (in shell, via `bash -e` against a stubbed preflight) covering: empty envelope, `dryRun: true`, `dryRun: false`, preflight exit code 2/5 propagation, execute exit code 4 propagation through `exec`, `jq` absent → exit 5 with clear stderr.

   **New tool `gh_cleanup_audit_append.ts`** (introduced in Phase 1 alongside the other entry points). One-shot helper that writes a single audit line per invocation. Used by both the wrapper-handoff path and direct manual audit operations. Argv: `--stage <stage> --plan-file <path> [--dry-run <bool>]`. Uses the same `runtime.ts:appendAuditLine` helper as preflight/execute.

2. **Update `plugins/stark-gh/README.md`.** Replace the manual `gh api -X DELETE … + git branch -D …` placeholder (currently around lines 35–39). New sections:
   - One-line description + use cases.
   - **Hard prerequisite: `jq`** — installation hint per platform. Document that `gh ≥2.40` is required for `--stale-days` (auto-checked at preflight).
   - Argument surface table (mirror the design's table, plus `--include-dirty`, `--audit-max-prs`, `--allow-foreign-authors`, `--stale-author` per §2 + refinements).
   - Exit code table including `EXIT_BAD_ARGS` all-PRs-not-found (Phase 1 Task 2 precedence row 3) AND `EXIT_BAD_ARGS` audit-truncated-no-results (plan-review H5).
   - Stdout/stderr contract one-liner — note the JSON envelope on stdout from preflight (`{planFile, dryRun, truncated}`), the `event:cleanup-complete` JSON from execute (with always-present-zero counter fields per plan-review M4), and the human table on stderr (including `Auth: <user>` header).
   - **Audit log:** location (`~/.claude/code-review/stark-gh/cleanup/.audit.jsonl`), automatic rotation (10 MB or 90 days; last 3 rotated kept), and the line-types emitted (`wrapper-handoff`, `preflight`, `action-start`, `action`, `execute`, `cleanup-fail`). Note that `--stale-author-self-only=false` is logged with the resolved `authUser` and `allowForeignAuthors: true`.
   - Cross-repo mode behaviour, with caveat that local-side actions are skipped and `audit-gone-branch` is unavailable.
   - Audit mode behaviour, with the `--audit-max-prs 500` cap noted and the truncation banner reminder; the `EXIT_BAD_ARGS` escalation when `truncated && actionable === 0` (plan-review H5).
   - Smoke runbook (from design's smoke section, verbatim), expanded with a pre-step `node --version && gh --version && git --version && jq --version` for diagnosability (plan-review M49).
   - Squash-merge recovery note (from design, verbatim — reflog + `git update-ref refs/keep/<name>` advice).
   - **Auto-discovered candidate safety table** (§2 refinements): dirty worktrees and `local.ahead > 0` are skipped by default in audit / stale-open mode; **dirty main worktree on the action's branch ALSO triggers the skip** (plan-review H23); explicit `--pr`/`--branch` modes force-remove with a stderr warning. `--include-dirty` re-enables destructive behaviour for auto modes. The skip is re-checked at execute time as `live-dirty`/`live-ahead` (plan-review H18).
   - `--stale-days` public-comment warning under operator's identity; safety rail is `--stale-author-self-only` default (`=false` requires `--allow-foreign-authors`). Note that the stale-freshness re-check in execute (Phase 4 Step 2) prevents closing a PR that received new activity after preflight. Document `--stale-author <login>` for bot-authored PR allowlists (plan-review M5).
   - Concurrent-runs note: safe-by-construction, may inflate per-action failure counts in the loser's summary. Audit-log lockfile serialises writers across processes.
   - **Identity stability** (plan-review M9): cleanup verifies the GitHub repository `node_id` between preflight and execute, so a repo renamed/deleted/recreated under the same `owner/name` slug between runs aborts with `EXIT_UNRECOVERABLE`.
   - Compatible tool versions: Node with `--experimental-strip-types` (≥22.6 recommended), `gh` (≥2.40), `git` (≥2.30), `jq` (any recent version). Versions verified at preflight where they're load-bearing.
   - Operational maintenance: automated pruning of plans older than 30 days runs on every successful preflight (skips files younger than 1h to avoid concurrent-run race — plan-review M2); audit log auto-rotates (plan-review M1/L0); failed prunes log warnings and continue (plan-review M13).

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

- **Plan-file** is the preflight ↔ execute data carrier. Execute never re-parses raw args, but it is also **not** the sole authorisation source: the execute pre-flight re-validation (Phase 4 Task 2) re-derives auth identity, cwd anchor, origin URL, and protected list independently. This is deliberate defense-in-depth — the plan-file at mode `0600` protects against other OS users, not against stale retained plans, identity swaps via `/stark-gh-user`, or hand-crafted plans (plan-review H0/H1/H23/H30).
- **`schemaVersion: 1`** rejection at execute boundary; future v2 must be additive or coordinated.
- **Wrapper ↔ stages:** `cleanup.md` forwards `$ARGUMENTS` verbatim as one quoted `--raw-args` value. Preflight emits a **single-line JSON envelope** on stdout (`planFile`, `dryRun`, `truncated`); the wrapper parses that envelope and decides whether to invoke execute (§2 resolution 4 revised). No `$ARGUMENTS` re-tokenisation in bash.
- **Audit log** (`<cleanupDir>/.audit.jsonl`, mode `0600`) is the durable post-run record. Append-only; preflight + execute both append on completion (success or partial). Survives `unlink(planFile)`.
- **Residual drift→delete race** (plan-review M5): the GitHub `DELETE /repos/{o}/{r}/git/refs/heads/{ref}` endpoint accepts no `If-Match` SHA. A push between Step 1's drift re-check and Step 3's delete can land. Window is small but real; documented here so operators don't assume strict atomicity.
- **`gh.ts`** owns all GitHub API shapes and the active `gh` auth identity (including per-segment ref-path URL encoding — §2 resolution 9). `closePrWithComment` is implemented as a single `gh pr close <n> --comment "..." --repo <repo>` invocation (§2 resolution 16).
- **`git.ts`** owns all local branch / worktree mutations. Every helper takes an injectable `cwd` and tests inject `plan.cwdToplevel` to keep work inside the verified checkout.
- **`lib/output.ts`** owns the human table renderer and `--no-color` / TTY gating; renders the `Auth: <user>` header (plan-review M27) and the audit-truncation banner (plan-review M15/M48).
- **`lib/redact.ts`** scrubs every stderr emission; test snapshots must not leak tokens.
- **Failure semantics:** incomplete preflight breaks safety gates; incomplete execute leaves partial deletion; incomplete README leaves operators unaware of squash-merge commit loss.

## 5. Testing Strategy

- **Mock at `lib/gh.ts` and `lib/git.ts`** — never hit real network or run real `git` in unit tests.
- **Risk-first order:** exit codes, eligibility gates, SHA drift before audit / stale features.
- **Snapshot stderr tables** — they are part of the contract; pin and update intentionally.
- **No flaky time tests** — `--stale-days` uses the clock-injection seam (`now: () => Date.now()` default).
- **Integration is the gatekeeper** — `integration.test.ts` covers full preflight → plan-file → execute round-trip via shimmed `gh` and `git`, asserting stdout JSON, exit codes, and plan-file lifecycle.

Test focus per phase:

| Phase | New tests |
|-------|-----------|
| 1 | `plan_io.test.ts`, `gh_ref_encoding.test.ts` (per-segment), `gh_canonicalise_origin.test.ts` (HTTPS-with-creds, SSH-form, SSH `Host` alias, GHE host, mixed-case path), `branch_validation.test.ts` (incl. `@{-1}`, `HEAD~1`), `plan_retention.test.ts` (incl. M2 race + M13 failure), `wrapper_envelope.test.ts`, `validate_execution_context.test.ts` (Phase 1 stub: callable, no throw) |
| 2 | `preflight_args.test.ts` (comma-lists, all reject/accept paths, `--audit-max-prs`, `--allow-foreign-authors`, `--stale-author`), `preflight_cross_repo.test.ts`, `preflight_protected.test.ts` (Main/Master/Develop + detached HEAD), `preflight_cwd_anchor.test.ts` (credentialled HTTPS + SSH-form + symlinked toplevel + repo node_id), `preflight_gh_version.test.ts` (gh ≥2.40 vs <2.40 with/without stale-days), `auth_fail.test.ts` |
| 3 | `preflight_pr.test.ts`, `preflight_open_pr.test.ts` (skip `pr-open`), `preflight_branch_reused.test.ts` (SHA mismatch + force-push-to-same-SHA via `committerDate`), `preflight_null_head_repo.test.ts` (deleted-fork → `fork`), `preflight_merged_gone_ref.test.ts`, `preflight_transient_gh_fail.test.ts` (non-404 → EXIT_UNRECOVERABLE), `preflight_branch.test.ts`, `preflight_audit.test.ts` (M48 banner at preflight), `preflight_audit_gates.test.ts`, `preflight_audit_truncated_no_results.test.ts` (H5: truncated + actionable=0 → EXIT_BAD_ARGS), `preflight_stale.test.ts`, `preflight_stale_filter_mode.test.ts` (H21: `--stale-days` with `--pr` does NOT trigger discovery scan), `preflight_stale_multi_pr.test.ts` (H22: two stale PRs on same head ref), `preflight_stale_sort.test.ts` (M26: oldest-first within cap), `preflight_stale_gates.test.ts`, `preflight_stale_visibility.test.ts`, `preflight_fork.test.ts`, `preflight_worktree_scope.test.ts` (incl. H23 dirty main worktree triggers gate via `dirtyWorktreesForGate`), `preflight_dirty_auto_skip.test.ts`, `preflight_already_clean.test.ts` (H16: runs after Task 6), `preflight_envelope.test.ts`, `preflight_dry_run.test.ts` (incl. M21 `--no-color` respected) |
| 4 | `execute_happy.test.ts`, `execute_revalidate.test.ts` (auth + cwd realpath + nodeId + protected-snapshot + detached-HEAD + protected-before-self-worktree ordering), `execute_live_local_recheck.test.ts` (H18: live-dirty / live-ahead), `execute_partial_failure.test.ts`, `execute_dry_run.test.ts`, `execute_worktree.test.ts` (incl. M6 existsSync re-check on remove failure), `execute_self_worktree.test.ts`, `execute_pr_close_failure.test.ts`, `execute_pr_close_retry.test.ts` (H7/H13/H25: re-fetch-then-act → "already-closed"), `execute_pr_already_closed.test.ts` (+ H3 branch-reused re-verify), `execute_freshness_changed.test.ts`, `execute_head_sha_drift.test.ts`, `execute_remote_gone.test.ts` (Step 1 404 → continue to Step 2; H17), `execute_retry_idempotent.test.ts` (M6 already-gone detection on remove + delete), `execute_cross_repo.test.ts`, `execute_truncated_banner.test.ts`, `execute_no_color.test.ts`, `execute_unlink_fail.test.ts` (H14: warn + EXIT_OK), `execute_multi_pr_close.test.ts` (H22: all PRs closed before remote delete), `stdout_json_shape.test.ts` (M4: all counter fields always present at zero), `audit_log.test.ts` (concurrent writes; stale-lock recovery; lock-fail → EXIT_UNRECOVERABLE; rotation 10MB + 90d; ENOSPC → warning + auditDropped), `audit_log_actionstart.test.ts` (M15: action-start before action-end) |
| 5 | `wrapper_dry_run_envelope.test.ts` (shell-driven), `wrapper_jq_missing.test.ts` (M3), `wrapper_handoff_audit.test.ts` (H4: handoff line written before exec), `integration.test.ts` |
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
