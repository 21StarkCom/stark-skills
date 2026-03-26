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

# Re-export for backward compat
__all__ = [
    "FACTOR_WEIGHTS", "AGENTS", "CODEX_REASONING_CONFIG",
    "dispatch_competitor", "evaluate_visual", "evaluate_semantic",
    "build_eval_prompt",
    "parse_scores", "compute_weighted_average", "select_winner",
    "write_audit_entry", "screenshot_html", "unescape_json_string",
    "TournamentConfig", "TournamentResult", "Tournament",
    "CompetitorConfig", "EvaluationConfig", "ExecutionConfig", "OutputConfig",
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
