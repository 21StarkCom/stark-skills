---
name: stark-review-improvement
description: >-
  Improve review prompts based on a Prompt Improvement Assessment from a
  completed review. Use for fixing review prompts or their current TypeScript
  orchestration; edits and validation are local, and commit/push are opt-in.
argument-hint: "[assessment-path] [--commit]"
disable-model-invocation: true
model: opus
revision: e504ba02a12b6dd779ebd026fa4c07df76697ff2
revision_date: 2026-05-15T18:20:11Z
---

## Help

If the current request asks for help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-review-improvement

Closes the feedback loop on stark-skills: reads a prompt improvement assessment,
makes targeted edits to prompt/orchestrator files, validates them, and records
the learning in the prompt changelog. It commits only when explicitly asked.

## Arguments

- `[assessment-path]` — optional explicit assessment or review receipt path.
  Otherwise use the assessment already present in the current conversation.
- `--commit` — after showing the final diff, explicitly authorize staging the
  listed changed files and committing them. Never implies push.

Treat the text following the explicit skill mention as the arguments. This
skill targets the PR review prompts in `global/prompts/{claude,codex,gemini}/`;
the former spec/plan prompt modes are not supported.

## Constants

Resolve the source checkout from the current workspace or an explicit path;
never assume a personal checkout location. Verify it by checking for both
`tools/stark_review.ts` and `global/prompts/` before editing. If the current
repository is not `stark-skills`, ask for its source checkout path.

```bash
STARK_REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
test -f "$STARK_REPO/tools/stark_review.ts"
test -d "$STARK_REPO/global/prompts"

PROMPTS="$STARK_REPO/global/prompts"
TOOLS="$STARK_REPO/tools"
CONFIG="$STARK_REPO/global/config.json"
ORG_CONFIG="$STARK_REPO/org/evinced/config.json"
CHANGELOG="$STARK_REPO/docs/prompt-changelog.md"
```

```
PROMPT_ROOT = $PROMPTS/{agent}/                  # e.g., $PROMPTS/claude/
ORCHESTRATOR = $TOOLS/stark_review.ts
```

## Phase 1: Extract Assessment

### 1.1 Find the assessment

Look in the **current conversation context** or the explicit argument for:

- A "Prompt Improvement Assessment" section (from a `stark-review` run)
- A `prompt-assessment.md` file path referenced in conversation
- A receipt whose `history_files` entries identify the relevant run artifacts

Do not crawl a hardcoded home/history directory or select “latest” by filename;
that can pick another repo or review. If no assessment or receipt path is in
context, ask the user for one and stop.

### 1.2 Parse into action items

Extract each recommendation row from the assessment table. For each:

- **Pattern**: what went wrong (e.g., "Scope creep noise — agents flag v2 concerns as v1 issues")
- **Recommendation**: what to change (e.g., "Add scope calibration instruction to scope domain prompt")
- **Target**: which file(s) to edit

Classify each action:

| Category            | Target Files                     | Examples                                                          |
| ------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `prompt-edit`       | `$PROMPT_ROOT/{agent}/{file}.md` | Tighten scope, add instructions, fix output format                |
| `orchestrator-edit` | `$ORCHESTRATOR`                  | Pass variables to agents, add post-processing, cross-domain dedup |
| `config-edit`       | `$CONFIG` or `$ORG_CONFIG`       | Add `disabled_paths`, `severity_overrides`, `disabled_domains`    |
| `no-action`         | —                                | Observation only, no concrete fix available                       |

### 1.3 Confirm with user

Present the action items as a numbered list with proposed changes. Ask: "Proceed with all, or select specific items?"

## Phase 2: Apply Changes

For each approved action item, in order. Maintain `EDITED_PATHS` as the
deduplicated list of repo-relative files this run actually changed; it is the
only staging allowlist in Phase 5.

### 2a. Prompt edits (`$PROMPT_ROOT/{agent}/*.md`)

Read the target prompt file. Apply the minimum edit needed.

**Common fixes for PR code review prompts:**

| Issue                                 | Fix Location                                 | What to Change                                                                                             |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent reviews files outside PR diff   | `agent.md` "How You Receive Context" section | Replace hardcoded `main` with `<base>` placeholder; add "ONLY review files that appear in the diff output" |
| Agent reviews managed/generated files | Domain prompt (top)                          | Add "Skip files in: {path patterns}" instruction                                                           |
| False positives on specific patterns  | Domain prompt (severity section)             | Add "Do NOT flag: {pattern description}"                                                                   |
| Agent produces no findings            | `agent.md` strengths section                 | Tune to be less conservative; add concrete examples                                                        |
| Output not parseable as JSON          | `agent.md` output rules                      | Strengthen JSON-only instruction                                                                           |
| Cross-domain duplicate findings       | Not a prompt fix → `orchestrator-edit`       | —                                                                                                          |

**Rules for prompt edits:**

- Minimal change. Don't rewrite entire prompts.
- Keep the existing structure (sections, headings).
- If adding an exclusion, add it to the relevant section, not as a new section.
- If the same fix applies to all 3 agents, edit all 3.
- If agent-specific, only edit that agent's file.

### 2b. Orchestrator edits (`$ORCHESTRATOR`)

Read the relevant function. Apply the targeted fix:

**For PR code review (`stark_review.ts`):**

| Issue                            | Where                           | Fix                                          |
| -------------------------------- | ------------------------------- | -------------------------------------------- |
| Agent doesn't receive the base ref | `resolvePromptSources()` / `renderReviewPrompt()` | Carry `baseRef` through the rendered assignment |
| Dispatch context is wrong          | `runReviewPass()` assignment construction         | Fix the trusted prompt sources or PR payload before `dispatchDomains()` |
| Finding classification is wrong    | `runClassifier()` / `applySeverityOverrides()`    | Correct classification or severity handling with tests |
| Posting shape is wrong             | `partitionInlineVsBody()` / `buildReviewBody()` / `postReview()` | Fix the smallest current posting seam |
| Fix-loop behavior is wrong         | `runFixer()` / `stageFiles()` / `runTrustedTest()` / `pushBranch()` | Preserve explicit-path staging and authorization gates |

**Rules for orchestrator edits:**

- Don't restructure the file. Surgical edits only.
- Add tests if changing logic (not prompt strings).
- Keep backward compatibility — new config fields must have defaults.

### 2c. Config edits (`config.json`)

Add new fields with safe defaults:

```json
{
  "disabled_paths": [],        // glob patterns to exclude from review
  "severity_overrides": {}     // already exists, extend if needed
}
```

**Rules for config edits:**

- New fields MUST have empty/null defaults (backward compatible).
- Document the field in the relevant config schema or repository documentation.
- If adding to org config, check that global config schema supports the field.

## Phase 3: Validate

After all edits:

1. **Syntax check prompts** — ensure no broken markdown, no missing sections
2. **TS syntax + focused tests** — if the orchestrator was edited, run
   `node --experimental-strip-types --check "$ORCHESTRATOR"` and the
   `tools/stark_review*.test.ts` tests covering the touched seam
3. **JSON validity** — if config was edited: `node -e "JSON.parse(require('fs').readFileSync('$CONFIG','utf8'))"`
4. **Diff review** — show `git diff` in `$STARK_REPO` to the user for confirmation

## Phase 4: Log the Learning

### 4a. Append to prompt changelog

Create or append to `$CHANGELOG`:

```markdown
## YYYY-MM-DD — {source description}

**Source:** PR #{number} in {repo} (or "spec review of {filename}" or "manual assessment")
**Prompts dir:** PR code review
**Assessment:** {1-line summary of what was wrong}

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/gemini/agent.md` | Fixed diff scoping | Agent was reviewing entire codebase, not PR diff |
| ... | ... | ... |

### Validation
- [ ] Prompt syntax OK
- [ ] Orchestrator type-checks
- [ ] Config valid JSON
```

### 4b. Preserve the assessment only when requested

Do not infer or write to a host-specific history root. The current TS tool owns
its review-history layout and exposes written paths through the receipt's
`history_files`. If the user explicitly asks to preserve a conversation-only
assessment, ask for the destination or use a destination they already supplied.

## Phase 5: Optional commit

Show the complete diff first. Commit only when the user supplied `--commit` or
otherwise explicitly approved committing after seeing that diff. Stage only
the files recorded in the change ledger; never stage unrelated workspace
changes.

```bash
cd $STARK_REPO
git add -- "${EDITED_PATHS[@]}" docs/prompt-changelog.md
git diff --cached --name-only
git commit -m "improve: {1-line summary of changes}

Source: {repo}#PR{number}
Changes: {count} prompt edits, {count} orchestrator edits, {count} config edits"
```

Do NOT push unless the user separately and explicitly asks.

## Important Constraints

- **Never rewrite an entire prompt file.** Targeted edits only.
- **Do not remove unrelated instructions.** Replace an obsolete or conflicting
  instruction only when the assessment identifies it as the defect.
- **Backward compatible.** New config fields must have defaults. Prompt changes must not break existing output format.
- **One concern per edit.** Don't bundle unrelated improvements in a single file change.
- **Show diffs before committing.** The user reviews the changes.
- **agent.md is the PR-scoping file.** Diff-scope instructions go there; domain
  prompts hold domain-specific review criteria.
