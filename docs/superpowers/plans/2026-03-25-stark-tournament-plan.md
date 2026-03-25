# `/stark-tournament` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the tournament pattern from `generate_skill_docs.py` into a reusable `scripts/tournament.py` module with visual, semantic, and test evaluation strategies, YAML config support, CLI, and a `/stark-tournament` skill.

**Architecture:** Extract 8 functions from `generate_skill_docs.py` into `tournament.py`. Add `TournamentConfig` (YAML loader), `TournamentResult` (dataclass), `Tournament` (orchestrator class). The `generate_skill_docs.py` module then imports from `tournament.py` instead of defining tournament logic inline.

**Tech Stack:** Python 3.11+, ThreadPoolExecutor, Anthropic SDK (evaluation), PyYAML (config), subprocess (CLI dispatch), Playwright (visual strategy)

**Spec:** `docs/superpowers/specs/2026-03-25-stark-tournament-design.md`

**Deferred to v2:** Custom evaluation strategy (`eval_script` + `importlib` loading). The MVP delivers visual, semantic, and test strategies. Custom is additive — no other component depends on it.

**Quality flag values:** `"good"` (winner_score ≥ 7), `"acceptable"` (≥ 5), `"poor"` (< 5), `"degraded"` (single survivor), `"all_failed"` (no survivors), `"eval_failed"` (judge error, first-valid fallback).

---

### Task 1: Extract Core Tournament Functions into `tournament.py`

**Files:**
- Create: `scripts/tournament.py`
- Create: `scripts/test_tournament.py`
- Modify: `scripts/generate_skill_docs.py` (replace inline functions with imports)

Extract these 8 functions from `generate_skill_docs.py` into `tournament.py`, keeping the exact same logic:

| From `generate_skill_docs.py` | To `tournament.py` |
|------|------|
| `_run_viz_agent` | `dispatch_competitor` |
| `run_evaluation` | `evaluate_visual` |
| `build_evaluation_prompt` | `build_eval_prompt` |
| `parse_evaluation_scores` | `parse_scores` |
| `compute_weighted_average` | `compute_weighted_average` |
| `select_winner` | `select_winner` |
| `write_audit_entry` | `write_audit_entry` |
| `screenshot_html` | `screenshot_html` |

Also extract: `FACTOR_WEIGHTS`, `AGENTS`, `_audit_lock`, `_unescape_json_string`, `_parse_viz_response`, `_load_css`, `_get_gemini_api_key`, `_gemini_api_key_cache`, `CODEX_REASONING_CONFIG`.

- [ ] **Step 1: Write failing tests**

```python
"""Tests for tournament.py — extracted tournament engine."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


def test_compute_weighted_average():
    from tournament import compute_weighted_average
    scores = {"correctness": 8, "completeness": 9, "quality": 7}
    weights = {"correctness": 2.0, "completeness": 1.5, "quality": 1.0}
    avg = compute_weighted_average(scores, weights)
    expected = (8*2 + 9*1.5 + 7*1) / (2 + 1.5 + 1)
    assert abs(avg - expected) < 0.01


def test_select_winner_clear():
    from tournament import select_winner
    scores = {"claude": {"correctness": 9}, "codex": {"correctness": 7}}
    weights = {"correctness": 1.0}
    winner, score = select_winner(scores, weights)
    assert winner == "claude"


def test_select_winner_tie_break():
    from tournament import select_winner
    scores = {
        "claude": {"correctness": 9, "quality": 7},
        "codex": {"correctness": 7, "quality": 9},
    }
    # Both avg to 8.33 with equal weights
    weights = {"correctness": 1.0, "quality": 1.0}
    winner, _ = select_winner(scores, weights)
    # correctness has weight 1.0 = quality 1.0, so first factor alphabetically?
    # Actually max(weights, key=weights.get) picks one. Both are 1.0.
    # With equal primary, falls to random. Either is valid.
    assert winner in ("claude", "codex")


def test_select_winner_float_tie():
    """Verify float comparison uses epsilon, not ==."""
    from tournament import select_winner
    scores = {
        "a": {"f1": 8.0},
        "b": {"f1": 8.000000001},  # within 0.01 epsilon
    }
    weights = {"f1": 1.0}
    winner, _ = select_winner(scores, weights)
    # Both should be considered tied
    assert winner in ("a", "b")


def test_parse_scores():
    from tournament import parse_scores
    raw = '{"scores": [{"competitor": "claude", "correctness": 9, "quality": 8}]}'
    result = parse_scores(raw)
    assert len(result) == 1
    assert result[0]["competitor"] == "claude"


def test_write_audit_entry(tmp_path):
    from tournament import write_audit_entry
    audit_path = tmp_path / "audit.jsonl"
    write_audit_entry(audit_path, {"winner": "claude", "score": 8.5})
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["winner"] == "claude"
    assert "timestamp" in parsed


def test_unescape_json_string():
    from tournament import unescape_json_string
    escaped = '<html lang=\\"en\\">\\n<head>\\n</head>\\n</html>'
    result = unescape_json_string(escaped)
    assert "\\n" not in result
    assert "\n" in result
    assert '\\"' not in result


def test_unescape_json_string_passthrough():
    from tournament import unescape_json_string
    normal = '<html lang="en">\n<head>\n</head>\n</html>'
    assert unescape_json_string(normal) == normal
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python -m pytest scripts/test_tournament.py -v
```

Expected: ImportError

- [ ] **Step 3: Create `tournament.py` by extracting functions from `generate_skill_docs.py`**

Copy the 8 functions + helpers into `tournament.py`. Update function signatures to be more generic (e.g., `dispatch_competitor` takes agent config instead of hardcoded skill params). Keep the exact same logic — this is a pure extraction, not a refactor.

Important: `_unescape_json_string` becomes `unescape_json_string` (public, since generate_skill_docs.py still needs it).

**Security:** `dispatch_competitor` must pass all prompt content via stdin (for claude/codex) or `-p` flag (for gemini), never interpolated into shell commands. This is already the pattern in the extracted code — preserve it.

- [ ] **Step 4: Update `generate_skill_docs.py` to import from `tournament.py`**

Replace the inline function definitions with imports:

```python
from tournament import (
    dispatch_competitor, evaluate_visual, build_eval_prompt,
    parse_scores, compute_weighted_average, select_winner,
    write_audit_entry, screenshot_html, unescape_json_string,
    FACTOR_WEIGHTS, AGENTS,
)
```

Remove the extracted function bodies from `generate_skill_docs.py`. Keep the `_parse_viz_response` function in `generate_skill_docs.py` since it's specific to viz output parsing (calls `unescape_json_string` from tournament).

- [ ] **Step 5: Run ALL existing tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py scripts/test_tournament.py -v
```

Expected: All 45 generate_skill_docs tests + new tournament tests PASS. This is the critical gate — extraction must not break anything.

- [ ] **Step 6: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py scripts/generate_skill_docs.py
git commit -m "refactor: extract tournament engine from generate_skill_docs.py into tournament.py"
```

---

### Task 2: `TournamentConfig` and `TournamentResult` Dataclasses

**Files:**
- Modify: `scripts/tournament.py`
- Modify: `scripts/test_tournament.py`

Add the config and result data structures that the `Tournament` class will use.

- [ ] **Step 1: Write failing tests**

```python
def test_tournament_config_from_dict():
    from tournament import TournamentConfig
    config = TournamentConfig.from_dict({
        "prompt_template": "Write a function that {task}",
        "competitors": [{"id": "claude", "agent": "claude"}],
        "evaluation": {"strategy": "semantic", "judge": "claude-sonnet-4-6",
                        "factors": {"correctness": {"weight": 2.0}}},
    })
    assert config.prompt_template == "Write a function that {task}"
    assert len(config.competitors) == 1
    assert config.evaluation.strategy == "semantic"


def test_tournament_config_from_yaml(tmp_path):
    from tournament import TournamentConfig
    yaml_file = tmp_path / "tournament.yaml"
    yaml_file.write_text("""
schema_version: 1
prompt_template: "Test prompt"
competitors:
  - id: claude
    agent: claude
evaluation:
  strategy: semantic
  judge: claude-sonnet-4-6
  factors:
    correctness:
      weight: 2.0
""")
    config = TournamentConfig.from_yaml(str(yaml_file))
    assert config.prompt_template == "Test prompt"
    assert config.evaluation.strategy == "semantic"


def test_tournament_config_validates_schema_version(tmp_path):
    from tournament import TournamentConfig
    import pytest
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text("schema_version: 99\nprompt_template: x\n")
    with pytest.raises(ValueError, match="schema_version"):
        TournamentConfig.from_yaml(str(yaml_file))


def test_tournament_config_defaults():
    from tournament import TournamentConfig
    config = TournamentConfig.from_dict({"prompt_template": "Test"})
    assert len(config.competitors) == 3  # claude, codex, gemini
    assert config.evaluation.strategy == "semantic"
    assert config.execution.max_workers == 6
    assert config.execution.timeout_seconds == 300


def test_tournament_config_prompt_override():
    from tournament import TournamentConfig
    config = TournamentConfig.from_dict({
        "prompt_template": "Base prompt: {task}",
        "variables": {"task": "write hello"},
        "competitors": [
            {"id": "concise", "agent": "claude", "prompt_override": "Be concise. {base_prompt}"},
            {"id": "detailed", "agent": "claude", "prompt_override": "Be detailed. {base_prompt}"},
        ],
        "evaluation": {"strategy": "semantic", "factors": {"correctness": {"weight": 1.0}}},
    })
    assert config.competitors[0].prompt_override is not None
    assert "concise" in config.competitors[0].prompt_override
    # Resolved prompt should substitute {base_prompt} with the resolved template
    resolved = config.resolve_prompt(config.competitors[0])
    assert "Be concise" in resolved
    assert "write hello" in resolved


def test_tournament_result_structure():
    from tournament import TournamentResult
    result = TournamentResult(
        winner="claude", winner_score=8.5,
        scores={"claude": {"correctness": 9}},
        artifacts={"claude": "def foo(): pass"},
        audit={"timestamp": "2026-03-25"},
        quality_flag="good",
    )
    assert result.winner == "claude"
    assert result.winner_score == 8.5
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_tournament.py -k "config or result" -v
```

- [ ] **Step 3: Implement TournamentConfig and TournamentResult**

`TournamentConfig`: nested dataclasses for competitors, evaluation, execution, output settings. `from_yaml()` loads YAML via `yaml.safe_load`, validates `schema_version == 1`, fills defaults. `from_dict()` does the same from a dict. Variable substitution in `prompt_template` uses `str.format_map()` with `variables` dict.

`TournamentResult`: dataclass with winner, winner_score, scores, artifacts, audit, quality_flag fields.

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_tournament.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: TournamentConfig (YAML + dict) and TournamentResult dataclasses"
```

---

### Task 3: `Tournament` Orchestrator Class — Semantic Strategy

**Files:**
- Modify: `scripts/tournament.py`
- Modify: `scripts/test_tournament.py`

The `Tournament` class ties everything together: config → dispatch competitors → collect outputs → evaluate → pick winner → audit.

- [ ] **Step 1: Write failing tests**

```python
def test_tournament_semantic_mock(monkeypatch):
    """Test Tournament.run() with mocked LLM dispatch."""
    from tournament import Tournament, TournamentConfig

    # Mock dispatch_competitor to return canned outputs
    def mock_dispatch(agent, prompt, **kwargs):
        return {"output": f"Mock output from {agent}", "error": None, "duration_s": 1.0}
    monkeypatch.setattr("tournament.dispatch_competitor", mock_dispatch)

    # Mock evaluate_semantic to return canned scores
    def mock_evaluate(prompt, outputs, factors, judge_model):
        return {
            "scores": {comp: {f: 8.0 for f in factors} for comp in outputs},
            "raw": "mock",
        }
    monkeypatch.setattr("tournament.evaluate_semantic", mock_evaluate)

    config = TournamentConfig.from_dict({
        "prompt_template": "Write hello world",
        "competitors": [
            {"id": "claude", "agent": "claude"},
            {"id": "codex", "agent": "codex"},
        ],
        "evaluation": {"strategy": "semantic", "judge": "claude-sonnet-4-6",
                        "factors": {"correctness": {"weight": 1.0}}},
    })
    t = Tournament(config)
    result = t.run()
    assert result.winner in ("claude", "codex")
    assert result.winner_score > 0
    assert len(result.artifacts) == 2
    assert result.quality_flag in ("good", "acceptable")


def test_tournament_all_fail(monkeypatch):
    """When all competitors fail, tournament fails."""
    from tournament import Tournament, TournamentConfig

    def mock_dispatch(agent, prompt, **kwargs):
        return {"output": "", "error": "timeout", "duration_s": 300}
    monkeypatch.setattr("tournament.dispatch_competitor", mock_dispatch)

    config = TournamentConfig.from_dict({
        "prompt_template": "Test",
        "competitors": [{"id": "a", "agent": "claude"}, {"id": "b", "agent": "codex"}],
        "evaluation": {"strategy": "semantic", "factors": {"correctness": {"weight": 1.0}}},
    })
    t = Tournament(config)
    result = t.run()
    assert result.winner is None
    assert result.quality_flag == "all_failed"


def test_tournament_eval_failure_fallback(monkeypatch):
    """When evaluation fails, fall back to first-valid with eval_failed flag."""
    from tournament import Tournament, TournamentConfig

    def mock_dispatch(agent, prompt, **kwargs):
        return {"output": f"Output from {agent}", "error": None, "duration_s": 1.0}
    monkeypatch.setattr("tournament.dispatch_competitor", mock_dispatch)

    def mock_evaluate(*args, **kwargs):
        raise RuntimeError("Judge model unavailable")
    monkeypatch.setattr("tournament.evaluate_semantic", mock_evaluate)

    config = TournamentConfig.from_dict({
        "prompt_template": "Test",
        "competitors": [{"id": "a", "agent": "claude"}, {"id": "b", "agent": "codex"}],
        "evaluation": {"strategy": "semantic", "factors": {"correctness": {"weight": 1.0}}},
    })
    t = Tournament(config)
    result = t.run()
    assert result.winner == "a"  # first valid
    assert result.quality_flag == "eval_failed"


def test_tournament_single_survivor(monkeypatch):
    """When only one competitor succeeds, it wins by default with degraded flag."""
    from tournament import Tournament, TournamentConfig

    call_count = {"n": 0}
    def mock_dispatch(agent, prompt, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"output": "good output", "error": None, "duration_s": 5}
        return {"output": "", "error": "failed", "duration_s": 1}
    monkeypatch.setattr("tournament.dispatch_competitor", mock_dispatch)

    config = TournamentConfig.from_dict({
        "prompt_template": "Test",
        "competitors": [{"id": "a", "agent": "claude"}, {"id": "b", "agent": "codex"}],
        "evaluation": {"strategy": "semantic", "factors": {"correctness": {"weight": 1.0}}},
    })
    t = Tournament(config)
    result = t.run()
    assert result.winner == "a"
    assert result.quality_flag == "degraded"
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_tournament.py -k "tournament" -v
```

- [ ] **Step 3: Implement `Tournament` class and `evaluate_semantic`**

`Tournament.__init__(config)` stores config.
`Tournament.run()`:
1. Resolve prompt (substitute variables into template)
2. Dispatch all competitors via ThreadPoolExecutor
3. Collect successful outputs, disqualify failures
4. If 0 succeed → return failed result
5. If 1 survives → return degraded result (skip evaluation)
6. Evaluate via the configured strategy
7. Select winner
8. Write audit entry
9. Return TournamentResult

`evaluate_semantic(prompt, outputs, factors, judge_model)`:
1. Build evaluation prompt with labeled text blocks
2. Call Anthropic SDK (same pattern as `evaluate_visual` but text instead of images)
3. Parse scores
4. Return scores dict

- [ ] **Step 4: Run all tests**

```bash
python -m pytest scripts/test_tournament.py scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: Tournament orchestrator class with semantic evaluation strategy"
```

---

### Task 4: Test Evaluation Strategy

**Files:**
- Modify: `scripts/tournament.py`
- Modify: `scripts/test_tournament.py`

Add the `test` evaluation strategy: run LLM-generated code against a user-provided test file.

- [ ] **Step 1: Write failing tests**

```python
def test_evaluate_test_strategy(tmp_path):
    from tournament import evaluate_test

    # Create a test file
    test_file = tmp_path / "test_add.py"
    test_file.write_text("""
def test_add():
    from impl import add
    assert add(1, 2) == 3
    assert add(0, 0) == 0
    assert add(-1, 1) == 0
""")

    outputs = {
        "good": "def add(a, b):\n    return a + b\n",
        "bad": "def add(a, b):\n    return a * b\n",
    }

    results = evaluate_test(outputs, str(test_file), tmp_path)
    assert results["good"]["pass_rate"] > results["bad"]["pass_rate"]


def test_evaluate_test_timeout(tmp_path):
    from tournament import evaluate_test

    test_file = tmp_path / "test_hang.py"
    test_file.write_text("def test_ok():\n    assert True\n")

    outputs = {"looper": "import time\nwhile True: time.sleep(1)\n"}

    results = evaluate_test(outputs, str(test_file), tmp_path, timeout=3)
    assert results["looper"]["pass_rate"] == 0
    assert "timeout" in results["looper"].get("error", "").lower()
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement `evaluate_test`**

For each competitor:
1. Write the output code to `{tmp_dir}/{competitor_id}/impl.py`
2. Run `python -m pytest {test_file} -v --timeout={timeout}` in a subprocess with cwd set to the competitor's dir
3. Parse pytest output for pass/fail counts
4. Score: `pass_rate = passed / total * 10` (scale to 0-10)
5. Optionally run Claude quality review on the code for additional factor scores

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_tournament.py -k "test_strategy" -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: test evaluation strategy — run LLM code against user test suite"
```

---

### Task 5: CLI + YAML Config Loading

**Files:**
- Modify: `scripts/tournament.py` (add `main()` and CLI arg parser)
- Modify: `scripts/test_tournament.py`

- [ ] **Step 1: Write failing tests**

```python
def test_cli_help():
    import subprocess
    result = subprocess.run(
        ["python", "scripts/tournament.py", "--help"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "--config" in result.stdout
    assert "--strategy" in result.stdout


def test_cli_dry_run(tmp_path):
    import subprocess
    result = subprocess.run(
        ["python", "scripts/tournament.py", "--dry-run",
         "--prompt", "Write hello world",
         "--competitors", "claude,codex"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "Would dispatch" in result.stdout or "dry" in result.stdout.lower()
```

- [ ] **Step 2: Implement CLI**

Add `main()` with argparse. Flags: `--config`, `--prompt`, `--competitors`, `--strategy`, `--factors`, `--judge`, `--output-dir`, `--audit-file`, `--keep-all`, `--dry-run`, `--json`, `--timeout`, `--workers`, `--retries`, `--variables`. Inline args build a TournamentConfig; `--config` loads from YAML.

- [ ] **Step 3: Run tests**

```bash
python -m pytest scripts/test_tournament.py -v
```

- [ ] **Step 4: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: tournament CLI with YAML config and inline arguments"
```

---

### Task 6: `/stark-tournament` Skill Definition

**Files:**
- Create: `skill/stark-tournament/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

The skill wraps `scripts/tournament.py` for conversational use in Claude Code.

Arguments: `/stark-tournament "prompt"` or `/stark-tournament --config tournament.yaml`

Workflow:
1. Parse arguments (inline prompt or --config path)
2. Show competition setup: competitors, strategy, factors, timeout
3. Dispatch via `python $ROOT/scripts/tournament.py [args]`
4. Display results table: competitor × factor scores, weighted avg, winner
5. Declare winner with score and quality flag
6. Report audit file location

Output format example:
```
Tournament: 3 competitors × semantic evaluation
  ┌──────────┬─────────────┬──────────────┬─────────┬─────────┐
  │ Competitor│ Correctness │ Completeness │ Quality │ Avg     │
  ├──────────┼─────────────┼──────────────┼─────────┼─────────┤
  │ claude   │ 9           │ 8            │ 8       │ 8.5 ★   │
  │ codex    │ 8           │ 9            │ 7       │ 8.1     │
  │ gemini   │ 7           │ 7            │ 9       │ 7.5     │
  └──────────┴─────────────┴──────────────┴─────────┴─────────┘
  Winner: claude (8.5/10) · Quality: good
```

Failure modes: competitor failure → disqualify, all fail → error, judge fail → first-valid fallback

- [ ] **Step 2: Verify install**

```bash
./install.sh && ls -la ~/.claude/skills/stark-tournament/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add skill/stark-tournament/SKILL.md
git commit -m "feat: /stark-tournament skill for multi-LLM competition"
```

---

### Task 7: Update CLAUDE.md + README + Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add /stark-tournament to CLAUDE.md skills table**

- [ ] **Step 2: Add to README.md Analytics section**

- [ ] **Step 3: Generate skill docs**

```bash
python scripts/generate_skill_docs.py --skill stark-tournament --force
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md docs/skills/
git commit -m "docs: add /stark-tournament to skills tables and generate docs"
```

---

### Task 8: Refactor `generate_skill_docs.py` to Use Tournament API

**Files:**
- Modify: `scripts/generate_skill_docs.py`

Replace the raw function calls with the `Tournament` class API. This is the final integration step.

- [ ] **Step 1: Refactor the main orchestrator's LLM dispatch + evaluation loop**

Replace the ~200 lines of inline tournament logic in `main()` (the ThreadPoolExecutor dispatch, candidate processing, evaluation, winner stamping) with:

```python
from tournament import Tournament, TournamentConfig

for skill_name, sd in skill_data_map.items():
    for audience in AUDIENCES:
        config = TournamentConfig.from_dict({
            "prompt_template": build_generation_prompt(sd, audience, css),
            "evaluation": {
                "strategy": "visual",
                "factors": {k: {"weight": v} for k, v in FACTOR_WEIGHTS.items()},
            },
            "execution": {"max_workers": MAX_WORKERS, "timeout_seconds": 900},
        })
        t = Tournament(config)
        result = t.run()
        # Use result.winner, result.artifacts, result.scores, result.audit
```

- [ ] **Step 2: Run ALL tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py scripts/test_tournament.py -v
```

All 45 generate_skill_docs tests must still pass. This is the critical gate.

- [ ] **Step 3: Verify E2E — regenerate one skill**

```bash
python scripts/generate_skill_docs.py --skill stark-metrics --force
```

Verify output matches expectations: HTML, PNG, Mermaid, markdown, audit.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate_skill_docs.py
git commit -m "refactor: generate_skill_docs uses Tournament API — net -150 lines"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Full test suite**

```bash
python -m pytest scripts/test_tournament.py scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 2: Staleness check**

```bash
python scripts/generate_skill_docs.py --check
```

- [ ] **Step 3: Install check**

```bash
./install.sh --status
```

- [ ] **Step 4: CLI smoke test**

```bash
python scripts/tournament.py --dry-run --prompt "Write a Python hello world" --competitors claude,codex
```
