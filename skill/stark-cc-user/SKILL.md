---
name: stark-cc-user
disable-model-invocation: true
description: >-
  Switch the active Claude Code account between stored profiles when a 5-hour
  or 7-day rate-limit window runs out. Credentials live in macOS Keychain
  (service `stark-cc-token`); headroom comes from statusline snapshots.
argument-hint: "[show|list|add <name>|use <name>|refresh <name>|remove <name>|prune|reset|limits|next|order] [--all] [--dry-run] [--best] [--yes]"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-cc-user

Toggle the Claude Code account so work can continue on a profile whose window
still has room. Sibling of `stark-gh-user` (which does the same for the **GitHub**
identity when a GraphQL/REST bucket runs dry), but the mechanics differ — read
"Why this isn't just a token swap" before changing anything.

## Arguments

**Raw input:** `$ARGUMENTS`

- `/stark-cc-user` or `show` — active account + its headroom
- `/stark-cc-user list` — registered profiles (`*` marks the active one)
- `/stark-cc-user add <name>` — store the CURRENT login as profile `<name>`
- `/stark-cc-user use <name>` — switch to profile `<name>`
- `/stark-cc-user remove <name>` — forget a profile (credentials + registry entry)
- `/stark-cc-user prune [--dry-run]` — forget every profile with no stored credentials
- `/stark-cc-user reset [--yes] [--snapshots]` — forget **every** stored login and start over (previews unless `--yes`)
- `/stark-cc-user refresh <name>` — renew that profile's tokens, no browser
- `/stark-cc-user refresh --all` — renew every stale profile (the active seat is checked and reported, never refreshed)
- `/stark-cc-user refresh --all --dry-run` — report what is due **without contacting the endpoint**
- `/stark-cc-user limits` — headroom for every profile, best target first
- `/stark-cc-user next` — **switch to the next profile in the rotation**
- `/stark-cc-user next --dry-run` — preview that pick without switching
- `/stark-cc-user next --best` — emptiest window instead of the next one
- `/stark-cc-user order [names...]` — show the rotation cycle, or set it

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

Repeat per account. `add` is also safe to re-run — it re-captures the current
login into an existing profile.

**Log in once per account, then never again**: keeping a profile alive is
`refresh`'s job, not `/login`'s — see the next section.

## Renewing without a browser — `refresh`

A stored profile's access token lives **8 hours** and its refresh token about
**28 days**. Nothing used to renew either, so profiles went stale within a day
and dead within a month, and the only known repair was `claude /login` per
account. `refresh` renews them against the OAuth token endpoint instead:

```
/stark-cc-user refresh --all            # renew everything that's due
/stark-cc-user refresh Max-1            # or one profile
/stark-cc-user refresh --all --dry-run  # what's due, no network call
```

Three facts, measured against CLI 2.1.205 on 2026-08-09, are what make this
work — and each one constrains the implementation:

1. **`POST https://platform.claude.com/v1/oauth/token`** with
   `grant_type=refresh_token` and the CLI's own public client id returns a fresh
   pair: HTTP 200, `expires_in=28800`, `refresh_token_expires_in≈2405096`.
2. **The refresh token rotates.** The token that was sent is dead the moment the
   response arrives, so a refresh whose result isn't persisted *destroys* the
   profile. That is exactly how profiles rotted before: `use` restored a
   snapshot, the CLI refreshed, and the rotated token was never written back.
3. **`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` does not help.** Injected alongside an
   expired access token, the CLI fails `401 OAuth access token has expired`
   without attempting a refresh — verified twice with the same token, which the
   second failure proves was never consumed.

Consequences worth knowing before you touch this code:

- **The active seat is never refreshed — its stored copy is CHECKED and
  REPORTED.** Rotating the live login's token leaves the running CLI holding a
  dead one, discovered hours later as a forced `/login`. But skipping it silently
  is what let a profile rot into a revoked token: the running CLI rotates the
  *global* Keychain item on its own schedule, so the stored copy dies while its
  own `expiresAt` still reads hours ahead and every staleness check says `fresh`.
  So `refresh` compares the stored refresh token against the live one and reports
  `stale-copy` when they differ. **It does not repair it automatically**, and that
  restraint is load-bearing: nothing local can tell "same account, rotated" from
  "a different account's token is in the shared item right now" — the blob carries
  no account uuid, and `~/.claude.json` is exactly what has gone stale in that
  scenario. `seatIncoherence` only compares plan strings, so it fails open for
  `team`↔`team` and `max`↔`max`, about half this fleet. An automatic copy would
  therefore bottle one seat's token under another's identity and destroy a
  non-re-derivable refresh token — worse than the silence it replaced. Repair is
  deliberate: quit other `claude` sessions, then `add <name>`.
- **`--dry-run` stops before the network call.** A preview that contacted the
  endpoint would rotate the token it was only meant to inspect.
- **Runs hold a lock** (`~/.claude/.cc-refresh.lock`). Two concurrent refreshes
  of one profile both send the same token; the server honours one and kills it
  for the other, so the loser stores a dead credential.
- **The response names the seat** (`account.uuid` + `organization.uuid`), so a
  profile holding a *different* seat's token is reported. This is the only check
  that catches a swap between two profiles on the same plan type —
  `seatIncoherence` compares plan strings and cannot. It **warns and still
  writes** (status `refreshed-mislabeled`, tallied separately from clean
  renewals): the token that was sent is already dead, so the response is the only
  live credential for that seat and refusing to store it would destroy the
  profile. The credential is right; the registry *label* is what drifted. Fixing
  the label means `remove <name>` then `add` while logged in as the seat that name
  should mean — a bare `add` overwrites the credential with the current login's
  rather than re-labelling the one you have.
- **`dead` means `dead`.** Once the refresh token itself expires, nothing here
  recovers it: `claude /login` + `add <name>`.

## Forgetting an account

```
/stark-cc-user remove <name>     # one profile: credentials + registry entry
/stark-cc-user prune --dry-run   # list profiles with no stored credentials
/stark-cc-user prune             # forget them
```

`remove` is **irreversible**. An OAuth blob cannot be re-derived, so recovering
the account means `claude /login` + `add` again.

Removing the **active** profile is allowed and warns. Nothing breaks
immediately — the live credentials item is a separate Keychain entry and stays
intact — but `use` re-captures the outgoing account only while it is still
registered. Without its entry, switching away drops that seat's credentials for
good.

`prune` refuses outright when any profile's credentials cannot be READ —
`security` exits non-zero for a locked keychain and a denied ACL as well as for
item-not-found, and treating those alike emptied the whole registry (names,
seat keys, the `order` cycle) while the Keychain records survived with nothing
left to enumerate them by name. Unlock the keychain and retry; do **not** run
`add` to "fix" it, since that overwrites an intact, non-re-derivable blob with
whatever seat is currently logged in.

Given a readable keychain `prune` destroys nothing recoverable: an entry
qualifies precisely because there is no credential left to destroy. `next`
already skips these, so they only pad `list` and `order`. Keep them if you plan
to re-`add` those accounts — a placeholder entry holds its slot in the
rotation, while a pruned one rejoins at the end of the cycle and needs `order`
run again.

Survivors keep their `order` values, gaps and all — those are a sort key, not a
position, so a removal never rewrites a cycle you arranged by hand.

## Starting over — `reset`

```
/stark-cc-user reset               # preview: exactly what would go
/stark-cc-user reset --yes         # do it
/stark-cc-user reset --yes --snapshots   # ...and clear headroom history too
```

Use it when the registry has drifted past repair — mismatched seats, profiles
you can no longer account for, a keying scheme from an older version. Rebuilding
from a clean slate is cheaper than auditing eleven records.

**It previews by default and acts only under `--yes`** — the inverse of `next`,
and deliberately so: `next` is undone by another `next`, whereas an OAuth blob
cannot be re-derived. A mistyped flag therefore degrades to a preview, and
`--dry-run` beats `--yes` if both appear. Unknown flags are a hard error, never
ignored.

**What it does NOT touch:** the live `Claude Code-credentials` item and
`~/.claude.json`. You stay logged in as whoever you are right now, so `add
<name>` re-registers that account immediately. A reset that logged you out would
leave nothing to rebuild from.

**It drains the whole `stark-cc-token` service**, looping an un-named
`security delete-generic-password` rather than walking registry names. That
catches **orphans** — stored credentials whose registry entry was lost, which
nothing can enumerate by name and which a name-walk would leave behind
invisibly. The output reports orphans separately from registered profiles.

**Usage snapshots are kept unless `--snapshots`.** They are per-seat headroom
readings that cannot be regenerated retroactively and stay valid for any seat
you re-`add`; clearing them re-ranks every profile as `unknown` until the
statusline has rendered once per account.

Rebuild afterwards, one `claude /login` + `add` per account, then `order` to set
the rotation. Quit every other running `claude` first — see the Keychain-is-
global warning above, which is how mismatched profiles get minted in the first
place.

## Why this isn't just a token swap

`gh` needs one token in one env var. A Claude switch has **two halves**, and
writing only one leaves the machine incoherent:

| Half | Where | What breaks if skipped |
|---|---|---|
| OAuth blob | Keychain `genp`, service `Claude Code-credentials`, account = the login user (`USER` env, `unknown` fallback — never hardcode; a hardcoded `root` shipped in the first release and made every switch a no-op) | CLI still authenticates as the old account |
| Identity metadata | `~/.claude.json` → `oauthAccount` | Statusline and every `oauthAccount` reader report the wrong account |

`use` writes both from one stored record, Keychain first (it is the half that
can fail on a locked keychain — if it throws, `~/.claude.json` is untouched and
the previous account stays coherent).

**Switching takes effect on the next `claude` launch.** Credentials are read
once at startup; a running session keeps the old account until restarted.

`use` also re-captures the OUTGOING account before overwriting it, so a token
refreshed during the session isn't lost.

### The Keychain item is global — quit other sessions before `add`

There is **one** `Claude Code-credentials` entry per login user, and every
running `claude` reads *and rewrites* it on token refresh. So a live session
authenticated as account A can clobber the credentials half moments after you
switch to B, while `~/.claude.json` still says B. `add` (and the outgoing
re-capture) then bottle that pair verbatim: **A's token under B's identity.**

The CLI presents A's token, the server resolves entitlement from it and not
from B's seat, and a team seat carrying a personal-org token bills as metered
API usage — surfacing as **"Credit balance is too low"** on an account that has
no metered balance at all. Nothing in the message points at the switch.

Hit live on 2026-08-01: profile `Net-T3` held a `max` token under an
`Evinced RD` (`claude_team`) seat — the only incoherent one of five team
profiles. `seatIncoherence()` now compares `credentials.claudeAiOauth`
`.subscriptionType` against `oauthAccount.organizationType` and blocks all
three write paths: `add` refuses to store a mismatched pair, `use` refuses to
switch to one, and the outgoing re-capture **skips** rather than overwrite a
good stored profile with a mismatched snapshot. It fails **open** — only a
definite contradiction between two known plan types (`claude_team`↔`team`,
`claude_max`↔`max`) blocks anything, so an unfamiliar `organizationType` or an
unreadable blob never strands a working profile.

**Repair a flagged profile:** quit every other running `claude`, `claude
/login` as that address, select the right organization, `add <name>` again.

## The identity is the SEAT, not the email and not the org

Neither email nor org is unique. Real profiles on one machine:

| profile | accountUuid | organizationUuid |
|---|---|---|
| `Net-T0` | `f05d659e` | `32e87edd` (Evinced RD) |
| `Net-M0` | `f05d659e` ← same account | `b5c2bf52` (personal Max) |
| `Net-T1` | `67ce42fe` | `32e87edd` ← same org |

One address holds seats in several orgs (a team seat plus a personal Max plan);
one org holds many members. **Team-plan limits are per-member**, so every
`(account, org)` pair has its own independent budget.

So the key is `accountUuid:organizationUuid` — the finest grain that maps 1:1 to
a rate-limit window, and the coarsest that never merges two. It keys the
registry, the snapshot filename, ranking joins, and the active-profile marker.
Email is display only; `list` and `next` print the org name so profiles sharing
an address stay readable.

Both narrower keys were tried and both lost data — email merged T0/M0, org alone
merged T0/T1. In each case `add` deduped one profile out of the registry and the
two shared a snapshot file, so each reported the other's usage.

Two consequences worth knowing:

- **`add` replaces by seat.** Registering another account that shares an address
  or an org with one you already have adds it; it does not overwrite. Re-running
  `add` with a new name for the *same seat* renames it and says so.
- **Older state migrates itself.** Registry entries written by earlier versions
  backfill their seat key from the stored Keychain record on first read.
  Snapshots written by them carry no seat key and are dropped rather than
  guessed at — so those profiles read `unknown` until the statusline renders
  once under each account.

## How `limits` knows anything about an inactive account

It cannot ask. The 5h/7d percentages exist **only** in the statusline's stdin
payload (`.rate_limits.*`) at render time — nothing persists them, and probing
an account live would spend quota from the window being measured.

So `config/statusline-command.sh` snapshots the four fields to
`~/.claude/.cc-usage-<accountUuid>_<organizationUuid>` on each render (free — already parsed, and a
fork-free bash redirect). `cc_account_lib.ts` then reasons over the snapshots
using two properties that make stale data far more useful than it sounds:

- **A rolled window is provably empty.** If `now >= resets_at`, that window
  reset regardless of snapshot age. Reported as `reset` — certainty, not a
  guess.
- **Within a live window, usage only rises.** A stale reading is therefore a
  strict *lower bound*, never an overestimate. Reported as `floor`.

An account with no snapshot is `unknown` and sorts **last** — never
optimistically assumed free, because guessing wrong sends you into a wall.

For the same reason a snapshot is written **only by a process launched under
the seat that is currently recorded**. `~/.claude.json` is global, but each
`claude` process authenticates once at startup and then reports *its own*
account's windows forever. With several windows open — eleven concurrent
processes spanning three days is a real observed case — a process started
before a `/login` keeps reporting the old account's numbers while reading the
new account's identity, and would file one seat's usage under another's key.

So the statusline records when the current seat first appeared and writes only
from processes that started after that. A stale process simply stops
contributing. Practical consequences:

- A newly-switched account reads `unknown` until you **restart `claude`** under
  it — the same restart the credentials themselves need.
- Long-running windows on older accounts stop refreshing their own seat. That is
  honest: nothing else on the machine can attribute their numbers.

`next --best` ranks provably-reset first, then lowest floor, then name
(deterministic: the same state always picks the same account).

## The rotation cycle

`next` walks a **fixed sequence**, not a ranking. Predictability is the point —
you always know which account comes next without reading percentages, and the
cycle visits every seat before repeating any.

```
/stark-cc-user order Com-Max Net-T0 Net-M0 Net-T1 Net-M1 …
/stark-cc-user order                 # show the current cycle
/stark-cc-user list                  # same order, with live status
/stark-cc-user next                  # advance one step (switches)
/stark-cc-user next --dry-run        # show the pick without switching
```

- **Switches by default.** `next` exists to advance the rotation; `--dry-run` is
  the preview. (`--apply` is still accepted, and now just names the default.)
- **Wraps** at the end, so repeated `next` laps the whole fleet.
- **Skips profiles with no stored credentials** — they cannot be switched to, so
  stopping on one would dead-end the rotation.
- **`add` appends** rather than inserting: a new account joins the end of the
  cycle instead of shifting a sequence you arranged. Re-`add`ing an existing
  seat under a new name keeps its slot.
- Profiles you leave out of `order` stay in the cycle, just after the placed
  ones — a partial reorder never drops an account.

Use `next --best` when you want the emptiest window rather than the next in
line; the ranking logic is unchanged.

### When `next` won't switch

Every dead end is a distinct outcome, and **only the first is fixed by `add`**:

| State | What you get | rc |
|---|---|---|
| Nothing registered | `register one with add <name>` | 1 |
| Nothing readable | names them, says **do NOT `add`** — unlock and retry | 1 |
| Nothing has credentials | re-`add` *while logged in as each* | 1 |
| Every profile incoherent | `/login` per account, pick the org, re-`add` | 1 |
| `--best` with an unknown active seat | refuses — see below | 1 |
| Only the active seat is usable | `already active — nothing to switch to` | **0** |

Exit **0** for the last one, in both modes: nothing to do is not a failure, and
a script branching on `rc` must not get a different answer depending on whether
it passed `--best`.

**Skipped profiles are reported on stderr, not hidden.** A rotation quietly
emptied down to one seat used to report a clean result every run, so the window
wall arrived unannounced. A profile that is merely unreadable or incoherent
does **not** block the switch when something healthy is available.

**`--best` refuses when the active seat is unknown** (a `~/.claude.json` with no
`oauthAccount`) because it excludes the active seat by name — with nothing to
exclude it would pick the account already in use and report a successful
switch. Plain `next` still works in that state and is the way back.

**Unknown flags are a hard error** on `next`, `reset`, `prune` and `order` — a
typo'd `--dry-run` used to mean a real switch. `--help` works after any
subcommand.

## Notes

- The snapshot files hold percentages and reset epochs only — no credentials.
- `add`/`use` pass secrets on `security`'s argv, visible via `ps` to the **same
  user** only. Same tradeoff as the `stark-gh-token` entries.
- Headless dispatch (`tools/claude_auth_lib.ts`) is deliberately
  subscription-only and strips `ANTHROPIC_API_KEY`. This skill does not change
  that — it switches which subscription is active, and adds no API-key mode.
