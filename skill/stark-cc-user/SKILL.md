---
name: stark-cc-user
disable-model-invocation: true
description: >-
  Switch the active Claude Code account between stored profiles when a 5-hour
  or 7-day rate-limit window runs out. Credentials live in macOS Keychain
  (service `stark-cc-token`); headroom comes from statusline snapshots.
argument-hint: "[show|list|add <name>|use <name>|limits|next] [--apply]"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-cc-user

Toggle the Claude Code account so work can continue on a profile whose window
still has room. Sibling of `stark-gh-user`, but the mechanics differ — read
"Why this isn't just a token swap" before changing anything.

## Arguments

**Raw input:** `$ARGUMENTS`

- `/stark-cc-user` or `show` — active account + its headroom
- `/stark-cc-user list` — registered profiles (`*` marks the active one)
- `/stark-cc-user add <name>` — store the CURRENT login as profile `<name>`
- `/stark-cc-user use <name>` — switch to profile `<name>`
- `/stark-cc-user limits` — headroom for every profile, best target first
- `/stark-cc-user next [--apply]` — best target other than the active one

## Behavior

Resolve `tools/cc_account.ts` (worktree-relative, falling back to
`${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/cc_account.ts`) and run
it with the parsed subcommand:

```
node --experimental-strip-types --no-warnings <script> <subcommand> [args]
```

Pass stdout through verbatim. The tool is the single source of truth for
formatting; do not re-render its tables.

## Setup — one `add` per account, while logged in as it

There is no way to mint a profile for an account you are not currently
authenticated as. OAuth blobs cannot be synthesized, and `claude setup-token`
mints a token for the *current* login only. So bootstrapping is manual and
one-time per account:

```
claude /login          # log in as the account
/stark-cc-user add s1  # capture it
```

Repeat per account. `add` is also safe to re-run — it refreshes a stored
profile whose token has since rotated.

## Why this isn't just a token swap

`gh` needs one token in one env var. A Claude switch has **two halves**, and
writing only one leaves the machine incoherent:

| Half | Where | What breaks if skipped |
|---|---|---|
| OAuth blob | Keychain `genp`, service `Claude Code-credentials`, account `root` | CLI still authenticates as the old account |
| Identity metadata | `~/.claude.json` → `oauthAccount` | Statusline and every `oauthAccount` reader report the wrong account |

`use` writes both from one stored record, Keychain first (it is the half that
can fail on a locked keychain — if it throws, `~/.claude.json` is untouched and
the previous account stays coherent).

**Switching takes effect on the next `claude` launch.** Credentials are read
once at startup; a running session keeps the old account until restarted.

`use` also re-captures the OUTGOING account before overwriting it, so a token
refreshed during the session isn't lost.

## The identity key is the ORG, not the email

One address can hold seats in several orgs. `aryeh.kiovetsky@evinced.net` is
both a member of the **Evinced RD** team org and the owner of a **personal Max**
org — same address, same `accountUuid`, different `organizationUuid`, and
entirely independent rate-limit budgets.

So `oauthAccount.organizationUuid` is what identifies a profile: it keys the
registry, the snapshot filename, ranking joins, and the active-profile marker.
Email is display only. `list` and `next` print the org name so two profiles
sharing an address stay distinguishable.

Two consequences worth knowing:

- **`add` replaces by org, not by address.** Registering a second account on an
  address you already use adds it; it does not overwrite the first. Re-running
  `add` with a new name for the *same org* renames it and says so.
- **Pre-`0.3.1` state migrates itself.** Registry entries written before this
  backfill their org key from the stored Keychain record on first read.
  Snapshots written before it lack an org key entirely and are dropped rather
  than guessed at — so those profiles read `unknown` until the statusline
  renders once under each account.

## How `limits` knows anything about an inactive account

It cannot ask. The 5h/7d percentages exist **only** in the statusline's stdin
payload (`.rate_limits.*`) at render time — nothing persists them, and probing
an account live would spend quota from the window being measured.

So `config/statusline-command.sh` snapshots the four fields to
`~/.claude/.cc-usage-<orgUuid>` on each render (free — already parsed, and a
fork-free bash redirect). `cc_account_lib.ts` then reasons over the snapshots
using two properties that make stale data far more useful than it sounds:

- **A rolled window is provably empty.** If `now >= resets_at`, that window
  reset regardless of snapshot age. Reported as `reset` — certainty, not a
  guess.
- **Within a live window, usage only rises.** A stale reading is therefore a
  strict *lower bound*, never an overestimate. Reported as `floor`.

An account with no snapshot is `unknown` and sorts **last** — never
optimistically assumed free, because guessing wrong sends you into a wall.

`next` ranks provably-reset first, then lowest floor, then name (deterministic:
the same state always picks the same account).

## Notes

- The snapshot files hold percentages and reset epochs only — no credentials.
- `add`/`use` pass secrets on `security`'s argv, visible via `ps` to the **same
  user** only. Same tradeoff as the `stark-gh-token` entries.
- Headless dispatch (`tools/claude_auth_lib.ts`) is deliberately
  subscription-only and strips `ANTHROPIC_API_KEY`. This skill does not change
  that — it switches which subscription is active, and adds no API-key mode.
