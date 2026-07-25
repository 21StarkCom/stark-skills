---
name: stark-build
description: >-
  Stage 2 — autonomous implementation from an accepted stark-author spec: one fresh headless session per task, gated by checks the agent cannot edit (PreToolUse path-deny + Stop-hook gate), evidence per task, commit per green task, held-out e2e gate, one cross-vendor advisory review, draft PR. No LLM review loops. Use for build, implement a spec.
argument-hint: '<spec-path> [--dry-run] [--no-advisory] [--stay-draft] [--max-turns N] [--model ID]'
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
- **ONE advisory review, cross-vendor, at the end. Findings die at the
  human.** No fix loop exists for a ratchet to live in. [RQ6]

**Raw input:** `$ARGUMENTS`

## Phase 0 — Preflight

1. Resolve `SPEC` to an absolute path; it must contain `accepted-base: <sha>`
   in the header — refuse an ungated spec (send the operator to
   `/stark-author`). Derive `SLUG` from the spec filename
   (strip `YYYY-MM-DD-` prefix and `-spec.md` suffix).
2. Parse `## Tasks`: per task — id, title, declared file set, done-when
   command, depends-on. **Every task needs a machine-checkable done-when**;
   any task without one → stop, return the spec to the operator (that is a
   Stage-1 defect, not yours to improvise). Topo-sort by declared edges;
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
<wt>; <done-when>`); `$T/settings.json`:

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
with the spec, unmet done-whens, unsafe changes. Severity-tag each finding.
Absence of findings is a valid, expected output for sound work. Do not
propose refactors, hardening, or scope the spec did not ask for."*

Post the findings as ONE PR comment authored by stark-codex
(`github_app.ts --app stark-codex pr comment ...`). Do not act on them,
answer them, or re-run the pass — they are input for the human. [RQ6][A1]

## Phase 5 — Land [§3.9]

1. Mirror every deviation line into the spec's `## Deviations` (append-only;
   you edit the spec here — task sessions never could) in the MAIN checkout
   on a spec-touching commit onto `build/<slug>` if the spec file exists in
   the worktree, else note the mirror in the PR body.
2. Push (plain, never force). Post the run summary comment on the PR:
   tasks green/deviation counts, per-task check tails, evidence dir path,
   e2e outcome, blocks histogram.
3. e2e green + CI green + advisory posted → flip ready (`gh pr ready <n>`)
   unless `--stay-draft`. Anything red → stays draft.
4. Clean up: `git worktree remove <wt>` only when the tree is clean and
   everything is pushed.

## Phase 6 — Report

Final message, in the operator's read order [§3.9]: PR number · spec digest
path (`.human.md`) · deviations (verbatim) · advisory findings summary ·
evidence dir · e2e verdict · the diff hot spots worth a human spot-check.
The human is the merge gate — never merge, never resolve findings yourself.

## Measurement [RQ9]

Per run, from git/PR metadata + `$STATE` only: tasks green first dispatch ·
re-dispatch count · deviation count by class · Stop-block histogram ·
task-green/e2e-red divergence · advisory findings later confirmed by the
human. No wall-clock, no self-report, no completion-rate dashboards.

## What this replaces

For implementation from an accepted spec, this replaces `/stark-copilot`'s
lead/wing review loop, `/stark-plan-to-tasks`, and `/stark-phase-execute`.
Those remain installed for legacy plan artifacts until removed. The
antipatterns this skill must never grow back: [references/stage2-dossier.md](references/stage2-dossier.md) §5.
