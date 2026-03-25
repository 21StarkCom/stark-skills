# `/stark-tournament` — Multi-LLM Competition Skill Design Spec

> Run N LLMs on the same task, evaluate outputs with a judge, pick a winner. Reusable competition framework for any prompt-in → artifact-out workflow.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-03-25-stark-tournament-design.md`

---

## Problem

The 3-LLM competition pattern is proven — we use it in `generate_skill_docs.py` for HTML visualizations and it works well (Claude and Codex tied at 20 wins each, Gemini scored well but never won). But the logic is hardcoded: prompt construction, parallel dispatch, output parsing, screenshot-based evaluation, winner selection, audit trail.

This pattern has broader applications:
- **Prompt tuning** — run 3 prompt variants through the same LLM, judge which produces the best output
- **Code generation** — have 3 LLMs write the same function, pick the best implementation
- **Review prompt comparison** — test whether a revised review prompt catches more real issues than the current one
- **Design alternatives** — generate 3 architectural approaches, evaluate trade-offs
- **Migration scripts** — generate 3 migration strategies, pick the safest

Each use case differs in: what the prompt asks for, what the output format is, how to evaluate quality, and what "winning" means. The tournament framework should be agnostic to all of these.

## Goals

1. Reusable tournament engine — works for any prompt-in → artifact-out task
2. Pluggable evaluation — screenshot-based (visual), text-based (semantic), code-based (tests pass), or custom
3. Configurable competitors — any combination of LLMs, prompt variants, or model configs
4. Structured audit trail — every run produces a JSONL record with scores, winner, and reasoning
5. CLI and Python API — usable as a standalone script or imported by other tools

## Non-Goals

- Real-time/streaming evaluation (batch only)
- More than 2 evaluation rounds (single judge pass is sufficient; the skill-docs system showed this works)
- GUI or web dashboard (terminal + JSONL audit is enough)
- Training or fine-tuning based on tournament results (that's a different system)

---

## Architecture

```
                    ┌─────────────┐
                    │  Tournament  │
                    │   Config     │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Claude   │ │ Codex    │ │ Gemini   │
        │ (or any) │ │ (or any) │ │ (or any) │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │             │
             ▼             ▼             ▼
        ┌──────────────────────────────────────┐
        │        Output Collector              │
        │   (parse, validate, normalize)       │
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │           Evaluator                  │
        │  (visual / semantic / test / custom) │
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │      Winner Selection                │
        │  (weighted avg, tie-break, audit)    │
        └──────────────────────────────────────┘
```

### Components

**Tournament Config** — defines the competition: prompt template, competitors, evaluation strategy, output format expectations, scoring factors and weights.

**Competitor Dispatch** — parallel execution via ThreadPoolExecutor. Each competitor is an (agent, prompt) pair. Reuses the CLI dispatch patterns from `multi_review.py` and `generate_skill_docs.py`.

**Output Collector** — parses raw LLM output into structured artifacts. Pluggable parsers for different output types (HTML, code, markdown, JSON).

**Evaluator** — judges the collected outputs. Multiple strategies:
- `visual` — screenshot artifacts, send PNGs to Claude via Anthropic SDK, score on visual factors
- `semantic` — send text artifacts to Claude, score on content quality factors
- `test` — run code artifacts through a test suite, score on pass rate + code quality
- `custom` — user-provided evaluation function

**Winner Selection** — weighted average of factor scores, tie-break by accuracy then random. Same algorithm as `generate_skill_docs.py`.

---

## Tournament Config Schema

```yaml
# tournament.yaml
schema_version: 1

# What to generate
prompt_template: |
  Generate a Python function that {task_description}.

  Requirements:
  {requirements}

  Output the function in a ```python code block.

# Variables injected into prompt_template
variables:
  task_description: "parses CSV files with configurable delimiters"
  requirements: |
    - Accept file path and optional delimiter (default comma)
    - Return list of dicts (header row as keys)
    - Handle quoted fields correctly
    - Raise ValueError on malformed input

# Who competes
competitors:
  - id: claude
    agent: claude           # CLI agent name
    model: claude-opus-4-6  # optional model override
    # prompt_override: ...  # optional per-competitor prompt modification
  - id: codex
    agent: codex
  - id: gemini
    agent: gemini

# How to evaluate
evaluation:
  strategy: semantic        # visual | semantic | test | custom
  judge: claude-sonnet-4-6  # model for judging (sonnet for cost efficiency)

  # Scoring factors (strategy-specific)
  factors:
    correctness:   { weight: 2.0, description: "Does the output meet all requirements?" }
    completeness:  { weight: 1.5, description: "Are edge cases handled?" }
    code_quality:  { weight: 1.0, description: "Is the code clean, idiomatic, well-structured?" }
    error_handling: { weight: 1.0, description: "Are errors handled gracefully?" }
    documentation: { weight: 0.5, description: "Are comments/docstrings appropriate?" }

  # For strategy: test
  # test_command: "python -m pytest /tmp/tournament-test-{competitor_id}.py -v"
  # test_file: "tests/test_csv_parser.py"

  # For strategy: visual
  # screenshot_command: "npx playwright screenshot --full-page {html_path} {png_path}"
  # viewport: "1200x800"

  # For strategy: custom
  # eval_script: "scripts/custom_eval.py"
  # eval_function: "evaluate"

# Output
output:
  artifact_dir: /tmp/tournament-{timestamp}  # where artifacts are saved
  audit_file: tournament-results.jsonl        # appended per run
  keep_all: false                             # keep losing artifacts? (default: only winner)

# Execution
execution:
  max_workers: 6
  timeout_seconds: 300
  retries: 1                 # retry failed competitors once
```

### Inline Config (no YAML file)

For simple cases, the skill accepts inline arguments:

```
/stark-tournament --prompt "Write a Python function that ..." \
  --competitors claude,codex,gemini \
  --strategy semantic \
  --factors correctness:2,completeness:1.5,quality:1
```

Or even simpler — prompt-only, everything else defaults:

```
/stark-tournament "Write a regex that matches email addresses"
```

Defaults: competitors = claude + codex + gemini, strategy = semantic, factors = correctness(2) + completeness(1.5) + quality(1).

---

## Evaluation Strategies

### `visual` — Screenshot-Based

For HTML/image outputs. Same approach as `generate_skill_docs.py`:

1. Save each competitor's HTML to a temp file
2. Screenshot via Playwright (`npx playwright screenshot --full-page`)
3. Send all PNGs to Claude via Anthropic SDK as base64 image content blocks
4. Claude scores each on the configured visual factors
5. Parse structured JSON scores from Claude's response

Default visual factors: `visual_clarity(1.0)`, `completeness(1.0)`, `info_architecture(1.0)`, `accuracy(1.5)`, `design_quality(0.5)`, `audience_fit(1.5)`

### `semantic` — Text-Based

For code, markdown, or any text output:

1. Collect each competitor's text output
2. Send all outputs to Claude as labeled text blocks
3. Claude scores each on the configured semantic factors
4. Parse structured JSON scores

Default semantic factors: `correctness(2.0)`, `completeness(1.5)`, `code_quality(1.0)`, `error_handling(1.0)`, `documentation(0.5)`

The evaluation prompt:

```
You are judging a competition between {N} AI-generated outputs.

## Task
{original prompt}

## Scoring Factors
{for each factor: name, weight, description}

## Outputs
{for each competitor: labeled output text}

Score each output on each factor (1-10). Return JSON:
{"scores": [
  {"competitor": "id", "factor1": N, "factor2": N, ...},
  ...
]}
```

### `test` — Test Suite

For code outputs:

1. Collect each competitor's code output
2. Write each to a temp file
3. Run `test_command` against each (substituting `{competitor_id}`)
4. Score: test pass rate (0-10 scale) + optional Claude code quality review
5. Both test results and quality scores feed into winner selection

Test failures are not automatic disqualification — a competitor that passes 9/10 tests with beautiful code might beat one that passes 10/10 with terrible code, depending on factor weights.

### `custom` — User-Provided

For domain-specific evaluation:

1. Collect outputs
2. Call user's `eval_script:eval_function(outputs: dict[str, str]) -> dict`
3. Function returns the same score format: `{"scores": [{"competitor": "id", ...}]}`

---

## Python API

```python
from tournament import Tournament, TournamentConfig

# From YAML config
config = TournamentConfig.from_yaml("tournament.yaml")
t = Tournament(config)
result = t.run()

# Programmatic
t = Tournament(
    prompt="Write a Python function that parses CSV files.",
    competitors=["claude", "codex", "gemini"],
    strategy="semantic",
    factors={"correctness": 2.0, "completeness": 1.5, "quality": 1.0},
)
result = t.run()

# Result
print(result.winner)          # "claude"
print(result.winner_score)    # 8.7
print(result.scores)          # {"claude": {...}, "codex": {...}, "gemini": {...}}
print(result.artifacts)       # {"claude": "def parse_csv...", "codex": "...", ...}
print(result.audit)           # full audit dict
```

### Integration with `generate_skill_docs.py`

After the tournament module exists, `generate_skill_docs.py` refactors to use it:

```python
from tournament import Tournament

t = Tournament(
    prompt=build_generation_prompt(skill, audience, css),
    competitors=["claude", "codex", "gemini"],
    strategy="visual",
    factors=FACTOR_WEIGHTS,
    screenshot_command="npx playwright screenshot --full-page {html_path} {png_path}",
)
result = t.run()
winner_html = result.artifacts[result.winner]
```

This replaces ~200 lines of tournament-specific code in `generate_skill_docs.py` with a 10-line integration.

---

## CLI

```
scripts/tournament.py [options] [prompt]

Options:
  --config FILE         Tournament config YAML file
  --prompt TEXT          Prompt template (alternative to --config)
  --competitors LIST    Comma-separated competitor IDs (default: claude,codex,gemini)
  --strategy TYPE       Evaluation strategy: visual|semantic|test|custom (default: semantic)
  --factors SPEC        Factor weights: "correctness:2,completeness:1.5,quality:1"
  --judge MODEL         Judge model (default: claude-sonnet-4-6)
  --output-dir DIR      Where to save artifacts (default: /tmp/tournament-{timestamp})
  --audit-file FILE     JSONL audit file (default: tournament-results.jsonl)
  --keep-all            Keep all competitor artifacts, not just winner
  --dry-run             Show what would run without executing
  --json                Output result as JSON to stdout
  --timeout SECONDS     Per-competitor timeout (default: 300)
  --workers N           Max parallel workers (default: 6)
  --retries N           Retry failed competitors (default: 1)
  --variables KEY=VAL   Variable substitution in prompt template (repeatable)
```

### Examples

```bash
# Simple: 3 LLMs compete on a coding task
python scripts/tournament.py "Write a function that validates email addresses"

# Visual: HTML generation competition
python scripts/tournament.py --strategy visual \
  --prompt "Generate an HTML dashboard showing server metrics" \
  --factors "visual_clarity:1,accuracy:1.5,design_quality:0.5"

# Test-driven: code competition judged by test suite
python scripts/tournament.py --strategy test \
  --config tournament-csv-parser.yaml

# From YAML config (full control)
python scripts/tournament.py --config tournament.yaml

# Prompt variant competition (same LLM, different prompts)
python scripts/tournament.py --config prompt-variants.yaml
```

---

## Prompt Variant Competitions

A key use case: testing different prompt wordings through the same model. The config supports this via `prompt_override`:

```yaml
competitors:
  - id: concise
    agent: claude
    prompt_override: |
      Be concise. {base_prompt}
  - id: detailed
    agent: claude
    prompt_override: |
      Be thorough and detailed. Include edge cases. {base_prompt}
  - id: structured
    agent: claude
    prompt_override: |
      Structure your response with clear sections. {base_prompt}
```

All three use Claude, but with different prompt wrappings. The judge evaluates which prompt style produces better output for the given task. This is directly useful for tuning review prompts (`/stark-review-improvement`).

---

## Audit Trail

Each run appends a JSONL entry:

```json
{
  "schema_version": 1,
  "timestamp": "2026-03-25T12:00:00Z",
  "prompt_hash": "sha256:abc123",
  "strategy": "semantic",
  "competitors": ["claude", "codex", "gemini"],
  "judge_model": "claude-sonnet-4-6",
  "results": {
    "claude": {
      "duration_s": 12.3,
      "output_length": 1523,
      "scores": {"correctness": 9, "completeness": 8, "quality": 8},
      "weighted_avg": 8.5
    },
    "codex": {
      "duration_s": 18.7,
      "output_length": 2104,
      "scores": {"correctness": 8, "completeness": 9, "quality": 7},
      "weighted_avg": 8.1
    },
    "gemini": {
      "duration_s": 15.2,
      "output_length": 1847,
      "scores": {"correctness": 7, "completeness": 7, "quality": 9},
      "weighted_avg": 7.5
    }
  },
  "winner": "claude",
  "winner_score": 8.5,
  "tie_break_used": false,
  "errors": [],
  "config_hash": "sha256:def456"
}
```

---

## Winner Selection Algorithm

Same as `generate_skill_docs.py`, generalized:

```python
def select_winner(scores: dict[str, dict[str, float]], weights: dict[str, float]) -> tuple[str, float]:
    """Select winner by weighted average. Tie-break: highest 'correctness' (or first factor), then random."""
    weighted_avgs = {}
    for competitor, factor_scores in scores.items():
        total = sum(factor_scores.get(f, 0) * w for f, w in weights.items())
        weight_sum = sum(w for f, w in weights.items() if f in factor_scores)
        weighted_avgs[competitor] = total / weight_sum if weight_sum else 0.0

    max_score = max(weighted_avgs.values())
    tied = [c for c, s in weighted_avgs.items() if s == max_score]

    if len(tied) == 1:
        return tied[0], max_score

    # Tie-break: highest score on the first (heaviest) factor
    primary_factor = max(weights, key=weights.get)
    primary_scores = {c: scores[c].get(primary_factor, 0) for c in tied}
    max_primary = max(primary_scores.values())
    primary_tied = [c for c, s in primary_scores.items() if s == max_primary]

    if len(primary_tied) == 1:
        return primary_tied[0], max_score

    return random.choice(primary_tied), max_score
```

---

## Skill Definition

The `/stark-tournament` skill wraps the Python module for conversational use:

```
/stark-tournament "prompt text"
/stark-tournament --config tournament.yaml
/stark-tournament --strategy test --prompt "Write merge sort" --test-file tests/test_sort.py
```

The skill:
1. Parses arguments (inline prompt or --config)
2. Shows the competition setup (competitors, strategy, factors)
3. Dispatches all competitors in parallel
4. Shows progress per competitor (real-time)
5. Runs evaluation
6. Displays results table with scores per factor
7. Declares winner with score
8. Saves audit entry

---

## Relationship to Existing Code

### Code to Extract from `generate_skill_docs.py`

These functions move into `scripts/tournament.py`:

| Current location | New location | Function |
|-----------------|-------------|----------|
| `generate_skill_docs.py:_run_viz_agent` | `tournament.py:_dispatch_competitor` | CLI dispatch (claude/codex/gemini) |
| `generate_skill_docs.py:run_evaluation` | `tournament.py:_evaluate_visual` | Anthropic SDK image evaluation |
| `generate_skill_docs.py:build_evaluation_prompt` | `tournament.py:_build_eval_prompt` | Evaluation prompt construction |
| `generate_skill_docs.py:parse_evaluation_scores` | `tournament.py:_parse_scores` | JSON score extraction |
| `generate_skill_docs.py:compute_weighted_average` | `tournament.py:compute_weighted_average` | Weighted average |
| `generate_skill_docs.py:select_winner` | `tournament.py:select_winner` | Winner selection with tie-break |
| `generate_skill_docs.py:write_audit_entry` | `tournament.py:write_audit_entry` | JSONL audit |
| `generate_skill_docs.py:screenshot_html` | `tournament.py:screenshot_html` | Playwright screenshot |

After extraction, `generate_skill_docs.py` imports from `tournament.py` instead of defining these functions inline. The generate_skill_docs module retains: parser, content-specific prompt building, markdown generation, staleness detection, and the main orchestrator. Tournament mechanics move out.

### Shared Infrastructure

- CLI dispatch patterns (claude/codex/gemini subprocess calls) — shared with `multi_review.py` and `plan_review_dispatch.py`. Eventually should be a shared `llm_dispatch.py` module, but that's a separate refactor.
- Gemini auth (tmpdir trick, API key fallback) — duplicated across 3 files. Tournament extraction is a step toward consolidation.

---

## Migration

### Phase 1: Extract tournament module

Create `scripts/tournament.py` with the generalized tournament engine. Extract shared functions from `generate_skill_docs.py`. Both old and new code work — `generate_skill_docs.py` imports from `tournament.py`.

### Phase 2: Add evaluation strategies

The visual strategy exists (extracted from generate_skill_docs.py). Add semantic and test strategies.

### Phase 3: CLI and config

Add the CLI argument parser, YAML config loading, and the `Tournament` class API.

### Phase 4: Skill definition

Create `skill/stark-tournament/SKILL.md`.

### Phase 5: Refactor generate_skill_docs.py

Replace inline tournament code with `Tournament` import. Verify all 45 tests still pass.

---

## Open Questions

1. **Should the judge be configurable beyond model selection?** E.g., custom judge prompts, judge temperature, number of judge passes (majority vote from 3 judge calls?). For v1: model selection only. Custom judge prompts in v2.

2. **Should tournament results feed into `/stark-metrics`?** The audit JSONL could be consumed by the metrics skill to show agent performance trends over time. Useful but not blocking — the audit format is already compatible.

3. **Should there be a "league" mode?** Run the same tournament N times and aggregate results to reduce variance. Single-run variance is high (one good/bad response can swing the result). For v1: single run. League mode in v2.

4. **How to handle heterogeneous output formats?** If Claude returns markdown and Codex returns JSON for the same prompt, the evaluator needs to normalize. For v1: competitors are expected to produce the same format (enforced by the prompt). Normalization in v2.
