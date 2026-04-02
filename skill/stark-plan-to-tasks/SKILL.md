---
name: stark-plan-to-tasks
description: >-
  Decompose spec/plan into phased GitHub issues with story points and risk labels. Use for plan to tasks, decompose plan.
argument-hint: "<path-to-spec> [--dry-run] [--cleanup <slug>]"
---

# stark-plan-to-tasks

Decompose a spec/design document into phased GitHub issues. Three LLM passes: quality gate → decomposition → validation. Extracts architectural knowledge to project docs, deletes the plan.

## Arguments

- `<path-to-spec>` — path to spec/plan markdown file (required, must be `.md`)
- `--dry-run` — run all three passes, preview issue payloads, write to `/tmp/stark-plan-to-tasks-preview-{plan-slug}.md`, stop before creating issues or modifying any files
- `--cleanup <plan-slug>` — find all issues with `plan:{slug}` label, list them, and offer to close with a "Cleaned up by stark-plan-to-tasks" comment

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

This skill uses only the `stark-claude` GitHub App (not all three like `stark-team-review`).

## Phase 1: Setup

Run all checks in this exact order. A failure at any check aborts before any LLM work begins.

### 1.1 Read plan file

```bash
cat "$PLAN_FILE"
```

- Fail if the file does not exist:
  > Error: Plan file not found: `{path}`
- Fail if the file is empty:
  > Error: Plan file is empty: `{path}`
- Fail if the extension is not `.md`:
  > Error: Expected a .md file, got: `{path}`

Set `PLAN_CONTENT` to the file contents. Set `PLAN_BASENAME` to the filename without path.

### 1.2 Detect target repo

Run these checks in order, stopping at the first match:

**1. Frontmatter scan** — look for `repo: org/name` in the plan's YAML frontmatter.

**2. Body scan** — scan plan body for `org/repo` patterns (e.g., `GetEvinced/widget-system`).

**3. git remote fallback:**
```bash
git remote -v
```
Prefer `origin`. If multiple remotes point to different orgs, warn:
> Warning: Multiple remotes found pointing to different orgs. Using `origin`. Verify this is correct.

**4. Ask user** — if all three fail:
> Could not detect target repo from plan frontmatter, body, or git remote. Enter `org/repo` (e.g., `GetEvinced/my-repo`):

**Checkout mismatch check:** After detection, parse the current checkout's remote URL and compare to the detected repo. If they differ:
> Warning: Detected target repo `{org}/{repo}` does not match current checkout (`{checkout-repo}`). Proceed anyway? [y/N]
Abort if the user says no.

Set `ORG`, `REPO`, and `ORG_REPO` (`{ORG}/{REPO}`) from the confirmed detection.

### 1.3 Verify gh CLI

```bash
which gh
```

Fail if not found:
> Error: `gh` CLI is not installed or not in PATH. Install it from https://cli.github.com before running this skill.

### 1.4 GitHub App auth

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Fail if this returns a non-zero exit code or empty token:
> Error: stark-claude GitHub App auth failed. Check that the STARK_CLAUDE_PRIVATE_KEY is present in macOS Keychain and the app is installed on `{ORG_REPO}`.

### 1.5 Repo access probe

```bash
GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO} --jq .permissions.push
```

- Fail if the API call returns 404:
  > Error: Repo `{ORG_REPO}` not found on GitHub. Check the org/repo name.
- Fail if `.permissions.push` is `false` or null:
  > Error: stark-claude does not have write access to `{ORG_REPO}`. Grant the app Issues + Labels write permissions and re-install on this repo.

### 1.6 Validation agent CLI check

Read `validation_agents` from config (standard hierarchy: global `~/.claude/code-review/config.json` → org `.code-review/config.json` → repo `.code-review/config.json`, repo overrides global). Default: `["codex"]`.

For each agent in `validation_agents`:

```bash
which {agent}   # e.g., which codex
```

Fail if not found:
> Error: Validation agent `{agent}` is configured but not installed (not found in PATH). Install it or update `validation_agents` in config before running.

### 1.7 Re-run detection

Derive `PLAN_SLUG` from the plan filename: strip the `.md` extension, strip known suffixes (`-design`, `-spec`, `-plan`). If the resulting slug exceeds 50 characters, truncate to 47 characters and append a 3-character hash suffix. E.g., `2026-03-18-widget-system-design.md` → `2026-03-18-widget-system`.

```bash
GH_TOKEN="$GH_TOKEN" gh issue list \
  --label "plan:{PLAN_SLUG}" \
  --repo {ORG_REPO} \
  --json number,title,state \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

If any issues are returned, display them and ask:
> Found {N} existing issue(s) with label `plan:{PLAN_SLUG}` on `{ORG_REPO}`:
> {list}
>
> How do you want to proceed?
> [s]kip — abort this run
> [u]pdate — re-patch existing issues (preserves issue numbers)
> [f]resh — create new issues alongside existing ones (may duplicate)

Do not proceed silently. Abort if the user chooses skip.

Set `RERUN_MODE` to `update`, `fresh`, or unset (first run).

### 1.8 Read target project docs tree

```bash
find {target-project-root}/docs -type f -name "*.md" 2>/dev/null | sort
```

Where `target-project-root` is derived from the current git checkout root (`git rev-parse --show-toplevel`). If the `docs/` directory doesn't exist, note it — it will be created in Step 6. Store the file list as `DOCS_TREE`.

### 1.9 Read target project existing labels

```bash
GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO}/labels \
  --paginate \
  --jq '.[].name'
```

Store as `EXISTING_LABELS`. This is used in Step 5 to determine which labels need to be created vs. already exist.

---

## Phase 2: Plan Quality Gate (Pass 1)

**This is an LLM pass — you are both the orchestrator and the evaluating agent.**

Evaluate the plan against the robustness checklist. This checks whether the plan has enough detail for decomposition into self-contained tasks — not whether the architecture is correct.

**Checklist:**

- **Completeness** — every component/feature mentioned has an implementation approach, not just a name
- **File paths** — concrete files/modules referenced, not vague "the backend" or "the API layer"
- **Decisions are made** — no unresolved forks ("we could do X or Y"); every decision has a chosen path
- **Dependencies are explicit** — what depends on what, what must exist before something else can be built
- **Boundaries are clear** — where one unit of work ends and another begins is unambiguous
- **Acceptance criteria exist** — for each feature/component, what "done" looks like
- **Edge cases and error handling** — addressed in the plan, not deferred
- **Security/performance constraints** — if relevant, stated explicitly

**Actions:**

- Present gaps as a structured report. Do NOT auto-fix the plan.
- Trivial clarifications may be suggested inline, but the user approves all changes.
- Re-read the plan from disk after user edits, re-validate. Max 3 validation cycles.
- After 3 cycles with remaining gaps, stop:
  > Quality gate failed after 3 rounds. Remaining gaps: {list}. Fix the plan and re-run.
- Proceed to Pass 2 only when the plan passes the checklist with no open gaps.

**Scope:** Do NOT challenge architectural decisions. Do NOT add scope. Do NOT infer implementation details.

---

## Phase 3: Decomposition (Pass 2)

**Large plan handling:** First identify all phases (names, descriptions, dependencies) in a single call. Then generate tasks one phase at a time.

**Phase identification:** Read the plan and identify natural phases — groups of work sharing a logical boundary, ordered by dependency.

Each phase:
- `phase_id` — stable slug, e.g., `phase-1-data-model`
- `name`, `description` (one line), `depends_on` (list of `phase_id`s)

**Task identification per phase:**

| Field | Notes |
|-------|-------|
| `task_id` | Stable slug, e.g., `task-1-1-user-entity` |
| `title` | Clear, imperative, scoped |
| `what` | Deliverable description |
| `why` | Context from the plan — must stand alone (plan gets deleted) |
| `where` | Specific files/modules to create or modify (max 4 files) |
| `how` | Implementation approach, key decisions already made (max 500 words) |
| `acceptance_criteria` | Testable conditions for "done" (max 5 items) |
| `dependencies` | Which `task_id`s must complete first |
| `review_hints` | Edge cases, security concerns, architectural constraints (max 5 bullets) |
| `type` | `feature`, `task`, or `bug` — see classification rules below |
| `story_points` | Fibonacci: 1, 2, 3, 5, 8, 13 |
| `risk` | `low`, `med`, `high` |
| `confidence` | `low`, `med`, `high` — LLM's self-assessed confidence the task is fully specified |
| `ai_suitability` | `autonomous`, `assisted`, `human-led` — see classification below |

**AI Suitability classification:** For each task, classify how suitable it is for AI agent implementation:

| Value | Meaning | Examples |
|-------|---------|----------|
| `autonomous` | Can be fully implemented by an AI agent without human intervention | CRUD endpoints, migrations, config changes, test scaffolding |
| `assisted` | Needs occasional human guidance or domain knowledge | Complex business logic, performance-sensitive code, security-critical paths |
| `human-led` | Requires significant human judgment, design decisions, or stakeholder input | UX decisions, cross-team coordination, vendor negotiations, compliance sign-offs |

Default to `assisted` if ambiguous. Use `autonomous` only when the task is well-specified with clear acceptance criteria and touches well-understood patterns. Use `human-led` when the task requires decisions not captured in the plan.

**Issue type classification:**

| Type | When to use | Label color |
|------|-------------|-------------|
| `feature` | New user-facing capability, new endpoint, new UI component — something that didn't exist before | `#1d76db` (blue) |
| `task` | Refactoring, migration, infrastructure, CI/CD, config changes, documentation — work that doesn't add new user-facing behavior | `#e4e669` (yellow) |
| `bug` | Fix for existing broken behavior identified in the plan — a defect called out as something to fix | `#e11d48` (red) |

Default to `task` if ambiguous. Use `feature` only when the task creates genuinely new functionality. Use `bug` only when the plan explicitly identifies broken existing behavior to fix.

**GitHub Issue Type mapping:** In addition to labels, set the native GitHub Issue Type on each issue via `--field type="{GH_ISSUE_TYPE}"`. Map the task `type` field to the GitHub Issue Type name:

| Task type | GitHub Issue Type (`--field type`) |
|-----------|-------------------------------------|
| `feature` | `Feature` |
| `task` | `Task` |
| `bug` | `Bug` |

**IMPORTANT:** Do NOT create or use `type:bug`, `type:feature`, or `type:task` labels. Use the built-in GitHub Issue Type field exclusively (`--field type="Bug"`). Labels and Types are separate concepts.

GitHub Issue Types are org-level. The GetEvinced org defines: Task, Bug, Feature. If the API call fails due to missing issue types, warn and continue without a type (do NOT fall back to type labels).

**Sizing guardrails:** If a task exceeds max 5 acceptance criteria, max 4 files, or max 500 words in `how` — split it. If a task has only 1 acceptance criterion and 1 file — consider merging. Recommend max 6-8 phases, max 8-10 tasks per phase. If exceeded, surface it as a signal the plan should be split.

**Output schema:** Write to a temp file:
```bash
TMPFILE="/tmp/stark-plan-to-tasks-${RANDOM}${RANDOM}.json" && touch "$TMPFILE" && chmod 600 "$TMPFILE"
```

Schema:
```json
{
  "schema_version": 1,
  "plan_hash": "sha256:{hash-of-plan-content-post-pass-1}",
  "phases": [
    {
      "phase_id": "phase-1-data-model",
      "name": "Data Model & Storage",
      "description": "Define entities, relationships, and persistence layer",
      "depends_on": [],
      "tasks": [
        {
          "task_id": "task-1-1-user-entity",
          "title": "Implement User entity with validation",
          "type": "feature",
          "what": "...",
          "why": "...",
          "where": ["src/models/user.py", "src/db/migrations/001_users.sql"],
          "how": "...",
          "acceptance_criteria": ["...", "..."],
          "dependencies": [],
          "review_hints": ["...", "..."],
          "story_points": 3,
          "risk": "low",
          "confidence": "high",
          "ai_suitability": "autonomous"
        }
      ]
    }
  ]
}
```

**Schema validation:** After generation, validate: all required fields present, `phase_id` and `task_id` are unique across the document, `dependencies` reference existing IDs, no circular dependencies. On failure, retry once with the error message appended to the prompt. If still invalid, halt.

**Plan hash:** Compute SHA-256 of the plan content after Pass 1 approval. Store in `plan_hash`.

---

## Phase 4: Validation (Pass 3 — separate agent)

**Plan integrity check:** Before dispatching, verify the plan file's current SHA-256 matches `plan_hash` in the breakdown JSON. If the plan changed since Pass 2:
> Warning: Plan file changed since decomposition. Re-running Pass 2.
Re-run Phase 3, then proceed.

**Dispatch:** Build the validation envelope:
```json
{
  "schema_version": 1,
  "plan_markdown": "{PLAN_CONTENT}",
  "breakdown": {breakdown-json},
  "plan_hash": "sha256:..."
}
```

Write to a temp file (`chmod 600`). Dispatch to each configured validation agent:

**Validation prompt:** Construct a prompt for the validation agent containing the full validation checklist (the 8 checks above). The prompt must instruct the agent to:
- Output ONLY a JSON object: `{"schema_version": 1, "approved": true/false, "issues": [{"phase_id": "...", "task_id": "...", "field": "...", "problem": "...", "suggestion": "..."}]}`
- If no issues found, return `{"schema_version": 1, "approved": true, "issues": []}`
- Be adversarial — try to break the decomposition

The prompt is embedded in the dispatch script at `$SCRIPTS/plan_to_tasks_validate.py` as the `VALIDATION_PROMPT` constant. To dispatch:

```bash
$PYTHON $SCRIPTS/plan_to_tasks_validate.py "$PLAN_FILE" "$BREAKDOWN_FILE" --timeout 300
```

This script handles envelope construction, agent dispatch, output normalization, and structured JSON output.

**Output normalization:**
- Codex: extract `agent_message` content from JSONL events
- Gemini: unwrap `{"response": "..."}`

After extraction, validate against the validation output schema. On malformed output, retry once with a stronger prompt. If still malformed, treat as validation failure.

**Validation checks the agent must perform:**
- **Coverage** — every requirement maps to at least one task
- **Self-containment** — each issue contains enough context to implement without reading other issues or the plan
- **Dependency correctness** — `task_id` links are accurate, no circular dependencies
- **No orphan knowledge** — plan content not covered by any task
- **Overlap** — two tasks describing the same work or touching the same files
- **Sizing** — any task exceeding guardrails (>5 criteria, >4 files, >500 words in `how`)
- **Review sufficiency** — review hints are specific, not generic
- **Metric sanity** — story points consistent across similar tasks, risk ratings aligned

**Multiple agents:** If both `codex` and `gemini` are configured and disagree, treat union of findings as the finding set.

**Resolution:**
- Fixable issues (missing context, incomplete criteria, wrong dependency link) → fix in breakdown, re-dispatch
- Structural issues (missed feature, phases in wrong order) → loop back to Phase 3 for that section
- Max 2 fix iterations. If not converged:
  > Validation failed to converge after 2 iterations. Remaining issues: {list}. Do NOT proceed to issue creation.
  Halt.

**If `--dry-run`:** After validation completes, write full issue preview to `/tmp/stark-plan-to-tasks-preview-{PLAN_SLUG}.md` and print a summary table to terminal. Stop here — do not proceed to Phase 5.

---

## Phase 5: GitHub Issue Creation

**Auth: use the user's PAT, not the bot.** Issues should appear as created by the user, not by `stark-claude[bot]`. Ensure `GH_TOKEN` is NOT set so `gh` uses native auth:

```bash
unset GH_TOKEN  # Use user's native gh auth for issue creation
```

**Label setup:** Auto-create all missing labels. Check against `EXISTING_LABELS` from Step 1.9:

```bash
gh label create "sp:3" --repo {ORG_REPO} --color "0075ca" --force
```

Labels to ensure exist:
- `sp:1`, `sp:2`, `sp:3`, `sp:5`, `sp:8`, `sp:13` (blue shades, graduated)
- `risk:low` (green, `#2cbe4e`), `risk:med` (yellow, `#e4e669`), `risk:high` (red, `#e11d48`)
- `confidence:low` (gray, `#8b949e`), `confidence:med` (gray, `#6e7681`), `confidence:high` (gray, `#484f58`)
- `stark-plan-to-tasks` (metadata, `#7057ff`)
- `plan:{PLAN_SLUG}` (traceability, `#0e8a16`)

Use `--force` — idempotent, updates description/color if the label already exists.

**Shell injection prevention:** Never interpolate LLM-generated content directly into shell commands. Write issue bodies to temp files (`chmod 600`) and use `--body-file`. Use `gh api` with `--field` for titles:

```bash
gh api /repos/{ORG}/{REPO}/issues \
  --method POST \
  --field title="$TITLE" \
  --field body="$(cat $BODY_FILE)" \
  --field labels='["sp:5","risk:med","confidence:high","stark-plan-to-tasks","plan:{PLAN_SLUG}"]' \
  --field type="{GH_ISSUE_TYPE}"
```

**Issue body length:** GitHub limit is 65,536 characters. Section caps in Phase 3 should prevent this. If a body still exceeds the limit, truncate with:
> Full detail available in the decomposition output.
Never split an issue — that's a decomposition change.

**Creation order (4 passes):**

1. Create all phase tracking issues first (to get issue numbers). Each contains phase name, description, depends_on phases, and a placeholder task checklist.
2. Create all task issues in dependency order within each phase. Use `[pending]` for the Dependencies section. Record `task_id → issue_number` mapping.
3. **Patch pass:** Update every task issue's Dependencies section with actual `#NNN` links using the mapping.
4. Update phase tracking issues with the final task checklist: `- [ ] #42 — {task title}`.

**Task issue body format:** See [references/issue-body-template.md](references/issue-body-template.md) for the full template (What, Why, Where, How, Acceptance Criteria, Dependencies, Review Hints, Non-Goals, Constraints, Rollout, Rollback, Artifacts, Verification).

**Run manifest:** After each successful issue creation, append `{task_id, issue_number, phase_id}` to the breakdown temp file's `_manifest` key. On re-run (from Step 1.7), cross-reference manifest with existing issues to skip already-created ones.

### 5.1 GitHub Projects Integration

See [references/github-projects-integration.md](references/github-projects-integration.md) for the full project integration protocol (config loading, auth, per-issue field setting, error handling).

---

## Phase 6: Knowledge Extraction & Doc Enrichment

**Dirty working tree check:** Before modifying any files:
```bash
git status --porcelain
```

If the plan file or any target doc files have uncommitted changes:
> Warning: Uncommitted changes detected in {files}. Commit or stash before running enrichment to avoid mixing unrelated changes. Continue anyway? [y/N]

Abort if the user says no.

**This is an LLM call.** Receive the plan content and `DOCS_TREE`. Output the content to write or append to each doc file. Conflicts with existing content: always append as a new section, never replace or merge into existing sections.

**Knowledge types and routing:**

| Knowledge type | Look for | Fallback if no match |
|----------------|----------|---------------------|
| Architectural decisions | `docs/adr/`, `docs/decisions/`, `docs/architecture/decisions/` | Create `docs/adr/NNN-{title}.md` (NNN = next sequential number in dir) |
| Data models / schemas | `docs/models/`, `docs/data/` | Create `docs/data-model.md` |
| Integration / API contracts | `docs/api/`, `docs/architecture/` | Create `docs/api.md` |
| Constraints | `docs/security.md`, `docs/performance.md` (by filename) | Create `docs/constraints.md` |
| Glossary terms | `docs/glossary.md`, `docs/GLOSSARY.md` (case-insensitive) | Create `docs/glossary.md` |

If the plan contains no extractable knowledge, skip doc enrichment. Still delete the plan — the knowledge lives in the issues.

**Decision record:** Append to `docs/decisions.md` (create with `# Decisions` header if missing):

```markdown
## {YYYY-MM-DD} — {Plan Title}

- **Date:** {date}
- **Status:** Decomposed → issues created
- **Tracking:** #{phase-issue-numbers}
- **Story Points:** {total} total ({N} tasks across {P} phases)
- **Summary:** {2-3 sentence summary of the plan's key decisions}
- **Knowledge extracted to:** {list of files written/updated}
```

**After enrichment:**

```bash
# Delete the plan file
rm "{PLAN_FILE}"

# Commit: add specific files only — never git add -A
git add docs/decisions.md {enriched-doc-files} {created-doc-files}
git rm "{PLAN_FILE}"
git commit -m "docs: extract knowledge from plan, create tasks (#{phase-issue-numbers})"
```

The commit is local-only. Do not push or create a PR.

If the commit fails (pre-commit hook, dirty tree):
> Warning: Commit failed. Plan file NOT deleted. Enrichment files left unstaged for your review.
Leave all changes unstaged — do not force the commit.

---

## Phase 7: Summary

Print to terminal:
- Number of phases created
- Total issues created
- Total story points
- Risk distribution (e.g., 3 low, 5 med, 1 high)
- Confidence distribution
- Links to each phase tracking issue (`{ORG_REPO}#NNN — {phase name}`)

Clean up temp files (decomposition JSON, validation envelope, any preview files).

**Metrics persistence:** Append to `~/.claude/code-review/logs/stark-plan-to-tasks.jsonl`:

```json
{
  "schema_version": 1,
  "skill": "stark-plan-to-tasks",
  "duration_seconds": 142,
  "plan_file": "{PLAN_FILE}",
  "target_repo": "{ORG_REPO}",
  "pass_1_duration_seconds": 28,
  "pass_1_gaps_flagged": 3,
  "pass_1_user_prompts": 1,
  "pass_2_duration_seconds": 45,
  "pass_3_duration_seconds": 32,
  "pass_3_agents": ["codex"],
  "pass_3_fix_iterations": 1,
  "phases_created": 4,
  "issues_created": 12,
  "labels_created": 8,
  "total_story_points": 47,
  "risk_distribution": {"low": 5, "med": 6, "high": 1},
  "confidence_distribution": {"low": 1, "med": 3, "high": 8},
  "knowledge_files_written": 3,
  "knowledge_files_updated": 1,
  "decision_record_appended": true,
  "plan_deleted": true,
  "dry_run": false
}
```

---

## Observability

Follows the Skill Observability Protocol. TaskCreate per step with `activeForm` spinner text, timestamped log lines, and 5-minute checkpoints for large plans.

## Mistakes to Avoid

- Don't use `git add -A` for the enrichment commit — add specific files by name.
- Don't delete the plan file before all issues are successfully created.
- Don't create issues without error handling — if issue 8 of 15 fails, track partial state in run manifest.
- Don't use comma-separated `--label` values — use separate `--field labels` entries or a JSON array.
- Don't auto-fix the plan in Pass 1 — flag gaps, let the architect fix them.
- Don't keep the decomposition JSON only in memory — write to temp file with `chmod 600`.
- Don't proceed to issue creation if Pass 3 validation didn't converge — halt and ask.
- Don't interpolate LLM-generated text into shell commands — use `gh api --field` or `--body-file`.
- Don't reference Step 6 docs from Step 5 issue bodies — those docs don't exist yet.
- Don't use positional indexes for task references — use stable `task_id` and `phase_id`.
- Don't create labels one at a time without `--force` — the flag is idempotent and avoids duplicate errors.

## Failure Modes

See [references/failure-modes.md](references/failure-modes.md) for the full recovery table.

## What This Skill Does NOT Do

- Challenge architectural decisions (those were validated during brainstorming)
- Add scope beyond what the plan describes
- Assign issues to people or agents
- Kick off implementation (execution is a separate concern)
- Create GitHub Projects or milestones (but integrates with existing projects via `.github/project-config.json`)
- Supplement weak plans with external research — if the plan is insufficient, it stops and asks

## Edge Cases

- **Plan references no repo** — fall back to `git remote -v`. If that also fails, ask the user.
- **Plan is too vague for any decomposition** — Pass 1 will flag this. If the plan can't pass the checklist after 3 rounds, stop.
- **Target repo has no docs/ directory** — create `docs/` with minimal structure during knowledge extraction.
- **Very large plan (20+ tasks)** — handled by per-phase task generation. Guardrails recommend max 6-8 phases × 8-10 tasks; exceeding this signals the plan should be split.
- **Plan contains no extractable knowledge** — skip Phase 6 doc enrichment, still delete the plan.
- **Detected repo doesn't match current checkout** — warn and ask user.
- **Multiple git remotes** — prefer `origin`, warn if multiple remotes point to different orgs.
