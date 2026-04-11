#!/usr/bin/env python3
"""3-tier domain classifier for forge design specs."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config_loader import get_forge_config

DEFAULT_HEURISTICS_PATH = (
    Path.home() / ".claude" / "code-review" / "forge_heuristics.json"
)
FALLBACK_HEURISTICS_PATH = (
    Path(__file__).resolve().parent.parent / "global" / "forge_heuristics.json"
)
LOG_NAME = "forge_classification_log.jsonl"
LOG_ROTATE_LIMIT = 1000
_MAX_EXPLANATION_TERM_LEN = 30
_MAX_PATTERN_LEN = 50


@dataclass
class ClassificationResult:
    domains: list[str]
    skipped_domains: list[str]
    design_type: str
    tier_used: int
    confidence: float


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def _heuristics_path() -> Path:
    if DEFAULT_HEURISTICS_PATH.exists():
        return DEFAULT_HEURISTICS_PATH
    return FALLBACK_HEURISTICS_PATH


def _load_heuristics(heuristics_path: Path | None = None) -> dict[str, Any]:
    path = heuristics_path or _heuristics_path()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("heuristics must be a JSON object")
    return data


def _compile_patterns(rules: dict[str, Any]) -> dict[str, list[re.Pattern[str]]]:
    compiled: dict[str, list[re.Pattern[str]]] = {}
    conditional = rules.get("conditional", {})
    if not isinstance(conditional, dict):
        return compiled
    for domain, domain_rules in conditional.items():
        if not isinstance(domain_rules, dict):
            continue
        patterns = domain_rules.get("patterns", [])
        if not isinstance(patterns, list):
            continue
        compiled[domain] = [
            re.compile(pattern, re.IGNORECASE)
            for pattern in patterns
            if isinstance(pattern, str) and pattern != "always"
        ]
    return compiled


def _determine_design_type(content: str, spec_path: Path) -> str:
    lowered = content.lower()
    suffix = spec_path.suffix.lower()
    if any(term in lowered for term in ("ui", "ux", "screen reader", "wcag", "aria")):
        return "frontend"
    if any(term in lowered for term in ("api", "database", "postgresql", "service", "auth")):
        return "backend"
    if suffix in {".md", ".txt", ".rst"}:
        return "general"
    return "unknown"


def match_heuristics(
    content: str, rules: dict[str, Any]
) -> tuple[list[str], list[str], float]:
    compiled = _compile_patterns(rules)
    conditional = rules.get("conditional", {})
    always_include = rules.get("always_include", [])
    if not isinstance(always_include, list):
        always_include = []

    matched: list[str] = [domain for domain in always_include if isinstance(domain, str)]
    matched_conditional = 0
    total_conditional = 0

    for domain, domain_rules in conditional.items():
        if not isinstance(domain_rules, dict):
            continue
        patterns = domain_rules.get("patterns", [])
        if not isinstance(patterns, list):
            continue
        total_conditional += 1
        if "always" in patterns:
            matched.append(domain)
            matched_conditional += 1
            continue
        regexes = compiled.get(domain, [])
        if any(pattern.search(content) for pattern in regexes):
            matched.append(domain)
            matched_conditional += 1

    matched = _ordered_unique(matched)
    skipped = [
        domain
        for domain in conditional
        if domain not in set(matched)
    ]
    ratio = (
        matched_conditional / total_conditional
        if total_conditional > 0
        else 0.0
    )
    confidence = ratio if ratio >= 0.5 else min(ratio, 0.49)
    return matched, skipped, confidence


def _build_triage_domains(available_domains: list[str]) -> dict[str, dict[str, str]]:
    return {
        domain: {
            "order": f"{index + 1:02d}",
            "label": domain.replace("-", " ").title(),
            "filename": f"{domain}.md",
            "description": f"{domain.replace('-', ' ').title()} review",
        }
        for index, domain in enumerate(available_domains)
    }


def _summarize_for_llm(content: str, spec_path: Path, design_type: str) -> str:
    snippets = [
        line.strip()
        for line in content.splitlines()
        if line.strip()
    ]
    preview = " ".join(snippets[:8])[:1200]
    return (
        f"Spec path: {spec_path.name}\n"
        f"Design type: {design_type}\n"
        f"Content summary: {preview}"
    )


def _llm_classify(content_summary: str, available_domains: list[str]) -> dict[str, Any]:
    """Call LLM for domain classification. Override in tests."""
    try:
        from domain_triage import triage_domains
    except ImportError:
        return {"domains": [], "confidence": 0.0, "explanation": ""}

    result = triage_domains(
        content=content_summary,
        review_type="design",
        domains=_build_triage_domains(available_domains),
    )
    explanation = " ".join(
        verdict.reason for verdict in result.verdicts if getattr(verdict, "reason", "")
    ).strip()
    return {
        "domains": result.dispatched_domains,
        "confidence": 1.0 if result.dispatched_domains else 0.0,
        "explanation": explanation,
    }


def _extract_explanation_terms(explanation: str) -> list[str]:
    candidates = re.findall(r"[A-Za-z][A-Za-z0-9 _/-]{1,29}", explanation)
    cleaned = [candidate.strip() for candidate in candidates if candidate.strip()]
    return _ordered_unique(cleaned)


def _interactive_confirm(
    domains: list[str], available_domains: list[str], design_type: str
) -> list[str]:
    print(f"Detected design type: {design_type}")
    print(f"Detected domains: {', '.join(domains)}")
    print("Press Enter to accept, or use +domain / -domain to adjust.")
    response = input("> ").strip()
    if not response:
        return domains

    updated = list(domains)
    for token in response.split():
        if token.startswith("+") and token[1:] in available_domains:
            updated.append(token[1:])
        elif token.startswith("-") and token[1:] in updated:
            updated.remove(token[1:])
    return _ordered_unique(updated)


def classify_spec(
    content: str,
    spec_path: Path,
    auto_detect: bool,
    cfg: dict[str, Any] | None,
) -> ClassificationResult:
    forge_cfg = cfg or get_forge_config()
    available_domains = list(forge_cfg.get("domain_routing", {}).keys())
    heuristics = _load_heuristics()
    matched_domains, _, heuristic_confidence = match_heuristics(content, heuristics)
    design_type = _determine_design_type(content, spec_path)

    if heuristic_confidence >= 0.5 and auto_detect:
        return ClassificationResult(
            domains=_ordered_unique(matched_domains),
            skipped_domains=[
                domain for domain in available_domains if domain not in set(matched_domains)
            ],
            design_type=design_type,
            tier_used=1,
            confidence=heuristic_confidence,
        )

    domains = list(matched_domains)
    confidence = heuristic_confidence
    tier_used = 1

    if heuristic_confidence < 0.5:
        llm_result = _llm_classify(
            _summarize_for_llm(content, spec_path, design_type),
            available_domains,
        )
        llm_domains = [
            domain
            for domain in llm_result.get("domains", [])
            if domain in available_domains
        ]
        domains = _ordered_unique(domains + llm_domains)
        confidence = max(
            heuristic_confidence,
            float(llm_result.get("confidence", 0.0)),
        )
        tier_used = 2

    if not auto_detect and sys.stdin.isatty():
        domains = _interactive_confirm(domains, available_domains, design_type)
        tier_used = max(tier_used, 3)

    return ClassificationResult(
        domains=domains,
        skipped_domains=[
            domain for domain in available_domains if domain not in set(domains)
        ],
        design_type=design_type,
        tier_used=tier_used,
        confidence=confidence,
    )


def append_classification_log(log_path: Path, entry: dict[str, Any]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        with log_path.open("r", encoding="utf-8") as handle:
            line_count = sum(1 for _ in handle)
        if line_count >= LOG_ROTATE_LIMIT:
            backup = log_path.with_suffix(log_path.suffix + ".bak")
            backup.unlink(missing_ok=True)
            log_path.replace(backup)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def maybe_patch_heuristics(
    explanation_terms: list[str],
    domain: str,
    heuristics_path: Path,
) -> bool:
    heuristics = _load_heuristics(heuristics_path)
    conditional = heuristics.setdefault("conditional", {})
    if not isinstance(conditional, dict):
        raise ValueError("conditional heuristics must be an object")
    domain_rules = conditional.setdefault(domain, {"patterns": []})
    if not isinstance(domain_rules, dict):
        raise ValueError("domain rules must be an object")
    patterns = domain_rules.setdefault("patterns", [])
    if not isinstance(patterns, list):
        raise ValueError("patterns must be a list")

    updated = False
    for term in explanation_terms:
        if not isinstance(term, str):
            continue
        cleaned = term.strip()
        if not cleaned or len(cleaned) > _MAX_EXPLANATION_TERM_LEN:
            continue
        escaped = re.escape(cleaned)
        candidate = rf"\b{escaped}\b"
        if len(candidate) >= _MAX_PATTERN_LEN or candidate in patterns:
            continue
        patterns.append(candidate)
        updated = True

    if updated:
        heuristics["patches_since_consolidation"] = int(
            heuristics.get("patches_since_consolidation", 0)
        ) + 1
        heuristics_path.write_text(
            json.dumps(heuristics, indent=2) + "\n",
            encoding="utf-8",
        )
    return updated

