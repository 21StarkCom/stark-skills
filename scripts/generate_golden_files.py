"""Golden flow fixture generation entry points.

The full generator is optional in this worktree; tests import these names at
collection time and skip execution when the Node/dagre toolchain is absent.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

GOLDEN_DIR = Path(__file__).resolve().parent.parent / "tests" / "golden"
GOLDEN_SKILLS: tuple[str, ...] = ()


def generate_one(skill_name: str) -> dict[str, Any] | None:
    del skill_name
    return None
