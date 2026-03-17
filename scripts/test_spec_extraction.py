import os
import tempfile
import pytest
from multi_review import extract_spec_link, resolve_spec_content

# --- extract_spec_link tests ---

def test_extract_spec_link_with_path():
    body = "## Spec: docs/specs/2026-03-17-my-feature.md"
    assert extract_spec_link(body) == "docs/specs/2026-03-17-my-feature.md"

def test_extract_spec_link_na():
    body = "## Spec: N/A"
    assert extract_spec_link(body) == "N/A"

def test_extract_spec_link_missing():
    body = "Some PR description without spec field"
    assert extract_spec_link(body) is None

def test_extract_spec_link_empty():
    body = "## Spec: "
    assert extract_spec_link(body) is None

def test_extract_spec_link_url():
    body = "## Spec: https://github.com/GetEvinced/repo/blob/main/docs/specs/feature.md"
    link = extract_spec_link(body)
    assert link == "https://github.com/GetEvinced/repo/blob/main/docs/specs/feature.md"

def test_extract_spec_link_none_body():
    assert extract_spec_link(None) is None

def test_extract_spec_link_html_comment():
    body = "## Spec: <!-- link to docs/specs/ or N/A -->"
    assert extract_spec_link(body) is None

# --- resolve_spec_content tests ---

def test_resolve_spec_content_na():
    assert resolve_spec_content("N/A", "/tmp") is None

def test_resolve_spec_content_url():
    assert resolve_spec_content("https://example.com/spec.md", "/tmp") is None

def test_resolve_spec_content_reads_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        spec_path = os.path.join(tmpdir, "docs", "specs")
        os.makedirs(spec_path)
        spec_file = os.path.join(spec_path, "test-spec.md")
        with open(spec_file, "w") as f:
            f.write("# Test Spec\nGoals: do the thing")
        result = resolve_spec_content("docs/specs/test-spec.md", tmpdir)
        assert result == "# Test Spec\nGoals: do the thing"

def test_resolve_spec_content_missing_file():
    assert resolve_spec_content("docs/specs/nonexistent.md", "/tmp") is None
