---
name: stark-review-improvement
description: >-
  Improve review prompts based on Prompt Improvement Assessment from completed reviews. Use for fix review prompts.
argument-hint: "[--prompts-dir spec-review] (reads assessment from context or latest history)"
disable-model-invocation: true
model: opus
revision: e504ba02a12b6dd779ebd026fa4c07df76697ff2
revision_date: 2026-05-15T18:20:11Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-review-improvement

Closes the feedback loop on stark-skills: reads the prompt improvement assessment from the current conversation, makes targeted edits to the prompt and orchestrator files, and commits a changelog entry.

## Arguments

- `--prompts-dir DIR` — which prompt set to target (default: agent root = `$PROMPTS/{agent}/`). When set, prompts resolve to `$PROMPTS/{DIR}/{agent}/`. Common values:
  - *(omitted)* — PR code review prompts (`global/prompts/{claude,codex,gemini}/`; gemini disabled by default)
  - `spec-review` — spec review prompts (`global/prompts/spec-review/{claude,codex,gemini}/`; gemini disabled by default)
  - `plan-review` — plan review prompts (`global/prompts/plan-review/{claude,codex,gemini}/`; gemini disabled by default)

**Raw input:** `$ARGUMENTS`

## Constants

```
STARK_REPO  = ~/Code/Playground/stark-skills
PROMPTS     = $STARK_REPO/global/prompts
TOOLS       = $STARK_REPO/tools
CONFIG      = $STARK_REPO/global/config.json
ORG_CONFIG  = $STARK_REPO/org/evinced/config.json
HISTORY     = ~/.claude/code-review/history
CHANGELOG   = $STARK_REPO/docs/prompt-changelog.md
```

When `--prompts-dir` is set:

```
PROMPT_ROOT = $PROMPTS/{prompts-dir}/{agent}/   # e.g., $PROMPTS/spec-review/claude/
ORCHESTRATOR = $TOOLS/stark_review_doc.ts  # instead of multi_review.ts
HISTORY_SUB  = spec-reviews                    # history subdirectory
```

When `--prompts-dir` is NOT set (default — PR code review):

```
PROMPT_ROOT = $PROMPTS/{agent}/                  # e.g., $PROMPTS/claude/
ORCHESTRATOR = $TOOLS/multi_review.ts
HISTORY_SUB  = (org/repo/pr structure)
```

## Phase 1: Extract Assessment

### 1.1 Find the assessment

Look in the **current conversation context** for either:

- A "Prompt Improvement Assessment" section (from a `/stark-review` or `/stark-review-spec` run)
- A `prompt-assessment.md` or `*.spec-review.md` file path referenced in conversation

If neither exists, check the most recent history directory for the matching review type:

```bash
# For PR code review (default; recurses per-repo-slug subdirs):
find $HISTORY -name "*.json" | sort | tail -1
# For spec-review:
ls -td $HISTORY/spec-reviews/*/ | head -1
# For plan-review:
ls -td $HISTORY/plan-reviews/*/ | head -1
```

Read `prompt-assessment.md` or `summary.md` from that directory.

If nothing found → error: "No prompt improvement assessment found. Run the relevant review skill first."

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

For each approved action item, in order:

### 2a. Prompt edits (`$PROMPT_ROOT/{agent}/*.md`)

Read the target prompt file. Apply the minimum edit needed.

**Common fixes for PR code review prompts (`--prompts-dir` not set):**

| Issue                                 | Fix Location                                 | What to Change                                                                                             |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent reviews files outside PR diff   | `agent.md` "How You Receive Context" section | Replace hardcoded `main` with `<base>` placeholder; add "ONLY review files that appear in the diff output" |
| Agent reviews managed/generated files | Domain prompt (top)                          | Add "Skip files in: {path patterns}" instruction                                                           |
| False positives on specific patterns  | Domain prompt (severity section)             | Add "Do NOT flag: {pattern description}"                                                                   |
| Agent produces no findings            | `agent.md` strengths section                 | Tune to be less conservative; add concrete examples                                                        |
| Output not parseable as JSON          | `agent.md` output rules                      | Strengthen JSON-only instruction                                                                           |
| Cross-domain duplicate findings       | Not a prompt fix → `orchestrator-edit`       | —                                                                                                          |

**Common fixes for spec/plan review prompts (`--prompts-dir spec-review` or `plan-review`):**

| Issue                                                              | Fix Location                    | What to Change                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Scope creep — agents flag v2/future concerns as v1 issues          | `03-scope.md`                   | Add: "Calibrate findings to the spec's stated scope and scale. Do not flag deferred/Phase 2 items as issues."         |
| Same finding surfaces in 3+ domains                                | `agent.md`                      | Add: "If a finding primarily belongs to another domain, mention it briefly and defer to that domain's review."          |
| One agent generates disproportionately more findings               | Agent-specific `agent.md`       | Tighten severity calibration: "A finding is high only if it would block implementation or cause a production incident." |
| Over-engineering for scale (low-volume system gets scale critique) | Relevant domain prompt           | Add: "Consider the stated traffic volume. Do not recommend horizontal scaling for systems under 100 runs/day."          |
| False positives on explicit design decisions                       | Domain prompt (relevant domain) | Add: "If the spec explicitly addresses this concern in another section, do not flag it."                              |
| Findings about missing features that are out of scope              | `01-completeness.md`            | Add: "Only flag missing items that are within the stated scope. Out-of-scope omissions are not completeness issues."    |

**Rules for prompt edits:**

- Minimal change. Don't rewrite entire prompts.
- Keep the existing structure (sections, headings).
- If adding an exclusion, add it to the relevant section, not as a new section.
- If the same fix applies to all 3 agents, edit all 3.
- If agent-specific, only edit that agent's file.

### 2b. Orchestrator edits (`$ORCHESTRATOR`)

Read the relevant function. Apply targeted fix. The orchestrator depends on `--prompts-dir`:

**For PR code review (`multi_review.ts`):**

| Issue                            | Where                           | Fix                                          |
| -------------------------------- | ------------------------------- | -------------------------------------------- |
| Agent doesn't receive `base` ref | `_run_subagent()`               | Inject `{base}` into the prompt string       |
| No file exclusion filtering      | `_run_subagent()` or new helper | Filter diff output before passing to agents  |
| Missing post-processing (dedup)  | After `_parse_findings()`       | Add cross-agent dedup by file+line proximity |

**For spec/plan review (`stark_review_doc.ts`):**

| Issue                                      | Where                                 | Fix                                                                                    |
| ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| Cross-domain duplicate findings            | After collecting all results          | Add dedup: same section + same concern across domains → keep highest-severity instance |
| Agent produces too many low-value findings | Prompt construction in `_run_agent()` | Inject max-findings instruction: "Return at most N findings, prioritized by severity"  |
| Findings reference wrong section numbers   | Prompt construction                   | Include document table of contents as context                                          |

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
2. **TS type-check** — if orchestrator was edited: `node --experimental-strip-types --check "$ORCHESTRATOR"`
3. **JSON validity** — if config was edited: `node -e "JSON.parse(require('fs').readFileSync('$CONFIG','utf8'))"`
4. **Diff review** — show `git diff` in `$STARK_REPO` to the user for confirmation

## Phase 4: Log the Learning

### 4a. Append to prompt changelog

Create or append to `$CHANGELOG`:

```markdown
## YYYY-MM-DD — {source description}

**Source:** PR #{number} in {repo} (or "spec review of {filename}" or "manual assessment")
**Prompts dir:** {prompts-dir or "default (PR code review)"}
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
- **agent.md is the scoping file.** For PR reviews: diff scope instructions go there. For spec/plan reviews: document-level scoping (e.g., "calibrate to stated scope") goes there. Domain prompts handle domain-specific review criteria in both cases.
