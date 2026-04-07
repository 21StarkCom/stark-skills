"""Unit tests for the Python AST parser (Task #281).

One test per fixture file + large-file and encoding tests.
Fixtures live in tests/fixtures/graph/ relative to the worktree root.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from graph.python_parser import PythonParser, _run_worker, _WORKER_SCRIPT
from graph.model import Graph

# ── Fixture paths ──────────────────────────────────────────────────────────

FIXTURES = Path(__file__).parent.parent / "tests" / "fixtures" / "graph"
REPO = "testrepo"
REPO_ROOT = str(FIXTURES)


def _parse_one(filename: str) -> dict:
    """Run parse_worker.py on a single fixture file, return result dict."""
    filepath = str(FIXTURES / filename)
    _, result = _run_worker((_WORKER_SCRIPT, filepath, REPO, REPO_ROOT))
    return result


def _parse_dir(path: Path) -> Graph:
    """Parse a directory using PythonParser."""
    parser = PythonParser(max_workers=1)
    return parser.parse([path], REPO)


# ── Test: valid_module.py ─────────────────────────────────────────────────


class TestValidModule:
    def test_not_skipped(self):
        result = _parse_one("valid_module.py")
        assert result["skipped"] is False
        assert result["suppressed"] is False

    def test_module_node_id_format(self):
        result = _parse_one("valid_module.py")
        nodes = result["nodes"]
        assert any(n["id"] == f"{REPO}:valid_module.py" for n in nodes), (
            f"Module node not found in {[n['id'] for n in nodes]}"
        )

    def test_module_layer(self):
        result = _parse_one("valid_module.py")
        module_nodes = [n for n in result["nodes"] if n["layer"] == "module"]
        assert len(module_nodes) == 1

    def test_import_edges(self):
        result = _parse_one("valid_module.py")
        import_targets = {e["target"] for e in result["edges"] if e["type"] == "imports"}
        assert "os" in import_targets
        assert "re" in import_targets

    def test_import_edges_origin_ast(self):
        result = _parse_one("valid_module.py")
        import_edges = [e for e in result["edges"] if e["type"] == "imports"]
        assert all(e["origin"] == "ast" for e in import_edges)

    def test_docstring_depends_field(self):
        result = _parse_one("valid_module.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert "os.path" in module_node["depends"]
        assert "re" in module_node["depends"]

    def test_depends_edges_origin_docstring(self):
        result = _parse_one("valid_module.py")
        dep_edges = [e for e in result["edges"] if e["type"] == "depends"]
        assert all(e["origin"] == "docstring" for e in dep_edges)

    def test_module_has_docstring(self):
        result = _parse_one("valid_module.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert module_node["has_docstring"] is True


# ── Test: class_with_docstring.py ─────────────────────────────────────────


class TestClassWithDocstring:
    def test_class_node_id_format(self):
        result = _parse_one("class_with_docstring.py")
        node_ids = {n["id"] for n in result["nodes"]}
        expected = f"{REPO}:class_with_docstring.py:MyService"
        assert expected in node_ids, f"Expected {expected!r} in {node_ids}"

    def test_class_layer(self):
        result = _parse_one("class_with_docstring.py")
        class_nodes = [n for n in result["nodes"] if n["layer"] == "class"]
        assert len(class_nodes) >= 1

    def test_class_parent_is_module(self):
        result = _parse_one("class_with_docstring.py")
        service_node = next(
            n for n in result["nodes"]
            if n["id"].endswith(":MyService")
        )
        assert service_node["parent"] == f"{REPO}:class_with_docstring.py"

    def test_class_depends_from_docstring(self):
        result = _parse_one("class_with_docstring.py")
        service_node = next(
            n for n in result["nodes"] if n["id"].endswith(":MyService")
        )
        assert "json" in service_node["depends"]
        assert "pathlib.Path" in service_node["depends"]

    def test_class_publishes_from_docstring(self):
        result = _parse_one("class_with_docstring.py")
        service_node = next(
            n for n in result["nodes"] if n["id"].endswith(":MyService")
        )
        assert "MyService.result" in service_node["publishes"]

    def test_class_called_by_from_docstring(self):
        result = _parse_one("class_with_docstring.py")
        service_node = next(
            n for n in result["nodes"] if n["id"].endswith(":MyService")
        )
        assert "some.caller" in service_node["called_by"]

    def test_inherits_edge(self):
        result = _parse_one("class_with_docstring.py")
        inherits = [e for e in result["edges"] if e["type"] == "inherits"]
        assert any(e["target"] == "Path" for e in inherits)

    def test_nested_class_qualname(self):
        result = _parse_one("class_with_docstring.py")
        node_ids = {n["id"] for n in result["nodes"]}
        expected = f"{REPO}:class_with_docstring.py:NestedOuter.NestedInner"
        assert expected in node_ids, f"Expected {expected!r} in {node_ids}"

    def test_class_has_docstring(self):
        result = _parse_one("class_with_docstring.py")
        service_node = next(
            n for n in result["nodes"] if n["id"].endswith(":MyService")
        )
        assert service_node["has_docstring"] is True

    def test_graph_is_valid_pydantic(self):
        graph = _parse_dir(FIXTURES)
        assert isinstance(graph, Graph)
        assert graph.schema_version == "1.0"


# ── Test: class_without_docstring.py ─────────────────────────────────────


class TestClassWithoutDocstring:
    def test_class_node_exists(self):
        result = _parse_one("class_without_docstring.py")
        node_ids = {n["id"] for n in result["nodes"]}
        expected = f"{REPO}:class_without_docstring.py:NoDoc"
        assert expected in node_ids

    def test_class_no_docstring(self):
        result = _parse_one("class_without_docstring.py")
        no_doc_node = next(
            n for n in result["nodes"] if n["id"].endswith(":NoDoc")
        )
        assert no_doc_node["has_docstring"] is False

    def test_class_empty_metadata(self):
        result = _parse_one("class_without_docstring.py")
        no_doc_node = next(
            n for n in result["nodes"] if n["id"].endswith(":NoDoc")
        )
        assert no_doc_node["depends"] == []
        assert no_doc_node["publishes"] == []
        assert no_doc_node["called_by"] == []


# ── Test: syntax_error.py ─────────────────────────────────────────────────


class TestSyntaxError:
    def test_file_is_skipped(self):
        result = _parse_one("syntax_error.py")
        assert result["skipped"] is True

    def test_skip_reason(self):
        result = _parse_one("syntax_error.py")
        assert result["reason"] == "syntax_error"

    def test_no_nodes(self):
        result = _parse_one("syntax_error.py")
        assert result["nodes"] == []

    def test_recorded_in_skipped_files(self):
        """When parsing via PythonParser, syntax error file lands in skipped_files."""
        parser = PythonParser(max_workers=1)
        graph = parser.parse([FIXTURES], REPO)
        syntax_file = str(FIXTURES / "syntax_error.py")
        assert any(syntax_file in s for s in graph.skipped_files)


# ── Test: empty.py ────────────────────────────────────────────────────────


class TestEmptyFile:
    def test_not_skipped(self):
        result = _parse_one("empty.py")
        assert result["skipped"] is False

    def test_has_module_node(self):
        result = _parse_one("empty.py")
        module_nodes = [n for n in result["nodes"] if n["layer"] == "module"]
        assert len(module_nodes) == 1

    def test_module_id_correct(self):
        result = _parse_one("empty.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert module_node["id"] == f"{REPO}:empty.py"

    def test_no_docstring(self):
        result = _parse_one("empty.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert module_node["has_docstring"] is False


# ── Test: __init__.py ─────────────────────────────────────────────────────


class TestInitPy:
    def test_not_skipped(self):
        result = _parse_one("__init__.py")
        assert result["skipped"] is False

    def test_has_module_node(self):
        result = _parse_one("__init__.py")
        module_nodes = [n for n in result["nodes"] if n["layer"] == "module"]
        assert len(module_nodes) == 1

    def test_module_id_includes_init(self):
        result = _parse_one("__init__.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert "__init__.py" in module_node["id"]

    def test_has_docstring(self):
        result = _parse_one("__init__.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert module_node["has_docstring"] is True


# ── Test: large file (>500 KB) ────────────────────────────────────────────


class TestLargeFile:
    def test_large_file_skipped(self):
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w") as f:
            # Write ~600 KB of content
            f.write("# padding\n" * 65000)
            large_path = f.name
        try:
            _, result = _run_worker((_WORKER_SCRIPT, large_path, REPO, str(Path(large_path).parent)))
            assert result["skipped"] is True
            assert result["reason"] == "too_large"
        finally:
            Path(large_path).unlink(missing_ok=True)

    def test_large_file_in_skipped_files_list(self):
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w") as f:
            f.write("x = 1\n" * 100000)
            large_path = f.name
        try:
            parser = PythonParser(max_workers=1)
            graph = parser.parse([Path(large_path)], REPO)
            assert large_path in graph.skipped_files
        finally:
            Path(large_path).unlink(missing_ok=True)


# ── Test: encoding issue ──────────────────────────────────────────────────


class TestEncodingIssue:
    def test_file_with_bad_encoding_not_skipped(self):
        """Files with invalid UTF-8 bytes are read with errors='replace' and parsed."""
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="wb") as f:
            # Write valid Python with embedded non-UTF-8 bytes in a comment
            content = b"# comment with bad bytes: \xff\xfe\n\nclass Foo:\n    pass\n"
            f.write(content)
            bad_path = f.name
        try:
            _, result = _run_worker(
                (_WORKER_SCRIPT, bad_path, REPO, str(Path(bad_path).parent))
            )
            # Should not be skipped (errors='replace' handles encoding)
            assert result["skipped"] is False
            assert any(n["layer"] == "module" for n in result["nodes"])
        finally:
            Path(bad_path).unlink(missing_ok=True)


# ── Test: suppressed node ─────────────────────────────────────────────────


class TestSuppressedFile:
    def test_suppressed_file_not_skipped(self):
        result = _parse_one("suppressed.py")
        assert result["skipped"] is False

    def test_suppressed_file_is_suppressed(self):
        result = _parse_one("suppressed.py")
        assert result["suppressed"] is True

    def test_suppressed_file_has_no_nodes(self):
        result = _parse_one("suppressed.py")
        assert result["nodes"] == []

    def test_suppressed_file_not_in_graph(self):
        parser = PythonParser(max_workers=1)
        graph = parser.parse([FIXTURES], REPO)
        node_ids = {n.id for n in graph.nodes}
        assert not any("suppressed" in nid and "ShouldNotAppear" in nid for nid in node_ids)

    def test_suppressed_not_in_skipped_files(self):
        """Suppressed files are silently dropped, not added to skipped_files."""
        parser = PythonParser(max_workers=1)
        graph = parser.parse([FIXTURES], REPO)
        assert not any("suppressed.py" in s for s in graph.skipped_files)


# ── Test: invalid metadata grammar ───────────────────────────────────────


class TestInvalidMetadata:
    def test_valid_value_accepted(self):
        result = _parse_one("invalid_metadata.py")
        class_node = next(
            n for n in result["nodes"] if n["id"].endswith(":HasInvalidMetadata")
        )
        assert "valid.dep" in class_node["depends"]

    def test_invalid_values_rejected(self):
        """Values with spaces or special chars are rejected."""
        result = _parse_one("invalid_metadata.py")
        class_node = next(
            n for n in result["nodes"] if n["id"].endswith(":HasInvalidMetadata")
        )
        # "invalid dep with spaces" and "another-bad!val" must not appear
        depends_str = " ".join(class_node["depends"])
        assert "invalid dep with spaces" not in depends_str
        assert "another-bad!val" not in depends_str

    def test_warnings_emitted_for_rejected(self):
        result = _parse_one("invalid_metadata.py")
        assert len(result["warnings"]) >= 2

    def test_warning_is_valid_json(self):
        result = _parse_one("invalid_metadata.py")
        for w in result["warnings"]:
            parsed = json.loads(w)
            assert "msg" in parsed
            assert "level" in parsed

    def test_warning_mentions_rejected_value(self):
        result = _parse_one("invalid_metadata.py")
        all_msgs = " ".join(w for w in result["warnings"])
        assert "invalid dep with spaces" in all_msgs or "another-bad" in all_msgs


# ── Test: node ID format ──────────────────────────────────────────────────


class TestNodeIdFormat:
    def test_module_id_is_repo_colon_path(self):
        result = _parse_one("valid_module.py")
        module_node = next(n for n in result["nodes"] if n["layer"] == "module")
        assert module_node["id"].startswith(f"{REPO}:")
        assert module_node["id"].endswith(".py")

    def test_class_id_has_three_parts(self):
        result = _parse_one("class_with_docstring.py")
        class_nodes = [n for n in result["nodes"] if n["layer"] == "class"]
        for n in class_nodes:
            # format: {repo}:{path}:{qualname}
            parts = n["id"].split(":")
            assert len(parts) >= 3, f"Class node ID {n['id']!r} has fewer than 3 colon-parts"

    def test_graph_node_ids_valid_after_pydantic(self):
        graph = _parse_dir(FIXTURES)
        for node in graph.nodes:
            assert node.id  # non-empty
            assert ":" in node.id


# ── Test: PythonParser protocol conformance ───────────────────────────────


class TestParserProtocol:
    def test_language(self):
        parser = PythonParser()
        assert parser.language() == "python"

    def test_file_patterns(self):
        parser = PythonParser()
        patterns = parser.file_patterns()
        assert "*.py" in patterns

    def test_implements_parser_protocol(self):
        from graph.model import Parser
        assert isinstance(PythonParser(), Parser)

    def test_parse_returns_graph(self):
        parser = PythonParser()
        graph = parser.parse([FIXTURES], REPO)
        assert isinstance(graph, Graph)

    def test_parse_graph_schema_version(self):
        parser = PythonParser()
        graph = parser.parse([FIXTURES], REPO)
        assert graph.schema_version == "1.0"

    def test_parse_graph_repo_name(self):
        parser = PythonParser()
        graph = parser.parse([FIXTURES], REPO)
        assert graph.repo == REPO

    def test_audit_data_populated(self):
        parser = PythonParser()
        parser.parse([FIXTURES], REPO)
        assert len(parser.audit_data) > 0
        assert all(isinstance(v, bool) for v in parser.audit_data.values())
