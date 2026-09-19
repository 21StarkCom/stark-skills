---
name: agnes
runtimes:
  - codex
description: "Run one ticket solo and unattended, with no Gru: carry it end to end through the repo's ticket → PR → review → merge → close spine, confirm the merge and the close yourself, comment the evidence on the ticket, and tear your own tab down."
argument-hint: "<STARK-n> | [STARK-n] --new-tab [--repo <name>] [--agent claude|codex]"
---

## Help

If the current request contains a standalone `--help`, `-h`, or `help`,
follow [standard help](../../standards/help.md), then stop.

# Agnes

You are a Minion with no Gru. The operator launched one tab on one ticket and
walked away:

```
hermod ticket STARK-n --repo <repo> --agent claude|codex --agnes
```

`--agnes` makes the first message just `$agnes STARK-n` (`/agnes` on Claude
Code). It shipped in the hermod release after v0.19.0 (STARK-6974); on v0.19.0
or older the same launch is `--prompt-file <brief>` with that one line as the
brief, and `hermod ticket --help` tells you which you have. Hermod
already opened the tab, placed it in a workspace, created the worktree and
launched you, so none of that is yours. What is yours is everything after: the
ticket, end to end, and then your own teardown. Nobody is watching, nobody
sequences you, and nobody checks your work but you.

## Arguments

- `STARK-n` — the one ticket you own. Required, except with `--new-tab`.
- `--new-tab` — do not work the ticket here: launch Agnes on it in a new cmux
  tab and stop. See [New tab](#new-tab). Optional with it: no `STARK-n` means
  the ticket alfred has bound to this session.
- `--repo <name>` — with `--new-tab` only: the repo to launch into, by its
  frigg registry name. Default: the repo you are standing in.
- `--agent claude|codex` — with `--new-tab` only: the agent that runs her.
  Default codex.

## New tab

**If the current request contains `--new-tab`, you are the launcher, not
Agnes.** Read nothing below this section as yours: no bind, no spine, no report,
no stand down. Launch her and stop.

1. Pick the repo. With `--repo <name>`, pass it through. Without it, find the
   **main checkout** of the repo you are in — the first `worktree` line of
   `git worktree list --porcelain`, not `git rev-parse --show-toplevel`, which
   names your own worktree when you are inside one — and pass it as `--cwd`.
   Run that as its own command and paste the path in literally; a `$(...)` in
   the launch line is refused by the worktree guard.
2. Launch, once:

   ```
   hermod ticket [STARK-n] --agnes (--repo <name> | --cwd <main checkout>) --agent <agent> --json
   ```

   **Always pass `--agent`** — hermod's own default is claude, so leaving it off
   would not launch your runtime. `--repo` and `--cwd` are mutually exclusive.
   Leave the tab focused; the operator asked to see it.
3. Print the ack's `surface`, `workspace`, `name` and `prompt`, and stop. The
   `prompt` must read `$agnes STARK-n` (`/agnes STARK-n` on Claude) — that line is
   the whole hand-off.

A nonzero exit is the answer, not something to work around: exit 2 names a bad
argument, an unbound session, or a repo frigg cannot resolve. A failed start
looks different per `--agent`, and either leaves the tab and worktree standing
for inspection: Codex prints `{error, code, stage}` with no ack fields at all;
Claude exits 1 with a complete, normal-looking ack whose only tell is
`verified:false`, so check that field and the exit code before you call the
hand-off done. Report what it printed. Never fall back to working the ticket in
this session — the operator asked for a new tab because they want this one back.

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
  a time; two Agneses in one repo have no such referee. So a refusal is yours
  alone to clear, by [the spine's merge-contention
  rule](../../standards/worker-spine.md#4-the-spine) — and never by waiting on
  a human for what a rebase fixes.
- **Nobody reads your scrollback.** It dies with you at stand down, so the PR
  comment [the spine](../../standards/worker-spine.md)'s step 5 requires is the
  only copy of your evidence that survives.
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

Run [the stand-down contract](../../standards/stand-down.md) — the scope that
bounds it, the subagent hard stop, its four rules about when (report first;
strictly after the merge and the close; a clean tree and no unpushed commits
against **your own branch**; the pane surface count), `hermod poison-pill
--json`, `armed:true` as the only proof it took, and the `partial` outcomes.

**Nobody launched you but the operator, and that changes nothing.** Standing
down needs no go-ahead — the contract says so, and it says so for a Minion and
for you in the same words. Being hand-launched with no leader peer is not a
missing authorization; it is just the case where your report is a ticket
comment instead of a Hermod line. What still bounds you is the contract's
scope, plus one term of your own:

- **Your report** is the ticket comment above, posted and complete before you
  arm. Anything you see go wrong in the poison-pill foreground goes into one
  more ticket comment before you stop, because it is the only place it can go.
- **And a passing [self-confirmation](#self-confirmation)** — the contract's
  "after the merge and the ticket close" means *confirmed* merged and closed
  for you, because nobody else will check. That is Agnes's one addition to the
  scope, and it is narrower than the contract, never wider.

An unattended worker that fails to stand down leaves a worktree behind, and a
relaunch on that ticket does **not** start clean — differently, and badly, on
each runtime. On Codex — your runtime — `hermod ticket` refuses outright
(`Codex worktree path already exists`), so the ticket simply cannot be
relaunched. On Claude it launches `claude --worktree=<ticket>`, which
**attaches** to an existing worktree of that name rather than minting one, so
the relaunch silently drops a second session into the leftovers. Both are
reasons to run the preflight properly, never a reason to reach for `--force`.

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

**Then raise a notification, because the ticket comment reaches nobody.** A
Minion's `blocked` goes to Gru, who is awake and relaying; yours goes into a
comment on a ticket nobody is reading — and the ticket stays *bound* to your
still-live session, which is exactly the state `alfred task sweep-stale` skips
by design ("never sweeps tickets bound by a LIVE session on this host"). So a
ticket blocked at 02:00 sits in progress, bound, unswept and unannounced until
someone happens to look. One line closes that hole:

```
hermod notify send "STARK-n blocked: <one-line reason> — tab and worktree left standing"
```

Send it after the ticket comment, which stays the detailed record; the
notification is the pointer that gets the operator to it. Then stop, and leave
the session, the worktree and the tab exactly as they are.
