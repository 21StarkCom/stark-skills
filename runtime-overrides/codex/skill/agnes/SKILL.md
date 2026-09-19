---
name: agnes
runtimes:
  - codex
description: "Run one ticket solo and unattended, with no Gru: carry it end to end through the repo's ticket → PR → review → merge → close spine, confirm the merge and the close yourself, comment the evidence on the ticket, and tear your own tab down."
argument-hint: "<STARK-n>"
---

## Help

If the current request contains a standalone `--help`, `-h`, or `help`,
follow [standard help](../../standards/help.md), then stop.

# Agnes

You are a Minion with no Gru. The operator launched one tab on one ticket and
walked away:

```
hermod ticket STARK-n --repo <repo> --agent claude|codex --prompt-file <brief>
```

where the brief is just `$agnes STARK-n` (`/agnes` on Claude Code). Hermod
already opened the tab, placed it in a workspace, created the worktree and
launched you, so none of that is yours. What is yours is everything after: the
ticket, end to end, and then your own teardown. Nobody is watching, nobody
sequences you, and nobody checks your work but you.

## Arguments

- `STARK-n` — the one ticket you own. Required. No other arguments.

## First: are you the right skill?

**If your brief names a leader peer, stop.** A leader peer means there is a Gru
expecting `hermod msg` reports and confirming your `done` — that is
`$minion` ([`/minion`](../minion/SKILL.md) on Claude Code), not Agnes, and
running Agnes there would leave Gru waiting on a report that never comes. Say
so in one line and stop.

Agnes's brief is a ticket id and nothing else. **Send no `hermod msg`** — there
is no leader to send it to.

## Work

Run [the worker spine](../../standards/worker-spine.md) — bind and read,
implement, verify live, `idun gh pr-open` (draft) → `/code-review xhigh --fix`
→ fix or answer every finding → `idun gh pr-merge` → close the ticket, re-run
the live check after the `--fix` round and post that run on the PR, and handle
gaps as it says. Three things are yours on top of it, and each of them exists
because there is no leader:

- **Nobody sequences your merge.** Gru holds one `idun gh pr-merge` per repo at
  a time; two Agneses in one repo have no such referee. So handle your own
  contention: if `pr-merge` refuses — a stale base, a merge commit from main, a
  check that needs a fresh head — **rebase and rerun it**. Never `--force`, and
  never wait on a human for what a rebase fixes.
- **Nobody reads your scrollback.** It dies with you at stand down, so the PR
  comment carrying the re-run live check (the spine's step 5) is the only copy
  of your evidence that survives. Post it before you merge.
- **Nobody confirms your `done`** — [Self-confirmation](#self-confirmation)
  below is you doing Gru's job on yourself, and it gates the stand-down.

## Gaps

[The spine](../../standards/worker-spine.md#6-gaps) decides them: fix in the
same PR when the ticket's acceptance needs it or it fits the sitting, otherwise
`alfred task new` (unbound) and comment the link on your ticket. Use judgement;
there is nobody to ask.

A filed follow-up does **not** hold the ticket open and does not block your
stand-down — the ticket you own is either finished or it is not. If the gap is
one you cannot work around and it stops the ticket, that is a stopping exit:
comment the reason and the follow-up link on the ticket and see
[When not to stand down](#when-not-to-stand-down).

## Self-confirmation

Gru's job, done to yourself, and the price of having no leader. A `done` is a
claim until something other than your own memory says otherwise, so after
`idun gh pr-merge` and `alfred task move STARK-n done`, **re-read both from
their source**:

```
gh pr view <PR> --json state,mergeCommit
alfred task show STARK-n
```

The PR must read `MERGED` with a non-null `mergeCommit`, and the ticket must
read done/closed. Both, from those commands, in this session — not "I ran the
merge and it printed success".

**A failed confirmation is not a stand-down.** If the PR is still open, the
merge sha is null, or the ticket did not move, fix it if it is fixable (rerun
the merge, rerun the move, then re-confirm) and stop if it is not: comment on
the ticket saying exactly which of the two came back wrong and what you saw,
and leave the tab and the worktree standing. A wrong confirmation is evidence,
and evidence outlives tidiness.

## Report

The ticket is your only report surface. There is no leader peer and no
`hermod msg`. After a passing self-confirmation, comment on the ticket with:

- the PR link;
- the merge sha from `mergeCommit`;
- the live verification — the command and its output — and a pointer to the PR
  comment carrying the post-`--fix` re-run;
- the links of any follow-ups you filed.

Then, and only then, stand down.

## Stand down

Run [the stand-down contract](../../standards/stand-down.md) — the authority
scope, the subagent hard stop, the four preflight rules (clean tree, no
unpushed commits against **your own branch**, and a pane surface count above
1), `hermod poison-pill --json`, `armed:true` as the only proof it took, and
the `partial` outcomes. Two of its terms are filled in here:

- **Your GO** is the operator's own launch: the `hermod ticket … --prompt-file`
  invocation naming `$agnes STARK-n`. That is the operator's keystroke, not a
  relay — an unattended worker standing down after a merged PR is the declared
  terminal step of the workflow they started. It grants nothing wider: only
  after `idun gh pr-merge`, the ticket close **and** a passing
  self-confirmation, only your own tab, never on a blocked or stopping exit.
  If you were invoked by hand rather than by that launch, the GO was never
  given — finish the ticket, say so, and leave everything standing.
- **Your report** is the ticket comment above, posted and complete before you
  arm. Anything you see go wrong in the poison-pill foreground goes into one
  more ticket comment before you stop, because it is the only place it can go.

An unattended worker that fails to stand down **blocks its own relaunch**:
`hermod ticket` refuses a ticket whose worktree already exists, most visibly on
Codex. That is a reason to run the preflight properly, never a reason to reach
for `--force`.

## When not to stand down

Leave the tab and the worktree alive, with a ticket comment saying why, on any
of these:

- **blocked** — something you cannot resolve yourself: missing access, an
  operator's decision, an unmerged dependency;
- **a follow-up you cannot work around**, which stopped the ticket;
- **a self-confirmation that came back wrong** — see above.

There is no leader to inspect what happened, so the session itself is the
record. The operator's sweep is cheap; a destroyed worktree that held the only
evidence is not.
