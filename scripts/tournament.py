"""Tournament engine: dispatch LLM competitors, evaluate, and select winners.

Extracted from generate_skill_docs.py — these functions power the multi-LLM
visualization competition used by /stark-generate-docs and /stark-tournament.

Functions:
    dispatch_competitor  — run one LLM CLI to generate content
    evaluate_visual      — run Claude to score candidate PNGs
    build_eval_prompt    — build evaluation prompt for scoring
    parse_scores         — parse JSON scores from evaluation response
    compute_weighted_average — weighted average of factor scores
    select_winner        — pick best agent with tie-breaking
    write_audit_entry    — thread-safe JSONL audit log
    screenshot_html      — render HTML to PNG via Playwright
"""
from __future__ import annotations

import hashlib
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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from claude_utils import CLAUDE_MODEL, build_claude_cmd
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import (
    GEMINI_MODEL, setup_gemini_home, make_gemini_env,
    parse_json_output as parse_gemini_output,
    should_fallback_to_api_key, try_gemini_api_key_fallback,
)

# Re-export for backward compat
__all__ = [
    "FACTOR_WEIGHTS", "AGENTS", "CLAUDE_MODEL", "CODEX_REASONING_CONFIG", "CODEX_MODEL", "GEMINI_MODEL",
    "REVIEW_EVAL_CRITERIA", "REVIEW_SCALE_MAP",
    "dispatch_competitor", "evaluate_visual", "evaluate_semantic",
    "evaluate_review",
    "build_eval_prompt",
    "parse_scores", "compute_weighted_average", "select_winner",
    "write_audit_entry", "screenshot_html", "unescape_json_string",
    "TournamentConfig", "TournamentResult", "Tournament",
    "CompetitorConfig", "EvaluationConfig", "ExecutionConfig", "OutputConfig",
    "evaluate_test",
]


# ── Config & Result dataclasses ───────────────────────────────────────


_DEFAULT_FACTORS: dict[str, dict[str, float]] = {
    "correctness": {"weight": 2.0},
    "completeness": {"weight": 1.5},
    "quality": {"weight": 1.0},
}

_DEFAULT_COMPETITORS: list[dict[str, Any]] = [
    {"id": "claude", "agent": "claude"},
    {"id": "codex", "agent": "codex"},
    {"id": "gemini", "agent": "gemini"},
]


@dataclass
class CompetitorConfig:
    """Configuration for a single tournament competitor."""
    id: str
    agent: str
    prompt_override: str | None = None


@dataclass
class EvaluationConfig:
    """How tournament entries are evaluated."""
    strategy: str = "semantic"
    judge: str = "claude-sonnet-4-6"
    factors: dict[str, dict[str, float]] = field(default_factory=lambda: dict(_DEFAULT_FACTORS))


@dataclass
class ExecutionConfig:
    """Runtime execution parameters."""
    max_workers: int = 6
    timeout_seconds: int = 300
    retries: int = 1


@dataclass
class OutputConfig:
    """Where tournament output goes."""
    output_dir: str | None = None
    audit_file: str | None = None
    keep_all: bool = False


@dataclass
class TournamentConfig:
    """Full tournament configuration, loadable from YAML or dict."""
    prompt_template: str
    competitors: list[CompetitorConfig] = field(default_factory=list)
    evaluation: EvaluationConfig = field(default_factory=EvaluationConfig)
    execution: ExecutionConfig = field(default_factory=ExecutionConfig)
    output: OutputConfig = field(default_factory=OutputConfig)

    def __post_init__(self) -> None:
        if not self.competitors:
            self.competitors = [
                CompetitorConfig(**c) for c in _DEFAULT_COMPETITORS
            ]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TournamentConfig:
        """Create config from a dict, filling defaults for missing fields."""
        if "prompt_template" not in data:
            raise ValueError("prompt_template is required")

        competitors_raw = data.get("competitors", [])
        competitors = [
            CompetitorConfig(**c) for c in competitors_raw
        ] if competitors_raw else []

        eval_raw = data.get("evaluation", {})
        evaluation = EvaluationConfig(
            strategy=eval_raw.get("strategy", "semantic"),
            judge=eval_raw.get("judge", "claude-sonnet-4-6"),
            factors=eval_raw.get("factors", dict(_DEFAULT_FACTORS)),
        )

        exec_raw = data.get("execution", {})
        execution = ExecutionConfig(
            max_workers=exec_raw.get("max_workers", 6),
            timeout_seconds=exec_raw.get("timeout_seconds", 300),
            retries=exec_raw.get("retries", 1),
        )

        out_raw = data.get("output", {})
        output = OutputConfig(
            output_dir=out_raw.get("output_dir"),
            audit_file=out_raw.get("audit_file"),
            keep_all=out_raw.get("keep_all", False),
        )

        return cls(
            prompt_template=data["prompt_template"],
            competitors=competitors,
            evaluation=evaluation,
            execution=execution,
            output=output,
        )

    @classmethod
    def from_yaml(cls, path: str | Path) -> TournamentConfig:
        """Load config from a YAML file with schema_version validation."""
        import yaml

        with open(path) as f:
            data = yaml.safe_load(f)

        if not isinstance(data, dict):
            raise ValueError(f"Expected YAML mapping, got {type(data).__name__}")

        schema_version = data.get("schema_version")
        if schema_version != 1:
            raise ValueError(
                f"Unsupported schema_version: {schema_version} (expected 1)"
            )

        return cls.from_dict(data)

    def resolve_prompt(self, competitor: CompetitorConfig, **variables: str) -> str:
        """Resolve prompt_template with variable substitution and optional override.

        Variables are substituted into prompt_template via str.format_map().
        If the competitor has a prompt_override, it is then applied —
        the override can reference {base_prompt} to wrap the resolved template.
        """
        resolved = self.prompt_template.format_map(variables)
        if competitor.prompt_override:
            resolved = competitor.prompt_override.format_map(
                {"base_prompt": resolved, **variables}
            )
        return resolved


@dataclass
class TournamentResult:
    """Outcome of a tournament run."""
    winner: str | None
    winner_score: float
    scores: dict[str, Any]
    artifacts: dict[str, Any] = field(default_factory=dict)
    audit: dict[str, Any] = field(default_factory=dict)
    quality_flag: str = "unknown"


ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).parent

AGENTS = {
    "claude": {"emoji": "\U0001f9e0", "label": "Claude"},
    "codex":  {"emoji": "\U0001f4bb", "label": "Codex"},
    "gemini": {"emoji": "\u2728",     "label": "Gemini"},
}

PYTHON = sys.executable
GITHUB_APP = str(SCRIPTS_DIR / "github_app.py")
CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_HIGH



_css_cache: str | None = None


def _load_css() -> str:
    """Lazy-load the design-system.css file."""
    global _css_cache
    if _css_cache is None:
        css_path = ROOT / "docs" / "skills" / "_css" / "design-system.css"
        _css_cache = css_path.read_text()
    return _css_cache


def unescape_json_string(s: str) -> str:
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


_audit_lock = threading.Lock()


def write_audit_entry(audit_path: Path, entry: dict) -> None:
    """Thread-safe JSONL append with UTC ISO8601 timestamp."""
    import datetime
    entry["timestamp"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with _audit_lock:
        with open(audit_path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")


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


def build_eval_prompt(skill_name: str, audience: str, num_candidates: int) -> str:
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


def parse_scores(raw: str) -> list[dict[str, Any]]:
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


def dispatch_competitor(agent: str, skill, audience: str):
    """Run one LLM CLI to generate a skill visualization.

    Mirrors dispatch patterns from scripts/multi_review.py.
    Security: prompt content is passed via stdin (claude/codex) or -p flag (gemini),
    never interpolated into shell commands.

    Args:
        agent: One of "claude", "codex", "gemini"
        skill: SkillData instance with name, description, etc.
        audience: "usage" or "internals"

    Returns:
        VizResult with generated artifacts or error details.
    """
    # Import here to avoid circular dependency
    from generate_skill_docs import VizResult, build_generation_prompt, _parse_viz_response

    css = _load_css()
    prompt = build_generation_prompt(skill, audience, css)
    t0 = time.monotonic()

    stdin_input: str | None = None
    gemini_home: str | None = None
    used_api_key_fallback = False

    if agent == "claude":
        cmd = build_claude_cmd()
        stdin_input = prompt

    elif agent == "codex":
        cmd = [
            "codex", "exec",
            "-m", CODEX_MODEL,
            "-c", CODEX_REASONING_CONFIG,
            "--ephemeral", "--json",
            "--full-auto",
            "-",
        ]
        stdin_input = prompt

    elif agent == "gemini":
        gemini_home = setup_gemini_home(
            "gemini-viz-", str(ROOT), "viz", approval_mode="plan",
        )
        cmd = [
            "gemini",
            "-m", GEMINI_MODEL,
            "-p", prompt,
            "-o", "json",
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
        run_kwargs["env"] = make_gemini_env(gemini_home)

    try:
        proc = subprocess.run(cmd, **run_kwargs)
        raw_output = proc.stdout or ""

        if proc.returncode != 0:
            stderr_snippet = proc.stderr[:500] if proc.stderr else ""
            if (
                agent == "gemini"
                and not used_api_key_fallback
                and should_fallback_to_api_key(stderr_snippet)
                and try_gemini_api_key_fallback(run_kwargs, skill.name, stderr_snippet)
            ):
                used_api_key_fallback = True
                proc = subprocess.run(cmd, **run_kwargs)
                raw_output = proc.stdout or ""

            if proc.returncode != 0:
                duration = time.monotonic() - t0
                return VizResult(
                    agent=agent, skill=skill.name, audience=audience,
                    error=f"CLI exit {proc.returncode}: {proc.stderr[:500]}",
                    duration_s=duration, api_key_fallback=used_api_key_fallback,
                )

        if agent == "codex":
            raw_output = parse_jsonl_output(raw_output)

        if agent == "gemini":
            raw_output = parse_gemini_output(raw_output)

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


def evaluate_visual(skill, audience: str, candidate_pngs: dict[str, Path]) -> dict[str, Any]:
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

    prompt_text = build_eval_prompt(skill.name, audience, len(candidate_pngs))

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

    scores_list = parse_scores(raw)
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


# ── Semantic evaluation ───────────────────────────────────────────────


def evaluate_semantic(
    prompt: str,
    outputs: dict[str, str],
    factors: dict[str, dict[str, float]],
    judge_model: str = "claude-sonnet-4-6",
) -> dict[str, dict[str, float]]:
    """Evaluate text outputs via Anthropic SDK, scoring each competitor on factors.

    Args:
        prompt: The original prompt given to competitors.
        outputs: {competitor_id: output_text} mapping.
        factors: {factor_name: {"weight": float}} — evaluation criteria.
        judge_model: Model to use as judge.

    Returns:
        {competitor_id: {factor_name: score}} mapping.
    """
    import anthropic

    factor_names = list(factors.keys())
    factor_list = ", ".join(factor_names)

    # Build labeled text blocks
    competitor_blocks = []
    for comp_id, output in outputs.items():
        competitor_blocks.append(f"## Competitor: {comp_id}\n\n{output}")
    competitors_text = "\n\n---\n\n".join(competitor_blocks)

    example_factors = ", ".join(f'"{f}": N' for f in factor_names)
    eval_prompt = (
        f"You are a judge evaluating {len(outputs)} competitors' responses to a prompt.\n\n"
        f"## Original prompt\n\n{prompt}\n\n"
        f"## Competitors\n\n{competitors_text}\n\n"
        f"## Instructions\n\n"
        f"Score each competitor on a 1-10 scale for each of these factors: {factor_list}.\n\n"
        f"Return ONLY valid JSON in this exact format:\n\n"
        f"```json\n"
        f'{{"scores": [\n'
        f'  {{"agent": "<competitor_id>", {example_factors}}},\n'
        f"  ...\n"
        f"]}}\n"
        f"```\n\n"
        f"Each score must be an integer from 1 to 10. Return JSON only, no commentary."
    )

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=judge_model,
        max_tokens=2048,
        messages=[{"role": "user", "content": eval_prompt}],
    )
    raw = response.content[0].text if response.content else ""

    scores_list = parse_scores(raw)
    result: dict[str, dict[str, float]] = {}
    for entry in scores_list:
        agent_name = entry.get("agent", "")
        factor_scores = {k: v for k, v in entry.items() if k in factors}
        if agent_name and factor_scores:
            result[agent_name] = factor_scores

    return result


# ── Test evaluation ────────────────────────────────────────────────────


def evaluate_test(
    outputs: dict[str, str],
    test_file: str,
    work_dir: Path,
    timeout: int = 30,
) -> dict[str, dict[str, float]]:
    """Evaluate code outputs by running them against a pytest test file.

    For each competitor:
    1. Write output code to {work_dir}/{competitor_id}/impl.py
    2. Run pytest against the test file with PYTHONPATH set to competitor dir
    3. Parse pass/fail counts from pytest output
    4. Score: pass_rate = passed / total * 10 (scaled to 0-10)

    Args:
        outputs: {competitor_id: code_text} mapping.
        test_file: Path to the pytest test file.
        work_dir: Working directory for competitor code.
        timeout: Subprocess timeout in seconds.

    Returns:
        {competitor_id: {factor_name: score, "_error": str}} mapping.
        All configured factors receive the same pass_rate score.
    """
    test_path = Path(test_file).resolve()
    results: dict[str, dict[str, float]] = {}

    for comp_id, code in outputs.items():
        comp_dir = work_dir / comp_id
        comp_dir.mkdir(parents=True, exist_ok=True)
        impl_file = comp_dir / "impl.py"
        impl_file.write_text(code)

        try:
            proc = subprocess.run(
                [sys.executable, "-m", "pytest", str(test_path), "-v"],
                capture_output=True, text=True, timeout=timeout,
                cwd=str(comp_dir),
                env={**os.environ, "PYTHONPATH": str(comp_dir)},
            )
            stdout = proc.stdout + proc.stderr

            # Parse "X passed" and "X failed" from pytest summary
            passed = 0
            failed = 0
            passed_match = re.search(r"(\d+) passed", stdout)
            failed_match = re.search(r"(\d+) failed", stdout)
            if passed_match:
                passed = int(passed_match.group(1))
            if failed_match:
                failed = int(failed_match.group(1))

            total = passed + failed
            if total > 0:
                pass_rate = (passed / total) * 10.0
            else:
                pass_rate = 0.0

            entry: dict[str, Any] = {"_pass_rate": round(pass_rate, 2)}
            if proc.returncode != 0 and total == 0:
                entry["_error"] = stdout[-500:] if len(stdout) > 500 else stdout
            results[comp_id] = entry

        except subprocess.TimeoutExpired:
            results[comp_id] = {"_pass_rate": 0.0, "_error": f"timeout ({timeout}s)"}

    return results


# ── Review evaluation ─────────────────────────────────────────────────


REVIEW_EVAL_CRITERIA: dict[str, dict] = {
    "coverage": {"weight": 2.0, "scale": "good/acceptable/poor"},
    "severity_accuracy": {"weight": 2.0, "scale": "good/acceptable/poor"},
    "false_positive_rate": {"weight": 1.5, "scale": "low/medium/high"},
    "actionability": {"weight": 1.5, "scale": "good/acceptable/poor"},
    "specificity": {"weight": 1.0, "scale": "good/acceptable/poor"},
}

REVIEW_SCALE_MAP: dict[str, int] = {
    "good": 9, "acceptable": 6, "poor": 3,
    "low": 9, "medium": 6, "high": 3,  # For false_positive_rate (low is good)
}


def _build_review_judge_prompt(
    document: str,
    reviews: dict[str, str],
    competitor_order: list[str],
) -> str:
    """Build a judge prompt for evaluating competing document reviews.

    Args:
        document: The original document being reviewed (for accuracy assessment).
        reviews: {competitor_id: review_text} mapping.
        competitor_order: Order to present competitors (for position bias control).

    Returns:
        Judge prompt string.
    """
    criteria_lines = []
    for criterion, info in REVIEW_EVAL_CRITERIA.items():
        criteria_lines.append(
            f"- **{criterion}** (scale: {info['scale']}, weight: {info['weight']})"
        )
    criteria_text = "\n".join(criteria_lines)

    competitor_blocks = []
    for comp_id in competitor_order:
        review_text = reviews[comp_id]
        competitor_blocks.append(f"## Reviewer: {comp_id}\n\n{review_text}")
    competitors_text = "\n\n---\n\n".join(competitor_blocks)

    competitor_ids = ", ".join(f'"{c}"' for c in competitor_order)
    criteria_scores = ", ".join(
        f'"{c}": "<scale_value>"' for c in REVIEW_EVAL_CRITERIA
    )

    return (
        f"You are a senior engineer judging competing reviews of a document.\n\n"
        f"## Original document\n\n{document}\n\n"
        f"## Competing reviews\n\n{competitors_text}\n\n"
        f"## Evaluation criteria\n\n{criteria_text}\n\n"
        f"## Instructions\n\n"
        f"1. Reason carefully before scoring — consider the original document to assess accuracy.\n"
        f"2. Score each reviewer on all criteria using the specified scale values.\n"
        f"3. Identify the single best reviewer (winner).\n"
        f"4. Synthesize the best findings from ALL reviews into a unified list.\n\n"
        f"Return ONLY valid JSON in this exact format:\n\n"
        f"```json\n"
        f'{{"reasoning": "<your analysis>",\n'
        f'  "scores": [\n'
        f'    {{"reviewer": "<id>", {criteria_scores}}},\n'
        f"    ...\n"
        f"  ],\n"
        f'  "winner": <one of [{competitor_ids}]>,\n'
        f'  "synthesized_findings": ["<finding>", ...]\n'
        f"}}\n"
        f"```\n\n"
        f"Return JSON only, no text outside the code block."
    )


def _parse_review_judge_output(raw: str) -> dict[str, Any]:
    """Parse JSON from judge output — handles code fences, finds outermost {}.

    Args:
        raw: Raw judge output string.

    Returns:
        Parsed dict or empty dict on failure.
    """
    # Try direct parse
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Try extracting from code fence
    fence_match = re.search(r"```(?:json)?\s*\n([\s\S]*?)```", raw)
    if fence_match:
        try:
            return json.loads(fence_match.group(1))
        except json.JSONDecodeError:
            pass
    # Find outermost {} — scan from first { to last }
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    return {}


def evaluate_review(
    document: str,
    reviews: dict[str, str],
    judge: str = "claude-sonnet-4-6",
    timeout: int = 120,
) -> dict[str, Any]:
    """Evaluate competing document reviews using a judge LLM with position bias control.

    Runs the judge TWICE with swapped competitor order. If the judge picks a different
    winner in each pass, position_bias_detected is set to True and the winner is "tie".

    Args:
        document: The original document that was reviewed (for accuracy assessment).
        reviews: {competitor_id: review_text} mapping of competing reviews.
        judge: Model name to use as judge (default: claude-sonnet-4-6).
        timeout: Max seconds per judge call (default: 120).

    Returns:
        Dict with:
            - scores: {competitor_id: {criterion: text_score}} raw text scores
            - numeric_scores: {competitor_id: {criterion: int, "_weighted_avg": float}}
            - winner: competitor_id or "tie"
            - synthesized_findings: list of unified findings
            - position_bias_detected: bool
            - pass1_winner: winner from first pass
            - pass2_winner: winner from second pass
    """
    import anthropic

    client = anthropic.Anthropic()
    competitor_ids = list(reviews.keys())

    def _run_judge(order: list[str]) -> dict[str, Any]:
        prompt = _build_review_judge_prompt(document, reviews, order)
        response = client.messages.create(
            model=judge,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text if response.content else ""
        return _parse_review_judge_output(raw)

    # Pass 1: natural order
    order1 = list(competitor_ids)
    result1 = _run_judge(order1)

    # Pass 2: reversed order
    order2 = list(reversed(competitor_ids))
    result2 = _run_judge(order2)

    # Extract winners from each pass
    pass1_winner = result1.get("winner", "")
    pass2_winner = result2.get("winner", "")
    position_bias = pass1_winner != pass2_winner

    # Parse text scores from both passes
    scores1: dict[str, dict[str, str]] = {}
    for entry in result1.get("scores", []):
        reviewer = entry.get("reviewer", "")
        if reviewer in reviews:
            scores1[reviewer] = {k: v for k, v in entry.items() if k != "reviewer"}

    scores2: dict[str, dict[str, str]] = {}
    for entry in result2.get("scores", []):
        reviewer = entry.get("reviewer", "")
        if reviewer in reviews:
            scores2[reviewer] = {k: v for k, v in entry.items() if k != "reviewer"}

    # Use pass1 text scores as the canonical text representation
    scores = scores1

    # Compute numeric scores from both passes and average them
    criteria_weights = {c: info["weight"] for c, info in REVIEW_EVAL_CRITERIA.items()}

    def _to_numeric(text_scores: dict[str, str]) -> dict[str, float]:
        num: dict[str, float] = {}
        for criterion in REVIEW_EVAL_CRITERIA:
            raw_val = text_scores.get(criterion, "")
            num[criterion] = float(REVIEW_SCALE_MAP.get(str(raw_val).lower(), 0))
        return num

    numeric_scores: dict[str, dict[str, Any]] = {}
    all_comp_ids = set(scores1.keys()) | set(scores2.keys())
    for comp_id in all_comp_ids:
        num1 = _to_numeric(scores1.get(comp_id, {}))
        num2 = _to_numeric(scores2.get(comp_id, {}))
        # Average scores from both passes when both exist
        averaged: dict[str, Any] = {}
        if num1 and num2:
            for criterion in REVIEW_EVAL_CRITERIA:
                averaged[criterion] = (num1.get(criterion, 0.0) + num2.get(criterion, 0.0)) / 2.0
        elif num1:
            averaged = {k: v for k, v in num1.items()}
        else:
            averaged = {k: v for k, v in num2.items()}
        averaged["_weighted_avg"] = compute_weighted_average(
            {k: float(v) for k, v in averaged.items() if k != "_weighted_avg"},
            criteria_weights,
        )
        numeric_scores[comp_id] = averaged

    # Determine winner
    if position_bias:
        winner = "tie"
    else:
        winner = pass1_winner

    # Synthesized findings — prefer pass1, fall back to pass2
    synthesized = result1.get("synthesized_findings") or result2.get("synthesized_findings") or []

    return {
        "scores": scores,
        "numeric_scores": numeric_scores,
        "winner": winner,
        "synthesized_findings": synthesized,
        "position_bias_detected": position_bias,
        "pass1_winner": pass1_winner,
        "pass2_winner": pass2_winner,
    }


# ── Tournament orchestrator ───────────────────────────────────────────


class Tournament:
    """Orchestrates a full tournament: dispatch, evaluate, select winner, audit."""

    def __init__(self, config: TournamentConfig) -> None:
        self.config = config

    def run(self) -> TournamentResult:
        """Execute the tournament lifecycle and return the result."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        config = self.config
        competitors = config.competitors

        # Step 1-2: Dispatch all competitors in parallel
        outputs: dict[str, str] = {}
        errors: dict[str, str] = {}

        def _dispatch_one(comp: CompetitorConfig) -> tuple[str, str | None, str | None]:
            """Dispatch a single competitor, return (id, output, error)."""
            try:
                prompt = config.resolve_prompt(comp)
                result = dispatch_competitor(comp.agent, prompt, comp.id)
                # dispatch_competitor returns different types depending on context;
                # for the generic tournament, we treat the return as a string output
                if isinstance(result, str):
                    return (comp.id, result if result.strip() else None, None)
                # If it has an error attribute (like VizResult), handle that
                if hasattr(result, "error") and result.error:
                    return (comp.id, None, result.error)
                # If it has html/doc_content, extract usable output
                output_text = getattr(result, "html", None) or getattr(result, "doc_content", None) or ""
                return (comp.id, output_text if output_text.strip() else None, None)
            except Exception as e:
                return (comp.id, None, str(e))

        with ThreadPoolExecutor(max_workers=config.execution.max_workers) as executor:
            futures = {executor.submit(_dispatch_one, c): c for c in competitors}
            for future in as_completed(futures):
                comp_id, output, error = future.result()
                if output:
                    outputs[comp_id] = output
                else:
                    errors[comp_id] = error or "empty output"

        # Step 3-4: All failed
        if not outputs:
            return TournamentResult(
                winner=None,
                winner_score=0.0,
                scores={},
                artifacts={},
                audit={"errors": errors},
                quality_flag="all_failed",
            )

        # Step 5: Single survivor — skip evaluation
        if len(outputs) == 1:
            sole_id = next(iter(outputs))
            result = TournamentResult(
                winner=sole_id,
                winner_score=0.0,
                scores={},
                artifacts={"outputs": outputs},
                audit={"errors": errors, "skipped_eval": True},
                quality_flag="degraded",
            )
            self._write_audit(result)
            return result

        # Step 6: Evaluate via configured strategy
        try:
            if config.evaluation.strategy == "visual":
                # Visual evaluation expects Path objects for PNGs
                candidate_pngs = {k: Path(v) for k, v in outputs.items()}
                # Need a skill-like object for evaluate_visual
                eval_result = evaluate_visual(
                    type("_Skill", (), {"name": config.prompt_template[:50]})(),
                    "tournament",
                    candidate_pngs,
                )
                winner = eval_result.get("winner")
                winner_score = eval_result.get("winner_score", 0.0)
                all_scores = eval_result.get("scores", {})
            elif config.evaluation.strategy == "test":
                # Test evaluation — run code against pytest suite
                test_file = config.evaluation.factors.get("_test_file", {}).get("path", "")
                test_timeout = int(config.evaluation.factors.get("_test_timeout", {}).get("weight", 30))
                work_dir = Path(config.output.output_dir or tempfile.mkdtemp(prefix="tournament-test-"))
                test_scores = evaluate_test(outputs, test_file, work_dir, timeout=test_timeout)
                # Convert pass_rate into factor scores
                weights = {f: info["weight"] for f, info in config.evaluation.factors.items()
                           if not f.startswith("_")}
                agent_weighted: dict[str, float] = {}
                accuracy_map: dict[str, float] = {}
                all_scores = {}
                for comp_id, entry in test_scores.items():
                    pass_rate = entry.get("_pass_rate", 0.0)
                    factor_scores = {f: pass_rate for f in weights}
                    all_scores[comp_id] = factor_scores
                    agent_weighted[comp_id] = pass_rate
                    accuracy_map[comp_id] = pass_rate

                if not agent_weighted:
                    raise ValueError("No valid scores from test evaluation")

                winner = select_winner(agent_weighted, accuracy_map)
                winner_score = agent_weighted.get(winner, 0.0)

            else:
                # Semantic evaluation
                factor_scores = evaluate_semantic(
                    config.prompt_template,
                    outputs,
                    config.evaluation.factors,
                    config.evaluation.judge,
                )
                # Compute weighted averages
                weights = {f: info["weight"] for f, info in config.evaluation.factors.items()}
                agent_weighted: dict[str, float] = {}
                accuracy_map: dict[str, float] = {}
                for comp_id, scores in factor_scores.items():
                    agent_weighted[comp_id] = compute_weighted_average(scores, weights)
                    accuracy_map[comp_id] = scores.get("correctness", scores.get("accuracy", 0))

                if not agent_weighted:
                    raise ValueError("No valid scores from evaluation")

                winner = select_winner(agent_weighted, accuracy_map)
                winner_score = agent_weighted.get(winner, 0.0)
                all_scores = factor_scores

        except Exception:
            # Step: Eval failure fallback — first valid output
            first_id = next(iter(outputs))
            result = TournamentResult(
                winner=first_id,
                winner_score=0.0,
                scores={},
                artifacts={"outputs": outputs},
                audit={"errors": errors, "eval_error": True},
                quality_flag="eval_failed",
            )
            self._write_audit(result)
            return result

        # Step 9: Determine quality flag
        if winner_score >= 7:
            quality_flag = "good"
        elif winner_score >= 5:
            quality_flag = "acceptable"
        else:
            quality_flag = "poor"

        # Step 10: Return result
        result = TournamentResult(
            winner=winner,
            winner_score=round(winner_score, 2),
            scores=all_scores,
            artifacts={"outputs": outputs},
            audit={"errors": errors},
            quality_flag=quality_flag,
        )
        self._write_audit(result)
        return result

    def _write_audit(self, result: TournamentResult) -> None:
        """Write audit entry if audit_file is configured."""
        audit_file = self.config.output.audit_file
        if audit_file:
            write_audit_entry(Path(audit_file), {
                "winner": result.winner,
                "winner_score": result.winner_score,
                "quality_flag": result.quality_flag,
                "scores": result.scores,
            })


# ── CLI ────────────────────────────────────────────────────────────────


def _parse_key_value_pairs(items: list[str]) -> dict[str, str]:
    """Parse key=value pairs from argparse nargs list."""
    result: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"Expected key=value, got: {item}")
        key, value = item.split("=", 1)
        result[key] = value
    return result


def main() -> None:
    """CLI entry point for running tournaments."""
    import argparse
    import dataclasses

    parser = argparse.ArgumentParser(
        prog="tournament",
        description="Run multi-LLM tournaments with evaluation and winner selection.",
    )

    # Config source (mutually supportive, not exclusive)
    parser.add_argument("--config", metavar="PATH",
                        help="YAML config file path (loads via TournamentConfig.from_yaml)")
    parser.add_argument("--prompt", metavar="TEXT",
                        help="Inline prompt text (used when --config is not provided)")

    # Competitor & evaluation
    parser.add_argument("--competitors", metavar="IDS", default="claude,codex,gemini",
                        help="Comma-separated competitor IDs (default: claude,codex,gemini)")
    parser.add_argument("--strategy", choices=["semantic", "visual", "test"],
                        default="semantic",
                        help="Evaluation strategy (default: semantic)")
    parser.add_argument("--factors", nargs="+", metavar="KEY=WEIGHT",
                        help="Evaluation factors as key=weight pairs (e.g., correctness=2.0)")
    parser.add_argument("--judge", default="claude-sonnet-4-6",
                        help="Judge model name (default: claude-sonnet-4-6)")
    parser.add_argument("--test-file", metavar="PATH",
                        help="Test file path for test strategy")

    # Output
    parser.add_argument("--output-dir", metavar="DIR",
                        help="Directory for output files")
    parser.add_argument("--audit-file", metavar="PATH",
                        help="Path to audit JSONL file")
    parser.add_argument("--keep-all", action="store_true",
                        help="Keep all competitor outputs, not just winner")

    # Execution
    parser.add_argument("--timeout", type=int, default=300,
                        help="Timeout in seconds (default: 300)")
    parser.add_argument("--workers", type=int, default=6,
                        help="Max parallel workers (default: 6)")
    parser.add_argument("--retries", type=int, default=1,
                        help="Retry count (default: 1)")

    # Template variables
    parser.add_argument("--variables", nargs="+", metavar="KEY=VALUE",
                        help="Key=value pairs for prompt template substitution")

    # Mode flags
    parser.add_argument("--dry-run", action="store_true",
                        help="Print config and exit without running")
    parser.add_argument("--json", action="store_true", dest="json_output",
                        help="Output TournamentResult as JSON")

    args = parser.parse_args()

    # Build config
    if args.config:
        config = TournamentConfig.from_yaml(args.config)
    elif args.prompt:
        # Parse factors
        factors = dict(_DEFAULT_FACTORS)
        if args.factors:
            factors = {}
            for pair in args.factors:
                if "=" not in pair:
                    parser.error(f"--factors expects key=weight, got: {pair}")
                key, weight = pair.split("=", 1)
                try:
                    factors[key] = {"weight": float(weight)}
                except ValueError:
                    parser.error(f"Invalid weight for factor {key}: {weight}")

        # Parse competitor IDs into CompetitorConfig list
        comp_ids = [c.strip() for c in args.competitors.split(",") if c.strip()]
        competitors = [{"id": cid, "agent": cid} for cid in comp_ids]

        data: dict[str, Any] = {
            "prompt_template": args.prompt,
            "competitors": competitors,
            "evaluation": {
                "strategy": args.strategy,
                "judge": args.judge,
                "factors": factors,
            },
            "execution": {
                "max_workers": args.workers,
                "timeout_seconds": args.timeout,
                "retries": args.retries,
            },
            "output": {
                "output_dir": args.output_dir,
                "audit_file": args.audit_file,
                "keep_all": args.keep_all,
            },
        }

        if args.test_file:
            data["evaluation"]["factors"]["_test_file"] = {"path": args.test_file}

        config = TournamentConfig.from_dict(data)
    else:
        parser.error("Either --config or --prompt is required")

    # Dry run: print config and exit
    if args.dry_run:
        info = {
            "prompt_template": config.prompt_template,
            "competitors": [{"id": c.id, "agent": c.agent} for c in config.competitors],
            "evaluation": {
                "strategy": config.evaluation.strategy,
                "judge": config.evaluation.judge,
                "factors": config.evaluation.factors,
            },
            "execution": {
                "max_workers": config.execution.max_workers,
                "timeout_seconds": config.execution.timeout_seconds,
                "retries": config.execution.retries,
            },
            "output": {
                "output_dir": config.output.output_dir,
                "audit_file": config.output.audit_file,
                "keep_all": config.output.keep_all,
            },
        }
        print(json.dumps(info, indent=2))
        sys.exit(0)

    # Run tournament
    tournament = Tournament(config)
    result = tournament.run()

    # Output
    if args.json_output:
        print(json.dumps(dataclasses.asdict(result), indent=2))
    else:
        flag = result.quality_flag
        if result.winner:
            print(f"Winner: {result.winner} (score: {result.winner_score}, quality: {flag})")
        else:
            print(f"No winner (quality: {flag})")


if __name__ == "__main__":
    main()
