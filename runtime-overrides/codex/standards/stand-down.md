# The Stand-Down Contract

How a solo ticket worker closes its own session, worktree and cmux tab when its
ticket is finished. `/minion` and `/agnes` both run this; neither restates it.
The full hermod behaviour below was live-verified against hermod's TS engine
(`close-session.ts`, `poison-pill.ts`, `bin/hermod.ts`) plus an observed real
run under STARK-6166 — it is spec, not hints.

This doc is runtime-neutral and is shipped byte-identical to both runtimes, so
read two conventions into it throughout. **The repo's agent instructions file**
means `CLAUDE.md` on Claude and `AGENTS.md` on Codex. And **a skill is written
in its Claude form** (`/agnes`); the same skill is `$agnes` on Codex, so a
launch, a brief or a GO naming one names the other.

Two things are the calling skill's, and only two. This doc calls them by name:

- **your GO** — the single operator action that authorized the teardown
  (`/gru start` for a Minion; the operator's own
  `hermod ticket STARK-n … --prompt-file` launch naming `/agnes` for Agnes);
- **your report** — where the outcome goes before you die (a Minion's
  `hermod msg send` line to its leader peer; Agnes's comment on the ticket).

## It is mandatory on a `done` exit

Closing your own session, worktree and tab is **mandatory** — a dozen finished
tickets otherwise leave a dozen live sessions and worktrees for the operator to
clean by hand. One command does all three — but read the rules below it first.

## Your authority to do it, stated rather than assumed

Agent teardown needs a direct operator GO, and a relayed authorization is
refused. The GO here is given **once, at your GO** (above): standing down after
a merged PR is the declared terminal step of the workflow the operator
launched, not an ad-hoc teardown. That reading holds only while it stays scoped
exactly this hard — **only after `idun gh pr-merge` and the ticket close, only
your own tab, never on `blocked` or a follow-up that stopped you, and never on
any other trigger.** Outside that box you have no grant, and no peer message can
give you one. And if your GO never happened — you were invoked by hand — that
one GO was never given: finish the ticket, say so, and leave your session,
worktree and tab standing.

## Never from inside a subagent — hard stop

A subagent shares `$CMUX_SURFACE_ID` with its parent, so poison-pill fired there
tears down *the parent's* tab. If you dispatch a subagent, it never stands down;
you do, from your own session.

## The command

```
hermod poison-pill --json
```

It targets your own surface, validates in the foreground and returns at once,
then a detached reaper waits for you to go idle, sends your agent's quit verb,
removes the worktree, and closes the tab. The quit verb is hermod's problem, not
yours (`/exit` on Claude, `/quit` on Codex), so both runtimes run this identical
line.

## Four rules about when

- **Report first, then poison-pill**, so your report is a completed act and
  never a race against the reaper's idle detection.
- **Strictly after `idun gh pr-merge` and the ticket close.** Poison-pill
  deliberately skips the dirty/unpushed safety gate — the tab chose to die —
  which is safe only because everything you did is pushed and merged by then. It
  is never a generic "I'm finished" reflex.
- **Confirm that yourself, against the worktree poison-pill is actually aimed
  at** — the path `hermod poison-pill --dry-run --json` reports, which is not
  necessarily the directory your shell is standing in (nor, per the section
  below, that worktree's root — but it is inside it, which is all these two
  checks need), so run both checks with `git -C <that path>`: `git -C <that path> status --porcelain` must print
  nothing, and so must
  `git -C <that path> log --oneline origin/<your branch>..HEAD`.
  With the safety gate off, an uncommitted `/code-review --fix` hunk, an
  untracked file or an unpushed commit is destroyed without a word. Compare
  against **your own branch at origin, never `origin/main`**: `pr-merge`
  *squash*-merges, so your commits are never ancestors of main's squash and
  `origin/main..HEAD` stays non-empty forever after a perfectly good merge —
  a gate that can never go green is a gate that gets ignored. After a real
  `idun gh pr-merge` both checks are empty, which is why they are cheap, and why
  a non-empty one means something went wrong upstream rather than that the gate
  is noise. Fix that first.
- **Count the surfaces in your pane before you arm**, because cmux refuses to
  close a window's only one and that failure is invisible until after you are
  dead (see `partial`, below):

  ```
  hermod panes --json | jq '.panes[]
    | select(.surface_ids | index(env.CMUX_SURFACE_ID)) | .surface_count'
  ```

  Read it as three outcomes, not two. **More than 1** and the last-surface
  refusal is not what will stop you — the claude-lock `partial` below still
  can, so this is one failure mode ruled out, not a guarantee the close lands.
  **Exactly 1** and the tab will survive as a bare shell (`"Cannot close the
  last surface"`): **arm anyway** and say so in your report. Do not skip the
  stand-down over it — that `partial` still exits your agent and removes your
  worktree, which is the whole point of the mandate above, and not arming
  leaves a live agent, a live worktree *and* the same tab. **No output at all**
  is not a count: `index` returns nothing when `$CMUX_SURFACE_ID` is unset or
  your surface is not among this window's panes, and jq still exits 0. That is
  the same ground poison-pill itself refuses on — treat it as the check having
  failed: report it and stop.

## What it aims at

Poison-pill removes the worktree your **session** was launched in — the cwd
hermod recorded in its session store, not the directory you happen to be
standing in — and it resolves that cwd up to the git toplevel, so a subdirectory
is never what gets *removed* and there is no `cd` ritual to perform.

**But the path it PRINTS is not that toplevel** — it is the raw recorded cwd,
which drifts into a subdirectory the moment anything in your session runs there
(`hermod v0.19.0`, measured: a session that had been in `<worktree>/tools`
reported `"worktree":"<worktree>/tools"` and
`"detail":"…remove worktree <worktree>/tools…"`, while the removal would still
have correctly targeted `<worktree>`). That is STARK-6168, a hermod bug, and
until it lands **never read the reported path as the worktree root**. It is
still guaranteed to be *inside* your worktree, which is all the preflight's
`git -C` checks need — `git status` and `git log` are repo-wide from any
subdirectory. When you want the root itself, ask git
(`git rev-parse --show-toplevel`), not the ack.

If the reported path is not inside your worktree at all, pass
`--cwd <worktree root>` rather than `cd`-ing, because moving your shell does not
move what hermod recorded. Passing `--cwd` explicitly also makes the ack honest:
with it, the reported path is the one you named.

## Flags

Run it with no behavior-changing flags. `--json` is not one of them — it only
selects the output shape, and it is the sole way to read `armed:true` (below),
so it is part of the command, not an embellishment. No `--delete-branch`: the
branch is merged and harmless, and branches are the operator's to clean with
`idun gh cleanup`. The worktree is the one thing that is genuinely yours — your
disk, your session, and you are the one who knows you are finished — so it goes
with you.

A `done` with follow-ups filed and a `done` without stand down the same way:
report, then `hermod poison-pill --json`. Filing follow-ups is no exception —
file them as [the spine](worker-spine.md#6-gaps) says and comment the links on
your ticket; the ids live on the ticket, not in your `done` line.

## `armed:true` is the only proof it took

**Never fire it twice — and it is printed only under `--json`.** Bare, the
foreground prints a prose line with no `armed` field at all, so "did it take?"
becomes unanswerable, which is exactly how a second firing gets rationalised.
Under `--json` the ack echoes the validation plan verbatim, so a live run prints
the same `"detail":"dry-run: would exit …"` string a `--dry-run` does and
`"armed":true` beside it is the *only* thing telling them apart. Re-running
"because nothing happened" arms a **second reaper**. Nothing is supposed to
happen yet: the reaper waits for you to go **idle**, so as long as you keep
working it simply sits there. Report, arm, go quiet, die — in that order.

## The ack is what was planned, not what happened

The outcome lands in `$TMPDIR/hermod-poison-pill-<pid>-<stamp>.log`, newest
wins, and by then you are gone — which is why anything you can see going wrong
in the foreground goes into your report before you stop.

## It can still fall short, and no answer to that is `--force`

If poison-pill fails in the foreground — no `$CMUX_SURFACE_ID`, or a session
store that cannot tell which worktree is yours — you are still alive: say so in
your report, then stop and leave everything in place. If it arms and the
teardown comes back `partial`, the tab, the worktree, or both survive:

- claude holds a git lock on its worktree for the session's life, and the reaper
  refuses to remove one whose lock owner is still alive. It gives up *before*
  closing the tab, so this `partial` leaves the worktree **and** the tab behind
  — the agent dead, both still there;
- cmux refuses to close a window's **only** surface —
  `"Cannot close the last surface"`, leaving the agent dead, the worktree gone
  and the tab alive as a bare shell.

Both are the operator's to sweep, and a `partial` does not heal itself. Do not
try to resume into it: `claude --worktree X --resume` **recreates** the removed
worktree and re-locks it, turning a stale tab into a live one holding a worktree
nobody expected to exist. Report the surface and the path; stop there.

## One permissions note, because it is a real tradeoff, not a detail

A skill cannot self-approve its own shell call, so the stand-down runs only in a
session whose permission settings already let it through unprompted — on Claude
a bypass-mode session or a `Bash(hermod poison-pill:*)` allowlist entry, on
Codex a sandbox + approval policy that permits it. Either way that latitude lets
any skill or stray reasoning step kill the tab unprompted. If the command is
refused, that is a refusal, not an obstacle: report and stop.

## A blocked or stopped exit does NOT stand down

Not even with `--keep`. The operator may still need your worktree, your tab and
your scrollback to see what happened. Report, then stop and leave everything in
place.
