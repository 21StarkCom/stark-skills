---
name: stark-build
description: >-
  Stage 2 — autonomous implementation from an accepted stark-author spec: one fresh headless session per task, gated by checks the agent cannot edit (PreToolUse path-deny + Stop-hook gate), evidence per task, commit per green task, held-out e2e gate, one cross-vendor advisory review, ONE bounded fix round for medium+ findings, draft PR. No LLM review loops. Use for build, implement a spec.
argument-hint: '<spec-path> [--dry-run] [--no-advisory] [--no-fix] [--stay-draft] [--max-turns N] [--model ID]'
disable-model-invocation: true
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-build — Stage 2: fresh session per task, checks the agent cannot edit

You are the RUNNER: an interactive session that sets up the harness, then
dispatches one fresh headless `claude -p` session per spec task and verifies
each result deterministically. The implementer never grades itself.

Evidence base: [references/stage2-dossier.md](references/stage2-dossier.md)
(`[RQn]`/`[§n]` tags cite it). Consumes a `/stark-author` accepted spec.

**Non-negotiables** [§1]:
- **Completion is a runnable pass/fail check, never a model verdict.** Agents
  fake completion at scale (100% submitted / 44% resolved, measured) — a
  "done" claim is noise.
- **Checks are read-only to the writer, enforced by hooks, not prompts.**
  Anti-cheat prompting alone fails (80–95% still hacked under explicit
  instructions).
- **Abort is a first-class success.** An explicit give-up path cuts cheating
  ~5x (54%→9%). A logged deviation + stop beats a gamed green, always.
- **One task per fresh session.** Spec + PROGRESS.md + git are the only
  cross-session memory. [RQ3]
- **Sequential single writer.** No parallel writers in this skill — the
  serialized-integration exception in [§3.5] is future work. [RQ4]
- **ONE advisory review, cross-vendor, at the end — then AT MOST ONE fix
  round for medium+ findings.** The fix round is single-pass and terminal:
  its output is verified by the deterministic gates only, and the advisory
  reviewer is NEVER re-run. There is no second opinion for a ratchet to
  live in. Everything below medium, and everything still open after the one
  round, dies at the human. [RQ6][A1 — relaxed by operator decision
  2026-07-26 ahead of the A/B the dossier asked for; the dossier's §1.8
  still argues against this round. Read §6.4a before widening it.]

**Raw input:** `$ARGUMENTS`

## Phase 0 — Preflight

1. Resolve `SPEC` to an absolute path; it must contain `accepted-base: <sha>`
   in the header — refuse an ungated spec (send the operator to
   `/stark-author`). Derive `SLUG` from the spec filename
   (strip `YYYY-MM-DD-` prefix and `-spec.md` suffix).
2. Parse `## Tasks`: per task — id, title, declared file set, done-when
   command, depends-on. **Every task needs a machine-checkable done-when**;
   any task without one → stop, return the spec to the operator (that is a
   Stage-1 defect, not yours to improvise). A done-when containing `grep -q`
   in a pipeline is refused the same way — a fails-on-success gate: under
   `pipefail` it can SIGPIPE a still-writing producer, failing the gate on
   success (return to `/stark-author`). Topo-sort by declared edges;
   ties keep spec order.
3. Verify `git cat-file -e <accepted-base>` in the target repo; run
   `git status --porcelain` — a dirty tree is a hard stop.
4. `--dry-run`: print tier facts — task order, per-task done-when + file
   set, the protected-paths list, per-task dispatch command — then stop.
   Zero side effects.

## Phase 1 — Run setup (once per spec) [§3.1]

State lives OUTSIDE the repo:
`STATE=~/.claude/code-review/history/build/<slug>/<run-id>/`
(`run-id` = UTC timestamp; `mkdir -p "$STATE"/{hooks,tasks,evidence}`).

1. **Worktree at the pin:** `git worktree add <wt> <accepted-base>`, then
   branch `build/<slug>` via the create-or-adopt plumbing (never force):
   ```bash
   TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
   node --experimental-strip-types --no-warnings "$TOOLS/copilot_land.ts" \
     prepare-branch --branch "build/<slug>" --repo-dir "<wt>"
   ```
2. **Draft PR immediately** — seed with
   `git commit --allow-empty -m "build(<slug>): run start (accepted-base <sha>)"`,
   then `copilot_land.ts land --repo <owner/repo> --branch "build/<slug>"
   --title "build: <slug>" --body "<spec path + run id>" --repo-dir "<wt>"`
   (draft by default). Prevents F6-class base ambiguity.
3. **Harness files:** copy this skill's
   [references/hooks/protect-paths.sh](references/hooks/protect-paths.sh) and
   [references/hooks/stop-gate.sh](references/hooks/stop-gate.sh) into
   `$STATE/hooks/`, `chmod +x`. Write `$STATE/protected.list` — one absolute
   path per line: the spec + its `.human.md` sidecar, every EXISTING test
   file named by any done-when, `$STATE/hooks/`, `$STATE/tasks/` (check
   scripts + settings), and the repo's CI config dir. [RQ1/RQ5 — read-only
   tests, measured]
4. **Materialize `$STATE/PROGRESS.md`** (append-only: per-task status,
   evidence pointers, deviations). [RQ3]

## Phase 2 — Per-task loop (sequential) [§3.2]

For each task `<id>`, in topo order:

**Prepare** (`T=$STATE/tasks/<id>`): write `$T/check.sh` = the task's
done-when command verbatim, running in the worktree (`set -euo pipefail; cd
<wt>; <done-when>`) — a piped `grep -q` here means Phase 0 missed a
fails-on-success gate: stop, never silently rewrite; `$T/settings.json`:

```json
{"hooks": {
  "PreToolUse": [{"matcher": "Edit|Write|NotebookEdit|Bash",
    "hooks": [{"type": "command", "command": "$STATE/hooks/protect-paths.sh $STATE/protected.list"}]}],
  "Stop": [{"hooks": [{"type": "command",
    "command": "$STATE/hooks/stop-gate.sh $T/check.sh $T/blocks $STATE/PROGRESS.md <id>"}]}]
}}
```

(absolute paths, `printf '0' > $T/blocks`); and `$T/prompt.md` from this
template — fill every `<>`:

> Implement exactly ONE task of an accepted spec. Repo: `<wt>`. Spec (read
> it, treat as immutable): `<SPEC>`. Task: `<id> — <title>`. Declared files:
> `<file set>`. Done-when: `<command>`.
> 1. Orient: read the spec's task, `<$STATE>/PROGRESS.md`, and
>    `git log --oneline -15`; run `<cheapest existing check>` to catch
>    undocumented breakage before you build on it.
> 2. Check first: run the done-when; SHOW its failing output before any
>    implementation. If it cannot fail meaningfully (config/docs/wiring),
>    first write the task's verification per the spec's fallback ladder.
> 3. Implement until the done-when passes. Gated files are hook-protected —
>    add NEW tests freely, never edit existing ones.
> 4. Evidence: run checks via `... 2>&1 | tee -a <$T>/evidence.log`.
> 5. Touch only the declared files. If you must touch outside the set,
>    append `- [deviation] task=<id> class=<blocked|spec-defect> ...` to
>    PROGRESS.md; if the SCOPE BOUNDARY moves, log `class=scope-move` and
>    stop immediately.
> 6. Finish with exactly one commit: `build(<slug>): <id> <title>`.
> 7. Abort is success: if blocked, log the deviation and stop. The gate
>    accepts a logged deviation — never fake a green.

**Dispatch** (fresh session; budget per task, not per run [§3.3]):

```bash
claude -p --model "<--model | claude-opus-5>" --settings "$T/settings.json" \
  --max-turns "<--max-turns | 30>" --dangerously-skip-permissions \
  "$(cat "$T/prompt.md")" > "$T/session.log" 2>&1
```

**Verify (you, deterministically — never ask the session how it went):**
1. Gate: `bash $T/check.sh` yourself → green / red.
2. Tamper: `git -C <wt> diff --name-only <pre-sha>..HEAD` (plus dirty files)
   ∩ `protected.list` must be EMPTY — a hit aborts the whole run
   (`class=blocked`, harness-tamper note, straight to Phase 5 report).
3. Scope: same diff vs declared file set → out-of-set paths get a deviation
   line (runner-written if the session didn't).
4. Commit: green + uncommitted → commit `build(<slug>): <id> (runner-committed)`;
   red-abort or crash → commit WIP as `wip(<slug>): <id>`. Every green task
   is durable. [RQ8]
5. Append the task entry to PROGRESS.md: status (`green | deviation | crashed`),
   evidence path, blocks count.
6. Crash/timeout without green or deviation → re-dispatch the SAME task ONCE
   (it resumes from PROGRESS.md + commits — never from zero [RQ2]); still no
   exit → runner writes `class=blocked` deviation and moves on.
7. A `class=scope-move` deviation → STOP the run: push what exists, report to
   the operator (the gate owns scope, not you). [§3.8]

## Phase 3 — Closing e2e gate (held out) [§3.6]

Run the spec's `## Verification` command(s) yourself in the worktree — the
per-task loop never iterates on them. Flaky discipline: re-run the IDENTICAL
command ≤3×, log every outcome, never edit it.

- **Green** → proceed.
- **Red with all tasks green** → the divergence signal (build gamed or spec
  mis-decomposed [RQ9]): append to PROGRESS.md, continue to Phase 4, PR
  STAYS DRAFT, and say it plainly in the report. There is NO fix loop —
  the human decides.

## Phase 4 — Advisory review (one-shot; skip with `--no-advisory`) [§3.7]

Skip-rule (speculative, log when used): diff < ~50 changed lines AND only
in-set files AND e2e green.

One reviewer, different model family, fresh context, read-only — codex:

```bash
git -C <wt> diff <accepted-base>..HEAD > "$STATE/final.diff"
codex exec -s read-only "$(cat "$STATE/advisory-prompt.md")" > "$STATE/advisory.out" 2>&1
```

`advisory-prompt.md` = the spec text + the full diff + this contract
verbatim: *"Report defects and spec deviations only — bugs, contradictions
with the spec, unmet done-whens, unsafe changes. Absence of findings is a
valid, expected output for sound work. Do not propose refactors, hardening,
or scope the spec did not ask for. Open every finding with a line of exactly
`SEVERITY: critical|high|medium|low` followed by the file:line it anchors to,
a quoted span of the offending code, and the concrete failure scenario. No
other severity words — the runner filters on this token. Severity is the
consequence if left unfixed: critical = data loss / crash on the normal path
/ security hole; high = wrong output or a broken spec contract; medium = a
real defect on a reachable edge path; low = everything else."*

Post the findings as ONE PR comment authored by stark-codex
(`github_app.ts --app stark-codex pr comment ...`) — ALL of them, every
severity, before any fixing. Then re-run the pass NEVER, whatever Phase 4b
does. [RQ6][A1]

## Phase 4b — ONE fix round, medium+ only (skip with `--no-fix`) [§3.7]

Exactly one pass. Not a loop, and there is no round 2 under any outcome —
red gates after the round mean the human decides, never another dispatch.
Repeated submissions against reviewer feedback *raise* cheating (33%→38%,
ImpossibleBench) and longer search raises hack severity (SpecBench), so the
budget past the first attempt is deliberately zero. [RQ1][RQ2]

1. **Select.** Parse `SEVERITY:` tokens from `$STATE/advisory.out` into
   `$STATE/findings.json`; keep `critical|high|medium`. Drop `low` (posted,
   human's). An unparseable or severity-less block counts as `medium` —
   fail toward a look, never toward a silent skip. No medium+ → log
   `fix_round=skipped_no_findings` and go to Phase 5.
2. **Scope guard.** Discard any finding anchored OUTSIDE the run's diff or
   demanding scope the spec never asked for — those are the reviewer
   overreaching, not defects. Log each discard with its reason; if that
   empties the set, treat it as no-findings.
3. **Dispatch ONE fresh headless session** — same harness as Phase 2, so
   the spec and every gated existing test stay hook-protected and the
   Stop-gate check is the **e2e command** (fixes cross task boundaries):

   ```bash
   T=$STATE/tasks/fix; mkdir -p "$T"; printf '0' > "$T/blocks"
   # $T/check.sh = the spec's ## Verification command(s), verbatim
   # $T/settings.json = Phase 2's, with Stop -> stop-gate.sh $T/check.sh ...
   claude -p --model "<--model | claude-opus-5>" --settings "$T/settings.json" \
     --max-turns "<--max-turns | 30>" --dangerously-skip-permissions \
     "$(cat "$T/prompt.md")" > "$T/session.log" 2>&1
   ```

   `$T/prompt.md`: the spec, the selected findings verbatim, and — *"Fix
   these findings and nothing else. The spec is immutable and the gated
   tests are hook-protected. Do not refactor, do not harden, do not touch a
   file no finding names. A finding you judge WRONG is not fixed — append
   `- [finding-rejected] id=<n> <one-line reason>` to PROGRESS.md and move
   on; rejecting on evidence is a success, faking a fix is not. Finish with
   exactly one commit: `fix(<slug>): advisory round`."*
4. **Verify (you, deterministically — the reviewer is not consulted again):**
   re-run EVERY task's `check.sh` plus the e2e command yourself. Any check
   that was green before the round and is red after → `git revert` the fix
   commit, log `class=fix-regression`, PR stays draft. All green → keep it.
   Tamper + scope checks run exactly as in Phase 2 §Verify.
5. **Record.** Append to PROGRESS.md: findings selected, fixed, rejected
   (with reasons), gate outcome. Post ONE follow-up PR comment listing what
   was fixed, what was rejected and why, and what remains open — CLAUDE.md's
   nothing-lost rule: a finding is fixed, or answered on the thread. Open
   medium+ findings after the round → **PR stays draft.**

## Phase 5 — Land [§3.9]

1. Mirror every deviation line into the spec's `## Deviations` (append-only;
   you edit the spec here — task sessions never could) in the MAIN checkout
   on a spec-touching commit onto `build/<slug>` if the spec file exists in
   the worktree, else note the mirror in the PR body.
2. Push (plain, never force). Post the run summary comment on the PR:
   tasks green/deviation counts, per-task check tails, evidence dir path,
   e2e outcome, blocks histogram.
3. e2e green + CI green + advisory posted + no medium+ finding left open
   → flip ready (`gh pr ready <n>`) unless `--stay-draft`. Anything red, or
   any medium+ still open (unfixed, rejected-by-the-agent, or regressed) →
   stays draft. A rejection is the agent's claim, not a resolution — only
   you close it.
4. Clean up: `git worktree remove <wt>` only when the tree is clean and
   everything is pushed.

## Phase 6 — Report

Final message, in the operator's read order [§3.9]: PR number · spec digest
path (`.human.md`) · deviations (verbatim) · advisory findings split into
**fixed / rejected-with-reason / still-open** · evidence dir · e2e verdict ·
the diff hot spots worth a human spot-check. Every rejection prints its
reason — that is the line you audit. The human is the merge gate: never
merge, and never treat a fix round as having closed a finding.

## Measurement [RQ9]

Per run, from git/PR metadata + `$STATE` only: tasks green first dispatch ·
re-dispatch count · deviation count by class · Stop-block histogram ·
task-green/e2e-red divergence · advisory findings later confirmed by the
human · **fix-round yield** (medium+ selected vs fixed-and-still-green vs
rejected vs regressed). That last one is the kill-switch metric: a round
that mostly rejects or regresses is the loop earning its way back out.
No wall-clock, no self-report, no completion-rate dashboards.

## What this replaces

For implementation from an accepted spec, this replaces `/stark-copilot`'s
lead/wing review loop, `/stark-plan-to-tasks`, and `/stark-phase-execute`
(the latter two deleted in the 2026-07-26 demolition; copilot survives for
plan-file work with a 1-round cap and a hard test gate). The antipatterns
this skill must never grow back: [references/stage2-dossier.md](references/stage2-dossier.md) §5.
