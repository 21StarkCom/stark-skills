#!/usr/bin/env python3
"""Benchmark Codex CLI configurations to find optimal settings for plan review.

Tests multiple dimensions:
  - Reasoning effort: low, medium, high
  - Sandbox mode: read-only vs full-auto (workspace-write)
  - Output mode: --json (JSONL to stdout) vs -o file (last message to file)
  - Prompt size: small (~20 lines) vs medium (~80 lines)
  - Model: default (gpt-5.4) vs explicit override

Each test case runs Codex with a fixed review prompt + plan fixture,
measures wall-clock time, exit code, output size, and JSON parseability.

Usage:
    python3 scripts/benchmarks/codex_benchmark.py [--quick] [--filter PATTERN] [--timeout SECS]

    --quick     Run only the 6 most diagnostic cases (default: all ~16 cases)
    --filter    Only run cases whose name contains PATTERN
    --timeout   Per-case timeout in seconds (default: 300)
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
FIXTURES = SCRIPT_DIR / "fixtures"
REVIEW_PROMPT = """\
You are reviewing a design document. Evaluate whether the scope is right-sized.
Output ONLY a JSON array of findings. No preamble, no markdown fences, no explanation.
[{"severity": "high|medium|low", "title": "...", "description": "...", "suggestion": "..."}]
If there are no findings, output: []"""


@dataclass
class TestCase:
    name: str
    reasoning: str  # low, medium, high
    sandbox: str  # read-only, full-auto
    output_mode: str  # json, file
    fixture: str  # small-plan.md, medium-plan.md
    model: str | None = None  # None = default


@dataclass
class Result:
    name: str
    duration_s: float = 0.0
    exit_code: int = -1
    output_size: int = 0
    json_parseable: bool = False
    findings_count: int = -1
    error: str = ""
    timed_out: bool = False


# --- Test matrix ---

QUICK_CASES = [
    TestCase("low-ro-json-small", "low", "read-only", "json", "small-plan.md"),
    TestCase("medium-ro-json-small", "medium", "read-only", "json", "small-plan.md"),
    TestCase("high-ro-json-small", "high", "read-only", "json", "small-plan.md"),
    TestCase("high-fa-json-small", "high", "full-auto", "json", "small-plan.md"),
    TestCase("high-ro-file-small", "high", "read-only", "file", "small-plan.md"),
    TestCase("high-ro-json-medium", "high", "read-only", "json", "medium-plan.md"),
]

FULL_CASES = QUICK_CASES + [
    TestCase("low-ro-json-medium", "low", "read-only", "json", "medium-plan.md"),
    TestCase("medium-ro-json-medium", "medium", "read-only", "json", "medium-plan.md"),
    TestCase("low-fa-json-small", "low", "full-auto", "json", "small-plan.md"),
    TestCase("medium-fa-json-small", "medium", "full-auto", "json", "small-plan.md"),
    TestCase("low-ro-file-small", "low", "read-only", "file", "small-plan.md"),
    TestCase("medium-ro-file-small", "medium", "read-only", "file", "small-plan.md"),
    TestCase("high-fa-json-medium", "high", "full-auto", "json", "medium-plan.md"),
    TestCase("high-fa-file-medium", "high", "full-auto", "file", "medium-plan.md"),
    TestCase("high-ro-file-medium", "high", "read-only", "file", "medium-plan.md"),
    TestCase("low-fa-file-medium", "low", "full-auto", "file", "medium-plan.md"),
]


def run_case(tc: TestCase, timeout: int) -> Result:
    """Execute a single benchmark case and return the result."""
    result = Result(name=tc.name)
    plan_path = FIXTURES / tc.fixture
    plan_content = plan_path.read_text()
    full_prompt = f"{REVIEW_PROMPT}\n\n{plan_content}"

    # Build command
    cmd = ["codex", "exec"]
    cmd += ["-c", f'model_reasoning_effort="{tc.reasoning}"']
    cmd += ["--ephemeral"]

    if tc.model:
        cmd += ["-m", tc.model]

    if tc.sandbox == "full-auto":
        cmd += ["--full-auto"]
    else:
        cmd += ["-s", "read-only"]

    output_file = None
    if tc.output_mode == "json":
        cmd += ["--json"]
    else:
        output_file = tempfile.NamedTemporaryFile(
            suffix=".txt", delete=False, prefix="codex-bench-"
        )
        output_file.close()
        cmd += ["-o", output_file.name]

    cmd += ["-"]  # read prompt from stdin

    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            input=full_prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        result.duration_s = time.monotonic() - t0
        result.exit_code = proc.returncode

        # Extract output
        raw = ""
        if tc.output_mode == "json":
            # Parse JSONL events to extract agent text
            parts = []
            for line in proc.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                    if ev.get("type") == "item.completed":
                        item = ev.get("item", {})
                        itype = item.get("type", "")
                        if itype == "agent_message":
                            text = item.get("text", "")
                            if text:
                                parts.append(text)
                        elif itype == "message":
                            for c in item.get("content", []):
                                if c.get("type") == "output_text":
                                    parts.append(c.get("text", ""))
                except json.JSONDecodeError:
                    continue
            raw = "\n".join(parts)
        else:
            if output_file and os.path.exists(output_file.name):
                raw = Path(output_file.name).read_text()

        result.output_size = len(raw)

        # Try to parse as JSON findings
        if raw.strip():
            # Strip markdown fences if present
            text = raw.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                lines = [l for l in lines if not l.strip().startswith("```")]
                text = "\n".join(lines).strip()
            try:
                findings = json.loads(text)
                result.json_parseable = True
                if isinstance(findings, list):
                    result.findings_count = len(findings)
            except json.JSONDecodeError:
                # Try to find JSON array in the output
                start = text.find("[")
                end = text.rfind("]")
                if start != -1 and end != -1:
                    try:
                        findings = json.loads(text[start : end + 1])
                        result.json_parseable = True
                        if isinstance(findings, list):
                            result.findings_count = len(findings)
                    except json.JSONDecodeError:
                        pass

        if proc.returncode != 0 and not result.error:
            result.error = proc.stderr[:200] if proc.stderr else f"exit {proc.returncode}"

    except subprocess.TimeoutExpired:
        result.duration_s = time.monotonic() - t0
        result.timed_out = True
        result.error = f"timeout ({timeout}s)"
    finally:
        if output_file and os.path.exists(output_file.name):
            os.unlink(output_file.name)

    return result


def print_results(results: list[Result]) -> None:
    """Print results as a formatted table."""
    # Header
    cols = [
        ("Case", 30),
        ("Time", 8),
        ("Exit", 4),
        ("Out", 6),
        ("JSON?", 5),
        ("Finds", 5),
        ("Status", 20),
    ]
    header = "  ".join(f"{name:<{width}}" for name, width in cols)
    print(f"\n{'=' * len(header)}")
    print("CODEX BENCHMARK RESULTS")
    print(f"{'=' * len(header)}")
    print(header)
    print("-" * len(header))

    for r in results:
        time_str = f"{r.duration_s:.1f}s" if not r.timed_out else "TIMEOUT"
        exit_str = str(r.exit_code) if not r.timed_out else "-"
        out_str = str(r.output_size)
        json_str = "Y" if r.json_parseable else "N"
        finds_str = str(r.findings_count) if r.findings_count >= 0 else "-"
        status = "OK" if r.exit_code == 0 and not r.timed_out else r.error[:20]

        row = [
            f"{r.name:<30}",
            f"{time_str:<8}",
            f"{exit_str:<4}",
            f"{out_str:<6}",
            f"{json_str:<5}",
            f"{finds_str:<5}",
            f"{status:<20}",
        ]
        print("  ".join(row))

    print(f"\n{'=' * len(header)}")

    # Analysis
    successful = [r for r in results if r.exit_code == 0 and not r.timed_out]
    if successful:
        fastest = min(successful, key=lambda r: r.duration_s)
        slowest = max(successful, key=lambda r: r.duration_s)
        json_rate = sum(1 for r in successful if r.json_parseable) / len(successful) * 100

        print(f"\nFastest: {fastest.name} ({fastest.duration_s:.1f}s)")
        print(f"Slowest: {slowest.name} ({slowest.duration_s:.1f}s)")
        print(f"JSON parse rate: {json_rate:.0f}%")
        print(f"Timeouts: {sum(1 for r in results if r.timed_out)}/{len(results)}")

        # Dimension analysis
        print("\n--- By reasoning effort ---")
        for effort in ("low", "medium", "high"):
            group = [r for r in successful if effort in r.name.split("-")[0]]
            if group:
                avg = sum(r.duration_s for r in group) / len(group)
                print(f"  {effort:>6}: avg {avg:.1f}s ({len(group)} runs)")

        print("\n--- By sandbox mode ---")
        for mode, key in [("read-only", "-ro-"), ("full-auto", "-fa-")]:
            group = [r for r in successful if key in r.name]
            if group:
                avg = sum(r.duration_s for r in group) / len(group)
                print(f"  {mode:>10}: avg {avg:.1f}s ({len(group)} runs)")

        print("\n--- By output mode ---")
        for mode in ("json", "file"):
            group = [r for r in successful if f"-{mode}-" in r.name]
            if group:
                avg = sum(r.duration_s for r in group) / len(group)
                print(f"  {mode:>4}: avg {avg:.1f}s ({len(group)} runs)")

        print("\n--- By fixture size ---")
        for size in ("small", "medium"):
            group = [r for r in successful if r.name.endswith(size)]
            if group:
                avg = sum(r.duration_s for r in group) / len(group)
                print(f"  {size:>6}: avg {avg:.1f}s ({len(group)} runs)")

    # Save raw results
    results_path = SCRIPT_DIR / "codex_benchmark_results.json"
    raw = [
        {
            "name": r.name,
            "duration_s": round(r.duration_s, 2),
            "exit_code": r.exit_code,
            "output_size": r.output_size,
            "json_parseable": r.json_parseable,
            "findings_count": r.findings_count,
            "timed_out": r.timed_out,
            "error": r.error,
        }
        for r in results
    ]
    results_path.write_text(json.dumps(raw, indent=2))
    print(f"\nRaw results saved to: {results_path}")


def main():
    parser = argparse.ArgumentParser(description="Benchmark Codex CLI configurations")
    parser.add_argument("--quick", action="store_true", help="Run only 6 diagnostic cases")
    parser.add_argument("--filter", help="Only run cases whose name contains PATTERN")
    parser.add_argument("--timeout", type=int, default=300, help="Per-case timeout (s)")
    args = parser.parse_args()

    cases = QUICK_CASES if args.quick else FULL_CASES
    if args.filter:
        cases = [c for c in cases if args.filter in c.name]

    if not cases:
        print("No test cases match the filter.", file=sys.stderr)
        sys.exit(1)

    # Verify codex is available
    try:
        subprocess.run(["codex", "--version"], capture_output=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print("Error: codex CLI not found or not responding", file=sys.stderr)
        sys.exit(1)

    print(f"Running {len(cases)} benchmark cases (timeout: {args.timeout}s each)")
    print(f"Fixtures: {FIXTURES}")
    print()

    results = []
    for i, tc in enumerate(cases, 1):
        print(f"[{i}/{len(cases)}] {tc.name} ...", end="", flush=True)
        r = run_case(tc, args.timeout)
        results.append(r)
        status = f" {r.duration_s:.1f}s" if not r.timed_out else " TIMEOUT"
        if r.exit_code != 0 and not r.timed_out:
            status += f" (exit {r.exit_code})"
        print(status)

    print_results(results)


if __name__ == "__main__":
    main()
