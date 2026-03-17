---
name: start-review-improvement
description: >
  Improve stark-review prompts based on the Prompt Improvement Assessment from a
  completed /stark-review run. Reads the assessment from conversation context (or
  history files), edits the relevant prompt files in ~/git/Evinced/stark-review/,
  patches multi_review.py if needed, and logs the learning. Use when the user says
  "improve review prompts", "start review improvement", "fix review prompts", or
  invokes /start-review-improvement.
---

# start-review-improvement

Closes the feedback loop on stark-review: reads the prompt improvement assessment from the current conversation, makes targeted edits to the prompt and orchestrator files, and commits a changelog entry.

## Constants

```
STARK_REPO = ~/git/Evinced/stark-review
PROMPTS    = $STARK_REPO/global/prompts
SCRIPTS    = $STARK_REPO/scripts
CONFIG     = $STARK_REPO/global/config.json
ORG_CONFIG = $STARK_REPO/org/evinced/config.json
HISTORY    = ~/.claude/code-review/history
CHANGELOG  = $STARK_REPO/docs/prompt-changelog.md
```

## Phase 1: Extract Assessment

### 1.1 Find the assessment

Look in the **current conversation context** for either:
- A "Prompt Improvement Assessment" section (from a `/stark-review` run)
- A `prompt-assessment.md` file path referenced in conversation

If neither exists, check the most recent history directory:
```bash
ls -td $HISTORY/*/*/* | head -1
```
Read `prompt-assessment.md` from that directory.

If nothing found → error: "No prompt improvement assessment found. Run /stark-review first."

### 1.2 Parse into action items

Extract each recommendation row from the assessment table. For each:
- **Pattern**: what went wrong (e.g., "Gemini reviewed entire codebase instead of PR diff")
- **Recommendation**: what to change (e.g., "Tighten diff scoping in Gemini agent.md")
- **Target**: which file(s) to edit

Classify each action:

| Category | Target Files | Examples |
|----------|-------------|----------|
| `prompt-edit` | `$PROMPTS/{agent}/{file}.md` | Tighten scope, add instructions, fix output format |
| `orchestrator-edit` | `$SCRIPTS/multi_review.py` | Pass variables to agents, add post-processing |
| `config-edit` | `$CONFIG` or `$ORG_CONFIG` | Add `disabled_paths`, `severity_overrides`, `disabled_domains` |
| `no-action` | — | Observation only, no concrete fix available |

### 1.3 Confirm with user

Present the action items as a numbered list with proposed changes. Ask: "Proceed with all, or select specific items?"

## Phase 2: Apply Changes

For each approved action item, in order:

### 2a. Prompt edits (`$PROMPTS/{agent}/*.md`)

Read the target prompt file. Apply the minimum edit needed:

**Common fixes and where they go:**

| Issue | Fix Location | What to Change |
|-------|-------------|----------------|
| Agent reviews files outside PR diff | `agent.md` "How You Receive Context" section | Replace hardcoded `main` with `<base>` placeholder; add "ONLY review files that appear in the diff output" |
| Agent reviews managed/generated files | Domain prompt (top) | Add "Skip files in: {path patterns}" instruction |
| False positives on specific patterns | Domain prompt (severity section) | Add "Do NOT flag: {pattern description}" |
| Agent produces no findings | `agent.md` strengths section | Tune to be less conservative; add concrete examples |
| Output not parseable as JSON | `agent.md` output rules | Strengthen JSON-only instruction |
| Cross-domain duplicate findings | Not a prompt fix → `orchestrator-edit` | — |

**Rules for prompt edits:**
- Minimal change. Don't rewrite entire prompts.
- Keep the existing structure (sections, headings).
- If adding an exclusion, add it to the relevant section, not as a new section.
- If the same fix applies to all 3 agents, edit all 3.
- If agent-specific, only edit that agent's file.

### 2b. Orchestrator edits (`$SCRIPTS/multi_review.py`)

Read the relevant function. Apply targeted fix:

| Issue | Where in multi_review.py | Fix |
|-------|-------------------------|-----|
| Agent doesn't receive `base` ref | `_run_subagent()` function, agent-specific command construction | Inject `{base}` into the prompt string passed to the agent |
| No file exclusion filtering | `_run_subagent()` or a new helper | Filter diff output before passing to agents, or add `--exclude` patterns to prompts |
| Missing post-processing (dedup) | After `_parse_findings()` | Add cross-agent dedup by file+line proximity |

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
- Document the field inline or in README.
- If adding to org config, check that global config schema supports the field.

## Phase 3: Validate

After all edits:

1. **Syntax check prompts** — ensure no broken markdown, no missing sections
2. **Python syntax** — if `multi_review.py` was edited: `python3 -c "import py_compile; py_compile.compile('$SCRIPTS/multi_review.py')"`
3. **JSON validity** — if config was edited: `python3 -c "import json; json.load(open('$CONFIG'))"`
4. **Diff review** — show `git diff` in `$STARK_REPO` to the user for confirmation

## Phase 4: Log the Learning

### 4a. Append to prompt changelog

Create or append to `$CHANGELOG`:

```markdown
## YYYY-MM-DD — {source description}

**Source:** PR #{number} in {repo} (or "manual assessment")
**Assessment:** {1-line summary of what was wrong}

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `global/prompts/gemini/agent.md` | Fixed diff scoping | Agent was reviewing entire codebase, not PR diff |
| ... | ... | ... |

### Validation
- [ ] Prompt syntax OK
- [ ] Python compiles
- [ ] Config valid JSON
```

### 4b. Copy assessment to history

If the assessment came from conversation context (not already saved):
```bash
cp assessment → $HISTORY/{org}/{repo}/{pr}/prompt-assessment.md
```

## Phase 5: Commit

```bash
cd $STARK_REPO
git add -A
git commit -m "improve: {1-line summary of changes}

Source: {repo}#PR{number}
Changes: {count} prompt edits, {count} orchestrator edits, {count} config edits"
```

Do NOT push unless the user explicitly asks.

## Important Constraints

- **Never rewrite an entire prompt file.** Targeted edits only.
- **Never remove existing instructions.** Add constraints, don't delete capabilities.
- **Backward compatible.** New config fields must have defaults. Prompt changes must not break existing output format.
- **One concern per edit.** Don't bundle unrelated improvements in a single file change.
- **Show diffs before committing.** The user reviews the changes.
- **agent.md is the scoping file.** Diff scope instructions go there, not in domain prompts. Domain prompts handle domain-specific review criteria.
