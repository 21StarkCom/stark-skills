# Execution skeleton — `continuation`, `fork`

The executor is a fresh coding session picking up a slice of work in progress.
Start from [spine.md](spine.md), then fill these sections in order.

## 1. Mission + ordering

What is to be built, and the task order **with the reason** for it — state
explicitly which items are sequential and which are parallel-safe.

## 2. Where things stand

- Worktree path, branch, PR number + draft state, ticket id.
- A **done table**: task · status · commit sha · ticket.
- The current gate numbers (test counts, pass/fail, run ids) as measured.

## 3. Per-task detail

For each remaining task:

- Spec quotes **verbatim** — paraphrase is where missions rot.
- The declared file set.
- The **done-when command**, copy-pasteable, and what its green looks like.

## 4. Load-bearing facts — "do not re-derive"

Facts that cost this session real time to establish. Mark them explicitly so
the executor spends its budget on the work, not on rediscovery.

## 5. Discipline established in prior sessions

The conventions already in force on this branch: commit message shape, one
commit per green task, evidence-log location, deviation-logging rule.

## 6. What comes after

The next slice beyond this handoff, so the executor stops at the right line
instead of drifting past it.

## 7. `fork` only — boundary + rebase rule

- **Boundary with the peer session's slice:** the exact files/dirs each side
  owns, and the shared files neither may touch unilaterally.
- **Rebase/conflict rule:** who rebases onto whom, when, and what to do on a
  conflict in a shared file (default: stop and ask, never resolve blind).
