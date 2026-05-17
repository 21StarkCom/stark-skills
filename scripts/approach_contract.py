#!/usr/bin/env python3
"""Pre-execution approach contract for expensive workflow execution.

Builds a lightweight contract from a plan file and repo constraints, emits an
observability event, and optionally prompts for confirmation before proceeding.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _emit import emit_event

LOG_PATH = Path.home() / ".claude" / "code-review" / "approach-contracts.jsonl"

_GOAL_HEADING_RE = re.compile(r"^#{1,6}\s+(what|goal|goals|objective|objectives)\b", re.IGNORECASE)
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_BULLET_RE = re.compile(r"^\s*[-*]\s+(.+?)\s*$")
_CONSTRAINT_RE = re.compile(r"\b(must|must not|should|should not|do not|don't|never|required)\b", re.IGNORECASE)


@dataclass
class ContractResult:
    plan_file: str
    what: list[str]
    how: list[str]
    constraints: list[str]
    valid: bool
    violations: list[str]
    confirmed: bool
    timestamp: str


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _find_repo_root(plan_file: Path) -> Path:
    for base in [plan_file.parent, *plan_file.parents]:
        if (base / ".git").exists() or (base / "CLAUDE.md").exists():
            return base
    return Path.cwd()


def _extract_goals(plan_text: str) -> list[str]:
    lines = plan_text.splitlines()
    goals: list[str] = []
    in_goal_section = False

    for line in lines:
        heading_match = _HEADING_RE.match(line)
        if heading_match:
            title = heading_match.group(2).strip()
            in_goal_section = bool(_GOAL_HEADING_RE.match(line))
            if in_goal_section:
                goals.append(title)
            continue

        bullet_match = _BULLET_RE.match(line)
        if in_goal_section and bullet_match:
            goals.append(bullet_match.group(1).strip())
            continue

        if in_goal_section and line.strip() and not line.startswith("#"):
            goals.append(line.strip())

    if goals:
        return _dedupe(goals)[:8]

    headings = [
        match.group(2).strip()
        for match in (_HEADING_RE.match(line) for line in lines)
        if match and not match.group(2).strip().lower().startswith(("phase", "task", "step"))
    ]
    return _dedupe(headings)[:6]


def _extract_how(plan_text: str) -> list[str]:
    steps: list[str] = []
    for line in plan_text.splitlines():
        heading_match = _HEADING_RE.match(line)
        if heading_match:
            title = heading_match.group(2).strip()
            lower = title.lower()
            if lower.startswith(("phase", "task", "step", "implementation", "rollout", "verify", "validation")):
                steps.append(title)
                continue
        bullet_match = _BULLET_RE.match(line)
        if bullet_match:
            text = bullet_match.group(1).strip()
            if len(text.split()) >= 3:
                steps.append(text)
    return _dedupe(steps)[:10]


def _extract_constraints(repo_root: Path) -> list[str]:
    claude_path = repo_root / "CLAUDE.md"
    if not claude_path.exists():
        return []

    constraints: list[str] = []
    for raw_line in _read_text(claude_path).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(("-", "*")):
            line = line[1:].strip()
        if _CONSTRAINT_RE.search(line):
            constraints.append(line)
    return _dedupe(constraints)[:12]


def _detect_violations(plan_text: str, constraints: list[str]) -> list[str]:
    lower_plan = plan_text.lower()
    violations: list[str] = []
    checks = [
        ("do not commit", ("git commit", "commit the changes")),
        ("do not push", ("git push", "push the branch")),
        ("never use destructive commands", ("git reset --hard", "git checkout --")),
        ("must run tests", ("skip tests", "without tests")),
        ("must verify", ("skip verification", "without verification")),
    ]
    for constraint in constraints:
        lower_constraint = constraint.lower()
        for marker, forbidden_terms in checks:
            if marker in lower_constraint and any(term in lower_plan for term in forbidden_terms):
                violations.append(constraint)
                break
    return _dedupe(violations)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = re.sub(r"\s+", " ", item).strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def _build_contract(plan_file: Path) -> ContractResult:
    repo_root = _find_repo_root(plan_file)
    plan_text = _read_text(plan_file)
    constraints = _extract_constraints(repo_root)
    violations = _detect_violations(plan_text, constraints)
    return ContractResult(
        plan_file=str(plan_file),
        what=_extract_goals(plan_text),
        how=_extract_how(plan_text),
        constraints=constraints,
        valid=not violations,
        violations=violations,
        confirmed=False,
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _format_contract(contract: ContractResult) -> str:
    def _section(title: str, items: list[str], empty: str) -> list[str]:
        lines = [title]
        values = items or [empty]
        lines.extend(f"- {item}" for item in values)
        return lines

    lines: list[str] = [f"Approach Contract: {contract.plan_file}", ""]
    lines.extend(_section("What", contract.what, "No explicit goals detected"))
    lines.append("")
    lines.extend(_section("How", contract.how, "No execution steps detected"))
    lines.append("")
    lines.extend(_section("Constraints", contract.constraints, "No CLAUDE.md constraints found"))
    if contract.violations:
        lines.append("")
        lines.extend(_section("Violations", contract.violations, "None"))
    return "\n".join(lines)


def _log_contract(contract: ContractResult) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(contract)) + "\n")
    except OSError as exc:
        print(f"approach_contract: warning: failed to write log: {exc}", file=sys.stderr)


def _emit_event(contract: ContractResult) -> None:
    try:
        emit_event(
            "approach_contract",
            {
                "plan_file": contract.plan_file,
                "what": contract.what,
                "how": contract.how,
                "constraints": contract.constraints,
                "valid": contract.valid,
                "violations": contract.violations,
                "confirmed": contract.confirmed,
            },
        )
    except Exception as exc:
        print(f"approach_contract: warning: failed to emit event: {exc}", file=sys.stderr)


def _finish(contract: ContractResult, *, as_json: bool) -> None:
    _log_contract(contract)
    _emit_event(contract)
    if as_json:
        print(json.dumps(asdict(contract), indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Approach contract confirmation gate")
    parser.add_argument("--plan-file", required=True, help="Path to a markdown plan file")
    parser.add_argument("--force-confirm", action="store_true", help="Bypass confirmation prompt")
    parser.add_argument("--json", action="store_true", help="Emit JSON result")
    args = parser.parse_args()

    plan_file = Path(args.plan_file).expanduser()
    contract = _build_contract(plan_file)

    if args.force_confirm:
        contract.confirmed = True
        print(
            f"approach_contract: force-confirm enabled for {contract.plan_file}",
            file=sys.stderr,
        )
        _finish(contract, as_json=args.json)
        raise SystemExit(0)

    interactive = sys.stdin.isatty() and not args.json
    if interactive:
        print(_format_contract(contract))
        while True:
            try:
                answer = input("Proceed? [Y/n/edit] ").strip().lower()
            except EOFError:
                answer = "n"
            if answer in ("", "y", "yes"):
                contract.confirmed = True
                _finish(contract, as_json=args.json)
                raise SystemExit(0)
            if answer in ("n", "no"):
                _finish(contract, as_json=args.json)
                raise SystemExit(1)
            if answer == "edit":
                print("Edit the plan file and re-run")
                _finish(contract, as_json=args.json)
                raise SystemExit(1)
    else:
        if not contract.valid:
            _finish(contract, as_json=args.json)
            print(
                f"approach_contract: constraint violation: {contract.violations[0]}",
                file=sys.stderr,
            )
            raise SystemExit(1)
        contract.confirmed = True
        _finish(contract, as_json=args.json)
        raise SystemExit(0)


if __name__ == "__main__":
    main()
