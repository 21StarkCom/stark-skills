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

Consumes a `/stark-author` accepted spec.

**Non-negotiables:**
- **Completion is a runnable pass/fail check, never a model verdict.** A "done"
  claim is noise.
- **Checks are read-only to the writer, enforced by hooks, not prompts.**
  Anti-cheat prompting alone fails.
- **Abort is a first-class success.** A logged deviation + stop beats a gamed
  green, always.
- **One task per fresh session.** Spec + PROGRESS.md + git are the only
  cross-session memory.
- **Sequential single writer.** No parallel writers in this skill — the
  serialized-integration exception is future work.
- **ONE advisory review, cross-vendor, at the end — then AT MOST ONE fix
  round for medium+ findings.** The fix round is single-pass and terminal:
  its output is verified by the deterministic gates only, and the advisory
  reviewer is NEVER re-run. There is no second opinion for a ratchet to
  live in. Everything below medium, and everything still open after the one
  round, dies at the human.

**Harness subprocess rule — stdin closed, always.** Every dispatched
subprocess (`claude -p`, `codex exec`) must have `</dev/null` before its
output redirect. **A hung reviewer is indistinguishable from a thorough
one.** Both CLIs read stdin *in addition to* the prompt argument, so an
open pipe that never delivers EOF — which is what stdin is under a
backgrounded or orchestrated shell — blocks them. `codex exec` blocks
silently and forever (emitting only `Reading additional input from
stdin...`). `claude -p` fails fast instead,
but into the redirect file where nobody is looking (`Warning: no stdin data
received in 3s` then `Execution error`). Add `</dev/null` before `>` on
every dispatch below; any new dispatch inherits this rule.

The rule covers **every** process this skill starts, not just the LLM
dispatches:
- **the hooks** — `stop-gate.sh` runs the task's check with stdin closed,
  because a Stop hook's own stdin is the Claude Code payload pipe and a
  gate that transitively reads stdin would hang turn-end inside the gate;
- **the runner's own gate invocations** — Phase 2 §Verify 1, the Phase 3
  e2e command, and the Phase 4b sweep all run under the orchestrated
  shell's never-EOF stdin. A check that reads stdin therefore returns in
  <1s under the Stop hook and blocks *forever* under the runner: the same
  command, two verdicts. That asymmetry is the most likely explanation for
  the undiagnosed "wrapper does not return" flake below, so close stdin
  there before reaching for the fallback.

`protect-paths.sh` is the one deliberate exception — it *must* read stdin
to get the tool payload.

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

## Phase 1 — Run setup (once per spec)

State lives OUTSIDE the repo:
`STATE=~/.claude/code-review/history/build/<slug>/<run-id>/`
(`run-id` = UTC timestamp; `mkdir -p "$STATE"/{hooks,tasks,evidence}`).

1. **Worktree at the pin:** `git worktree add <wt> <accepted-base>`, then
   branch `build/<slug>` via the create-or-adopt plumbing (never force):
   ```bash
   TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
   node --no-warnings "$TOOLS/copilot_land.ts" \
     prepare-branch --branch "build/<slug>" --repo-dir "<wt>" \
     --require-base <accepted-base>
   ```
   **`--require-base` is mandatory here.** Without it, a leftover
   `origin/build/<slug>` from a prior abandoned run is adopted via
   `git checkout -B <branch> origin/<branch>`, which silently resets HEAD
   onto that older codebase — reporting `ok: true` while every subsequent
   gate measures a tree predating the pin. The flag refuses the stale
   adoption without moving the worktree.

   **Check the exit code FIRST, then assert.** A refusal is the guard
   working, and it leaves HEAD exactly where it was — so a bare
   `merge-base --is-ancestor <accepted-base> HEAD` compares the base to
   itself, exits 0, and sails past a run that never got its branch. (The
   downstream symptom is an opaque `src refspec build/<slug> does not
   match any` from Phase 1 step 2, after an empty commit lands on a
   detached HEAD.) Both checks are required — the assertion is the backstop
   for an older vendored `copilot_land.ts` that predates the flag:
   ```bash
   node ... "$TOOLS/copilot_land.ts" prepare-branch ... --require-base <accepted-base> \
     || { echo "HARD STOP: prepare-branch refused — read its message." >&2; exit 1; }
   git -C "<wt>" rev-parse --abbrev-ref HEAD | grep -qx "build/<slug>" \
     || { echo "HARD STOP: worktree is not on build/<slug> (detached or wrong branch)." >&2; exit 1; }
   git -C "<wt>" merge-base --is-ancestor <accepted-base> HEAD \
     || { echo "HARD STOP: HEAD does not contain accepted-base <sha>." >&2; exit 1; }
   ```
   **Remedy for a stale branch — do NOT reflexively delete the remote.**
   `git push origin --delete build/<slug>` **closes any open PR on that head
   ref**, taking its posted advisory findings and review threads with it —
   which the nothing-lost rule forbids. Prefer, in order: (a) re-pin the
   spec if the old run's work is superseded, (b) land this run on a
   suffixed branch (`build/<slug>-2`), (c) delete the remote branch only
   after confirming no PR on it holds findings you still need.
2. **Draft PR immediately** — seed with
   `git commit --allow-empty -m "build(<slug>): run start (accepted-base <sha>)"`,
   then `copilot_land.ts land --repo <owner/repo> --branch "build/<slug>"
   --title "build: <slug>" --body "<spec path + run id>" --repo-dir "<wt>"`
   (draft by default). Prevents base ambiguity.
3. **Harness files:** copy this skill's
   [references/hooks/protect-paths.sh](references/hooks/protect-paths.sh) and
   [references/hooks/stop-gate.sh](references/hooks/stop-gate.sh) into
   `$STATE/hooks/`, `chmod +x`. Write `$STATE/protected.list` — one absolute
   path per line, **no trailing slash on directory entries**: the spec + its
   `.human.md` sidecar, every EXISTING test file named by any done-when,
   `$STATE/hooks`, `$STATE/tasks` (check scripts + settings), and the repo's
   CI config dir.

   A trailing slash builds the glob `<dir>//*`, whose double slash matches
   **nothing** — the Edit/Write deny branch silently passes every file under
   it, and a task session can rewrite its own `check.sh` and `stop-gate.sh`
   to land a fabricated green. `protect-paths.sh` normalizes trailing
   slashes itself, so this is belt-and-braces; write them without anyway.
4. **Materialize `$STATE/PROGRESS.md`** (append-only: per-task status,
   evidence pointers, deviations).

## Phase 2 — Per-task loop (sequential)

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
> 4. Evidence: run checks via `... 2>&1 | tee -a <$STATE>/evidence/<id>.log`.
>    (`$STATE/tasks/` is write-protected; write evidence to `$STATE/evidence/` instead.)
> 5. Touch only the declared files. If you must touch outside the set,
>    append `- [deviation] task=<id> class=<blocked|spec-defect> ...` to
>    PROGRESS.md; if the SCOPE BOUNDARY moves, log `class=scope-move` and
>    stop immediately.
> 6. Finish with exactly one commit: `build(<slug>): <id> <title>`.
> 7. Abort is success: if blocked, log the deviation and stop. The gate
>    accepts a logged deviation — never fake a green.

**Dispatch** (fresh session; budget per task, not per run):

```bash
claude -p --model "<--model | claude-opus-5>" --settings "$T/settings.json" \
  --max-turns "<--max-turns | 30>" --dangerously-skip-permissions \
  "$(cat "$T/prompt.md")" </dev/null > "$T/session.log" 2>&1
```

**Verify (you, deterministically — never ask the session how it went):**
1. Gate: run `bash "$T/check.sh" </dev/null` yourself → green / red.
   Keep the `bash` prefix — `check.sh` is written without a shebang and is
   never `chmod +x` (only `$STATE/hooks/` is), so executing it directly
   returns `permission denied` (126) on **every** task: a false red
   indistinguishable from a real one. `</dev/null` for the same reason the
   dispatches carry it — the runner's own stdin is the orchestrated shell's
   never-EOF pipe, so a gate that transitively reads stdin blocks forever
   here even though it returns in <1s under the Stop hook.
   **Background it — foreground timeouts leak children.** When the
   orchestrating shell hits a wall-clock limit it stops waiting but does
   NOT kill the child process tree. Every retry then competes with all
   prior `go test` (or equivalent) processes for build caches, producing a
   self-inflicted escalating slowdown that looks like external contention
   and causes real misdiagnosis. Run long gates as background tasks and
   terminate them via the harness's own task-stop, never via a foreground
   timeout.
   **macOS has no `timeout(1)`** (and `gtimeout` is not installed by
   default either; it needs `brew install coreutils`).
   A gate sweep written with `timeout 120 bash check.sh` reports every gate
   as red in 0s, because `timeout: command not found` exits 127 — a **false
   red that is indistinguishable from a correct one**. Never bare
   `timeout`. Prefer the runner's own language-level bound (`go test
   -timeout`), which kills the work it started and orphans nothing.
   **Any wrapper that signals only the direct child leaks the tree** — that
   includes `gtimeout` without `--kill-after`/process-group handling and
   the `perl -e 'alarm N; exec @ARGV'` trick: `alarm` delivers SIGALRM to
   the exec'd shell only, so `go test`'s compile/run children survive and
   reproduce the exact contention above. If you need a hard bound outside
   the language, run the gate in its own process group and kill the
   **group** (`set -m`, then `kill -- -"$PGID"`), and verify nothing
   survived before retrying.
   **Broad kill patterns kill YOUR OWN gate first.** `pkill -f "go test"`
   matches on command-line text, not on process ownership — it can kill the
   runner's own in-flight verification (producing a misread `rc=143`) or a
   *different* concurrent `stark-build` run whose prompt text contains the
   string `go test`. Any cleanup pattern must be scoped to
   this run's unique `$STATE` path and dry-run listed **with the command
   text visible** — `pgrep -lf "$STATE"` or `ps -eo pid,command | grep -F
   "$STATE"`. **Not `pgrep -af`**: on macOS `-a` means "include process
   ancestors in the match list", not "show the full command line", so it
   prints bare PIDs (nothing to inspect) *and* widens the set to each
   match's ancestors — which includes the orchestrating session, so
   feeding that list to a kill terminates the run itself.
   **Wrapper flake fallback.** If `bash "$T/check.sh"` does not return, the
   runner may run the check's **own content verbatim** — meaning the whole
   file including its `set -euo pipefail; cd <wt>` envelope, not just the
   done-when line lifted out of the spec. Dropping the envelope is a
   silent correctness change: without `cd <wt>` the command runs against
   the **main checkout** and greens a task whose worktree implementation is
   absent or broken; without `pipefail` a piped done-when exits with the
   last stage's status and greens a failing suite. Both are the vacuous
   green this skill exists to prevent. Re-run to confirm (Phase 3's ≤3×
   flaky discipline applies), and record in PROGRESS.md that the wrapper
   did not return, that direct invocation was used, and both outcomes.
   Never paraphrase or adapt the command. The root cause here is
   **undiagnosed** — do not invent one. The non-negotiable "completion is a
   runnable check, never a model verdict" holds precisely because the
   command and its envelope are identical and the runner still runs it.
2. Tamper: `git -C <wt> diff --name-only <pre-sha>..HEAD` (plus dirty files)
   ∩ `protected.list` must be EMPTY — a hit aborts the whole run
   (`class=blocked`, harness-tamper note, straight to Phase 5 report).
3. Scope: same diff vs declared file set → out-of-set paths get a deviation
   line (runner-written if the session didn't).
4. Commit: green + uncommitted → commit `build(<slug>): <id> (runner-committed)`;
   red-abort or crash → commit WIP as `wip(<slug>): <id>`. Every green task
   is durable.
5. Append the task entry to PROGRESS.md: status (`green | deviation | crashed`),
   evidence path, blocks count.
6. Crash/timeout without green or deviation → re-dispatch the SAME task ONCE
   (it resumes from PROGRESS.md + commits — never from zero); still no
   exit → runner writes `class=blocked` deviation and moves on.
7. A `class=scope-move` deviation → STOP the run: push what exists, report to
   the operator (the gate owns scope, not you).

## Phase 3 — Closing e2e gate (held out)

Run the spec's `## Verification` command(s) yourself in the worktree — the
per-task loop never iterates on them. Flaky discipline: re-run the IDENTICAL
command ≤3×, log every outcome, never edit it.

The e2e command is typically the longest-running gate in the run, so
**Phase 2 §Verify 1's execution rules apply here in full**: run it with
stdin closed (`</dev/null`), background it and stop it via the harness's
own task-stop (a foreground timeout leaks the child process tree, and each
leaked child then competes with the next attempt), never bare `timeout`,
never a wrapper that signals only the direct child, and never a broad kill
pattern.

- **Green** → proceed.
- **Red with all tasks green** → the divergence signal (build gamed or spec
  mis-decomposed): append to PROGRESS.md, continue to Phase 4, PR
  STAYS DRAFT, and say it plainly in the report. There is NO fix loop —
  the human decides.

## Phase 4 — Advisory review (one-shot; skip with `--no-advisory`)

Skip-rule (speculative, log when used): diff < ~50 changed lines AND only
in-set files AND e2e green.

One reviewer, different model family, fresh context, read-only — codex:

```bash
git -C <wt> diff <accepted-base>..HEAD > "$STATE/final.diff"
codex exec -s read-only "$(cat "$STATE/advisory-prompt.md")" </dev/null > "$STATE/advisory.out" 2>&1
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
does.

## Phase 4b — ONE fix round, medium+ only (skip with `--no-fix`)

Exactly one pass. Not a loop, and there is no round 2 under any outcome —
red gates after the round mean the human decides, never another dispatch.

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
     "$(cat "$T/prompt.md")" </dev/null > "$T/session.log" 2>&1
   ```

   `$T/prompt.md`: the spec, the selected findings verbatim, and — *"Fix
   these findings and nothing else. The spec is immutable and the gated
   tests are hook-protected. Do not refactor, do not harden, do not touch a
   file no finding names. A finding you judge WRONG is not fixed — append
   `- [finding-rejected] id=<n> <one-line reason>` to PROGRESS.md and move
   on; rejecting on evidence is a success, faking a fix is not. Finish with
   exactly one commit: `fix(<slug>): advisory round`."*
4. **Verify (you, deterministically — the reviewer is not consulted again):**
   re-run EVERY task's `check.sh` plus the e2e command yourself. This is the
   heaviest gate sweep in the run, so **Phase 2 §Verify 1's execution rules
   apply to every check in it**: invoke each as `bash "$T/check.sh"
   </dev/null` (no shebang, never chmod +x, and the runner's stdin never
   EOFs), background each one and use task-stop, never a foreground timeout
   (leaks children that then slow every later check), never bare `timeout`
   (absent on macOS — reports the whole sweep as a false red in 0s), never a
   broad kill pattern (it kills your own in-flight gate and other runs'
   tasks). Any check that was green before the round and is
   red after → `git revert` the fix commit, log `class=fix-regression`, PR
   stays draft. All green → keep it. Tamper + scope checks run exactly as in
   Phase 2 §Verify.
5. **Record.** Append to PROGRESS.md: findings selected, fixed, rejected
   (with reasons), gate outcome. Post ONE follow-up PR comment listing what
   was fixed, what was rejected and why, and what remains open — CLAUDE.md's
   nothing-lost rule: a finding is fixed, or answered on the thread. Open
   medium+ findings after the round → **PR stays draft.**

## Phase 5 — Land

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

Final message, in the operator's read order: PR number · spec digest
path (`.human.md`) · deviations (verbatim) · advisory findings split into
**fixed / rejected-with-reason / still-open** · evidence dir · e2e verdict ·
the diff hot spots worth a human spot-check. Every rejection prints its
reason — that is the line you audit. The human is the merge gate: never
merge, and never treat a fix round as having closed a finding.

## Measurement

Per run, from git/PR metadata + `$STATE` only: tasks green first dispatch ·
re-dispatch count · deviation count by class · Stop-block histogram ·
task-green/e2e-red divergence · advisory findings later confirmed by the
human · **fix-round yield** (medium+ selected vs fixed-and-still-green vs
rejected vs regressed). That last one is the kill-switch metric: a round
that mostly rejects or regresses is the loop earning its way back out.
No wall-clock, no self-report, no completion-rate dashboards.
