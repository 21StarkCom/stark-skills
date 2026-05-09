# ADR 0019: REST-Only `/stark-review` with Trusted Config Reads and GIT_ASKPASS Pushes

**Status:** Accepted (decomposed → issues #438–#489)
**Date:** 2026-05-09
**Plan:** [`docs/superpowers/specs/2026-05-09-stark-review-ts-rewrite-plan.md`](../superpowers/specs/2026-05-09-stark-review-ts-rewrite-plan.md)

## Context

The Python-based `/stark-review` orchestrator carries three architectural risks worth removing on the rewrite:

1. **GraphQL coupling.** Dispatcher code reaches for `gh api graphql` in places where REST is sufficient; a single GraphQL hit makes the entire path harder to audit and rate-limit-budget against.
2. **Worktree-trust ambiguity.** Repo-override config (`.code-review/config.json`) and per-repo prompt overrides have been read from the on-disk worktree. A PR that touches those files can influence its own review.
3. **Token leakage on fork-PR pushes.** URL-embedded tokens persist in `.git/config` and `git remote -v`; `git -c http.extraheader=...` exposes the token in `ps auxe`.

The TypeScript rewrite (V1 + V1.1) addresses all three.

## Decision

### 1. REST-only wire protocol

"REST-only" means the wire protocol is REST. **Allowed:** any `gh api <REST_PATH>`, `gh pr view --json ...`, `gh pr diff`. **Forbidden:** `gh api graphql`, any `/graphql` URL, any GraphQL query string from `tools/stark_review*.ts` and `tools/agent_*.ts`.

Enforcement: `tools/check-rest-only.sh` greps the file set for `gh api graphql|/graphql` and exits non-zero on any hit; the script is wired into `npm test` so a violation breaks the test suite. The Phase 4 verification grep is developer-time; the test gate is the real enforcement.

`gh pr view`/`gh pr diff` are permitted because their underlying transport is REST today. If `gh` upstream ever flips them to GraphQL, our wire-protocol claim becomes inaccurate but our code still doesn't *write* GraphQL — the grep guard catches our own code regardless.

### 2. Trusted config reads via base-branch git objects

Repo-override config is read from the **base branch's git object database**, never from the worktree filesystem:

```ts
const repoOverrideConfig = await git([
  "-C", repoRoot,
  "show", `${baseRef}:.code-review/config.json`
]).catch(() => null);
```

The same pattern applies to repo-level prompt overrides. The base-branch read mechanism makes worktree placement irrelevant — the worktree may live anywhere, even inside the repo it reviews (which is this repo's standard layout under `.claude/worktrees/`).

A realpath guard remains for the configRoot itself: `realpathSync(configRoot)` must NOT equal or start with `realpathSync(worktree) + path.sep`. This catches the symlink-redirect edge case where an attacker plants a symlink in configRoot before the skill runs.

The configRoot is **captured before worktree setup** in the SKILL.md wrapper, so the trusted CWD never aliases into PR-controlled worktree content.

### 3. Fork-PR pushes via GIT_ASKPASS

For fork PRs with `maintainer_can_modify=true`, the push token is delivered via a one-line `GIT_ASKPASS` script that reads `STARK_PUSH_TOKEN` from env and prints it:

```sh
#!/bin/sh
printf "%s" "$STARK_PUSH_TOKEN"
```

The askpass file lives in a per-invocation `mkdtemp` with mode `0700`; the parent dir is removed in a `finally` block alongside `git remote remove stark-fork-push`. The token never appears in argv, in `.git/config`, or in any audit log.

Crash-recovery cleanup: on tool startup after acquiring the per-PR review lock, the worktree is scanned for a stale `stark-fork-push` remote and the remote is removed before any other operation.

## Consequences

**Positive:**
- Auditable wire protocol (one grep guards the contract).
- Worktree placement is no longer a security boundary; CI runners and developers using `.claude/worktrees/<slug>/` get the same trust guarantees.
- Token-leak surface for fork pushes is reduced to env-var visibility (UID-isolated on Linux/macOS).

**Negative:**
- `gh pr view`/`gh pr diff` opacity: a future `gh` release could switch them to GraphQL internally. Acknowledged in the plan; the CI guard catches our own code regardless.
- Cross-host serialization is explicitly out of scope. The per-PR flock is host-local; two CI runners on different hosts would both bypass the local lock and rely only on the remote-marker check. CCR triggers run on a single host, so this window is acceptable for now.
- Multi-user shared-UID systems are not in scope for the GIT_ASKPASS env-var threat model.

## Tracking

- Phase 1–4: `tools/stark_review.ts`, `tools/stark_review_lib.ts`, `tools/agent_*.ts` (issues #438–#441 + tasks)
- Phase 6: REST-only CI guard (`tools/check-rest-only.sh`, issue #472)
- Phase 9: V1.1 fix-loop with GIT_ASKPASS (issue #446 + tasks #480–#485)

## References

- Plan §1 Overview, §3 Phase 4 task 9, §3 Phase 9 task 5, §4 Integration Points
- ADR 0010 (GraphQL for Projects V2) — establishes the precedent that GraphQL is allowed only where REST is materially insufficient. `/stark-review` does not meet that bar.
