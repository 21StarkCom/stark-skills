#!/usr/bin/env python3
"""Resolve a GitHub PAT for the active user identity.

Two user identities are supported:
  - primary   → aryeh-evinced
  - secondary → aryeh-admin

Tokens are read from the macOS Keychain (service `stark-gh-token`, accounts
`{primary,secondary}-{fine,classic}`).

Selection precedence:
  1. --user CLI flag
  2. STARK_GH_USER env var ("primary" | "secondary")
  3. Default: "primary"

Token kind precedence (per identity):
  1. --kind CLI flag
  2. STARK_GH_TOKEN_KIND env var ("fine" | "classic" | "auto")
  3. Default: "auto" (fine-grained, fall back to classic)

Usage:
    export GH_TOKEN=$(python scripts/user_token.py)
    export GH_TOKEN=$(python scripts/user_token.py --user secondary)
    export GH_TOKEN=$(python scripts/user_token.py --user secondary --kind classic)
    eval "$(python scripts/user_token.py --swap)"

This intentionally only addresses *user-identity* gh calls. Bot calls keep using
GitHub App installation tokens minted by `github_app.py`.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import Literal

UserId = Literal["primary", "secondary"]
TokenKind = Literal["fine", "classic", "auto"]

KEYCHAIN_SERVICE = "stark-gh-token"


def _keychain_get(account: str) -> str | None:
    """Return a keychain secret, or None if not found."""
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            check=True, capture_output=True, text=True,
        )
    except subprocess.CalledProcessError:
        return None
    val = out.stdout.strip()
    return val or None


def get_user_token(user: UserId = "primary", kind: TokenKind = "auto") -> str:
    """Return a PAT for the requested identity and kind. Raises KeyError if absent."""
    fine = _keychain_get(f"{user}-fine")
    classic = _keychain_get(f"{user}-classic")

    if kind == "fine":
        if not fine:
            raise KeyError(f"keychain: {KEYCHAIN_SERVICE}/{user}-fine not found")
        return fine
    if kind == "classic":
        if not classic:
            raise KeyError(f"keychain: {KEYCHAIN_SERVICE}/{user}-classic not found")
        return classic
    # auto mode: secondary prefers classic because GetEvinced's fine-grained
    # PAT permission picker has no "Checks" entry (verified 2026-05-18 — no
    # items match "checks" even for org owners), so secondary-fine can't reach
    # the /check-runs API that `gh pr checks` needs. Primary is unaffected.
    if user == "secondary" and classic:
        return classic
    if fine:
        return fine
    if classic:
        return classic
    raise KeyError(
        f"keychain: neither {KEYCHAIN_SERVICE}/{user}-fine nor "
        f"{KEYCHAIN_SERVICE}/{user}-classic found"
    )


def _resolve_user(cli: str | None) -> UserId:
    val = (cli or os.environ.get("STARK_GH_USER") or "primary").lower()
    if val not in ("primary", "secondary"):
        raise SystemExit(f"invalid user: {val!r} (expected primary|secondary)")
    return val  # type: ignore[return-value]


def _resolve_kind(cli: str | None) -> TokenKind:
    val = (cli or os.environ.get("STARK_GH_TOKEN_KIND") or "auto").lower()
    if val not in ("fine", "classic", "auto"):
        raise SystemExit(f"invalid kind: {val!r} (expected fine|classic|auto)")
    return val  # type: ignore[return-value]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Print a GitHub PAT for the active user identity.")
    p.add_argument("--user", choices=["primary", "secondary"], default=None)
    p.add_argument("--kind", choices=["fine", "classic", "auto"], default=None)
    p.add_argument(
        "--swap",
        action="store_true",
        help="Print export lines that swap STARK_GH_USER (primary↔secondary)."
        " Use as: eval \"$(python scripts/user_token.py --swap)\"",
    )
    args = p.parse_args(argv)

    if args.swap:
        current = _resolve_user(None)
        new: UserId = "secondary" if current == "primary" else "primary"
        token = get_user_token(new, _resolve_kind(args.kind))
        print(f"export STARK_GH_USER={new}")
        print(f"export GH_TOKEN={token}")
        print(f"export GITHUB_TOKEN={token}")
        print(f"# swapped: {current} -> {new}", file=sys.stderr)
        return 0

    user = _resolve_user(args.user)
    kind = _resolve_kind(args.kind)
    print(get_user_token(user, kind))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
