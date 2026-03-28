"""Report rendering and token estimation utilities."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Template


def render_report(template_path: Path, data: dict) -> str:
    """Render a Jinja2 template with the given data dict."""
    template_text = template_path.read_text()
    template = Template(template_text)
    return template.render(**data)


def estimate_tokens(input_chars: int, output_chars: int) -> dict:
    """Estimate token counts and cost (sonnet-4-6 pricing)."""
    prompt_tokens = input_chars // 4
    completion_tokens = output_chars // 4
    total = (input_chars + output_chars) // 4
    cost_usd = round(
        prompt_tokens * 3 / 1_000_000 + completion_tokens * 15 / 1_000_000, 4
    )
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total": total,
        "cost_usd": cost_usd,
    }
