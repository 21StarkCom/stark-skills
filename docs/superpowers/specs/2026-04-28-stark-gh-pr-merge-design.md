# stark-gh:pr-merge Design Spec

## Overview

`/stark-gh:pr-merge` is the second command in the `stark-gh` plugin (after `/stark-gh:pr-open`). It rebases an open PR onto its base, drafts a squash commit message and a `CHANGELOG.md` entry via Codex, force-pushes the rebased branch with the changelog appended, then waits for CI and squash-merges once green.

The command builds on pr-open's three-stage TS pipeline (preflight → draft → execute) and reuses `gh_watch_runs.ts` with a new "on-green merge" callback. The slash command body has zero LLM logic — all drafting happens in the Stage 2 TS tool that subprocess-calls Codex.

Local cleanup (checkout main, delete local branch) is **not** automated by this command — it lives in a future `/stark-gh:cleanup` command. The watcher's final state file prints the cleanup commands for the user to run when they switch context.

## Decisions

| Decision | Choice |
|----------|--------|
| Command | `/stark-gh:pr-merge` |
| Pipeline | Three TS stages mirroring pr-open: preflight → draft → execute |
| Parent skill model | Sonnet 4.6 (Claude Code harness running `commands/pr-merge.md`); does not draft |
| Sub-agent | Codex (default `gpt-5.5`, reasoning effort `medium`); shared `lib/codex.ts` from pr-open |
| Target PR | Default: current branch's open PR (via `gh pr view`). `--pr N` flag overrides |
| PR identity (rt1) | Capture `headRepositoryOwner`, `headRepositoryName`, `headRefOid`, `isCrossRepository`. Reject cross-repo (fork) PRs in v1. Verify `origin/<headRef>` resolves to `headRefOid` before rebase/push. |
| Merge strategy | Squash-merge after rebase. No flag for alternative strategies |
| Rebase | Local rebase onto `origin/<baseRef>`; force-push with **explicit-OID** lease (rt5) |
| Force-push lease (rt5) | `git push --force-with-lease=refs/heads/<headRef>:<originalHeadOid>` where `originalHeadOid` is captured from the PR's pre-rebase head. Implicit `--force-with-lease` is forbidden — local tracking refs are mutable mid-flow |
| Drafting | Always-on. Stage 2 produces three artifacts: squash subject, squash body, single changelog bullet |
| Changelog write | Append bullet to `## [Unreleased]` → `### <Section>` in `CHANGELOG.md` on the PR branch *before* force-push, so the squash-merge contains both the change and the entry atomically |
| Changelog section | Default inferred from PR labels (`bug`/`fix` → Fixed; otherwise Added). `--changelog-section` flag overrides |
| Changelog file | Repo root `CHANGELOG.md`. Fail in preflight if absent |
| Fail-fast gates | PR must be: not draft, not closed/merged, no requested-changes review, all required checks passing or pending (not failing), `mergeable` ≠ `CONFLICTING`. `--force` bypasses these (does NOT bypass GitHub branch protection) |
| Args policy | Slash body forwards `$ARGUMENTS` as one quoted `--raw-args` to preflight (same as pr-open) |
| Watcher | Background by default; new `--on-green` callback mode in `gh_watch_runs.ts` invokes a configured tool with the plan-file path. `--no-watch` requires checks already green at push time |
| Local cleanup | Not automated. Watcher final state file prints `/stark-gh:cleanup --pr N` (rt3) — never raw shell containing untrusted ref names. Future `/stark-gh:cleanup` will own the actual cleanup |
| Idempotency (rt7) | Plan/state schema includes `runId`, `originalHeadOid`, `changelogCommitOid`, `pushedHeadOid`, `changelogBulletHash`. Reruns detect existing tool-created changelog entry by hash and update it in place rather than appending |
| Secret scan | Reuse pr-open's two-point scan + override flags (`--allow-secret-commit`, `--allow-secret-to-llm`). Drafted changelog bullet runs through pre-commit scan before changelog write |
| State integrity | Preflight captures `baseOid` and `rebasedHeadOid`. Execute re-verifies before force-push and again before merge |
| Runtime tempdir | Same as pr-open: `~/.claude/code-review/stark-gh/runtime/` |
| Output validation | TS validates Stage 2 output: subject ≤ 72 chars (squash-commit convention), body ≤ 16 KB, bullet must start with `- ` and be a single line ≤ 200 chars; rejects `Closes`/`Refs` lines (issue linking is pr-open's responsibility) |

## Command Surface

```
/stark-gh:pr-merge [--pr N]
                   [--changelog-section Added|Changed|Fixed|Removed|Deprecated|Security]
                   [--force]
                   [--no-watch]
                   [--allow-secret-commit]
                   [--allow-secret-to-llm]
```

## Pipeline Architecture

### Stage 1 — Preflight (`gh_pr_merge_preflight.ts`)

1. Parse `--raw-args` via shared `lib/shell_quote.ts`.
2. Resolve target PR:
   - If `--pr N`, fetch by number.
   - Else `gh pr view --json number,headRefName,baseRefName,url,isDraft,state,mergeable,reviewDecision,labels,headRepositoryOwner,headRepository,isCrossRepository,headRefOid`.
   - Fail with exit `10` if no PR for current branch (when `--pr` not given).
3. **PR identity gate (rt1):** if `isCrossRepository == true`, exit `17` (fork PRs unsupported in v1). Capture `headRepositoryOwner`, `headRepositoryName`, `headRefOid` (= `originalHeadOid`).
4. Fail-fast gates (skip with `--force` where noted):
   - `state == OPEN` (always enforced, even with `--force`)
   - `isDraft == false` (force-bypassable)
   - `reviewDecision != CHANGES_REQUESTED` (force-bypassable)
   - Required checks not failing (force-bypassable)
   - `mergeable != CONFLICTING` (always enforced — rebase requires non-conflicting state at PR level)
5. `git fetch --no-tags origin <baseRef> <headRef>`.
6. **Verify head identity (rt1):** `git rev-parse origin/<headRef>` must equal `originalHeadOid`. Else exit `17` (PR head moved or local fetch is stale).
7. Capture `baseOid = origin/<baseRef> SHA`.
8. Local rebase: check out `headRef`, run `git rebase origin/<baseRef>`. On conflict: `git rebase --abort`, exit `13`.
9. Capture `rebasedHeadOid = HEAD SHA`.
10. Verify `CHANGELOG.md` exists at repo root and contains `## [Unreleased]`. Else exit `15`.
11. Resolve changelog section: `--changelog-section` flag, else label-inferred (`bug`/`fix` label → Fixed; else Added).
12. Run pre-LLM secret scan (reuse pr-open's `lib/secret.ts`) over: PR title, PR body, commit messages on the rebased branch, diff vs base. Exit `16` if found and `--allow-secret-to-llm` not set.
13. Generate `runId` (UUIDv4) for idempotency keys (rt7).
14. Write plan-file to runtime dir, mode `0600`. Emit path on stdout.

### Stage 2 — Draft (`gh_pr_merge_draft.ts`)

1. Read plan-file.
2. Build prompt for Codex with `untrusted`-wrapped fields:
   - PR title, body, commit messages on rebased branch
   - Diff summary (file shortstat + change-type)
   - Target changelog section name
3. Subprocess-call `codex exec` (shared `lib/codex.ts`).
4. Parse JSONL response; expect `{ subject, body, changelog_bullet }`.
5. Validate output (caps + format rules above). Retry once on validation failure.
6. Write three tempfiles under runtime dir, mode `0600`.
7. Atomic-update plan-file with tempfile paths.

### Stage 3 — Execute (`gh_pr_merge_execute.ts`)

1. Read plan-file. Re-fetch `origin/<baseRef>` and `origin/<headRef>`.
2. Verify `baseOid` unchanged and `origin/<headRef>` still equals `originalHeadOid`; else exit `30`.
3. Verify local `HEAD` SHA matches `rebasedHeadOid`; else exit `30` (working tree moved).
4. **Idempotency check (rt7):** read existing `CHANGELOG.md`. If a bullet matching `changelogBulletHash` already exists under `[Unreleased]`, skip the insert (rerun-safe). Else apply changelog edit via `lib/changelog.ts`:
   - Find `## [Unreleased]` line.
   - Locate or create `### <Section>` subsection beneath it.
   - Insert bullet at top of subsection.
   - Atomic write.
5. Run pre-commit secret scan over: changelog bullet, drafted subject, drafted body. Exit `28` if found and `--allow-secret-commit` not set; else if override set, redact spans from drafted prose before merge.
6. Stage and commit changelog (skip if step 4 was a no-op): `git add CHANGELOG.md && git commit -m "chore(changelog): <bullet text without leading dash>"`. Capture `changelogCommitOid`.
7. Verify origin URL matches PR's `nameWithOwner`; else exit `31`.
8. **Explicit-OID force-push (rt5):** `git push --force-with-lease=refs/heads/<headRef>:<originalHeadOid> origin HEAD:refs/heads/<headRef>`. Exit `31` on rejection.
9. Capture `pushedHeadOid = HEAD SHA` and atomic-update plan-file with `changelogCommitOid` and `pushedHeadOid` (rt7).
10. If `--no-watch`:
    - Re-fetch PR; require all required checks already success.
    - Else exit `12`.
    - Run `gh pr merge --squash --subject-file <f> --body-file <f> --delete-branch <pr#>`. Exit `32` on failure.
    - Print merge SHA + PR URL.
11. Else (default):
    - Spawn `gh_watch_runs.ts --on-green-tool gh_pr_merge_complete.ts --plan-file <path>` in background. Exit `33` on spawn failure.
    - Print PR URL + watcher state-file path.
12. Unlink plan-file (sync mode) or pass ownership to watcher (background mode).

### Watcher merge callback

Extend `gh_watch_runs.ts` with `--on-green-tool <path>` flag. When checks reach success, watcher subprocess-invokes the configured tool with the plan-file path.

For pr-merge, the on-green tool (`gh_pr_merge_complete.ts`) does:
1. Read plan-file.
2. **OID re-verify (rt4):** `git fetch --no-tags origin <baseRef>` and `gh pr view --json headRefOid,baseRefOid`. If `baseOid` differs from plan, write terminal state `base_moved` and exit (no merge). If PR `headRefOid` differs from `pushedHeadOid` in plan, write terminal state `head_moved` and exit.
3. Run `gh pr merge --squash --subject-file <f> --body-file <f> --delete-branch <pr#>`.
4. Capture merge SHA.
5. Write final watcher state file with status `merged`, merge SHA, and a cleanup hint **using slash-command form (rt3)**:
   ```
   Merge complete. To clean up locally, run:
     /stark-gh:cleanup --pr <N>
   ```
   The hint never contains raw shell commands with untrusted ref names.
6. Unlink plan-file and prose tempfiles.

If merge fails post-green (e.g., branch protection blocks): write final state with status `merge_failed` and surface stderr verbatim. Branch is not deleted.

## Plan-File Schema

```json
{
  "version": 1,
  "command": "pr-merge",
  "runId": "uuid-v4",
  "pr": {
    "number": 123,
    "headRef": "feat/foo",
    "baseRef": "main",
    "url": "https://github.com/...",
    "nameWithOwner": "Evinced/stark-skills",
    "headRepositoryOwner": "Evinced",
    "headRepositoryName": "stark-skills",
    "isCrossRepository": false
  },
  "baseOid": "<sha>",
  "originalHeadOid": "<sha>",
  "rebasedHeadOid": "<sha>",
  "changelogCommitOid": "<sha or null until step 6>",
  "pushedHeadOid": "<sha or null until step 9>",
  "changelog": {
    "filePath": "/abs/path/CHANGELOG.md",
    "section": "Added",
    "bulletHash": "sha256-of-bullet-text"
  },
  "stage2": {
    "skip": false,
    "subjectFile": "/runtime/.../subject.txt",
    "bodyFile": "/runtime/.../body.md",
    "changelogBulletFile": "/runtime/.../bullet.txt",
    "model": "gpt-5.5",
    "reasoningEffort": "medium"
  },
  "execute": {
    "watch": true,
    "force": false,
    "secretOverrides": { "commit": false, "toLlm": false }
  }
}
```

`runId`, `originalHeadOid`, `changelogCommitOid`, `pushedHeadOid`, and `changelog.bulletHash` form the rt7 idempotency-key set. Reruns detect existing tool-created changelog entries by `bulletHash` and update in place rather than appending duplicates.

The `lib/plan.ts` module gains a discriminator on `command` (`"pr-open"` vs `"pr-merge"`) and per-command field types.

## Exit Codes

Reuse pr-open's stable codes where applicable; merge-specific codes added:

| Code | Stage | Meaning |
|------|-------|---------|
| 0 | any | success |
| 10 | preflight | bad args / unknown PR / no PR for current branch |
| 11 | preflight | PR is draft, closed, or merged (no `--force` for draft) |
| 12 | preflight / execute | failing or missing required checks (no `--force`); or `--no-watch` with non-green checks |
| 13 | preflight | rebase conflict |
| 14 | preflight | base OID moved between fetch and plan write |
| 15 | preflight | CHANGELOG.md missing or has no `[Unreleased]` section |
| 16 | preflight | secret in pre-LLM scan, no `--allow-secret-to-llm` |
| 17 | preflight | cross-repository (fork) PR — unsupported in v1 (rt1); or `origin/<headRef>` != PR's `headRefOid` |
| 20 | draft | codex error / invalid output after retry |
| 28 | execute | secret in pre-commit scan, no `--allow-secret-commit` |
| 30 | execute | base OID or rebased HEAD moved between push and merge |
| 31 | execute | force-push rejected, or origin URL mismatch |
| 32 | execute | gh merge failed (non-OID reason; e.g., branch protection) |
| 33 | execute | watcher spawn failed |

## Repository Structure

```
plugins/stark-gh/
├── commands/
│   ├── pr-open.md                    # existing
│   └── pr-merge.md                   # NEW
├── tools/
│   ├── gh_pr_merge_preflight.ts      # NEW Stage 1
│   ├── gh_pr_merge_draft.ts          # NEW Stage 2
│   ├── gh_pr_merge_execute.ts        # NEW Stage 3
│   ├── gh_pr_merge_complete.ts       # NEW watcher on-green callback
│   ├── gh_watch_runs.ts              # MODIFIED: add --on-green-tool flag
│   ├── lib/
│   │   ├── changelog.ts              # NEW: insert bullet under [Unreleased] → <Section>
│   │   ├── plan.ts                   # MODIFIED: extend schema for pr-merge
│   │   └── (rest reused unchanged)
│   └── __tests__/
│       ├── merge_preflight_args.test.ts
│       ├── merge_preflight_gates.test.ts
│       ├── merge_preflight_rebase.test.ts
│       ├── merge_draft.test.ts
│       ├── merge_execute_changelog.test.ts
│       ├── merge_execute_push.test.ts
│       ├── merge_execute_merge.test.ts
│       ├── changelog_lib.test.ts
│       ├── watcher_on_green.test.ts
│       └── integration_merge_happy.test.ts
└── README.md                         # MODIFIED: add pr-merge usage + smoke test
```

Also modified:
- `plugins/stark-gh/.claude-plugin/plugin.json` — register pr-merge
- `CLAUDE.md` — add command to Pipeline section

## Testing

Mirror pr-open's per-unit + per-stage + integration layout:
- **Unit:** `changelog_lib.test.ts` covers all `[Unreleased]` insertion edge cases (missing section, empty section, multiple subsections, nested headers).
- **Stage:** preflight gate matrix (draft/closed/changes-requested/check-failure × force/no-force), rebase success + abort, draft validation, execute changelog write + force-push + merge invocation.
- **Watcher mode:** `watcher_on_green.test.ts` covers callback invocation with plan-file path, terminal failure handling, idempotency under repeated polls.
- **Integration:** `integration_merge_happy.test.ts` end-to-end with `gh` shim — fakes a green CI, asserts squash-merge call shape and final state file content.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Force-push triggers CI re-run; watcher polls stale checks from before force-push | Watcher polls by current head SHA; force-push changes the SHA, so old check runs are not picked up |
| Base moves during the wait window | Watcher's on-green callback re-verifies `baseOid` and `pushedHeadOid` (rt4); on mismatch, writes terminal state `base_moved` or `head_moved` and aborts merge |
| PR identity confused with branch name | rt1 mitigations: capture `headRefOid` + reject cross-repo PRs in v1; verify `origin/<headRef>` resolves to captured OID before rebase |
| Implicit `--force-with-lease` overrides collaborator commits | rt5: explicit-OID lease using `originalHeadOid` captured pre-rebase |
| Cleanup hint contains shell metacharacters from untrusted ref | rt3: cleanup hint uses slash-command form `/stark-gh:cleanup --pr N`, never raw shell with refs |
| Rerun creates duplicate changelog entries | rt7 idempotency keys: `bulletHash` matched against existing `[Unreleased]` content; existing tool-created bullet updated in place |
| Branch protection blocks `gh pr merge` post-green | `gh_pr_merge_complete.ts` surfaces stderr; final state shows `merge_failed`; branch not deleted |
| User edits CHANGELOG.md between preflight and execute | Changelog write does atomic file replacement; conflicts resolved by re-running (preflight re-reads file each time). Acceptable race for a single-user dev tool |
| Secret in drafted prose | Two-point scan reused from pr-open (pre-LLM + pre-commit); changelog bullet included in pre-commit scan |
| Local rebase on a worktree where user has uncommitted changes | Preflight refuses if `git status --porcelain` is non-empty (separate exit code candidate; included under exit `13` for v1) |
| Watcher dies mid-poll, merge never happens | Same lock + state model as pr-open; user re-runs `/stark-gh:pr-merge` to resume (preflight detects existing watcher state and offers to attach) — *future work*, v1 just leaves orphaned state and prints a hint |

## Considered & Rejected (red-team v1, 2026-04-28)

Findings from `2026-04-28-stark-gh-pr-merge-design.red-team.md` reviewed and applied selectively. Applied: rt1, rt3, rt4, rt5, rt7. Deferred:

| ID | Persona | Concern (summary) | Disposition |
|----|---------|-------------------|-------------|
| **rt2** | security-trust | Make draft + CHANGES_REQUESTED gates non-bypassable; `--force` should not exist | **Deferred.** `--force` retained as audited escape hatch. GitHub branch protection remains the authoritative trust boundary; the override never bypasses it. Non-bypassability is dogmatic for a single-user dev tool |
| **rt6** | data | Fragment-based per-PR changelog files instead of direct CHANGELOG.md edits | **Deferred to v2.** Direct CHANGELOG edit was the explicit design choice for atomic squash + entry. Fragment model is a defensible v2 if parallel-merge contention becomes real |
| **rt8** | product-dx | Default flow stops after Stage 2 with preview; require `--yes` for execute | **Deferred.** Inverts the happy path. Future enhancement: opt-in `--preview` flag |
| **rt9** | product-dx | Rebase in temp worktree; only update user's branch on success | **Deferred.** Worktree-mutation risk is contained: `git rebase --abort` restores. Temp-worktree complexity not justified for v1 |
| **rt10** | cost-ops | Use `gh pr merge --auto --squash` instead of local watcher | **Rejected.** Discussed in brainstorming and explicitly rejected — auto-merge would lose CI-failure visibility and may merge stale CI under our rebase + force-push timing |
| **rt11** | cost-ops | `--draft=template\|codex` flag; template default for automation | **Rejected.** A skip-draft flag was discussed in brainstorming and explicitly dropped (single-purpose command, drafting is the value-add) |

## Out of Scope (v1)

- Local cleanup (checkout, branch delete) — future `/stark-gh:cleanup`.
- Cross-repository (fork) PRs — rejected with exit `17` (rt1); future work.
- Resuming an interrupted watcher — v1 prints orphan hint only.
- Non-squash merge strategies.
- Multi-PR batch merge.
- Auto-rebase on `mergeable: BEHIND` without `--force` (v1 always rebases; no opt-out).
- Editing CHANGELOG.md format (always Keep a Changelog `## [Unreleased]` → `### <Section>`).
