# ADR 0020 — Defense-in-Depth Re-Validation Between Preflight and Execute

**Status:** Accepted
**Date:** 2026-05-11
**Context:** `/stark-gh:cleanup` plan (`docs/superpowers/specs/2026-05-11-stark-gh-cleanup-plan.md`), §2 resolution 17 + plan-review H0/H1/H23/H30.
**Related:** Phase 4 Task 2 (`task-4-2-revalidate-context`), Task 4-3 (`task-4-3-live-local-recheck`).

## Decision

`/stark-gh:cleanup` splits operation into two processes: **preflight** (read-only, writes a typed plan-file at mode `0600`) and **execute** (consumes the plan-file, runs destructive operations). Execute does **not** trust the plan-file as the sole authorisation source. Before any mutation it re-derives — independently and in this order — every safety-critical invariant the plan-file claims:

1. **Auth identity** — `gh.ts:ghCurrentUser()` must equal `plan.authUser`.
2. **Repository identity** — re-fetch `repoView({repoSlug: plan.repo.nameWithOwner})`; returned `nodeId` must equal `plan.repo.nodeId`.
3. **Cwd anchor + origin URL** (same-repo only) — `fs.realpathSync(plan.cwdToplevel)` must be a git toplevel; `canonicaliseOrigin(live origin) === plan.originUrl` (credential-free canonical form on both sides).
4. **Protected list** — re-derive `[main, master, develop]` (lowercase) ∪ `repoView().defaultBranch` ∪ `plan.protected.currentHead` (snapshotted, not live-read). Any in-memory action whose branch matches is forced to `skip:true, skipReason:'protected'`.
5. **Self-worktree gate** (runs *after* protected re-derivation) — `fs.realpathSync(wt.path) === fs.realpathSync(plan.cwdToplevel)` ⇒ skip `'current-worktree'`.

Additionally, **live-local re-check** (Task 4-3) re-enumerates worktrees and recomputes `aheadBehind` for non-explicit actions and forces `live-dirty` / `live-ahead` skips when the local state changed between preflight and execute.

## Rationale

A plan-file at mode `0600` only protects against **other OS users on the same machine**. It does **not** protect against:

- **Stale retained plans** — an old plan-file on disk after a previous failed run.
- **Identity swaps** — operator runs `/stark-gh-user secondary` between preflight and execute, flipping the active `gh` token under the same process tree.
- **Hand-crafted plans** — an attacker (or a confused operator) with shell access on the same UID can edit the plan-file directly to bypass the protected-branch gate or the staleness filter.
- **Repo identity changes** — a repo renamed/recreated under the same `owner/name` slug between preflight and execute resolves to a different GitHub `node_id`; without the re-check, destructive ops would run on the wrong repo.
- **Cwd / origin drift** — operator `cd`s elsewhere, swaps the clone, or rotates credentials between preflight and execute.

The plan-file is the **data carrier**, not the authority. Execute treats it as untrusted input and re-validates every invariant it depends on.

## Consequences

**Pro:**
- A hand-edited plan-file (e.g. flipping `flags.staleAuthorSelfOnly` to `false`) cannot bypass the safety filter — execute also verifies `plan.flags.staleAuthorSelfOnly || plan.flags.allowForeignAuthors` at startup (task-4-1).
- Cwd-anchor + origin canonicalisation catches credential-swapped clones (`https://user:token@github.com/...` vs `git@github.com:...`) and SSH `Host` aliases (`git@my-github:o/r` resolving to the same canonical form as `git@github.com:o/r`).
- Repo `nodeId` survives renames and slug-recreate attacks that text-comparison on `owner/name` would miss.
- Snapshotted `protected.currentHead` (NOT live-read at execute) handles the legitimate case where the operator moves HEAD between preflight and execute — the protected set stays anchored to preflight intent.

**Con:**
- Three extra GitHub API calls at execute startup (`repoView`, `ghCurrentUser`, plus internal helpers). Acceptable; cleanup is interactive and runs O(seconds), not O(milliseconds).
- Order of checks matters — protected re-derivation **before** self-worktree gate (plan-review L1): a protected branch is flagged `'protected'` (the more critical safety property) rather than `'current-worktree'`.
- `process.chdir` is forbidden — every `git.ts` helper accepts an injectable `cwd` argument (plan-review H6). Process-global state is unsafe in shared event loops.

## Counter-pattern (rejected)

Earlier draft proposed trusting the plan-file directly because it lives at mode `0600`. Plan-review rounds 4-6 (H0/H1/H23/H30) accumulated counter-examples showing the threat model — same-UID hand-edits, identity swaps, repo renames — that the mode-0600 protection cannot address. The mode-0600 protection remains valuable against **other-UID** attackers; it is not sufficient on its own.

## Where in the code

- `plugins/stark-gh/tools/gh_cleanup_execute.ts` → `validateExecutionContext(plan, {exec})` (scaffolded in Phase 1 Task 8, body filled in Phase 4 Task 2)
- `plugins/stark-gh/tools/lib/gh.ts` → `ghCurrentUser`, `repoView` (returns `nodeId`), `canonicaliseOrigin`
- `plugins/stark-gh/tools/lib/git.ts` → every helper accepts an injectable `cwd` (no `process.chdir`)
- Tests: `execute_revalidate.test.ts`, `execute_self_worktree.test.ts`, `execute_live_local_recheck.test.ts`, `gh_canonicalise_origin.test.ts`
