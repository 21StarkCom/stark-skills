---
name: stark-handover
description: >-
  Use when pausing or splitting work across sessions — before /clear, when
  context runs low, end of day, switching tasks — or when resuming after one.
  Triggers: "handover", "handoff", "save context", "save progress", "resume",
  "continue where we left off", "what was I doing". Persists a numbered
  handover chain + PROGRESS.md tracker per task; resume needs no recap.
argument-hint: "[save|resume|status] [--task slug]"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-handover

Cross-`/clear` session continuity. Every **save** appends `handover_{N}.md`
(numbered chain) and rewrites `PROGRESS.md` (done-vs-todo tracker) under
`{root}/{project}/{worktree}/{task}/`; **resume** loads both in one call so a
fresh session continues without a recap. Root default: `~/Code/Handovers`
(config `handover.root`, env `STARK_HANDOVER_ROOT`).

The CLI owns paths/numbering/writes; **you** author the content — the value
of a handover is what you mine from the conversation, which only you have.

## Constants

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
HANDOVER_CLI="node --experimental-strip-types --no-warnings $TOOLS/stark_handover.ts"
```

## Arguments

- `/stark-handover` or `/stark-handover save` — save a handover (default)
- `/stark-handover resume` — resume the latest (or `--task <slug>`) task
- `/stark-handover status` — list this project/worktree's tasks

**Raw input:** `$ARGUMENTS`

## Guards

- **Never write handover files freeform.** Ad-hoc summaries skip chain
  numbering, frontmatter, and the tracker — always go through the CLI.
- **Save only when asked** (explicit invocation or a clear "save context /
  wrap up" request). Don't burn tokens on speculative handovers.
- Not in plan mode — this skill writes files.

---

## Save Mode

### Phase 1 — Resolve storage context

```bash
$HANDOVER_CLI resolve            # or: resolve --task "<slug>"
```

Pick the task slug, in order: `--task` from arguments → the `task` field from
`resolve` (continuing the active task) → derive a fresh 2-4 word kebab slug
from the session's dominant work (e.g. `fix-auth-callback`). When `resolve`
shows an existing task whose work does NOT match this session, do not chain
onto it — use a new slug.

### Phase 2 — Mine the conversation

The conversation is ground truth; git fills gaps:

```bash
git log --oneline -15 && git status -s && git diff --stat
```

Extraction checklist — every bullet you skip is something the next session
re-discovers the hard way:

- [ ] Goal (why, not just what)
- [ ] Where we are — every file/function touched, with specifics
- [ ] Approaches tried, **including failed ones + why they failed**
- [ ] Decisions made + rejected alternatives
- [ ] Evidence with real numbers ("21/21 pass", "exit 2"), never "it works"
- [ ] User feedback & preferences, verbatim — this calibrates the next session
- [ ] Next steps, ordered; risks; open questions
- [ ] Commands to verify state on resume

### Phase 3 — Author the two artifacts

Write both to temp files, following the templates **exactly**
(section names are the resume contract):

- Handover body → [references/handover-template.md](references/handover-template.md).
  Target 80–250 lines; a real work session under 60 lines is under-mined —
  go back to Phase 2. Details are the value; too-long is cheap, too-short
  costs the next session hours.
- Progress tracker → [references/progress-template.md](references/progress-template.md).
  ≤ 50 lines, rewritten wholesale — it's a tracker, not a log; history lives
  in the chain.

```bash
HB=$(mktemp -t stark-handover-body) && PB=$(mktemp -t stark-handover-progress)
# Write handover body to $HB and progress to $PB, then:
$HANDOVER_CLI save --task "<slug>" --handover-file "$HB" --progress-file "$PB"
```

### Phase 4 — Report + the loop prompt

Self-check first: line count in budget, ≥1 failed approach or explicit
"none", next action is concrete (not "continue working"). Expand before
reporting if thin. Then tell the user:

- Saved `handover_{N}.md` (+ chain length) and `PROGRESS.md` + paths
- Done/remaining counts from the tracker
- The loop: **"Run `/clear`, then `/stark-handover resume` — I'll pick up
  exactly here."**

---

## Resume Mode

### Phase 1 — Load

```bash
$HANDOVER_CLI resume             # or: resume --task "<slug>"
```

Exit 2 → nothing to resume: say so, show `$HANDOVER_CLI list`, ask what to
work on. Otherwise the JSON carries `handover_content` (latest in chain),
`progress_content`, `chain`, `task_slugs`.

### Phase 2 — Ingest + brief

Read both contents fully — they are your context now. Do **not** dump them
at the user; render a 5–8 line brief: task + seq, goal one-liner, where we
are, what's done vs left (counts), the next action. If `chain` has prior
seqs and the latest references them, read earlier files from `dir` only as
needed.

### Phase 3 — Rebuild task list + continue

Recreate the tracker's **Next** items as session tasks (TaskCreate, in
order; skip Done). Run the handover's *Verify state* command if one is
listed. Then start on the first Next item immediately — the whole point is
zero recap friction. Pause only if the handover's *Open questions* block the
first step; ask exactly those.

---

## Status Mode

```bash
$HANDOVER_CLI list               # --all for every project/worktree
```

Render as a table: task, latest seq, last activity, has tracker. Suggest
`/stark-handover resume --task <newest>` as the next move.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| CLI prints `{"error": ...}` | Report it; for save retry once with `--task` explicit |
| `resolve` shows unrelated active task | New slug — never chain unrelated work |
| Not a git repo | Works fine — stored under `{cwd-basename}/no-git/` |
| Handover body < 60 lines after a real session | Under-mined — re-run Phase 2 checklist |
| Resume exit 2 | `list`, offer tasks, or start fresh work |
