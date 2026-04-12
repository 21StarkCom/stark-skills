"""Structural checks for forged-review prompt files.

This is a *filesystem* test — it verifies that every prompt exists with the
expected name and that each file has a JSON output schema block. It does not
invoke any LLM or subprocess.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPTS_DIR = REPO_ROOT / "global" / "prompts" / "forged-review"

# (leader, second) per domain, per design spec §5 domain_pairs
DOMAIN_PAIRS = {
    "01-architecture":          ("claude", "codex"),
    "02-accessibility":         ("claude", "gemini"),
    "03-correctness":           ("codex",  "claude"),
    "04-type-safety":           ("codex",  "gemini"),
    "05-security":              ("gemini", "codex"),
    "06-test-coverage":         ("codex",  "gemini"),
    "07-spec-conformance":      ("claude", "codex"),
    "08-ui-design-conformance": ("gemini", "claude"),
    "09-regression-prevention": ("gemini", "claude"),
}


def test_triage_prompt_exists_and_has_schema():
    path = PROMPTS_DIR / "triage" / "triage.md"
    assert path.exists()
    content = path.read_text()
    assert "selected_domains" in content
    assert "rationale" in content
    assert "```json" in content


def test_all_18_domain_prompts_exist():
    missing: list[str] = []
    for domain, (leader, second) in DOMAIN_PAIRS.items():
        leader_path = PROMPTS_DIR / leader / f"{domain}-leader.md"
        second_path = PROMPTS_DIR / second / f"{domain}-second.md"
        if not leader_path.exists():
            missing.append(str(leader_path.relative_to(REPO_ROOT)))
        if not second_path.exists():
            missing.append(str(second_path.relative_to(REPO_ROOT)))
    assert not missing, f"Missing prompt files: {missing}"


def test_leader_prompts_declare_id_field():
    for domain, (leader, _) in DOMAIN_PAIRS.items():
        path = PROMPTS_DIR / leader / f"{domain}-leader.md"
        content = path.read_text()
        assert '"id"' in content, f"{path.name} leader prompt must define id field"
        assert "```json" in content, f"{path.name} leader prompt must have JSON example"


def test_second_prompts_define_decisions_and_second_only():
    for domain, (_, second) in DOMAIN_PAIRS.items():
        path = PROMPTS_DIR / second / f"{domain}-second.md"
        content = path.read_text()
        assert '"decisions"' in content, f"{path.name} missing decisions"
        assert '"second_only"' in content, f"{path.name} missing second_only"


def test_each_agent_leads_three_and_seconds_three():
    leads = {"claude": 0, "codex": 0, "gemini": 0}
    seconds = {"claude": 0, "codex": 0, "gemini": 0}
    for leader, second in DOMAIN_PAIRS.values():
        leads[leader] += 1
        seconds[second] += 1
    assert leads == {"claude": 3, "codex": 3, "gemini": 3}
    assert seconds == {"claude": 3, "codex": 3, "gemini": 3}


def test_all_three_forge_design_prompts_exist():
    for agent in ("claude", "codex", "gemini"):
        path = PROMPTS_DIR / "forge-design" / f"{agent}.md"
        assert path.exists(), f"missing forge-design prompt: {path}"
        content = path.read_text()
        assert "Proposed Design" in content or "Proposed design" in content.lower()
