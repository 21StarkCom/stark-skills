"""Python AST parser for stark-graph.

Implements the Parser protocol from model.py. Dispatches per-file parsing
to parse_worker.py via subprocess (with 5-second timeout per file). For
repositories with >500 Python files, uses ProcessPoolExecutor for parallel
subprocess dispatch.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from .model import Edge, Graph, Node

SEQUENTIAL_THRESHOLD = 500  # switch to parallel above this many files
_WORKER_SCRIPT = str(Path(__file__).parent / "parse_worker.py")


# ── Worker function (top-level for picklability) ──────────────────────────


def _run_worker(args: tuple[str, str, str, str]) -> tuple[str, dict]:
    """Call parse_worker.py for a single file.

    Args:
        args: (worker_script_path, filepath, repo_name, repo_root)

    Returns:
        (filepath, result_dict)
    """
    import subprocess  # local import so workers don't need it at module load

    worker_script, filepath, repo, repo_root = args
    try:
        proc = subprocess.run(
            [sys.executable, worker_script, filepath, repo, repo_root],
            timeout=5,
            capture_output=True,
            text=True,
        )
        if proc.stderr.strip():
            # Forward worker warnings to our stderr
            print(proc.stderr, end="", file=sys.stderr)
        if not proc.stdout.strip():
            return filepath, {
                "nodes": [],
                "edges": [],
                "skipped": True,
                "reason": "empty_output",
                "suppressed": False,
                "warnings": [],
            }
        result = json.loads(proc.stdout)
    except subprocess.TimeoutExpired:
        print(
            json.dumps({"level": "warning", "msg": f"Parse timeout (>5s): {filepath}"}),
            file=sys.stderr,
        )
        result = {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": "timeout",
            "suppressed": False,
            "warnings": [],
        }
    except (json.JSONDecodeError, Exception) as exc:
        result = {
            "nodes": [],
            "edges": [],
            "skipped": True,
            "reason": f"worker_error: {exc}",
            "suppressed": False,
            "warnings": [],
        }
    return filepath, result


def _process_result(
    result: dict,
    filepath: str,
    nodes: list[Node],
    edges: list[Edge],
    skipped: list[str],
    audit_data: dict[str, bool],
) -> None:
    """Integrate a parse_worker result into the running accumulators."""
    if result.get("skipped"):
        skipped.append(filepath)
        return
    if result.get("suppressed"):
        return

    for raw_node in result.get("nodes", []):
        has_doc = raw_node.pop("has_docstring", False)
        node = Node(**raw_node)
        nodes.append(node)
        audit_data[node.id] = has_doc

    for raw_edge in result.get("edges", []):
        edges.append(Edge(**raw_edge))


# ── Parser ────────────────────────────────────────────────────────────────


class PythonParser:
    """Parser for Python source files. Implements the Parser protocol.

    After calling parse(), audit_data maps node_id -> has_docstring.
    """

    def __init__(self, max_workers: int = 1) -> None:
        self._max_workers = max(1, max_workers)
        self.audit_data: dict[str, bool] = {}

    # ── Protocol methods ──────────────────────────────────────────────────

    def language(self) -> str:
        return "python"

    def file_patterns(self) -> list[str]:
        return ["*.py"]

    def parse(self, paths: list[Path], repo: str) -> Graph:
        """Parse Python files under the given paths.

        Collects all *.py files, dispatches parse_worker.py per file with a
        5-second timeout, and assembles the results into a Graph.

        Side effect: populates self.audit_data (node_id -> has_docstring).
        """
        self.audit_data = {}

        repo_root = self._resolve_repo_root(paths)
        py_files = self._collect_py_files(paths)

        all_nodes: list[Node] = []
        all_edges: list[Edge] = []
        skipped_files: list[str] = []

        use_parallel = (
            len(py_files) > SEQUENTIAL_THRESHOLD and self._max_workers > 1
        )
        worker_args = [
            (_WORKER_SCRIPT, f, repo, repo_root) for f in py_files
        ]

        if use_parallel:
            with ProcessPoolExecutor(max_workers=self._max_workers) as executor:
                future_map = {
                    executor.submit(_run_worker, arg): arg[1]
                    for arg in worker_args
                }
                for future in as_completed(future_map):
                    filepath = future_map[future]
                    try:
                        _, result = future.result()
                    except Exception as exc:
                        print(
                            json.dumps(
                                {
                                    "level": "warning",
                                    "msg": f"Worker failed for {filepath}: {exc}",
                                }
                            ),
                            file=sys.stderr,
                        )
                        skipped_files.append(filepath)
                        continue
                    _process_result(
                        result, filepath, all_nodes, all_edges, skipped_files, self.audit_data
                    )
        else:
            for arg in worker_args:
                _, result = _run_worker(arg)
                _process_result(
                    result, arg[1], all_nodes, all_edges, skipped_files, self.audit_data
                )

        return Graph(
            schema_version="1.0",
            repo=repo,
            nodes=all_nodes,
            edges=all_edges,
            skipped_files=skipped_files,
        )

    # ── Internal helpers ──────────────────────────────────────────────────

    @staticmethod
    def _resolve_repo_root(paths: list[Path]) -> str:
        """Determine repo root from the list of paths."""
        if not paths:
            return str(Path.cwd())
        p = Path(paths[0])
        if p.is_dir():
            return str(p)
        # List of files: use parent of first path
        return str(p.parent)

    @staticmethod
    def _collect_py_files(paths: list[Path]) -> list[str]:
        """Gather all *.py file paths from the given paths list."""
        py_files: list[str] = []
        for path in paths:
            p = Path(path)
            if p.is_file() and p.suffix == ".py":
                py_files.append(str(p))
            elif p.is_dir():
                for f in sorted(p.rglob("*.py")):
                    py_files.append(str(f))
        return py_files
