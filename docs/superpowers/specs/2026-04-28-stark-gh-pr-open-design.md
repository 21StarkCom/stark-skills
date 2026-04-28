# stark-gh:pr-open Design Spec

## Overview

A Claude Code plugin (`stark-gh`) housing a family of GitHub workflow slash commands. v1 ships `/stark-gh:pr-open` — a "full pipeline" command that detects state, drafts PR title/body via a Sonnet sub-agent (respecting `.github/PULL_REQUEST_TEMPLATE.md`), commits/pushes/creates the PR, and spawns a background watcher for CI checks. Implementation splits work between TS tools (deterministic state + mutations) and a single LLM sub-agent (drafting prose). The plugin scaffolds the rest of the family — `/stark-gh:merge`, `/stark-gh:merge-and-release`, `/stark-gh:clean`, `/stark-gh:fetch`, `/stark-gh:workflow-run` — by establishing a shared `lib/` and a reusable background watcher.

## Decisions

| Decision | Choice |
|----------|--------|
| Plugin namespace | `stark-gh` (colon-namespaced commands: `/stark-gh:pr-open`, `/stark-gh:merge`, …) |
| First command | `/stark-gh:pr-open` (full pipeline: optional commit → push → create or update) |
| LLM/TS split | Approach C — TS preflight + TS execute, with one LLM sub-agent at the drafting step |
| Sub-agent model | Sonnet 4.6 |
| Parent skill model | Sonnet 4.6 |
| Branch contract | Refuses on default branch; assumes a feature branch (worktree or plain checkout) |
| Draft default | Never draft — always ready PR (no `--draft` flag) |
| Args policy | Pass-through only, no LLM parsing: `--title`, `--body`, `--body-file`, `--base`, `--reviewer`, `--label`, `--assignee`, `--no-watch` |
| Existing PR | Push commits (PR auto-updates). Update title and/or body only for the override flags the user passed — never both unconditionally |
| Issue auto-linking | Detect `#N` from branch name + commit messages → emit `Closes #N` only at high confidence |
| Base detection | `gh repo view --json defaultBranchRef`; `--base` flag overrides |
| Background watcher | `gh_watch_runs.ts` polls `gh pr checks` until terminal; default-on, opt-out via `--no-watch` |
| PR template | Reads `.github/PULL_REQUEST_TEMPLATE.md` (single template, root or `.github/`) if present |
| Install | install.sh symlinks `plugins/stark-gh/` → `~/.claude/plugins/stark-gh/` |
| TS runtime | `node --experimental-strip-types` (matches existing stark tools convention) |

## Repository Structure

```
plugins/stark-gh/
├── .claude-plugin/
│   └── plugin.json                    # { name, description, author }
├── commands/
│   └── pr-open.md                     # Skill body / orchestrator
├── tools/
│   ├── gh_pr_open_preflight.ts        # Stage 1: read state, validate guards, emit JSON
│   ├── gh_pr_open_execute.ts          # Stage 3: commit + push + create/update + spawn watcher
│   ├── gh_watch_runs.ts               # Background CI poller (shared across family)
│   ├── lib/
│   │   ├── git.ts                     # execFileSync wrappers (no shell interpolation)
│   │   ├── gh.ts                      # gh CLI helpers (typed)
│   │   ├── branch.ts                  # branch-name validation
│   │   ├── issue.ts                   # extract issue numbers (branch + commits)
│   │   ├── exit.ts                    # numbered exit codes + messages
│   │   └── output.ts                  # printJson() / printErr() helpers
│   └── __tests__/
│       ├── branch.test.ts
│       ├── issue.test.ts
│       ├── preflight.test.ts
│       └── execute.test.ts
└── README.md
```

`install.sh` adds a plugin loop alongside the existing `skill/stark-*` loop:

```bash
# Install plugins
for plugin_dir in "$REPO_DIR"/plugins/*/; do
    [ -d "$plugin_dir" ] || continue
    [ -f "$plugin_dir/.claude-plugin/plugin.json" ] || continue
    name=$(basename "$plugin_dir")
    target="$HOME/.claude/plugins/$name"
    ln -sfn "$plugin_dir" "$target"
done
```

The plugin manifest is recorded in `$CODE_REVIEW_DIR/plugins.manifest.json` (mirrors the existing skill manifest pattern: SHA + ISO date of the last commit touching `plugins/<name>/`, plus a dirty flag at install time).

## Pipeline Overview

The skill body in `commands/pr-open.md` orchestrates a fixed three-stage pipeline. Each stage has one responsibility; the LLM is invoked at exactly one stage.

```
Stage 1 (TS, read-only)            Stage 2 (LLM sub-agent)            Stage 3 (TS, mutations)
─────────────────────────          ───────────────────────            ──────────────────────────
gh_pr_open_preflight.ts    ────►   Agent(model=sonnet)        ────►   gh_pr_open_execute.ts
  • detect state                     • draft title and/or body          • commit (if dirty)
  • validate guards                  • respect PR template              • push (set upstream)
  • emit big JSON                    • append "Closes #N"               • gh pr create | gh pr edit
                                     • return JSON {title, body}       • spawn gh_watch_runs.ts
                                                                       • emit result JSON
```

Stage 2 is conditional. It runs only when there is **no existing PR** AND at least one of {title, body} is missing from `userArgs`. For an existing PR we never re-draft prose: the user's overrides go through verbatim, and unprovided pieces are left untouched on GitHub (avoids clobbering manual edits). The "Sub-agent decision matrix" below is the source of truth.

## Components

### 1. `gh_pr_open_preflight.ts`

**Purpose:** collect every piece of state the LLM and Stage 3 need; validate guards; fail fast.

**Inputs (CLI args, all optional):**
- `--base BRANCH`
- `--title TITLE`, `--body BODY`, `--body-file PATH`
- `--reviewer LIST`, `--label LIST`, `--assignee LIST` (comma-separated)
- `--no-watch`

These are surfaced unchanged in the JSON's `userArgs` field so Stage 2/3 know what the user provided.

**Behavior:**
1. Verify cwd is a git repo (`git rev-parse --git-dir`).
2. Detect current branch (`git rev-parse --abbrev-ref HEAD`).
3. Resolve default branch:
   - If `--base` given, use it.
   - Else: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
4. Refuse if `currentBranch == defaultBranch` (exit `11`).
5. Validate current branch name against `^[a-zA-Z0-9][a-zA-Z0-9/_.#+-]*$` (regex from `claude-code-action`'s branch validator). Exit `12` on mismatch with the violating substring.
6. Detect dirty tree: `git status --porcelain` (any output → dirty).
7. Detect unpushed commits:
   - If upstream tracking exists (`git rev-parse --abbrev-ref --symbolic-full-name @{u}`): `git rev-list --count @{u}..HEAD`.
   - Else: count `git rev-list --count <baseBranch>..HEAD` and mark `hasUpstream: false`.
8. Look up existing PR for current branch: `gh pr list --head <branch> --state open --json number,url,title,body,headRefOid` → first entry or `null`.
9. Locate PR template:
   - Check `.github/PULL_REQUEST_TEMPLATE.md`, then `.github/pull_request_template.md`, then `PULL_REQUEST_TEMPLATE.md`. (Single-template repos only; multi-template directory is out of scope for v1.)
   - Read content if found.
10. Compute candidate issues:
    - Branch-name regex `^(feat|fix|chore|docs|refactor|test|perf|ci|build|style|revert)/(\d+)-` → confidence `high`, source `branch`.
    - Commit-body regex `(?:closes|fixes|resolves)\s+#(\d+)` (case-insensitive) → confidence `high`, source `commit`.
    - Plain `#(\d+)` mentions in branch name or commits → confidence `low`.
    - Deduplicate by issue number; keep highest confidence.
11. Compute diff context:
    - `stat`: `git diff --stat <baseBranch>...HEAD` (truncated to 100 lines).
    - `fileCount`: parsed file count from stat.
    - `patch`: `git diff <baseBranch>...HEAD`, capped at 60 KB; if larger, truncate at the file boundary closest to the cap and append `[... truncated, N more files]`.
12. Read commit messages: `git log --format=%B <baseBranch>..HEAD` (full bodies, no truncation; assumed bounded by branch life).

**Output (stdout, JSON; stderr reserved for human-readable errors):**

```jsonc
{
  "branch": "feat/123-foo",
  "baseBranch": "main",
  "remote": "origin",
  "dirty": true,
  "hasUpstream": false,
  "unpushedCommits": 3,
  "existingPr": null,                       // or { number, url, title, body, headRefOid }
  "prTemplate": "## Summary\n…\n",          // or null
  "candidateIssues": [
    { "number": 123, "confidence": "high", "source": "branch" }
  ],
  "diff": {
    "stat": "src/foo.ts | 30 ++++++++--\n",
    "fileCount": 3,
    "patch": "diff --git …",
    "truncated": false
  },
  "commitMessages": ["feat(foo): add bar\n\nDetail…"],
  "userArgs": {
    "title": null,
    "body": null,
    "bodyFile": null,
    "base": null,
    "reviewer": [],
    "label": [],
    "assignee": [],
    "noWatch": false
  }
}
```

**Exit codes:**

| Code | Meaning |
|---:|---|
| 0 | success |
| 10 | not a git repo |
| 11 | on default branch (refusal) |
| 12 | invalid branch name |
| 13 | `gh` not installed or not authenticated |
| 14 | no remote configured (no `origin`) |
| 15 | could not resolve default branch |
| 1 | unspecified failure |

### 2. Drafting sub-agent (Stage 2)

The skill body decides whether to dispatch (see decision matrix). When it does, it dispatches one sub-agent.

**Dispatch shape:**

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "Draft PR title/body",
  prompt: <self-contained prompt — see below>
)
```

**Prompt template (parent does string substitution on `<…>` placeholders):**

```
You are drafting a GitHub PR for a feature branch. Inputs are below as JSON; produce the
output JSON described at the bottom. Do not perform any tool calls. Reply with one fenced
```json``` block containing your output and nothing else.

DRAFT_REQUEST: { "needTitle": <bool>, "needBody": <bool> }

USER_PROVIDED:
  title:    <userArgs.title or null>
  body:     <userArgs.body or null, or contents of userArgs.bodyFile if set>

PREFLIGHT:
  branch:           <preflight.branch>
  base:             <preflight.baseBranch>
  prTemplate:       <preflight.prTemplate or null>
  candidateIssues:  <preflight.candidateIssues>
  commitMessages:   <preflight.commitMessages>
  diffStat:         <preflight.diff.stat>
  diffPatch:        <preflight.diff.patch>     // truncated to ~60KB

RULES:
1. If needTitle: produce a single-line title in conventional-commit form when the change
   maps cleanly to one (`feat(scope): …`, `fix: …`); otherwise plain imperative.
2. If needBody:
   a. If prTemplate is non-null: fill the template's headings/sections from the diff and
      commit messages. Do not invent CI/test results not present in commit messages.
   b. Else: produce sections "## Summary", "## Why", "## Test plan" (the last is a
      bulleted checklist of the user's likely manual checks).
   c. Append "Closes #N" lines (one per high-confidence candidate issue), separated from
      the body by a blank line.
3. Do not include any markdown headers in the title.
4. Do not invent reviewers/labels/assignees in the body.

OUTPUT FORMAT (single fenced JSON block):
```json
{
  "title": "…" | null,    // null only if needTitle was false
  "body":  "…" | null     // null only if needBody was false
}
```
```

**Parsing:** parent extracts the first fenced JSON block; if parse fails or required fields are missing, parent retries once with a stricter "your previous output was invalid because X" suffix; if still bad, exit with a clear error.

**Output handling:** parent writes `title` (when present) to `$TITLE_FILE` and `body` to `$BODY_FILE` (`mktemp` paths); both paths are passed to Stage 3.

#### Sub-agent decision matrix

Let `T = userArgs.title`, `B = userArgs.body || userArgs.bodyFile`, `pr = existingPr`.

| `pr` | `T` | `B` | Action |
|---|---|---|---|
| null | nil | nil | Stage 2 drafts title + body |
| null | set | nil | Stage 2 drafts body only |
| null | nil | set | Stage 2 drafts title only |
| null | set | set | Skip Stage 2; both come from user |
| set | nil | nil | Skip Stage 2; Stage 3 push-only (no `gh pr edit`) |
| set | set | nil | Skip Stage 2; Stage 3 `gh pr edit --title` only |
| set | nil | set | Skip Stage 2; Stage 3 `gh pr edit --body-file` only |
| set | set | set | Skip Stage 2; Stage 3 `gh pr edit --title --body-file` |

This matrix is the source of truth for Stages 2 and 3.

### 3. `gh_pr_open_execute.ts`

**Purpose:** the only mutating component. Idempotent: safe to re-run; converges to "branch pushed, PR exists, watcher running".

**Inputs (CLI args):**
- `--title-file PATH` (optional; absent → no title write)
- `--body-file PATH` (optional; absent → no body write)
- `--base BRANCH`
- `--reviewer LIST`, `--label LIST`, `--assignee LIST`
- `--no-watch`
- `--existing-pr-number N` (when reusing existing PR; the skill body passes the value from preflight JSON)

**Behavior:**
1. **Commit:** if `git status --porcelain` shows changes:
   - `git add -A`
   - `git commit -m "<title>"` (one commit; message read from `--title-file`). If `--title-file` is absent (existing-PR push-only path), nothing is committed — the dirty tree is preserved and we exit with code `24` so the user knows to provide a title or use a separate commit command first.
2. **Push:** `git push --set-upstream origin <currentBranch>` if `git rev-parse --abbrev-ref @{u}` fails; else `git push`.
3. **Create or update PR:**
   - **No `--existing-pr-number`:**
     - Build `gh pr create` argv: `--title <title>`, `--body-file <body-file>`, `--base <base>`, plus optional `--reviewer`, `--label`, `--assignee` (each list comma-joined). Never `--draft`.
   - **With `--existing-pr-number`:**
     - Build `gh pr edit <N>` argv with only the flags the user passed (`--title` if `--title-file` set, `--body-file` if `--body-file` set, plus `--add-reviewer`, `--add-label`, `--add-assignee` for those lists; existing values are not removed).
4. **Resolve PR URL/number:** `gh pr view --json url,number -q '{url,number}'` (works whether we just created it or it already existed).
5. **Spawn watcher** unless `userArgs.noWatch`:
   - Detached child via `child_process.spawn("node", [...], { detached: true, stdio: "ignore" })` then `child.unref()`.
   - Args: `--pr <N> --repo <owner/repo>` (resolved from `gh repo view`), `--max-minutes 30`, `--poll-seconds 15`.
6. **Emit result JSON.**

**Output:**

```jsonc
{
  "action": "created" | "updated" | "pushed-only",
  "prNumber": 42,
  "prUrl": "https://github.com/owner/repo/pull/42",
  "watcherPid": 12345 | null,
  "watcherStateFile": "~/.claude/code-review/stark-gh/watchers/pr-42.json" | null
}
```

**`action` semantics:**
- `created` — `gh pr create` ran (no existing PR).
- `updated` — `gh pr edit` ran (existing PR + at least one update arg: `--title-file`, `--body-file`, `--reviewer`, `--label`, or `--assignee`).
- `pushed-only` — only `git push` happened (existing PR with no update args).

Metadata flags (`--reviewer`, `--label`, `--assignee`) are **independent of the title/body decision matrix**: they are forwarded to `gh pr create` (as `--reviewer`/`--label`/`--assignee`) or `gh pr edit` (as `--add-reviewer`/`--add-label`/`--add-assignee`) whenever non-empty. They never trigger Stage 2.

**Exit codes:** mirrors preflight where applicable; new codes:
- 20: nothing to push and no existing PR (rare; covered by preflight, but a defensive guard)
- 21: `gh pr create` failed
- 22: `gh pr edit` failed
- 23: push failed (non-fast-forward etc.)
- 24: dirty tree but no `--title-file` (cannot generate a commit message)

### 4. `gh_watch_runs.ts` (background)

**Purpose:** poll PR check status; emit terminal summary; never block the parent.

**Inputs:**
- `--pr N` (required)
- `--repo OWNER/REPO` (required)
- `--max-minutes 30` (default)
- `--poll-seconds 15` (default)

**Behavior:**
1. Compute state file path: `${HOME}/.claude/plugins/stark-gh/state/watchers/pr-<N>.json`. Write `{ status: "watching", startedAt: <iso>, pr, repo }`.
2. Loop until terminal or max-minutes exceeded:
   - `gh pr checks <N> --repo <owner/repo> --json bucket,name,state,link,workflow,startedAt,completedAt`
   - Terminal when every check has `state` ∈ {`SUCCESS`, `FAILURE`, `CANCELLED`, `SKIPPED`} AND there is at least one check, OR when no checks have appeared after the first 60 seconds (some repos have no CI).
   - Sleep `poll-seconds`.
3. On terminal:
   - Update state file with `{ status: "done", finishedAt, checks: [...], summary: { total, success, failure, cancelled, skipped } }`.
   - macOS notification via `osascript -e 'display notification "..." with title "stark-gh"'` (best-effort; failure ignored).
4. On timeout: state file gets `{ status: "timeout", finishedAt }`.

**State directory:** `~/.claude/code-review/stark-gh/watchers/` (resolved via `os.homedir()`). Created with `mkdir -p` semantics on first write.

### 5. `commands/pr-open.md` (skill body)

**Frontmatter:**

```yaml
---
name: pr-open
description: >-
  Open or update a PR with sub-agent-drafted title/body, push, and watch CI.
argument-hint: "[--title TITLE] [--body BODY] [--body-file FILE] [--base BRANCH] [--reviewer LIST] [--label LIST] [--assignee LIST] [--no-watch]"
allowed-tools: Bash, Read, Write, Agent
model: sonnet
---
```

**Body structure (skeleton — full prose written in implementation):**

```markdown
# /stark-gh:pr-open

Open or update a GitHub pull request. Three stages: TS preflight → sub-agent draft → TS execute.
You orchestrate; you do NOT draft prose yourself.

## Constants
- TOOLS: $HOME/.claude/plugins/stark-gh/tools

## Stage 1 — Preflight

Run:
\`\`\`bash
node --experimental-strip-types "$TOOLS/gh_pr_open_preflight.ts" $ARGUMENTS --json
\`\`\`
Capture stdout as PREFLIGHT (parse as JSON). On nonzero exit, surface stderr to the user and stop.

## Stage 2 — Draft (conditional)

Apply the decision matrix (preflight.existingPr × preflight.userArgs.title × preflight.userArgs.body|bodyFile)
to compute (needTitle, needBody, willEdit, willCreate). If both needTitle and needBody are false, skip to Stage 3.

Else dispatch ONE sub-agent:
- subagent_type: general-purpose
- model: sonnet
- prompt: <fill the prompt template above with PREFLIGHT and DRAFT_REQUEST>

Parse the returned fenced JSON block. Write title to $TITLE_FILE (mktemp) when present, body to $BODY_FILE.

## Stage 3 — Execute

Build the execute argv:
- --title-file $TITLE_FILE (only if title was set or drafted)
- --body-file $BODY_FILE (only if body was set or drafted)
- --existing-pr-number <N> (only if PREFLIGHT.existingPr is non-null)
- --base, --reviewer, --label, --assignee, --no-watch as user provided

Run:
\`\`\`bash
node --experimental-strip-types "$TOOLS/gh_pr_open_execute.ts" <argv>
\`\`\`

Print result.prUrl. If result.watcherPid, mention "Watching CI in background (state file: <result.watcherStateFile>)."
```

The full body adds error-message templates and a worked example, but the structure above is the contract.

## Data Flow (worked examples)

### A) Happy path — dirty tree, no existing PR

```
$ /stark-gh:pr-open --reviewer alice
                                    ▼
Stage 1: gh_pr_open_preflight.ts --reviewer alice
  → JSON: {
      branch: "feat/123-foo", baseBranch: "main", dirty: true, unpushedCommits: 2,
      existingPr: null, prTemplate: "## Summary\n…\n",
      candidateIssues: [{ number: 123, confidence: "high", source: "branch" }],
      diff: {…}, commitMessages: ["feat(foo): add bar"], userArgs: { reviewer: ["alice"] }
    }
                                    ▼
Stage 2: Agent(sonnet, prompt=<filled template, needTitle=true, needBody=true>)
  → '{"title": "feat(foo): add bar", "body": "## Summary\n…\n\nCloses #123"}'
  → write /tmp/.../title /tmp/.../body
                                    ▼
Stage 3: gh_pr_open_execute.ts --title-file … --body-file … --reviewer alice
  → git add -A; git commit -m "feat(foo): add bar"
  → git push --set-upstream origin feat/123-foo
  → gh pr create --title "feat(foo): add bar" --body-file … --base main --reviewer alice
  → spawn gh_watch_runs.ts --pr 42 --repo evinced/stark-skills
  → JSON: { action: "created", prNumber: 42, prUrl: "…/pull/42", watcherPid: 12345 }
                                    ▼
Skill prints: "Opened …/pull/42 — watching CI in background."
```

### B) Existing PR, push-only

```
$ /stark-gh:pr-open
                                    ▼
Stage 1 → existingPr: { number: 42, url: …, title: …, body: … }, dirty: false, unpushedCommits: 1
                                    ▼
Stage 2: SKIPPED (decision matrix: pr=set, T=nil, B=nil)
                                    ▼
Stage 3: gh_pr_open_execute.ts --existing-pr-number 42
  → git push   (no commit; no gh pr edit)
  → spawn watcher
  → JSON: { action: "pushed-only", prNumber: 42, prUrl: "…", watcherPid: 12346 }
```

### C) Existing PR, user provided new title

```
$ /stark-gh:pr-open --title "feat: better foo"
                                    ▼
Stage 1 → existingPr: { number: 42, …}, userArgs.title: "feat: better foo"
                                    ▼
Stage 2: SKIPPED (decision matrix: pr=set, T=set, B=nil)
                                    ▼
Stage 3: write title to file, run gh pr edit 42 --title "feat: better foo"
  → JSON: { action: "updated", prNumber: 42, … }
```

## Edge Cases

| State | Behavior |
|---|---|
| On `main` / default branch | Preflight exit `11`; message: "create a feature branch first (currently on `main`)" |
| Not a git repo | Preflight exit `10` |
| Invalid branch name (control char, leading `-`, etc.) | Preflight exit `12` with the violating substring |
| `gh` not installed or unauthenticated | Preflight exit `13` with `gh auth login` hint |
| No `origin` remote | Preflight exit `14` |
| Could not resolve default branch | Preflight exit `15` |
| No upstream set on current branch | Execute pushes with `--set-upstream`; non-error |
| Clean tree, unpushed commits, no PR | Skip commit; push; create PR |
| Clean tree, no unpushed, no PR | Push is a no-op; `gh pr create` runs against the already-pushed branch |
| Clean tree, no unpushed, existing PR | Push no-op; no `gh pr edit`; report URL (idempotent re-run) |
| Sub-agent returns malformed JSON | Retry once; if still bad, exit `30` with the raw output in stderr |
| Sub-agent timeout | Same as malformed: surface stderr, suggest retry |
| Watcher fails to start | Result JSON's `watcherPid: null`; not fatal |
| User pressed Ctrl-C between push and `gh pr create` | Re-run picks up: branch already pushed, no PR yet → goes through `gh pr create` path |

## Error Handling

- **TS exit codes are stable** and documented per tool. Skill body checks each invocation and surfaces stderr verbatim to the user, then stops.
- **No partial-state cleanup.** A failure mid-pipeline leaves the working tree in whatever state it reached. Re-running converges (idempotent).
- **Watcher failures are silent** by design (best-effort). The user can re-run `gh pr checks` manually; the result file (if any) tells them where the watcher got.
- **Sub-agent retry policy:** at most one retry on parse failure with a stricter "your previous output was invalid because X" suffix.

## Testing

| Layer | What | How |
|---|---|---|
| `lib/branch.ts` | regex behavior on edge inputs (control chars, dotdot, leading dash, `.lock`) | `bun test`, table-driven |
| `lib/issue.ts` | branch and commit-msg parsing across confidence levels | `bun test`, table-driven |
| `gh_pr_open_preflight.ts` | each guard + each JSON field | mock `git`/`gh` via `execFileSync` shim; assert exit codes and JSON shape |
| `gh_pr_open_execute.ts` | each branch in the decision matrix (created/updated/pushed-only) | mock `git`/`gh`; assert exact argv passed to each |
| `gh_watch_runs.ts` | terminal detection + timeout + state file shape | mock `gh pr checks` to return a sequence; assert exit conditions and state file content |
| Sub-agent prompt | output structure stability | small fixture suite of preflight JSONs → assertions on the JSON parser's success and required fields (no exact-prose assertions) |
| End-to-end | real flow against a fixture repo | integration test: clone a fixture repo, run `/stark-gh:pr-open` via Claude Code CLI, assert PR is created and watcher state file appears |

Tests live under `plugins/stark-gh/tools/__tests__/`. CI runs `bun test plugins/stark-gh`.

## Forward Compatibility

The components in v1 scaffold the rest of the family. Each future command reuses (rather than reimplements) `lib/` and `gh_watch_runs.ts`.

| Future command | Reuses | New tools (sketch) |
|---|---|---|
| `/stark-gh:merge` | `lib/{git,gh,branch}` | `gh_merge_preflight.ts`, `gh_merge_execute.ts`. Always rebases onto base; on conflict, the parent fans out one Sonnet sub-agent per conflicted file (parallel `Agent` calls), each receiving the file + both sides + surrounding context, returning resolved text. |
| `/stark-gh:merge-and-release` | `pr-open` watcher conventions; `merge` | composes `merge` with `/stark-release` post-merge |
| `/stark-gh:clean` | `lib/{git,gh}` | `gh_clean.ts` (delete merged-and-gone branches + prune worktrees) |
| `/stark-gh:fetch` | `lib/git` | `gh_fetch.ts` (fetch + ff-merge + prune) |
| `/stark-gh:workflow-run` | `gh_watch_runs.ts` directly | `gh_workflow_run.ts` (POST `actions.createWorkflowDispatch` via `gh api`) |

The shared `lib/` package + `gh_watch_runs.ts` are the spine of the family.

## Out of Scope (v1)

- Multi-commit splitting. Users who want atomic commits run `commit-commands:commit` first, then `/stark-gh:pr-open`.
- Reviewer/label suggestions from CODEOWNERS or labeler config.
- Confirmation step before posting (autonomous mode).
- Draft PRs.
- Updating existing-PR title or body when the user did not pass an override flag (avoids clobbering manual edits on GitHub).
- Multiple PR-template directory (`.github/PULL_REQUEST_TEMPLATE/`).
- Cross-repo PRs (forks → upstream).
- Reviewer/label/assignee *removal* on existing PRs (only additive: `--add-reviewer`/`--add-label`).

## Open Questions

None at design lock. Revisit during plan if a new constraint surfaces.
