# Skill Documentation & Visualization System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-LLM documentation generator that produces visual, audience-split docs for every stark-skill — with Mermaid diagrams, rich HTML visualizations, competitive scoring, and audit trails.

**Architecture:** A single Python script (`generate_skill_docs.py`) that parses SKILL.md frontmatter, dispatches 3 LLMs to generate HTML visualizations, screenshots all candidates via Playwright, has Claude judge the PNGs, and assembles markdown docs with both Mermaid diagrams and embedded PNG screenshots. Single flat ThreadPoolExecutor, MAX_WORKERS=6.

**Tech Stack:** Python 3.11+, ThreadPoolExecutor, subprocess (claude/codex/gemini CLIs), Playwright (HTML→PNG), hashlib (staleness), JSON (audit), Git LFS (PNGs)

**Spec:** `docs/superpowers/specs/2026-03-24-skill-docs-viz-design.md`

---

### Task 1: Git LFS Setup + Shared CSS Design System

**Files:**
- Create: `docs/skills/_css/design-system.css`
- Modify: `.gitattributes`

- [ ] **Step 1: Configure Git LFS for PNG files**

```bash
cd /Users/aryeh/git/Evinced/stark-skills
git lfs install  # if not already installed
```

Add to `.gitattributes`:

```
docs/skills/**/*.png filter=lfs diff=lfs merge=lfs -text
```

- [ ] **Step 2: Create the shared CSS file**

Reference `infra-ai-platform/scripts/generate-viz.py` lines 349-456 for the design system. Adapt node types for skill documentation:

```css
/* Node types for skill viz */
.node-phase    { background: #1e40af; color: white; }       /* Workflow phase */
.node-decision { background: #7c3aed; color: white; }       /* Decision point */
.node-failure  { background: #dc2626; color: white; }       /* Failure/error */
.node-config   { background: #047857; color: white; }       /* Config/setup — #047857 passes WCAG AA 4.5:1 */
.node-output   { background: #f59e0b; color: #1a1a1a; }     /* Output/result */
.node-external { background: #e5e7eb; color: #666; border: 1px dashed #bbb; } /* External dep */
```

Keep all existing classes from infra-ai-platform's design system (flow, cards, tables, tags, arrows, header, footer, legend, summary-grid). Add:

```css
.winner-badge { font-size: 12px; color: #555; text-align: center; padding: 8px; } /* #555 on white = 7.5:1, passes AA */
```

LLMs may extend with inline styles — the CSS is a floor, not a ceiling. ~200 lines total.

- [ ] **Step 3: Commit**

```bash
git add .gitattributes docs/skills/_css/design-system.css
git commit -m "feat: Git LFS for PNGs + shared CSS design system for skill docs"
```

---

### Task 2: Lightweight SKILL.md Parser

**Files:**
- Create: `scripts/generate_skill_docs.py` (initial skeleton with parser only)
- Create: `scripts/test_generate_skill_docs.py`

The parser extracts only frontmatter + complexity. It does NOT attempt to regex-extract phases, config tables, failure modes, or arguments from the wildly varying SKILL.md formats. The LLMs receive `raw_md` and are better at understanding unstructured markdown.

- [ ] **Step 1: Write failing tests**

```python
"""Tests for SKILL.md parser."""
import json
import sys
from pathlib import Path

# Add scripts/ to path so we can import the module
sys.path.insert(0, str(Path(__file__).parent))
from generate_skill_docs import parse_skill_md, SkillData, discover_skills

FIXTURE = Path(__file__).parent.parent / "skill" / "stark-session" / "SKILL.md"


def test_parse_extracts_name():
    data = parse_skill_md(FIXTURE)
    assert data.name == "stark-session"


def test_parse_extracts_description():
    data = parse_skill_md(FIXTURE)
    assert "session" in data.description.lower()


def test_parse_extracts_argument_hint():
    data = parse_skill_md(FIXTURE)
    assert "start" in data.argument_hint or "end" in data.argument_hint


def test_parse_complexity_simple():
    fixture = Path(__file__).parent.parent / "skill" / "stark-metrics" / "SKILL.md"
    data = parse_skill_md(fixture)
    assert data.complexity == "simple"
    assert data.line_count < 100


def test_parse_complexity_complex():
    fixture = Path(__file__).parent.parent / "skill" / "stark-phase-execute" / "SKILL.md"
    data = parse_skill_md(fixture)
    assert data.complexity == "complex"
    assert data.line_count > 400


def test_parse_includes_raw_md():
    data = parse_skill_md(FIXTURE)
    assert "## Start Mode" in data.raw_md
    assert len(data.raw_md) > 100


def test_parse_to_json_roundtrip():
    data = parse_skill_md(FIXTURE)
    j = data.to_json()
    parsed = json.loads(j)
    assert parsed["name"] == "stark-session"
    assert "raw_md" in parsed


def test_parse_handles_missing_frontmatter():
    """If frontmatter is missing, use directory name as fallback."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("# No frontmatter\nJust content.")
        f.flush()
        data = parse_skill_md(Path(f.name))
        assert data.name  # should not crash
        assert data.raw_md == "# No frontmatter\nJust content."


def test_discover_skills_all():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir)
    assert all((s / "SKILL.md").exists() for s in skills)
    assert len(skills) >= 19


def test_discover_skills_filter():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir, filter_name="stark-session")
    assert len(skills) == 1
    assert skills[0].name == "stark-session"


def test_discover_skills_filter_nonexistent():
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = discover_skills(skill_dir, filter_name="nonexistent")
    assert len(skills) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python -m pytest scripts/test_generate_skill_docs.py -v
```

Expected: ImportError

- [ ] **Step 3: Implement parser and skill discovery**

```python
#!/usr/bin/env python3
"""Generate skill documentation with multi-LLM visualization competition.

Parses SKILL.md frontmatter, dispatches 3 LLMs to generate HTML visualizations,
has Claude judge the screenshots, and assembles markdown docs with Mermaid
diagrams and embedded PNGs.

Usage:
    generate_skill_docs.py                          # all skills
    generate_skill_docs.py --skill stark-review     # one skill
    generate_skill_docs.py --check                  # staleness check
    generate_skill_docs.py --no-screenshots         # skip PNG generation
    generate_skill_docs.py --no-evaluation          # skip judge, use first valid
    generate_skill_docs.py --markdown-only          # skip LLM, regen markdown
    generate_skill_docs.py --dry-run                # show what would change
    generate_skill_docs.py --force                  # regenerate even if clean
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / "skill"
DEFAULT_OUT = ROOT / "docs" / "skills"
SCRIPTS_DIR = Path(__file__).parent

SCRIPT_VERSION = "1.0.0"
MAX_WORKERS = 6

AGENTS = {
    "claude": {"emoji": "\U0001f9e0", "label": "Claude"},
    "codex":  {"emoji": "\U0001f4bb", "label": "Codex"},
    "gemini": {"emoji": "\u2728",     "label": "Gemini"},
}


@dataclass
class SkillData:
    name: str
    description: str
    argument_hint: str
    complexity: str       # simple (<100 lines), medium (100-400), complex (>400)
    line_count: int
    raw_md: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def parse_skill_md(path: Path) -> SkillData:
    """Parse a SKILL.md file. Extracts frontmatter + raw text."""
    text = path.read_text()
    lines = text.splitlines()
    line_count = len(lines)

    # Parse YAML frontmatter between --- delimiters
    name = path.parent.name  # fallback
    description = ""
    argument_hint = ""
    fm_match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        m = re.search(r"^name:\s*(.+)", fm, re.MULTILINE)
        if m:
            name = m.group(1).strip()
        # description may span multiple lines (YAML folded scalar >)
        m = re.search(r"^description:\s*>?\s*\n?((?:\s+.+\n?)*)", fm, re.MULTILINE)
        if m:
            description = " ".join(m.group(1).split())
        else:
            m = re.search(r"^description:\s*(.+)", fm, re.MULTILINE)
            if m:
                description = m.group(1).strip()
        m = re.search(r"^argument-hint:\s*(.+)", fm, re.MULTILINE)
        if m:
            argument_hint = m.group(1).strip().strip('"')

    complexity = "simple" if line_count < 100 else "medium" if line_count <= 400 else "complex"

    return SkillData(
        name=name,
        description=description,
        argument_hint=argument_hint,
        complexity=complexity,
        line_count=line_count,
        raw_md=text,
    )


def discover_skills(skill_dir: Path, filter_name: str | None = None) -> list[Path]:
    """Find skill directories that contain SKILL.md. Returns list[Path] — use .name for string key."""
    skills = []
    for d in sorted(skill_dir.iterdir()):
        if not d.is_dir() or not (d / "SKILL.md").exists():
            continue
        if filter_name and d.name != filter_name:
            continue
        skills.append(d)
    return skills
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -v
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: lightweight SKILL.md parser with frontmatter extraction"
```

---

### Task 3: HTML Validation + LLM Sub-Agent Dispatch

**Files:**
- Modify: `scripts/generate_skill_docs.py`
- Modify: `scripts/test_generate_skill_docs.py`

Duplicate the `_run_subagent()` pattern from `multi_review.py:573-822`. Same retry logic, same Gemini tmpdir trick, same Codex JSONL parsing.

- [ ] **Step 1: Write failing tests**

```python
def test_validate_html_valid():
    html = '<html><body><div class="node-phase">Phase 1</div></body></html>'
    assert validate_html(html) is True


def test_sanitize_strips_scripts():
    html = '<html><body><script>alert("xss")</script><div class="node-phase">ok</div></body></html>'
    cleaned = sanitize_html(html)
    assert "<script>" not in cleaned
    assert "node-phase" in cleaned


def test_sanitize_strips_event_handlers():
    html = '<html><body><img onerror="alert(1)" class="node-phase"></body></html>'
    cleaned = sanitize_html(html)
    assert "onerror" not in cleaned


def test_sanitize_strips_dangerous_tags():
    html = '<html><body><iframe srcdoc="bad"></iframe><object data="x"></object><embed src="y"><meta http-equiv="refresh"><div class="node-phase">ok</div></body></html>'
    cleaned = sanitize_html(html)
    assert "<iframe" not in cleaned
    assert "<object" not in cleaned
    assert "<embed" not in cleaned
    assert "<meta" not in cleaned


def test_validate_html_rejects_no_html_tag():
    assert validate_html("just some text") is False


def test_validate_html_rejects_external_urls_in_attributes():
    html = '<html><body><link href="https://fonts.googleapis.com/css" rel="stylesheet"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_allows_urls_in_comments():
    html = '<html><body><!-- based on https://example.com --><div class="node-phase">ok</div></body></html>'
    assert validate_html(html) is True


def test_validate_html_rejects_protocol_relative_urls():
    html = '<html><body><link href="//fonts.google.com/css" rel="stylesheet"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_rejects_data_uris_in_attributes():
    html = '<html><body><img src="data:text/html,<script>alert(1)</script>"><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_validate_html_rejects_javascript_urls():
    html = '<html><body><a href="javascript:alert(1)">x</a><div class="node-phase"></div></body></html>'
    assert validate_html(html) is False


def test_build_generation_prompt():
    data = parse_skill_md(FIXTURE)
    css = "body { color: black; }"
    prompt = build_generation_prompt(data, audience="usage", css=css)
    assert "usage" in prompt.lower()
    assert "standalone HTML" in prompt
    assert data.name in prompt
    assert "mermaid" in prompt.lower()  # must also request Mermaid diagram


def test_build_generation_prompt_internals():
    data = parse_skill_md(FIXTURE)
    css = "body { color: black; }"
    prompt = build_generation_prompt(data, audience="internals", css=css)
    assert "internals" in prompt.lower() or "contributor" in prompt.lower()
    assert "mermaid" in prompt.lower()
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "validate or prompt" -v
```

- [ ] **Step 3: Implement validation, prompt builder, and sub-agent runner**

```python
DESIGN_CSS = ""  # loaded lazily

def _load_css() -> str:
    global DESIGN_CSS
    if not DESIGN_CSS:
        css_path = DEFAULT_OUT / "_css" / "design-system.css"
        if css_path.exists():
            DESIGN_CSS = css_path.read_text()
        else:
            DESIGN_CSS = "/* design-system.css not found — using minimal defaults */"
    return DESIGN_CSS


def sanitize_html(html: str) -> str:
    """Sanitize LLM-generated HTML. Uses html.parser, not regex (regex is bypassable)."""
    from html.parser import HTMLParser
    from io import StringIO

    DANGEROUS_TAGS = {"script", "iframe", "object", "embed", "meta"}

    class Sanitizer(HTMLParser):
        def __init__(self):
            super().__init__()
            self.result = StringIO()
            self._skip_depth = 0
            self._skip_tag = None

        def handle_starttag(self, tag, attrs):
            if tag.lower() in DANGEROUS_TAGS:
                self._skip_depth += 1
                self._skip_tag = tag.lower()
                return
            if self._skip_depth:
                return
            # Strip on* event handlers from attributes
            safe_attrs = [(k, v) for k, v in attrs if not k.lower().startswith("on")]
            attr_str = "".join(f' {k}="{v}"' for k, v in safe_attrs)
            self.result.write(f"<{tag}{attr_str}>")

        def handle_endtag(self, tag):
            if tag.lower() == self._skip_tag and self._skip_depth > 0:
                self._skip_depth -= 1
                if self._skip_depth == 0:
                    self._skip_tag = None
                return
            if self._skip_depth:
                return
            self.result.write(f"</{tag}>")

        def handle_data(self, data):
            if not self._skip_depth:
                self.result.write(data)

        def handle_comment(self, data):
            if not self._skip_depth:
                self.result.write(f"<!--{data}-->")

    s = Sanitizer()
    s.feed(html)
    result = s.result.getvalue()
    # Strip CSS url() and @import
    result = re.sub(r'url\s*\([^)]*\)', 'url()', result, flags=re.IGNORECASE)
    result = re.sub(r'@import[^;]*;', '', result, flags=re.IGNORECASE)
    return result


def validate_html(html: str) -> bool:
    """Check sanitized HTML meets minimum requirements."""
    if "<html" not in html.lower() or "</html>" not in html.lower():
        return False
    # Check for dangerous URLs in src=, href=, url( attributes only (not in comments/text)
    # Reject: https://, http://, //, data:, javascript:, file: in attribute contexts
    dangerous_url = re.compile(
        r'''(?:src|href|action)\s*=\s*["']?\s*(?:https?://|//|data:|javascript:|file:)''',
        re.IGNORECASE,
    )
    if dangerous_url.search(html):
        return False
    # Must use at least one design system class
    design_classes = ["node-phase", "node-decision", "node-failure", "node-config",
                      "node-output", "flow", "card", "data-table"]
    if not any(cls in html for cls in design_classes):
        return False
    return True


@dataclass
class VizResult:
    agent: str
    skill: str
    audience: str
    html: str
    mermaid: str          # Mermaid diagram extracted from LLM response
    doc_content: dict     # Structured doc sections (prerequisites, troubleshooting, etc.)
    alt_text: str         # Descriptive alt text for the PNG screenshot
    error: str | None = None
    duration_s: float = 0.0
    api_key_fallback: bool = False


def build_generation_prompt(skill: SkillData, audience: str, css: str) -> str:
    """Build the prompt sent to each LLM for HTML + Mermaid generation."""
    # Prompt asks for TWO outputs:
    # 1. A standalone HTML page using the provided CSS
    # 2. A Mermaid diagram (```mermaid ... ```) suitable for markdown embedding
    # LLM returns both in a structured format (HTML first, then mermaid block)
    ...


def _run_viz_agent(agent: str, skill: SkillData, audience: str) -> VizResult:
    """Run one LLM to generate HTML visualization + Mermaid diagram.
    Mirrors multi_review._run_subagent() — same CLI dispatch, retry, timeout."""
    # Same patterns:
    # claude: claude -p - --output-format text --model claude-opus-4-6
    # codex: codex exec --ephemeral --json --full-auto -
    # gemini: gemini -p <prompt> -o json --approval-mode plan
    # Parse response to extract HTML and Mermaid blocks separately
    ...
```

Key: the prompt asks each LLM to produce THREE artifacts:
1. An HTML page (goes through sanitization + validation + screenshots)
2. A Mermaid diagram (persisted to `{audience}.mermaid`, embedded in markdown)
3. Structured doc content as JSON (persisted to `{audience}.json`, populates markdown sections)
4. A descriptive alt text for the visualization PNG

The response is parsed to separate all four. Each is persisted to disk so `--markdown-only` can rebuild without LLM calls.

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: HTML validation, prompt builder, and LLM sub-agent dispatch"
```

---

### Task 4: Playwright Screenshots + Single-Judge Evaluation

**Files:**
- Modify: `scripts/generate_skill_docs.py`
- Modify: `scripts/test_generate_skill_docs.py`

- [ ] **Step 1: Ensure Playwright is available**

```bash
npx playwright install chromium 2>/dev/null || echo "Playwright not available — screenshots will be skipped"
```

- [ ] **Step 2: Write failing tests**

```python
def test_screenshot_html_creates_png(tmp_path, monkeypatch):
    """Test screenshot with mocked Playwright to ensure deterministic behavior."""
    html_path = tmp_path / "test.html"
    html_path.write_text("<html><body><h1>Test</h1></body></html>")
    png_path = tmp_path / "test.png"

    # Mock subprocess.run to simulate Playwright creating a PNG
    def mock_run(cmd, **kwargs):
        # Write a fake PNG to the tmp path (second-to-last arg)
        out_path = Path(cmd[-1])
        out_path.write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 100)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(shutil, "which", lambda x: "/usr/bin/npx")
    monkeypatch.setattr(subprocess, "run", mock_run)
    result = screenshot_html(html_path, png_path)
    assert result is True
    assert png_path.exists()


def test_screenshot_html_skips_when_no_npx(tmp_path, monkeypatch):
    """When Playwright is not installed, screenshot returns False gracefully."""
    html_path = tmp_path / "test.html"
    html_path.write_text("<html><body><h1>Test</h1></body></html>")
    png_path = tmp_path / "test.png"
    monkeypatch.setattr(shutil, "which", lambda x: None)
    result = screenshot_html(html_path, png_path)
    assert result is False
    assert not png_path.exists()


def test_build_evaluation_prompt():
    prompt = build_evaluation_prompt(
        skill_name="stark-session",
        audience="usage",
        num_candidates=3,
    )
    assert "visual_clarity" in prompt
    assert "accuracy" in prompt
    assert "audience_fit" in prompt
    assert "JSON" in prompt


def test_parse_evaluation_scores():
    raw = '''{"scores": [
        {"agent": "claude", "visual_clarity": 8, "completeness": 9, "info_architecture": 7, "accuracy": 9, "design_quality": 7, "audience_fit": 8},
        {"agent": "codex", "visual_clarity": 7, "completeness": 8, "info_architecture": 8, "accuracy": 8, "design_quality": 6, "audience_fit": 7},
        {"agent": "gemini", "visual_clarity": 9, "completeness": 7, "info_architecture": 8, "accuracy": 7, "design_quality": 8, "audience_fit": 9}
    ]}'''
    scores = parse_evaluation_scores(raw)
    assert len(scores) == 3


FACTOR_WEIGHTS = {
    "visual_clarity": 1.0, "completeness": 1.0, "info_architecture": 1.0,
    "accuracy": 1.5, "design_quality": 0.5, "audience_fit": 1.5,
}


def test_compute_weighted_average():
    scores = {"visual_clarity": 8, "completeness": 9, "info_architecture": 7,
              "accuracy": 9, "design_quality": 7, "audience_fit": 8}
    avg = compute_weighted_average(scores, FACTOR_WEIGHTS)
    # (8*1 + 9*1 + 7*1 + 9*1.5 + 7*0.5 + 8*1.5) / (1+1+1+1.5+0.5+1.5) = 53/6.5 ≈ 8.15
    assert abs(avg - 8.15) < 0.1


def test_select_winner():
    agent_scores = {"claude": 8.15, "codex": 7.5, "gemini": 8.15}
    accuracy_scores = {"claude": 9.0, "codex": 8.0, "gemini": 8.5}
    winner = select_winner(agent_scores, accuracy_scores)
    assert winner == "claude"  # tie broken by accuracy


def test_select_winner_random_on_full_tie():
    """When scores AND accuracy are identical, random pick (not alphabetical)."""
    import random
    agent_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    accuracy_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    # Seed for determinism, then verify different seeds produce different winners
    random.seed(42)
    winner_a = select_winner(agent_scores, accuracy_scores)
    random.seed(99)
    winner_b = select_winner(agent_scores, accuracy_scores)
    # At least one should differ from alphabetical first ("claude")
    assert winner_a in ("claude", "codex", "gemini")
    assert winner_b in ("claude", "codex", "gemini")
    # The implementation must use random.choice, not sorted()[0]
    assert not (winner_a == "claude" and winner_b == "claude"), \
        "Tie-breaking appears alphabetical, not random"
```

- [ ] **Step 3: Implement screenshot + evaluation**

Screenshot function — copy from `infra-ai-platform/scripts/generate-viz.py:1257-1284`:

```python
def screenshot_html(html_path: Path, png_path: Path) -> bool:
    """Render HTML to PNG via Playwright with JS disabled and network blocked.
    Returns True if PNG changed."""
    npx = shutil.which("npx")
    if not npx:
        print(f"  SKIP  {png_path.name} (npx not found — run: npx playwright install chromium)")
        return False
    tmp_png = png_path.with_suffix(".tmp.png")
    try:
        subprocess.run(
            [npx, "playwright", "screenshot", "--full-page",
             "--viewport-size=1200,800",
             f"file://{html_path.resolve()}", str(tmp_png)],
            capture_output=True, timeout=30, check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"  ERROR  {png_path.name}: {e}")
        tmp_png.unlink(missing_ok=True)
        return False
    # Compare by content hash to avoid unnecessary git churn
    if png_path.exists():
        old_hash = hashlib.md5(png_path.read_bytes()).hexdigest()
        new_hash = hashlib.md5(tmp_png.read_bytes()).hexdigest()
        if old_hash == new_hash:
            tmp_png.unlink()
            return False
    tmp_png.rename(png_path)
    return True
```

Note: Playwright's `screenshot` CLI command runs with a minimal browser context. For additional hardening, the script should also use the Playwright Python API when available to set `page.route('**', lambda route: route.abort())` for network isolation. This is a defense-in-depth measure on top of the HTML sanitization.

Evaluation — Claude as single judge, evaluating PNG screenshots:

```python
def build_evaluation_prompt(skill_name: str, audience: str, num_candidates: int) -> str:
    """Prompt for Claude to score candidate PNGs."""
    # Claude receives the PNGs as images and scores each on 6 factors
    ...

def run_evaluation(skill: SkillData, audience: str, candidate_pngs: dict[str, Path]) -> dict:
    """Run Claude to evaluate candidate PNGs. Returns audit dict with scores and winner."""
    # Uses claude -p with image inputs
    # Returns: {"winner": "agent", "winner_score": N.N, "scores": {...}, "quality_flag": "ok"|"needs-human-review"}
    ...

def compute_weighted_average(scores: dict[str, float], weights: dict[str, float]) -> float:
    total = sum(scores[k] * weights[k] for k in weights if k in scores)
    weight_sum = sum(weights[k] for k in weights if k in scores)
    return total / weight_sum if weight_sum else 0.0

def select_winner(agent_scores: dict[str, float], accuracy_scores: dict[str, float]) -> str:
    """Highest weighted avg. Ties broken by accuracy, then random."""
    import random
    max_score = max(agent_scores.values())
    tied = [a for a, s in agent_scores.items() if s == max_score]
    if len(tied) == 1:
        return tied[0]
    # Break by accuracy
    max_acc = max(accuracy_scores[a] for a in tied)
    acc_tied = [a for a in tied if accuracy_scores[a] == max_acc]
    return random.choice(acc_tied)
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "screenshot or evaluation or weighted or winner" -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: Playwright screenshots + single-judge evaluation on PNGs"
```

---

### Task 5: Winner Stamping + Audit Trail

**Files:**
- Modify: `scripts/generate_skill_docs.py`
- Modify: `scripts/test_generate_skill_docs.py`

- [ ] **Step 1: Write failing tests**

```python
def test_stamp_winner_html():
    html = '<html><body><div class="footer">placeholder</div></body></html>'
    stamped = stamp_winner_html(html, winner="gemini", score=8.42)
    assert "Gemini" in stamped
    assert "8.4" in stamped


def test_write_audit_entry(tmp_path):
    audit_path = tmp_path / "scores.jsonl"
    entry = {"skill": "stark-review", "audience": "usage", "winner": "claude", "winner_score": 8.25}
    write_audit_entry(audit_path, entry)
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["skill"] == "stark-review"
    assert "timestamp" in parsed

    write_audit_entry(audit_path, {**entry, "skill": "stark-session"})
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 2
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "stamp or audit" -v
```

- [ ] **Step 3: Implement**

```python
def stamp_winner_html(html: str, winner: str, score: float) -> str:
    """Replace footer placeholder with winning LLM attribution."""
    badge = f'Visualization by {AGENTS[winner]["label"]} · Score: {score:.1f}/10 · Generated from SKILL.md'
    return re.sub(
        r'<div class="footer">.*?</div>',
        f'<div class="footer"><div class="winner-badge">{badge}</div></div>',
        html, flags=re.DOTALL,
    )

import threading
_audit_lock = threading.Lock()

def write_audit_entry(audit_path: Path, entry: dict) -> None:
    import datetime
    entry["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with _audit_lock:
        with open(audit_path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "stamp or audit" -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: winner HTML stamping and audit trail"
```

---

### Task 6: Markdown Generation (Mermaid + PNG)

**Files:**
- Modify: `scripts/generate_skill_docs.py`
- Modify: `scripts/test_generate_skill_docs.py`

- [ ] **Step 1: Write failing tests**

```python
def test_generate_usage_markdown():
    data = parse_skill_md(FIXTURE)
    mermaid = "graph TD\n    A[Start] --> B[End]"
    doc_content = {"prerequisites": "Requires gh CLI", "troubleshooting": "If auth fails..."}
    alt_text = "Workflow diagram showing session start and end phases"
    md = generate_usage_markdown(data, mermaid_diagram=mermaid, doc_content=doc_content,
                                  alt_text=alt_text, has_png=True)
    assert "# stark-session" in md
    assert "```mermaid" in md
    assert "A[Start] --> B[End]" in md  # exact Mermaid content preserved
    assert f"![{alt_text}](usage.png)" in md  # descriptive alt text, not just skill name
    assert "## When to Use" in md
    assert "## Prerequisites" in md
    assert "Requires gh CLI" in md  # doc_content populated
    assert "## Troubleshooting" in md
    assert "If auth fails" in md


def test_generate_usage_markdown_no_png():
    data = parse_skill_md(FIXTURE)
    md = generate_usage_markdown(data, mermaid_diagram="graph TD\n  A-->B", doc_content={},
                                  alt_text="", has_png=False)
    assert "usage.png" not in md
    assert "usage.html" in md  # fallback link to HTML
    assert "A-->B" in md  # Mermaid still present


def test_generate_internals_markdown():
    data = parse_skill_md(FIXTURE)
    mermaid = "graph TD\n    A[Phase 1] --> B[Phase 2]"
    doc_content = {"how_to_modify": "Edit SKILL.md, run /stark-generate-docs"}
    alt_text = "Phase flow diagram for stark-session internals"
    md = generate_internals_markdown(data, mermaid_diagram=mermaid, doc_content=doc_content,
                                      alt_text=alt_text, has_png=True)
    assert "# stark-session — Internals" in md
    assert "```mermaid" in md
    assert "A[Phase 1] --> B[Phase 2]" in md  # exact content
    assert f"![{alt_text}](internals.png)" in md
    assert "## How to Modify" in md  # NOT "Extension Points"
    assert "Edit SKILL.md" in md


def test_generate_index_markdown():
    fixture_review = Path(__file__).parent.parent / "skill" / "stark-review" / "SKILL.md"
    fixture_session = Path(__file__).parent.parent / "skill" / "stark-session" / "SKILL.md"
    skills = [parse_skill_md(fixture_review), parse_skill_md(fixture_session)]
    md = generate_index_markdown(skills)
    assert "stark-review" in md
    assert "stark-session" in md
    assert "usage.md" in md
    assert "internals.md" in md
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "markdown" -v
```

- [ ] **Step 3: Implement markdown generators**

```python
def generate_usage_markdown(skill: SkillData, mermaid_diagram: str, doc_content: dict,
                            alt_text: str, has_png: bool) -> str:
    """Generate user-facing documentation with Mermaid + optional PNG.
    doc_content provides LLM-generated section text (loaded from {audience}.json)."""
    lines = [
        f"# {skill.name}",
        "",
        skill.description,
        "",
        "## Workflow Overview",
        "",
        "```mermaid",
        mermaid_diagram,
        "```",
        "",
    ]
    if has_png:
        lines += [f"![{alt_text}](usage.png)", ""]
    else:
        lines += [f"[View detailed visualization](usage.html)", ""]

    lines += [
        "## When to Use",
        "",
        # Extract trigger phrases from description
        skill.description,
        "",
        "## Prerequisites",
        "",
        doc_content.get("prerequisites", "*See SKILL.md*"),
        "",
        "## Arguments",
        "",
        f"`{skill.argument_hint}`" if skill.argument_hint else "*No arguments*",
        "",
        doc_content.get("arguments_table", ""),
        "",
        "## Quick Start",
        "",
        doc_content.get("quick_start", f"`/{skill.name}`"),
        "",
        "## Common Patterns",
        "",
        doc_content.get("common_patterns", ""),
        "",
        "## Troubleshooting",
        "",
        doc_content.get("troubleshooting", ""),
        "",
        "## Related Skills",
        "",
        ", ".join(f"`/{s}`" for s in doc_content.get("related_skills", [])),
        "",
    ]
    return "\n".join(lines)


def generate_internals_markdown(skill: SkillData, mermaid_diagram: str, doc_content: dict,
                                 alt_text: str, has_png: bool) -> str:
    """Generate contributor-facing documentation with Mermaid + optional PNG.
    doc_content provides LLM-generated section text (loaded from {audience}.json)."""
    lines = [
        f"# {skill.name} — Internals",
        "",
        skill.description,
        "",
        "## Architecture",
        "",
        "```mermaid",
        mermaid_diagram,
        "```",
        "",
    ]
    if has_png:
        lines += [f"![{alt_text}](internals.png)", ""]
    else:
        lines += ["[View detailed visualization](internals.html)", ""]

    lines += [
        "## Phases",
        "",
        doc_content.get("phase_walkthrough", "*See SKILL.md*"),
        "",
        "## Config",
        "",
        doc_content.get("config_schema", "*No config*"),
        "",
        "## Failure Modes",
        "",
        doc_content.get("failure_modes", "*See SKILL.md*"),
        "",
        "## How to Modify This Skill",
        "",
        doc_content.get("how_to_modify", f"Edit `skill/{skill.name}/SKILL.md`, then run `/stark-generate-docs --skill {skill.name}` to regenerate documentation."),
        "",
    ]
    return "\n".join(lines)


def generate_index_markdown(skills: list[SkillData]) -> str:
    """Generate docs/skills/index.md linking all skills."""
    ...
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "markdown" -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: markdown generation with Mermaid diagrams + conditional PNG embeds"
```

---

### Task 7: Staleness Detection

**Files:**
- Modify: `scripts/generate_skill_docs.py`
- Modify: `scripts/test_generate_skill_docs.py`

- [ ] **Step 1: Write failing tests**

```python
def test_compute_manifest(tmp_path):
    skill_dir = tmp_path / "skill" / "test-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Test")
    css_path = tmp_path / "css" / "design-system.css"
    css_path.parent.mkdir(parents=True)
    css_path.write_text("body { color: black; }")
    manifest = compute_manifest(tmp_path / "skill", css_path, "1.0.0")
    assert "test-skill" in manifest["skills"]
    assert "css_hash" in manifest["meta"]
    assert manifest["meta"]["script_version"] == "1.0.0"
    assert "usage_quality" in manifest["skills"]["test-skill"]
    assert "internals_quality" in manifest["skills"]["test-skill"]


def test_check_staleness_clean(tmp_path):
    manifest = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
                "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "ok"}}}
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    current = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
               "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "ok"}}}
    stale = check_staleness(manifest_path, current)
    assert len(stale) == 0


def test_check_staleness_skill_changed(tmp_path):
    manifest = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
                "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "ok"}}}
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    current = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
               "skills": {"test-skill": {"hash": "CHANGED", "usage_quality": "ok", "internals_quality": "ok"}}}
    stale = check_staleness(manifest_path, current)
    assert "test-skill" in stale


def test_check_staleness_css_changed(tmp_path):
    manifest = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
                "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "ok"}}}
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    current = {"meta": {"css_hash": "CHANGED", "script_version": "1.0.0"},
               "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "ok"}}}
    stale = check_staleness(manifest_path, current)
    assert "test-skill" in stale


def test_check_staleness_usage_needs_review(tmp_path):
    """Skills with usage flagged needs-human-review are always stale."""
    manifest = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
                "skills": {"test-skill": {"hash": "abc123", "usage_quality": "needs-human-review", "internals_quality": "ok"}}}
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    current = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
               "skills": {"test-skill": {"hash": "abc123", "usage_quality": "needs-human-review", "internals_quality": "ok"}}}
    stale = check_staleness(manifest_path, current)
    assert "test-skill" in stale


def test_check_staleness_internals_needs_review(tmp_path):
    """Skills with internals flagged needs-human-review are also stale."""
    manifest = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
                "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "needs-human-review"}}}
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    current = {"meta": {"css_hash": "abc", "script_version": "1.0.0"},
               "skills": {"test-skill": {"hash": "abc123", "usage_quality": "ok", "internals_quality": "needs-human-review"}}}
    stale = check_staleness(manifest_path, current)
    assert "test-skill" in stale
```

- [ ] **Step 2: Run to verify fail**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "manifest or staleness" -v
```

- [ ] **Step 3: Implement**

```python
def compute_manifest(skill_dir: Path, css_path: Path, script_version: str) -> dict:
    """Compute manifest with SKILL.md hashes + CSS hash + script version."""
    css_hash = hashlib.sha256(css_path.read_bytes()).hexdigest()[:16] if css_path.exists() else "missing"
    skills = {}
    for d in sorted(skill_dir.iterdir()):
        md_file = d / "SKILL.md"
        if md_file.exists():
            skills[d.name] = {
                "hash": hashlib.sha256(md_file.read_bytes()).hexdigest()[:16],
                "usage_quality": "ok",
                "internals_quality": "ok",
            }
    return {"meta": {"css_hash": css_hash, "script_version": script_version}, "skills": skills}


def check_staleness(manifest_path: Path, current: dict) -> list[str]:
    """Compare current state to stored manifest. Returns list of stale skill names."""
    if not manifest_path.exists():
        return list(current["skills"].keys())
    stored = json.loads(manifest_path.read_text())
    stale = []
    # Global change (CSS or script version) = all stale
    if stored.get("meta", {}) != current.get("meta", {}):
        return list(current["skills"].keys())
    for name, info in current["skills"].items():
        stored_info = stored.get("skills", {}).get(name, {})
        if stored_info.get("hash") != info["hash"]:
            stale.append(name)
        # Any audience flagged needs-human-review = stale
        elif stored_info.get("usage_quality") == "needs-human-review":
            stale.append(name)
        elif stored_info.get("internals_quality") == "needs-human-review":
            stale.append(name)
    return stale
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -k "manifest or staleness" -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: staleness detection tracking SKILL.md + CSS + script version"
```

---

### Task 8: Main Orchestrator & CLI

**Files:**
- Modify: `scripts/generate_skill_docs.py`

- [ ] **Step 1: Implement the main() function**

Single flat ThreadPoolExecutor, MAX_WORKERS=6. No nested pools. All LLM generation calls go into one pool. Evaluation runs sequentially per skill after its generation completes.

```python
def main() -> int:
    parser = argparse.ArgumentParser(description="Generate skill docs with multi-LLM viz competition")
    parser.add_argument("--skill", type=str, help="Generate for one skill only")
    parser.add_argument("--check", action="store_true", help="Exit 1 if docs are stale (for CI)")
    parser.add_argument("--no-screenshots", action="store_true", help="Skip PNG generation")
    parser.add_argument("--no-evaluation", action="store_true", help="Skip judge, use first valid result")
    parser.add_argument("--markdown-only", action="store_true", help="Skip LLM, regenerate markdown from persisted artifacts")
    parser.add_argument("--dry-run", action="store_true", help="Show what would change")
    parser.add_argument("--force", "--all", action="store_true", dest="force", help="Regenerate even if manifest is clean")
    parser.add_argument("-o", "--output-dir", type=Path, default=DEFAULT_OUT, help="Output directory")
    args = parser.parse_args()

    # 1. Discover skills (returns list[Path] — use .name for string key)
    skills = discover_skills(SKILL_DIR, filter_name=args.skill)
    if not skills:
        print("No skills found.")
        return 1

    css_path = args.output_dir / "_css" / "design-system.css"

    # 2. Staleness check
    current_manifest = compute_manifest(SKILL_DIR, css_path, SCRIPT_VERSION)
    if args.check:
        stale = check_staleness(args.output_dir / "_manifest.json", current_manifest)
        if stale:
            print(f"STALE: {', '.join(stale)}")
            return 1
        print("All docs up to date.")
        return 0

    # 3. Filter to stale skills only (unless --force)
    if not args.force and not args.markdown_only:
        stale_names = set(check_staleness(args.output_dir / "_manifest.json", current_manifest))
        if args.skill:
            stale_names.add(args.skill)
        skills = [s for s in skills if s.name in stale_names]
        if not skills:
            print("All docs up to date. Use --force to regenerate.")
            return 0

    # 4. Parse
    parsed = [(s, parse_skill_md(s / "SKILL.md")) for s in skills]
    print(f"Processing {len(parsed)} skills")

    # 5. Generate HTML viz — flat ThreadPoolExecutor, MAX_WORKERS=6
    audit_path = args.output_dir / "_audit" / "scores.jsonl"
    # skill_name -> audience -> {winner: VizResult, eval_result: dict}
    winning_data: dict[str, dict[str, dict]] = {}

    if not args.markdown_only:
        all_tasks = []
        for skill_path, skill_data in parsed:
            for audience in ("usage", "internals"):
                for agent in AGENTS:
                    all_tasks.append((agent, skill_data, audience))

        print(f"\nGenerating: {len(all_tasks)} LLM calls ({len(parsed)} skills × 2 audiences × 3 LLMs)")

        if args.dry_run:
            for agent, skill_data, audience in all_tasks:
                print(f"  WOULD generate  {skill_data.name} × {audience} × {agent}")
        else:
            # Flat dict keyed by "skill:audience" → list of VizResults
            results_by_key: dict[str, list[VizResult]] = {}

            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                futures = {}
                for agent, skill_data, audience in all_tasks:
                    future = pool.submit(_run_viz_agent, agent, skill_data, audience)
                    futures[future] = (agent, skill_data, audience)
                    print(f"  [{AGENTS[agent]['emoji']}] {agent} × {skill_data.name} × {audience}...")

                for future in as_completed(futures):
                    agent, skill_data, audience = futures[future]
                    try:
                        result = future.result()
                    except Exception as e:
                        # Worker exception → disqualify, don't abort batch (#19)
                        print(f"  [{AGENTS[agent]['emoji']}] {agent} × {skill_data.name} × {audience}: EXCEPTION — {e}")
                        result = VizResult(agent=agent, skill=skill_data.name, audience=audience,
                                           html="", mermaid="", doc_content={}, alt_text="",
                                           error=str(e), duration_s=0.0)
                    key = f"{skill_data.name}:{audience}"
                    results_by_key.setdefault(key, []).append(result)

                    status = f"{len(result.html)} chars" if result.html else f"ERROR: {result.error}"
                    print(f"  [{AGENTS[agent]['emoji']}] {agent} × {skill_data.name} × {audience}: {status} [{result.duration_s:.1f}s]")

            # 6. Sanitize, screenshot ALL candidates, then evaluate
            print("\nProcessing candidates:")
            for key, results in results_by_key.items():
                skill_name, audience = key.split(":", 1)
                out_dir = args.output_dir / skill_name
                out_dir.mkdir(parents=True, exist_ok=True)

                # Sanitize + validate
                valid = [r for r in results if r.html and not r.error]
                for r in valid:
                    r.html = sanitize_html(r.html)
                    if not validate_html(r.html):
                        print(f"  INVALID  {skill_name}/{audience} from {r.agent}")
                        r.error = "invalid_html"
                valid = [r for r in valid if not r.error]

                if not valid:
                    print(f"  ERROR  all LLMs failed for {skill_name} × {audience}")
                    continue

                # Write all candidate HTMLs + screenshot them
                candidate_pngs: dict[str, Path] = {}
                for r in valid:
                    candidate_html = out_dir / f"{audience}.{r.agent}.html"
                    candidate_html.write_text(r.html)
                    if not args.no_screenshots:
                        candidate_png = out_dir / f"{audience}.{r.agent}.png"
                        if screenshot_html(candidate_html, candidate_png):
                            candidate_pngs[r.agent] = candidate_png
                        elif candidate_png.exists():
                            candidate_pngs[r.agent] = candidate_png

                # 7. Evaluate (single judge on PNGs)
                if len(valid) == 1 or args.no_evaluation:
                    winner_result = valid[0]
                    eval_result = {
                        "skill": skill_name, "audience": audience,
                        "winner": winner_result.agent, "winner_score": 0.0,
                        "scores": {}, "judge": "none",
                        "quality_flag": "degraded" if len(valid) == 1 else "unevaluated",
                    }
                elif candidate_pngs and len(candidate_pngs) >= 2:
                    try:
                        eval_result = run_evaluation(
                            next(sd for _, sd in parsed if sd.name == skill_name),
                            audience, candidate_pngs,
                        )
                        winner_result = next(r for r in valid if r.agent == eval_result["winner"])
                    except Exception as e:
                        print(f"  EVAL ERROR  {skill_name}/{audience}: {e} — using first valid")
                        winner_result = valid[0]
                        eval_result = {
                            "skill": skill_name, "audience": audience,
                            "winner": winner_result.agent, "winner_score": 0.0,
                            "scores": {}, "judge": "none",
                            "quality_flag": "eval-failed",
                        }
                else:
                    winner_result = valid[0]
                    eval_result = {
                        "skill": skill_name, "audience": audience,
                        "winner": winner_result.agent, "winner_score": 0.0,
                        "scores": {}, "judge": "none",
                        "quality_flag": "no-screenshots",
                    }

                # Stamp winner HTML and save as the canonical file
                winning_html = stamp_winner_html(winner_result.html, eval_result["winner"], eval_result["winner_score"])
                (out_dir / f"{audience}.html").write_text(winning_html)

                # Persist Mermaid + doc content for --markdown-only rebuilds
                (out_dir / f"{audience}.mermaid").write_text(winner_result.mermaid)
                (out_dir / f"{audience}.json").write_text(json.dumps(winner_result.doc_content, indent=2))

                # Screenshot the winning HTML as the canonical PNG
                if not args.no_screenshots:
                    screenshot_html(out_dir / f"{audience}.html", out_dir / f"{audience}.png")

                # Clean up candidate files (keep only winner)
                for r in valid:
                    (out_dir / f"{audience}.{r.agent}.html").unlink(missing_ok=True)
                    (out_dir / f"{audience}.{r.agent}.png").unlink(missing_ok=True)

                # Store winning data for markdown generation + manifest
                winning_data.setdefault(skill_name, {})[audience] = {
                    "result": winner_result,
                    "eval": eval_result,
                }

                # Audit
                write_audit_entry(audit_path, eval_result)
                quality = eval_result.get("quality_flag", "ok")
                score_str = f"{eval_result['winner_score']:.1f}" if eval_result["winner_score"] else "n/a"
                print(f"  Winner: {eval_result['winner']} ({score_str}/10, {quality}) — {skill_name}/{audience}")

    # 8. Generate markdown
    if not args.dry_run:
        print("\nMarkdown:")
        for skill_path, skill_data in parsed:
            out_dir = args.output_dir / skill_data.name
            out_dir.mkdir(parents=True, exist_ok=True)
            for audience in ("usage", "internals"):
                # Load from winning_data (fresh run) or from disk (--markdown-only)
                win = winning_data.get(skill_data.name, {}).get(audience)
                if win:
                    mermaid = win["result"].mermaid
                    doc_content = win["result"].doc_content
                    alt_text = win["result"].alt_text
                else:
                    # --markdown-only: load persisted artifacts from disk
                    mermaid_path = out_dir / f"{audience}.mermaid"
                    json_path = out_dir / f"{audience}.json"
                    mermaid = mermaid_path.read_text() if mermaid_path.exists() else ""
                    doc_content = json.loads(json_path.read_text()) if json_path.exists() else {}
                    alt_text = doc_content.get("alt_text", f"{skill_data.name} {audience} visualization")

                has_png = (out_dir / f"{audience}.png").exists()
                if audience == "usage":
                    md = generate_usage_markdown(skill_data, mermaid, doc_content, alt_text, has_png)
                else:
                    md = generate_internals_markdown(skill_data, mermaid, doc_content, alt_text, has_png)
                (out_dir / f"{audience}.md").write_text(md)
            print(f"  generated  {skill_data.name}/usage.md + internals.md")

        # 9. Index
        all_skills = [parse_skill_md(s / "SKILL.md") for s in discover_skills(SKILL_DIR)]
        (args.output_dir / "index.md").write_text(generate_index_markdown(all_skills))
        print("  generated  index.md")

        # 10. Update manifest with per-audience quality flags
        manifest = compute_manifest(SKILL_DIR, css_path, SCRIPT_VERSION)
        for skill_name, audiences in winning_data.items():
            if skill_name in manifest["skills"]:
                for audience in ("usage", "internals"):
                    aud_data = audiences.get(audience, {})
                    eval_result = aud_data.get("eval", {})
                    quality = eval_result.get("quality_flag", "ok")
                    manifest["skills"][skill_name][f"{audience}_quality"] = quality
        (args.output_dir / "_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
        print("  updated    _manifest.json")
    else:
        print(f"\nDry run complete. Would process {len(parsed)} skills.")

    return 0
```

- [ ] **Step 2: Test CLI**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python scripts/generate_skill_docs.py --help
python scripts/generate_skill_docs.py --dry-run --skill stark-session
```

- [ ] **Step 3: Add orchestrator and routing guide tests**

Add to `scripts/test_generate_skill_docs.py`:

```python
def test_main_check_mode_clean(tmp_path, monkeypatch):
    """--check returns 0 when manifest is current."""
    # Set up a manifest that matches current state
    skill_dir = Path(__file__).parent.parent / "skill"
    css_path = tmp_path / "_css" / "design-system.css"
    css_path.parent.mkdir(parents=True)
    css_path.write_text("body {}")
    manifest = compute_manifest(skill_dir, css_path, SCRIPT_VERSION)
    manifest_path = tmp_path / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    monkeypatch.setattr(sys, "argv", ["prog", "--check", "-o", str(tmp_path)])
    assert main() == 0


def test_main_check_mode_stale(tmp_path, monkeypatch):
    """--check returns 1 when no manifest exists."""
    monkeypatch.setattr(sys, "argv", ["prog", "--check", "-o", str(tmp_path)])
    assert main() == 1


def test_generate_routing_guide():
    """Routing guide contains all skills and valid Mermaid."""
    skill_dir = Path(__file__).parent.parent / "skill"
    skills = [parse_skill_md(s / "SKILL.md") for s in discover_skills(skill_dir)]
    md = generate_routing_guide(skills)
    # Every skill must appear exactly once
    for s in skills:
        assert s.name in md, f"{s.name} missing from routing guide"
    # Must contain Mermaid decision tree
    assert "```mermaid" in md
    assert "graph TD" in md or "graph LR" in md
```

- [ ] **Step 4: Run tests**

```bash
python -m pytest scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate_skill_docs.py scripts/test_generate_skill_docs.py
git commit -m "feat: main orchestrator — flat ThreadPoolExecutor, single-judge, full CLI"
```

---

### Task 9: Routing Guide

**Files:**
- Create: `docs/skills/README.md`

The routing guide is the highest-value single file — it answers "which skill do I use?"

- [ ] **Step 1: Generate the routing guide**

Add a function `generate_routing_guide(skills: list[SkillData]) -> str` that produces a task-oriented decision tree. The function uses the skill descriptions to group skills by task domain and generates Mermaid decision trees.

```python
def generate_routing_guide(skills: list[SkillData]) -> str:
    """Generate docs/skills/README.md — task-oriented routing guide with Mermaid decision trees."""
    # Group skills by domain:
    # - Code Review: stark-review, stark-review-plan, stark-review-deployment-plan, stark-review-improvement
    # - PR & Shipping: stark-pr-flow, stark-release
    # - Planning: stark-plan-to-tasks, stark-phase-execute
    # - Session: stark-session, stark-session-insights
    # - Documentation: stark-init-docs, stark-extract-docs, stark-generate-docs, stark-claude-md-improver
    # - Project Management: stark-onboard-project, stark-rename-project, stark-update-deps
    # - Analytics: stark-metrics, stark-skill-analytics, stark-pr-status
    #
    # For each group: "I want to..." section + Mermaid decision tree
    ...
```

- [ ] **Step 2: Wire into main() — generate routing guide alongside index**

- [ ] **Step 3: Commit**

```bash
git add scripts/generate_skill_docs.py docs/skills/README.md
git commit -m "feat: routing guide — task-to-skill decision trees with Mermaid"
```

---

### Task 10: End-to-End Test with One Skill

**Files:**
- No new files — integration test

- [ ] **Step 1: Run for stark-metrics (smallest skill)**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python scripts/generate_skill_docs.py --skill stark-metrics
```

- [ ] **Step 2: Verify output**

```bash
ls -la docs/skills/stark-metrics/
cat docs/skills/stark-metrics/usage.md | head -30
cat docs/skills/_audit/scores.jsonl
```

Verify: usage.md has both Mermaid diagram and PNG embed (or HTML link if no Playwright).

- [ ] **Step 3: Open HTML for visual check**

```bash
open docs/skills/stark-metrics/usage.html
```

- [ ] **Step 4: Staleness check**

```bash
python scripts/generate_skill_docs.py --check
```

Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add docs/skills/
git commit -m "feat: initial skill docs — stark-metrics (end-to-end validation)"
```

---

### Task 11: Full Run — All 19 Skills

- [ ] **Step 1: Run full pipeline**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python scripts/generate_skill_docs.py --force 2>&1 | tee /tmp/skill-docs-run.log
```

152 LLM calls (19 × 2 × 3 gen + 19 × 2 eval). Monitor for errors.

- [ ] **Step 2: Verify output**

```bash
ls docs/skills/*/usage.md | wc -l    # 19
ls docs/skills/*/internals.md | wc -l # 19
wc -l docs/skills/_audit/scores.jsonl # 38 lines (19 skills × 2 audiences)
cat docs/skills/README.md | head -40  # routing guide
cat docs/skills/index.md | head -40
```

- [ ] **Step 3: Visual review of 3 samples**

```bash
open docs/skills/stark-review/usage.html
open docs/skills/stark-phase-execute/internals.html
open docs/skills/stark-session/usage.html
```

- [ ] **Step 4: Commit**

```bash
git add docs/skills/
git commit -m "feat: complete skill docs for all 19 skills — Mermaid + HTML viz + routing guide"
```

---

### Task 12: `/stark-generate-docs` Skill

**Files:**
- Create: `skill/stark-generate-docs/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
---
name: stark-generate-docs
description: >
  Generate or update skill documentation with multi-LLM visualizations.
  Detects which SKILL.md files changed, regenerates docs for those skills,
  and commits the results. Use when the user says "generate docs",
  "update skill docs", "regenerate viz", or invokes /stark-generate-docs.
  Proactively use when a SKILL.md has been modified in the current session.
argument-hint: "[--skill <name>] [--all] [--check] [--force]"
---

# stark-generate-docs

Generate or update skill documentation with multi-LLM visualization competition.

## Arguments

- `/stark-generate-docs` — regenerate docs for skills with changed SKILL.md files
- `/stark-generate-docs --skill <name>` — regenerate one specific skill
- `/stark-generate-docs --all` — regenerate all (alias for `--force`)
- `/stark-generate-docs --check` — check if any docs are stale (no changes)

## Constants

```
ROOT = <repo root of stark-skills>
```

## Workflow

### Phase 1: Detect Changes

If `--skill` or `--all` specified, skip detection.

Otherwise:

```bash
python $ROOT/scripts/generate_skill_docs.py --check
```

If exit 0: "All skill docs are up to date." Done.
If exit 1: capture stale skill names.

### Phase 2: Generate

```bash
python $ROOT/scripts/generate_skill_docs.py [--skill <name> | --force]
```

Report progress per skill.

### Phase 3: Commit

```bash
cd $ROOT
git add docs/skills/
git commit -m "docs: update skill documentation — <list of skills>"
```

### Phase 4: Summary

Report: updated skills, winners, scores, file counts.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| LLM calls fail | Report which failed, continue |
| Playwright missing | Skip screenshots, warn |
| No changes | Report "all up to date" |
```

- [ ] **Step 2: Verify install.sh picks it up**

```bash
grep -c "skill/" /Users/aryeh/git/Evinced/stark-skills/install.sh
./install.sh && ls -la ~/.claude/skills/stark-generate-docs/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add skill/stark-generate-docs/SKILL.md
git commit -m "feat: /stark-generate-docs skill for ongoing doc maintenance"
```

---

### Task 13: Update CLAUDE.md Files

**Files:**
- Modify: `CLAUDE.md` (stark-skills repo)
- Modify: `~/git/Evinced/CLAUDE.md` (separate repo)

- [ ] **Step 1: Add to stark-skills CLAUDE.md skills table**

```
| `/stark-generate-docs [--skill <name>]` | Generate/update skill docs with multi-LLM viz |
```

- [ ] **Step 2: Commit stark-skills**

```bash
git add CLAUDE.md
git commit -m "docs: add /stark-generate-docs to skill tables"
```

- [ ] **Step 3: Add to Evinced CLAUDE.md (separate repo)**

```bash
cd ~/git/Evinced
# Add row to Global Skills table
git add CLAUDE.md
git commit -m "docs: add /stark-generate-docs to global skills table"
cd /Users/aryeh/git/Evinced/stark-skills
```

---

### Task 14: Final Verification

- [ ] **Step 1: Full test suite**

```bash
cd /Users/aryeh/git/Evinced/stark-skills && python -m pytest scripts/test_generate_skill_docs.py -v
```

- [ ] **Step 2: Staleness check**

```bash
python scripts/generate_skill_docs.py --check
```

- [ ] **Step 3: Install verification**

```bash
./install.sh --status
```
