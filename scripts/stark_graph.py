#!/usr/bin/env python3
"""stark-graph — code graph pipeline orchestrator."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Make the graph package importable regardless of cwd
sys.path.insert(0, str(Path(__file__).parent))


# ── Helpers ──────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stark-graph",
        description="Code graph pipeline orchestrator.",
    )
    parser.add_argument(
        "--repo",
        type=str,
        default=None,
        help="Path to repo root (default: current directory).",
    )
    parser.add_argument(
        "--repo-name",
        type=str,
        default=None,
        help="Logical name for the repo (default: basename of repo).",
    )
    parser.add_argument(
        "--stage",
        choices=["parse", "validate", "diff", "audit"],
        default="parse",
        help="Pipeline stage to run (default: parse).",
    )
    parser.add_argument(
        "--pr",
        type=str,
        default=None,
        help='PR number or "auto" for CI detection.',
    )
    parser.add_argument(
        "--base",
        type=str,
        default=None,
        help="Base branch/commit for diff.",
    )
    parser.add_argument(
        "--warn",
        action="store_true",
        help="Emit warnings only (no error exit).",
    )
    parser.add_argument(
        "--include",
        action="append",
        dest="include",
        metavar="PATTERN",
        help="File glob patterns to include (repeatable).",
    )
    parser.add_argument(
        "--input",
        type=str,
        default=None,
        help="Path to input graph JSON file.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Path to write output JSON.",
    )
    parser.add_argument(
        "--workdir",
        type=str,
        default=None,
        help="Override working directory for temp files.",
    )
    return parser


def _slugify(value: str) -> str:
    """Slugify a string for use as a directory name.

    Steps:
    1. Replace any character not in [a-zA-Z0-9_-] with '-'.
    2. Collapse consecutive dashes into a single '-'.
    3. Strip leading/trailing '-'.
    4. Truncate to 80 characters.
    """
    slug = re.sub(r"[^a-zA-Z0-9_-]", "-", value)
    slug = re.sub(r"-{2,}", "-", slug)
    slug = slug.strip("-")
    return slug[:80]


def _validate_base(base: str) -> None:
    """Validate the --base value; exit(2) with JSON error on failure."""
    if not re.match(r"^[a-zA-Z0-9_./:-]+$", base):
        print(
            json.dumps({"error": "invalid --base value", "value": base}),
            file=sys.stderr,
        )
        sys.exit(2)


def _compute_workdir(args: argparse.Namespace, repo_root: str) -> str:
    """Compute and path-guard the working directory.

    If --workdir is explicitly given, use it directly (after realpath guard).
    Otherwise derive from --pr or current git branch.
    """
    if args.workdir:
        workdir = os.path.realpath(args.workdir)
    else:
        # Determine slug base
        if args.pr:
            slug_base = args.pr
        else:
            # Fall back to current git branch name
            result = subprocess.run(
                ["git", "-C", repo_root, "rev-parse", "--abbrev-ref", "--", "HEAD"],
                capture_output=True,
                text=True,
            )
            slug_base = result.stdout.strip() if result.returncode == 0 else "local"
            if not slug_base or slug_base == "HEAD":
                slug_base = "local"

        slug = _slugify(slug_base)
        workdir = os.path.realpath(
            os.path.join(repo_root, ".stark-graph", slug)
        )

    # Path traversal guard
    real_repo_root = os.path.realpath(repo_root)
    if not workdir.startswith(real_repo_root + os.sep) and workdir != real_repo_root:
        print(
            json.dumps(
                {
                    "error": "workdir escapes repo root",
                    "workdir": workdir,
                    "repo_root": real_repo_root,
                }
            ),
            file=sys.stderr,
        )
        sys.exit(2)

    return workdir


def _resolve_base_sha(pr: str, base: str, repo_root: str) -> str | None:
    """Resolve base branch/ref to a commit SHA.

    In CI (CI env var set): use git merge-base HEAD <base>.
    Locally: use gh pr view to get the base branch name, then git rev-parse.
    """
    if os.environ.get("CI"):
        result = subprocess.run(
            ["git", "-C", repo_root, "merge-base", "--", "HEAD", base],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
        return None
    else:
        # Local: resolve via gh pr view
        try:
            gh_result = subprocess.run(
                ["gh", "pr", "view", pr, "--json", "baseRefName", "-q", ".baseRefName"],
                capture_output=True,
                text=True,
                cwd=repo_root,
                timeout=10,
            )
        except subprocess.TimeoutExpired:
            gh_result = None
        branch = (gh_result.stdout.strip() if gh_result and gh_result.returncode == 0 else base)
        if not branch:
            branch = base

        rev_result = subprocess.run(
            ["git", "-C", repo_root, "rev-parse", "--", branch],
            capture_output=True,
            text=True,
        )
        if rev_result.returncode == 0:
            return rev_result.stdout.strip() or None
        return None


def _cleanup_old_worktrees(repo_root: str) -> None:
    """Remove .stark-graph/*/worktrees/ dirs older than 24 hours and prune."""
    stark_graph_dir = os.path.join(repo_root, ".stark-graph")
    if not os.path.isdir(stark_graph_dir):
        return
    cutoff = time.time() - 86400  # 24 hours
    for entry in os.scandir(stark_graph_dir):
        if not entry.is_dir():
            continue
        worktrees_dir = os.path.join(entry.path, "worktrees")
        if os.path.isdir(worktrees_dir):
            if os.path.getmtime(worktrees_dir) < cutoff:
                shutil.rmtree(worktrees_dir, ignore_errors=True)
    subprocess.run(
        ["git", "-C", repo_root, "worktree", "prune"],
        capture_output=True,
    )


# ── Stage handlers ────────────────────────────────────────────────────────


def _load_config() -> dict:
    """Load global/config.json from the stark-skills repo root."""
    config_path = Path(__file__).parent.parent / "global" / "config.json"
    try:
        return json.loads(config_path.read_text())
    except Exception:
        return {}


def _stage_parse(
    args: argparse.Namespace,
    repo_root: str,
    repo_name: str,
    workdir: str,
) -> None:
    """Run the parse stage: walk *.py files and emit graph JSON."""
    from graph.python_parser import PythonParser

    config = _load_config()
    max_workers = config.get("graph_max_parse_workers", 1)

    parser = PythonParser(max_workers=max_workers)

    # Honour --include patterns or fall back to full repo root
    if args.include:
        paths = []
        for pattern in args.include:
            paths.extend(Path(repo_root).glob(pattern))
    else:
        paths = [Path(repo_root)]

    graph = parser.parse(paths, repo_name)

    os.makedirs(workdir, exist_ok=True)
    graph_path = os.path.join(workdir, "graph.json")
    graph_json = graph.model_dump_json(indent=2)

    # Always write graph to workdir
    Path(graph_path).write_text(graph_json)

    # If --output, also write there
    if args.output:
        Path(args.output).write_text(graph_json)

    # Print status JSON to stdout (graph is in graph_path)
    status = {
        "stage": "parse",
        "repo": repo_name,
        "workdir": workdir,
        "graph": graph_path,
        "node_count": len(graph.nodes),
        "edge_count": len(graph.edges),
        "skipped_files": len(graph.skipped_files),
    }
    print(json.dumps(status, indent=2))


def _stage_audit(
    args: argparse.Namespace,
    repo_root: str,
    repo_name: str,
    workdir: str,
) -> None:
    """Run audit stage: parse + non-blocking docstring coverage report.

    Reports NO_DOCSTRING findings and coverage percentage.
    Always exits 0.
    """
    from graph.python_parser import PythonParser

    config = _load_config()
    max_workers = config.get("graph_max_parse_workers", 1)

    parser = PythonParser(max_workers=max_workers)

    if args.include:
        paths = []
        for pattern in args.include:
            paths.extend(Path(repo_root).glob(pattern))
    else:
        paths = [Path(repo_root)]

    graph = parser.parse(paths, repo_name)
    audit_data = parser.audit_data  # node_id -> has_docstring

    total = len(graph.nodes)
    missing: list[dict] = []
    for node in graph.nodes:
        has_doc = audit_data.get(node.id, False)
        if not has_doc:
            missing.append({"node_id": node.id, "finding": "NO_DOCSTRING"})

    covered = total - len(missing)
    coverage_pct = round((covered / total * 100) if total else 0.0, 1)

    # Machine-readable JSON report
    report = {
        "repo": repo_name,
        "total_nodes": total,
        "nodes_with_docstring": covered,
        "coverage_pct": coverage_pct,
        "findings": missing,
    }

    os.makedirs(workdir, exist_ok=True)
    report_path = os.path.join(workdir, "audit_report.json")
    Path(report_path).write_text(json.dumps(report, indent=2))

    # Human-readable output
    print(f"stark-graph audit — {repo_name}")
    print(f"  Nodes:     {total}")
    print(f"  Coverage:  {coverage_pct}% ({covered}/{total} have docstrings)")
    if missing:
        print(f"  Missing ({len(missing)}):")
        for item in missing[:50]:  # cap display at 50
            print(f"    NO_DOCSTRING  {item['node_id']}")
        if len(missing) > 50:
            print(f"    ... and {len(missing) - 50} more")
    else:
        print("  All nodes have docstrings.")
    print(f"\n  Report written to: {report_path}")

    # Always exit 0
    sys.exit(0)


# ── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    repo_root = os.path.realpath(args.repo or os.getcwd())

    # Startup sweep
    _cleanup_old_worktrees(repo_root)

    # Validate --base
    if args.base:
        _validate_base(args.base)

    # Compute and guard workdir
    workdir = _compute_workdir(args, repo_root)

    # Resolve base SHA for --pr mode
    base_sha = None
    if args.pr and args.base:
        base_sha = _resolve_base_sha(args.pr, args.base, repo_root)

    repo_name = args.repo_name or os.path.basename(repo_root)

    if args.stage == "parse":
        _stage_parse(args, repo_root, repo_name, workdir)
    elif args.stage == "audit":
        _stage_audit(args, repo_root, repo_name, workdir)
    else:
        # validate / diff — not yet implemented; emit status stub
        result = {
            "stage": args.stage,
            "repo": repo_name,
            "workdir": workdir,
            "base_sha": base_sha,
        }
        if args.output:
            with open(args.output, "w") as f:
                json.dump(result, f, indent=2)
        else:
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
