#!/usr/bin/env python3
"""Per-file parse worker for stark-graph.

Standalone script — no imports from the graph package.

Usage:
    python parse_worker.py <filepath> <repo_name> <repo_root>

Stdout: JSON dict with keys:
    nodes     list[dict]  — raw node dicts (includes has_docstring)
    edges     list[dict]  — raw edge dicts
    skipped   bool        — True if file was skipped (too large, syntax error, etc.)
    reason    str         — skip reason ("too_large", "syntax_error", "io_error")
    suppressed bool       — True if file had # stark-graph: ignore suppression
    warnings  list[str]   — JSON-encoded warning strings
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

MAX_FILE_SIZE = 500 * 1024  # 500 KB
SUPPRESS_COMMENT = "# stark-graph: ignore"
METADATA_PATTERN = re.compile(r"^[a-zA-Z0-9_.]+$")


# ── Helpers ───────────────────────────────────────────────────────────────


def _get_name(node: ast.expr) -> str | None:
    """Resolve a dotted name from an AST expression."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        value = _get_name(node.value)  # type: ignore[arg-type]
        if value:
            return f"{value}.{node.attr}"
    return None


def _parse_docstring_metadata(
    docstring: str | None,
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Parse Depends:, Publishes:, Called by: fields from a docstring.

    Returns:
        (depends, publishes, called_by, warnings)
        Values failing [a-zA-Z0-9_.]+ grammar are rejected with a warning.
    """
    depends: list[str] = []
    publishes: list[str] = []
    called_by: list[str] = []
    warnings: list[str] = []

    if not docstring:
        return depends, publishes, called_by, warnings

    patterns = [
        ("depends", re.compile(r"^\s*depends\s*:\s*(.+)$", re.I | re.M)),
        ("publishes", re.compile(r"^\s*publishes\s*:\s*(.+)$", re.I | re.M)),
        ("called_by", re.compile(r"^\s*called\s+by\s*:\s*(.+)$", re.I | re.M)),
    ]
    for field, pat in patterns:
        for m in pat.finditer(docstring):
            for raw in m.group(1).split(","):
                val = raw.strip()
                if not val:
                    continue
                if not METADATA_PATTERN.match(val):
                    warnings.append(
                        json.dumps(
                            {
                                "level": "warning",
                                "msg": f"Invalid metadata value {val!r} in {field!r} field (rejected)",
                            }
                        )
                    )
                    continue
                if field == "depends":
                    depends.append(val)
                elif field == "publishes":
                    publishes.append(val)
                else:
                    called_by.append(val)

    return depends, publishes, called_by, warnings


# ── AST Visitor ───────────────────────────────────────────────────────────


class _Visitor(ast.NodeVisitor):
    """Walks one module's AST, collecting nodes and edges."""

    def __init__(self, module_id: str, rel_path: str) -> None:
        self._module_id = module_id
        self._rel_path = rel_path
        self._class_stack: list[str] = []
        self.nodes: list[dict] = []
        self.edges: list[dict] = []
        self.warnings: list[str] = []

    def _current_source_id(self) -> str:
        """ID of the current class scope, or module if at top level."""
        if self._class_stack:
            qualname = ".".join(self._class_stack)
            return f"{self._module_id}:{qualname}"
        return self._module_id

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            self.edges.append(
                {
                    "source": self._module_id,
                    "target": alias.name,
                    "type": "imports",
                    "origin": "ast",
                }
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        if node.module:
            self.edges.append(
                {
                    "source": self._module_id,
                    "target": node.module,
                    "type": "imports",
                    "origin": "ast",
                }
            )

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        self._class_stack.append(node.name)
        qualname = ".".join(self._class_stack)
        class_id = f"{self._module_id}:{qualname}"

        doc = ast.get_docstring(node)
        dep, pub, cb, warns = _parse_docstring_metadata(doc)
        self.warnings.extend(warns)

        self.nodes.append(
            {
                "id": class_id,
                "layer": "class",
                "parent": self._module_id,
                "depends": dep,
                "publishes": pub,
                "called_by": cb,
                "file_path": self._rel_path,
                "line": node.lineno,
                "has_docstring": doc is not None,
            }
        )

        # depends edges from class docstring
        for d in dep:
            self.edges.append(
                {
                    "source": class_id,
                    "target": d,
                    "type": "depends",
                    "origin": "docstring",
                }
            )

        # inherits edges from base classes
        for base in node.bases:
            name = _get_name(base)  # type: ignore[arg-type]
            if name:
                self.edges.append(
                    {
                        "source": class_id,
                        "target": name,
                        "type": "inherits",
                        "origin": "ast",
                    }
                )

        self.generic_visit(node)
        self._class_stack.pop()


# ── Entry point ───────────────────────────────────────────────────────────


def parse_file(filepath: str, repo: str, repo_root: str) -> dict:
    """Parse a single Python file and return a result dict."""
    path = Path(filepath)

    # Size check
    try:
        size = path.stat().st_size
    except OSError:
        return {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": "io_error",
            "suppressed": False,
            "warnings": [],
        }

    if size > MAX_FILE_SIZE:
        return {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": "too_large",
            "suppressed": False,
            "warnings": [],
        }

    # Read source
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": "io_error",
            "suppressed": False,
            "warnings": [],
        }

    # Check suppression in first 5 lines
    for line in source.splitlines()[:5]:
        if SUPPRESS_COMMENT in line:
            return {
                "nodes": [],
                "edges": [],
                "skipped": False,
                "reason": "",
                "suppressed": True,
                "warnings": [],
            }

    # Parse AST
    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError:
        return {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": "syntax_error",
            "suppressed": False,
            "warnings": [],
        }

    # Compute relative path
    try:
        rel_path = str(path.relative_to(Path(repo_root)))
    except ValueError:
        rel_path = path.name

    module_id = f"{repo}:{rel_path}"

    # Module-level docstring metadata
    module_doc = ast.get_docstring(tree)
    mod_dep, mod_pub, mod_cb, mod_warns = _parse_docstring_metadata(module_doc)

    module_node: dict = {
        "id": module_id,
        "layer": "module",
        "parent": None,
        "depends": mod_dep,
        "publishes": mod_pub,
        "called_by": mod_cb,
        "file_path": rel_path,
        "line": 1,
        "has_docstring": module_doc is not None,
    }

    edges: list[dict] = []
    # depends edges from module docstring
    for d in mod_dep:
        edges.append(
            {
                "source": module_id,
                "target": d,
                "type": "depends",
                "origin": "docstring",
            }
        )

    # Walk AST for imports and classes
    visitor = _Visitor(module_id, rel_path)
    visitor.visit(tree)

    return {
        "nodes": [module_node] + visitor.nodes,
        "edges": edges + visitor.edges,
        "skipped": False,
        "reason": "",
        "suppressed": False,
        "warnings": mod_warns + visitor.warnings,
    }


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(
            json.dumps(
                {
                    "error": "Usage: parse_worker.py <filepath> <repo_name> <repo_root>"
                }
            ),
            file=sys.stderr,
        )
        sys.exit(1)

    _filepath, _repo, _repo_root = sys.argv[1], sys.argv[2], sys.argv[3]
    _result = parse_file(_filepath, _repo, _repo_root)

    # Log warnings to stderr as JSON lines
    for _w in _result.get("warnings", []):
        print(_w, file=sys.stderr)

    print(json.dumps(_result))
