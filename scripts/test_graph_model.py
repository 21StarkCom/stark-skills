"""Tests for graph Pydantic models."""
import pytest
from pydantic import ValidationError

from graph.model import Node, Edge, Graph, ValidationReport, DiffReport, Parser


# ── Helpers ──────────────────────────────────────────────────────────────


def _node(
    id: str = "mod_a",
    layer: str = "module",
    file_path: str = "src/a.py",
    line: int = 1,
    **kw: object,
) -> Node:
    return Node(id=id, layer=layer, file_path=file_path, line=line, **kw)  # type: ignore[arg-type]


def _edge(
    source: str = "mod_a",
    target: str = "mod_b",
    type: str = "imports",
    origin: str = "ast",
) -> Edge:
    return Edge(source=source, target=target, type=type, origin=origin)  # type: ignore[arg-type]


def _graph(
    schema_version: str = "1.0",
    repo: str = "myrepo",
    nodes: list = [],
    edges: list = [],
    **kw: object,
) -> Graph:
    return Graph(schema_version=schema_version, repo=repo, nodes=nodes, edges=edges, **kw)  # type: ignore[arg-type]


# ── TestNode ─────────────────────────────────────────────────────────────


class TestNode:
    def test_required_fields(self):
        node = _node()
        assert node.id == "mod_a"
        assert node.layer == "module"
        assert node.file_path == "src/a.py"
        assert node.line == 1

    def test_optional_defaults(self):
        node = _node()
        assert node.parent is None
        assert node.depends == []
        assert node.publishes == []
        assert node.called_by == []

    def test_layer_module(self):
        node = _node(layer="module")
        assert node.layer == "module"

    def test_layer_class(self):
        node = _node(layer="class")
        assert node.layer == "class"

    def test_layer_invalid(self):
        with pytest.raises(ValidationError):
            _node(layer="function")

    def test_extra_field_rejected(self):
        with pytest.raises(ValidationError):
            _node(unknown_extra_field="boom")


# ── TestEdge ─────────────────────────────────────────────────────────────


class TestEdge:
    def test_required_fields(self):
        edge = _edge()
        assert edge.source == "mod_a"
        assert edge.target == "mod_b"
        assert edge.type == "imports"
        assert edge.origin == "ast"

    def test_origin_ast(self):
        edge = _edge(origin="ast")
        assert edge.origin == "ast"

    def test_origin_docstring(self):
        edge = _edge(origin="docstring")
        assert edge.origin == "docstring"

    def test_origin_invalid(self):
        with pytest.raises(ValidationError):
            _edge(origin="manual")

    def test_type_is_open(self):
        """type field accepts any string value."""
        for t in ("imports", "calls", "custom_type", "inherits"):
            edge = _edge(type=t)
            assert edge.type == t


# ── TestGraph ────────────────────────────────────────────────────────────


class TestGraph:
    def test_valid_schema_version(self):
        g = _graph(schema_version="1.0")
        assert g.schema_version == "1.0"

    def test_rejects_unknown_version(self):
        with pytest.raises((ValidationError, ValueError), match="schema_version"):
            _graph(schema_version="2.0")

    def test_rejects_version_100(self):
        with pytest.raises((ValidationError, ValueError)):
            _graph(schema_version="100")

    def test_defaults(self):
        g = _graph()
        assert g.partial is False
        assert g.skipped_files == []

    def test_json_roundtrip(self):
        node = _node()
        edge = _edge()
        g = _graph(nodes=[node], edges=[edge])
        serialized = g.model_dump_json()
        parsed = Graph.model_validate_json(serialized)
        assert parsed == g
        assert len(parsed.nodes) == 1
        assert len(parsed.edges) == 1


# ── TestValidationReport ─────────────────────────────────────────────────


class TestValidationReport:
    def test_required_fields(self):
        report = ValidationReport(graph_repo="myrepo")
        assert report.graph_repo == "myrepo"

    def test_defaults(self):
        report = ValidationReport(graph_repo="myrepo")
        assert report.errors == []
        assert report.warnings == []
        assert report.dismissed == []
        assert report.node_count == 0
        assert report.edge_count == 0

    def test_dismissed_tracking(self):
        report = ValidationReport(graph_repo="myrepo", dismissed=["issue-1", "issue-2"])
        assert "issue-1" in report.dismissed
        assert "issue-2" in report.dismissed
        assert len(report.dismissed) == 2


# ── TestDiffReport ───────────────────────────────────────────────────────


class TestDiffReport:
    def test_required_fields(self):
        diff = DiffReport(base_ref="main", head_ref="feature-branch")
        assert diff.base_ref == "main"
        assert diff.head_ref == "feature-branch"

    def test_defaults(self):
        diff = DiffReport(base_ref="main", head_ref="feature-branch")
        assert diff.added_nodes == []
        assert diff.removed_nodes == []
        assert diff.added_edges == []
        assert diff.removed_edges == []
        assert diff.blast_radius == []


# ── TestParserProtocol ───────────────────────────────────────────────────


class TestParserProtocol:
    def test_protocol_conformance(self):
        class MyParser:
            def parse(self, *_: object) -> Graph:
                return _graph()

            def language(self) -> str:
                return "python"

            def file_patterns(self) -> list[str]:
                return ["*.py"]

        p = MyParser()
        assert isinstance(p, Parser)

    def test_protocol_nonconformance(self):
        class BadParser:
            def parse(self, *_: object) -> None:
                pass
            # missing language() and file_patterns()

        b = BadParser()
        assert not isinstance(b, Parser)
