#!/usr/bin/env python3
"""Generate skill documentation with multi-LLM visualization competition.

Parses SKILL.md frontmatter, dispatches 3 LLMs to generate HTML visualizations,
has Claude judge the screenshots, and assembles markdown docs with Mermaid
diagrams and embedded PNGs.

Usage:
    generate_skill_docs.py                          # all skills
    generate_skill_docs.py --skill stark-review     # one skill
    generate_skill_docs.py --check                  # staleness check
    generate_skill_docs.py --no-screenshots         # skip PNG generation
    generate_skill_docs.py --no-evaluation          # skip judge, use first valid
    generate_skill_docs.py --markdown-only          # skip LLM, regen markdown
    generate_skill_docs.py --dry-run                # show what would change
    generate_skill_docs.py --force                  # regenerate even if clean
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / "skill"
DEFAULT_OUT = ROOT / "docs" / "skills"
SCRIPTS_DIR = Path(__file__).parent

SCRIPT_VERSION = "1.0.0"
MAX_WORKERS = 6

AGENTS = {
    "claude": {"emoji": "\U0001f9e0", "label": "Claude"},
    "codex":  {"emoji": "\U0001f4bb", "label": "Codex"},
    "gemini": {"emoji": "\u2728",     "label": "Gemini"},
}


@dataclass
class SkillData:
    name: str
    description: str
    argument_hint: str
    complexity: str       # simple (<100 lines), medium (100-400), complex (>400)
    line_count: int
    raw_md: str

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def parse_skill_md(path: Path) -> SkillData:
    """Parse a SKILL.md file. Extracts frontmatter + raw text."""
    text = path.read_text()
    lines = text.splitlines()
    line_count = len(lines)

    # Parse YAML frontmatter between --- delimiters
    name = path.parent.name  # fallback
    description = ""
    argument_hint = ""
    fm_match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        m = re.search(r"^name:\s*(.+)", fm, re.MULTILINE)
        if m:
            name = m.group(1).strip()
        # description may span multiple lines (YAML folded scalar >)
        m = re.search(r"^description:\s*>\s*\n((?:\s+.+\n?)*)", fm, re.MULTILINE)
        if m:
            description = " ".join(m.group(1).split())
        else:
            m = re.search(r"^description:\s*(.+)", fm, re.MULTILINE)
            if m:
                description = m.group(1).strip()
        m = re.search(r"^argument-hint:\s*(.+)", fm, re.MULTILINE)
        if m:
            argument_hint = m.group(1).strip().strip('"')

    complexity = "simple" if line_count < 100 else "medium" if line_count <= 400 else "complex"

    return SkillData(
        name=name,
        description=description,
        argument_hint=argument_hint,
        complexity=complexity,
        line_count=line_count,
        raw_md=text,
    )


def discover_skills(skill_dir: Path, filter_name: str | None = None) -> list[Path]:
    """Find skill directories that contain SKILL.md. Returns list[Path] — use .name for string key."""
    skills = []
    for d in sorted(skill_dir.iterdir()):
        if not d.is_dir() or not (d / "SKILL.md").exists():
            continue
        if filter_name and d.name != filter_name:
            continue
        skills.append(d)
    return skills
