#!/usr/bin/env python3
"""Stamp `revision:` + `revision_date:` into SKILL.md frontmatter.

Used in two contexts:
- Bootstrap: ``stamp_skill_revision.py --all`` — re-stamp every stark-* skill.
- Pre-commit hook: ``stamp_skill_revision.py <path> [<path> ...]`` — stamp the
  specific SKILL.md files about to be committed.

Stamping semantics: ``revision`` is the full SHA of the commit currently at
HEAD (the commit being superseded by the upcoming edit), and ``revision_date``
is the current UTC time. After the new commit lands,
``git diff <revision> -- <path>`` shows what changed in this revision.

The script is idempotent: it strips any existing ``revision:`` /
``revision_date:`` lines from the frontmatter before re-inserting, so
re-running on the same file replaces values cleanly.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

REVISION_KEYS = ("revision", "revision_date")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n(.*)\Z", re.DOTALL)


def _git(*args: str, cwd: Path | None = None) -> str:
    out = subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        cwd=str(cwd) if cwd else None,
    )
    return out.stdout.strip() if out.returncode == 0 else ""


def repo_root() -> Path:
    root = _git("rev-parse", "--show-toplevel")
    if not root:
        raise SystemExit("not inside a git working tree")
    return Path(root)


def file_revision(path: Path, repo: Path) -> tuple[str, str]:
    """Return (sha, iso) of the most recent commit that touched ``path``.

    Used by ``--all`` bootstrap mode where stamping with the file's own last
    commit is more accurate than HEAD (HEAD may not have touched the file).
    Falls back to (HEAD, now) if the file has no history yet.
    """
    rel = str(path.relative_to(repo))
    log = _git("log", "-1", "--format=%H%x09%cI", "--", rel, cwd=repo)
    if log and "\t" in log:
        sha, iso = log.split("\t", 1)
        return sha, iso
    return head_revision(repo)


def head_revision(repo: Path) -> tuple[str, str]:
    """Return (HEAD SHA, current UTC ISO timestamp).

    Used by the pre-commit hook: stamps the predecessor commit's SHA into the
    file before this commit lands, so ``revision`` always identifies the
    superseded state.
    """
    sha = _git("rev-parse", "HEAD", cwd=repo) or "0" * 40
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return sha, iso


def _strip_revision(block: str) -> str:
    kept = [
        line for line in block.split("\n")
        if not any(line.startswith(f"{k}:") for k in REVISION_KEYS)
    ]
    while kept and kept[-1] == "":
        kept.pop()
    return "\n".join(kept)


def stamp_file(path: Path, sha: str, iso: str) -> bool:
    """Write revision/revision_date into ``path``'s frontmatter. Idempotent.

    Returns True if the file changed, False if already at the desired state.
    """
    text = path.read_text(encoding="utf-8")
    m = FRONTMATTER.match(text)
    if not m:
        print(f"  [skip] {path}: no YAML frontmatter", file=sys.stderr)
        return False
    block, rest = m.group(1), m.group(2)
    block = _strip_revision(block) + f"\nrevision: {sha}\nrevision_date: {iso}"
    new_text = f"---\n{block}\n---\n{rest}"
    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="SKILL.md paths to stamp")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Stamp every skill/stark-*/SKILL.md using each file's own last commit",
    )
    args = parser.parse_args()

    repo = repo_root()

    if args.all:
        if args.paths:
            parser.error("--all and explicit paths are mutually exclusive")
        targets = sorted((repo / "skill").glob("stark-*/SKILL.md"))
    else:
        if not args.paths:
            return 0  # no files staged → nothing to do
        targets = []
        for p in args.paths:
            path = Path(p)
            if not path.is_absolute():
                path = repo / path
            if path.name != "SKILL.md":
                continue
            if not path.is_file():
                continue
            targets.append(path)

    if not targets:
        return 0

    if args.all:
        resolve = lambda path: file_revision(path, repo)  # noqa: E731
    else:
        sha, iso = head_revision(repo)
        resolve = lambda _path: (sha, iso)  # noqa: E731

    changed = 0
    for path in targets:
        this_sha, this_iso = resolve(path)
        if stamp_file(path, this_sha, this_iso):
            changed += 1
            print(f"  stamped {path.relative_to(repo)} → {this_sha[:8]} @ {this_iso}", file=sys.stderr)

    print(f"stamp_skill_revision: {changed}/{len(targets)} updated", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
