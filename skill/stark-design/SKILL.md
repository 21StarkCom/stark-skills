---
name: stark-design
description: >
  Use this skill when the user wants to create a design document, spec, or architecture doc from
  requirements, a feature description, or a high-level prompt. Triggers whenever someone needs to
  go from an idea or set of requirements to a formal design. Covers requests like "design this
  feature", "write a spec for", "create an architecture doc", "I need a design document for",
  or any variation where input is requirements/prompt and desired output is a design/spec document.
  Also triggers on `/stark-design <prompt-or-path>`. Works by dispatching 3 independent AI agents
  to each produce a design, then cross-reviewing all designs to synthesize the best one. This is
  the natural first step before design review (`/stark-review-design`).
argument-hint: '"prompt" | <path-to-requirements> [--agents claude,codex,gemini] [--timeout N] [--dry-run] [--output PATH]'
---

# stark-design

Generate a design document from requirements or a prompt. Three agents each independently produce
a design, then each design is cross-reviewed by the other two agents (3 designs, 6 reviews).
The highest-scoring design becomes the base, synthesized with the best elements from the others.

Fills the pipeline start: **`/stark-design`** → `/stark-review-design` → `/stark-design-to-plan` → `/stark-review-plan` → `/stark-plan-to-tasks` → `/stark-phase-execute`

## Arguments

- `"prompt"` — inline requirements text (positional, quoted)
- `<path>` — path to requirements/prompt markdown file
- `--agents LIST` — comma-separated agent IDs (default: claude,codex,gemini)
- `--timeout N` — per-agent timeout in seconds (default: 600)
- `--dry-run` — generate designs and reviews but don't write output files
- `--output PATH` — override output path for the design document

If neither a prompt nor a path is provided, ask: "What should the design cover?"

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Setup

### 1.1 Parse input

Two input modes:
- **Inline prompt:** User provides quoted text or describes the feature directly. Capture as `requirements_content`.
- **File path:** User provides a path to a requirements/prompt file. Read it as `requirements_content`.

If a file path is provided:
- Confirm file exists and is readable. If not found and path looks like a partial name, search:
  ```bash
  find docs/ -name "*${path}*" -o -name "*${path}*.md" 2>/dev/null | head -5
  ```
- Check uncommitted changes (warn if dirty, unless `--force`).

### 1.2 Detect PR context

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

Store for Phase 5 if present.

### 1.3 Authenticate (only if PR detected)

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

## Phase 2: Generate Designs

Dispatch 3 agents in parallel, each produces a design document:

```bash
$PYTHON $SCRIPTS/design_to_plan_dispatch.py \
  --mode generate \
  --design-file "$requirements_file" \
  --prompts-dir prompt-to-design \
  --timeout $timeout
```

If input was an inline prompt (not a file), write it to a temp file first:
```bash
echo "$requirements_content" > /tmp/stark-design-$$/requirements.md
```

Capture JSON output. Extract `results[].plan_content` for each agent.

**Minimum viable:** At least 2 of 3 agents must succeed. If only 1 succeeds, use that single design (skip cross-review). If 0 succeed, abort with dispatch failure diagnostics.

Write each design to a temp file and a plans.json for Phase 3:
```bash
mkdir -p /tmp/stark-design-$$
```

## Phase 3: Cross-Review Designs

Each design gets reviewed by the other 2 agents (6 reviews total):

```bash
$PYTHON $SCRIPTS/design_to_plan_dispatch.py \
  --mode cross-review \
  --design-file "$requirements_file" \
  --plans-json /tmp/stark-design-$$/plans.json \
  --prompts-dir prompt-to-design \
  --timeout $timeout
```

Capture JSON output. Parse scores, strengths, weaknesses.

Display the scorecard:

```
Cross-Review Scorecard
──────────────────────
              Complete  Clarity  Feasible  Extend  Security  Avg
  claude        8.5       9.0      8.0     7.5      8.0     8.2 ★
  codex         7.5       8.0      8.5     7.0      7.5     7.7
  gemini        8.0       7.5      7.0     8.5      8.0     7.8

Winner: claude (8.2/10)
```

Tie threshold: top 2 within 0.5 points.

## Phase 4: Synthesize

This phase runs in the Claude Code orchestrator (not dispatched to a sub-agent).

Read:
1. The winning design (or both in a tie)
2. All 6 cross-reviews
3. The original requirements

Synthesis rules:
1. **Winner as base:** Start with the winning design's structure and content
2. **Merge superior elements:** For each section where a non-winning design scored higher on a specific dimension, incorporate that design's approach
3. **Address weaknesses:** Fix issues flagged by cross-reviewers
4. **Discard confirmed problems:** If both reviewers flagged the same weakness, don't carry it forward
5. **Preserve specificity:** Keep concrete data formats, API contracts, component names

### Synthesis Quality Check

Verify:
- Every requirement has a corresponding design element
- No contradictions between sections
- Security considerations address the data sensitivity level
- Open questions are genuine (not things already decided in the design)

## Phase 5: Output & Persist

### 5a. Terminal — print synthesis summary.

### 5b. Write design file (skip in --dry-run)

Default output path logic:
- If `--output PATH` specified: use it
- If input was a file at `docs/requirements/foo.md`: write to `docs/specs/YYYY-MM-DD-foo-design.md`
- If input was inline prompt: write to `docs/specs/YYYY-MM-DD-<slugified-topic>-design.md`

### 5c. Write review summary (skip in --dry-run)

Write to `{design-name}.design-review.md` alongside the design file.

### 5d. Post to PR (if PR detected and not --dry-run)

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

### 5e. Save history

```bash
mkdir -p ~/.claude/code-review/history/prompt-to-design/{topic-slug}
```

Write: `generate.json`, `cross-review.json`, `synthesis.md`, `summary.md`

### 5f. Cleanup

```bash
rm -rf /tmp/stark-design-$$
```

## Observability

### Task-based progress (required)

```
TaskCreate: "Phase 1: Setup — parse input"
            activeForm: "Parsing requirements"
TaskCreate: "Phase 2: Generate — 3 agents producing designs"
            activeForm: "Generating 3 design documents"
TaskCreate: "Phase 3: Cross-review — 6 reviews"
            activeForm: "Running 6 cross-reviews"
TaskCreate: "Phase 4: Synthesize — merge best elements"
            activeForm: "Synthesizing final design"
TaskCreate: "Phase 5: Output — write files"
            activeForm: "Writing design and review files"
```

### Timestamped log lines (required)

```
[HH:MM:SS] === stark-design started ===
[HH:MM:SS] Phase 1: Setup — done (1s)
[HH:MM:SS] Phase 2: Generate — dispatching 3 agents
[HH:MM:SS]   ▸ claude: done — 280 lines [140s]
[HH:MM:SS]   ▸ codex: done — 220 lines [190s]
[HH:MM:SS]   ▸ gemini: done — 250 lines [100s]
[HH:MM:SS] Phase 2: done (3m 10s)
[HH:MM:SS] Phase 3: Cross-review — dispatching 6 reviews
[HH:MM:SS]   ▸ codex→claude: 8.2/10 [85s]
[HH:MM:SS]   ...
[HH:MM:SS] Phase 3: done (2m 50s)
[HH:MM:SS] Phase 4: Synthesize — winner: claude (8.2/10)
[HH:MM:SS] Phase 4: done (30s)
[HH:MM:SS] Phase 5: Output — done (3s)
[HH:MM:SS] === stark-design completed ===
```

### Metrics block at end (required)

```
Metrics
───────
Total duration:     Xm Ys
Designs generated:  3/3
Reviews completed:  6/6
Winner:             claude (8.2/10)
Runner-up:          gemini (7.8/10)
Synthesis merges:   N sections from non-winner designs
Output:             {output_path}
```

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No prompt and no path | Ask: "What should the design cover?" |
| File not found | Search docs/ for candidates |
| 0/3 designs generated | Abort with dispatch diagnostics |
| 1/3 designs generated | Use single design, skip cross-review, warn |
| 2/3 designs generated | Cross-review with available designs (4 reviews) |
| Cross-review parse failure | Use raw output, score manually |
| Script not found | "Run install.sh to set up stark-skills" |
