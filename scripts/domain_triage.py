#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_MEDIUM, parse_jsonl_output
from config_loader import get_model_id


TRIAGE_DIR = Path(__file__).parent.parent / "global" / "prompts" / "triage"
_ALLOWED_MODES = {"aggressive", "conservative", "full"}
_ALLOWED_AGENTS = {"claude", "codex"}
_REVIEW_TO_PROMPT = {
    "pr": "pr-review.md",
    "design": "design-review.md",
    "plan": "plan-review.md",
}
_REVIEW_TO_MANIFEST = {
    "pr": "pr-review",
    "design": "design-review",
    "plan": "plan-review",
}


class DomainMeta(TypedDict):
    order: str
    label: str
    filename: str
    description: str


@dataclass
class DomainVerdict:
    domain: str
    relevant: bool
    confidence: float
    reason: str


@dataclass
class TriageResult:
    mode: Literal["aggressive", "conservative", "full"]
    agent: Literal["claude", "codex"]
    model: str
    review_type: Literal["pr", "design", "plan"]
    verdicts: list[DomainVerdict]
    dispatched_domains: list[str]
    skipped_domains: list[str]
    duration_s: float
    error: str | None
    input_strategy: Literal["full", "summary"]
    content_hash: str


def _warn(message: str) -> None:
    print(f"domain_triage: {message}", file=sys.stderr)


def _fallback_description(domain: str) -> str:
    return f"{domain.replace('-', ' ').title()} review"


def _load_prompt(review_type: str) -> str:
    path = TRIAGE_DIR / _REVIEW_TO_PROMPT[review_type]
    return path.read_text(encoding="utf-8")


def _load_domain_descriptions(review_type: str) -> dict[str, str]:
    path = TRIAGE_DIR / "domains.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    section = raw.get(_REVIEW_TO_MANIFEST[review_type], {})
    if not isinstance(section, dict):
        return {}
    return {str(key): str(value) for key, value in section.items()}


def _format_domain_catalogue(domains: dict[str, DomainMeta], descriptions: dict[str, str]) -> str:
    lines: list[str] = []
    ordered = sorted(domains.items(), key=lambda item: (item[1].get("order", "99"), item[0]))
    for domain, meta in ordered:
        label = meta.get("label") or domain.replace("-", " ").title()
        description = descriptions.get(domain) or meta.get("description") or _fallback_description(domain)
        lines.append(f"- {domain} ({label}): {description}")
    return "\n".join(lines)


def _summarize_diff(content: str) -> str:
    files: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for line in content.splitlines():
        if line.startswith("diff --git "):
            if current is not None:
                files.append(current)
            parts = line.split()
            path = parts[3][2:] if len(parts) >= 4 and parts[3].startswith("b/") else parts[-1]
            current = {"path": path, "plus": 0, "minus": 0, "lines": []}
            continue
        if current is None:
            continue
        if line.startswith("+++ ") or line.startswith("--- "):
            continue
        if line.startswith("+") and not line.startswith("+++"):
            current["plus"] = int(current["plus"]) + 1
        elif line.startswith("-") and not line.startswith("---"):
            current["minus"] = int(current["minus"]) + 1
        if len(current["lines"]) < 50:
            current["lines"].append(line)
    if current is not None:
        files.append(current)

    if not files:
        return content[:120000]

    files = files[:20]
    lines = ["Diff Summary", ""]
    for info in files:
        lines.append(f"- {info['path']}: +{info['plus']}/-{info['minus']}")
    lines.append("")
    lines.append("File Excerpts")
    for info in files:
        lines.append("")
        lines.append(f"### {info['path']} (+{info['plus']}/-{info['minus']})")
        lines.extend(info["lines"])  # type: ignore[arg-type]
    return "\n".join(lines)


def _summarize_document(content: str) -> str:
    heading_re = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
    sections: list[tuple[str, list[str]]] = []
    current_heading = "Document Start"
    current_lines: list[str] = []

    for line in content.splitlines():
        match = heading_re.match(line)
        if match:
            sections.append((current_heading, current_lines))
            current_heading = match.group(2)
            current_lines = []
            continue
        current_lines.append(line)
    sections.append((current_heading, current_lines))

    summary_lines = ["Document Summary", ""]
    for heading, lines in sections:
        paragraph_lines: list[str] = []
        for raw_line in lines:
            stripped = raw_line.strip()
            if not stripped:
                if paragraph_lines:
                    break
                continue
            paragraph_lines.append(stripped)
        paragraph = " ".join(paragraph_lines)
        if paragraph:
            summary_lines.append(f"## {heading}")
            summary_lines.append(paragraph)
            summary_lines.append("")

    summarized = "\n".join(summary_lines).strip()
    return summarized or content[:120000]


def _parse_triage_response(raw: str, candidate_domains: list[str]) -> tuple[list[DomainVerdict], str | None]:
    cleaned = raw.strip()
    if not cleaned:
        return [], "empty_response"

    fence_match = re.search(r"```(?:json)?\s*\n(.*?)```", cleaned, re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1).strip()

    if "\\n" in cleaned and cleaned.startswith('"'):
        try:
            cleaned = json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            pass

    parsed: object
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        return [], f"json_parse_error: {exc}"

    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except json.JSONDecodeError as exc:
            return [], f"json_parse_error: {exc}"

    if not isinstance(parsed, dict):
        return [], f"json_parse_error: expected object, got {type(parsed).__name__}"

    domains = parsed.get("domains")
    if not isinstance(domains, list):
        return [], "json_parse_error: missing domains array"

    candidate_set = set(candidate_domains)
    seen: set[str] = set()
    verdicts: list[DomainVerdict] = []

    for item in domains:
        if not isinstance(item, dict):
            continue
        domain = item.get("domain")
        if not isinstance(domain, str):
            continue
        if domain not in candidate_set:
            _warn(f"ignoring unknown domain in triage response: {domain}")
            continue
        if domain in seen:
            _warn(f"ignoring duplicate domain in triage response: {domain}")
            continue
        seen.add(domain)

        relevant = bool(item.get("relevant"))
        confidence_raw = item.get("confidence", 0.0)
        try:
            confidence = float(confidence_raw)
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        reason = item.get("reason")
        if not isinstance(reason, str):
            reason = ""
        verdicts.append(
            DomainVerdict(
                domain=domain,
                relevant=relevant,
                confidence=confidence,
                reason=reason.strip(),
            )
        )

    missing = [domain for domain in candidate_domains if domain not in seen]
    for domain in missing:
        _warn(f"triage response missing domain {domain}; treating as relevant")
        verdicts.append(
            DomainVerdict(
                domain=domain,
                relevant=True,
                confidence=1.0,
                reason="Missing from triage response; fail-open to relevant.",
            )
        )

    order = {domain: index for index, domain in enumerate(candidate_domains)}
    verdicts.sort(key=lambda verdict: order.get(verdict.domain, len(order)))
    return verdicts, None


def _dispatch_to_agent(agent: str, prompt: str, timeout: int) -> tuple[str, str | None]:
    model = get_model_id(agent)
    run_kwargs = {
        "capture_output": True,
        "text": True,
        "timeout": timeout,
        "cwd": str(Path(__file__).parent),
        "input": prompt,
        "env": make_clean_env(),
    }

    last_error: str | None = None
    for attempt in range(2):
        try:
            if agent == "claude":
                cmd = build_claude_cmd()
            elif agent == "codex":
                cmd = [
                    "codex",
                    "exec",
                    "-m",
                    model or CODEX_MODEL,
                    "-c",
                    CODEX_REASONING_EFFORT_MEDIUM,
                    "--ephemeral",
                    "--json",
                    "-s",
                    "read-only",
                    "-",
                ]
            else:
                return "", f"unsupported agent: {agent}"

            result = subprocess.run(cmd, **run_kwargs)
            output = result.stdout
            if agent == "codex":
                output = parse_jsonl_output(output)
            if result.returncode == 0:
                return output, None
            stderr = (result.stderr or "").strip()
            last_error = f"exit_{result.returncode}: {stderr or 'no stderr'}"
            _warn(f"triage agent {agent} failed on attempt {attempt + 1}: {last_error}")
        except subprocess.TimeoutExpired:
            last_error = "timeout"
            _warn(f"triage agent {agent} timed out on attempt {attempt + 1}")
        except FileNotFoundError as exc:
            last_error = f"agent_unavailable: {exc}"
            _warn(f"triage agent {agent} unavailable: {exc}")
            break
        except OSError as exc:
            last_error = f"dispatch_error: {exc}"
            _warn(f"triage agent {agent} dispatch error: {exc}")
        if attempt == 0:
            time.sleep(2)

    if last_error == "timeout":
        return "", "timeout after 2 retries"
    return "", last_error or "triage dispatch failed"


def triage_domains(
    content: str,
    review_type: Literal["pr", "design", "plan"],
    domains: dict[str, DomainMeta],
    mode: Literal["aggressive", "conservative", "full"] = "aggressive",
    agent: Literal["claude", "codex"] = "claude",
    disabled_domains: list[str] | None = None,
    timeout: int = 15,
    confidence_threshold: float = 0.8,
) -> TriageResult:
    if mode not in _ALLOWED_MODES:
        raise ValueError(f"Invalid mode: {mode}")
    if agent not in _ALLOWED_AGENTS:
        raise ValueError(f"Invalid agent: {agent}")
    if review_type not in _REVIEW_TO_PROMPT:
        raise ValueError(f"Invalid review_type: {review_type}")

    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    model = get_model_id(agent) or ("claude" if agent == "claude" else CODEX_MODEL)

    full_ordered_domains = [
        domain
        for domain, _ in sorted(domains.items(), key=lambda item: (item[1].get("order", "99"), item[0]))
    ]

    if mode == "full":
        verdicts = [
            DomainVerdict(domain=domain, relevant=True, confidence=1.0, reason="Full mode: all domains dispatched.")
            for domain in full_ordered_domains
        ]
        return TriageResult(
            mode=mode,
            agent=agent,
            model=model,
            review_type=review_type,
            verdicts=verdicts,
            dispatched_domains=full_ordered_domains,
            skipped_domains=[],
            duration_s=0.0,
            error=None,
            input_strategy="full",
            content_hash=content_hash,
        )

    disabled_set = set(disabled_domains or [])
    candidate_domains = {
        domain: meta for domain, meta in domains.items() if domain not in disabled_set
    }
    ordered_candidates = [
        domain
        for domain, _ in sorted(candidate_domains.items(), key=lambda item: (item[1].get("order", "99"), item[0]))
    ]

    start = time.time()
    input_strategy: Literal["full", "summary"] = "full"

    try:
        prompt_template = _load_prompt(review_type)
        descriptions = _load_domain_descriptions(review_type)
        catalogue = _format_domain_catalogue(candidate_domains, descriptions)

        prompt_content = content
        if len(content) > 120000:
            prompt_content = _summarize_diff(content) if review_type == "pr" else _summarize_document(content)
            input_strategy = "summary"

        prompt = prompt_template.replace("{domains}", catalogue).replace("{content}", prompt_content)

        raw_output, dispatch_error = _dispatch_to_agent(agent, prompt, timeout)
        if dispatch_error is not None:
            raise RuntimeError(dispatch_error)

        verdicts, parse_error = _parse_triage_response(raw_output, ordered_candidates)
        if parse_error is not None:
            raise RuntimeError(parse_error)
        error: str | None = None
    except Exception as exc:
        error = str(exc)
        _warn(f"triage failed; falling back to full mode: {error}")
        verdicts = [
            DomainVerdict(domain=domain, relevant=True, confidence=1.0, reason=f"Fallback to full mode: {error}")
            for domain in ordered_candidates
        ]

    if mode == "aggressive":
        dispatched_domains = [verdict.domain for verdict in verdicts if verdict.relevant]
    else:
        dispatched_domains = [
            verdict.domain
            for verdict in verdicts
            if verdict.relevant or verdict.confidence < confidence_threshold
        ]
    skipped_domains = [domain for domain in ordered_candidates if domain not in set(dispatched_domains)]

    return TriageResult(
        mode=mode,
        agent=agent,
        model=model,
        review_type=review_type,
        verdicts=verdicts,
        dispatched_domains=dispatched_domains,
        skipped_domains=skipped_domains,
        duration_s=round(time.time() - start, 3),
        error=error,
        input_strategy=input_strategy,
        content_hash=content_hash,
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run domain triage on diff or document input.")
    parser.add_argument("--review-type", required=True, choices=["pr", "design", "plan"])
    parser.add_argument("--mode", default="aggressive", choices=["aggressive", "conservative", "full"])
    parser.add_argument("--agent", default="claude", choices=["claude", "codex"])
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--confidence-threshold", type=float, default=0.8)
    parser.add_argument("--disabled-domain", action="append", dest="disabled_domains", default=[])
    parser.add_argument(
        "--domains-json",
        help="Optional path to a domains metadata JSON file; defaults to triage manifest keys only.",
    )
    return parser.parse_args()


def _load_cli_domains(review_type: str, domains_json: str | None) -> dict[str, DomainMeta]:
    descriptions = _load_domain_descriptions(review_type)
    if domains_json:
        raw = json.loads(Path(domains_json).read_text(encoding="utf-8"))
        return {
            domain: DomainMeta(
                order=str(meta.get("order", "99")),
                label=str(meta.get("label", domain.replace("-", " ").title())),
                filename=str(meta.get("filename", f"{domain}.md")),
                description=str(meta.get("description", descriptions.get(domain) or _fallback_description(domain))),
            )
            for domain, meta in raw.items()
            if isinstance(meta, dict)
        }
    ordered = list(descriptions.items())
    return {
        domain: DomainMeta(
            order=f"{index + 1:02d}",
            label=domain.replace("-", " ").title(),
            filename=f"{domain}.md",
            description=str(description),
        )
        for index, (domain, description) in enumerate(ordered)
    }


if __name__ == "__main__":
    args = _parse_args()
    input_content = sys.stdin.read()
    cli_domains = _load_cli_domains(args.review_type, args.domains_json)
    result = triage_domains(
        content=input_content,
        review_type=args.review_type,
        domains=cli_domains,
        mode=args.mode,
        agent=args.agent,
        disabled_domains=args.disabled_domains,
        timeout=args.timeout,
        confidence_threshold=args.confidence_threshold,
    )
    print(
        json.dumps(
            {
                "mode": result.mode,
                "agent": result.agent,
                "model": result.model,
                "review_type": result.review_type,
                "verdicts": [verdict.__dict__ for verdict in result.verdicts],
                "dispatched_domains": result.dispatched_domains,
                "skipped_domains": result.skipped_domains,
                "duration_s": result.duration_s,
                "error": result.error,
                "input_strategy": result.input_strategy,
                "content_hash": result.content_hash,
            },
            indent=2,
        )
    )
