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
        f"## Required outputs\n\n"
        f"Return ALL of the following in your response:\n\n"
        f"1. **standalone HTML page** — Complete `<html>...</html>` document with the CSS "
        f"inlined in a `<style>` tag. Use design-system classes (node-phase, node-decision, "
        f"node-action, etc.). No external resources.\n\n"
        f"2. **Mermaid diagram** — A mermaid flowchart in a fenced code block:\n"
        f"````\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n````\n\n"
        f"3. **Doc content JSON** — Structured content as a JSON code block:\n"
        f"```json\n{{\n"
        f'  "summary": "one-paragraph summary",\n'
        f'  "key_features": ["feature1", "feature2"],\n'
        f'  "usage_examples": ["example1"]\n'
        f"}}\n```\n\n"
        f"4. **Alt text** — A descriptive alt text line for a PNG screenshot of the HTML, "
        f"prefixed with `Alt text: `\n"
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


def _parse_viz_response(raw: str) -> dict[str, Any]:
    """Parse LLM response to extract HTML, mermaid, doc_content JSON, and alt_text."""
    result: dict[str, Any] = {"html": "", "mermaid": "", "doc_content": {}, "alt_text": ""}

    # Extract HTML: look for <html>...</html>
    html_match = re.search(r"(<html[\s\S]*?</html>)", raw, re.IGNORECASE)
    if html_match:
        result["html"] = html_match.group(1)

    # Extract mermaid block
    mermaid_match = re.search(r"```mermaid\s*\n([\s\S]*?)```", raw)
    if mermaid_match:
        result["mermaid"] = mermaid_match.group(1).strip()

    # Extract JSON doc content
    json_match = re.search(r"```json\s*\n([\s\S]*?)```", raw)
    if json_match:
        try:
            result["doc_content"] = json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

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
    """Run Claude to evaluate candidate PNGs. Returns dict with winner, scores, quality_flag."""
    prompt = build_evaluation_prompt(skill.name, audience, len(candidate_pngs))

    # Build claude command with image inputs
    cmd = ["claude", "-p", "-", "--output-format", "text", "--model", "claude-opus-4-6"]
    for agent_name, png_path in candidate_pngs.items():
        cmd.extend(["--image", str(png_path)])

    # Add agent labels to prompt
    labeled_prompt = prompt + "\n\n## Candidates\n\n"
    for i, agent_name in enumerate(candidate_pngs.keys(), 1):
        labeled_prompt += f"- Image {i}: **{agent_name}**\n"

    try:
        proc = subprocess.run(
            cmd, input=labeled_prompt,
            capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "error",
                    "error": f"CLI exit {proc.returncode}"}

        raw = proc.stdout or ""
        scores_list = parse_evaluation_scores(raw)
        if not scores_list:
            return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "parse_error"}

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

        winner = select_winner(agent_weighted, accuracy_map)
        winner_score = agent_weighted.get(winner, 0)
        quality_flag = "good" if winner_score >= 7.0 else "acceptable" if winner_score >= 5.0 else "poor"

        return {
            "winner": winner,
            "winner_score": round(winner_score, 2),
            "scores": all_scores,
            "quality_flag": quality_flag,
        }

    except subprocess.TimeoutExpired:
        return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "timeout"}
    except Exception as e:
        return {"winner": None, "winner_score": 0, "scores": {}, "quality_flag": "error", "error": str(e)}


# ── Winner stamping & audit trail ─────────────────────────────────────


def stamp_winner_html(html: str, winner: str, score: float) -> str:
    """Replace footer placeholder with winning LLM attribution badge."""
    badge = f'Visualization by {AGENTS[winner]["label"]} · Score: {score:.1f}/10 · Generated from SKILL.md'
    return re.sub(
        r'<div class="footer">.*?</div>',
        f'<div class="footer"><div class="winner-badge">{badge}</div></div>',
        html, flags=re.DOTALL,
    )


_audit_lock = threading.Lock()


def write_audit_entry(audit_path: Path, entry: dict) -> None:
    """Thread-safe JSONL append with UTC ISO8601 timestamp."""
    import datetime
    entry["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with _audit_lock:
        with open(audit_path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
