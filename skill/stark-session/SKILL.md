---
name: stark-session
description: >-
  Session start (context, git state, briefing) and end (tests, merge, push). Use for session start/end, catch me up.
argument-hint: "[start|end]"
disable-model-invocation: true
model: opus
revision: 27e35f5d4b6b1e245c6bdd1adf11d8f1ff0233e6
revision_date: 2026-05-18T09:14:41Z
---

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-session`.

# stark-session

Session lifecycle management: **start** (context load + briefing) and **end** (test + merge + commit + push).

A single TS CLI gathers every fact you need into one JSON blob; you render the briefing/summary directly. No ANSI, no box-drawing, no fallback path — when a collector fails, its slot is `null` and the failure is logged into `errors[]`.

## Arguments

- `/stark-session` or `/stark-session start` — starts a session (default)
- `/stark-session end` — ends a session

**Raw input:** `$ARGUMENTS`

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
TOOLS="${STARK_REVIEW_TOOLS:-$HOME/.claude/code-review/tools}"
SESSION_CLI="node --experimental-strip-types --no-warnings $TOOLS/stark_session.ts"
```

## Config

Path: `.code-review/config.json` (hierarchical: global → org → repo). Reading is handled inside the TS CLI; you only need to know the keys that affect **end-mode dialogue**:

| Key | Default | Notes |
|-----|---------|-------|
| `build_command` | `null` | Build command for end |
| `test_command` | `null` | Falls back to top-level |
| `doc_paths` | `["docs/", "CLAUDE.md"]` | Paths to stage on end |
| `devlog_path` | `null` | Devlog directory |
| `pr_merge_strategy` | `"squash"` | squash/merge/rebase |

`session.health_checks` is consumed by the TS CLI directly — you don't run these yourself.

---

## Start Mode

### Phase 0 — Record start HEAD

```bash
SESSION_ID="${CLAUDE_SESSION_ID:-$(node --experimental-strip-types --no-warnings "$HOME/.claude/code-review/tools/session_id.ts")}"
START_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### Phase 1 — Gather context (silent)

Read and internalize — do NOT display:
- `CLAUDE.md` from current directory and each parent up to `~`
- Memory files: `~/.claude/projects/*/memory/` matching current project path

(Config + project board context are handled by the CLI in Phase 2.)

### Phase 2 — Collect session state

```bash
STATE_JSON=$($SESSION_CLI start \
  --session-id "$SESSION_ID" \
  --start-head "$START_HEAD" \
  --started-at "$STARTED_AT" 2>/dev/null || echo '{}')
```

`STATE_JSON` is the structured briefing. Schema:

```json
{
  "session": { "session_id", "started_at", "branch", "repo",
               "tasks_completed", "last_checkpoint", "name", "start_head" } | null,
  "git": { "branch", "ahead", "behind", "uncommitted", "stashes",
           "recent_commits": [{ "sha", "message", "age" }] } | null,
  "prs": { "mine": [{ "number", "title", "head", "review_decision", "url" }],
           "current_branch": { "number", "title", "state", "review_decision",
                               "checks": { "pass", "fail", "pending" } } | null } | null,
  "board": { "in_flight", "blocked", "needs_attention" } | null,
  "alerts": { "unacknowledged": [{ "level", "message", "context" }] } | null,
  "health": [{ "name", "passed", "detail", "duration" }],
  "queue": { "pending", "dead_letter", "max_created_at" } | null,
  "healer": { "categories": [{ "name", "count" }],
              "canary": { "circuits_open", "near_promotion" } } | null,
  "skills": { "available": [...], "suggestions": [{ "name", "reason" }] },
  "persona": { "name", "source", "catchphrase", ... } | null,
  "errors": [{ "source", "message" }]
}
```

### Phase 3 — Persist start HEAD

```bash
node --experimental-strip-types --no-warnings \
  "$HOME/.claude/code-review/tools/session_state.ts" set \
  --field start_head --value "$START_HEAD" 2>/dev/null || true
```

### Phase 4 — Render briefing

Render `STATE_JSON` as a concise briefing for the user. Layout guidance:

1. **Header line:** `Session {session.session_id[:8]} · {session.branch} · {session.repo}`
2. **Persona line** (if `persona`): `Persona: {name} ({source}) — "{catchphrase}"`
3. **Alerts** (if `alerts.unacknowledged` non-empty): surface FIRST and prominently — each as `[{level}] {message}` with context underneath.
4. **Git**: branch, ahead/behind, uncommitted count, stashes, last 5 commits.
5. **PRs**: open PRs (`mine`), then the current branch PR with check rollup if present.
6. **Board**: `in_flight`, `needs_attention`, `blocked` (omit empty buckets).
7. **Health**: render each result on one line — pass/fail/timeout, name, duration, short detail.
8. **Queue**: `pending`/`dead_letter` — warn if `dead_letter > 0` or `pending > 10`.
9. **Healer**: top categories from `healer.categories`; flag any `circuits_open` and `near_promotion`.
10. **Skills**: skill `suggestions` (cap 2). Available skills list is for your awareness; don't dump it on the user.
11. **Errors** (if non-empty): brief one-liner at the bottom — *"Couldn't read: X, Y"*.

Omit entire sections that are `null` or empty. Prefer brief, scannable formatting over walls of text.

### Phase 5 — Task list

Build a prioritized task list from the briefing data in this order, including only categories that have items:

1. **Open PRs needing action** — review comments, failing checks, requested changes
2. **Uncommitted changes** — dirty tree, staged files, stashes
3. **Failing health checks**
4. **Board items in flight** assigned to Claude
5. **Alerts** still unacknowledged

Ask: **"Task list look right? Say 'go' to start from the top, or tell me what to focus on."**

On "go", work sequentially without prompting between tasks — only pause for genuine decisions (merge conflict, ambiguous review, failing test). If everything is empty: "Everything looks clean. What are we working on?"

---

## End Mode

### Phase 0 — Persona cleanup

```bash
if [ -f "$HOME/.stark-persona/active.json" ]; then
  node --experimental-strip-types "$HOME/.claude/code-review/tools/stark_persona.ts" session-end 2>/dev/null || true
fi
```
Display the 20% fun-fact callout AFTER the summary (if any).

### Phase 1 — Tests

Read `test_command` and `build_command` from `.code-review/config.json` (`session.*` first, then top-level). Run them.

On failure: warn and ask **"Proceed anyway?"**

### Phase 2 — Merge open PRs

```bash
gh auth status   # skip with warning if fails
gh pr list --head "$(git branch --show-current)" --json number,title,state
```

For each open PR: offer to merge via `gh pr merge <number> --<pr_merge_strategy>`. On failure: report and ask "Skip this PR?". Uses your PAT — not GitHub App bots.

### Phase 3 — Commit docs

Stage paths from `session.doc_paths`. If `session.devlog_path` is set, prompt for a one-line summary, create `<devlog_path>/YYYY-MM-DD.md`, stage it. Always ask for a summary for the commit message.

Skip the commit if `git diff --cached --stat` is empty. Otherwise:

```bash
git commit -m "docs: session update — <summary>"
```

### Phase 3b — Session checkpoint

```bash
node --experimental-strip-types --no-warnings \
  "$HOME/.claude/code-review/tools/context_compactor.ts" --json 2>/dev/null || true
node --experimental-strip-types --no-warnings \
  "$HOME/.claude/code-review/tools/session_state.ts" --json 2>/dev/null || true
```

Both are best-effort. Note the checkpoint path in the summary.

### Phase 4 — Project field updates

If `.github/project-config.json` exists: pull issue numbers from this session's commits. For commits referencing an issue that also modified `docs/`, set Documentation State to `Drafted` (only if currently `Not Started`). Do not override `Reviewed` or `Complete`. Log warnings — never block session end.

### Phase 5 — Push

If the branch has an upstream, or you're on `main` ahead of `origin`: `git push`. On failure: report and ask how to proceed. If no upstream and not on `main`: ask **"Push to origin?"**

### Phase 5.5 — Derive session name

In priority order, derive a slug (lowercase, hyphens, max 50 chars) from:

1. PRs merged in this session
2. Issues closed in this session
3. Branch name
4. Most common commit prefix
5. `session-$SESSION_ID`

You compute this — no CLI call needed; you have all the inputs from accumulated phase results.

### Phase 6 — Collect end state + render summary

```bash
END_JSON=$($SESSION_CLI end \
  --session-id "$SESSION_ID" \
  --start-head "$START_HEAD" \
  --started-at "$STARTED_AT" \
  --name "$SESSION_NAME" 2>/dev/null || echo '{}')
```

Schema:

```json
{
  "session": { "session_id", "branch", "repo", "started_at",
               "name", "start_head", "ended_at" },
  "diff": { "added", "removed", "file_count",
            "key_files": [{ "path", "added", "removed", "status" }],
            "approximate" } | null,
  "branch": { "ahead", "behind", "upstream", "has_pr" },
  "errors": [{ "source", "message" }]
}
```

Render the end summary:

1. **Header**: `Session {name} · {duration} · {branch}`
2. **Receipt** (from your in-memory accumulator through phases 1–5.5): Tests, Build, PRs merged, Docs committed, Push — each as pass/fail with a detail and duration.
3. **Diff**: `{added}+ / {removed}- across {file_count} files` + the key files list. Warn if `diff.approximate` is true (start HEAD wasn't recorded).
4. **Branch**: ahead/behind vs upstream, PR link if `has_pr`.
5. **Errors** (if non-empty): brief one-liner.
6. **Persist session name**:

```bash
node --experimental-strip-types --no-warnings \
  "$HOME/.claude/code-review/tools/session_state.ts" set \
  --field name --value "$SESSION_NAME" 2>/dev/null || true
```

---

## Failure Modes

| Failure | Recovery |
|---------|----------|
| `STATE_JSON` empty / `{}` | CLI crashed — read stderr, fall back to plain `git status` + `gh pr list` |
| Specific slot is `null` | Note in `errors[]`; omit that section from briefing |
| `gh` auth fails | `prs` slot null, skip PR sections |
| Not a git repo | `git` and `prs` slots null |
| Test/build fails | Warn, ask whether to proceed |
| PR merge fails | Report, offer to skip |
| Push fails | Report, ask how to proceed |
| Project config missing | `board` slot null silently |
| Config missing | Health checks empty, defaults applied for end-mode keys |

> **Warning:** Every command in a parallel batch must exit 0 — one non-zero exit cancels the entire batch. Use `|| true` on the few shell commands that remain in the SKILL itself. The TS CLI is failure-safe by construction; no `|| true` needed when calling it.
