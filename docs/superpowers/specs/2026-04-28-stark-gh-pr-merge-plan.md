# Implementation Plan — stark-gh:pr-merge

Synthesized from codex (winner, 8.4/10) + claude (8.2/10) cross-reviewed plans.
Source spec: `2026-04-28-stark-gh-pr-merge-design.md`.

## 1. Overview

Build `/stark-gh:pr-merge` as the second command in `plugins/stark-gh`, extending the existing pr-open three-stage TypeScript pipeline. Phases 1–2 add shared merge primitives without altering pr-open behavior; Phase 3 implements preflight; Phase 4 adds Codex drafting; Phase 5 implements the execute stage with the synchronous `--no-watch` path proving the merge-call shape end-to-end before the asynchronous Phase 6 watcher work; Phase 7 wires the slash command and docs; Phase 8 covers integration smoke. **Runtime maintenance/GC is excluded from v1** (flagged as scope creep by both claude and gemini reviewers; tracked in a follow-up plan).

**Trust model (PR2-codex/sequencing + feasibility — known v1 limitation):** the install path `$HOME/.claude/plugins/stark-gh/` is currently a **symlink to the repo working tree** (matches all other stark-skills plugins). When `/stark-gh:pr-merge` runs against a PR that has been checked out into that same working tree, the slash body's `node ...` invocations resolve through the symlink to the PR's mutated tool code. **The self-modifying-PR refuse gate (Phase 3 step 6, exit 19) runs from this same potentially-mutated code, so it is defense-in-depth, not an authoritative trust boundary.** A determined attacker who modifies the gate code in their PR can disable it.

Mitigations applied in v1:
1. **Refuse gate** (defense-in-depth) catches accidental misuse and unsophisticated attackers.
2. **Documentation:** README will explicitly state "do not run `/stark-gh:pr-merge` against PRs that modify `plugins/stark-gh/**`; merge those manually via `gh pr merge`."
3. **Operator awareness:** the gate's exit `19` message names the policy explicitly so users are reminded.

Authoritative fix is out of v1 scope: **install-by-copy** (instead of symlink) plus a content-hash manifest verified on each invocation. Tracked separately as a stark-skills-wide hardening initiative — applies equally to pr-open, every other skill, and the broader plugin loader. See "Considered & Rejected — plan-review round 2" for full rationale.

## 2. Prerequisites

```bash
cd /Users/aryeh/git/Evinced/stark-skills
git status --short
gh auth status
node --version
codex --version
test -f CHANGELOG.md
```

Required access:
- `gh` authenticated to GitHub with repo read/write, GraphQL, checks, push, and merge permissions.
- Push permission to the PR head branch and squash-merge permission on the target PR.
- Codex CLI available for `codex exec -m gpt-5.5 -c model_reasoning_effort="medium" --json`.
- Implementation must happen on a clean branch; the current checkout has unrelated dirty state (`config/settings.json`, `.claude/`) that must not be swept into pr-merge commits.

Runtime provisioning (code-owned, not manual):
- `lib/runtime.ts` (or first tool to need it) creates `~/.claude/code-review/stark-gh/{runtime,audit,watchers}` with mode `0700`.
- Audit file `audit/pr-merge.log` is created with mode `0600` on first override write.

## 3. Phases

## Phase 1: Foundation Contracts

**Goal:** Add merge-safe shared types, exit codes, audit support, and reusable git/GitHub helpers without changing pr-open behavior.
**Dependencies:** None.
**Estimated effort:** M.

### Tasks

1. **Extend exit-code contracts.**
   - Modify `plugins/stark-gh/tools/lib/exit.ts`.
   - Add `export const MergeExit = { OK:0, BAD_ARGS:10, PR_GATE:11, CHECK_FAIL:12, CONFLICT_OR_DIRTY:13, BASE_OID_MOVED:14, NO_CHANGELOG:15, SECRET_LLM:16, FORK_OR_HEAD_MISMATCH:17, LOCAL_DIVERGED:18, SELF_MODIFYING_PR:19, DRAFT_INVALID:20, SECRET_COMMIT:28, OID_DRIFT:30, PUSH_REJECTED:31, MERGE_FAILED:32, SPAWN_FAILED:33, WATCHER_RUNNING:34 } as const`.
   - Exit `19` (PR1-codex/security) is for self-modifying PRs that touch `plugins/stark-gh/**` or `scripts/**`.
   - Keep existing `Exit` names/values stable for pr-open.
   - Done when pr-open tests still pass and merge tools can import `MergeExit`.

2. **Convert plan handling to a discriminated union.**
   - Modify `plugins/stark-gh/tools/lib/plan.ts`.
   - Introduce `PrOpenPlan`, `PrMergePlan`, `type Plan = PrOpenPlan | PrMergePlan` with `command` discriminator.
   - Add `validatePrMergePlan(p)`, `isPrMergePlan(p)`; preserve legacy `PrOpenPlan` validation.
   - `PrMergePlan` includes: `runId`, `pr` (with `headRepositoryOwner/Name`, `headRef`, `baseRef`, `isCrossRepository`, `nameWithOwner`) — **`headRef` and `baseRef` are explicit persisted fields** (PR4-codex H17); downstream stages must use these, not re-query. Plus: `baseOid`, `originalHeadOid`, `rebasedHeadOid`, `changelogCommitOid`, `pushedHeadOid`, `originalChangelogPath` (path to a durable tempfile copy of pre-edit CHANGELOG.md content; PR4-claude H04 + codex H11/H25/H34 — replaces `originalChangelogSha` since loose blobs are GC-vulnerable), `changelog.{filePath,section,markerComment}`, `startingRef`, `forceReason` (string, required if `force=true`; PR4-codex H15), `stage2.*`, `execute.{watch,force,watchTimeoutHours,secretOverrides,allowNoRequiredChecks}`.
   - **`execute.watchTimeoutHours` is persisted** so spawn-fail rerun without `--watch-timeout` flag preserves original timeout (codex review weakness).
   - Done when `readPlan()` rejects malformed merge plans and accepts existing open plans.

3. **Add merge audit support + runtime-dir helper (PR4-claude H01).**
   - Create `plugins/stark-gh/tools/lib/runtime.ts` exporting `ensureRuntimeDirs()` — `mkdir -p {runtime,audit,watchers}` with mode `0700`. Idempotent; safe to call from any tool.
   - Modify `plugins/stark-gh/tools/lib/audit.ts`.
   - Add `appendPrMergeOverride({timestamp, runId, pr, flag, user, hostname, reason})` — `reason` becomes **required** when `flag === '--force'` (PR4-codex H15); writers call `ensureRuntimeDirs()` first.
   - Append JSONL to `~/.claude/code-review/stark-gh/audit/pr-merge.log`, file mode `0600`, parent dir `0700`.
   - **Generate `runId` before any auditable gate** so override-flag invocation is logged once per run regardless of whether the override actually bypassed a gate (codex review weakness).
   - Print stderr warning when `--allow-secret-to-llm` is set: `WARNING: secret material is being sent to an external LLM provider; review provider data-handling policies`.
   - Tests in `override_audit.test.ts`: each flag writes a structured line, file mode `0600`, stderr warning text, JSONL well-formedness.

4. **Add reusable git/GitHub helpers + cross-stage restore tool (PR4-codex H33).**
   - Modify `plugins/stark-gh/tools/lib/git.ts`: add `revParse(ref)`, `fetchRefs(remote, refs)` (uses explicit destination refspecs `+refs/heads/<n>:refs/remotes/origin/<n>` per PR4-codex H09), `checkout(ref)`, `rebase(onto)`, `abortRebase()`, `commitMessage(subject)`, `resetHard(oid)`, `updateRef(ref, oid)`, and explicit-lease push helper. Build the lease via `argv` (no shell quoting).
   - Create `plugins/stark-gh/tools/lib/restore_branch.ts` — cross-stage cleanup tool. Reads plan-file; performs two-step restore: `git update-ref refs/heads/<plan.pr.headRef> <plan.originalHeadOid>` + `git checkout <plan.startingRef>`; restores CHANGELOG.md from `originalChangelogPath` if it differs from current. Idempotent. Invoked by the slash-body trap (Phase 8 task 1).
   - Modify `plugins/stark-gh/tools/lib/gh.ts`: add merge PR metadata fetch, authenticated `gh api graphql` wrapper, and `mergeSquashPr({prNumber, subjectFile, bodyFile})` — reads the subject tempfile and passes `--subject <text>` (NOT `--subject-file`) and `--body-file <file>` via argv (no shell quoting; no `--delete-branch`). **Both Phase 5 (`--no-watch` path) and Phase 7 (watcher callback) call the same shared helper** — single source of truth for the merge invocation shape (PR2-claude/feasibility). Remote branch deletion is **not** in v1's lib/gh.ts surface — deferred to `/stark-gh:cleanup` per PR3-codex/rollback.
   - Done when helpers are unit-testable through `ExecFn`.

5. **Persist override-flag audit-key dependency on runId.**
   - Ensure the slash-body argv → preflight pathway computes `runId` before any audit write. Document this ordering invariant inline in `audit.ts`.

### Risks

- Breaking pr-open plan validation: keep compatibility tests; do not require merge-only fields on open plans.
- Lock-format change (Phase 6) impacts pr-open watcher consumers — Phase 6 includes a compat verification.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/plan.test.ts \
  plugins/stark-gh/tools/__tests__/override_audit.test.ts
```

## Phase 2: Merge Shared Libraries

**Goal:** Implement deterministic merge primitives before any stage mutates branches.
**Dependencies:** Phase 1.
**Estimated effort:** L.

### Tasks

1. **Changelog marker library.**
   - Create `plugins/stark-gh/tools/lib/changelog.ts`.
   - Export `updateUnreleasedChangelog({content, pr, runId, section, bullet}): {content, changed, markerLine}`.
   - Match marker by **PR number only** (`<!-- stark-gh:pr-merge pr=<N> `); ignore `runId` for matching.
   - **Byte-identical case:** if marker found AND existing bullet line equals new bullet text exactly, return `{changed: false}` — do not touch `runId`.
   - **Differs case:** replace bullet line; rewrite marker with new `runId`.
   - **First-run case:** locate or create `### <Section>` under `## [Unreleased]`; insert marker line + bullet at top.
   - Reject non-numeric PR; reject bullets not matching `^- .{1,198}$` (no embedded newlines).
   - **Implementation Note (claude):** for the byte-identical first-run edge case where no prior `changelogCommitOid` exists in the plan, treat as a no-op for the changelog step but require Phase 5 to still capture the post-step `HEAD` SHA so `changelogCommitOid` is non-null in the plan-file.

2. **Draft schema + validator.**
   - Create `plugins/stark-gh/tools/lib/draft_schema.json` with: subject ≤72, body ≤16384, `changelog_bullet` matching `^- [^\n]{1,198}$`, `additionalProperties: false`.
   - Create `plugins/stark-gh/tools/lib/draft_schema.ts` exporting `validateDraft(obj)` that enforces the schema **plus**: rejection of `Closes`/`Refs`/`#N` patterns in any field, no embedded newlines anywhere.
   - Test all rejection cases in `merge_draft_validation.test.ts`.

3. **GraphQL check rollup library.**
   - Create `plugins/stark-gh/tools/lib/checks_graphql.ts`.
   - Export `fetchRequiredCheckRollup({owner, repo, prNumber, expectedHeadOid})` returning `{headRefOid, contexts: Context[]}` after pagination.
   - Use authenticated `gh api graphql` with `contexts(first:100)`; paginate on `pageInfo.hasNextPage` via `after:` cursor.
   - **Caller-provided `expectedHeadOid` (codex weakness):** the function refuses to return contexts unless `pullRequest.headRefOid === expectedHeadOid`; on mismatch returns `{headRefOid, contexts: null, mismatch: true}` so callers can distinguish stale data from absent checks.
   - Export `isCheckPassing(c)`: `c.isRequired === true` AND (CheckRun: `conclusion ∈ {SUCCESS, NEUTRAL, SKIPPED}`; StatusContext: `state === SUCCESS`). Failing set: `{FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE}`. Pending: anything else.
   - Vacuous-pass: zero `isRequired === true` contexts → all-passing returns `true`.
   - **Implementation Note (claude):** GraphQL pagination must aggregate before evaluation; partial pages cannot satisfy the predicate.
   - Test pagination in `checks_graphql_pagination.test.ts` with 100+ contexts.

4. **OID re-verify shared helper.**
   - Create `plugins/stark-gh/tools/lib/verify_oids.ts`.
   - Export `verifyMergeOids(plan: PrMergePlan, opts): Promise<{ok:true} | {ok:false; kind:'base_moved'|'head_moved'; actual:string}>`.
   - Accepts the **full plan or PR-identity object** (codex weakness): needs `nameWithOwner`, `pr.number`, `baseRef`, expected `baseOid`, expected `pushedHeadOid`.
   - Re-fetches `origin/<baseRef>` via `git fetch --no-tags`; queries PR `headRefOid` via GraphQL.
   - **Used by both** `gh_pr_merge_execute.ts` (`--no-watch` path) and `gh_pr_merge_complete.ts` — single canonical comparison.

5. **Watcher callback registry.**
   - Create `plugins/stark-gh/tools/lib/watcher_callbacks.ts`.
   - Export `WATCHER_CALLBACKS = { "pr-merge-complete": "gh_pr_merge_complete.ts" } as const`.
   - Export `resolveCallback(name): string | null` — returns the resolved tool path or `null` for unknown names. Watcher must reject unknown names before any subprocess spawn.

6. **Implementation Notes — Ambiguities Flagged (claude):**
   - **SSH vs HTTPS origin URL:** before origin URL match in execute, normalize SSH `git@github.com:owner/repo.git` and HTTPS `https://github.com/owner/repo` to `owner/repo` for comparison with `nameWithOwner`.
   - **Pushed SHA capture:** strictly `git rev-parse HEAD` after a successful push (not `--porcelain`); the design's `pushedHeadOid` is the local ref's SHA.

### Risks

- GraphQL union parsing can silently drop status contexts: tests cover both `CheckRun` and `StatusContext` shapes.
- Changelog header parsing can corrupt historical sections: edits constrained to `## [Unreleased]` block.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/changelog_lib.test.ts \
  plugins/stark-gh/tools/__tests__/checks_graphql_pagination.test.ts \
  plugins/stark-gh/tools/__tests__/merge_draft_validation.test.ts
```

## Phase 3: Preflight Stage

**Goal:** Produce a complete `PrMergePlan` only when the repo, PR, branch, checks, and secrets satisfy the gate matrix.
**Dependencies:** Phases 1–2.
**Estimated effort:** L.

### Tasks

1. **Create `plugins/stark-gh/tools/gh_pr_merge_preflight.ts`.**
   - Argument parsing via `lib/shell_quote.ts` over `--raw-args`.
   - Flags: `--pr <N>`, `--changelog-section <Added|Changed|Fixed|Removed|Deprecated|Security>`, `--force`, `--no-watch`, `--watch-timeout <hours>`, `--allow-secret-commit`, `--allow-secret-to-llm`, `--emit-plan-path`.

2. **Implement Gate Matrix as enumerated table** (codex weakness fix). Each gate is a named function in `lib/preflight_gates.ts`:
   - **Always-enforced (`--force` does NOT bypass):** `state == OPEN`, `isCrossRepository == false`, `origin/<headRef> == headRefOid` (rt1), local `<headRef> == origin/<headRef>` (R2-H3), `mergeable != CONFLICTING`, working tree clean + no in-progress git op (H02), CHANGELOG.md exists with `[Unreleased]`, secret in pre-LLM scan (no `--allow-secret-to-llm`), secret in pre-commit scan (no `--allow-secret-commit`), `--no-watch` non-green checks (always-enforced per round-4 critical fix `c827008`).
   - **`--force`-bypassable:** `isDraft`, `reviewDecision == CHANGES_REQUESTED`, any required check failing.
   - Each gate returns `{passed, exitCode, bypassable}` and is unit-testable.
   - Tests in `merge_preflight_gates.test.ts` enumerate every row × force/no-force combination.

3. **Working-tree gate (Stage 1 step 2 — first mutation guard).**
   - `git status --porcelain` empty AND no `.git/rebase-*`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`.
   - Capture `startingRef` (current symbolic `HEAD`) for restoration on rebase abort.

4. **Watcher recovery and resume detection.**
   - Read `~/.claude/code-review/stark-gh/watchers/<host>/<owner>/<repo>/pr-N/latest.json`.
   - Verify lock liveness: hostname match + `kill -0 <pid>` + process start-time match (defends against PID reuse).
   - Live non-terminal watcher → exit `34` with state-file path.
   - Stale lock → log takeover and proceed.
   - **Resume path (codex review weakness):** if a retained plan-file for this PR exists with `pushedHeadOid` set and no terminal watcher state, preflight skips Stage 1 mutations and emits a marker on stdout signaling Stage 3 to skip to step 10 (spawn). Slash command body branches on this marker.
   - Tests in `merge_preflight_watcher_recovery.test.ts`: live, stale (PID dead), hostname mismatch, start-time mismatch, terminal-state non-blocking, resume detection.

5. **PR resolution + identity.**
   - `--pr N` → fetch by number; else `gh pr view --json number,headRefName,baseRefName,url,isDraft,state,mergeable,reviewDecision,labels,headRepositoryOwner,headRepository,isCrossRepository,headRefOid,files`.
   - No PR → exit `10`.
   - Cross-repo → exit `17`.
   - Capture `originalHeadOid = headRefOid`.

6. **Self-modifying PR gate (PR1-codex/security critical + PR4-claude H06 — expanded path coverage).**
   - Compute the set of guarded paths from `install.sh` at preflight time: parse install.sh's symlink directives to derive every directory that the slash command's runtime (node + tools + prompts + scripts) might load. v1 conservatively guards: `plugins/stark-gh/`, `scripts/`, `tools/` (TS helpers used by skills), `global/prompts/`, `skill/stark-*/SKILL.md` files referenced by stark-gh, and `standards/`.
   - Examine PR `files[].path`; if any path matches a guarded prefix, exit `19` with explicit message: "PR modifies stark-skills runtime files (`<matched-path>`); refuse to self-execute. Merge via plain `gh pr merge` after manual review."
   - **Inverse safer policy (PR4-claude H06):** if `install.sh` parsing fails or produces an empty set, default to refusing **any** PR whose diff touches files outside an explicit safe-list (`docs/`, `data/`, `automation/`, `org/`, root `*.md`). Operator must merge via plain `gh pr merge`.
   - Always-enforced; `--force` does not bypass.
   - Test `merge_preflight_self_modifying.test.ts`: PR touching each guarded prefix → exit `19`; PR touching only docs/specs → proceeds; install.sh-parse failure triggers safe-list mode.

7. **Fresh fetch with explicit destination refspecs (PR4-codex H08/H09/H32).**
   - `git fetch --no-tags origin +refs/heads/<baseRef>:refs/remotes/origin/<baseRef> +refs/heads/<headRef>:refs/remotes/origin/<headRef>` — explicit destination refspecs ensure remote-tracking refs are updated; bare `origin <ref>` updates `FETCH_HEAD` only. Wraps `lib/git.ts:fetchRefs`.
   - Verify `origin/<headRef> === originalHeadOid`; else exit `17` (PR head moved during preflight or local fetch was stale).
   - Verify local `<headRef> === origin/<headRef>`; else exit `18`.
   - Capture `baseOid = origin/<baseRef>` SHA.

8. **Pre-LLM secret scan (PR4-codex H08/H32 — runs against just-fetched refs, no rebase yet).**
   - Scan: PR title, PR body, commit messages on `origin/<headRef>` (now fresh), diff `origin/<baseRef>...origin/<headRef>`.
   - Exit `16` without `--allow-secret-to-llm`. **No branch mutation has happened yet** — failed scan leaves the user's branch untouched.
   - Tests `merge_preflight_secret_scan.test.ts`: one case per input stream → exit `16`.

9. **Rebase safely.**
   - Checkout `headRef`, rebase onto `origin/<baseRef>`. On conflict: `git rebase --abort`, restore `startingRef`, exit `13`.
   - Capture `rebasedHeadOid = HEAD` SHA.
   - **Cleanup-on-later-failure invariant (PR1-codex/general + PR2-claude/general + PR4-codex H07/H33):** Stage 1 from this step onward installs an error handler that, on any later non-zero exit, performs a **two-step restore**: (a) `git update-ref refs/heads/<headRef> <originalHeadOid>` to undo the rebase on the head branch, (b) `git checkout <startingRef>` to put the user back on their original symbolic ref. **The slash command body extends this invariant cross-stage** (PR4-codex H33): a shell `trap` calls `lib/restore_branch.ts <plan-file>` on any non-zero exit from preflight/draft/execute *before successful push*. Post-push the trap is disarmed (the rebase has been pushed; restoration is via Phase 5's push-rejection path, not the trap).

10. **Capture pre-edit CHANGELOG.md content via durable tempfile (PR4-claude H04 + codex H11/H25/H34/PR4-claude H31).**
   - Capture happens *after* rebase (so it reflects rebase's effect on CHANGELOG.md if the rebase touched it) and *before* the changelog edit in Phase 5.
   - Read `CHANGELOG.md` from the rebased branch into a tempfile under `~/.claude/code-review/stark-gh/runtime/<runId>-changelog-pre-edit.md` with mode `0600`.
   - Persist absolute path as `originalChangelogPath` in plan-file. Phase 5's rollback restores via `cp <originalChangelogPath> CHANGELOG.md`. **Tempfile is durable across crashes and not subject to git GC** (replaces the `git hash-object -w` approach which was GC-vulnerable). Tempfile is unlinked when plan-file is unlinked.
   - Test `merge_execute_push.test.ts` rollback case: assert tempfile exists and is readable before push attempt; rollback path verifies recovered content matches pre-edit byte-for-byte.

11. **Changelog section resolution.**
   - `--changelog-section` flag if provided; else label-inferred (`bug`/`fix` label → Fixed; else Added).
   - Verify rebased CHANGELOG.md has `## [Unreleased]`; else exit `15`.

12. **Pre-plan-write base re-check (exit `14`).**
   - Immediately before writing the plan-file, re-read `git rev-parse origin/<baseRef>`.
   - If different from captured `baseOid` → exit `14`. Cleanup invariant from step 9 fires.

13. **Write plan-file.**
    - `mktempInRuntime("stark-gh-pr-merge-plan-XXXXXX.json")`, mode `0600`, atomic write.
    - Print plan-file path on stdout when `--emit-plan-path`.
    - **Resume marker protocol (PR4-claude H03):** when emitting a resume hint, preflight prints a dedicated machine-readable line `STARK_GH_RESUME=<mode>` on its own line BEFORE the plan-file path. Modes: `spawn-only` (skip Stage 2/3 mutations, jump to spawn), `attached` (live watcher exists; no further work). The slash body parses both lines deterministically.
    - **Handoff (PR4-codex H18):** preflight leaves checkout on `headRef` so Stage 5 inherits the rebased state directly. The cross-stage trap (step 9) handles restore on later non-zero exit before push.

### Risks

- Rebase mutates the user branch: all mutation must happen after dirty-tree, local-sync, and PR identity gates.
- Existing watcher false positives: tests must simulate dead PID, hostname mismatch, PID reuse.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/merge_preflight_args.test.ts \
  plugins/stark-gh/tools/__tests__/merge_preflight_gates.test.ts \
  plugins/stark-gh/tools/__tests__/merge_preflight_rebase.test.ts \
  plugins/stark-gh/tools/__tests__/merge_preflight_watcher_recovery.test.ts \
  plugins/stark-gh/tools/__tests__/merge_preflight_local_sync.test.ts \
  plugins/stark-gh/tools/__tests__/merge_preflight_secret_scan.test.ts
```

## Phase 4: Draft Stage

**Goal:** Generate validated squash subject/body/changelog-bullet through Codex-owned Stage 2.
**Dependencies:** Phases 1–3.
**Estimated effort:** M.

### Tasks

1. **Create `plugins/stark-gh/tools/gh_pr_merge_draft.ts`.**
   - Read `PrMergePlan`; if `stage2.skip`, exit `0`.
   - Build prompt with `untrusted` JSON-wrapped fields: PR title, body, commit messages on rebased branch, diff summary (file shortstat). `trusted` keys: target changelog section name.
   - **Codex hardening contract (PR4-claude H29):** `lib/codex.ts:invokeCodex` spawns with `cwd` set to runtime dir (NOT the repo); env built via allowlist (`PATH`, `HOME`, `LANG`, `LC_*`, `OPENAI_API_KEY` if needed; strip `GITHUB_TOKEN`, `GH_TOKEN`, all `STARK_*`, all `AWS_*`, `ANTHROPIC_*`, etc.); no GitHub tokens reach Codex's env. Output piped via stdin/stdout — Codex never reads files from disk in our flow. Document this contract in `lib/codex.ts`'s file header. Tests in `codex_env_scrub.test.ts` assert the spawned env.

2. **Parse + validate output.**
   - Use `parseCodexJsonl` then `validateDraft` from `lib/draft_schema.ts`.
   - Reject `Closes`/`Refs`/`#N` in any field; reject embedded newlines; reject additional properties.
   - Retry once with validation-error feedback as additional prompt context. Second failure → exit `20`.

3. **Write prose tempfiles.**
   - Write `subject.txt`, `body.md`, `bullet.txt` to runtime dir, mode `0600`.
   - Atomic-update plan-file `stage2.{subjectFile,bodyFile,changelogBulletFile,model,reasoningEffort}`.

### Risks

- Prompt injection from PR content: all repository-derived fields explicitly `untrusted` and JSON-escaped.
- Invalid model output: never fall back to heuristics; fail with exit `20`.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/merge_draft.test.ts \
  plugins/stark-gh/tools/__tests__/merge_draft_validation.test.ts
```

## Phase 5: Execute Stage — `--no-watch` path first

**Goal:** Apply changelog, push with explicit lease, then either merge synchronously (`--no-watch`) or hand off to Phase 6 watcher. Implementing `--no-watch` first proves the merge-call shape end-to-end before async watcher complexity (claude phasing strength).
**Dependencies:** Phases 1–4.
**Estimated effort:** L.

### Tasks

1. **Create `plugins/stark-gh/tools/gh_pr_merge_execute.ts`.**
   - Read `PrMergePlan`.
   - Re-fetch `origin/<baseRef>` and `origin/<headRef>`.
   - Verify `baseOid` unchanged AND `origin/<headRef> === originalHeadOid`; else exit `30`.
   - Verify local `HEAD === rebasedHeadOid`; else exit `30`.

2. **Pre-commit secret scan + redaction visibility (PR4-claude H30).**
   - Read subject/body/bullet tempfiles; scan via `lib/secret.ts`.
   - Exit `28` without `--allow-secret-commit`.
   - With `--allow-secret-commit`: redact spans in **all three tempfiles atomically** before any file mutation; **also print a unified diff (before/after for each tempfile, with secret values masked) to stderr**, write structured audit line including `forceReason` (required when `--allow-secret-commit` set; PR4-codex H15-style — adds an `allowSecretCommitReason` flag the user must provide). The audit log retains the diff hash for forensics.

3. **Apply and commit changelog.**
   - Use `lib/changelog.ts:updateUnreleasedChangelog`.
   - Stage only `CHANGELOG.md`.
   - Commit message: `chore(changelog): <bullet text without leading "- ">` (codex review note: design says `<bullet text>` but the bullet always starts with `- `; stripping it produces a clean conventional commit subject — confirmed by Phase 5 task and `merge_execute_changelog.test.ts` assertion).
   - If `git diff --cached` is empty (byte-identical rerun), skip commit; reuse existing `changelogCommitOid` from plan-file.

4. **Origin URL match (Stage 3 step 7 — design exit `31`).**
   - Compare normalized origin URL (SSH/HTTPS forms) against `pr.nameWithOwner`.
   - Mismatch → exit `31`.

5. **Force-push with explicit-OID lease (rt5) + plan-file pre-push reconciliation.**
   - **Plan-file pre-push write (PR4-claude H23):** before invoking `git push`, capture `pushedHeadOid = git rev-parse HEAD` (local SHA equals about-to-push SHA) and atomic-update plan-file with `changelogCommitOid` + `pushedHeadOid`. The durable record exists pre-push so a crash mid-push doesn't strand the remote with no local-side memory of `pushedHeadOid`.
   - Build argv: `git push --force-with-lease=refs/heads/<headRef>:<originalHeadOid> origin HEAD:refs/heads/<headRef>`.
   - **Implementation Note:** lease string is built via argv only — never shell-interpolated.
   - On rejection (R3-claude/resilience):
     - `git reset --hard <rebasedHeadOid>` (rolls back changelog commit on the local branch).
     - Restore `CHANGELOG.md` content via `cp <originalChangelogPath> CHANGELOG.md` (PR4-claude H04 + codex H11 — durable tempfile, not GC-vulnerable git blob).
     - Retain plan-file + originalChangelogPath tempfile for diagnosis.
     - Exit `31`.
   - On success: re-verify `git rev-parse HEAD === pushedHeadOid` (sanity check: nothing local mutated between pre-push write and push); proceed.

6. **`--no-watch` path** (synchronous merge after re-verify):
   - Call `lib/verify_oids.ts:verifyMergeOids(plan)`; on mismatch exit `30`.
   - Call `lib/checks_graphql.ts:fetchRequiredCheckRollup` with `expectedHeadOid=pushedHeadOid`; mismatch → exit `30`.
   - **Bake/soak gate (PR4-claude H12):** in `--no-watch` mode, require **at least one required check context observed on `pushedHeadOid`**. A vacuous-pass (zero required contexts) is **not** allowed in `--no-watch` unless `--allow-no-required-checks` was set in the plan (PR4-codex H16 audited override; refused without `--force-reason`).
   - Apply `isCheckPassing` to all required contexts. If any not passing → exit `12` (always-enforced; `--force` does NOT bypass per round-4 critical fix).
   - **Merge call (PR1-codex/feasibility + PR4-codex H10):** `lib/gh.ts:mergeSquashPr({prNumber, subjectFile, bodyFile, expectedHeadOid: pushedHeadOid})` reads the subject tempfile and passes flags via argv. The helper passes `--match-head-commit <pushedHeadOid>` so GitHub atomically rejects the merge if the PR head moved between our check and the merge call (closes the TOCTOU window). **Subject flag (PR4-claude H05):** verify against installed `gh` version; if `--subject` is unsupported, fall back to GraphQL `mergePullRequest` mutation passing `commitHeadline` and `commitBody`. The helper detects support via `gh pr merge --help | grep -q '^      --subject string'` at first call and caches.
   - **Branch deletion deferred (PR3-codex/rollback critical):** v1 does NOT delete the remote branch. Branch remains as a recovery anchor; deletion is `/stark-gh:cleanup`'s job.
   - On success: print merge SHA + PR URL; unlink plan-file, prose tempfiles, and `originalChangelogPath` tempfile.
   - On failure: exit `32`.

7. **Default-watch path (handed off to Phase 6/7).** Capture `--watch-timeout`, atomic-update `execute.watchTimeoutHours`. Implementation completes in Phase 7.

### Risks

- Push rollback can leave inconsistent state if dirty state slips through Stage 1: tests assert clean state at every gate.
- Explicit lease string construction must use argv, never shell quoting (codex risk).

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/merge_execute_secret_scan.test.ts \
  plugins/stark-gh/tools/__tests__/merge_execute_changelog.test.ts \
  plugins/stark-gh/tools/__tests__/merge_execute_push.test.ts \
  plugins/stark-gh/tools/__tests__/merge_execute_no_watch.test.ts \
  plugins/stark-gh/tools/__tests__/merge_execute_idempotency.test.ts
```

## Phase 6: Watcher Modifications + Backward Compat

**Goal:** Extend `gh_watch_runs.ts` with the on-green callback registry, SHA-match contract, max-wait, and new lock format — without breaking pr-open watcher consumers (codex review weakness).
**Dependencies:** Phases 1–5.
**Estimated effort:** L.

### Tasks

1. **Extend `plugins/stark-gh/tools/gh_watch_runs.ts`.**
   - Add `--on-green <name>` (registry-resolved via `lib/watcher_callbacks.ts`; unknown name → refuse spawn before any subprocess fork).
   - Add `--plan-file <path>` (carries the `PrMergePlan` to the callback).
   - Add `--watch-timeout <hours>` (default 6, from plan if not flag-overridden).
   - Preserve legacy pr-open behavior when no `--on-green` is given (the watcher still polls and writes state files; no callback fires).
   - Update lock format to `{pid, startedAt, hostname, ownerToken}`.
   - Per-poll HTTP timeout: 30s.

2. **pr-open backward-compat AND in-flight-watcher migration (codex weakness + PR2-claude/general critical).**
   - Run existing pr-open watcher tests against the new lock format.
   - **Lock-format reader is tolerant:** `lib/watcher_lock.ts:readLock` accepts both old shape (whatever pr-open writes today) and new shape `{pid, startedAt, hostname, ownerToken}`. On reading an old-format lock from an in-flight watcher: log a warning, treat as live (conservative), require operator to wait for the in-flight watcher to terminate naturally before next run uses the new format.
   - **Lock-format writer always emits new shape** so the next run upgrades the format.
   - Document the upgrade-window behavior: in-flight pr-open watchers continue running on the old format until they terminate; new watchers (post-upgrade) write new format. No watcher is killed by the upgrade.
   - Tests in `watcher_pr_open_compat.test.ts`: (a) reader accepts old format; (b) writer emits new format; (c) old-format lock file present on-disk does not corrupt new run; (d) old-format lock with live PID exits `34` (treat as live).

3. **SHA-match contract + debounce (PR4-claude H13) + head-move detection (PR4-codex H35).**
   - In callback mode, read `pushedHeadOid` from plan.
   - Query `lib/checks_graphql.ts` with `expectedHeadOid=pushedHeadOid`. The helper returns `{headRefOid, contexts, mismatch}`.
   - **Head-move detection (PR4-codex H35):** if `mismatch === true` (PR `headRefOid !== pushedHeadOid`), the **watcher writes terminal state `head_moved`** and exits — this is a watcher-owned terminal state because the callback would never run on a mismatched rollup. The callback retains ownership of `base_moved`, `secret_in_prose`, `merged`, `merge_failed` (where it's actually invoked).
   - Three observable states for matching rollups:
     - Only stale pre-rebase OID rows present → wait.
     - `pushedHeadOid` rows present, at least one pending → wait.
     - All required passing on `pushedHeadOid` AND **2 consecutive polls observed all-passing** (debounce; PR4-claude H13) → fire callback.
   - Vacuous pass (zero required contexts on `pushedHeadOid`) is **refused in default-watch too** (PR5-codex/gates critical) unless `--allow-no-required-checks` is set in the plan. Without the override, watcher waits up to `--watch-timeout` for at least one required context to appear; if none does, terminal state `no_required_checks` (not `merged`). Same predicate as `--no-watch` — single canonical rule, no path-specific gap.

4. **Max-wait timeout + heartbeat (PR4-claude H21).**
   - On expiry: write terminal state `watch_timeout` with last observed check states; unlink prose tempfiles; print cleanup hint.
   - **Heartbeat (PR4-claude H21):** every poll, `touch latest.json` to update mtime. Operators / future `/stark-gh:housekeeping` can detect stuck watchers via `find ~/.claude/code-review/stark-gh/watchers -name latest.json -mmin +120 -not -empty` (state files older than 2× max poll cadence with non-terminal content are likely orphaned).
   - Tests in `watcher_max_wait.test.ts`.

5. **GraphQL rate-limit / backoff (PR4-claude H24).**
   - Poll cadence: 30s with ±20% jitter. Per-poll HTTP timeout: 30s.
   - On HTTP `403`/`429` with `X-RateLimit-Remaining: 0`: capped exponential backoff (cap 15min); resume polling once headers indicate availability.
   - On secondary-rate-limit (HTTP `403` with body matching "secondary rate limit"): same backoff path.
   - On `5xx`: 3 retries with 30s/60s/120s backoff, then continue normal polling.
   - Tests in `watcher_backoff.test.ts`: simulate 429 response → backoff + resume; 5xx burst → retry; persistent 401 → terminal `auth_failed` state.

### Risks

- Lock-format change must not break in-flight pr-open watchers running on the user's machine: backward-compat helper required.
- Stale check runs from pre-rebase SHA causing false green: callback mode must reject any rollup with `headRefOid !== pushedHeadOid`.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/watcher_on_green.test.ts \
  plugins/stark-gh/tools/__tests__/watcher_max_wait.test.ts \
  plugins/stark-gh/tools/__tests__/watcher_pr_open_compat.test.ts
```

## Phase 7: Watcher Callback + Stage 3 default-watch + spawn-fail recovery

**Goal:** Implement `gh_pr_merge_complete.ts` and wire Stage 3's default-watch + spawn-fail resume.
**Dependencies:** Phases 1–6.
**Estimated effort:** M.

### Tasks

1. **Create `plugins/stark-gh/tools/gh_pr_merge_complete.ts`.**
   - Read plan-file.
   - Call `lib/verify_oids.ts:verifyMergeOids`. On `base_moved` mismatch, write terminal state `base_moved` and exit (callback owns this state). `head_moved` is now owned by the watcher (PR4-codex H35 — see Phase 6 task 3).
   - **Pre-merge secret rescan:** read subject/body tempfiles; re-run `lib/secret.ts`. If secret found AND `--allow-secret-commit` not in plan, write terminal state `secret_in_prose` and exit. With override, proceed (already redacted).
   - Run merge via `lib/gh.ts:mergeSquashPr({prNumber, subjectFile, bodyFile, expectedHeadOid: plan.pushedHeadOid})` — **the same shared helper used by Phase 5 task 6**. The helper passes `--match-head-commit <pushedHeadOid>` for atomic SHA-bound merge (PR4-codex H10).
   - On success: capture merge SHA. **Remote branch is NOT deleted** — left as recovery anchor (squash commit is single-parent; un-deleted branch is the only post-merge path back to original commits).
   - Write final state `merged` with merge SHA + **operator runbook block** (PR4-claude H28): `{recovery: {remote_was_force_pushed: true, original_head_oid: <ORIG>, current_remote_head_oid: <PUSHED>, restore_command: "git push --force-with-lease=...", branch_recovery_window: "until /stark-gh:cleanup runs"}}`.
   - On failure: write terminal state `merge_failed` with the same runbook block, surface stderr, retain plan-file + tempfiles for diagnosis.

2. **Stage 3 default-watch in `gh_pr_merge_execute.ts`.**
   - After force-push success and plan-file update, spawn `gh_watch_runs.ts --on-green pr-merge-complete --plan-file <path> --watch-timeout <hours>`.
   - Use a deterministic state-file path computed from plan fields (so the parent can print it before detaching — claude review weakness fix).
   - On spawn success: print PR URL + watcher state-file path; the **plan-file is retained** until the watcher writes terminal state.
   - On spawn failure: retain plan-file; print PR URL + plan-file path + rerun instruction; exit `33`.

3. **Spawn-fail resume entry point.**
   - In `gh_pr_merge_execute.ts`, accept a resume marker from preflight (Phase 3 task 4).
   - Resume mode skips Stage 1 mutations and Stage 2 drafting; jumps straight to Phase 6/7 spawn (post-push state).
   - Test in `merge_execute_spawn_fail.test.ts`: spawn fails → plan retained + exit `33`; rerun detects retained plan → resume from spawn.

### Risks

- Arbitrary subprocess execution: registry resolution (Phase 6) must reject unknown callback names *before* any spawn.
- Branch protection blocks merge post-green: callback writes `merge_failed`; plan + tempfiles retained for user diagnosis.

### Verification

```bash
node --experimental-strip-types --test \
  plugins/stark-gh/tools/__tests__/merge_complete_oid_reverify.test.ts \
  plugins/stark-gh/tools/__tests__/merge_complete_secret_rescan.test.ts \
  plugins/stark-gh/tools/__tests__/merge_execute_spawn_fail.test.ts
```

## Phase 8: Command, Registration, Docs, Integration

**Goal:** Expose the slash command without LLM/unsafe-shell logic in the body; verify the full pipeline end-to-end. **Command landing is gated on integration tests + disposable-PR smoke passing** (PR4-codex H14/H22).
**Dependencies:** Phases 1–7.
**Estimated effort:** S.

### Task ordering (PR4-codex H14 — release verification before exposure)

Within Phase 8, tasks run in order: **task 4 (integration test) → task 5 (disposable-PR smoke) → task 1 (command file) → task 2 (registration) → task 3 (install verify)**. The slash command markdown is the LAST file to land. Each gate writes a go/no-go marker to `~/.claude/code-review/stark-gh/release/<runId>.json` consumed by the next gate.

### Tasks

1. **Add `plugins/stark-gh/commands/pr-merge.md` (lands LAST after gates pass).**
   - Mirror `pr-open.md` structure.
   - Forward `$ARGUMENTS` exactly once as `--raw-args "$ARGUMENTS"`.
   - Run preflight, draft, execute via `node --experimental-strip-types` from `$HOME/.claude/plugins/stark-gh/tools` (install path).
   - **Cross-stage cleanup trap (PR4-codex H33):** body installs `trap 'node --experimental-strip-types $TOOLS/lib/restore_branch.ts "$PLAN_FILE"' EXIT` after preflight succeeds and before draft/execute. Trap is disarmed (`trap - EXIT`) immediately after a successful push (Phase 5 task 5 reports back via stdout marker `STARK_GH_PUSHED=1`).
   - **Resume-mode handling:** when preflight emits `STARK_GH_RESUME=spawn-only`, slash body skips draft and calls execute in resume mode (`--resume-from-spawn`).
   - **Kill switch (PR4-codex H22):** body refuses to run unless `STARK_GH_PR_MERGE_ENABLE=1` is set in env OR `~/.claude/code-review/stark-gh/release/enabled.flag` exists. Print: "Set STARK_GH_PR_MERGE_ENABLE=1 to enable. v1 is gated on operator opt-in." This is removed in v1.1 after the disposable-PR smoke runbook has been exercised by ≥2 operators.
   - **Zero LLM logic** in markdown body. Smoke test asserts the body contains no LLM/Agent invocation strings.

2. **Register and document — explicit verification (PR4-claude H02).**
   - Run `claude --list-commands 2>&1 | grep -q '/stark-gh:pr-merge'` after the command file lands. If not listed, add the command entry to `plugins/stark-gh/.claude-plugin/plugin.json` mirroring pr-open's entry verbatim. (No conditional language — explicit verification + corrective action.)
   - Update `plugins/stark-gh/README.md` with usage, manual smoke-test runbook, kill-switch instructions, and the post-merge recovery procedure (`originalPRBranch` is recovery anchor until `/stark-gh:cleanup`).
   - Update root `CLAUDE.md` Pipeline section with `/stark-gh:pr-merge`.

3. **Install verification.**
   - `./install.sh --status` (matches existing pr-open verification command — codex weakness fix from claude review).
   - Confirm `~/.claude/plugins/stark-gh/commands/pr-merge.md` resolves through the install symlink.

4. **End-to-end integration test.**
   - Create `plugins/stark-gh/tools/__tests__/integration_merge_happy.test.ts`.
   - Use a fixture repo + `gh` shim that returns canned GraphQL rollup responses (green checks against `pushedHeadOid`).
   - Assert: rebase happens, changelog marker inserted, explicit-lease push command shape, GraphQL query shape, squash-merge call shape, terminal state `merged`, cleanup hint contains `/stark-gh:cleanup --pr N` (no raw shell).

5. **Manual smoke procedure.**
   - Document in `plugins/stark-gh/README.md` a disposable-PR smoke test against this repo's CI (codex weakness — make destructive-test explicit, not part of automated coverage).
   - Required precheck: `gh auth status`.

### Risks

- Slash command accidentally drifts from thin-wrapper contract: smoke test asserts no LLM strings in the body.
- Plugin registration may be schema-sensitive: verify against current installed plugin behavior before changing metadata shape.
- Manual smoke is destructive (rebases, pushes, merges): use a fixture branch with manual approval, not automated CI.

### Verification

```bash
node --experimental-strip-types --test plugins/stark-gh/tools/__tests__/integration_merge_happy.test.ts
./install.sh --status
test -f "$HOME/.claude/plugins/stark-gh/commands/pr-merge.md"
gh auth status
```

## 4. Integration Points

- **Slash command → Stage 1:** `$ARGUMENTS` is the only untrusted string, passed as one `--raw-args` value.
- **Plan-file:** `PrMergePlan` is the contract across stages and watcher callback. Idempotency-critical fields: `runId`, `originalHeadOid`, `rebasedHeadOid`, `changelogCommitOid`, `pushedHeadOid`, `changelog.markerComment`.
- **Changelog marker:** `<!-- stark-gh:pr-merge pr=<N> runId=<UUID> -->` is the durable rerun key embedded in `CHANGELOG.md` itself; survives plan-file deletion.
- **GitHub checks:** all green decisions use `lib/checks_graphql.ts` with `expectedHeadOid` enforcement. `gh pr checks` is rejected.
- **Secret handling:** Stage 1 pre-LLM, Stage 3 pre-commit, watcher pre-merge — all share `lib/secret.ts` semantics.
- **Watcher state:** execute retains plan after push; watcher/callback owns terminal cleanup. `head_moved`/`base_moved`/`secret_in_prose` are callback-owned states (not watcher-owned).
- **Merge boundary:** `gh pr merge` is the trust boundary for branch protection; `--force` never bypasses it. `--force` also never bypasses `--no-watch`'s green-check requirement (round-4 critical fix `c827008`).
- **Lock format change:** Phase 6 task 2 verifies pr-open watcher consumers continue to work with the new `{pid, startedAt, hostname, ownerToken}` shape.

## 5. Testing Strategy

Implement tests in dependency order:

1. **Library units:** `plan`, `changelog`, `draft_schema`, `checks_graphql`, `verify_oids`, `audit`, `watcher_callbacks`.
2. **Stage tests:** preflight gates + rebase + secret-scan + watcher-recovery + local-sync; draft validation; execute push/rollback/no-watch/idempotency/spawn-fail.
3. **Watcher:** lock liveness, SHA filter, max-wait, callback registry, terminal states, pr-open compat.
4. **Callback:** OID re-verify, secret rescan.
5. **Integration:** fixture repo + `gh` shim with green GraphQL.
6. **Manual smoke:** authenticated, disposable PR (Phase 8 task 5).

**Full test file list** (every design rt mitigation has explicit coverage):

| Test file | Domain | rt/H mitigation |
|-----------|--------|-----------------|
| `plan.test.ts` | Phase 1 | discriminated union, watchTimeoutHours persistence |
| `override_audit.test.ts` | Phase 1 | R3-codex/security |
| `changelog_lib.test.ts` | Phase 2 | rt7 marker |
| `checks_graphql_pagination.test.ts` | Phase 2 | R3-codex/api-design |
| `merge_draft_validation.test.ts` | Phase 2/4 | R3-claude/api-design |
| `merge_preflight_args.test.ts` | Phase 3 | shell-quote round-trip |
| `merge_preflight_gates.test.ts` | Phase 3 | full Gate Matrix × force |
| `merge_preflight_rebase.test.ts` | Phase 3 | conflict abort + startingRef restore |
| `merge_preflight_watcher_recovery.test.ts` | Phase 3 | H12/H14/R2-H11 |
| `merge_preflight_local_sync.test.ts` | Phase 3 | R2-H3 |
| `merge_preflight_self_modifying.test.ts` | Phase 3 | PR1-codex/security critical |
| `merge_rollback_force_push.test.ts` | Section 6 | PR1-codex/rollback critical 1 |
| `codex_env_scrub.test.ts` | Phase 4 | PR4-claude H29 |
| `watcher_backoff.test.ts` | Phase 6 | PR4-claude H24 |
| `restore_branch.test.ts` | Phase 1 | PR4-codex H33 (cross-stage cleanup) |
| `merge_complete_head_moved.test.ts` | Phase 6 | PR4-codex H35 (watcher writes head_moved) |
| `kill_switch.test.ts` | Phase 8 | PR4-codex H22 (STARK_GH_PR_MERGE_ENABLE gate) |
| `merge_preflight_secret_scan.test.ts` | Phase 3 | R2-H17 |
| `merge_draft.test.ts` | Phase 4 | codex stub + tempfile placement |
| `merge_execute_secret_scan.test.ts` | Phase 5 | H05/H16 + R2-H18 |
| `merge_execute_changelog.test.ts` | Phase 5 | scan→redact→write→commit ordering |
| `merge_execute_push.test.ts` | Phase 5 | rt5 + rollback (R3-claude/resilience) |
| `merge_execute_no_watch.test.ts` | Phase 5 | R2-H8/H9 + always-enforced critical |
| `merge_execute_idempotency.test.ts` | Phase 5 | rt7 byte-identical + replace |
| `watcher_on_green.test.ts` | Phase 6 | H13 + R2-H15/H16 |
| `watcher_max_wait.test.ts` | Phase 6 | R2-H4/H12 |
| `watcher_pr_open_compat.test.ts` | Phase 6 | codex review weakness |
| `merge_complete_oid_reverify.test.ts` | Phase 7 | rt4 |
| `merge_complete_secret_rescan.test.ts` | Phase 7 | H01 |
| `merge_execute_spawn_fail.test.ts` | Phase 7 | R3-codex/completeness |
| `integration_merge_happy.test.ts` | Phase 8 | end-to-end + rt3 cleanup hint |

Primary command:
```bash
node --experimental-strip-types --test plugins/stark-gh/tools/__tests__/*.test.ts
```

## 6. Rollback Plan

Each phase is independently rollback-able by reverting its commits; no destructive remote actions are taken before Phase 5.

- **Phase 1–2:** revert; pr-open tests still pass.
- **Phase 3:** revert preflight tool; no command exposed yet.
- **Phase 4:** revert draft tool + schema; preflight plans become inert without command registration.
- **Phase 5:** revert execute tool. See "Operational rollback — force-pushed PR" below if a test run reached the push step.
- **Phase 6:** revert watcher modifications; pr-open watcher behavior must be preserved (Phase 6 task 2 compat verification).
- **Phase 7:** revert callback + execute default-watch wiring; sync `--no-watch` path remains functional.
- **Phase 8:** revert command markdown; install symlink no longer exposes `/stark-gh:pr-merge` after `./install.sh --status` refresh.

### Operational rollback — force-pushed PR (PR1-codex/rollback critical 1)

The plan-file holds `originalHeadOid` (PR's pre-rebase head). If a test run force-pushed and the run must be undone:

```bash
# 1. Read originalHeadOid from the retained plan-file
ORIG=$(jq -r .originalHeadOid <plan-file>)
# 2. Restore the remote head with an explicit-OID lease back to current pushedHeadOid
PUSHED=$(jq -r .pushedHeadOid <plan-file>)
git fetch --no-tags origin <headRef>
git push --force-with-lease=refs/heads/<headRef>:$PUSHED \
  origin $ORIG:refs/heads/<headRef>
```

**Operator confirmation required.** This rewrites remote history and must be reviewed by a human before invocation. Test coverage: fixture in `merge_rollback_force_push.test.ts` — populates a fake plan, runs the restore command via shim, asserts the resulting remote head equals `originalHeadOid`.

### Operational rollback — post-merge defect (PR1-codex/rollback critical 2)

`gh pr merge --squash` is irreversible: the squash commit is a **single-parent commit on the base branch**; the original PR commit graph is **not** referenced by the squash commit and becomes orphaned once the remote branch is deleted (PR2-claude/feasibility critical fix). Recovery procedure:

1. **Capture the merge commit SHA** from the watcher's terminal state file (`status: merged`, `merge_sha`).
2. **Revert via PR:** `git revert <merge_sha>` on a fresh branch off `baseRef`, then `gh pr create --base <baseRef> --title "Revert: <orig title>" --body "Reverts #<orig PR>"`.
3. **Original PR branch remains as recovery anchor in v1** (PR3-codex/rollback fix): pr-merge does NOT delete the remote branch; `/stark-gh:cleanup` does, and only when the operator explicitly invokes it. The branch ref `refs/heads/<headRef>` continues pointing at `pushedHeadOid` after merge, so the original commits stay reachable for as long as the branch exists. Recovery: simply `git fetch origin <headRef>` and inspect/cherry-pick from `origin/<headRef>`. After the operator runs `/stark-gh:cleanup`, the branch is deleted and the commits become reachable only via `gh api repos/{owner}/{repo}/git/commits/{pushedHeadOid}` for a finite GC window.

Treat the merge call as an irreversible boundary requiring operator readiness.

## Considered & Rejected — plan-review round 2 (2026-04-28)

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| PR2-codex/sequencing + feasibility (3 criticals) | security | Self-modifying-PR refuse gate is sequenced after tool code is loaded; install symlink is not a trusted control plane | **Acknowledged — v1 known limitation.** The refuse gate is defense-in-depth (catches accidental misuse, not determined attackers). Authoritative fix requires install-by-copy + content-hash manifest verified on each invocation, which is a stark-skills-wide hardening initiative covering all plugins (pr-open, every other skill). Out of scope for pr-merge v1; tracked separately. v1 mitigation: refuse gate + explicit README documentation + operator-readable exit-19 message |

## Considered & Rejected — plan-review round 1 (2026-04-28)

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| PR1-codex/security (Codex sandboxing critical) | security | Codex subprocess receives untrusted PR text without a sandbox; "make sandboxing part of v1 or replace Codex" | **Affirmed deferred (R2-H14 carryover).** `codex exec` runs in non-agentic mode here — single inference call producing JSON output. No tool execution loop, no shell tools, no approval escalation. Output is schema-validated by `validateDraft` (rejects `Closes`/`Refs`/`#N`/embedded newlines/additional properties); impact bound to the three drafted prose fields. Prompt-injection risk reduces to "model produces awkward CHANGELOG bullet text," which is not a security-critical outcome. Cross-cutting hardening (run with neutral cwd, no GH tokens in env, no network beyond model call) tracked separately as a stark-skills-wide initiative |

## Operational Contracts (PR4 round 4 additions)

### Minimal v1 runtime-state policy (PR4-codex H20)

V1 cannot ship full GC, but defines contracts so retained state doesn't drift:

- **Plan-file:** unlinked on terminal success; retained on `merge_failed`/`base_moved`/`head_moved`/`secret_in_prose`/`watch_timeout`/`auth_failed`/`spawn_fail`. Manual cleanup: `find ~/.claude/code-review/stark-gh/runtime -name '*-plan-*.json' -mtime +7 -exec rm {} \;` documented in README.
- **Watcher state files (`latest.json`):** retained indefinitely; manual cleanup via `/stark-gh:cleanup --pr N` once user reviews terminal state.
- **`originalChangelogPath` tempfiles:** unlinked when plan-file is unlinked.
- **Audit log:** rotated when > 10 MiB. Rotation rule lives in `lib/audit.ts`; on append, if file size > 10 MiB, rename to `pr-merge.log.<timestamp>.gz` (gzipped) and start fresh. No automatic deletion of rotated files in v1.
- **Operator runbook in README:** lists every retained-state location + manual-cleanup commands. Stark-housekeeping integration tracked in follow-up (per Out of Scope).

### Lock-format rollback (PR4-codex H26)

Phase 6 ships a tolerant reader (accepts old + new formats). Rollback to pre-Phase-6 code requires the **old reader to ignore new-format locks**:

- **Pre-Phase-6 code already ignores any lock it can't parse** (existing pr-open behavior). Rolling back Phase 6 means: new-format locks on disk are simply ignored by the reverted code, which then writes its own old-format lock. **No lock-corruption window** because both readers fail-closed (treat unparseable as missing) — the worst case is a new lock is written next to an old, and the next watcher run resolves it.
- Rollback step in Section 6: revert Phase 6 commits + advise operator to wait for in-flight new-format watchers to terminate before relying on rolled-back behavior.

### Timeline & test budget (PR4-codex H36/H37)

Concrete estimates (calendar days; 1 day = ~6 productive hours; assumes one developer). Includes **20% buffer per phase** + **30% buffer at release level**. Replan if any phase exceeds 1.5× its budget.

| Phase | Goal | Effort | Days (est) |
|------:|------|:------:|:----------:|
| 1 | Foundation contracts + audit + git/restore lib | M | 2 |
| 2 | Shared libs (changelog, draft schema, GraphQL, verify_oids, callbacks) | L | 4 |
| 3 | Preflight stage (gates, fetch, scan, rebase, blob capture) | L | 4 |
| 4 | Draft stage + Codex hardening | M | 2 |
| 5 | Execute stage `--no-watch` + push rollback | L | 4 |
| 6 | Watcher modifications + compat + debounce + heartbeat + rate-limit | L | 4 |
| 7 | Watcher callback + Stage 3 default-watch + spawn-fail resume | M | 2 |
| 8 | Command + integration + smoke + release gate | S | 1 |
| **Subtotal** | | | **23** |
| Buffer (30% release-level) | | | **7** |
| **Total** | | | **~30 days** |

**Test budget:** ~25 test files (see Section 5 matrix). Estimate 2–4 hours per file (fixtures + assertions + flaky-timing handling for watcher tests). Total test-only effort: **~10 days** distributed across phases (already included in the per-phase estimates above; tests are written alongside implementation, not as a separate phase). Manual smoke (Phase 8 task 5) is +0.5 day, not in the subtotal.

## 7. Out of Scope (deferred from synthesis)

These were in codex's Phase 8 but were flagged by both claude and gemini as v1 scope creep:

- **Runtime maintenance / GC** for retained plan-files, terminal watcher states, audit-log rotation. Tracked separately as `2026-04-28-stark-gh-runtime-maintenance-plan.md` (to be created); v1 ships without it.

These were in the design as deferred items and remain so:

- Cross-repository (fork) PR support (rt1).
- `/stark-gh:cleanup` slash command (handles local checkout + branch delete).
- Auto-resuming an interrupted watcher (v1 prints orphan hint via exit `34`).
- Concurrent-merge contention mitigation via per-PR changelog fragments (rt6 / R2-H13).
- Codex subprocess sandboxing (R2-H14 — cross-cutting hardening).

## 8. Implementation Notes — Ambiguities Flagged

(Synthesis from claude's Implementation Notes section + cross-review observations.)

1. **`changelogCommitOid` byte-identical first run:** Phase 5 task 3 — when the changelog write is a no-op (rare, but possible if the user manually inserted the exact same bullet), capture the post-step `HEAD` SHA into `changelogCommitOid` so the plan-file isn't left with `null`. The push step then has a stable rollback target.
2. **SSH vs HTTPS origin URLs:** Phase 5 task 4 — normalize both to `owner/repo` before comparing with `nameWithOwner`. Common in mixed-clone setups.
3. **Pushed SHA capture:** Phase 5 task 5 — strictly `git rev-parse HEAD` after successful push. Do NOT parse `git push --porcelain` output (claude's clever idea, but deviates from the spec contract).
4. **`chore(changelog)` commit subject format:** the design says `chore(changelog): <bullet text>` but the bullet always begins with `- `; stripping the leading `- ` produces a clean conventional commit. Spec to be amended OR Phase 5 task 3 documents the strip explicitly; tests assert the stripped form.
5. **GraphQL pagination edge case:** Phase 2 task 3 — partial pages cannot satisfy the predicate; `fetchRequiredCheckRollup` aggregates all pages before returning.
6. **Lock-format migration for in-flight pr-open watchers:** Phase 6 task 2 — verify or migrate; do not silently break running watchers.
7. **`kill -0` portability (PR1-claude/feasibility):** liveness check uses POSIX `kill -0 <pid>`. Linux/macOS supported; Windows is out of scope for v1. `lib/process.ts` exposes `isProcessAlive(pid, startedAt)` with a clear errno mapping; on `EPERM` the process exists (treat as alive); on `ESRCH` it does not. Tests cover both branches.
8. **Trusted control plane execution path (PR1-codex/security):** the slash command body invokes node with `TOOLS="$HOME/.claude/plugins/stark-gh/tools"` (matches pr-open). Implementation must verify this resolves to the install symlink, not to a path inside the PR's working tree. Phase 8 task 3 asserts the path resolution.

## 9. Synthesis Decisions

- **Base:** codex plan structure (Phases 1–8).
- **Merged from claude:** Implementation Notes section, testability mapping (test file → rt mitigation), `--no-watch` path proven before async watcher (Phase 5 ordering).
- **Discarded from claude (both reviewers flagged):** `head_moved` placed in generic watcher (kept callback-owned), `git push --porcelain` SHA capture (deviates from spec).
- **Discarded from codex (both reviewers flagged):** `gh_runtime_maintenance.ts` Phase 8 task — moved to follow-up plan (Section 7).
- **Net additions resolving codex review weaknesses:**
  - Explicit Gate Matrix enumeration (Phase 3 task 2).
  - pr-open watcher backward-compat task (Phase 6 task 2).
  - `override_audit.test.ts` listed in Phase 1 verification.
  - `chore(changelog)` commit-message format reconciled (Implementation Notes #4).
  - Spawn-fail resume entry point explicit in Phase 3 task 4 + Phase 7 task 3.
  - `runId` generated before any auditable gate (Phase 1 task 5).
  - `verifyMergeOids` accepts full plan / PR-identity (Phase 2 task 4).
  - Exit `14` (base OID moved between fetch and plan write) implemented in Phase 3 task 9.
  - `execute.watchTimeoutHours` persisted in plan-file (Phase 1 task 2).
  - Origin URL normalization for SSH/HTTPS (Phase 5 task 4 + Implementation Notes #2).
  - `./install.sh --status` instead of `bun run install.sh --status` (Phase 8 task 3).
  - Disposable-PR smoke as manual-only (Phase 8 task 5).
