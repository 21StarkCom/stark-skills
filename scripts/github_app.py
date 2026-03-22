#!/usr/bin/env python3
"""GitHub App authentication helper for Claude Code sessions.

Generates installation tokens from the GitHub App private key stored in
macOS Keychain, and provides convenience wrappers for common GitHub API
operations (PRs, reviews, issues, merges).

Auto-detects the current repo from `git remote -v` so it works in any
GetEvinced repo without configuration.

Usage as token provider (for gh CLI):
    export GH_TOKEN=$(python ~/git/Evinced/scripts/github_app.py token)
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
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import jwt
import requests

# ── Config ──────────────────────────────────────────────────────────────

APPS: dict[str, dict[str, str]] = {
    "stark-claude": {
        "app_id": "3066738",
        "installation_id": "115648521",
        "keychain_service": "STARK_CLAUDE_PRIVATE_KEY",
    },
    "stark-codex": {
        "app_id": "3066834",
        "installation_id": "115650994",
        "keychain_service": "STARK_CODEX_PRIVATE_KEY",
    },
    "stark-gemini": {
        "app_id": "3066689",
        "installation_id": "115648971",
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


def _app_config() -> dict[str, str]:
    return APPS[_active_app]


def select_app(name: str) -> None:
    """Set the active app. Raises KeyError if unknown."""
    global _active_app
    if name not in APPS:
        raise KeyError(f"Unknown app '{name}'. Available: {', '.join(APPS.keys())}")
    _active_app = name


# ── Token cache (file-based, per-app, survives across invocations within 1hr)

_CACHE_DIR = Path.home() / ".cache" / "github-app-tokens"


def _cache_file() -> Path:
    return _CACHE_DIR / f"{_active_app}.json"


def _read_cached_token() -> str | None:
    cf = _cache_file()
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


def _write_cached_token(token: str, expires_at: float) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cf = _cache_file()
    cf.write_text(json.dumps({"token": token, "expires_at": expires_at}))
    cf.chmod(0o600)


# ── Core auth ───────────────────────────────────────────────────────────


def _get_private_key() -> str:
    import base64

    cfg = _app_config()
    result = subprocess.run(
        ["security", "find-generic-password", "-s", cfg["keychain_service"], "-w"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Error reading Keychain ({cfg['keychain_service']}): {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return base64.b64decode(result.stdout.strip()).decode()


def _make_jwt(private_key: str) -> str:
    cfg = _app_config()
    now = int(time.time())
    return jwt.encode(
        {"iat": now - 60, "exp": now + 600, "iss": cfg["app_id"]},
        private_key,
        algorithm="RS256",
    )


def get_token(app: str | None = None) -> str:
    """Get a valid installation token (cached or fresh).

    If *app* is given, temporarily switch to that app for this call.
    """
    if app:
        prev = _active_app
        select_app(app)
        try:
            return get_token()
        finally:
            select_app(prev)

    cached = _read_cached_token()
    if cached:
        return cached

    cfg = _app_config()
    private_key = _get_private_key()
    encoded_jwt = _make_jwt(private_key)

    resp = requests.post(
        f"{API}/app/installations/{cfg['installation_id']}/access_tokens",
        headers={
            "Authorization": f"Bearer {encoded_jwt}",
            "Accept": "application/vnd.github+json",
        },
        timeout=10,
    )
    if resp.status_code != 201:
        print(f"Token exchange failed ({resp.status_code}): {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    token = data["token"]

    from datetime import datetime

    expires_str = data["expires_at"]  # e.g. "2026-03-04T06:13:16Z"
    expires_dt = datetime.fromisoformat(expires_str.replace("Z", "+00:00"))
    expires_at = expires_dt.timestamp()

    _write_cached_token(token, expires_at)
    return token


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {get_token()}",
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
    last_exc: Exception | None = None
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
        except requests.exceptions.ConnectionError as exc:
            last_exc = exc
            if attempt + 1 >= attempts:
                raise
    raise last_exc  # unreachable, but keeps type-checker happy


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


def issue_create(repo: str, *, title: str, body: str = "", labels: list[str] | None = None) -> dict:
    payload: dict[str, Any] = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
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
    pr_merge_p.add_argument("--squash", action="store_true", default=True)
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
        print(get_token())

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
