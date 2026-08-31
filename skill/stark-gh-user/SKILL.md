---
name: stark-gh-user
disable-model-invocation: true
description: >-
  Switch the active GitHub user identity (primary ↔ secondary) for `gh`
  invocations to dodge per-user GraphQL/REST rate limits. Tokens live in macOS
  Keychain (service `stark-gh-token`).
argument-hint: "[show|primary|secondary|swap|limits] [--kind fine|classic|auto]"
revision: 63e888043556dafb1b0c7e9743f127ae4a257c6f
revision_date: 2026-05-18T18:34:12Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-gh-user

Toggle the GitHub user identity used by `gh` so rate-limited GraphQL/REST traffic can flow under a relief account when `aryeh-stark`'s hourly bucket runs dry.

- **primary** → `aryeh-stark` — **THE identity.** Matches `gh`'s own keyring login. Everything authors as this unless Aryeh says otherwise.
- **secondary** → a relief account, provisioned deliberately (`aryeh-evinced` and `aryeh-admin` both still exist and either can serve).

**This skill is human-only, by design.** `disable-model-invocation: true` in the frontmatter means no model can select it — a swap happens because Aryeh typed `/stark-gh-user`, never because an agent decided to. Nothing in the repo calls `tools/user_token.ts` automatically, and nothing should: a token left in `GH_TOKEN` re-authors every later `gh` call in that shell. When you're done with a relief window, revert (see Reverting below).

Bot calls (App installation tokens minted by `tools/github_app.ts`) are unaffected — they get their own pool per app, and their only sanctioned use is posting multi-LLM review findings.

**No tokens are provisioned yet:** all four `stark-gh-token` Keychain entries are absent, so every subcommand that resolves a token fails until they're seeded. `limits`/`show` will report that rather than a number. Seed `primary-*` from `aryeh-stark` first:

```bash
security add-generic-password -U -s stark-gh-token -a primary-fine -w   # paste the aryeh-stark PAT
```

## Arguments

**Raw input:** `$ARGUMENTS`

- `/stark-gh-user` or `/stark-gh-user show` — show active user + remaining rate limits
- `/stark-gh-user primary` — print export lines for the primary identity
- `/stark-gh-user secondary` — print export lines for the secondary identity
- `/stark-gh-user swap` — flip whichever is currently active
- `/stark-gh-user limits` — show rate limits for both identities side-by-side
- `--kind fine|classic|auto` — token kind (default: auto = fine-grained, fall back to classic)

The token-printing modes do not mutate the user's shell. They emit `export …` lines the user is expected to wrap in `eval "$(…)"` to apply.

## Resolver

The single source of truth is `tools/user_token.ts` (installed at `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/user_token.ts`). It reads from macOS Keychain entries:

- `stark-gh-token / primary-fine`
- `stark-gh-token / primary-classic`
- `stark-gh-token / secondary-fine`
- `stark-gh-token / secondary-classic`

`STARK_GH_USER` env var (`primary` | `secondary`) and `STARK_GH_TOKEN_KIND` (`fine` | `classic` | `auto`) are honored when no flag is passed.

## Behavior

Resolve the script path (worktree-relative `tools/user_token.ts`, falling back to `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/user_token.ts`).

Parse `$ARGUMENTS` into a subcommand and optional `--kind` flag. Default subcommand: `show`.

### `show`

1. Read `$STARK_GH_USER` (default `primary`).
2. Run `node --no-warnings <script> --user <active>` to confirm a token is reachable. If it raises, surface the keychain account name that's missing.
3. Spawn `gh api rate_limit --jq '.resources | {core, graphql}'` with `GH_TOKEN` set to that token.
4. Print: active user, login (`gh api user --jq .login`), core remaining/limit, graphql remaining/limit.

### `primary` / `secondary`

1. Resolve token via `node --no-warnings <script> --user <name> --kind <kind>`.
2. Print three lines exactly (no markdown, no commentary), so the user can `eval` them:
   ```
   export STARK_GH_USER=<name>
   export GH_TOKEN=<token>
   export GITHUB_TOKEN=<token>
   ```
3. After the block, print a one-line hint: `# eval "$(claude /stark-gh-user <name>)" to apply` — but only if the user invoked via Claude Code where slash output is not auto-evaluated. If you can't tell, omit the hint.

### `swap`

Run `node --no-warnings <script> --swap` (forwarding `--kind` if provided). Pass through stdout verbatim. The script already emits the three export lines plus a `#` comment indicating the direction of the swap.

### `limits`

For each of `primary`, `secondary`:
1. Resolve the token (auto kind).
2. Spawn `gh api rate_limit` with that token. Capture core + graphql remaining.

Render a compact two-row table:

```
identity   core         graphql      login
primary    4982 / 5000  4998 / 5000  aryeh-stark
secondary  5000 / 5000  5000 / 5000  <relief account>
```

Show the login each token actually resolves to (`gh api user`), never the login this doc predicts — the whole point of the table is catching a token that belongs to someone you didn't expect.

If a keychain entry is missing, render `MISSING` in place of the numbers and continue with the other identity.

## Output rules

- For `primary` / `secondary` / `swap`: print **only** the export lines (and the trailing `#` comment if any). No prose. The user is going to `eval "$(…)"`.
- For `show` / `limits`: human-readable, single short paragraph or a compact table. No emoji unless the user asked for it.
- Never echo the token value in `show` / `limits` output. Truncate to first 12 chars + `…` if you must reference it.

## Failure modes

- **Keychain entry missing:** tell the user which entry (`stark-gh-token / <account>`) and the `security add-generic-password -U -s stark-gh-token -a <account> -w '<token>'` command to add it.
- **`gh` not installed:** report and stop; don't try to test rate limits.
- **`security` not available (non-macOS):** surface and stop. This skill is macOS-only by design.

## Notes

- `gh` honors `GH_TOKEN` over the keychain auth, so once the user `eval`s the export block, every subsequent `gh` call in that shell — including ones spawned by `stark_review.ts` and the TS tools in `tools/` (including `github_projects.ts`) — uses the chosen identity automatically. No call-site edits.
- `tools/runtime_env_lib.ts` overrides `GH_TOKEN` for review subprocesses with the matching App installation token, so review-posting still goes through the correct bot.

## Reverting — do this when the relief window is over

```bash
unset GH_TOKEN GITHUB_TOKEN STARK_GH_USER   # back to gh's own keyring (aryeh-stark)
gh api user --jq .login                     # confirm: expect aryeh-stark
```

**Why it matters:** that blanket override is the whole mechanism *and* the whole hazard. A `secondary` token left in `GH_TOKEN` silently authors every later PR, comment, review-reply and merge in that shell as the relief account — with nothing in the output saying so. The rule is that Aryeh's GitHub activity reads as `aryeh-stark`; a forgotten `eval` breaks it quietly. So: swap for the rate-limited command, revert immediately after, and confirm the login rather than assuming.

A swap is scoped to the one shell that `eval`'d it — it does not follow into other terminals or other Claude Code sessions. It DOES follow into subprocesses that shell spawns.

## How It Works

Run `~/.claude/skills/stark-gh-user/handler.sh` with the subcommand as an argument. The handler resolves the script path, parses arguments, and delegates to `user_token.ts` or runs `gh api` calls.

```bash
#!/bin/bash
set -euo pipefail

# Resolve script path: worktree-relative or global fallback
SCRIPT=""
if [[ -f "tools/user_token.ts" ]]; then
  SCRIPT="tools/user_token.ts"
elif [[ -f "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/user_token.ts" ]]; then
  SCRIPT="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/user_token.ts"
else
  echo "Error: user_token.ts not found" >&2
  exit 1
fi

run_token() { node --no-warnings "$SCRIPT" "$@"; }

# Parse arguments: extract subcommand and --kind flag
SUBCOMMAND="show"
KIND=""
for arg in $ARGUMENTS; do
  if [[ "$arg" == "--kind" ]]; then
    # Next arg is the kind value, handled below
    continue
  elif [[ "$arg" == fine || "$arg" == classic || "$arg" == auto ]]; then
    # Preceding arg was --kind, this is the value
    KIND="--kind $arg"
  elif [[ "$arg" == show || "$arg" == primary || "$arg" == secondary || "$arg" == swap || "$arg" == limits ]]; then
    SUBCOMMAND="$arg"
  fi
done

# Execute subcommand
case "$SUBCOMMAND" in
  primary|secondary)
    # Print export lines for eval
    run_token --user "$SUBCOMMAND" $KIND
    ;;
  swap)
    # Print export + direction comment
    run_token --swap $KIND
    ;;
  show)
    # Show active user + rate limits
    ACTIVE_USER="${STARK_GH_USER:-primary}"
    TOKEN=$(run_token --user "$ACTIVE_USER" 2>/dev/null) || {
      echo "Error: No token for '$ACTIVE_USER'. Add it to keychain: security add-generic-password -U -s stark-gh-token -a $ACTIVE_USER-fine -w '<token>'" >&2
      exit 1
    }
    LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
    LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit) core, \(.graphql.remaining)/\(.graphql.limit) graphql"' 2>/dev/null) || LIMITS="(unable to fetch)"
    echo "Active: $ACTIVE_USER ($LOGIN) — $LIMITS"
    ;;
  limits)
    # Show both identities side-by-side
    echo "identity   core         graphql      login"
    for user in primary secondary; do
      TOKEN=$(run_token --user "$user" 2>/dev/null) || {
        echo "$user      MISSING      MISSING      MISSING"
        continue
      }
      LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit),\(.graphql.remaining)/\(.graphql.limit)"' 2>/dev/null) || {
        echo "$user      MISSING      MISSING      MISSING"
        continue
      }
      CORE=$(echo "$LIMITS" | cut -d, -f1)
      GRAPHQL=$(echo "$LIMITS" | cut -d, -f2)
      LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
      printf "%-10s %-12s %-12s %s\n" "$user" "$CORE" "$GRAPHQL" "$LOGIN"
    done
    ;;
  *)
    echo "Error: unknown subcommand '$SUBCOMMAND'" >&2
    exit 1
    ;;
esac
```
