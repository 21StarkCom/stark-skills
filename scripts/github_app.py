#!/usr/bin/env python3
"""GitHub App authentication helper for Claude Code sessions.

Generates installation tokens from the GitHub App private key stored in
macOS Keychain, and provides convenience wrappers for common GitHub API
operations (PRs, reviews, issues, merges).

Auto-detects the current repo from `git remote -v` so it works in any
GetEvinced repo without configuration.

Usage as token provider (for gh CLI):
    export GH_TOKEN=$(python ~/Code/scripts/github_app.py token)
    gh pr list

Usage as direct CLI:
    github-app pr list
    github-app pr view 46
    github-app pr review 46 --approve --body "LGTM"
    github-app pr merge 46 --squash
    github-app pr create --head my-branch --title "feat: X" --body "..."
    github-app issue list
    github-app issue create --title "Bug: X" --body "..."
    github-app repo info

Override repo auto-detection:
    github-app --repo GetEvinced/other-repo pr list
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import jwt
import requests

# ── Config ──────────────────────────────────────────────────────────────

APPS: dict[str, dict] = {
    "stark-claude": {
        "app_id": "3066738",
        "installation_id": "115648521",  # default (GetEvinced org)
        "installations": {
            "GetEvinced": "115648521",
        },
        "keychain_service": "STARK_CLAUDE_PRIVATE_KEY",
    },
    "stark-codex": {
        "app_id": "3066834",
        "installation_id": "115648800",  # default (GetEvinced org)
        "installations": {
            "GetEvinced": "115648800",
        },
        "keychain_service": "STARK_CODEX_PRIVATE_KEY",
    },
    "stark-gemini": {
        "app_id": "3066689",
        "installation_id": "115648971",  # default (GetEvinced org)
        "installations": {
            "GetEvinced": "115648971",
        },
        "keychain_service": "STARK_GEMINI_PRIVATE_KEY",
    },
}

# Legacy aliases kept for backwards compat with old keychain entry
APPS["default"] = APPS["stark-claude"]

DEFAULT_APP = "stark-codex"
API = "https://api.github.com"

# Module-level active app (set by CLI --app flag or select_app())
_active_app: str = DEFAULT_APP

# ── Repo detection ──────────────────────────────────────────────────────


def _detect_repo() -> str:
    """Detect GitHub org/repo from git remote origin in the current directory."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return ""
        url = result.stdout.strip()

        # SSH: git@github.com:GetEvinced/infra-pulse.git
        m = re.match(r"git@github\.com:(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)

        # HTTPS: https://github.com/GetEvinced/infra-pulse.git
        m = re.match(r"https://github\.com/(.+?)(?:\.git)?$", url)
        if m:
            return m.group(1)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return ""


# ── App selection ──────────────────────────────────────────────────────


def _resolve_app_name(app: str | None = None) -> str:
    name = app or _active_app
    if name not in APPS:
        raise KeyError(f"Unknown app '{name}'. Available: {', '.join(APPS.keys())}")
    return name


def _app_config(app: str | None = None) -> dict[str, str]:
    return APPS[_resolve_app_name(app)]


def select_app(name: str) -> None:
    """Set the active app. Raises KeyError if unknown."""
    global _active_app
    _active_app = _resolve_app_name(name)


# ── Token cache (file-based, per-app+installation, survives across invocations within 1hr)

_CACHE_DIR = Path.home() / ".cache" / "github-app-tokens"


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write JSON to *path* atomically with restricted permissions (0o600)."""
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.stem}-")
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def _cache_file(app: str | None = None, installation_id: str | None = None) -> Path:
    name = _resolve_app_name(app)
    if installation_id:
        return _CACHE_DIR / f"{name}-{installation_id}.json"
    return _CACHE_DIR / f"{name}.json"


def _read_cached_token(app: str | None = None, installation_id: str | None = None) -> str | None:
    cf = _cache_file(app, installation_id)
    if not cf.exists():
        return None
    try:
        data = json.loads(cf.read_text())
        # Expire 5 minutes early to avoid mid-request expiry
        if data.get("expires_at", 0) > time.time() + 300:
            return data["token"]
    except (json.JSONDecodeError, KeyError):
        pass
    return None


def _write_cached_token(
    token: str, expires_at: float, app: str | None = None, installation_id: str | None = None
) -> None:
    _atomic_write_json(_cache_file(app, installation_id), {"token": token, "expires_at": expires_at})


# ── Installation ID cache (per-app, 1-hour TTL, populated by API discovery)

def _install_cache_file(app_name: str) -> Path:
    return _CACHE_DIR / f"installations-{app_name}.json"


def _read_install_cache(app_name: str) -> dict[str, str]:
    cf = _install_cache_file(app_name)
    if not cf.exists():
        return {}
    try:
        data = json.loads(cf.read_text())
        if data.get("expires_at", 0) > time.time():
            return data.get("entries", {})
    except (json.JSONDecodeError, KeyError):
        pass
    return {}


def _write_install_cache(app_name: str, entries: dict[str, str]) -> None:
    _atomic_write_json(
        _install_cache_file(app_name),
        {"expires_at": time.time() + 3600, "entries": entries},
    )


# ── Core auth ───────────────────────────────────────────────────────────


class _KeychainError(Exception):
    """Raised when macOS Keychain auth is unavailable or fails."""


def _get_private_key(app: str | None = None) -> str:
    """Get private key from macOS Keychain.

    Raises _KeychainError if the key cannot be read (e.g. on Linux/CI,
    where the `security` binary is missing, or when the entry isn't in
    the keychain). Callers rely on this error type to fall through to
    env-var / GH_TOKEN auth — letting the raw FileNotFoundError escape
    breaks the multi-tier fallback in `get_token`.
    """
    import base64

    cfg = _app_config(app)
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", cfg["keychain_service"], "-w"],
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, OSError) as exc:
        # `security` only ships on macOS; on Linux runners the binary is
        # absent and subprocess.run raises before we ever see a returncode.
        raise _KeychainError(
            f"Keychain unavailable ({type(exc).__name__}): {exc}"
        ) from exc
    if result.returncode != 0:
        raise _KeychainError(
            f"Keychain read failed ({cfg['keychain_service']}): {result.stderr.strip()}"
        )
    return base64.b64decode(result.stdout.strip()).decode()


def _get_private_key_from_env() -> tuple[str, str, str]:
    """Get (private_key, app_id, installation_id) from CI env vars.

    Reads STARK_PRIVATE_KEY_B64, STARK_APP_ID, STARK_INSTALL_ID.
    Treats empty values as missing — GitHub Actions exposes unset secrets as
    empty strings, not as absent env vars, so a strict ``os.environ[...]``
    lookup would proceed with garbage and crash inside JWT signing instead of
    falling through to the GH_TOKEN fallback.

    Raises KeyError if any variable is missing or empty.
    """
    import base64

    key_b64 = os.environ.get("STARK_PRIVATE_KEY_B64") or ""
    app_id = os.environ.get("STARK_APP_ID") or ""
    install_id = os.environ.get("STARK_INSTALL_ID") or ""
    if not (key_b64 and app_id and install_id):
        raise KeyError("STARK_PRIVATE_KEY_B64, STARK_APP_ID, or STARK_INSTALL_ID is missing or empty")
    private_key = base64.b64decode(key_b64).decode()
    return private_key, app_id, install_id


def _make_jwt_raw(private_key: str, app_id: str) -> str:
    """Mint a GitHub App JWT from a raw private key and app ID."""
    now = int(time.time())
    return jwt.encode(
        {"iat": now - 60, "exp": now + 600, "iss": app_id},
        private_key,
        algorithm="RS256",
    )


def _make_jwt(private_key: str, app: str | None = None) -> str:
    cfg = _app_config(app)
    return _make_jwt_raw(private_key, cfg["app_id"])


def _mint_installation_token(
    private_key: str, app_id: str, installation_id: str
) -> tuple[str, float]:
    """Exchange a private key for a GitHub installation access token.

    Returns (token, expires_at_timestamp).
    Raises RuntimeError if the API call fails.
    """
    from datetime import datetime

    encoded_jwt = _make_jwt_raw(private_key, app_id)
    resp = requests.post(
        f"{API}/app/installations/{installation_id}/access_tokens",
        headers={
            "Authorization": f"Bearer {encoded_jwt}",
            "Accept": "application/vnd.github+json",
        },
        timeout=10,
    )
    if resp.status_code != 201:
        raise RuntimeError(f"Token exchange failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    expires_dt = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
    return data["token"], expires_dt.timestamp()


def get_installation_id(owner: str, app: str | None = None) -> str:
    """Resolve the installation ID for a given org/user owner.

    Resolution order:
    1. Hardcoded ``installations`` dict in the app config.
    2. File cache at ``~/.cache/github-app-installations-{app}.json`` (1-hour TTL).
    3. ``GET /app/installations`` API call (result is cached for 1 hour).

    Raises RuntimeError if the app is not installed for this owner.
    """
    app_name = _resolve_app_name(app)
    cfg = APPS[app_name]

    # 1. Hardcoded dict
    hardcoded: dict[str, str] = cfg.get("installations", {})
    if owner in hardcoded:
        return hardcoded[owner]

    # 2. File cache
    cached = _read_install_cache(app_name)
    if owner in cached:
        return cached[owner]

    # 3. API discovery via JWT (not an installation token)
    try:
        private_key = _get_private_key(app_name)
    except _KeychainError:
        try:
            private_key, _, _ = _get_private_key_from_env()
        except KeyError:
            raise RuntimeError(
                f"Cannot discover installations for {app_name!r}: "
                "Keychain unavailable and STARK_* env vars not set."
            )

    app_jwt = _make_jwt(private_key, app_name)
    resp = requests.get(
        f"{API}/app/installations",
        headers={
            "Authorization": f"Bearer {app_jwt}",
            "Accept": "application/vnd.github+json",
        },
        params={"per_page": 100},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Failed to list installations for {app_name!r} "
            f"({resp.status_code}): {resp.text}"
        )

    discovered: dict[str, str] = {
        inst["account"]["login"]: str(inst["id"])
        for inst in resp.json()
        if "account" in inst
    }

    # Merge discovered entries into cache (preserves entries from previous pages)
    merged = {**cached, **discovered}
    _write_install_cache(app_name, merged)

    if owner not in discovered:
        raise RuntimeError(
            f"GitHub App {app_name!r} is not installed on owner {owner!r}. "
            f"Known installations: {', '.join(discovered.keys()) or 'none'}."
        )
    return discovered[owner]


def get_token(app: str | None = None, *, owner: str | None = None) -> str:
    """Get a valid installation token (cached or fresh).

    Auth precedence:
      1. Cache (in-memory token not yet expired)
      2. GitHub App via macOS Keychain (local dev)
      3. GitHub App via env vars STARK_APP_ID / STARK_INSTALL_ID / STARK_PRIVATE_KEY_B64 (CI)
      4. GH_TOKEN env var fallback (emits a warning log)

    If *app* is given, resolve config, cache, and key material for that app
    without mutating the module-global active app.

    If *owner* is given (e.g. ``"MyOrg"``), resolve the installation ID for
    that org/user via :func:`get_installation_id` so that the returned token
    is valid for repos outside the default GetEvinced installation.
    """
    app_name = _resolve_app_name(app)
    cfg = _app_config(app_name)

    # Resolve installation ID — per-owner when possible, default otherwise.
    install_id = cfg["installation_id"]
    if owner:
        try:
            install_id = get_installation_id(owner, app_name)
        except RuntimeError as exc:
            logging.warning(
                "Could not resolve installation for owner %r (%s). "
                "Falling back to default installation.",
                owner,
                exc,
            )

    # 1. Cache (keyed on installation_id so different orgs don't share tokens)
    cached = _read_cached_token(app_name, install_id)
    if cached:
        return cached

    # 2. Keychain (macOS)
    try:
        private_key = _get_private_key(app_name)
        token, expires_at = _mint_installation_token(
            private_key, cfg["app_id"], install_id
        )
        _write_cached_token(token, expires_at, app_name, install_id)
        return token
    except _KeychainError:
        pass  # Not on macOS or key not installed; try env vars

    # 3. Env vars (CI / Linux)
    try:
        private_key, app_id, env_install_id = _get_private_key_from_env()
        # In CI, honour the per-owner install_id if we resolved one; otherwise
        # fall back to what the env vars specify.
        effective_install_id = install_id if owner else env_install_id
        token, expires_at = _mint_installation_token(private_key, app_id, effective_install_id)
        _write_cached_token(token, expires_at, app_name, effective_install_id)
        return token
    except KeyError:
        pass  # STARK_* env vars not set

    # 4. GH_TOKEN fallback
    gh_token = os.environ.get("GH_TOKEN")
    if gh_token:
        logging.warning(
            "github_app: using GH_TOKEN fallback (App auth unavailable — "
            "Keychain failed and STARK_* env vars are not set)"
        )
        return gh_token

    raise RuntimeError(
        "No GitHub auth available: Keychain read failed, STARK_* env vars not set, "
        "GH_TOKEN not set."
    )


def _headers(app: str | None = None) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {get_token(app=app)}",
        "Accept": "application/vnd.github+json",
    }


# ── API helpers ─────────────────────────────────────────────────────────


def api_get(path: str, params: dict | None = None) -> Any:
    r = requests.get(f"{API}{path}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path: str, body: dict | None = None) -> Any:
    r = requests.post(f"{API}{path}", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path: str, body: dict | None = None) -> Any:
    r = requests.put(f"{API}{path}", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def api_patch(path: str, body: dict | None = None) -> Any:
    r = requests.patch(f"{API}{path}", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def api_delete(path: str) -> int:
    r = requests.delete(f"{API}{path}", headers=_headers(), timeout=30)
    r.raise_for_status()
    return r.status_code


def graphql(query: str, *, variables: dict | None = None, retry: bool = True) -> Any:
    """Send a GraphQL query to the GitHub API.

    Posts to /graphql with the active app's token. Retries once on transient
    connection failures (disable with retry=False). Raises RuntimeError if the
    response contains GraphQL-level errors (fail-closed).
    """
    body: dict[str, Any] = {"query": query}
    if variables is not None:
        body["variables"] = variables

    attempts = 2 if retry else 1
    for attempt in range(attempts):
        try:
            r = requests.post(
                f"{API}/graphql",
                headers=_headers(),
                json=body,
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            if "errors" in data:
                msgs = "; ".join(e.get("message", str(e)) for e in data["errors"])
                raise RuntimeError(f"GraphQL errors: {msgs}")
            return data
        except requests.exceptions.ConnectionError:
            if attempt + 1 >= attempts:
                raise
    raise RuntimeError("GraphQL request failed after retries")


# ── High-level operations ───────────────────────────────────────────────
# All functions accept `repo` param (org/name) to stay independent of globals.


def pr_list(repo: str, state: str = "open") -> list[dict]:
    return api_get(f"/repos/{repo}/pulls", {"state": state, "per_page": 30})


def pr_view(repo: str, number: int) -> dict:
    return api_get(f"/repos/{repo}/pulls/{number}")


def pr_create(repo: str, *, head: str, title: str, body: str = "", base: str = "main", draft: bool = False) -> dict:
    return api_post(f"/repos/{repo}/pulls", {
        "head": head,
        "base": base,
        "title": title,
        "body": body,
        "draft": draft,
    })


def pr_review(repo: str, number: int, *, event: str = "APPROVE", body: str = "") -> dict:
    """Submit a PR review. event: APPROVE, REQUEST_CHANGES, COMMENT."""
    return api_post(f"/repos/{repo}/pulls/{number}/reviews", {
        "event": event,
        "body": body,
    })


def pr_merge(repo: str, number: int, *, method: str = "squash", commit_title: str = "") -> dict:
    payload: dict[str, Any] = {"merge_method": method}
    if commit_title:
        payload["commit_title"] = commit_title
    return api_put(f"/repos/{repo}/pulls/{number}/merge", payload)


def pr_comment(repo: str, number: int, body: str) -> dict:
    return api_post(f"/repos/{repo}/issues/{number}/comments", {"body": body})


def pr_update(repo: str, number: int, **fields: Any) -> dict:
    return api_patch(f"/repos/{repo}/pulls/{number}", fields)


def issue_list(repo: str, state: str = "open") -> list[dict]:
    items = api_get(f"/repos/{repo}/issues", {"state": state, "per_page": 30})
    return [i for i in items if "pull_request" not in i]


def issue_create(
    repo: str,
    *,
    title: str,
    body: str = "",
    labels: list[str] | None = None,
    issue_type: str | None = None,
) -> dict:
    """Create a GitHub issue.

    Args:
        issue_type: Built-in GitHub Issue Type name (Bug, Feature, Task).
                    This sets the native Type field, NOT a label.
    """
    payload: dict[str, Any] = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    if issue_type:
        payload["type"] = issue_type
    return api_post(f"/repos/{repo}/issues", payload)


def issue_comment(repo: str, number: int, body: str) -> dict:
    return api_post(f"/repos/{repo}/issues/{number}/comments", {"body": body})


def repo_info(repo: str) -> dict:
    return api_get(f"/repos/{repo}")


def branch_protection(repo: str, branch: str = "main") -> dict:
    return api_get(f"/repos/{repo}/branches/{branch}/protection")


# ── CLI ─────────────────────────────────────────────────────────────────


def _json_out(data: Any) -> None:
    print(json.dumps(data, indent=2))


def _resolve_repo(args: argparse.Namespace) -> str:
    """Get repo from --repo flag or auto-detect from git remote."""
    repo = getattr(args, "repo", None)
    if repo:
        return repo
    detected = _detect_repo()
    if not detected:
        print("Could not detect repo. Use --repo or run from inside a git repo.", file=sys.stderr)
        sys.exit(1)
    return detected


def main() -> None:
    parser = argparse.ArgumentParser(description="GitHub App helper")
    parser.add_argument("--repo", help="Override repo (org/name). Default: auto-detect from git remote.")
    parser.add_argument("--app", choices=list(APPS.keys()), default=DEFAULT_APP,
                        help=f"Which GitHub App to authenticate as (default: {DEFAULT_APP})")
    sub = parser.add_subparsers(dest="command")

    # token
    sub.add_parser("token", help="Print installation token (for GH_TOKEN)")

    # repo
    sub.add_parser("repo", help="Show repo info")

    # pr
    pr_parser = sub.add_parser("pr", help="Pull request operations")
    pr_sub = pr_parser.add_subparsers(dest="pr_action")

    pr_sub.add_parser("list", help="List open PRs")

    pr_view_p = pr_sub.add_parser("view", help="View PR details")
    pr_view_p.add_argument("number", type=int)

    pr_create_p = pr_sub.add_parser("create", help="Create PR")
    pr_create_p.add_argument("--head", required=True)
    pr_create_p.add_argument("--title", required=True)
    pr_create_p.add_argument("--body", default="")
    pr_create_p.add_argument("--base", default="main")
    pr_create_p.add_argument("--draft", action="store_true")

    pr_review_p = pr_sub.add_parser("review", help="Review PR")
    pr_review_p.add_argument("number", type=int)
    pr_review_p.add_argument("--approve", action="store_true")
    pr_review_p.add_argument("--request-changes", action="store_true")
    pr_review_p.add_argument("--comment", action="store_true")
    pr_review_p.add_argument("--body", default="")

    pr_merge_p = pr_sub.add_parser("merge", help="Merge PR")
    pr_merge_p.add_argument("number", type=int)
    pr_merge_p.add_argument("--squash", action="store_true")
    pr_merge_p.add_argument("--merge", action="store_true")
    pr_merge_p.add_argument("--rebase", action="store_true")
    pr_merge_p.add_argument("--title", default="")

    pr_comment_p = pr_sub.add_parser("comment", help="Comment on PR")
    pr_comment_p.add_argument("number", type=int)
    pr_comment_p.add_argument("--body", required=True)

    # issue
    issue_parser = sub.add_parser("issue", help="Issue operations")
    issue_sub = issue_parser.add_subparsers(dest="issue_action")

    issue_sub.add_parser("list", help="List open issues")

    issue_create_p = issue_sub.add_parser("create", help="Create issue")
    issue_create_p.add_argument("--title", required=True)
    issue_create_p.add_argument("--body", default="")
    issue_create_p.add_argument("--labels", nargs="*", default=[])

    args = parser.parse_args()
    select_app(args.app)

    if args.command == "token":
        # Extract owner from --repo flag or git remote so that per-org
        # installation routing kicks in automatically.
        repo_str = getattr(args, "repo", None) or _detect_repo()
        owner = repo_str.split("/")[0] if repo_str and "/" in repo_str else None
        print(get_token(owner=owner))

    elif args.command == "repo":
        repo = _resolve_repo(args)
        info = repo_info(repo)
        print(f"{info['full_name']} | default: {info['default_branch']} | private: {info['private']}")
        print(f"Open issues: {info['open_issues_count']}")

    elif args.command == "pr":
        repo = _resolve_repo(args)
        if args.pr_action == "list":
            for pr in pr_list(repo):
                print(f"  #{pr['number']}: {pr['title']} ({pr['user']['login']}) [{pr['head']['ref']}]")
        elif args.pr_action == "view":
            _json_out(pr_view(repo, args.number))
        elif args.pr_action == "create":
            result = pr_create(repo, head=args.head, title=args.title, body=args.body, base=args.base, draft=args.draft)
            print(f"Created PR #{result['number']}: {result['html_url']}")
        elif args.pr_action == "review":
            event = "APPROVE" if args.approve else "REQUEST_CHANGES" if args.request_changes else "COMMENT"
            result = pr_review(repo, args.number, event=event, body=args.body)
            print(f"Review submitted: {event}")
        elif args.pr_action == "merge":
            method = "rebase" if args.rebase else "merge" if args.merge else "squash"
            result = pr_merge(repo, args.number, method=method, commit_title=args.title)
            print(f"Merged PR #{args.number} via {method}")
        elif args.pr_action == "comment":
            pr_comment(repo, args.number, args.body)
            print(f"Commented on PR #{args.number}")
        else:
            pr_parser.print_help()

    elif args.command == "issue":
        repo = _resolve_repo(args)
        if args.issue_action == "list":
            for issue in issue_list(repo):
                labels = ", ".join(l["name"] for l in issue.get("labels", []))
                extra = f" [{labels}]" if labels else ""
                print(f"  #{issue['number']}: {issue['title']}{extra}")
        elif args.issue_action == "create":
            result = issue_create(repo, title=args.title, body=args.body, labels=args.labels)
            print(f"Created issue #{result['number']}: {result['html_url']}")
        else:
            issue_parser.print_help()

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
