"""Tests for scripts/automation/schema.py."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from automation.schema import load_registry


def test_load_registry_valid(tmp_path):
    reg = tmp_path / "registry.json"
    data = {"schema_version": 1, "skills": []}
    reg.write_text(json.dumps(data))
    result = load_registry(reg)
    assert result == data


def test_load_registry_invalid_json(tmp_path):
    reg = tmp_path / "registry.json"
    reg.write_text("not json {{{")
    with pytest.raises(ValueError, match="Invalid JSON"):
        load_registry(reg)


def test_load_registry_wrong_schema_version(tmp_path):
    reg = tmp_path / "registry.json"
    reg.write_text(json.dumps({"schema_version": 99}))
    with pytest.raises(ValueError, match="Unsupported schema_version"):
        load_registry(reg)
