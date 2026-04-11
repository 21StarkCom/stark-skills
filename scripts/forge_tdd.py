#!/usr/bin/env python3
"""TDD stub for stark-forge Phase 3 (available in v2)."""
from __future__ import annotations

import sys


def skip_tdd_phase() -> dict:
    """Skip the TDD spec phase. Returns completed status immediately."""
    print("Phase 3: TDD Spec — skipped (available in v2)", file=sys.stderr)
    return {"status": "completed", "skipped": True}
