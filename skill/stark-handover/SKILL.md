---
name: stark-handover
disable-model-invocation: true
description: >-
  Use when pausing or splitting work across sessions — before clearing context,
  when context runs low, at end of day, when switching tasks — or when resuming.
  Triggers: "handover", "handoff", "save context", "save progress", "resume",
  "continue where we left off", "what was I doing". Persists a numbered
  handover chain + PROGRESS.md tracker per task; resume needs no recap.
argument-hint: "[save|resume|status] [--task slug]"
---

## Help

If the current user request includes a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-handover

Cross-session continuity. Every **save** appends `handover_{N}.md`
(numbered chain) and rewrites `PROGRESS.md` (done-vs-todo tracker) under
`{root}/{project}/{worktree}/{task}/`; **resume** loads both in one call so a
fresh session continues without a recap. Root default: `~/Code/Handovers`
(config `handover.root`, env `STARK_HANDOVER_ROOT`).

The CLI owns paths/numbering/writes; **you** author the content — the value
of a handover is what you mine from the conversation, which only you have.

## Execution rule

Shell state does not persist between tool calls. Every command below resolves
`TOOLS` and invokes `stark_handover.ts` in the same shell call; do not create a
function or command variable and expect a later call to inherit it.

## Arguments

- no input or `save` — save a handover (default)
- `resume` — resume the latest task; add `--task <slug>` to select one
- `status` — list this project/worktree's tasks

Read the mode and flags from the current user's explicit invocation. Do not
depend on a host-populated argument placeholder.

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
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types --no-warnings \
  "$TOOLS/stark_handover.ts" resolve            # add: --task "<slug>"
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
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
HB=$(mktemp -t stark-handover-body) && PB=$(mktemp -t stark-handover-progress)
# Write handover body to $HB and progress to $PB, then:
node --experimental-strip-types --no-warnings \
  "$TOOLS/stark_handover.ts" save --task "<slug>" \
  --handover-file "$HB" --progress-file "$PB"
```

### Phase 4 — Report + the loop prompt

Self-check first: line count in budget, ≥1 failed approach or explicit
"none", next action is concrete (not "continue working"). Expand before
reporting if thin. Then tell the user:

- Saved `handover_{N}.md` (+ chain length) and `PROGRESS.md` + paths
- Done/remaining counts from the tracker
- The loop: **"Start a fresh or cleared session, then explicitly invoke
  `stark-handover` with `resume` — I'll pick up exactly here."**

---

## Resume Mode

### Phase 1 — Load

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types --no-warnings \
  "$TOOLS/stark_handover.ts" resume             # add: --task "<slug>"
```

Exit 2 → nothing to resume: say so, show `handover list`, ask what to
work on. Otherwise the JSON carries `handover_content` (latest in chain),
`progress_content`, `chain`, `task_slugs`.

### Phase 2 — Ingest + brief

Read both contents fully — they are your context now. Do **not** dump them
at the user; render a 5–8 line brief: task + seq, goal one-liner, where we
are, what's done vs left (counts), the next action. If `chain` has prior
seqs and the latest references them, read earlier files from `dir` only as
needed.

### Phase 3 — Rebuild task list + continue

Recreate the tracker's **Next** items in the current host's task or plan tracker,
when one is available, preserving order and skipping Done. If the host has no
task-tracking surface, keep the ordered Next list in working context and update
it explicitly as items finish. Run the handover's *Verify state* command if one
is listed. Then start on the first Next item immediately — the whole point is
zero recap friction. Pause only if the handover's *Open questions* block the
first step; ask exactly those.

---

## Status Mode

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types --no-warnings \
  "$TOOLS/stark_handover.ts" list               # add --all for every project/worktree
```

Render as a table: task, latest seq, last activity, has tracker. Suggest
explicitly invoking `stark-handover` with `resume --task <newest>` as the next
move.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| CLI prints `{"error": ...}` | Report it; for save retry once with `--task` explicit |
| `resolve` shows unrelated active task | New slug — never chain unrelated work |
| Not a git repo | Works fine — stored under `{cwd-basename}/no-git/` |
| Handover body < 60 lines after a real session | Under-mined — re-run Phase 2 checklist |
| Resume exit 2 | `list`, offer tasks, or start fresh work |
