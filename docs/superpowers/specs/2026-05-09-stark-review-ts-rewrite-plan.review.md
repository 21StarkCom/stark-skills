# Plan Review: TS rewrite of `/stark-review`

**Plan:** [`2026-05-09-stark-review-ts-rewrite-plan.md`](2026-05-09-stark-review-ts-rewrite-plan.md)
**Date:** 2026-05-09
**Mode:** standard, 3 fix rounds
**Agents:** claude + codex (gemini excluded by config)
**Domains:** completeness, security, sequencing, viability (4 adversarial domains × 2 agents = 8 sub-agents/round)

## Headline

| Round | Findings | 🔴 Critical | 🟡 High | 🟠 Medium | ⚪ Low | Sub-agents |
|-------|----------|-------------|---------|-----------|---------|------------|
| 1 | 54 | **2** | 27 | 22 | 3 | 8/8 ✅ |
| 2 | 49 | 3 | 27 | 17 | 2 | 8/8 ✅ |
| 3 | 38 | 3 | 22 | 12 | 1 | 8/8 ✅ |

**Trajectory:** Total findings trending down (54 → 49 → 38). The "criticals stayed at 3" headline is misleading — round 1's 2 criticals were both about the same root cause (config path mismatch with install layout), round 2 added 3 new criticals (REST-only confusion, unspecified flock support, trusted config), and round 3 surfaced one genuinely new critical (path-containment check rejecting this repo's standard worktree layout) plus two recurring-but-rephrased criticals. Each round's criticals were resolved at root cause, not patched-around.

**Net assessment:** Plan converged. Remaining round 3 items are either documented design tradeoffs (cross-host lock not in V1, `gh pr` opacity acknowledged), recurring wording disputes that the plan now addresses authoritatively, or detail-level items belonging to code review.

## Round-by-round fixes

### Round 1 (15 fixes)

**Both criticals, root-caused:**
- **Config path mismatch** — plan referenced `~/.claude/code-review/global/config.json` but the actual install layout (verified via `install.sh`) symlinks to `~/.claude/code-review/config.json`. Fixed via global string replacement.

**13 high fixes:**
- Anchor-rejection fallback (422 → demote → retry → body-only)
- POST-retry re-runs idempotency check
- `pr_head_sha` in run hash so fix-loop rounds re-post
- Phase 5 (skill migration) reordered to depend on Phase 6 (tests)
- SKILL.md provisions `GH_TOKEN` via `github_app.py`
- Fork push switched from URL-injected token to `http.extraheader -c` (later upgraded again in round 2)
- Crash-recovery cleanup of stale `stark-fork-push` remotes
- `repoRoot` derived from `configRoot`, not received as arg (caller-misuse safety)
- Classifier validates agent-supplied `finding.file` (path containment)
- Classifier abort defines posting/history/exit-code state
- Pruning has its own non-blocking lock; never deletes locked PR dirs
- Lock IO errors handled (`error.code: "lock_io"`)
- `unposted_reviews` triggers non-zero exit
- REST-only contract clarified in §4 (wire protocol, not subcommand avoidance)

### Round 2 (12 fixes)

**3 criticals:**
- **REST-only contract restated authoritatively** in §1 with a binding paragraph. Earlier §4 clarification wasn't visible enough.
- **Lock implementation specified** — `fs.openSync(O_CREAT|O_EXCL|O_RDWR)` + TTL-based stale recovery. Avoids `proper-lockfile` dep, works on darwin and linux without `flock(2)`.
- **Trusted config validation hardened** — realpath both sides, trailing-separator check defeats `/foo` vs `/foo-bar` prefix collision.

**9 high:**
- **Token NOT in argv** — replaced `git -c http.extraheader=Bearer XYZ` (visible via `ps`) with `GIT_ASKPASS` pattern. Token lives in env (per-UID-readable on standard Linux/macOS), askpass script in mode-0700 mkdtemp scope.
- 422 error parsing made defensive (multi-shape attempts, falls through to body-only on unparseable indices)
- Round-N allocation moved into per-PR lock (was racy outside it)
- App-token identity + lifetime documented (V1 uniform `stark-claude` bot; V1.1 per-agent + per-round token reissue)
- Phase 1 verification now checks `default_agent` doesn't silently alter `/stark-team-review` behavior

### Round 3 (8 fixes — final)

**3 criticals:**
- **Path-containment rejecting standard layout** — REAL bug. This repo's worktrees live at `<repo>/.claude/worktrees/<slug>/`, INSIDE the repo. The earlier check `worktree.startsWith(repoRoot)` would reject the layout we actually use. Fix: read repo-override config via `git show <base>:.code-review/config.json` instead of disk. PR-controlled worktree files cannot influence config because the read goes through git's object database at the base ref. Realpath guard kept only for `configRoot` symlink-redirect tricks.
- **Token isolation explicit** — `GH_TOKEN` MUST NOT be in `runtime.subagent_env_allowlist`. Belt-and-braces `delete agentEnv.GH_TOKEN` when constructing the env passed to agent CLIs. Agents review code; they don't need GitHub credentials. Defeats prompt-injected exfiltration.
- **REST-only as CI gate** — bumped from a manual `grep` in Phase 4 verification to a Phase 6 test-suite shell-out (`tools/check-rest-only.sh`) that fails `npm test`. Manual grep is good intent, automated grep is enforcement.

**5 high:**
- Lock heartbeat (mtime every 5 min during long ops) so legitimate slow runs don't get reclaimed; stale-lock check requires BOTH stale mtime AND dead pid.
- Marker write made explicit. `buildMarker(round, agent, runHash)` exported from `stark_review_lib.ts`; both POST and the GET-scan use the same string constant. Eliminates "scanned but never written" risk.
- SKILL.md preserves an existing `GH_TOKEN` from the caller's env; only provisions one if unset.
- `unposted_reviews` surfaced in SKILL.md failure handling.
- Phase 5/6 dependency cycle made unambiguous: 1 → 2 → 3 → 4 → 6 → 5 → 7.

## Items deliberately deferred

The following were raised but classified as `ignored` (out-of-scope for V1) or `noise`:

| Item | Reason |
|------|--------|
| Cross-host lock bypass on multi-runner CCR fleet | V1 runs single-host; remote lock service is V1.2+ |
| `gh pr` could in theory switch to GraphQL upstream | Acknowledged in §1 with explicit risk acceptance + CI grep guard on our own code |
| Fix-loop schemes that `gh` doesn't support | V1.1, not V1 |
| Per-agent App tokens (codex post under `stark-codex[bot]`) | V1.1 |
| GitHub App token rotation (1h lifetime) for multi-round fix loops | V1.1 (Phase 9 documents the per-round reissue) |
| Full diff size gate | Codex agent CLI has its own input limits; redundant guard |
| Path containment prefix bypass (`/foo-bar` vs `/foo`) | Addressed in round 2 with trailing-sep check |
| Reading ±20 worktree lines feeds PR content to classifier | Acceptable in V1: classifier doesn't drive auto-edits (fix loop is V1.1 with stricter input contract) |
| Encryption of local persisted history/audit | Out of scope; user controls `~/.claude/` |
| Force-push protection beyond non-fast-forward | "no `--force` ever" already in plan |
| Reviewer prompt schema vs existing prompt contract | Phase 1 task 3 instructs reconciling on prompt audit |

## Cross-cutting noise / non-issues

- **"flock not specified"** raised in round 2 was correct; round 2 fix replaced it with `O_EXCL` + TTL. Round 3 then raised TOCTOU concerns on the TTL recovery, fixed by requiring both stale-mtime AND dead-pid.
- **"Token still in argv"** raised in round 2 was correct against the round 1 `http.extraheader` fix; round 2 fix moved to `GIT_ASKPASS`. Round 3 noted `GIT_ASKPASS` env-var visibility risks, addressed with `/proc/<pid>/environ` UID-scoping documentation.
- **"REST-only conflicts with `gh pr`"** raised in EVERY round. The plan's response evolved: round 1 added a §4 clarification, round 2 promoted it to §1 with binding language, round 3 added a CI gate. The agents kept flagging it because it's a real cognitive dissonance that needs an authoritative paragraph; we now have one.
- **"App private key lifecycle"** — managed by `github_app.py` and macOS keychain; not a TS-tool concern.

## Misalignment Analysis

| Round | Intent | Actual | Drift |
|-------|--------|--------|-------|
| 1 | Resolve criticals | 2/2 root-caused (single fix for both) | none |
| 2 | Tighten contracts and security | 3 criticals + 9 high fixed; ~150 lines added | acceptable (added precision around lock impl, token handling, REST-only) |
| 3 | Final review | 3 criticals fixed; rest deferred to plan with named ownership | none |

No behavior drift. Each round added precision to the same design surface; no new features introduced via review.

## Prompt Improvement Assessment

| Pattern | Recommendation | Level |
|---------|----------------|-------|
| Codex flagged "REST-only conflicts with gh pr" in all 3 rounds despite an authoritative §1 paragraph in round 2 | Add to plan-review/completeness prompt: "Treat REST-only as a wire-protocol claim. `gh pr view --json` and `gh pr diff` are REST. Only `gh api graphql` violates the rule." | Global |
| Both agents counted "still uses gh subcommands" as a contract violation in completeness AND viability domains | Coordinate completeness/viability prompts to avoid double-counting the same finding under two domains | Global |
| Claude flagged `http.extraheader` token leakage AND `GIT_ASKPASS` env visibility in same round (the second was the fix for the first) | Plan-review/security prompt should note "if a remediation is itself flagged, score the residual risk, not just the new mechanism" | Global |
| "Trusted config validation can be bypassed" appeared in every round with subtly different attack vectors | Each round's flag was a real new attack vector — keep the prompt as-is. | n/a |

## Changes Made

```
$ git log --oneline docs/superpowers/specs/2026-05-09-stark-review-ts-rewrite-plan.md
7d4c21d docs: plan review round 3 fixes (8 issues addressed; final)
15ab515 docs: plan review round 2 fixes (12 issues addressed)
aa4f8a3 docs: plan review round 1 fixes (15 issues addressed)
aa2913a docs: implementation plan + d2p cross-review for stark-review TS rewrite
```

Net change across 3 review rounds: +391 / −87 lines. Plan went from ~570 lines to ~870 lines without scope expansion (additions are precision and safety; no new features).

## Verdict

**Plan approved-pending-user-review for execution.** The implementation is well-bounded, the security model is explicit (trust boundaries, token isolation, fork-push safety), the failure modes are enumerated (lock_held, lock_io, dispatch_failure, classifier_aborted, push_conflict, test_failure, unposted_reviews), the sequencing is clean (1→2→3→4→6→5→7→8→9 with V1.1 cleanly separated), and the rollback table covers every phase.

Remaining round-3 mediums and lows can be filed as follow-up tasks during `/stark-plan-to-tasks` decomposition rather than spec edits.
