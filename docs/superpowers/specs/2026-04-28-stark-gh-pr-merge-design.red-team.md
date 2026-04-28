# Red-team review — 2026-04-28-stark-gh-pr-merge-design.md

- **Date:** 2026-04-28T12:16:02Z
- **Run ID:** `manual-0a0bc6be2186`
- **Model:** `gpt-5.5-pro`
- **Source spec:** (design used as its own spec)
- **Status:** **halted**
- **Findings:** 11 total — 10 blocking (≥ high), 0 human-review
- **Cost:** $1.9215 | **Duration:** 419.5s | **Tokens:** in=10646 out=16553

## Synthesis

The main tension is automation speed versus control: the design optimizes for a one-command, background, LLM-assisted merge, while security and reliability need stronger PR identity checks, non-bypassable review boundaries, final OID validation, and safer force-push semantics. A second tension is atomic CHANGELOG inclusion versus long-term operability: direct edits to one CHANGELOG.md make the squash self-contained, but data and cost/ops concerns push toward fragment-based release notes, idempotent run state, and less mandatory watcher/model work.

## Findings

| # | Severity | Persona | ID | Concern |
|---|----------|---------|----|---------|
| 1 | 🛑 critical | reliability-distsys | `rt4` | The watcher callback merges on green without rechecking the base and PR head OIDs captured by the plan. |
| 2 | 🛑 critical | reliability-distsys | `rt5` | The force-push uses an implicit lease instead of the exact remote head OID observed before the rebase. |
| 3 | 🛑 critical | security-trust | `rt1` | The design identifies the PR head only by headRefName, which is not a defensible trust boundary for fork PRs or branch-name collisions. |
| 4 | 🔴 high | cost-ops | `rt10` | The default merge path depends on a long-lived local polling watcher rather than a durable service or GitHub auto-merge. |
| 5 | 🔴 high | data | `rt6` | A single root CHANGELOG.md is a hot write target for every PR merge. |
| 6 | 🔴 high | data | `rt7` | The plan/state schema lacks durable idempotency keys for the changelog mutation and pushed commit. |
| 7 | 🔴 high | product-dx | `rt8` | The default path gives users no preview or edit point before LLM-generated prose is committed and used for the squash merge. |
| 8 | 🔴 high | product-dx | `rt9` | Preflight performs checkout and rebase in the user's current worktree before the user sees whether the merge can complete. |
| 9 | 🔴 high | security-trust | `rt2` | The --force flag bypasses human-review readiness signals instead of treating draft and requested-changes state as trust boundaries. |
| 10 | 🔴 high | security-trust | `rt3` | The watcher prints copy-paste cleanup commands containing the untrusted PR branch name. |
| 11 | 🟡 medium | cost-ops | `rt11` | Always-on Codex drafting makes model spend and latency mandatory for every merge. |

## Detail

### 1. 🛑 `rt4` — reliability-distsys (critical)

**Concern.** The watcher callback merges on green without rechecking the base and PR head OIDs captured by the plan.

**Consequence.** If base advances during the CI wait, the callback can merge a branch tested against an older base. If the PR head changes after the force-push, it can merge code not represented by the plan.

**Counter-proposal.** Store the post-changelog pushedHeadOid; in gh_pr_merge_complete.ts fetch base and PR head, require baseOid and pushedHeadOid to still match, and write terminal base_moved or head_moved state instead of merging on mismatch.

**Trade-off.** More stopped merges and reruns when base or PR head moves during CI.

### 2. 🛑 `rt5` — reliability-distsys (critical)

**Concern.** The force-push uses an implicit lease instead of the exact remote head OID observed before the rebase.

**Consequence.** Implicit --force-with-lease relies on mutable local tracking refs. An IDE auto-fetch or another git command can update the lease target after preflight, allowing the push to overwrite collaborator commits the rebase never incorporated.

**Counter-proposal.** Capture originalHeadOid from the PR branch and push with --force-with-lease=refs/heads/<headRef>:<originalHeadOid>; fail if a fresh fetch shows a different remote head.

**Trade-off.** More legitimate pushes are rejected and require a rerun.

### 3. 🛑 `rt1` — security-trust (critical)

**Concern.** The design identifies the PR head only by headRefName, which is not a defensible trust boundary for fork PRs or branch-name collisions.

**Consequence.** For cross-repository PRs, the tool can rebase and push origin/<headRef> while gh later merges a different PR head. That can land code that was not the code checked, rebased, drafted against, or force-pushed by this command.

**Counter-proposal.** Fetch and store headRepositoryOwner, headRepositoryName, headRefOid, and isCrossRepository; for v1 reject cross-repository PRs and require origin/<headRef> to resolve to headRefOid before rebase or push.

**Trade-off.** No fork-PR merge support in v1 and more GitHub API/schema plumbing.

### 4. 🔴 `rt10` — cost-ops (high)

**Concern.** The default merge path depends on a long-lived local polling watcher rather than a durable service or GitHub auto-merge.

**Consequence.** At higher usage, laptops and CI agents will accumulate orphaned watchers, GitHub API polling load, and state files no operator can inspect centrally. Failures surface as user reports rather than observable service signals.

**Counter-proposal.** Prefer gh pr merge --auto --squash after pushing the rebased branch; if custom watching remains, run a single supervised daemon with per-run leases, structured heartbeats, and status inspection.

**Trade-off.** Depends on GitHub auto-merge availability or introduces daemon infrastructure.

### 5. 🔴 `rt6` — data (high)

**Concern.** A single root CHANGELOG.md is a hot write target for every PR merge.

**Consequence.** Parallel PRs will repeatedly contend for the same section near the top of the file, causing rebase churn and conflicts. The release-note data model will be hard to evolve for per-package, per-component, or generated changelogs.

**Counter-proposal.** Write unreleased entries as per-PR fragments under .changelog/unreleased/<pr-number>.md with section metadata, then generate CHANGELOG.md during release; keep direct CHANGELOG editing as an explicit compatibility mode.

**Trade-off.** Adds release tooling and gives up the simple property that every merged PR directly edits CHANGELOG.md.

### 6. 🔴 `rt7` — data (high)

**Concern.** The plan/state schema lacks durable idempotency keys for the changelog mutation and pushed commit.

**Consequence.** After a local changelog commit, rejected push, or watcher failure, a rerun cannot distinguish command-created content from user-authored content. This will age into duplicate bullets, orphan state, and hard-to-audit branch rewrites.

**Counter-proposal.** Extend the schema with runId, originalHeadOid, changelogCommitOid, pushedHeadOid, and changelogBulletHash; make execute check these before inserting or committing and update the existing entry instead of appending on rerun.

**Trade-off.** More schema complexity and version/migration handling.

### 7. 🔴 `rt8` — product-dx (high)

**Concern.** The default path gives users no preview or edit point before LLM-generated prose is committed and used for the squash merge.

**Consequence.** Users cannot catch inaccurate release notes, awkward squash messages, or policy-inappropriate wording before the branch is force-pushed and queued for merge. One command both rewrites history and accepts public-facing generated text.

**Counter-proposal.** Make the default flow stop after Stage 2 with a preview plus --edit or --accept prompt; add --yes for trusted automation that proceeds directly to execute.

**Trade-off.** Slower happy path and less hands-off merging.

### 8. 🔴 `rt9` — product-dx (high)

**Concern.** Preflight performs checkout and rebase in the user's current worktree before the user sees whether the merge can complete.

**Consequence.** Codex failure, changelog failure, or push rejection can leave the user on a different or rebased branch with local-only mutations. This is especially surprising when --pr N targets a PR unrelated to the current branch.

**Counter-proposal.** Perform the rebase and changelog commit in a temporary worktree or throwaway branch; update the user's branch only after successful push or explicit --apply-local.

**Trade-off.** More implementation complexity, extra disk usage, and a less direct git workflow.

### 9. 🔴 `rt2` — security-trust (high)

**Concern.** The --force flag bypasses human-review readiness signals instead of treating draft and requested-changes state as trust boundaries.

**Consequence.** In repos without strict branch protection, a compromised token or mistaken invocation can land code explicitly marked not ready or rejected. The blast radius depends on per-repo GitHub settings outside this command.

**Counter-proposal.** Make draft and CHANGES_REQUESTED gates non-bypassable in v1; if emergency override is required, implement a separate --admin-override <pr> --reason <text> flow with interactive confirmation and audit output.

**Trade-off.** Removes a convenient escape hatch and slows exceptional merges.

### 10. 🔴 `rt3` — security-trust (high)

**Concern.** The watcher prints copy-paste cleanup commands containing the untrusted PR branch name.

**Consequence.** Git ref names can contain shell metacharacters, so a malicious headRef can turn the cleanup hint into command execution when pasted. This creates a local-machine attack path after an otherwise legitimate merge.

**Counter-proposal.** Do not emit raw shell commands with refs; emit /stark-gh:cleanup --pr N or render shell-quoted argv using the shared shell_quote.ts, and use the actual baseRef instead of hard-coded main.

**Trade-off.** Less visually simple cleanup output and extra cleanup-command or quoting work.

### 11. 🟡 `rt11` — cost-ops (medium)

**Concern.** Always-on Codex drafting makes model spend and latency mandatory for every merge.

**Consequence.** Automation-heavy repos will spend model budget on trivial PRs where the title, labels, or conventional commits are sufficient. Model failures also become merge-path failures because drafting is not optional.

**Counter-proposal.** Add --draft=template|codex with template as the default for automation or noninteractive runs and Codex as an opt-in or repo-configured mode.

**Trade-off.** Lower default prose quality and less personalized changelog text.
