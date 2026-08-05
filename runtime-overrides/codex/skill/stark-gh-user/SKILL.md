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

If the current user request includes a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-gh-user

Toggle the GitHub user identity used by `gh` so rate-limited GraphQL/REST traffic can flow under a relief account when `aryeh-stark`'s hourly bucket runs dry.

- **primary** → `aryeh-stark` — **THE identity.** Matches `gh`'s own keyring login. Everything authors as this unless Aryeh says otherwise.
- **secondary** → a relief account, provisioned deliberately (`aryeh-evinced` and `aryeh-admin` both still exist and either can serve).

**This skill is human-only, by design.** `disable-model-invocation: true` in the frontmatter means no model can select it — a swap happens only because Aryeh explicitly invoked `stark-gh-user`, never because an agent decided to. Nothing in the repo calls `tools/user_token.ts` automatically, and nothing should: a token left in `GH_TOKEN` re-authors every later `gh` call in that shell. When you're done with a relief window, revert (see Reverting below).

Bot calls (App installation tokens minted by `tools/github_app.ts`) are unaffected — they get their own pool per app, and their only sanctioned use is posting multi-LLM review findings.

**No tokens are provisioned yet** (checked 2026-08-04): all four `stark-gh-token` Keychain entries are absent, so every subcommand that resolves a token fails until they're seeded. `limits`/`show` will report that rather than a number. Seed `primary-*` from `aryeh-stark` first:

```bash
security add-generic-password -U -s stark-gh-token -a primary-fine -w   # paste the aryeh-stark PAT
```

## Arguments

- no input or `show` — show active user + remaining rate limits
- `primary` — print export lines for the primary identity
- `secondary` — print export lines for the secondary identity
- `swap` — flip whichever is currently active
- `limits` — show rate limits for both identities side-by-side
- `--kind fine|classic|auto` — token kind (default: auto = fine-grained, fall back to classic)

Read the subcommand and flags from the current user's explicit invocation. Do
not depend on a host-populated argument placeholder.

The activation modes do not mutate the user's shell. They emit deferred `export
…` lines that resolve the token from Keychain only when the user evaluates them
in their own shell. The handler must never print a PAT value into agent output.

## Resolver

The single source of truth is the bundle's `tools/user_token.ts`; the supporting
`scripts/handler.sh` resolves that tool from the active runtime's asset root. It
reads from macOS Keychain entries:

- `stark-gh-token / primary-fine`
- `stark-gh-token / primary-classic`
- `stark-gh-token / secondary-fine`
- `stark-gh-token / secondary-classic`

`STARK_GH_USER` env var (`primary` | `secondary`) and `STARK_GH_TOKEN_KIND` (`fine` | `classic` | `auto`) are honored when no flag is passed.

## Behavior

Resolve `scripts/handler.sh` relative to this `SKILL.md` and pass it the
subcommand and optional `--kind` flag as ordinary shell arguments. The handler
parses `"$@"` without word-splitting. Default subcommand: `show`.

### `show`

1. Read `$STARK_GH_USER` (default `primary`).
2. Run `node --experimental-strip-types --no-warnings <script> --user <active>` to confirm a token is reachable. If it raises, surface the keychain account name that's missing.
3. Spawn `gh api rate_limit --jq '.resources | {core, graphql}'` with `GH_TOKEN` set to that token.
4. Print: active user, login (`gh api user --jq .login`), core remaining/limit, graphql remaining/limit.

### `primary` / `secondary`

1. Resolve token via `node --experimental-strip-types --no-warnings <script> --user <name> --kind <kind>`.
2. Validate that the requested Keychain entry exists, discarding the resolved
   value rather than printing it.
3. Print one guarded deferred export block (no markdown or commentary), so the
   user can `eval` it without the PAT passing through the conversation. Identity
   markers are exported only after the deferred Keychain read succeeds:
   ```
   if GH_TOKEN="$(node .../user_token.ts --user <name> --kind <kind>)"; then
     export GH_TOKEN
     export GITHUB_TOKEN="$GH_TOKEN"
     export STARK_GH_USER=<name>
     export STARK_GH_TOKEN_KIND=<kind>
   else
     unset GH_TOKEN GITHUB_TOKEN
     false
   fi
   ```
4. Do not add host-specific invocation hints to the export block. Tell the user
   separately to evaluate the returned lines in the shell they want to change.

### `swap`

Reject `$STARK_GH_USER` unless it is exactly `primary` or `secondary`. Resolve
the opposite identity, validate its Keychain
entry without printing it, emit the same guarded deferred export block, then a `#`
comment indicating the direction of the swap.

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

- For `primary` / `secondary` / `swap`: print **only** deferred export lines
  (and the trailing `#` comment if any). Never interpolate the token value into
  stdout or stderr. The user is going to `eval "$(…)"` in a terminal.
- For `show` / `limits`: human-readable, single short paragraph or a compact table. No emoji unless the user asked for it.
- Never echo or truncate a token value in any mode. Refer only to the Keychain
  account name.

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

A swap is scoped to the one shell that `eval`'d it — it does not follow into
other terminals or other agent sessions. It DOES follow into subprocesses that
shell spawns.

## How It Works

Resolve `SKILL_DIR` to the directory containing this `SKILL.md`. Run the shipped
handler with `bash`, passing the invocation input as real arguments. Set the
asset root in the same call so both source checkouts and installed bundles can
locate `user_token.ts`:

```bash
SKILL_DIR=/absolute/path/to/stark-gh-user
ASSET_ROOT="${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}}"
STARK_ASSET_ROOT="$ASSET_ROOT" \
  bash "$SKILL_DIR/scripts/handler.sh" show
```

Replace `show` with the requested subcommand and pass `--kind` as two quoted
arguments, for example `secondary --kind classic`. For an activation mode,
the user applies the result in their terminal with `eval "$(...)"`; never eval it
inside an unrelated agent subprocess.
