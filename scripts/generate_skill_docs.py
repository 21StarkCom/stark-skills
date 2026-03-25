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
import html.parser
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

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
        m = re.search(r"^description:\s*>\s*\n((?:\s+.+\n?)*)", fm, re.MULTILINE)
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


# ── HTML sanitization & validation ─────────────────────────────────────


_DANGEROUS_TAGS = frozenset({"script", "iframe", "object", "embed", "meta"})
_DESIGN_SYSTEM_CLASSES = frozenset({
    "node-phase", "node-decision", "node-action", "node-input",
    "node-output", "node-error", "node-loop", "edge-label",
    "skill-flow", "skill-header", "phase-group",
})


class _Sanitizer(html.parser.HTMLParser):
    """HTMLParser subclass that strips dangerous tags and event handlers."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._out: list[str] = []
        self._skip_depth: int = 0  # depth inside a stripped tag (script)
        self._skip_tag: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        if tag_lower in _DANGEROUS_TAGS:
            if tag_lower == "script":
                self._skip_depth += 1
                self._skip_tag = "script"
            return
        if self._skip_depth > 0:
            return
        safe_attrs = [
            (k, v) for k, v in attrs if not k.lower().startswith("on")
        ]
        attr_str = ""
        for k, v in safe_attrs:
            if v is None:
                attr_str += f" {k}"
            else:
                attr_str += f' {k}="{v}"'
        self._out.append(f"<{tag}{attr_str}>")

    def handle_endtag(self, tag: str) -> None:
        tag_lower = tag.lower()
        if tag_lower == "script" and self._skip_depth > 0:
            self._skip_depth -= 1
            if self._skip_depth == 0:
                self._skip_tag = None
            return
        if tag_lower in _DANGEROUS_TAGS:
            return
        if self._skip_depth > 0:
            return
        self._out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(data)

    def handle_comment(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(f"<!--{data}-->")

    def handle_entityref(self, name: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(f"&#{name};")

    def handle_decl(self, decl: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(f"<!{decl}>")

    def get_output(self) -> str:
        return "".join(self._out)


def sanitize_html(html_str: str) -> str:
    """Strip dangerous tags, event handlers, and CSS injection vectors."""
    sanitizer = _Sanitizer()
    sanitizer.feed(html_str)
    result = sanitizer.get_output()
    # Post-process: strip CSS url() and @import
    result = re.sub(r"url\s*\([^)]*\)", "url()", result, flags=re.IGNORECASE)
    result = re.sub(r"@import\s+[^;]+;?", "", result, flags=re.IGNORECASE)
    return result


def validate_html(html_str: str) -> bool:
    """Validate HTML for safety and design-system compliance."""
    # Must contain <html and </html>
    if not re.search(r"<html[\s>]", html_str, re.IGNORECASE):
        return False
    if not re.search(r"</html>", html_str, re.IGNORECASE):
        return False

    # Strip comments before checking attribute URLs (comments are allowed to have URLs)
    no_comments = re.sub(r"<!--.*?-->", "", html_str, flags=re.DOTALL)

    # Reject external/dangerous URLs in src, href, action attributes
    dangerous_url_pattern = re.compile(
        r'''(?:src|href|action)\s*=\s*["']?\s*(?:https?://|//|data:|javascript:|file:)''',
        re.IGNORECASE,
    )
    if dangerous_url_pattern.search(no_comments):
        return False

    # Must use at least one design system class
    for cls in _DESIGN_SYSTEM_CLASSES:
        if cls in html_str:
            return True
    return False


# ── VizResult dataclass ────────────────────────────────────────────────


@dataclass
class VizResult:
    """Result from a single LLM visualization sub-agent."""
    agent: str
    skill: str
    audience: str
    html: str = ""
    mermaid: str = ""
    doc_content: dict[str, Any] = field(default_factory=dict)
    alt_text: str = ""
    error: str = ""
    duration_s: float = 0.0
    api_key_fallback: bool = False


# ── Prompt builder ─────────────────────────────────────────────────────


_css_cache: str | None = None


def _load_css() -> str:
    """Lazy-load the design-system.css file."""
    global _css_cache
    if _css_cache is None:
        css_path = ROOT / "docs" / "skills" / "_css" / "design-system.css"
        _css_cache = css_path.read_text()
    return _css_cache


def build_generation_prompt(skill: SkillData, audience: str, css: str) -> str:
    """Build prompt asking LLM to generate visualization artifacts.

    Returns a prompt that requests:
    - A standalone HTML page using the provided CSS
    - A Mermaid diagram in ```mermaid block
    - Structured doc content as JSON
    - Descriptive alt text for PNG screenshot
    """
    audience_desc = {
        "usage": "end-user focused: how to invoke the skill, inputs, outputs, common workflows",
        "internals": "contributor/developer focused: internal architecture, data flow, extension points",
    }.get(audience, audience)

    # Audience-specific doc content keys
    if audience == "usage":
        doc_keys_spec = (
            '  "prerequisites": "what must be installed/configured before using this skill",\n'
            '  "quick_start": "simplest invocation example",\n'
            '  "common_patterns": "2-3 common usage patterns as markdown",\n'
            '  "troubleshooting": "common issues and how to fix them",\n'
            '  "related_skills": ["skill-name-1", "skill-name-2"],\n'
            '  "arguments_table": "markdown table of arguments if any"'
        )
    else:
        doc_keys_spec = (
            '  "phase_walkthrough": "step-by-step description of each phase",\n'
            '  "config_schema": "config options and their defaults",\n'
            '  "failure_modes": "what can go wrong and how it recovers",\n'
            '  "how_to_modify": "how to change this skill behavior"'
        )

    return (
        f"Generate a standalone HTML page visualizing the skill **{skill.name}**.\n\n"
        f"## Audience\n\n"
        f"Target audience: **{audience}** — {audience_desc}\n\n"
        f"## Skill metadata\n\n"
        f"- Name: {skill.name}\n"
        f"- Description: {skill.description}\n"
        f"- Argument hint: {skill.argument_hint}\n"
        f"- Complexity: {skill.complexity} ({skill.line_count} lines)\n\n"
        f"## Skill content\n\n"
        f"```markdown\n{skill.raw_md}\n```\n\n"
        f"## CSS Design System\n\n"
        f"Use the following CSS inline in a `<style>` tag. You may extend it but do NOT "
        f"link external stylesheets or load external resources.\n\n"
        f"```css\n{css}\n```\n\n"
        f"## CRITICAL RULES\n\n"
        f"- Output the raw HTML directly — do NOT wrap it in a JSON string or code block.\n"
        f"- Do NOT escape the HTML (no \\n, no \\\"). Just output the literal HTML.\n"
        f"- Do NOT run shell commands or search files. Generate the content from the skill "
        f"description above.\n"
        f"- You MUST include all 4 outputs below. Missing any is a failure.\n\n"
        f"## Required outputs\n\n"
        f"Return ALL of the following in your response:\n\n"
        f"### 1. Standalone HTML page\n\n"
        f"Complete `<html>...</html>` document with the CSS inlined in a `<style>` tag. "
        f"Use design-system classes (node-phase, node-decision, node-config, node-output, "
        f"node-failure, node-external, flow, card-*, data-table, legend, etc.). "
        f"No external resources. Include a `<div class=\"footer\">placeholder</div>` at the end.\n\n"
        f"### 2. Mermaid diagram (REQUIRED)\n\n"
        f"A mermaid flowchart showing the skill's workflow. Output it in a fenced code block:\n\n"
        f"````\n```mermaid\ngraph TD\n    A[Step 1] --> B[Step 2]\n    B --> C[Step 3]\n```\n````\n\n"
        f"This MUST be present — it gets embedded in the markdown documentation.\n\n"
        f"### 3. Doc content JSON\n\n"
        f"Structured content for markdown doc sections. Output as a JSON code block with "
        f"EXACTLY these keys:\n\n"
        f"```json\n{{\n{doc_keys_spec}\n}}\n```\n\n"
        f"### 4. Alt text\n\n"
        f"A descriptive alt text for a PNG screenshot of the HTML. "
        f"Prefix with exactly `Alt text: `\n"
    )


# ── LLM sub-agent dispatch ────────────────────────────────────────────


PYTHON = sys.executable
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
CODEX_REASONING_CONFIG = 'model_reasoning_effort="high"'

_gemini_api_key_cache: str | None | bool = None  # None=not tried, False=not found


def _get_gemini_api_key() -> str | None:
    """Retrieve Gemini API key from macOS Keychain (cached)."""
    global _gemini_api_key_cache
    if _gemini_api_key_cache is not None:
        return _gemini_api_key_cache if _gemini_api_key_cache else None
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "GEMINI_API_KEY", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            _gemini_api_key_cache = result.stdout.strip()
            return _gemini_api_key_cache
    except Exception:
        pass
    _gemini_api_key_cache = False
    return None


def _unescape_json_string(s: str) -> str:
    """Unescape a string that was JSON-encoded by an LLM.

    Some LLMs return HTML wrapped in a JSON string, so literal \\n appears
    instead of newlines and quotes are backslash-escaped or doubled.
    """
    # Detect: if the first 200 chars contain literal \n, unescape
    if r"\n" not in s[:200]:
        return s
    # Unescape JSON string sequences
    s = s.replace("\\n", "\n")
    s = s.replace("\\t", "\t")
    # Handle double-escaped quotes first: \\" → "
    s = s.replace('\\\\"', '"')
    # Then single-escaped: \" → "
    s = s.replace('\\"', '"')
    # Fix remaining doubled quotes in attributes: ="" → ="
    s = re.sub(r'=""([^"]*?)""', r'="\1"', s)
    return s


def _parse_viz_response(raw: str) -> dict[str, Any]:
    """Parse LLM response to extract HTML, mermaid, doc_content JSON, and alt_text."""
    result: dict[str, Any] = {"html": "", "mermaid": "", "doc_content": {}, "alt_text": ""}

    # Extract HTML: look for <html>...</html>
    # Try inside ```html code block first (some LLMs wrap it)
    html_block = re.search(r"```html\s*\n([\s\S]*?)```", raw)
    if html_block and "<html" in html_block.group(1).lower():
        result["html"] = _unescape_json_string(html_block.group(1))
    else:
        html_match = re.search(r"(<html[\s\S]*?</html>)", raw, re.IGNORECASE)
        if html_match:
            result["html"] = _unescape_json_string(html_match.group(1))

    # Extract mermaid block — try multiple patterns
    # Pattern 1: ```mermaid\n...\n```
    mermaid_match = re.search(r"```mermaid\s*\n([\s\S]*?)```", raw)
    if mermaid_match:
        result["mermaid"] = mermaid_match.group(1).strip()
    else:
        # Pattern 2: ````mermaid (4 backticks)
        mermaid_match = re.search(r"````mermaid\s*\n([\s\S]*?)````", raw)
        if mermaid_match:
            result["mermaid"] = mermaid_match.group(1).strip()
        else:
            # Pattern 3: mermaid inside the HTML (some LLMs put it there)
            if result["html"]:
                mermaid_in_html = re.search(r"graph\s+(?:TD|LR|TB|BT)\s*\n[\s\S]*?(?=\n\s*```|\n\s*<)", result["html"])
                # Don't use this — it would extract from within the HTML

    # Extract JSON doc content — find the last ```json block (first might be inside HTML examples)
    json_matches = list(re.finditer(r"```json\s*\n([\s\S]*?)```", raw))
    if json_matches:
        # Use the last JSON block (the one after the HTML, not inside it)
        for jm in reversed(json_matches):
            try:
                parsed = json.loads(jm.group(1))
                if isinstance(parsed, dict):
                    result["doc_content"] = parsed
                    break
            except json.JSONDecodeError:
                continue

    # Extract alt text
    alt_match = re.search(r"Alt text:\s*(.+)", raw)
    if alt_match:
        result["alt_text"] = alt_match.group(1).strip()

    return result


def _run_viz_agent(agent: str, skill: SkillData, audience: str) -> VizResult:
    """Run one LLM CLI to generate a skill visualization.

    Mirrors dispatch patterns from scripts/multi_review.py.
    """
    css = _load_css()
    prompt = build_generation_prompt(skill, audience, css)
    t0 = time.monotonic()

    stdin_input: str | None = None
    gemini_home: str | None = None
    used_api_key_fallback = False

    if agent == "claude":
        cmd = [
            "claude",
            "-p", "-",
            "--output-format", "text",
            "--model", "claude-opus-4-6",
        ]
        stdin_input = prompt

    elif agent == "codex":
        cmd = [
            "codex", "exec",
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "--full-auto",
            "-",
        ]
        stdin_input = prompt

    elif agent == "gemini":
        gemini_home = tempfile.mkdtemp(prefix="gemini-viz-")
        gemini_dir = os.path.join(gemini_home, ".gemini")
        os.makedirs(gemini_dir, exist_ok=True)
        real_gemini = os.environ.get("GEMINI_CLI_HOME", os.path.expanduser("~"))
        real_gemini_dir = os.path.join(real_gemini, ".gemini")
        for auth_file in ("settings.json", "oauth_creds.json", "google_accounts.json", "installation_id"):
            src = os.path.join(real_gemini_dir, auth_file)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(gemini_dir, auth_file))
        cwd = str(ROOT)
        with open(os.path.join(gemini_dir, "projects.json"), "w") as f:
            json.dump({"projects": {cwd: "viz"}}, f)
        cmd = [
            "gemini",
            "-p", prompt,
            "-o", "json",
            "--approval-mode", "plan",
        ]
        stdin_input = None

    else:
        return VizResult(
            agent=agent, skill=skill.name, audience=audience,
            error=f"Unknown agent: {agent}",
        )

    run_kwargs: dict[str, Any] = {
        "capture_output": True, "text": True,
        "timeout": 900, "cwd": str(ROOT),
    }
    if stdin_input is not None:
        run_kwargs["input"] = stdin_input
    if gemini_home:
        run_kwargs["env"] = {
            **os.environ,
            "GEMINI_CLI_HOME": gemini_home,
            "GOOGLE_CLOUD_LOCATION": "global",
        }

    try:
        proc = subprocess.run(cmd, **run_kwargs)
        raw_output = proc.stdout or ""

        if proc.returncode != 0:
            # Gemini API key fallback
            if agent == "gemini" and not used_api_key_fallback:
                api_key = _get_gemini_api_key()
                if api_key:
                    used_api_key_fallback = True
                    run_kwargs.setdefault("env", {**os.environ})
                    run_kwargs["env"]["GEMINI_API_KEY"] = api_key
                    proc = subprocess.run(cmd, **run_kwargs)
                    raw_output = proc.stdout or ""

            if proc.returncode != 0:
                duration = time.monotonic() - t0
                return VizResult(
                    agent=agent, skill=skill.name, audience=audience,
                    error=f"CLI exit {proc.returncode}: {proc.stderr[:500]}",
                    duration_s=duration, api_key_fallback=used_api_key_fallback,
                )

        # For codex, extract text from JSONL
        if agent == "codex":
            text_parts = []
            for line in raw_output.splitlines():
                try:
                    obj = json.loads(line)
                    if obj.get("type") == "message" and "content" in obj:
                        for block in obj["content"]:
                            if block.get("type") == "output_text":
                                text_parts.append(block.get("text", ""))
                except json.JSONDecodeError:
                    continue
            if text_parts:
                raw_output = "\n".join(text_parts)

        # For gemini, extract text from JSON response
        if agent == "gemini":
            try:
                gobj = json.loads(raw_output)
                if isinstance(gobj, list):
                    text_parts = []
                    for item in gobj:
                        if isinstance(item, dict) and "response" in item:
                            text_parts.append(item["response"])
                    if text_parts:
                        raw_output = "\n".join(text_parts)
                elif isinstance(gobj, dict) and "response" in gobj:
                    raw_output = gobj["response"]
            except json.JSONDecodeError:
                pass

        parsed = _parse_viz_response(raw_output)
        duration = time.monotonic() - t0

        return VizResult(
            agent=agent,
            skill=skill.name,
            audience=audience,
            html=parsed["html"],
            mermaid=parsed["mermaid"],
            doc_content=parsed["doc_content"],
            alt_text=parsed["alt_text"],
            duration_s=duration,
            api_key_fallback=used_api_key_fallback,
        )

    except subprocess.TimeoutExpired:
        duration = time.monotonic() - t0
        return VizResult(
            agent=agent, skill=skill.name, audience=audience,
            error="Timeout (900s)", duration_s=duration,
            api_key_fallback=used_api_key_fallback,
        )
    except Exception as e:
        duration = time.monotonic() - t0
        return VizResult(
            agent=agent, skill=skill.name, audience=audience,
            error=str(e), duration_s=duration,
            api_key_fallback=used_api_key_fallback,
        )
    finally:
        if gemini_home and os.path.isdir(gemini_home):
            shutil.rmtree(gemini_home, ignore_errors=True)


# ── Screenshot capture ─────────────────────────────────────────────────


def screenshot_html(html_path: Path, png_path: Path) -> bool:
    """Render HTML to PNG via Playwright. Returns True if PNG was created/updated."""
    npx = shutil.which("npx")
    if not npx:
        print(f"  SKIP  {png_path.name} (npx not found)")
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
    if png_path.exists():
        old_hash = hashlib.md5(png_path.read_bytes()).hexdigest()
        new_hash = hashlib.md5(tmp_png.read_bytes()).hexdigest()
        if old_hash == new_hash:
            tmp_png.unlink()
            return False
    tmp_png.rename(png_path)
    return True


# ── Evaluation (single-judge) ─────────────────────────────────────────


FACTOR_WEIGHTS: dict[str, float] = {
    "visual_clarity": 1.0,
    "completeness": 1.0,
    "info_architecture": 1.0,
    "accuracy": 1.5,
    "design_quality": 0.5,
    "audience_fit": 1.5,
}


def build_evaluation_prompt(skill_name: str, audience: str, num_candidates: int) -> str:
    """Build prompt for Claude to score candidate PNGs on 6 factors."""
    factors = ", ".join(FACTOR_WEIGHTS.keys())
    return (
        f"You are evaluating {num_candidates} candidate visualizations of the "
        f"**{skill_name}** skill for the **{audience}** audience.\n\n"
        f"Score each candidate on a 1-10 scale for each of these factors: {factors}.\n\n"
        f"## Factor definitions\n\n"
        f"- **visual_clarity**: Layout readability, color contrast, whitespace usage\n"
        f"- **completeness**: Does it cover all major aspects of the skill?\n"
        f"- **info_architecture**: Logical grouping, hierarchy, navigation flow\n"
        f"- **accuracy**: Correctness of depicted workflow vs actual SKILL.md\n"
        f"- **design_quality**: Polish, consistency, professional appearance\n"
        f"- **audience_fit**: How well it matches the target audience's needs\n\n"
        f"## Response format\n\n"
        f"Return ONLY valid JSON in this exact format:\n\n"
        f"```json\n"
        f'{{"scores": [\n'
        f'  {{"agent": "<name>", "visual_clarity": N, "completeness": N, '
        f'"info_architecture": N, "accuracy": N, "design_quality": N, "audience_fit": N}},\n'
        f"  ...\n"
        f"]}}\n"
        f"```\n\n"
        f"Each score must be an integer from 1 to 10. Return JSON only, no commentary."
    )


def parse_evaluation_scores(raw: str) -> list[dict[str, Any]]:
    """Parse JSON scores from Claude evaluation response."""
    # Try direct parse first
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "scores" in data:
            return data["scores"]
    except json.JSONDecodeError:
        pass
    # Try extracting from code block
    json_match = re.search(r"```(?:json)?\s*\n([\s\S]*?)```", raw)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            if isinstance(data, dict) and "scores" in data:
                return data["scores"]
        except json.JSONDecodeError:
            pass
    # Try finding JSON object anywhere
    brace_match = re.search(r"\{[\s\S]*\"scores\"[\s\S]*\}", raw)
    if brace_match:
        try:
            data = json.loads(brace_match.group(0))
            if isinstance(data, dict) and "scores" in data:
                return data["scores"]
        except json.JSONDecodeError:
            pass
    return []


def compute_weighted_average(scores: dict[str, float], weights: dict[str, float]) -> float:
    """Compute weighted average of factor scores."""
    total_weight = 0.0
    weighted_sum = 0.0
    for factor, weight in weights.items():
        if factor in scores:
            weighted_sum += scores[factor] * weight
            total_weight += weight
    if total_weight == 0:
        return 0.0
    return weighted_sum / total_weight


def select_winner(agent_scores: dict[str, float], accuracy_scores: dict[str, float]) -> str:
    """Select winner by highest weighted avg, tie-break by accuracy, then random."""
    max_score = max(agent_scores.values())
    tied = [a for a, s in agent_scores.items() if s == max_score]
    if len(tied) == 1:
        return tied[0]
    # Break tie by accuracy
    max_acc = max(accuracy_scores[a] for a in tied)
    acc_tied = [a for a in tied if accuracy_scores[a] == max_acc]
    if len(acc_tied) == 1:
        return acc_tied[0]
    return random.choice(acc_tied)


def run_evaluation(skill: SkillData, audience: str, candidate_pngs: dict[str, Path]) -> dict[str, Any]:
    """Run Claude to evaluate candidate PNGs via Anthropic SDK.

    Uses the SDK directly (not the CLI) because Claude CLI doesn't support
    image inputs. Sends PNG screenshots as base64 image content blocks.
    """
    import base64

    try:
        import anthropic
    except ImportError:
        return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "error",
                "error": "anthropic SDK not installed"}

    prompt_text = build_evaluation_prompt(skill.name, audience, len(candidate_pngs))

    # Build message content with images
    content: list[dict[str, Any]] = []
    agent_order: list[str] = []
    for agent_name, png_path in candidate_pngs.items():
        agent_order.append(agent_name)
        png_data = base64.standard_b64encode(png_path.read_bytes()).decode("ascii")
        content.append({"type": "text", "text": f"\n## Candidate: {agent_name}\n"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": png_data},
        })
    content.append({"type": "text", "text": f"\n\n{prompt_text}"})

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            messages=[{"role": "user", "content": content}],
        )
        raw = response.content[0].text if response.content else ""
    except Exception as e:
        return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "error",
                "error": str(e)[:200]}

    scores_list = parse_evaluation_scores(raw)
    if not scores_list:
        return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "parse_error",
                "raw": raw[:500]}

    agent_weighted: dict[str, float] = {}
    accuracy_map: dict[str, float] = {}
    all_scores: dict[str, dict] = {}
    for entry in scores_list:
        agent_name = entry.get("agent", "")
        factor_scores = {k: v for k, v in entry.items() if k in FACTOR_WEIGHTS}
        avg = compute_weighted_average(factor_scores, FACTOR_WEIGHTS)
        agent_weighted[agent_name] = avg
        accuracy_map[agent_name] = factor_scores.get("accuracy", 0)
        all_scores[agent_name] = factor_scores

    if not agent_weighted:
        return {"winner": None, "winner_score": 0, "scores": all_scores, "quality_flag": "no_valid_scores"}

    winner = select_winner(agent_weighted, accuracy_map)
    winner_score = agent_weighted.get(winner, 0)
    quality_flag = "good" if winner_score >= 7.0 else "acceptable" if winner_score >= 5.0 else "poor"

    return {
        "winner": winner,
        "winner_score": round(winner_score, 2),
        "scores": all_scores,
        "quality_flag": quality_flag,
    }


# ── Winner stamping & audit trail ─────────────────────────────────────


def stamp_winner_html(html: str, winner: str, score: float) -> str:
    """Replace footer placeholder with winning LLM attribution badge."""
    badge = f'Visualization by {AGENTS[winner]["label"]} · Score: {score:.1f}/10 · Generated from SKILL.md'
    return re.sub(
        r'<div class="footer">.*?</div>',
        f'<div class="footer"><div class="winner-badge">{badge}</div></div>',
        html, flags=re.DOTALL,
    )


def generate_usage_markdown(skill: SkillData, mermaid_diagram: str, doc_content: dict,
                            alt_text: str, has_png: bool) -> str:
    """Generate user-facing usage.md for a skill."""
    lines = [
        f"# {skill.name}", "", skill.description, "",
        "## Workflow Overview", "", "```mermaid", mermaid_diagram, "```", "",
    ]
    if has_png:
        lines += [f"![{alt_text}](usage.png)", ""]
    else:
        lines += ["[View detailed visualization](usage.html)", ""]
    lines += [
        "## When to Use", "", skill.description, "",
        "## Prerequisites", "", doc_content.get("prerequisites", "*See SKILL.md*"), "",
        "## Arguments", "",
        f"`{skill.argument_hint}`" if skill.argument_hint else "*No arguments*", "",
        doc_content.get("arguments_table", ""), "",
        "## Quick Start", "", doc_content.get("quick_start", f"/{skill.name}"), "",
        "## Common Patterns", "", doc_content.get("common_patterns", ""), "",
        "## Troubleshooting", "", doc_content.get("troubleshooting", ""), "",
        "## Related Skills", "",
        ", ".join(f"`/{s}`" for s in doc_content.get("related_skills", [])), "",
    ]
    return "\n".join(lines)


def generate_internals_markdown(skill: SkillData, mermaid_diagram: str, doc_content: dict,
                                 alt_text: str, has_png: bool) -> str:
    """Generate contributor-facing internals.md for a skill."""
    lines = [
        f"# {skill.name} — Internals", "", skill.description, "",
        "## Architecture", "", "```mermaid", mermaid_diagram, "```", "",
    ]
    if has_png:
        lines += [f"![{alt_text}](internals.png)", ""]
    else:
        lines += ["[View detailed visualization](internals.html)", ""]
    lines += [
        "## Phases", "", doc_content.get("phase_walkthrough", "*See SKILL.md*"), "",
        "## Config", "", doc_content.get("config_schema", "*No config*"), "",
        "## Failure Modes", "", doc_content.get("failure_modes", "*See SKILL.md*"), "",
        "## How to Modify This Skill", "",
        doc_content.get("how_to_modify", f"Edit `skill/{skill.name}/SKILL.md`, then run `/stark-generate-docs --skill {skill.name}` to regenerate documentation."), "",
    ]
    return "\n".join(lines)


DOMAIN_MAP: dict[str, list[str]] = {
    "Code Review": [
        "stark-review", "stark-review-plan", "stark-review-deployment-plan",
        "stark-review-improvement",
    ],
    "PR & Shipping": ["stark-pr-flow", "stark-release"],
    "Planning": ["stark-plan-to-tasks", "stark-phase-execute"],
    "Session": ["stark-session", "stark-session-insights"],
    "Documentation": [
        "stark-init-docs", "stark-extract-docs", "stark-generate-docs",
        "stark-claude-md-improver",
    ],
    "Project Management": [
        "stark-onboard-project", "stark-rename-project", "stark-update-deps",
    ],
    "Analytics": ["stark-metrics", "stark-skill-analytics", "stark-pr-status"],
}

# Decision-tree templates per domain. Each node uses the skill name as ID.
_DECISION_TREES: dict[str, str] = {
    "Code Review": """\
graph TD
    A{What are you reviewing?} -->|PR code| B[stark-review]
    A -->|Design doc / plan| C[stark-review-plan]
    A -->|Infra / deployment plan| D[stark-review-deployment-plan]
    A -->|Improve review prompts| E[stark-review-improvement]""",

    "PR & Shipping": """\
graph TD
    A{What do you need?} -->|Push + create + review + merge| B[stark-pr-flow]
    A -->|Cut a versioned release| C[stark-release]""",

    "Planning": """\
graph TD
    A{Starting or continuing?} -->|Break plan into issues| B[stark-plan-to-tasks]
    A -->|Execute a phase end-to-end| C[stark-phase-execute]""",

    "Session": """\
graph TD
    A{Session lifecycle} -->|Start or end a work session| B[stark-session]
    A -->|Analyze past session patterns| C[stark-session-insights]""",

    "Documentation": """\
graph TD
    A{What kind of docs?} -->|Scaffold docs structure| B[stark-init-docs]
    A -->|Extract knowledge from specs| C[stark-extract-docs]
    A -->|Generate skill HTML/MD docs| D[stark-generate-docs]
    A -->|Improve CLAUDE.md| E[stark-claude-md-improver]""",

    "Project Management": """\
graph TD
    A{Project task?} -->|Bootstrap new project| B[stark-onboard-project]
    A -->|Rename project + refs| C[stark-rename-project]
    A -->|Audit & update deps| D[stark-update-deps]""",

    "Analytics": """\
graph TD
    A{What metrics?} -->|Review performance| B[stark-metrics]
    A -->|Skill usage & adoption| C[stark-skill-analytics]
    A -->|PR analytics dashboard| D[stark-pr-status]""",
}


def generate_routing_guide(skills: list[SkillData]) -> str:
    """Generate a task-oriented routing guide with Mermaid decision trees per domain."""
    skill_map: dict[str, SkillData] = {s.name: s for s in skills}
    lines = [
        "# Skill Routing Guide", "",
        "Which skill should I use? Follow the decision trees below.", "",
    ]

    for domain, skill_names in DOMAIN_MAP.items():
        lines += [f"## {domain}", "", "### I want to...", ""]

        # Mermaid decision tree
        tree = _DECISION_TREES.get(domain)
        if tree:
            lines += ["```mermaid", tree, "```", ""]

        # Skill descriptions with links
        for sname in skill_names:
            sd = skill_map.get(sname)
            if sd:
                desc = sd.description or "See SKILL.md"
                lines.append(f"- **[`/{sname}`]({sname}/usage.md)** — {desc}")
            else:
                lines.append(f"- **`/{sname}`** — *(not installed)*")
        lines.append("")

    # Catch any skills not in a domain
    all_domain_skills = {s for names in DOMAIN_MAP.values() for s in names}
    uncategorized = [s for s in skills if s.name not in all_domain_skills]
    if uncategorized:
        lines += ["## Other Skills", ""]
        for sd in sorted(uncategorized, key=lambda s: s.name):
            desc = sd.description or "See SKILL.md"
            lines.append(f"- **[`/{sd.name}`]({sd.name}/usage.md)** — {desc}")
        lines.append("")

    return "\n".join(lines)


def generate_index_markdown(skills: list[SkillData]) -> str:
    """Generate index.md listing all skills with links to usage and internals docs."""
    lines = [
        "# Skill Documentation Index", "",
        "| Skill | Description | Docs |",
        "|-------|-------------|------|",
    ]
    for skill in sorted(skills, key=lambda s: s.name):
        usage_link = f"[usage.md]({skill.name}/usage.md)"
        internals_link = f"[internals.md]({skill.name}/internals.md)"
        lines.append(f"| `/{skill.name}` | {skill.description} | {usage_link} · {internals_link} |")
    lines.append("")
    return "\n".join(lines)


def compute_manifest(skill_dir: Path, css_path: Path, script_version: str) -> dict:
    """Build a manifest of current skill hashes, CSS hash, and script version."""
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
    """Compare stored manifest against current state. Returns list of stale skill names."""
    if not manifest_path.exists():
        return list(current["skills"].keys())
    stored = json.loads(manifest_path.read_text())
    stale = []
    if stored.get("meta", {}) != current.get("meta", {}):
        return list(current["skills"].keys())
    for name, info in current["skills"].items():
        stored_info = stored.get("skills", {}).get(name, {})
        if stored_info.get("hash") != info["hash"]:
            stale.append(name)
        elif stored_info.get("usage_quality") == "needs-human-review":
            stale.append(name)
        elif stored_info.get("internals_quality") == "needs-human-review":
            stale.append(name)
    return stale


_audit_lock = threading.Lock()


def write_audit_entry(audit_path: Path, entry: dict) -> None:
    """Thread-safe JSONL append with UTC ISO8601 timestamp."""
    import datetime
    entry["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with _audit_lock:
        with open(audit_path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")


# ── CLI argument parser ───────────────────────────────────────────────


AUDIENCES = ("usage", "internals")


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Generate skill documentation with multi-LLM visualization competition.",
    )
    p.add_argument("--skill", help="Generate docs for a single skill (directory name)")
    p.add_argument("--check", action="store_true", help="Staleness check only — exit 0 if clean, 1 if stale")
    p.add_argument("--no-screenshots", action="store_true", help="Skip PNG screenshot generation")
    p.add_argument("--no-evaluation", action="store_true", help="Skip judge evaluation, use first valid candidate")
    p.add_argument("--markdown-only", action="store_true", help="Skip LLM calls, regenerate markdown from persisted artifacts")
    p.add_argument("--dry-run", action="store_true", help="Show what would change without writing anything")
    p.add_argument("--force", "--all", action="store_true", dest="force", help="Regenerate even if manifest is clean")
    p.add_argument("-o", "--output-dir", type=Path, default=DEFAULT_OUT, help="Output directory")
    return p


# ── Main orchestrator ─────────────────────────────────────────────────


def _load_persisted_artifacts(skill_dir: Path, audience: str) -> tuple[str, str, dict, str]:
    """Load mermaid, html, doc_content JSON, and alt_text from persisted files."""
    mermaid = ""
    doc_content: dict = {}
    alt_text = ""
    html_content = ""

    mermaid_path = skill_dir / f"{audience}.mermaid"
    if mermaid_path.exists():
        mermaid = mermaid_path.read_text().strip()

    json_path = skill_dir / f"{audience}.json"
    if json_path.exists():
        try:
            data = json.loads(json_path.read_text())
            doc_content = data.get("doc_content", data)
            alt_text = data.get("alt_text", "")
        except json.JSONDecodeError:
            pass

    html_path = skill_dir / f"{audience}.html"
    if html_path.exists():
        html_content = html_path.read_text()

    return mermaid, html_content, doc_content, alt_text


def _viz_worker(agent: str, skill_data: SkillData, audience: str) -> VizResult:
    """Worker function for ThreadPoolExecutor — catches all exceptions."""
    try:
        return _run_viz_agent(agent, skill_data, audience)
    except Exception as e:
        return VizResult(
            agent=agent, skill=skill_data.name, audience=audience,
            error=f"Worker exception: {e}",
        )


def main() -> int:
    args = _build_arg_parser().parse_args()
    out_dir: Path = args.output_dir
    css_path = out_dir / "_css" / "design-system.css"
    manifest_path = out_dir / "_manifest.json"
    audit_path = out_dir / "_audit" / "scores.jsonl"

    # ── 1. Discover skills ────────────────────────────────────────────
    skill_dirs = discover_skills(SKILL_DIR, filter_name=args.skill)
    if not skill_dirs:
        print(f"No skills found{' matching ' + args.skill if args.skill else ''}.")
        return 1 if args.skill else 0

    # ── 2. Compute current manifest & staleness ───────────────────────
    current_manifest = compute_manifest(SKILL_DIR, css_path, SCRIPT_VERSION)
    stale_names = check_staleness(manifest_path, current_manifest)

    if args.check:
        if stale_names:
            print(f"Stale skills ({len(stale_names)}): {', '.join(sorted(stale_names))}")
            return 1
        print("All skills up to date.")
        return 0

    # ── 3. Filter to stale skills (unless --force) ────────────────────
    if args.force:
        target_dirs = skill_dirs
    else:
        target_dirs = [d for d in skill_dirs if d.name in stale_names]

    if not target_dirs:
        print("All skills up to date. Use --force to regenerate.")
        return 0

    target_names = [d.name for d in target_dirs]
    print(f"Target skills ({len(target_dirs)}): {', '.join(target_names)}")

    if args.dry_run:
        print("[dry-run] Would generate docs for:", ", ".join(target_names))
        return 0

    # ── 4. Parse all target skills ────────────────────────────────────
    skill_data_map: dict[str, SkillData] = {}
    for d in target_dirs:
        skill_data_map[d.name] = parse_skill_md(d / "SKILL.md")

    # ── 5. LLM generation (unless --markdown-only) ────────────────────
    # Results keyed by "skill:audience" → list[VizResult]
    results: dict[str, list[VizResult]] = {}

    if not args.markdown_only:
        # Build flat task list: (agent, skill_data, audience)
        tasks: list[tuple[str, SkillData, str]] = []
        for skill_name, sd in skill_data_map.items():
            for audience in AUDIENCES:
                for agent in AGENTS:
                    tasks.append((agent, sd, audience))

        print(f"Dispatching {len(tasks)} LLM calls (MAX_WORKERS={MAX_WORKERS})...")

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            future_map = {}
            for agent, sd, audience in tasks:
                fut = pool.submit(_viz_worker, agent, sd, audience)
                future_map[fut] = (agent, sd.name, audience)

            for fut in as_completed(future_map):
                agent, skill_name, audience = future_map[fut]
                vr = fut.result()
                key = f"{skill_name}:{audience}"
                results.setdefault(key, []).append(vr)
                status = "OK" if not vr.error else f"ERR: {vr.error[:60]}"
                print(f"  [{agent}] {skill_name}/{audience} — {status} ({vr.duration_s:.1f}s)")

    # ── 6. Process candidates per skill×audience ──────────────────────
    # Track quality flags for manifest update
    quality_flags: dict[str, dict[str, str]] = {}  # skill → {audience → flag}

    for skill_name, sd in skill_data_map.items():
        skill_out = out_dir / skill_name
        skill_out.mkdir(parents=True, exist_ok=True)
        quality_flags.setdefault(skill_name, {})

        for audience in AUDIENCES:
            key = f"{skill_name}:{audience}"

            if args.markdown_only:
                # Load from persisted artifacts
                mermaid, html_content, doc_content, alt_text = _load_persisted_artifacts(skill_out, audience)
                has_png = (skill_out / f"{audience}.png").exists()
            else:
                candidates = results.get(key, [])

                # Filter to candidates with HTML
                valid: list[VizResult] = []
                for vr in candidates:
                    if vr.error or not vr.html:
                        if vr.error:
                            write_audit_entry(audit_path, {
                                "event": "generation_error", "skill": skill_name,
                                "audience": audience, "agent": vr.agent, "error": vr.error,
                            })
                        continue
                    # Sanitize
                    vr.html = sanitize_html(vr.html)
                    # Validate
                    if not validate_html(vr.html):
                        write_audit_entry(audit_path, {
                            "event": "validation_failed", "skill": skill_name,
                            "audience": audience, "agent": vr.agent,
                        })
                        continue
                    valid.append(vr)

                if not valid:
                    print(f"  SKIP  {skill_name}/{audience} — no valid candidates")
                    quality_flags[skill_name][audience] = "failed"
                    continue

                # Screenshot valid candidates
                candidate_pngs: dict[str, Path] = {}
                if not args.no_screenshots:
                    for vr in valid:
                        html_path = skill_out / f"{audience}_{vr.agent}.html"
                        html_path.write_text(vr.html)
                        png_path = skill_out / f"{audience}_{vr.agent}.png"
                        if screenshot_html(html_path, png_path):
                            candidate_pngs[vr.agent] = png_path
                        elif png_path.exists():
                            candidate_pngs[vr.agent] = png_path

                # Evaluate
                winner_agent: str | None = None
                winner_score: float = 0.0
                quality_flag = "ok"

                if len(valid) == 1:
                    # Single survivor — skip evaluation
                    winner_agent = valid[0].agent
                    quality_flag = "degraded"
                elif args.no_evaluation or not candidate_pngs:
                    # No evaluation — use first valid
                    winner_agent = valid[0].agent
                    quality_flag = "unevaluated"
                else:
                    eval_result = run_evaluation(sd, audience, candidate_pngs)
                    winner_agent = eval_result.get("winner")
                    winner_score = eval_result.get("winner_score", 0)
                    quality_flag = eval_result.get("quality_flag", "error")
                    write_audit_entry(audit_path, {
                        "event": "evaluation", "skill": skill_name,
                        "audience": audience, **eval_result,
                    })

                if not winner_agent:
                    # Fallback to first valid if evaluation failed to pick
                    winner_agent = valid[0].agent
                    quality_flag = "eval_fallback"

                # Find the winning VizResult
                winner_vr = next(vr for vr in valid if vr.agent == winner_agent)

                # Stamp winner HTML
                if winner_score > 0:
                    winner_vr.html = stamp_winner_html(winner_vr.html, winner_agent, winner_score)

                # Persist winning artifacts
                (skill_out / f"{audience}.html").write_text(winner_vr.html)
                if winner_vr.mermaid:
                    (skill_out / f"{audience}.mermaid").write_text(winner_vr.mermaid)
                persist_json = {"doc_content": winner_vr.doc_content, "alt_text": winner_vr.alt_text}
                (skill_out / f"{audience}.json").write_text(json.dumps(persist_json, indent=2))

                # Promote winner PNG if we have it
                winner_png_src = skill_out / f"{audience}_{winner_agent}.png"
                final_png = skill_out / f"{audience}.png"
                if winner_png_src.exists():
                    shutil.copy2(winner_png_src, final_png)

                # Clean up candidate files (keep only winner)
                for vr in valid:
                    for suffix in (".html", ".png"):
                        cand = skill_out / f"{audience}_{vr.agent}{suffix}"
                        cand.unlink(missing_ok=True)

                # Set up vars for markdown generation
                mermaid = winner_vr.mermaid
                doc_content = winner_vr.doc_content
                alt_text = winner_vr.alt_text
                has_png = final_png.exists()
                quality_flags[skill_name][audience] = quality_flag

            # ── 7. Generate markdown ──────────────────────────────────
            if audience == "usage":
                md = generate_usage_markdown(sd, mermaid, doc_content, alt_text, has_png)
                (skill_out / "usage.md").write_text(md)
            else:
                md = generate_internals_markdown(sd, mermaid, doc_content, alt_text, has_png)
                (skill_out / "internals.md").write_text(md)

            print(f"  DONE  {skill_name}/{audience}.md")

    # ── 8. Generate index.md & README.md routing guide ─────────────────
    all_skill_data = [skill_data_map[d.name] for d in target_dirs if d.name in skill_data_map]
    index_md = generate_index_markdown(all_skill_data)
    (out_dir / "index.md").write_text(index_md)
    print(f"  DONE  index.md ({len(all_skill_data)} skills)")

    routing_md = generate_routing_guide(all_skill_data)
    (out_dir / "README.md").write_text(routing_md)
    print(f"  DONE  README.md (routing guide)")

    # ── 9. Update manifest with quality flags ─────────────────────────
    # Start from current manifest and merge in quality flags
    for skill_name, flags in quality_flags.items():
        if skill_name in current_manifest["skills"]:
            for audience, flag in flags.items():
                qkey = f"{audience}_quality"
                current_manifest["skills"][skill_name][qkey] = (
                    "needs-human-review" if flag in ("poor", "failed", "error") else flag
                )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(current_manifest, indent=2) + "\n")
    print(f"  DONE  _manifest.json updated")

    return 0


if __name__ == "__main__":
    sys.exit(main())
