# stark-gh:cleanup — Self-Challenge (Red-Team Pass)

Adversarial review of `2026-05-11-stark-gh-cleanup-design.md`. The author wrote both documents in one pass; this sidecar exists to surface holes before the implementation plan is drafted.

Convention: each finding has a severity (**high** / **medium** / **low**), a brief argument for why it matters, and a verdict (**fix in spec** / **defer to plan** / **accept as documented tradeoff** / **reject**). Spec edits already applied during self-review are listed in §1 for traceability — they are not findings here, they are receipts.

---

## 1. Already fixed during self-review

These were caught during the inline self-review pass and resolved before this red-team. Listed for the record:

- Dropped `--force`: it was a no-op (git refuses to `branch -D` a checked-out branch). Removed from arg table, decisions table, and protection prose.
- Added **fork detection**: PRs from contributor forks short-circuit with `skipReason: "fork"`. We never had permission to delete refs on forks.
- Added **headSha drift re-check**: preflight records each remote head SHA; execute re-fetches before deleting. Prevents deleting a branch that just received new work.
- Added **detached-HEAD** handling: `protected.currentHead` is `null` when HEAD is detached; nothing to protect.
- Added **`--audit-max-prs`** to the argument surface (was used in prose but not declared).
- Resolved the "Open Questions" section into decisions (`--branch` literal-only in v1, audit cap 500, summary row required).
- Added explicit **reserved-name rejection** (`HEAD`, `@`, `-`, names starting with `-`, names with `..`).

---

## 2. Findings (red-team pass)

### R1 — Squash-merged branches silently destroy local-only commits  
**Severity:** medium · **Verdict:** accept as documented tradeoff (with README note)

For squash-merged PRs, the local feature branch contains commits that are not on `main` (the squash merge created a single new commit instead). `git branch -D <name>` discards them silently. The spec already chose `-D` over `-d` ("user has opted into destruction by invoking the command") — fine. But operators who run `/stark-gh:cleanup --pr <merged-squash-PR>` may not realize their original commit graph is irrecoverable except via reflog.

**Action:** add a one-paragraph warning to the README cleanup section: "For squash-merged PRs, the original commit graph survives only in `git reflog` (~30 days locally) until cleanup runs. Operators who anticipate needing the original commits should capture a backup ref before cleanup." This parallels the existing pr-merge README "post-merge recovery" section.

### R2 — Stale-open mode posts public comments under the operator's identity  
**Severity:** medium · **Verdict:** fix in spec (add an explicit gate)

`--stale-days N` causes `gh pr close --comment "Closed by /stark-gh:cleanup — stale for N days …"`. If the PR was authored by someone else, the comment is public and may be surprising. Worse, large `--stale-days` runs in audit mode could mass-close cross-author PRs.

**Action:** add a `--stale-author-self-only` flag (default **on**) that filters stale-PR candidates to those authored by the current `gh` user. Opt out with `--stale-author-self-only=false` for repos where the operator manages others' stale PRs. This is conservative-by-default and matches the spirit of "stark-housekeeping aggressive mode is opt-in." Add to the decisions table and argument surface.

### R3 — Audit mode in cross-repo can't see `[gone]` branches  
**Severity:** low · **Verdict:** fix in spec (call out)

`audit-gone-branch` candidates come from `git branch -vv` on the local repo. When `--repo OWNER/NAME` is a different repo than cwd, that signal is absent. The current spec implicitly handles this (cross-repo skips local steps) but doesn't say the audit set is different.

**Action:** add a sentence to the "Audit Mode" section: "In cross-repo audit (`--repo` set to a non-cwd repo), only `audit-pr` candidates are generated — `[gone]` branches are a local concept and require cwd to match the target repo."

### R4 — TOCTOU on local branch state between preflight and execute  
**Severity:** low · **Verdict:** accept as documented tradeoff

Between preflight (snapshots local branch refs) and execute (calls `branch -D`), the user could `git checkout <branch>` in another terminal — making it the new HEAD. Result: `git branch -D` refuses (git itself protects checked-out branches in any worktree), step fails, recorded, run continues. The system fails safely; no destructive misfire. The headSha drift check covers the remote side. Local-side TOCTOU is bounded by git's own refusal.

**Action:** none. Document in the failure modes table that `git branch -D` will refuse for any worktree-attached branch; that's the safety net.

### R5 — `--pr 0`, `--pr -5`, `--pr abc` malformed inputs  
**Severity:** low · **Verdict:** fix in spec

The arg surface says "comma-separated list, no spaces" but doesn't define the integer validation rule. Negative, zero, or non-numeric PR numbers should fail at parse time with a clear message.

**Action:** add to the argument surface section: "`--pr` values must be positive integers (regex `^[1-9][0-9]*$`). Invalid values exit `2` with the offending token in stderr."

### R6 — Symlink attack on plan-file path  
**Severity:** low · **Verdict:** accept as documented tradeoff (already covered by `runtime.ts`)

The plan-file lives under `~/.claude/code-review/stark-gh/cleanup/` (mode `0700`, files `0600`). The existing `runtime.ts` helper already creates files with `O_CREAT | O_EXCL | O_NOFOLLOW`-equivalent semantics (verified against pr-open/pr-merge usage). Reusing the same helper means cleanup inherits the same protection.

**Action:** none. The "Plan-file location" decision row already names `runtime.ts`; the implementation must use it (not a hand-rolled `fs.writeFile`).

### R7 — Two concurrent `/stark-gh:cleanup` invocations  
**Severity:** low · **Verdict:** accept as documented tradeoff

Two concurrent runs against the same repo: both build similar plans; both try to delete the same remote ref. The second 404s and is treated as success. Both try `git branch -D`; git serializes ref operations, second fails with "branch not found." Recorded as step failure, exit 4. No corruption; the second run's exit code is a benign false positive.

**Action:** none. Worth a brief sentence in the README smoke runbook that the command is safe to retry but concurrent invocations may produce inflated failure counts.

### R8 — Audit mode pagination cost on huge repos  
**Severity:** medium · **Verdict:** accept; spec already caps

`gh api --paginate` over 10k closed PRs is ~30s + rate-limit risk. The spec already caps at `--audit-max-prs 500` and emits a `truncated` warning. The remaining concern is rate-limit: each `gh api` is one REST call (5k/hr authenticated). 500 PRs ≈ 5 paginated requests of 100 each. Well under the limit. Audit mode is safe.

**Action:** none. The cap is doing the work.

### R9 — Stale time computation in edge time zones  
**Severity:** low · **Verdict:** fix in test plan

`updated_at` comparisons against "now minus N days" are timezone-stable in principle (both are ISO-8601 UTC), but off-by-one bugs are common. The preflight stale test already mentions "off by ±1 second" boundary — keep that and add a TZ test fixture (fake `Date.now()` to a known UTC value).

**Action:** sharpen the test bullet to: "`preflight_stale.test.ts` — `updated_at` boundary handling: exactly N days, ±1 second; fixed-clock fixture so test is reproducible across TZs."

### R10 — Cross-repo `gh api` calls bypass cwd's gitconfig  
**Severity:** low · **Verdict:** accept as documented tradeoff

`gh` resolves auth from its own config (`~/.config/gh/`), not from the cwd's git remote. So `--repo X/Y` while sitting in repo `A/B` works as long as gh is authenticated for `X/Y`. This is the existing model for all stark-gh commands; cleanup inherits it. If gh isn't authenticated for the target, preflight's `gh repo view` fails with a clean error before any mutation.

**Action:** none.

### R11 — Race window: PR merged, branch deleted by GitHub's "delete branch on merge" setting, cleanup runs anyway  
**Severity:** low · **Verdict:** accept; idempotent

GitHub has a repo setting "Automatically delete head branches" that fires on merge. If enabled, cleanup against a recently-merged PR finds `remote.exists: false` at preflight, marks `skipReason: "not-found"` (or if PR-driven, just no remote step). Worktrees and local branches may still exist. Local cleanup proceeds. This is correct behavior.

**Action:** none.

### R12 — Branch names with slashes or unicode  
**Severity:** low · **Verdict:** fix in test plan

`feat/something-unicode-ñ` is a valid git ref. `branch.ts:validateBranchName` should already accept it (existing function), and `shell_quote.ts` should handle it on the `gh api -X DELETE /repos/.../refs/heads/<encoded>` path. Worth an explicit test.

**Action:** add `preflight_branch_unicode.test.ts` to the test plan (or a unicode case to the existing branch test).

### R13 — `cleanup.md` smoke test would itself create cruft if run repeatedly  
**Severity:** low · **Verdict:** accept

The smoke runbook creates a disposable PR, merges it (or closes it), then runs cleanup. Each run leaves a `docs/SMOKE.md` or similar commit in `main`. Not a cleanup-command bug per se, but worth noting.

**Action:** none. Inherits the pattern from pr-open / pr-merge smoke tests.

### R14 — Default branch name change race  
**Severity:** low · **Verdict:** accept

If a repo renames its default branch from `main` to `trunk` between preflight (which captures `defaultBranch: "main"` in the plan) and execute, the protected list could be stale. But the hardcoded `main`/`master`/`develop` set is also protected, so the rename target is almost certainly in that set anyway. Edge case where it's not (e.g., renamed to `production`): execute could attempt to delete a branch the repo now treats as default. Real risk window is seconds.

**Action:** none. The double-protection (hardcoded + queried default) covers the realistic cases.

### R15 — `--stale-days 0` semantics  
**Severity:** low · **Verdict:** fix in spec

`--stale-days 0` means "PRs idle for at least 0 days," which is every open PR. That would close every open PR in the repo. Almost certainly user error.

**Action:** add to argument surface: "`--stale-days` requires N ≥ 1. `--stale-days 0` is rejected at parse time."

---

## 3. Net result of red-team

Six concrete spec edits to apply (R2, R3, R5, R9, R12, R15) and one README note to add (R1). The rest are either accepted tradeoffs already covered by the design or items the test plan should cover but the design need not respell.

Applying the six spec edits in a follow-up pass on the design doc, then the spec is ready for user review.
