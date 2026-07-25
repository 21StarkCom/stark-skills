---
name: stark-plan-to-tasks
description: >-
  Decompose spec/plan into phased GitHub issues with story points and risk labels. Use for plan to tasks, decompose plan.
argument-hint: "<path-to-spec> [--plan-slug <slug>] [--dry-run] [--cleanup <slug>] [--agents codex,gemini]"
disable-model-invocation: true
context: fork
model: opus
revision: 7d4eb375d131624ff59927945d448856858d621c
revision_date: 2026-05-18T16:33:25Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-plan-to-tasks

Decompose a spec/design document into phased GitHub issues. Three LLM passes: quality gate → decomposition → validation. Extracts architectural knowledge to project docs.

## Arguments

- `<path-to-spec>` — path to spec/plan markdown file (required, must be `.md`)
- `--plan-slug <slug>` — the plan-scoped slug to stamp on every created issue and to key the dedup pre-check by. **When `/stark-forge` invokes this skill, it always passes the slug `stark-spec-to-plan` recorded** (spec §4 SSOT — see `standards/stage-completion-line.md`) — never re-derive it from the plan filename in that case; it is threaded identically on the first run and on a crash-reentry re-run, so the dedup identity can't drift between them. When absent (a standalone, non-forge run), fall back to deriving it from the filename as in Phase 1.7 below. Must match the threaded-artifact-token grammar `^[A-Za-z0-9._:=/][A-Za-z0-9._:=/-]*$`.
- `--dry-run` — run all three passes, preview issue payloads, write to `/tmp/stark-plan-to-tasks-preview-{plan-slug}.md`, stop before creating issues or modifying files
- `--cleanup <plan-slug>` — find all issues with `plan:{slug}` label, list them, and offer to close with a "Cleaned up by stark-plan-to-tasks" comment
- `--agents <list>` — comma-separated subset of `codex`, `gemini` for the Pass 3 validation agent. Overrides `validation_agents` from config (default: `codex`). Pass 1 (quality gate) and Pass 2 (decomposition) are always run by Claude as orchestrator and are not affected by this flag.

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
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
export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)
```

Fail if non-zero exit or empty token. Check that key `STARK_CLAUDE_PRIVATE_KEY` is in macOS Keychain and app is installed on `{ORG_REPO}`.

### 1.5 Repo access probe

`GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO} > /dev/null` — 200: proceed; 404: repo not found or app not installed; 403: app lacks permissions. Do NOT inspect `.permissions.push` — always false for App tokens.

### 1.6 Validation agent CLI check

Parse `$ARGUMENTS` for `--agents <list>`. If supplied, validate each entry is one of `codex`, `gemini` (Claude is the orchestrator and not a valid Pass 3 agent); abort with a clear error on any unknown name. Store the normalized list in `$VALIDATION_AGENTS`.

If `--agents` was not supplied, read `validation_agents` from config hierarchy (global → org → repo). Default: `["codex"]`.

Verify each resolved agent is in PATH. Fail with install instructions if missing.

### 1.7 Re-run detection

**Resolve `PLAN_SLUG`:** if `--plan-slug` was supplied, validate it against the threaded-artifact-token grammar `^[A-Za-z0-9._:=/][A-Za-z0-9._:=/-]*$` (abort with a clear error if it doesn't match), then use it verbatim — it is the value `stark-spec-to-plan` recorded (spec §4 SSOT), consumed here, never re-derived. Otherwise (standalone, non-forge run) derive it from the filename: strip `.md`, strip trailing `-design`/`-spec`/`-plan`. Truncate to 47 chars + 3-char hash if > 50 chars. This filename-derivation path is the fallback ONLY — under `/stark-forge` the slug always arrives via `--plan-slug`.

Query `gh issue list --label "plan:{PLAN_SLUG}" --repo {ORG_REPO} --json number,title,state`. If issues found, display them and ask: [s]kip / [u]pdate / [f]resh. Abort if user skips. Set `RERUN_MODE`.

### 1.8 Read target project docs tree

`find {target-project-root}/docs -type f -name "*.md" 2>/dev/null | sort`. Store as `DOCS_TREE`.

### 1.9 Read target project existing labels

`GH_TOKEN="$GH_TOKEN" gh api /repos/{ORG}/{REPO}/labels --paginate --jq '.[].name'`. Store as `EXISTING_LABELS`.

---

## Phase 2: Plan Quality Gate (Pass 1)

**You are both orchestrator and evaluating agent.** Evaluate the plan against the robustness checklist — whether it has enough detail for self-contained task decomposition (not whether the architecture is correct).

### 2.1 Scope check (run first, before checklist)

Is the plan really one cohesive piece of work, or does it bundle multiple independent subsystems that each produce working software on their own? Signals it should be split:

- Two or more clearly orthogonal surfaces (e.g., "new ingestion pipeline AND new dashboard AND new auth flow")
- Total scope obviously exceeds 6–8 phases × 8–10 tasks before you start
- Disjoint dependency islands (sections that share no acceptance criteria with each other)

If split is warranted, stop here and tell the user: "This plan looks like N separate plans. Recommend splitting into: A / B / C — each producing standalone deliverables. Re-run me on each." Do not proceed to decomposition.

### 2.2 Robustness checklist

**Checklist:** Completeness, File paths (concrete files referenced), Decisions made (no unresolved forks), Dependencies explicit, Boundaries clear, Acceptance criteria exist, Edge cases/error handling addressed, Security/performance constraints stated.

**Scope-match, don't demand ceremony.** This gate checks the plan is *decomposable*, not that it's *production-hardened*. Most of these plans are single-user, playground-scoped tools (one operator, a laptop, no fleet, no SLA). When the plan declares that scope, the **absence** of security/performance hardening, error-recovery machinery, rollback procedures, or monitoring is **correct, not a gap** — do not flag it. "Edge cases / Security / performance" are satisfied by whatever the plan's actual scope warrants (often "n/a — single-user local tool"); only flag them as gaps when the plan takes on real external users, shared state, or cloud infra and then leaves the concern undefined. Never turn this gate into a demand for platform machinery the plan didn't scope.

### 2.3 No-Placeholders canon (auto-reject)

Any of these in the plan is a Pass 1 failure — flag them as gaps regardless of the rest of the checklist:

| Anti-pattern | Why it fails |
|---|---|
| `TBD`, `TODO`, `[fill in]`, "implement later" | Decision deferred — decomposition can't be self-contained |
| "Add appropriate error handling" / "handle edge cases" / "add validation" | No spec for what's appropriate — implementer guesses |
| "Similar to X above" / "Same pattern as Task N" | Implementer may read out of order; repeat the substance |
| "Write tests for the above" (without naming what to test) | Test scope is the spec; missing scope = missing tests |
| "We'll figure out X during implementation" | That's where decomposition belongs, not after |
| Method/type names referenced but never defined | Forces guesswork at issue-creation time |

- Present gaps (checklist + canon violations) as a structured report. Do NOT auto-fix the plan.
- Suggest trivial clarifications inline; user approves all changes.
- Re-read from disk after edits. Max 3 validation cycles. If gaps remain after 3 rounds → stop.
- Only proceed to Pass 2 when checklist passes with no open gaps and no canon violations.
- **Do NOT challenge architectural decisions, add scope, or infer implementation details.**

---

## Phase 3: Decomposition (Pass 2)

### 3.1 File map (lock decomposition boundaries first)

Before identifying phases, enumerate **every file** the plan will create or modify, across all the work. For each: one-line responsibility ("owns X", "extends Y"). The point is to surface boundary collisions and over-broad files *before* fragmenting them across tasks — once tasks exist, you can't easily see overlap.

Output as a single table:

| Path | Status | Responsibility |
|---|---|---|
| `src/foo/bar.ts` | create | Owns parsing of … |
| `src/foo/baz.ts` | modify | Add `parseX` to existing export surface |

Guardrails:
- A single file appearing across > 3 tasks is a smell — split the file or split the work.
- Two tasks both creating the same file → merge them or split the file into two.
- Use these boundaries to decide phase splits.

### 3.2 Phase + task generation

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

**Scope guardrail — decompose the plan, don't inflate it.** Every task must trace to work the plan actually specifies. Do **not** manufacture tasks the plan didn't ask for — rollback/recovery, monitoring/alerting/retention jobs, cloud-infra provisioning the plan doesn't deploy, credential rotation, migration/backfill frameworks, an E2E/load-test pyramid, or adversarial-input hardening — for a single-user playground tool. If the plan doesn't contain it, there is no task for it. Inventing hardening tasks is exactly the bloat that wastes the executor's time and tokens downstream.

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
        "where": ["src/models/user.ts"],
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

## Phase 3.5: Self-Review (cheap pre-Pass-3 filter)

Before paying for an external validation agent, **you** review your own decomposition against three deterministic checks. Catches the easy issues for free. This is not a substitute for Pass 3 — it just lets Pass 3 focus on what only an outside eye can spot.

### 3.5.1 Spec coverage

Walk every section/requirement of the post-Pass-1 plan. For each, point to at least one `task_id` that implements it. List unmapped requirements explicitly. If any → add tasks (or fold into existing) before Pass 3.

### 3.5.2 Placeholder scan

Re-run the Phase 2 No-Placeholders canon against the **breakdown JSON** (titles, `what`, `why`, `how`, `acceptance_criteria`, `review_hints`). The canon applies just as hard to the decomposition as to the plan. Any hit → fix in-place before Pass 3.

### 3.5.3 Type/name consistency

Scan the breakdown for cross-task references: types, function names, file paths, environment variables, API endpoints, label names. A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a real bug — implementers will build the wrong thing. Build a quick symbol → first-defining-task index; any mismatch → reconcile in-place.

If any of the three checks finds issues, fix them in the breakdown JSON and re-validate the JSON schema. **Do not** loop on self-review — one pass only. Then proceed to Phase 4.

---

## Phase 4: Validation (Pass 3 — separate agent)

Verify plan file SHA-256 still matches `plan_hash`. If changed → re-run Phase 3.

Build validation envelope JSON (plan_markdown + breakdown + plan_hash), write to temp file (`chmod 600`). Dispatch:

```bash
agents_args=()
[ -n "${VALIDATION_AGENTS:-}" ] && agents_args=(--agents "$VALIDATION_AGENTS")
node --experimental-strip-types --no-warnings "$TOOLS/plan_to_tasks_validate.ts" "$PLAN_FILE" "$BREAKDOWN_FILE" --timeout 300 "${agents_args[@]}"
```

This script handles envelope construction, agent dispatch (uses `--agents` when supplied, otherwise falls back to configured `validation_agents`), output normalization, and structured JSON output. Expect output: `{"schema_version": 1, "approved": true|false, "issues": [...]}`. If malformed, retry once with stronger prompt. If still malformed → treat as validation failure.

**Validation checks:** Coverage (all requirements have tasks), self-containment (each issue stands alone), dependency correctness (no circular deps, no orphan knowledge), overlap, sizing, review sufficiency, metric sanity, **cross-task name/type consistency** (a method/type/path/env-var named differently across tasks is a bug — implementers will build the wrong thing).

**Calibration:** Only flag issues that would cause real problems during implementation — an implementer building the wrong thing, getting stuck, or shipping a bug. Minor wording, stylistic preferences, and "nice to have" suggestions are not issues. Approve unless there are serious gaps: missing requirements, contradictory steps, placeholder content, vague tasks, or cross-task name/type mismatches.

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

**Dedup pre-check (BLOCKING BUILD GATE — do this before creating anything):** fetch this plan's existing issues **once**:

```bash
GH_TOKEN="$GH_TOKEN" gh issue list --label "plan:${PLAN_SLUG}" --repo "$ORG_REPO" --state all --json number,title,body > "$EXISTING_ISSUES_FILE"
```

Write the Phase 3 task breakdown's tasks (`{task_id, title, phase_id}` per task) to `$PLANNED_TASKS_FILE`, then call the dedup helper:

```bash
node --experimental-strip-types "$TOOLS/plan_to_tasks_dedup.ts" \
  --plan-slug "$PLAN_SLUG" \
  --existing-issues-file "$EXISTING_ISSUES_FILE" \
  --planned-tasks-file "$PLANNED_TASKS_FILE"
```

This prints `{"toCreate": [...], "toSkip": [...], "issueNumbers": [...]}`. `toSkip` entries are tasks a prior (crashed) run already created for **this exact `plan_slug`** — identified by an **exact marker match**, never a title match, so a same-titled task from a different plan is unaffected (`tools/plan_to_tasks_dedup_lib.ts` is the tested decision logic — see its test file for the false-positive guard). Only create issues for `toCreate`; for `toSkip` entries, reuse the reported `issue_number` as if it had just been created (dependency links, phase checklists, etc. all resolve the same way).

**Creation order (4 passes):**
1. Create all phase tracking issues (get issue numbers).
2. Create task issues for `toCreate` only, in dependency order. Use `[pending]` for Dependencies. Stamp every created task issue's body with its marker (`<!-- stark-task: {PLAN_SLUG}/{task_id} -->` — `tools/plan_to_tasks_dedup_lib.ts::buildTaskMarker`), appended after the template in [references/issue-body-template.md](references/issue-body-template.md). Record `task_id → issue_number` for every task (both freshly created and `toSkip`-reused).
3. Patch pass: update each task's Dependencies section with `#NNN` links.
4. Update phase tracking issues with final task checklist: `- [ ] #42 — {task title}`.

GitHub limit: 65,536 chars per body. If exceeded, truncate with "Full detail available in decomposition output." Never split an issue.

**Dedup mechanism — single source of truth:** the per-task marker stamped into each issue's body, checked via the exact-match pre-check above, is the ONLY re-run-safety mechanism this skill uses. There is no separate run-manifest file — an unwritten "run manifest" promise previously lived here with no path or format ever specified; it is removed rather than left as a second, unimplemented dedup story.

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

Print: phases/issues/story points created, risk/confidence/AI suitability distributions, links to phase tracking issues.

Compute `ISSUE_NUMBERS` — the array of every issue this plan now has: those actually created this run, plus every `toSkip` issue number the dedup pre-check reported (so a resumed run reports the complete set, not just what it freshly created). Use `tools/plan_to_tasks_dedup_lib.ts::mergeIssueNumbers(toSkip_numbers, created_this_run_numbers)`.

### Execution handoff

End the summary with an explicit two-option framing. Do not just dump the `/stark-copilot` command — make the user's next move a choice:

```
Phase tracking issues created. Two execution paths:

  1. Autonomous (recommended) — lead/wing implementation:
     /stark-copilot --plan-slug {PLAN_SLUG}

  2. Manual — work issues yourself, in any order respecting dependencies:
     gh issue list --label "plan:{PLAN_SLUG}" --repo {ORG_REPO}

Which approach?
```

Don't loop on the answer — present, then exit. The user picks up from here.

**Completion line (`standards/stage-completion-line.md`).** As the literal last line of output, on every success path through this skill (issues created or reused via dedup), print exactly one `STARK_STAGE_SUMMARY` line — not gated behind any flag, appended after the human output above:

```bash
cat <<EOF
STARK_STAGE_SUMMARY {"skill":"stark-plan-to-tasks","outcome":"issues_created","plan_slug":"$PLAN_SLUG","issue_numbers":[$ISSUE_NUMBERS_CSV]}
EOF
```

On an aborted/halted path (Pass 1 gaps unresolved after 3 rounds, Pass 3 validation not converged, `--dry-run`, or `--cleanup`), print the same line with `issue_numbers` as `[]` and `outcome` set to the specific halt reason (`gaps_unresolved`, `validation_unresolved`, `dry_run`, `cleanup`) — no issues exist yet on those paths, so there is nothing to report. On a Phase 1 setup failure (before `PLAN_SLUG` is even resolved), `plan_slug` is `null` too.

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

## What This Skill Does NOT Do

- Challenge architectural decisions
- Add scope beyond the plan
- Assign issues to people or agents
- Kick off implementation (prints `/stark-copilot` command instead)
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
