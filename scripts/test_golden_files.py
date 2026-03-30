"""Golden-file regression tests for flow extraction + layout.

Regenerates flow diagrams for representative skills and compares against
committed snapshots in tests/golden/. Fails if extraction or layout has
drifted from the recorded golden files.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from generate_golden_files import GOLDEN_DIR, GOLDEN_SKILLS, generate_one

SCRIPTS_DIR = Path(__file__).resolve().parent
HAS_NODE = shutil.which('node') is not None
HAS_DAGRE = (SCRIPTS_DIR / 'node_modules' / 'dagre').exists()


@pytest.mark.skipif(not HAS_NODE or not HAS_DAGRE, reason='node and scripts/node_modules/dagre are required')
@pytest.mark.parametrize('skill_name', GOLDEN_SKILLS)
def test_golden_file_matches(skill_name: str) -> None:
    golden_path = GOLDEN_DIR / f'{skill_name}.flow.json'
    assert golden_path.exists(), f'Golden file missing: {golden_path}. Run: python3 generate_golden_files.py'

    expected = json.loads(golden_path.read_text(encoding='utf-8'))
    actual = generate_one(skill_name)

    assert actual is not None, f'Failed to generate flow for {skill_name}'
    assert actual == expected, (
        f'Golden file mismatch for {skill_name}. '
        f'Run: python3 generate_golden_files.py to update.'
    )


@pytest.mark.skipif(not HAS_NODE or not HAS_DAGRE, reason='node and scripts/node_modules/dagre are required')
def test_all_golden_files_exist() -> None:
    """Every skill in GOLDEN_SKILLS should have a committed golden file."""
    missing = [
        name for name in GOLDEN_SKILLS
        if not (GOLDEN_DIR / f'{name}.flow.json').exists()
    ]
    assert not missing, f'Missing golden files: {missing}. Run: python3 generate_golden_files.py'
