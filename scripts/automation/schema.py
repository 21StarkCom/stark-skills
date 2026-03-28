"""Registry schema loading and validation."""

from __future__ import annotations

import json
from pathlib import Path


def load_registry(registry_path: Path) -> dict:
    """Load and validate registry.json. Raises ValueError on problems."""
    try:
        data = json.loads(registry_path.read_text())
    except (json.JSONDecodeError, Exception) as exc:
        raise ValueError(f"Invalid JSON in {registry_path}: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"Registry must be a JSON object, got {type(data).__name__}")

    if data.get("schema_version") != 1:
        raise ValueError(
            f"Unsupported schema_version: {data.get('schema_version')} (expected 1)"
        )

    return data
