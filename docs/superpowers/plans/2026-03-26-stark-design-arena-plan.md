# `/stark-design-arena` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 3-phase competitive pipeline: collaborative brainstorm → design tournament with cross-evaluation → plan tournament with cross-evaluation. HTML side-by-side visualizations. Human picks the winner at each gate.

**Architecture:** Single Python module `scripts/design_arena.py` with 3 phase orchestrators. Reuses `tournament.py` for LLM dispatch, scoring, and audit. New: cross-evaluation (6 pairs instead of single-judge), question deduplication, HTML comparison generator, interactive question flow.

**Tech Stack:** Python 3.11+, ThreadPoolExecutor, Anthropic SDK (cross-evaluation), tournament.py (dispatch + scoring), Playwright (HTML→PNG), PyYAML

**Spec:** `docs/superpowers/specs/2026-03-26-stark-design-arena-design.md`

**Dependencies:** Requires `scripts/tournament.py` from the `/stark-tournament` plan. If tournament.py doesn't exist yet, Task 1 includes the minimal dispatch and scoring functions needed (extracted later when tournament ships).

---

### Task 1: Arena Core — LLM Dispatch + Cross-Evaluation Engine

**Files:**
- Create: `scripts/design_arena.py`
- Create: `scripts/test_design_arena.py`

The foundation: dispatch prompts to 3 LLMs in parallel, collect outputs, run cross-evaluation (each LLM scores the other 2), aggregate scores, rank results.

- [ ] **Step 1: Write failing tests**

```python
"""Tests for design_arena.py — cross-evaluation and scoring."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from design_arena import (
    cross_evaluate, aggregate_scores, rank_results,
    dispatch_to_agents, DESIGN_FACTORS, PLAN_FACTORS,
)


def test_cross_evaluate_structure(monkeypatch):
    """Cross-evaluation produces 6 pairs (3 agents, each scores other 2)."""
    call_log = []
    def mock_evaluate(evaluator, target_agent, target_content, factors, prompt_context):
        call_log.append((evaluator, target_agent))
        return {f: {"score": 8, "reason": "Good"} for f in factors}
    monkeypatch.setattr("design_arena._evaluate_one", mock_evaluate)

    designs = {"claude": "Design A", "codex": "Design B", "gemini": "Design C"}
    results = cross_evaluate(designs, DESIGN_FACTORS, prompt_context="test")
    assert len(call_log) == 6
    # No self-scoring
    for evaluator, target in call_log:
        assert evaluator != target


def test_cross_evaluate_no_self_scoring(monkeypatch):
    def mock_evaluate(evaluator, target_agent, target_content, factors, prompt_context):
        return {f: {"score": 7, "reason": "OK"} for f in factors}
    monkeypatch.setattr("design_arena._evaluate_one", mock_evaluate)

    designs = {"claude": "A", "codex": "B", "gemini": "C"}
    results = cross_evaluate(designs, DESIGN_FACTORS, prompt_context="test")
    for target_agent, evals in results.items():
        for evaluator in evals:
            assert evaluator != target_agent


def test_aggregate_scores():
    evals = {
        "claude": {
            "codex": {"arch": {"score": 8, "reason": "x"}, "completeness": {"score": 9, "reason": "y"}},
            "gemini": {"arch": {"score": 7, "reason": "x"}, "completeness": {"score": 8, "reason": "y"}},
        },
        "codex": {
            "claude": {"arch": {"score": 9, "reason": "x"}, "completeness": {"score": 7, "reason": "y"}},
            "gemini": {"arch": {"score": 6, "reason": "x"}, "completeness": {"score": 8, "reason": "y"}},
        },
    }
    weights = {"arch": 2.0, "completeness": 1.5}
    scores = aggregate_scores(evals, weights)
    assert "claude" in scores
    assert "codex" in scores
    assert scores["claude"]["weighted_avg"] > 0
    # Claude: avg(8,7)=7.5 arch, avg(9,8)=8.5 completeness
    # weighted: (7.5*2 + 8.5*1.5) / 3.5 = (15+12.75)/3.5 = 7.93
    assert abs(scores["claude"]["weighted_avg"] - 7.93) < 0.1


def test_rank_results():
    scores = {
        "claude": {"weighted_avg": 8.3, "factors": {}},
        "codex": {"weighted_avg": 7.9, "factors": {}},
        "gemini": {"weighted_avg": 7.7, "factors": {}},
    }
    ranked = rank_results(scores)
    assert ranked[0][0] == "claude"
    assert ranked[1][0] == "codex"
    assert ranked[2][0] == "gemini"


def test_design_factors_have_weights():
    for factor, info in DESIGN_FACTORS.items():
        assert "weight" in info
        assert "description" in info
    assert DESIGN_FACTORS["architecture_fitness"]["weight"] == 2.0


def test_plan_factors_have_weights():
    for factor, info in PLAN_FACTORS.items():
        assert "weight" in info
    assert PLAN_FACTORS["design_fidelity"]["weight"] == 2.0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_design_arena.py -v
```

- [ ] **Step 3: Implement core engine**

Create `scripts/design_arena.py` with:

- `DESIGN_FACTORS` — dict matching spec's design scoring factors with weights
- `PLAN_FACTORS` — dict matching spec's plan scoring factors with weights
- `dispatch_to_agents(prompt, agents, timeout=300)` — parallel dispatch via ThreadPoolExecutor, returns `dict[agent_id, output_text]`. Reuses dispatch patterns from tournament.py or generate_skill_docs.py.
- `_evaluate_one(evaluator, target_agent, target_content, factors, prompt_context)` — single evaluation call via Anthropic SDK. Returns `dict[factor, {score, reason}]`.
- `cross_evaluate(outputs, factors, prompt_context)` — dispatches all 6 evaluation pairs in parallel. Returns `dict[target_agent, dict[evaluator, dict[factor, {score, reason}]]]`.
- `aggregate_scores(evals, factor_weights)` — averages the 2 evaluator scores per factor, computes weighted average. Returns `dict[agent, {weighted_avg, factors, strongest, weakest, evaluator_details}]`.
- `rank_results(scores)` — sorts by weighted_avg descending. Returns `list[tuple[agent, score_dict]]`.

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_design_arena.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: arena core — cross-evaluation engine with 6-pair parallel scoring"
```

---

### Task 2: Phase 1 — Brainstorm (Question Collection + Dedup + Answers)

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Collaborative brainstorm: 3 LLMs generate questions → deduplicate → present one at a time → collect answers → generate requirements brief.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import (
    collect_questions, deduplicate_questions, build_requirements_brief,
    collect_follow_ups,
)


def test_collect_questions_from_agents(monkeypatch):
    def mock_dispatch(prompt, agents, timeout):
        return {
            "claude": '{"questions": ["What scale?", "What stack?"]}',
            "codex": '{"questions": ["What scale?", "Auth model?"]}',
            "gemini": '{"questions": ["Timeline?", "What stack?"]}',
        }
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    raw = collect_questions("Build a notification system")
    assert "claude" in raw
    assert len(raw["claude"]) >= 2


def test_deduplicate_questions(monkeypatch):
    raw = {
        "claude": ["What scale do you expect?", "What tech stack?"],
        "codex": ["What's the expected scale?", "What auth model?"],
        "gemini": ["What's the timeline?", "What technology stack?"],
    }
    # Mock the Claude dedup call
    def mock_dispatch(prompt, agents, timeout):
        return {"claude": '{"questions": ["What scale do you expect?", "What tech stack?", "What auth model?", "What is the timeline?"]}'}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    deduped = deduplicate_questions(raw)
    assert len(deduped) == 4  # 6 raw → 4 deduped
    assert all(isinstance(q, str) for q in deduped)


def test_deduplicate_fallback_on_failure(monkeypatch):
    """If Claude dedup fails, fall back to token-overlap dedup."""
    raw = {
        "claude": ["What scale?", "What stack?"],
        "codex": ["What scale?"],
    }
    def mock_dispatch(prompt, agents, timeout):
        raise RuntimeError("Claude unavailable")
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    deduped = deduplicate_questions(raw)
    # Should still work via fallback, removing exact duplicate
    assert len(deduped) == 2


def test_deduplicate_fuzzy_overlap(monkeypatch):
    """Questions with >60% word overlap should be merged."""
    raw = {
        "claude": ["What scale do you expect?"],
        "codex": ["What is the expected scale?"],
    }
    def mock_dispatch(prompt, agents, timeout):
        raise RuntimeError("Force fallback")
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    deduped = deduplicate_questions(raw)
    assert len(deduped) == 1  # fuzzy match merges them


def test_deduplicate_respects_max_questions(monkeypatch):
    raw = {"claude": [f"Question {i}?" for i in range(15)]}
    def mock_dispatch(prompt, agents, timeout):
        # Claude dedup returns all 15
        return {"claude": json.dumps({"questions": [f"Q{i}?" for i in range(15)]})}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    deduped = deduplicate_questions(raw, max_questions=10)
    assert len(deduped) <= 10


def test_collect_follow_ups(monkeypatch):
    """Follow-up round: LLMs can ask 0-3 more questions based on answers."""
    def mock_dispatch(prompt, agents, timeout):
        return {
            "claude": '{"questions": ["Clarify X?"]}',
            "codex": '{"questions": []}',
            "gemini": '{"questions": ["What about Y?"]}',
        }
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    follow_ups = collect_follow_ups("idea", [("Q1", "A1")], round_num=2)
    assert len(follow_ups) >= 1  # at least one follow-up from the 2 non-empty


def test_collect_follow_ups_all_empty_stops(monkeypatch):
    """When all LLMs return empty follow-ups, brainstorm is complete."""
    def mock_dispatch(prompt, agents, timeout):
        return {a: '{"questions": []}' for a in agents}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    follow_ups = collect_follow_ups("idea", [("Q1", "A1")], round_num=2)
    assert len(follow_ups) == 0


def test_build_requirements_brief():
    questions = ["What scale?", "What stack?", "Auth model?"]
    answers = {0: "10k users", 1: "Python + PostgreSQL", 2: None}  # None = skipped
    brief = build_requirements_brief("Build a notification system", questions, answers)
    assert "notification system" in brief
    assert "10k users" in brief
    assert "Python" in brief
    assert "deferred" in brief.lower() or "skipped" in brief.lower()
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement brainstorm phase**

- `collect_questions(idea, agents=["claude","codex","gemini"])` — dispatch question generation prompt to all 3 agents. Parse JSON `{"questions": [...]}` from each. On malformed response, retry once with stricter prompt, then extract questions via regex fallback.
- `deduplicate_questions(raw_questions)` — send all questions to Claude as coordinator with the dedup prompt from the spec. On failure, fall back to token-overlap deduplication (split questions into word sets, merge questions with >60% word overlap, keep the longer version).
- `build_requirements_brief(idea, questions, answers)` — generate the markdown brief from spec template. Skipped questions noted as "author deferred."

- `collect_follow_ups(idea, qa_pairs, round_num, agents)` — send idea + previous Q&A to all 3 LLMs asking for 0-3 follow-ups. Parse JSON. If all return empty arrays, brainstorm is complete. Hard stop at round 3.
- `deduplicate_questions` accepts `max_questions` parameter (default 12). If Claude's dedup returns more, truncate from the bottom (most specific questions trimmed first).

The question presentation (one at a time) is handled by the skill SKILL.md, not this module. This module provides the data; the skill handles the UX.

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_design_arena.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: brainstorm phase — question collection, dedup, requirements brief"
```

---

### Task 3: Phase 2 — Design Tournament Orchestrator

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Orchestrate the full design tournament: dispatch design prompt to 3 LLMs → cross-evaluate → aggregate → rank.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import run_design_tournament


def test_run_design_tournament_mock(monkeypatch):
    def mock_dispatch(prompt, agents, timeout):
        return {a: f"# Design by {a}\n\nArchitecture section..." for a in agents}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    def mock_cross_eval(outputs, factors, prompt_context):
        result = {}
        for target in outputs:
            result[target] = {}
            for evaluator in outputs:
                if evaluator != target:
                    result[target][evaluator] = {
                        f: {"score": 8, "reason": "Solid"} for f in factors
                    }
        return result
    monkeypatch.setattr("design_arena.cross_evaluate", mock_cross_eval)

    brief = "# Requirements\nBuild a notification system."
    result = run_design_tournament(brief)
    assert "rankings" in result
    assert len(result["rankings"]) == 3
    assert "designs" in result
    assert "evaluations" in result
    assert result["rankings"][0][1]["weighted_avg"] > 0


def test_design_tournament_one_agent_fails(monkeypatch):
    def mock_dispatch(prompt, agents, timeout):
        return {"claude": "# Design A", "codex": "# Design B", "gemini": ""}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    def mock_cross_eval(outputs, factors, prompt_context):
        result = {}
        for target in outputs:
            result[target] = {}
            for evaluator in outputs:
                if evaluator != target:
                    result[target][evaluator] = {f: {"score": 7, "reason": "OK"} for f in factors}
        return result
    monkeypatch.setattr("design_arena.cross_evaluate", mock_cross_eval)

    brief = "# Requirements\nTest."
    result = run_design_tournament(brief)
    # Gemini should be excluded (empty output)
    assert len(result["designs"]) == 2
    assert "gemini" not in result["designs"]
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

`run_design_tournament(brief, agents, factors, timeout)`:
1. Build design prompt from spec template + brief
2. Dispatch to all agents in parallel
3. Filter out empty/failed outputs (disqualify)
4. If 0 succeed → raise error
5. If 1 survives → return degraded result (skip evaluation)
6. Cross-evaluate (6 pairs in parallel)
7. Aggregate scores
8. Rank results
9. Return `{rankings, designs, evaluations, audit_events}`

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: design tournament orchestrator with cross-evaluation"
```

---

### Task 4: Phase 3 — Plan Tournament Orchestrator

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Same pattern as Phase 2 but for plans. The chosen design is passed to all plan creators with authorship stripped.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import run_plan_tournament


def test_run_plan_tournament_strips_authorship(monkeypatch):
    """The chosen design should not reveal which LLM authored it."""
    captured_prompts = []
    def mock_dispatch(prompt, agents, timeout):
        captured_prompts.append(prompt)
        return {a: f"# Plan by {a}" for a in agents}
    monkeypatch.setattr("design_arena.dispatch_to_agents", mock_dispatch)

    def mock_cross_eval(outputs, factors, prompt_context):
        result = {}
        for target in outputs:
            result[target] = {}
            for evaluator in outputs:
                if evaluator != target:
                    result[target][evaluator] = {f: {"score": 8, "reason": "OK"} for f in factors}
        return result
    monkeypatch.setattr("design_arena.cross_evaluate", mock_cross_eval)

    result = run_plan_tournament(
        brief="# Requirements\nTest.",
        chosen_design="# Claude's brilliant design",
        chosen_agent="claude",
    )
    # The prompt sent to agents should NOT contain "Claude" or the agent name
    assert "claude" not in captured_prompts[0].lower()
    assert len(result["rankings"]) == 3
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

`run_plan_tournament(brief, chosen_design, chosen_agent, agents, factors, timeout)`:
1. Strip authorship from `chosen_design` (remove agent name references)
2. Build plan prompt from spec template + brief + anonymized design
3. Same dispatch → cross-evaluate → aggregate → rank pipeline as design tournament but with `PLAN_FACTORS`

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: plan tournament orchestrator with authorship stripping"
```

---

### Task 5: HTML Comparison Visualization

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Generate the side-by-side HTML comparison page with score table, per-evaluator reasoning, expandable design/plan content, and strongest/weakest highlights.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import generate_comparison_html


def test_generate_comparison_html_structure():
    rankings = [
        ("claude", {"weighted_avg": 8.3, "factors": {"arch": 8.5, "completeness": 9.0},
                     "strongest": "architecture", "weakest": "innovation",
                     "evaluator_details": {
                         "codex": {"overall_impression": "Strong design", "avg": 8.1},
                         "gemini": {"overall_impression": "Comprehensive", "avg": 8.5},
                     }}),
        ("codex", {"weighted_avg": 7.9, "factors": {"arch": 7.0, "completeness": 8.5},
                    "strongest": "feasibility", "weakest": "innovation",
                    "evaluator_details": {
                        "claude": {"overall_impression": "Practical", "avg": 7.8},
                        "gemini": {"overall_impression": "Solid", "avg": 8.0},
                    }}),
    ]
    designs = {"claude": "# Claude Design\n\nContent...", "codex": "# Codex Design\n\nContent..."}
    html = generate_comparison_html(rankings, designs, "design", "Test Project")
    assert "<html" in html
    assert "claude" in html.lower()
    assert "codex" in html.lower()
    assert "8.3" in html  # score
    assert "design-system.css" in html or "node-phase" in html  # uses design system


def test_comparison_html_escapes_content():
    """LLM-generated content must be escaped, not rendered as raw HTML."""
    rankings = [("a", {"weighted_avg": 8.0, "factors": {}, "strongest": "", "weakest": "",
                        "evaluator_details": {}})]
    designs = {"a": '<script>alert("xss")</script>'}
    html = generate_comparison_html(rankings, designs, "design", "Test")
    assert "<script>" not in html
    assert "&lt;script&gt;" in html or "alert" not in html
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

`generate_comparison_html(rankings, content_map, phase_type, project_name)`:

Build a single HTML page using the shared design-system CSS. Layout from the spec:
1. Header with project name and phase type
2. Score comparison table (agents as columns, factors as rows)
3. Per-evaluator reasoning section (who said what about each design)
4. Expandable design/plan content (3 columns, escaped text)
5. Strongest/weakest highlights
6. Footer with timestamp

All LLM-generated content is HTML-escaped via `html.escape()`. The page uses the same CSS classes as skill docs visualizations.

Also add `screenshot_comparison(html_path, png_path)` — wrapper around `tournament.screenshot_html` (or direct Playwright call) to generate `comparison.png`. On Playwright failure, skip the PNG (HTML still available). Log the failure.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: HTML comparison visualization — side-by-side with scores and reasoning"
```

---

### Task 6: Artifact Storage + Audit Trail

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Persist all arena artifacts to the directory structure from the spec. Write audit events to JSONL.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import ArenaArtifacts


def test_arena_artifacts_creates_directory(tmp_path):
    artifacts = ArenaArtifacts(tmp_path / "arena-test")
    artifacts.save_idea("Build a thing")
    assert (tmp_path / "arena-test" / "phase-1-brainstorm" / "idea.md").exists()


def test_arena_artifacts_saves_designs(tmp_path):
    artifacts = ArenaArtifacts(tmp_path / "arena-test")
    artifacts.save_designs({"claude": "# Design A", "codex": "# Design B"})
    assert (tmp_path / "arena-test" / "phase-2-design" / "designs" / "claude.md").exists()
    assert (tmp_path / "arena-test" / "phase-2-design" / "designs" / "codex.md").exists()


def test_arena_artifacts_saves_evaluations(tmp_path):
    artifacts = ArenaArtifacts(tmp_path / "arena-test")
    evals = {"claude": {"codex": {"arch": {"score": 8, "reason": "Good"}}}}
    artifacts.save_evaluations(evals, "design")
    assert (tmp_path / "arena-test" / "phase-2-design" / "evaluations" / "codex-scores-claude.json").exists()


def test_audit_trail(tmp_path):
    artifacts = ArenaArtifacts(tmp_path / "arena-test")
    artifacts.log_event("arena_start", idea="test")
    artifacts.log_event("design_generated", agent="claude", duration_s=85)
    audit_file = tmp_path / "arena-test" / "audit.jsonl"
    assert audit_file.exists()
    lines = audit_file.read_text().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["event"] == "arena_start"


def test_meta_json_has_schema_version(tmp_path):
    artifacts = ArenaArtifacts(tmp_path / "arena-test")
    artifacts.save_meta(idea="test", agents=["claude", "codex", "gemini"])
    meta = json.loads((tmp_path / "arena-test" / "meta.json").read_text())
    assert meta["schema_version"] == 1
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement `ArenaArtifacts` class**

Encapsulates all file I/O. Methods: `save_idea()`, `save_questions_raw()`, `save_questions_deduped()`, `save_answers()`, `save_brief()`, `save_designs()`, `save_plans()`, `save_evaluations()`, `save_results()`, `save_comparison_html()`, `save_chosen()`, `save_meta()`, `log_event()`.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: arena artifact storage + JSONL audit trail"
```

---

### Task 7: Main Orchestrator + CLI

**Files:**
- Modify: `scripts/design_arena.py`

Wire everything together: parse CLI args, run Phase 1 → 2 → 3 with human interaction points, save artifacts, print summary.

- [ ] **Step 1: Implement `main()` and `run_arena()`**

`run_arena(idea, output_dir, agents, ...)`:
1. Create ArenaArtifacts
2. Phase 1: collect_questions → deduplicate → (return questions for human answers — the skill handles UX) → build_brief
3. Phase 2: run_design_tournament → generate_comparison_html → screenshot → (return rankings for human choice) → save chosen
4. Phase 3: run_plan_tournament → generate_comparison_html → screenshot → (return rankings for human choice) → save chosen
5. Print improvement flags
6. Print metrics summary

`main()`: argparse with all flags from spec (--idea-file, --output-dir, --skip-brainstorm, --brief, --skip-plan, --resume, --agents, --max-questions, --design-factors, --plan-factors, --cleanup-days, --timeout).

**Resume logic:** `--resume arena-{timestamp}` loads the arena directory, checks which phases completed (by existence of `phase-N-*/results.json` or `phase-N-*/chosen.md`), and restarts from the next incomplete phase. If Phase 1 completed (brief.md exists), skip to Phase 2. If Phase 2 completed (chosen.md exists), skip to Phase 3.

**Cleanup logic:** `--cleanup-days N` scans `{output_dir}/arena-*/meta.json`, parses the timestamp, deletes directories older than N days. Run before the arena starts (if flag provided). No cleanup without the flag.

**Dual timeout:** `--timeout` sets the competitor dispatch timeout (default 300s). Evaluation calls use `timeout * 0.4` (default 120s). Both values logged in the metrics summary.

- [ ] **Step 2: Smoke test**

```bash
python scripts/design_arena.py --help
```

- [ ] **Step 3: Commit**

```bash
git add scripts/design_arena.py
git commit -m "feat: arena main orchestrator + CLI with all flags"
```

---

### Task 8: Prompt Improvement Detection

**Files:**
- Modify: `scripts/design_arena.py`
- Modify: `scripts/test_design_arena.py`

Analyze arena audit data for improvement signals.

- [ ] **Step 1: Write failing tests**

```python
from design_arena import detect_improvement_flags


def test_detect_evaluator_calibration_issue():
    audit_events = [
        {"event": "design_evaluated", "evaluator": "claude", "target": "codex", "avg_score": 9.0},
        {"event": "design_evaluated", "evaluator": "gemini", "target": "codex", "avg_score": 6.5},
    ]
    flags = detect_improvement_flags(audit_events)
    assert any("calibration" in f["signal"].lower() for f in flags)


def test_detect_human_override_pattern(tmp_path):
    # Simulate 4 arenas, 2 with overrides (50% > 30% threshold)
    for i in range(4):
        arena_dir = tmp_path / f"arena-{i}"
        arena_dir.mkdir()
        override = "true" if i < 2 else "false"
        (arena_dir / "audit.jsonl").write_text(
            f'{{"event": "design_chosen", "human_override": {override}}}\n'
        )
    from design_arena import detect_cross_run_flags
    flags = detect_cross_run_flags(tmp_path)
    assert any("override" in f["signal"].lower() for f in flags)


def test_detect_too_many_questions():
    audit_events = [{"event": "brainstorm_dedup", "raw_count": 25, "deduped_count": 18}]
    flags = detect_improvement_flags(audit_events)
    assert any("question" in f["signal"].lower() for f in flags)


def test_detect_too_few_questions():
    audit_events = [{"event": "brainstorm_dedup", "raw_count": 6, "deduped_count": 3}]
    flags = detect_improvement_flags(audit_events)
    assert any("question" in f["signal"].lower() for f in flags)


def test_detect_generic_reasoning():
    audit_events = [
        {"event": "design_evaluated", "evaluator": "claude", "target": "codex",
         "reasoning": {"arch": {"reason": "Good"}, "completeness": {"reason": "Good"}}},
        {"event": "design_evaluated", "evaluator": "gemini", "target": "codex",
         "reasoning": {"arch": {"reason": "Good"}, "completeness": {"reason": "Well structured"}}},
    ]
    flags = detect_improvement_flags(audit_events)
    assert any("generic" in f["signal"].lower() or "reasoning" in f["signal"].lower() for f in flags)


def test_detect_design_similarity():
    audit_events = [
        {"event": "design_generated", "agent": "claude", "content_hash": "abc123", "length": 4000},
        {"event": "design_generated", "agent": "codex", "content_hash": "abc124", "length": 4000},
        {"event": "design_similarity", "claude_codex": 0.85, "claude_gemini": 0.3, "codex_gemini": 0.3},
    ]
    flags = detect_improvement_flags(audit_events)
    assert any("similar" in f["signal"].lower() or "converg" in f["signal"].lower() for f in flags)


def test_detect_factor_dominance():
    audit_events = [
        {"event": "design_results", "rankings": [
            {"agent": "claude", "factors": {"arch": 9.0, "completeness": 8.0, "security": 8.0}},
            {"agent": "codex", "factors": {"arch": 9.0, "completeness": 7.5, "security": 7.5}},
            {"agent": "gemini", "factors": {"arch": 9.0, "completeness": 7.0, "security": 7.0}},
        ]}
    ]
    flags = detect_improvement_flags(audit_events)
    assert any("dominat" in f["signal"].lower() or "differentiat" in f["signal"].lower() for f in flags)


def test_no_flags_when_clean():
    audit_events = [
        {"event": "design_evaluated", "evaluator": "claude", "target": "codex", "avg_score": 8.0},
        {"event": "design_evaluated", "evaluator": "gemini", "target": "codex", "avg_score": 8.2},
    ]
    flags = detect_improvement_flags(audit_events)
    assert len(flags) == 0
```

- [ ] **Step 2: Implement**

- `detect_improvement_flags(audit_events)` — single-run analysis (evaluator calibration, question count, generic reasoning, factor dominance, design similarity)
- `detect_cross_run_flags(output_dir)` — scan all `arena-*/audit.jsonl` files for cross-run patterns (agent win rates, human override frequency)

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add scripts/design_arena.py scripts/test_design_arena.py
git commit -m "feat: prompt improvement detection — single-run + cross-run analytics"
```

---

### Task 9: `/stark-design-arena` Skill Definition

**Files:**
- Create: `skill/stark-design-arena/SKILL.md`

The skill orchestrates the interactive flow. It handles the UX that the Python module can't: presenting questions one at a time, collecting answers, showing results, asking for the human's choice.

- [ ] **Step 1: Write SKILL.md**

Key sections:
- Frontmatter: name, description, argument-hint
- Phase 1: Brainstorm
  - Run `python scripts/design_arena.py --phase brainstorm --idea "..."` to collect + dedup questions
  - Present questions one at a time with multiple-choice/free-text/skip
  - After answers, run `--phase brief --answers-file answers.json` to generate brief
- Phase 2: Design Tournament
  - Run `--phase design --brief brief.md` to dispatch + cross-evaluate
  - Open comparison.html in browser
  - Present ranked results with choose/edit/merge/redo options
  - Handle edit (Claude modifies) and merge (Claude produces coherent document)
- Phase 3: Plan Tournament
  - Run `--phase plan --brief brief.md --design chosen.md` to dispatch + cross-evaluate
  - Open comparison.html
  - Present ranked results with same options
- `--skip-brainstorm`, `--skip-plan`, `--resume` flags
- Observability (tasks, timestamps, metrics)
- Failure modes table

- [ ] **Step 2: Verify install**

```bash
./install.sh && ls -la ~/.claude/skills/stark-design-arena/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add skill/stark-design-arena/SKILL.md
git commit -m "feat: /stark-design-arena skill — 3-phase competitive pipeline"
```

---

### Task 10: Update CLAUDE.md + README + Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/skills/lifecycle.html`

- [ ] **Step 1: Add to CLAUDE.md skills table**

- [ ] **Step 2: Add to README Planning section**

- [ ] **Step 3: Update lifecycle diagram**

Add `/stark-design-arena` as an alternative path in the Design phase — alongside the current brainstorm → write spec → review flow.

- [ ] **Step 4: Generate skill docs**

```bash
python scripts/generate_skill_docs.py --skill stark-design-arena --force
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs/
git commit -m "docs: add /stark-design-arena to skills tables, lifecycle, and generate docs"
```

---

### Task 11: E2E Validation

- [ ] **Step 1: Run a real arena**

```bash
/stark-design-arena "Build a dependency impact analysis skill that checks who depends on this project before releasing breaking changes"
```

Verify all 3 phases complete, HTML visualizations render correctly, artifacts stored, audit trail complete.

- [ ] **Step 2: Check artifacts**

```bash
ls -la docs/arena/arena-*/
cat docs/arena/arena-*/audit.jsonl | python -m json.tool --no-ensure-ascii
```

- [ ] **Step 3: Check improvement flags**

Verify the summary prints any applicable flags.

- [ ] **Step 4: Commit any fixes**

---

### Task 12: Final Verification

- [ ] **Step 1: Full test suite**

```bash
python -m pytest scripts/test_design_arena.py scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 2: Install check**

```bash
./install.sh --status
```

- [ ] **Step 3: Staleness check**

```bash
python scripts/generate_skill_docs.py --check
```
