#!/usr/bin/env python3
"""Generate golden-file snapshots for flow extraction + layout.

Extracts and lays out flow diagrams for a representative set of skills,
normalizes the output (round coords to int, sort keys), and writes to
``tests/golden/<name>.flow.json``.

Usage:
    python3 generate_golden_files.py            # regenerate all
    python3 generate_golden_files.py --check    # verify golden files are up to date
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from flow_extractor import extract_skill_workflow
from flow_layout import compute_layout
from flow_schema import FlowDiagram

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / 'skill'
GOLDEN_DIR = ROOT / 'tests' / 'golden'

GOLDEN_SKILLS = [
    'stark-team-review',
    'stark-pr-flow',
    'stark-session',
    'stark-update-deps',
    'stark-release',
]


def normalize_diagram(diagram: FlowDiagram) -> dict:
    """Convert a FlowDiagram to a dict with rounded coords and sorted keys."""
    data = diagram.model_dump()
    for node in data['nodes']:
        pos = node['position']
        pos['x'] = int(round(pos['x']))
        pos['y'] = int(round(pos['y']))
    return json.loads(json.dumps(data, sort_keys=True))


def generate_one(skill_name: str) -> dict | None:
    """Extract, layout, and normalize a single skill's flow diagram."""
    diagram = extract_skill_workflow(SKILL_DIR / skill_name)
    if diagram is None:
        print(f'  FAIL {skill_name}: no workflow extracted', file=sys.stderr)
        return None

    positioned = compute_layout(diagram)
    if positioned is None:
        print(f'  FAIL {skill_name}: layout failed', file=sys.stderr)
        return None

    return normalize_diagram(positioned)


def generate_all() -> dict[str, dict]:
    """Generate golden files for all representative skills.

    Every skill in ``GOLDEN_SKILLS`` is required to produce a diagram. If any
    fails, exit non-zero — silent skips would let CI green-light a PR that
    has actually stopped validating one of the configured skills.
    """
    results: dict[str, dict] = {}
    missing: list[str] = []
    for name in GOLDEN_SKILLS:
        data = generate_one(name)
        if data is None:
            missing.append(name)
        else:
            results[name] = data
    if missing:
        print(
            f'\nGOLDEN_SKILLS produced no diagram: {", ".join(missing)}',
            file=sys.stderr,
        )
        sys.exit(1)
    return results


def write_golden_files(results: dict[str, dict]) -> None:
    """Write golden files to disk."""
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in results.items():
        path = GOLDEN_DIR / f'{name}.flow.json'
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        print(f'  wrote {path.relative_to(ROOT)}')


def check_golden_files(results: dict[str, dict]) -> bool:
    """Compare regenerated results against existing golden files. Returns True if all match."""
    ok = True
    for name, data in results.items():
        path = GOLDEN_DIR / f'{name}.flow.json'
        if not path.exists():
            print(f'  MISSING {path.relative_to(ROOT)}', file=sys.stderr)
            ok = False
            continue
        existing = json.loads(path.read_text(encoding='utf-8'))
        if existing != data:
            print(f'  MISMATCH {path.relative_to(ROOT)}', file=sys.stderr)
            ok = False
        else:
            print(f'  ok {path.relative_to(ROOT)}')
    return ok


def main() -> None:
    check_mode = '--check' in sys.argv
    results = generate_all()

    if not results:
        print('No golden files generated — check skill directory and node/dagre availability.', file=sys.stderr)
        sys.exit(1)

    if check_mode:
        if not check_golden_files(results):
            print('\nGolden files are out of date. Run: python3 generate_golden_files.py', file=sys.stderr)
            sys.exit(1)
        print(f'\nAll {len(results)} golden files up to date.')
    else:
        write_golden_files(results)
        print(f'\nGenerated {len(results)} golden files.')


if __name__ == '__main__':
    main()
