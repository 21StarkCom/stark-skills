# Design Review & Plan Review Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `/stark-review-plan` into `/stark-review-design` (12 domains, interactive questionnaire, content-based activation) and a narrowed `/stark-review-plan` (10 domains, design traceability, priority inheritance). Introduce intensity-weighted review dispatch.

**Architecture:** Extend `plan_review_dispatch.py` with `--review-type` and `--domains-json` flags for intensity-aware dispatch. New `content_scan.py` module for signal detection and questionnaire logic. New prompt directories under `global/prompts/{agent}/design/` and `global/prompts/{agent}/plan/`. Existing code-review prompts move to `global/prompts/{agent}/code/` with backward-compat symlinks.

**Tech Stack:** Python 3.11+, existing multi-agent dispatch infrastructure, YAML (priority records), regex (content scanning)

**Spec:** `docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.md`

---

### Task 1: Content Scanner Module — Signal Detection

**Files:**
- Create: `scripts/content_scan.py`
- Create: `scripts/test_content_scan.py`

The content scanner reads a spec/plan markdown file and detects which conditional domains to activate based on regex signal patterns.

- [ ] **Step 1: Write failing tests**

```python
"""Tests for content_scan.py — signal detection and domain activation."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from content_scan import scan_signals, SIGNAL_MAP, ALWAYS_ON_DESIGN, ALWAYS_ON_PLAN


def test_signal_map_has_all_conditional_domains():
    expected = {"api-contracts", "data-arch", "security", "scalability",
                "observability", "operations", "existing-impact"}
    assert set(SIGNAL_MAP.keys()) == expected


def test_scan_detects_api_signals():
    text = "This system exposes REST endpoints for user management."
    result = scan_signals(text)
    assert "api-contracts" in result
    assert len(result["api-contracts"]) >= 1


def test_scan_detects_security_signals():
    text = "Users authenticate via OAuth tokens. PII is stored encrypted."
    result = scan_signals(text)
    assert "security" in result


def test_scan_detects_data_arch_signals():
    text = "The PostgreSQL schema includes a users table with a migration from v1."
    result = scan_signals(text)
    assert "data-arch" in result


def test_scan_ignores_signals_in_quoted_alternatives():
    # Signal word appears but in a "we considered and rejected" context
    # The scanner is intentionally simple (regex) — this is expected to activate.
    # The questionnaire + challenge mechanism handles false activations.
    text = "We considered using OAuth but decided against it."
    result = scan_signals(text)
    assert "security" in result  # regex doesn't understand context — this is by design


def test_scan_no_signals_returns_empty():
    text = "This is a simple CSS refactor with no external dependencies."
    result = scan_signals(text)
    assert len(result) == 0


def test_scan_multiple_domains():
    text = """
    REST API endpoints with PostgreSQL database.
    OAuth authentication for external users.
    Canary deployment with Grafana dashboards.
    """
    result = scan_signals(text)
    assert "api-contracts" in result
    assert "data-arch" in result
    assert "security" in result
    assert "operations" in result
    assert "observability" in result


def test_always_on_design_domains():
    assert "problem-fit" in ALWAYS_ON_DESIGN
    assert "architecture" in ALWAYS_ON_DESIGN
    assert "tradeoffs" in ALWAYS_ON_DESIGN
    assert "failure-modes" in ALWAYS_ON_DESIGN
    assert "maintainability" in ALWAYS_ON_DESIGN
    assert len(ALWAYS_ON_DESIGN) == 5


def test_always_on_plan_domains():
    assert "design-traceability" in ALWAYS_ON_PLAN
    assert "decomposition" in ALWAYS_ON_PLAN
    assert "phasing" in ALWAYS_ON_PLAN
    assert len(ALWAYS_ON_PLAN) == 3
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_content_scan.py -v
```

Expected: ImportError

- [ ] **Step 3: Implement content_scan.py**

```python
"""Content scanner — detect domain activation signals in spec/plan text.

Scans a markdown document for regex patterns that indicate which review
domains are relevant. Used by /stark-review-design and /stark-review-plan
to activate only the domains that matter for a given spec.
"""
from __future__ import annotations

import re
from typing import Any

# Always-on domains — apply to every review regardless of content
ALWAYS_ON_DESIGN = frozenset([
    "problem-fit", "architecture", "tradeoffs", "failure-modes", "maintainability",
])

ALWAYS_ON_PLAN = frozenset([
    "design-traceability", "decomposition", "phasing",
])

# Conditional domains — activated by content signals
SIGNAL_MAP: dict[str, list[str]] = {
    "api-contracts": [
        r"\b(?:endpoint|REST|GraphQL|gRPC|SDK|client[\s.-]library|webhook|callback)\b",
        r"\bAPI\b.*\b(?:design|contract|spec|version)\b",
    ],
    "data-arch": [
        r"\b(?:database|schema|migration|storage|model|entity|table|column|index)\b",
        r"\b(?:SQL|NoSQL|Postgres|Redis|DynamoDB|Mongo)\b",
    ],
    "security": [
        r"\b(?:auth|token|secret|password|PII|permission|role|encrypt|OAuth|SAML|certificate)\b",
        r"\b(?:trust[\s.]boundar|attack[\s.]surface|threat)\b",
    ],
    "scalability": [
        r"\b(?:latency|throughput|cache|concurrent|batch|rate[\s.]limit|SLO|p99|scale|load)\b",
        r"\b(?:performance|capacity|horizontal|vertical)\b",
    ],
    "observability": [
        r"\b(?:metric|logging|tracing|alert|dashboard|SLO|SLI|monitor|on[\s.-]call|Grafana|Datadog)\b",
    ],
    "operations": [
        r"\b(?:deploy|rollback|canary|blue[\s.-]green|feature[\s.]flag|terraform|kubernetes|CI/CD|infra)\b",
    ],
    "existing-impact": [
        r"\b(?:backward[\s.]compat|breaking[\s.]change|consumer|deprecat|downstream|upstream|existing)\b",
        r"\b(?:migration[\s.]path|expand[\s.]contract)\b",
    ],
}


def scan_signals(text: str) -> dict[str, list[str]]:
    """Scan text for domain activation signals.

    Returns dict mapping domain ID → list of matched signal strings.
    Only returns domains that had at least one match.
    """
    activated: dict[str, list[str]] = {}
    for domain, patterns in SIGNAL_MAP.items():
        matches = []
        for pattern in patterns:
            for m in re.finditer(pattern, text, re.IGNORECASE):
                matches.append(m.group(0))
        if matches:
            # Deduplicate while preserving order
            seen = set()
            unique = []
            for match in matches:
                key = match.lower()
                if key not in seen:
                    seen.add(key)
                    unique.append(match)
            activated[domain] = unique
    return activated
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_content_scan.py -v
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/content_scan.py scripts/test_content_scan.py
git commit -m "feat: content scanner — regex-based domain activation signal detection"
```

---

### Task 2: Priority Questionnaire + Challenge Logic

**Files:**
- Modify: `scripts/content_scan.py`
- Modify: `scripts/test_content_scan.py`

Add the priority questionnaire data structures, answer-to-intensity mapping, challenge rule evaluation, and priority record generation.

- [ ] **Step 1: Write failing tests**

```python
from content_scan import (
    CORE_QUESTIONS, CONDITIONAL_QUESTIONS,
    build_questionnaire, map_answers_to_intensity,
    evaluate_challenges, build_priority_record,
    OPTIMIZATION_BOOST, RESILIENCE_MAP, SECURITY_MAP, CONSUMERS_MAP,
    DATA_SENSITIVITY_MAP, DEPENDENCY_COUNT_MAP,
)


def test_core_questions_structure():
    assert len(CORE_QUESTIONS) == 2
    for q in CORE_QUESTIONS:
        assert "id" in q
        assert "text" in q
        assert "options" in q
        assert len(q["options"]) >= 4


def test_conditional_questions_keyed_by_domain():
    for domain, q in CONDITIONAL_QUESTIONS.items():
        assert domain in ("security", "api-contracts", "data-arch", "existing-impact")
        assert "id" in q
        assert "text" in q
        assert "options" in q


def test_build_questionnaire_core_only():
    activated = {}  # no conditional domains
    questions = build_questionnaire(activated)
    assert len(questions) == 2  # only core questions


def test_build_questionnaire_with_conditional():
    activated = {"security": ["OAuth"], "api-contracts": ["REST"]}
    questions = build_questionnaire(activated)
    assert len(questions) == 4  # 2 core + 2 conditional


def test_build_questionnaire_max_6():
    # Activate all conditional domains
    activated = {
        "security": ["x"], "api-contracts": ["x"],
        "data-arch": ["x"], "existing-impact": ["x"],
    }
    questions = build_questionnaire(activated)
    assert len(questions) <= 6


def test_map_answers_basic():
    activated = {"security": ["OAuth"], "api-contracts": ["REST"]}
    answers = {
        "optimization_target": "correctness",
        "resilience": "mission-critical",
        "security_posture": "high",
        "consumers": "internal-teams",
    }
    intensity = map_answers_to_intensity(answers, activated)
    # Always-on domains should be present
    assert "problem-fit" in intensity
    assert "architecture" in intensity
    # Security boosted to deep by security_posture=high
    assert intensity["security"] == "deep"
    # Failure-modes boosted by resilience=mission-critical
    assert intensity["failure-modes"] == "deep"


def test_map_answers_light_for_minimal():
    activated = {"security": ["token"]}
    answers = {
        "optimization_target": "cost",
        "resilience": "best-effort",
        "security_posture": "minimal",
    }
    intensity = map_answers_to_intensity(answers, activated)
    assert intensity["security"] == "light"


def test_map_answers_skip_unactivated():
    activated = {}  # no security signals
    answers = {
        "optimization_target": "cost",
        "resilience": "not-applicable",
    }
    intensity = map_answers_to_intensity(answers, activated)
    assert intensity.get("security", "skip") == "skip"
    assert intensity.get("api-contracts", "skip") == "skip"


def test_evaluate_challenges_security_mismatch():
    answers = {"security_posture": "minimal"}
    signals = {"security": ["OAuth tokens", "PII"]}
    challenges = evaluate_challenges(answers, signals)
    assert len(challenges) >= 1
    assert challenges[0]["domain"] == "security"


def test_evaluate_challenges_no_mismatch():
    answers = {"security_posture": "high"}
    signals = {"security": ["OAuth tokens"]}
    challenges = evaluate_challenges(answers, signals)
    assert len(challenges) == 0


def test_evaluate_challenges_resilience_mismatch():
    answers = {"resilience": "not-applicable"}
    # Spec mentions multiple service dependencies
    signals = {"operations": ["deploy", "rollback", "kubernetes"]}
    challenges = evaluate_challenges(answers, signals)
    assert any(c["domain"] == "resilience" for c in challenges)


def test_build_priority_record():
    record = build_priority_record(
        spec_file="docs/specs/my-feature.md",
        signals={"security": ["OAuth"], "api-contracts": ["REST"]},
        answers={"optimization_target": "latency", "resilience": "important", "security_posture": "standard", "consumers": "external"},
        challenges=[],
        active_domains={"problem-fit": "deep", "security": "standard", "api-contracts": "deep"},
        source="interactive",
    )
    assert record["schema_version"] == 1
    assert record["source"] == "interactive"
    assert "spec_hash" in record
    assert "active_domains" in record
    assert "skipped_domains" in record


def test_build_priority_record_with_spec_hash():
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("# Test spec\nSome content.")
        f.flush()
        record = build_priority_record(
            spec_file=f.name,
            signals={}, answers={"optimization_target": "cost", "resilience": "best-effort"},
            challenges=[], active_domains={"problem-fit": "standard"},
            source="file",
        )
        assert len(record["spec_hash"]) > 10


def test_spec_hash_changes_with_content():
    """Verify spec_hash is content-based (SHA-256) and changes when file changes."""
    import tempfile, os
    f1 = tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False)
    f1.write("# Version 1")
    f1.close()
    f2 = tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False)
    f2.write("# Version 2")
    f2.close()
    r1 = build_priority_record(spec_file=f1.name, signals={}, answers={"optimization_target": "cost", "resilience": "best-effort"}, challenges=[], active_domains={}, source="file")
    r2 = build_priority_record(spec_file=f2.name, signals={}, answers={"optimization_target": "cost", "resilience": "best-effort"}, challenges=[], active_domains={}, source="file")
    assert r1["spec_hash"] != r2["spec_hash"], "Different content should produce different hashes"
    os.unlink(f1.name)
    os.unlink(f2.name)


def test_intensity_conflict_resolution_max_wins():
    """When multiple mappings disagree, highest intensity wins."""
    activated = {"security": ["token"], "scalability": ["cache"], "data-arch": ["schema"]}
    answers = {
        "optimization_target": "cost",         # scalability: standard
        "resilience": "best-effort",
        "security_posture": "high",             # security: deep
        "data_sensitivity": "large-scale-sensitive",  # data-arch: deep, security: deep
    }
    intensity = map_answers_to_intensity(answers, activated)
    # security: high→deep AND data_sensitivity→deep. Max wins = deep.
    assert intensity["security"] == "deep"
    # data-arch: data_sensitivity→deep. Should be deep.
    assert intensity["data-arch"] == "deep"
    # scalability: cost→standard, but data_sensitivity could boost. At minimum standard.
    assert intensity["scalability"] in ("standard", "deep")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest scripts/test_content_scan.py -v -k "question or challenge or priority or map_answers"
```

- [ ] **Step 3: Implement questionnaire, mapping, challenges, and priority record**

Add to `scripts/content_scan.py`: `CORE_QUESTIONS`, `CONDITIONAL_QUESTIONS`, `OPTIMIZATION_BOOST`, `RESILIENCE_MAP`, `SECURITY_MAP`, `CONSUMERS_MAP`, `DATA_SENSITIVITY_MAP`, `DEPENDENCY_COUNT_MAP`, `build_questionnaire()`, `map_answers_to_intensity()`, `evaluate_challenges()`, `build_priority_record()`.

Follow the spec exactly for mapping tables and challenge rules. Conflict resolution: "max wins" — the highest intensity from any applicable mapping is used.

- [ ] **Step 4: Run all tests**

```bash
python -m pytest scripts/test_content_scan.py -v
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/content_scan.py scripts/test_content_scan.py
git commit -m "feat: priority questionnaire, intensity mapping, challenge rules, priority record"
```

---

### Task 3: Design Review Domain Prompts (Claude-only for v1)

**Files:**
- Create: `global/prompts/claude/design/agent.md`
- Create: `global/prompts/claude/design/01-problem-fit.md`
- Create: `global/prompts/claude/design/02-architecture.md`
- Create: `global/prompts/claude/design/03-tradeoffs.md`
- Create: `global/prompts/claude/design/04-failure-modes.md`
- Create: `global/prompts/claude/design/05-maintainability.md`
- Create: `global/prompts/claude/design/06-api-contracts.md`
- Create: `global/prompts/claude/design/07-data-arch.md`
- Create: `global/prompts/claude/design/08-security.md`
- Create: `global/prompts/claude/design/09-scalability.md`
- Create: `global/prompts/claude/design/10-observability.md`
- Create: `global/prompts/claude/design/11-operations.md`
- Create: `global/prompts/claude/design/12-existing-impact.md`

Per the Prompt Authoring Strategy: start Claude-only (13 files). Each prompt follows the template from the spec: `What you're checking`, `Review checklist`, `Common anti-patterns to flag`, `What to skip`, `Finding format`.

- [ ] **Step 1: Create agent.md preamble**

Design review agent preamble. Sets the persona (Principal Engineer reviewing a design doc), output format (structured JSON findings), and intensity awareness.

- [ ] **Step 2: Create all 12 domain prompts**

Generate from the domain descriptions in the spec. Each domain's table entry (checklist, anti-patterns) from the research becomes the prompt content. Adapt for Claude's strengths (nuanced reasoning, contextual understanding).

Reference existing code-review prompts at `global/prompts/claude/01-architecture.md` for structure and tone.

- [ ] **Step 3: Verify all files exist**

```bash
ls global/prompts/claude/design/*.md | wc -l
# Expected: 13 (agent.md + 12 domains)
```

- [ ] **Step 4: Commit**

```bash
git add global/prompts/claude/design/
git commit -m "feat: design review prompts — 12 domains + agent preamble (Claude-only for v1)"
```

---

### Task 4: Plan Review Domain Prompts (Claude-only for v1)

**Files:**
- Create: `global/prompts/claude/plan/agent.md`
- Create: `global/prompts/claude/plan/01-design-traceability.md`
- Create: `global/prompts/claude/plan/02-decomposition.md`
- Create: `global/prompts/claude/plan/03-phasing.md`
- Create: `global/prompts/claude/plan/04-dependency-graph.md`
- Create: `global/prompts/claude/plan/05-acceptance-criteria.md`
- Create: `global/prompts/claude/plan/06-risk-mitigation.md`
- Create: `global/prompts/claude/plan/07-rollback.md`
- Create: `global/prompts/claude/plan/08-integration-points.md`
- Create: `global/prompts/claude/plan/09-nfr-coverage.md`
- Create: `global/prompts/claude/plan/10-resource-deps.md`

10 plan-specific domains + agent preamble. Same structure as design prompts. The `design-traceability` prompt instructs the LLM to cross-reference the plan against a provided design document.

- [ ] **Step 1: Create agent.md preamble**

Plan review persona: experienced tech lead validating that an implementation plan faithfully and completely executes an approved design.

- [ ] **Step 2: Create all 10 domain prompts**

Generate from the plan review domain descriptions in the spec. Focus on execution concerns: dependency ordering, acceptance criteria quality (INVEST), rollback feasibility, phasing for incremental value.

- [ ] **Step 3: Verify all files exist**

```bash
ls global/prompts/claude/plan/*.md | wc -l
# Expected: 11 (agent.md + 10 domains)
```

- [ ] **Step 4: Commit**

```bash
git add global/prompts/claude/plan/
git commit -m "feat: plan review prompts — 10 domains + agent preamble (Claude-only for v1)"
```

---

### Task 5: Move Code-Review Prompts to `code/` Subdirectory

**Files:**
- Move: `global/prompts/claude/*.md` → `global/prompts/claude/code/`
- Move: `global/prompts/codex/*.md` → `global/prompts/codex/code/`
- Move: `global/prompts/gemini/*.md` → `global/prompts/gemini/code/`
- Create: backward-compat symlinks

The existing code-review prompts live directly in `global/prompts/{agent}/`. They need to move to `global/prompts/{agent}/code/` so the directory structure is consistent (`design/`, `plan/`, `code/`). Backward-compat symlinks ensure existing `multi_review.py` code continues to work.

- [ ] **Step 1: Write a test that verifies code prompts load from the new location**

Add to `scripts/test_multi_review.py`:

```python
def test_code_prompts_exist_in_code_subdir():
    """After migration, code prompts should live in {agent}/code/."""
    from pathlib import Path
    prompts_dir = Path(__file__).parent.parent / "global" / "prompts"
    for agent in ("claude", "codex", "gemini"):
        code_dir = prompts_dir / agent / "code"
        assert code_dir.exists(), f"{code_dir} missing"
        assert (code_dir / "agent.md").exists(), f"{code_dir}/agent.md missing"
        assert len(list(code_dir.glob("*.md"))) >= 7, f"{code_dir} has too few prompts"
```

- [ ] **Step 2: Move files and create symlinks**

```bash
for agent in claude codex gemini; do
  mkdir -p global/prompts/$agent/code
  # Move all .md files (not directories) to code/
  for f in global/prompts/$agent/*.md; do
    [ -f "$f" ] && mv "$f" global/prompts/$agent/code/
  done
  # Create backward-compat symlinks
  for f in global/prompts/$agent/code/*.md; do
    ln -sf "code/$(basename $f)" "global/prompts/$agent/$(basename $f)"
  done
done
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
python -m pytest scripts/test_multi_review.py -v
python -m pytest scripts/test_plan_review_dispatch.py -v
```

- [ ] **Step 4: Commit**

```bash
git add global/prompts/
git commit -m "refactor: move code-review prompts to code/ subdirectory with backward-compat symlinks"
```

---

### Task 6: Extend `plan_review_dispatch.py` with `--review-type`, `--domains-json`, and `--design`

**Files:**
- Modify: `scripts/plan_review_dispatch.py`
- Modify: `scripts/test_plan_review_dispatch.py`

**Note:** The spec references `multi_review.py` for these changes, but `plan_review_dispatch.py` is the correct target — it's the dispatch layer for plan and design reviews (separate from `multi_review.py` which handles code reviews). The new `--review-type design` flag reuses the same dispatch infrastructure.

Add `--review-type` (design/plan), `--domains-json` (intensity-filtered dispatch), `--design` (pass design doc for traceability), and intensity-aware prompt loading with directive injection. Backward compatible — omitting new flags defaults to current behavior.

- [ ] **Step 1: Write failing tests**

```python
def test_parse_domains_json_valid():
    from plan_review_dispatch import _parse_domains_json
    result = _parse_domains_json('{"problem-fit": "deep", "security": "standard"}')
    assert result["problem-fit"] == "deep"
    assert result["security"] == "standard"


def test_parse_domains_json_rejects_invalid_intensity():
    from plan_review_dispatch import _parse_domains_json
    import pytest
    with pytest.raises(ValueError):
        _parse_domains_json('{"problem-fit": "extreme"}')


def test_filter_dispatch_by_intensity():
    from plan_review_dispatch import _filter_dispatch_tasks
    domains = {"problem-fit": "deep", "security": "light", "api-contracts": "skip"}
    agents = ["claude", "codex"]
    tasks = _filter_dispatch_tasks(domains, agents)
    # deep: both agents
    assert ("claude", "problem-fit") in tasks
    assert ("codex", "problem-fit") in tasks
    # light: claude only
    assert ("claude", "security") in tasks
    assert ("codex", "security") not in tasks
    # skip: nobody
    assert ("claude", "api-contracts") not in tasks


def test_resolve_prompt_with_review_type():
    from plan_review_dispatch import resolve_plan_prompt
    # Should look in global/prompts/claude/design/ when review_type=design
    path = resolve_plan_prompt("claude", "problem-fit", review_type="design")
    assert "design" in str(path)


def test_inject_intensity_directive_deep():
    from plan_review_dispatch import inject_intensity_directive
    prompt = "# Domain: security\n\n## What you're checking\nThreat model..."
    result = inject_intensity_directive(prompt, "deep", "security_posture=high")
    assert "## Review Intensity: DEEP" in result
    assert "security_posture=high" in result
    assert prompt in result  # original prompt preserved


def test_inject_intensity_directive_light():
    from plan_review_dispatch import inject_intensity_directive
    prompt = "# Domain: observability\n\n## What you're checking\n..."
    result = inject_intensity_directive(prompt, "light", "no specific boost")
    assert "## Review Intensity: LIGHT" in result
    assert "HIGH and CRITICAL" in result


def test_design_flag_passes_spec_content():
    """--design flag should make spec content available to the traceability domain."""
    from plan_review_dispatch import _build_dispatch_context
    context = _build_dispatch_context(
        plan_file="docs/plans/my-plan.md",
        design_file="docs/specs/my-spec.md",
        review_type="plan",
    )
    assert "design_content" in context or "spec_content" in context
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_plan_review_dispatch.py -k "domains_json or filter_dispatch or review_type" -v
```

- [ ] **Step 3: Implement**

Add to `plan_review_dispatch.py`:
- `_parse_domains_json(json_str) -> dict` — validate JSON against schema, reject unknown domain IDs per review-type
- `_filter_dispatch_tasks(domains, agents) -> list[tuple[str, str]]` — deep=all agents, standard=all agents, light=claude only, skip=nobody
- `inject_intensity_directive(prompt, intensity, reason) -> str` — prepend `## Review Intensity: {DEEP|STANDARD|LIGHT}` block with behavior instructions per the spec
- `_build_dispatch_context(plan_file, design_file, review_type) -> dict` — when `--design` is provided, read the design doc and include its content in the dispatch context so the traceability domain can cross-reference
- Update `resolve_plan_prompt()` to accept `review_type` parameter (looks in `{agent}/design/` or `{agent}/plan/`)
- Update `dispatch_plan_review()` to accept `--review-type`, `--domains-json`, and `--design`
- Update `main()` CLI argument parsing with new flags
- When `--design` is provided, append the design doc content to prompts for the `design-traceability` domain

- [ ] **Step 4: Run all tests**

```bash
python -m pytest scripts/test_plan_review_dispatch.py -v
```

- [ ] **Step 5: Smoke test — existing behavior unchanged**

```bash
# Default (no new flags) should produce same output
python scripts/plan_review_dispatch.py --file docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.md --round 1 --timeout 60 --agents claude 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: add --review-type and --domains-json to plan_review_dispatch.py"
```

---

### Task 7: Build `/stark-review-design` Skill

**Files:**
- Create: `skill/stark-review-design/SKILL.md`

The new skill orchestrates: content scan → questionnaire → challenges → confirm → dispatch (via plan_review_dispatch.py with --review-type design) → fix loop → priority record output.

- [ ] **Step 1: Write SKILL.md**

The skill file is the full workflow definition. It must include:
- Frontmatter: name, description, argument-hint
- Phase 1: Setup (validate input, content scan, print activated domains)
- Phase 2: Priority Questionnaire (present questions, collect answers)
- Phase 3: Challenge (evaluate mismatches, present challenges, resolve)
- Phase 4: Confirm & Dispatch (show final domain/intensity map, dispatch via plan_review_dispatch.py --review-type design --domains-json ...)
- Phase 5: Review-Fix Loop (same as current /stark-review-plan)
- Phase 6: Output (write .review.md + .priorities.yaml sidecar, print summary)
- --priorities flag for CI/headless mode (load YAML instead of interactive)
- Observability (tasks, timestamps, metrics)
- Failure modes table

Reference `skill/stark-review-plan/SKILL.md` for structure and patterns. The new skill follows the same dispatch/fix-loop/output phases but adds the questionnaire phases before dispatch.

- [ ] **Step 2: Verify install.sh picks it up**

```bash
./install.sh && ls -la ~/.claude/skills/stark-review-design/SKILL.md
```

- [ ] **Step 3: Smoke test with a real spec**

```bash
# Run on the spec itself — ultimate dogfooding
/stark-review-design docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.md --dry-run
```

Verify: content scan output shown, questionnaire presented, domain activation confirmed, dispatch would run.

- [ ] **Step 4: Commit**

```bash
git add skill/stark-review-design/SKILL.md
git commit -m "feat: /stark-review-design skill — questionnaire, content scan, challenge mechanism"
```

---

### Task 8: Narrow `/stark-review-plan` — Plan-Specific Domains + Priority Inheritance

**Files:**
- Modify: `skill/stark-review-plan/SKILL.md`

This is Phase 4 from the spec. The existing `/stark-review-plan` currently uses 7 mixed domains (general, feasibility, completeness, security, operability, scope, api-design). Narrow it to use the 10 plan-specific domains from Task 4, add priority record loading, add `--design` flag for traceability, and handle the "no approved design" graceful degradation.

**Only do this after ≥5 successful `/stark-review-design` runs** (per the spec's staged rollout criteria). For the plan, implement the changes but gate the switchover on validation.

- [ ] **Step 1: Add priority record loading to SKILL.md**

In the Setup phase of the skill, add logic to:
- Look for `{spec-name}.priorities.yaml` sidecar file
- If found, load it and extract `active_domains` for intensity inheritance
- If not found, present the 3 options from the spec: point to artifact, infer from design doc, or skip priority weighting
- Add `--design <path>` flag that passes the design doc to `plan_review_dispatch.py` via `--design` for the traceability domain

- [ ] **Step 2: Switch dispatch to plan-specific domains**

Update the dispatch command in the skill from:
```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $round --timeout 300
```
to:
```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file "$path" --round $round --timeout 300 \
  --review-type plan --domains-json "$DOMAINS_JSON" \
  ${DESIGN_FILE:+--design "$DESIGN_FILE"}
```

Where `$DOMAINS_JSON` is built from the priority record's inherited intensities mapped to plan domains, and `$DESIGN_FILE` is from the `--design` flag.

- [ ] **Step 3: Add graceful degradation when no design exists**

When no priority record and no `--design` flag: run all plan domains at `standard` intensity, emit warning:
```
⚠️  No approved design found — traceability domain disabled, all domains at standard intensity.
   Run /stark-review-design first for full coverage.
```

- [ ] **Step 4: Verify existing plan review still works**

```bash
/stark-review-plan docs/superpowers/plans/2026-03-25-design-plan-review-split-plan.md --dry-run
```

Should run without errors, using the new plan domains.

- [ ] **Step 5: Commit**

```bash
git add skill/stark-review-plan/SKILL.md
git commit -m "feat: narrow /stark-review-plan — plan-specific domains, priority inheritance, --design flag"
```

---

### Task 9: Update CLAUDE.md Files and Install Script

**Files:**
- Modify: `CLAUDE.md`
- Modify: `~/Code/CLAUDE.md`
- Verify: `install.sh` picks up new skill and prompt directories

- [ ] **Step 1: Add /stark-review-design to stark-skills CLAUDE.md skills table**

```
| `/stark-review-design <path>` | Multi-agent design review with priority questionnaire |
```

- [ ] **Step 2: Add to Evinced CLAUDE.md Global Skills table**

- [ ] **Step 3: Verify install.sh**

```bash
./install.sh --status
```

Check that `stark-review-design`, `global/prompts/claude/design/`, and `global/prompts/claude/plan/` are all symlinked.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md install.sh
git commit -m "docs: add /stark-review-design to skills tables and verify install"
```

---

### Task 10: End-to-End Validation — Run Design Review on a Real Spec

**Files:** No new files — integration test

- [ ] **Step 1: Run /stark-review-design on the spec itself**

```bash
/stark-review-design docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.md
```

Verify:
- Content scan shows correct activated domains
- Questionnaire presents 4-6 questions
- Challenge mechanism fires on at least one answer
- Dispatch runs with intensity-filtered domains
- Fix loop works (if findings exist)
- Priority record written to `.priorities.yaml`
- Review summary written to `.review.md`

- [ ] **Step 2: Verify priority record**

```bash
cat docs/superpowers/specs/2026-03-25-design-and-plan-review-split-design.priorities.yaml
```

Check: schema_version, spec_hash, active_domains with intensities, answers, source.

- [ ] **Step 3: Run /stark-review-design on a simple spec (fewer domains)**

Find a simple spec in the repo and run the design review to verify that fewer domains activate:

```bash
/stark-review-design docs/specs/2026-03-20-stark-metrics-design.md --dry-run
```

Verify: fewer conditional domains activate, fewer questions asked.

- [ ] **Step 4: Commit any fixes from the E2E run**

```bash
git add -A && git commit -m "fix: address issues found during E2E design review validation"
```

---

### Task 11: Update Lifecycle Diagram and Docs

**Files:**
- Modify: `docs/skills/lifecycle.html`
- Modify: `docs/skills/README.md` (routing guide)
- Modify: `README.md`

- [ ] **Step 1: Update lifecycle.html**

Replace the single "review plan" step with two steps: `/stark-review-design` and `/stark-review-plan`. The design review comes first in the Design phase, and the plan review stays where it is.

- [ ] **Step 2: Re-screenshot lifecycle.png**

```bash
npx playwright screenshot --full-page --viewport-size=960,800 "file://$(pwd)/docs/skills/lifecycle.html" docs/skills/lifecycle.png
```

- [ ] **Step 3: Update routing guide**

Add `/stark-review-design` to the Code Review section of `docs/skills/README.md`.

- [ ] **Step 4: Update README.md skills table**

Add `/stark-review-design` to the Quality Gates table. Update the description of `/stark-review-plan` to note it now focuses on plan execution validity.

- [ ] **Step 5: Regenerate skill docs**

```bash
python scripts/generate_skill_docs.py --skill stark-review-design --force
```

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md
git commit -m "docs: update lifecycle diagram, routing guide, and README for design review split"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Full test suite**

```bash
python -m pytest scripts/ -v
```

- [ ] **Step 2: Install verification**

```bash
./install.sh --status
```

- [ ] **Step 3: Staleness check**

```bash
python scripts/generate_skill_docs.py --check
```

- [ ] **Step 4: Verify both skills work independently**

```bash
# Design review (new)
/stark-review-design docs/superpowers/specs/2026-03-24-skill-docs-viz-design.md --dry-run

# Plan review (existing, unchanged)
/stark-review-plan docs/superpowers/plans/2026-03-25-design-plan-review-split-plan.md --dry-run
```

Both should run without errors.
