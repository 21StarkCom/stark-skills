---
name: stark-plan-to-tasks
description: >-
  Decompose spec/plan into phased GitHub issues with story points and risk labels. Use for plan to tasks, decompose plan.
argument-hint: "<path-to-spec> [--dry-run] [--cleanup <slug>] [--agents codex,gemini]"
disable-model-invocation: true
context: fork
model: opus
revision: e504ba02a12b6dd779ebd026fa4c07df76697ff2
revision_date: 2026-05-15T18:20:11Z
---

# stark-plan-to-tasks

Decompose a spec/design document into phased GitHub issues. Three LLM passes: quality gate → decomposition → validation. Extracts architectural knowledge to project docs.

## Arguments

- `<path-to-spec>` — path to spec/plan markdown file (required, must be `.md`)
- `--dry-run` — run all three passes, preview issue payloads, write to `/tmp/stark-plan-to-tasks-preview-{plan-slug}.md`, stop before creating issues or modifying files
- `--cleanup <plan-slug>` — find all issues with `plan:{slug}` label, list them, and offer to close with a "Cleaned up by stark-plan-to-tasks" comment
- `--agents <list>` — comma-separated subset of `codex`, `gemini` for the Pass 3 validation agent. Overrides `validation_agents` from config (default: `codex`). Pass 1 (quality gate) and Pass 2 (decomposition) are always run by Claude as orchestrator and are not affected by this flag.

**Raw input:** `$ARGUMENTS`

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
```

This skill uses only the `stark-claude` GitHub App.

## Phase 1: Setup

Run all checks in this exact order. Any failure aborts before LLM work begins.

### 1.1 Read plan file

Read the file. Fail with descriptive error if not found, empty, or not `.md`. Set `PLAN_CONTENT` and `PLAN_BASENAME`.

### 1.2 Detect target repo

In order, stopping at first match:
1. **Frontmatter** — look for `repo: org/name` in YAML frontmatter.
2. **Body scan** — scan for `org/repo` patterns (e.g., `GetEvinced/widget-system`).
3. **git remote fallback:** `git remote -v` — prefer `origin`. Warn if multiple remotes point to different orgs.
4. **Ask user** if all three fail.

**Checkout mismatch check:** After detection, if resolved repo differs from current checkout's remote, warn and ask to proceed. Abort if user says no.

Set `ORG`, `REPO`, `ORG_REPO`.

### 1.3 Verify gh CLI

`which gh` — fail with install URL if not found.

### 1.4 GitHub App auth

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Fail if non-zero exit or empty token. Check that key `STARK_CLAUDE_PRIVATE_KEY` is in macOS Keychain and app is installed on `{ORG_REPO}`.

### 1.5 Repo access probe

`GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO} > /dev/null` — 200: proceed; 404: repo not found or app not installed; 403: app lacks permissions. Do NOT inspect `.permissions.push` — always false for App tokens.

### 1.6 Validation agent CLI check

Parse `$ARGUMENTS` for `--agents <list>`. If supplied, validate each entry is one of `codex`, `gemini` (Claude is the orchestrator and not a valid Pass 3 agent); abort with a clear error on any unknown name. Store the normalized list in `$VALIDATION_AGENTS`.

If `--agents` was not supplied, read `validation_agents` from config hierarchy (global → org → repo). Default: `["codex"]`.

Verify each resolved agent is in PATH. Fail with install instructions if missing.

### 1.7 Re-run detection

Derive `PLAN_SLUG` from filename: strip `.md`, strip trailing `-design`/`-spec`/`-plan`. Truncate to 47 chars + 3-char hash if > 50 chars. Query `gh issue list --label "plan:{PLAN_SLUG}" --repo {ORG_REPO} --json number,title,state`. If issues found, display them and ask: [s]kip / [u]pdate / [f]resh. Abort if user skips. Set `RERUN_MODE`.

### 1.8 Read target project docs tree

`find {target-project-root}/docs -type f -name "*.md" 2>/dev/null | sort`. Store as `DOCS_TREE`.

### 1.9 Read target project existing labels

`GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO}/labels --paginate --jq '.[].name'`. Store as `EXISTING_LABELS`.

---

## Phase 2: Plan Quality Gate (Pass 1)

**You are both orchestrator and evaluating agent.** Evaluate the plan against the robustness checklist — whether it has enough detail for self-contained task decomposition (not whether the architecture is correct).

**Checklist:** Completeness, File paths (concrete files referenced), Decisions made (no unresolved forks), Dependencies explicit, Boundaries clear, Acceptance criteria exist, Edge cases/error handling addressed, Security/performance constraints stated.

- Present gaps as a structured report. Do NOT auto-fix the plan.
- Suggest trivial clarifications inline; user approves all changes.
- Re-read from disk after edits. Max 3 validation cycles. If gaps remain after 3 rounds → stop.
- Only proceed to Pass 2 when checklist passes with no open gaps.
- **Do NOT challenge architectural decisions, add scope, or infer implementation details.**

---

## Phase 3: Decomposition (Pass 2)

**Identify phases first** (all at once): `phase_id` (slug), `name`, `description` (one line), `depends_on`. Then generate tasks one phase at a time.

**Per-task fields:**

| Field | Notes |
|-------|-------|
| `task_id` | Stable slug, e.g., `task-1-1-user-entity` |
| `title` | Clear, imperative, scoped |
| `what` | Deliverable description |
| `why` | Context — must stand alone without the plan |
| `where` | Specific files/modules to create or modify (max 4) |
| `how` | Implementation approach (max 500 words) |
| `acceptance_criteria` | Testable conditions for "done" (max 5) |
| `dependencies` | `task_id`s that must complete first |
| `review_hints` | Edge cases, security concerns, constraints (max 5 bullets) |
| `type` | `feature`, `task`, or `bug` (see classification below) |
| `story_points` | Fibonacci: 1, 2, 3, 5, 8, 13 |
| `risk` | `low`, `med`, `high` |
| `confidence` | `low`, `med`, `high` — self-assessed |
| `ai_suitability` | `autonomous`, `assisted`, `human-led` (see below) |

**AI Suitability:** `autonomous` = well-specified, clear criteria, standard patterns (CRUD, config, migrations). `assisted` = complex logic, performance-sensitive, security-critical. `human-led` = requires judgment not captured in plan (UX decisions, compliance). Default to `assisted` if ambiguous.

**Issue type:** `feature` = new user-facing capability; `task` = refactoring/infra/config/docs; `bug` = fix for explicitly identified broken behavior. Default to `task` if ambiguous.

**GitHub Issue Type:** Map `feature→Feature`, `task→Task`, `bug→Bug` via `--field type="{GH_ISSUE_TYPE}"`. Do NOT use `type:bug`/`type:feature`/`type:task` labels — use the native GitHub Issue Type field exclusively. If API call fails due to missing types, warn and continue without type (no label fallback).

**Sizing guardrails:** Split if > 5 criteria, > 4 files, or > 500 words in `how`. Merge if only 1 criterion and 1 file. Max 6–8 phases, 8–10 tasks per phase — exceeding this signals the plan should be split.

**Output:** Write to `TMPFILE="/tmp/stark-plan-to-tasks-${RANDOM}${RANDOM}.json"` (`chmod 600`):

```json
{
  "schema_version": 1,
  "plan_hash": "sha256:{hash-of-plan-content-post-pass-1}",
  "phases": [
    {
      "phase_id": "phase-1-data-model",
      "name": "Data Model & Storage",
      "description": "...",
      "depends_on": [],
      "tasks": [{
        "task_id": "task-1-1-user-entity",
        "title": "...", "type": "feature",
        "what": "...", "why": "...",
        "where": ["src/models/user.py"],
        "how": "...",
        "acceptance_criteria": ["..."],
        "dependencies": [],
        "review_hints": ["..."],
        "story_points": 3, "risk": "low", "confidence": "high", "ai_suitability": "autonomous"
      }]
    }
  ]
}
```

Validate: all required fields, unique `phase_id` and `task_id`, no circular dependencies. Retry once on failure. If still invalid → halt. Compute `plan_hash` as SHA-256 of post-Pass-1 plan content.

---

## Phase 4: Validation (Pass 3 — separate agent)

Verify plan file SHA-256 still matches `plan_hash`. If changed → re-run Phase 3.

Build validation envelope JSON (plan_markdown + breakdown + plan_hash), write to temp file (`chmod 600`). Dispatch:

```bash
agents_args=()
[ -n "${VALIDATION_AGENTS:-}" ] && agents_args=(--agents "$VALIDATION_AGENTS")
$PYTHON $SCRIPTS/plan_to_tasks_validate.py "$PLAN_FILE" "$BREAKDOWN_FILE" --timeout 300 "${agents_args[@]}"
```

This script handles envelope construction, agent dispatch (uses `--agents` when supplied, otherwise falls back to configured `validation_agents`), output normalization, and structured JSON output. Expect output: `{"schema_version": 1, "approved": true|false, "issues": [...]}`. If malformed, retry once with stronger prompt. If still malformed → treat as validation failure.

**Validation checks:** Coverage (all requirements have tasks), self-containment (each issue stands alone), dependency correctness (no circular deps, no orphan knowledge), overlap, sizing, review sufficiency, metric sanity.

**Multiple agents:** If codex and gemini disagree, take the union of findings.

**Resolution:** Fixable issues → fix in breakdown, re-dispatch. Structural issues → loop back to Phase 3 for that section. Max 2 iterations. If not converged → halt.

**If `--dry-run`:** Write full issue preview to `/tmp/stark-plan-to-tasks-preview-{PLAN_SLUG}.md`, print summary table. Stop here.

---

## Phase 5: GitHub Issue Creation

```bash
unset GH_TOKEN  # Use user's native gh auth for issue creation
```

**Label setup:** Auto-create missing labels with `gh label create ... --force` (idempotent):
- `sp:1`–`sp:13` (blue shades), `risk:low/med/high`, `confidence:low/med/high`, `stark-plan-to-tasks` (`#7057ff`), `plan:{PLAN_SLUG}` (`#0e8a16`)

> **Warning:** Never interpolate LLM-generated content into shell commands. Write issue bodies to temp files (`chmod 600`) and use `gh api --field body="$(cat $BODY_FILE)"` or `--field` for titles.

**Creation order (4 passes):**
1. Create all phase tracking issues (get issue numbers).
2. Create all task issues in dependency order. Use `[pending]` for Dependencies. Record `task_id → issue_number` mapping.
3. Patch pass: update each task's Dependencies section with `#NNN` links.
4. Update phase tracking issues with final task checklist: `- [ ] #42 — {task title}`.

GitHub limit: 65,536 chars per body. If exceeded, truncate with "Full detail available in decomposition output." Never split an issue.

Task issue body format: see [references/issue-body-template.md](references/issue-body-template.md).

**Run manifest:** Append `{task_id, issue_number, phase_id}` after each successful creation. On re-run, cross-reference manifest to skip already-created issues.

### 5.1 GitHub Projects Integration

See [references/github-projects-integration.md](references/github-projects-integration.md) for the full project integration protocol.

---

## Phase 6: Knowledge Extraction & Doc Enrichment

**Dirty working tree check:** `git status --porcelain`. If plan file or target doc files have uncommitted changes → warn and ask. Abort if user says no.

**This is an LLM call.** Receive plan content and `DOCS_TREE`. Output content to write/append to doc files. Always append as new section — never replace or merge existing sections.

**Knowledge routing:**

| Knowledge type | Target location | Fallback |
|----------------|-----------------|---------- |
| Architectural decisions | `docs/adr/`, `docs/decisions/`, `docs/architecture/decisions/` | Create `docs/adr/NNN-{title}.md` |
| Data models / schemas | `docs/models/`, `docs/data/` | Create `docs/data-model.md` |
| Integration / API contracts | `docs/api/`, `docs/architecture/` | Create `docs/api.md` |
| Constraints | `docs/security.md`, `docs/performance.md` (by filename) | Create `docs/constraints.md` |
| Glossary terms | `docs/glossary.md`, `docs/GLOSSARY.md` | Create `docs/glossary.md` |

If the plan contains no extractable knowledge, skip Phase 6 entirely.

Append to `docs/decisions.md` (create with `# Decisions` if missing):
```markdown
## {YYYY-MM-DD} — {Plan Title}
- **Date:** {date}
- **Status:** Decomposed → issues created
- **Tracking:** #{phase-issue-numbers}
- **Story Points:** {total} total ({N} tasks across {P} phases)
- **Summary:** {2-3 sentence summary of key decisions}
- **Knowledge extracted to:** {list of files}
```

After enrichment: `git add docs/decisions.md {enriched-doc-files}` (specific files only, never `-A`) and `git commit -m "docs: extract knowledge from plan, create tasks (#{phase-issue-numbers})"`. Local-only commit. Do NOT push. Do NOT delete the plan file.

If commit fails: warn, leave changes unstaged.

---

## Phase 7: Summary

Print: phases/issues/story points created, risk/confidence/AI suitability distributions, links to phase tracking issues, ready-to-use autopilot command.

Append to `~/.claude/code-review/logs/stark-plan-to-tasks.jsonl`:
```json
{
  "schema_version": 1, "skill": "stark-plan-to-tasks",
  "duration_seconds": 142, "plan_file": "...", "target_repo": "...",
  "pass_1_duration_seconds": 28, "pass_1_gaps_flagged": 3, "pass_1_user_prompts": 1,
  "pass_2_duration_seconds": 45, "pass_3_duration_seconds": 32,
  "pass_3_agents": ["codex"], "pass_3_fix_iterations": 1,
  "phases_created": 4, "issues_created": 12, "labels_created": 8,
  "total_story_points": 47,
  "risk_distribution": {"low":5,"med":6,"high":1},
  "confidence_distribution": {"low":1,"med":3,"high":8},
  "knowledge_files_written": 3, "knowledge_files_updated": 1,
  "decision_record_appended": true, "plan_preserved": true, "dry_run": false
}
```

Clean up temp files (decomposition JSON, validation envelope, preview files).

---

## Observability

Standard observability: create task per step with `activeForm` spinner text, timestamped log lines, 5-minute checkpoints for large plans. Emit completion event via `emit_queue.py`.

## What This Skill Does NOT Do

- Challenge architectural decisions
- Add scope beyond the plan
- Assign issues to people or agents
- Kick off implementation (prints `/stark-autopilot` command instead)
- Create GitHub Projects or milestones
- Supplement weak plans with external research

## Edge Cases

- **Plan references no repo** — fall back to `git remote -v`. If that fails, ask the user.
- **Plan too vague** — Pass 1 will flag this. Stops after 3 rounds.
- **No `docs/` directory** — create it with minimal structure during Phase 6.
- **Very large plan** — guardrails recommend max 6–8 phases × 8–10 tasks; exceeding signals the plan should be split.
- **Detected repo doesn't match checkout** — warn and ask user.
- **Multiple git remotes** — prefer `origin`, warn if pointing to different orgs.

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.
