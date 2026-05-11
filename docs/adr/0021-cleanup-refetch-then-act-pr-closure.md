# ADR 0021 — Re-Fetch-Then-Act Over Claimed Atomicity for Destructive GitHub Operations

**Status:** Accepted
**Date:** 2026-05-11
**Context:** `/stark-gh:cleanup` plan, §2 resolution 16 + plan-review H7/H13/H25/H30/M17/M26/M50.
**Related:** Phase 1 Task 7 (`lib/gh.ts:closePrWithComment`), Phase 4 Task 4 (Step 2 of the action loop).

## Decision

`closePrWithComment({repoSlug, number, comment})` is implemented as **one** `gh pr close <n> --comment "..." --repo <repo>` invocation. On non-zero exit, we **re-fetch the PR state** via `fetchCleanupPr` and branch:

- PR is now `closed` or `merged` → return `"already-closed"` (mid-network failure landed the close server-side; `gh` lost the response). Caller proceeds to remote-ref delete.
- PR is still `open` → return `{ error }`. Caller records the error and does **NOT** proceed to remote-ref delete (the open-PR-no-branch invariant).

Step 2 of the execute action loop (`task-4-4-action-loop`) also re-fetches the PR **before** closure — to check freshness (`updated_at` newer than `(now - staleDays*86400)` ⇒ skip `'freshness-changed'`), the draft + author filters, and (for the multi-PR-on-same-head-ref case) iterates `action.sources.filter(s => s.prNumber)` and applies the same re-fetch + close logic to each.

## Rationale

`gh pr close --comment` is NOT atomic. The comment and the close are separate API calls under the hood; either can succeed or fail independently. Earlier drafts claimed atomicity ("single GraphQL mutation") — that claim was **unsubstantiated** when plan-review H7/H13/H25 dug in. The actual safety mechanism is **re-fetch-then-act**:

- The PR comment is durable server-side once the API call lands. If a mid-network failure leaves a `"Closed by /stark-gh:cleanup"` comment on a still-open PR, the operator sees it on re-run (the same `closePrWithComment` retries idempotently via the re-fetch path).
- The state machine is **idempotent by construction** — re-running the cleanup on an already-cleaned PR produces no destructive side-effects (`"already-closed"` short-circuits closure; the remote-delete returns 404→success).

The same pattern applies elsewhere:
- **Remote ref delete** (`deleteRemoteHeadRef`) — HTTP 404 and HTTP 422 matching `/Reference does not exist/i` are treated as success. The ref being gone is the desired post-condition; how we got there is irrelevant.
- **Worktree removal** (`removeWorktree`) — on throw, re-check `fs.existsSync(wt.path)`. Path gone ⇒ success (plan-review M6 — never substring-match stderr to detect "already-gone").
- **Local branch delete** (`deleteLocalBranch`) — on throw, re-check `localBranchExists`. Branch gone ⇒ success.

## Consequences

**Pro:**
- Idempotent retry on transient network failures.
- Operator-friendly: a comment may appear on a still-open PR after a network glitch, but a re-run resolves it (either confirms the close or surfaces a persistent error).
- No reliance on claimed atomicity that the underlying API does not actually provide.

**Con:**
- Extra API round-trip (`fetchCleanupPr` after the close exits non-zero).
- Worst-case visible artifact: a `"Closed by /stark-gh:cleanup"` comment may appear on a PR that is still open if `gh` succeeded server-side but failed to surface the response — operator must manually delete the comment in that surprise case. Acceptable given the alternative (treating the close as failed and stranding the PR).

## Counter-pattern (rejected)

- **Trusting `gh pr close --comment` as atomic** — rejected after plan-review H7/H13/H25 demonstrated the claim was unsubstantiated. The fix is not stronger atomicity (GitHub doesn't offer it for this operation) but a re-fetch-then-act idempotency contract.
- **`If-Match` SHA on `DELETE /repos/.../git/refs/heads/<ref>`** — GitHub does not accept `If-Match` on this endpoint (plan §4 documents this residual drift→delete race). A push between Step 1's drift re-check and Step 3's delete can land. Window is small; documented in `plugins/stark-gh/README.md` so operators don't expect strict atomicity.

## Where in the code

- `plugins/stark-gh/tools/lib/gh.ts` → `closePrWithComment`, `deleteRemoteHeadRef`, `fetchCleanupPr`
- `plugins/stark-gh/tools/gh_cleanup_execute.ts` → action loop Step 2 (re-fetch-then-act for closure, plus freshness/branch-reuse re-check on closed/merged re-fetch)
- Tests: `execute_pr_close_retry.test.ts`, `execute_pr_already_closed.test.ts`, `execute_pr_close_failure.test.ts`, `execute_freshness_changed.test.ts`, `execute_multi_pr_close.test.ts`, `execute_retry_idempotent.test.ts`
