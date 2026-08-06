/**
 * cc_account_lib.ts — pure logic behind `/stark-cc-user`: switching the active
 * Claude Code account and reasoning about each profile's rate-limit headroom.
 * Sibling of the `stark-gh-token` resolver, but the mechanics differ in two
 * ways that drive the whole design.
 *
 * ## 1. A Claude switch has TWO halves, not one
 *
 * `gh` needs a token in an env var. Claude Code needs both:
 *   - macOS Keychain, class `genp`, service `Claude Code-credentials`,
 *     account = the login user (`USER` env, `unknown` fallback — see
 *     `resolveClaudeKeychainAccount`) — the OAuth blob (access/refresh token,
 *     expiry, scopes).
 *   - `~/.claude.json` → `oauthAccount` — the identity metadata
 *     (`emailAddress`, `organizationType`, `organizationUuid`, `seatTier`, …).
 *
 * Writing only the Keychain half leaves `~/.claude.json` describing the OLD
 * account: the CLI authenticates as the new one while every consumer that
 * reads `oauthAccount` (the statusline included — see `statusline-command.sh`,
 * which mtime-caches that file) keeps reporting the old identity. So a profile
 * record stores BOTH halves and `applyProfile` writes them together.
 *
 * Claude Code reads credentials once at startup, so a switch only takes effect
 * on the next `claude` launch. Callers surface that; nothing here can force it.
 *
 * ## 2. There is no local rate-limit state to read
 *
 * The 5h/7d percentages come from Claude Code's statusline stdin payload
 * (`.rate_limits.*`) at render time. They are not persisted anywhere —
 * `~/.claude.json` has no rate/limit/reset field for them. So an inactive
 * profile's headroom cannot simply be looked up, and probing it live would
 * mean spending quota from the very window you're trying to measure.
 *
 * Instead the statusline writes a snapshot per account on each render (free —
 * it already parses those four fields), and this module reasons over the
 * snapshots. Two facts make stale snapshots far more useful than they sound:
 *
 *   - **A window that has provably rolled is known-empty.** If `now >=
 *     fiveReset`, that window reset regardless of how old the snapshot is.
 *     Certainty, not estimation.
 *   - **Within a live window, usage is monotonic.** It only ever goes up, so a
 *     stale reading is a strict LOWER BOUND on current usage — never an
 *     estimate that might be too high. Ranking on a floor is sound: a profile
 *     whose floor is 90% is genuinely at least 90%.
 *
 * `projectUsage` returns which of those cases applies, and `rankProfiles`
 * orders on it: provably-reset first, then lowest floor. A profile with no
 * snapshot at all is `unknown` — sorted last rather than optimistically
 * assumed empty, because guessing wrong sends you to a wall.
 */

/**
 * A named account this machine can switch to.
 *
 * The identity is the SEAT: the `accountUuid` + `organizationUuid` pair. Neither
 * component is unique on its own, as one machine's real profiles show:
 *
 *   Net-T0  account f05d659e  org 32e87edd   (Evinced RD team seat)
 *   Net-M0  account f05d659e  org b5c2bf52   <- same account, different org
 *   Net-T1  account 67ce42fe  org 32e87edd   <- same org, different account
 *
 * One address can hold seats in several orgs (a team seat plus a personal Max
 * plan), and one org holds many members. Team-plan limits are per-member, so
 * every (account, org) pair has its own independent budget — the pair is the
 * finest grain that maps 1:1 to a rate-limit window, and the coarsest that
 * never merges two.
 *
 * Both narrower keys were tried and both lost data: keying on email merged
 * T0/M0, keying on org alone merged T0/T1. In each case `add` deduped one
 * profile out of the registry and both shared a snapshot file, so each reported
 * the other's usage.
 */
export interface Profile {
  /** Keychain account under service `stark-cc-token`, e.g. `s1`. */
  name: string;
  /** Address the account logs in as. Display + disambiguation only. */
  email: string;
  /**
   * `accountUuid:organizationUuid` — the identity key, joining a profile to its
   * usage snapshot. Optional only to tolerate registry entries written by
   * earlier versions, which the CLI backfills from the stored record on read.
   */
  seatKey?: string;
  /** Org name, e.g. `Evinced RD` — display only, disambiguates shared emails. */
  label?: string;
  /**
   * Position in the rotation cycle that `next` walks. Lower comes first.
   * Absent means "not placed yet" — those sort after every placed profile, so a
   * freshly `add`ed account joins the end of the cycle instead of silently
   * displacing the sequence you set.
   */
  order?: number;
}

/** Both halves of a stored account, as persisted under `stark-cc-token`. */
export interface StoredProfile {
  /** Verbatim `Claude Code-credentials` blob. Opaque — never parsed. */
  credentials: string;
  /** The `oauthAccount` object lifted from `~/.claude.json`. */
  oauthAccount: Record<string, unknown>;
}

/** One statusline render's view of an account's rate-limit windows. */
export interface UsageSnapshot {
  /** The seat this reading belongs to — the join key. */
  seatKey: string;
  /** Login address at capture time. Display only; not unique across orgs. */
  email: string;
  fivePct: number;
  /** Unix seconds when the 5h window rolls. 0 when absent. */
  fiveReset: number;
  weekPct: number;
  weekReset: number;
  /** Unix seconds the snapshot was taken. */
  stampedAt: number;
}

export type Certainty =
  /** Window provably rolled since the snapshot — genuinely 0%. */
  | "reset"
  /** Snapshot is from the live window: `pct` is a lower bound. */
  | "floor"
  /** No snapshot for this profile — headroom unknown. */
  | "unknown";

export interface Projection {
  fivePct: number;
  weekPct: number;
  /** Applies to the 5h window — the one that gates a working session. */
  certainty: Certainty;
  /** Snapshot age in seconds; null when `unknown`. */
  ageSec: number | null;
}

const SERVICE_CLAUDE = "Claude Code-credentials";
const SERVICE_PROFILES = "stark-cc-token";

export const KEYCHAIN = {
  claudeService: SERVICE_CLAUDE,
  profileService: SERVICE_PROFILES,
} as const;

/**
 * The Keychain ACCOUNT the Claude CLI keys its credentials item by.
 *
 * The CLI resolves this from the `USER` env var, with a literal `unknown`
 * fallback when it is unset (an `acct=unknown` item created by a USER-less
 * headless run is the observed evidence — `os.userInfo()` can never produce
 * that string). This mirrors that resolution exactly, so every read and write
 * here targets the entry the CLI itself will use in the same environment.
 *
 * The original release hardcoded `root` — a stale relic item — which made
 * `use` write credentials the CLI never read and `add` capture a long-dead
 * token into every stored profile. Never hardcode this account.
 */
export function resolveClaudeKeychainAccount(
  env: Record<string, string | undefined>,
): string {
  const user = env["USER"]?.trim();
  return user ? user : "unknown";
}

/**
 * Read the live Claude credential blob for `account`.
 *
 * `security` takes the secret on argv for writes, so it is visible to `ps` for
 * processes owned by the same user. That is the standard scripting tradeoff on
 * macOS and matches how the `stark-gh-token` entries are managed; it is not an
 * exposure to *other* users. Callers must still not log the returned value.
 */
export function readClaudeCredsArgv(account: string): string[] {
  return [
    "find-generic-password",
    "-s",
    SERVICE_CLAUDE,
    "-a",
    account,
    "-w",
  ];
}

export function writeClaudeCredsArgv(account: string, blob: string): string[] {
  // -U updates in place instead of erroring on an existing item.
  return [
    "add-generic-password",
    "-U",
    "-s",
    SERVICE_CLAUDE,
    "-a",
    account,
    "-w",
    blob,
  ];
}

export function readProfileArgv(name: string): string[] {
  return ["find-generic-password", "-s", SERVICE_PROFILES, "-a", name, "-w"];
}

export function deleteProfileArgv(name: string): string[] {
  return ["delete-generic-password", "-s", SERVICE_PROFILES, "-a", name];
}

/**
 * Delete ONE `stark-cc-token` item without naming it.
 *
 * `security` deletes a single matching item per call, so looping on this until
 * it exits non-zero drains the whole service — including ORPHANS, records whose
 * registry entry was lost and which `deleteProfileArgv` therefore cannot reach
 * (nothing enumerates a Keychain service by name). That is why `reset` needs
 * this and `remove` does not. Scoped to `stark-cc-token`, so it can never touch
 * the live `Claude Code-credentials` item or any other service.
 */
export function deleteAnyProfileArgv(): string[] {
  return ["delete-generic-password", "-s", SERVICE_PROFILES];
}

export function writeProfileArgv(name: string, blob: string): string[] {
  return [
    "add-generic-password",
    "-U",
    "-s",
    SERVICE_PROFILES,
    "-a",
    name,
    "-w",
    blob,
  ];
}

/**
 * Snapshot file path for an account — one file per SEAT.
 *
 * Two profiles sharing a login address, or sharing an org, must not share a
 * file: their windows are independent, and a shared file makes each report the
 * other's usage.
 */
export function snapshotPath(home: string, seatKey: string): string {
  return `${home}/.claude/.cc-usage-${sanitizeKey(seatKey)}`;
}

/**
 * Filesystem-safe form of an identity key.
 *
 * `:` is not in the allowed set, so a `<account>:<org>` seat key lands as
 * `<account>_<org>` on disk. That is fine — the mapping is injective over
 * uuids, which contain no `_`.
 */
export function sanitizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_");
}

/**
 * Build the seat key for an `oauthAccount`, or null if either half is missing.
 *
 * Both halves are required: a key missing one component would silently collide
 * with every other seat sharing the component it does have.
 */
export function seatKeyOf(
  account: Record<string, unknown> | null | undefined,
): string | null {
  const acct = account?.["accountUuid"];
  const org = account?.["organizationUuid"];
  if (typeof acct !== "string" || acct === "") return null;
  if (typeof org !== "string" || org === "") return null;
  return `${acct}:${org}`;
}

/**
 * Snapshot wire format: one `key=value` per line. Chosen over JSON because the
 * writer is `statusline-command.sh` on a 1s tick, where a `jq` fork is the
 * thing the whole script is built to avoid — bash can emit this with `printf`.
 *
 * `seat_key` is emitted LAST, and that ordering is load-bearing. The writer
 * redirects straight onto the file (no temp-file + rename, which would cost a
 * fork per tick), so a reader can catch a partially-written file. `parse`
 * treats a record with no `seat_key` as unmarked — so a truncated write
 * degrades to `unknown` (sorted last) instead of to a record showing
 * `five_pct=0`, which would read as "this account is completely free" and send
 * a caller straight into a wall. Fail-safe by construction, not by locking.
 *
 * A record without `seat_key` is also how snapshots from earlier versions
 * (keyed by email, then by org alone) are rejected: neither can be attributed
 * to one specific seat, so they are dropped rather than guessed at.
 */
export function formatSnapshot(s: UsageSnapshot): string {
  return (
    [
      `five_pct=${s.fivePct}`,
      `five_reset=${s.fiveReset}`,
      `week_pct=${s.weekPct}`,
      `week_reset=${s.weekReset}`,
      `stamped_at=${s.stampedAt}`,
      `email=${s.email}`,
      `seat_key=${s.seatKey}`,
    ].join("\n") + "\n"
  );
}

export function parseSnapshot(text: string): UsageSnapshot | null {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const seatKey = kv.get("seat_key");
  if (!seatKey) return null;
  const num = (k: string): number => {
    const raw = kv.get(k);
    if (raw === undefined || raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    seatKey,
    email: kv.get("email") ?? "",
    fivePct: num("five_pct"),
    fiveReset: num("five_reset"),
    weekPct: num("week_pct"),
    weekReset: num("week_reset"),
    stampedAt: num("stamped_at"),
  };
}

/**
 * Resolve a snapshot into current-headroom terms.
 *
 * The 5h window drives `certainty` because that is the window that stops a
 * session. The 7d percentage is projected the same way but reported alongside
 * rather than ranked on — a rolled 7d window with a live 5h window still
 * leaves you blocked.
 */
export function projectUsage(
  snap: UsageSnapshot | undefined,
  now: number,
): Projection {
  if (!snap) {
    return { fivePct: 0, weekPct: 0, certainty: "unknown", ageSec: null };
  }
  const ageSec = Math.max(0, now - snap.stampedAt);
  // A reset epoch of 0 means the field was absent — never treat that as rolled.
  const fiveRolled = snap.fiveReset > 0 && now >= snap.fiveReset;
  const weekRolled = snap.weekReset > 0 && now >= snap.weekReset;
  return {
    fivePct: fiveRolled ? 0 : snap.fivePct,
    weekPct: weekRolled ? 0 : snap.weekPct,
    certainty: fiveRolled ? "reset" : "floor",
    ageSec,
  };
}

/**
 * The rotation cycle, in order.
 *
 * Placed profiles (an explicit `order`) come first, ascending; unplaced ones
 * follow, by name. The sort is total and stable so `next` is deterministic —
 * it is used non-interactively, and the same state must always pick the same
 * account.
 */
export function orderedProfiles(profiles: readonly Profile[]): Profile[] {
  return [...profiles].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The profile after `activeSeatKey` in the cycle, wrapping at the end.
 *
 * `eligible` filters out profiles that cannot actually be switched to (no
 * stored credentials) — skipping them keeps the cycle usable rather than
 * dead-ending on a broken entry.
 *
 * Returns null when nothing is eligible. When the active seat is not in the
 * list — an unregistered login, or the active profile itself ineligible — the
 * cycle starts from its beginning rather than failing: "the next one" is still
 * well-defined.
 *
 * Single eligible profile returns that profile: a cycle of one is itself, which
 * `use` treats as a no-op switch. Callers that want "somewhere else" should
 * compare against the active seat.
 */
export function nextInCycle(
  profiles: readonly Profile[],
  activeSeatKey: string | null,
  eligible: (p: Profile) => boolean = () => true,
): Profile | null {
  const cycle = orderedProfiles(profiles).filter(eligible);
  if (cycle.length === 0) return null;
  const active = activeSeatKey?.toLowerCase() ?? null;
  const at = active
    ? cycle.findIndex((p) => p.seatKey?.toLowerCase() === active)
    : -1;
  if (at < 0) return cycle[0] ?? null;
  return cycle[(at + 1) % cycle.length] ?? null;
}

/**
 * Apply an explicit ordering by profile name.
 *
 * Names not present in the registry are ignored; registered profiles the caller
 * omitted keep their place AFTER the listed ones (they become unplaced), so a
 * partial list reorders the front of the cycle without dropping anyone.
 */
export function applyOrder(
  profiles: readonly Profile[],
  names: readonly string[],
): Profile[] {
  const rank = new Map<string, number>();
  names.forEach((n, i) => rank.set(n.toLowerCase(), i));
  return profiles.map((p) => {
    const r = rank.get(p.name.toLowerCase());
    if (r === undefined) {
      const { order: _drop, ...rest } = p;
      return rest;
    }
    return { ...p, order: r };
  });
}

/**
 * Drop a profile from the registry by name.
 *
 * Matching is case-insensitive to agree with every other name lookup here.
 * Survivors keep their `order` untouched: those values are a sort key, not a
 * position, so renumbering after a removal would silently rewrite a cycle the
 * user arranged by hand. The resulting gap is invisible — `orderedProfiles`
 * only compares.
 */
export function removeProfile(
  existing: readonly Profile[],
  name: string,
): { profiles: Profile[]; removed?: Profile } {
  const want = name.trim().toLowerCase();
  const removed = existing.find((p) => p.name.toLowerCase() === want);
  return {
    profiles: existing.filter((p) => p.name.toLowerCase() !== want),
    ...(removed ? { removed } : {}),
  };
}

/**
 * Flags for `next`.
 *
 * Switching is the DEFAULT: `next` exists to advance the rotation, and gating
 * that behind `--apply` made the common case two commands while the bare form
 * did nothing — which reads as a broken tool rather than as a preview.
 *
 * `--dry-run` is the preview. `--apply` is still accepted so muscle memory and
 * any existing script keep working; it now simply names the default. A
 * contradictory pair resolves to the safe reading — never switch unasked.
 *
 * Unknown flags are a hard error, for the same reason `parseResetFlags` makes
 * them one — and more urgently here, because this command's default ACTS.
 * `apply` was computed as `!args.includes("--dry-run")`, so any misspelling
 * (`--dry-rn`, `--dryrun`, `-n`) silently meant the opposite of what was
 * asked and performed a live swap; `--bset` silently degraded `--best` to
 * cycle mode. A swap while another `claude` is running can bottle the wrong
 * seat's token, which surfaces much later as "Credit balance is too low" with
 * nothing pointing back at the typo.
 */
export function parseNextFlags(args: readonly string[]): {
  apply: boolean;
  best: boolean;
  unknown: string[];
} {
  const known = new Set(["--dry-run", "--apply", "--best"]);
  return {
    apply: !args.includes("--dry-run"),
    best: args.includes("--best"),
    unknown: args.filter((a) => !known.has(a)),
  };
}

/**
 * Whether a profile's stored credentials could be READ — three states, not two.
 *
 * `security` exits 44 for "item not found" but non-zero for a locked keychain,
 * a denied ACL, or a missing keychain too, and collapsing those into "absent"
 * is not a cosmetic loss: the remedy for absent is `add <name>`, which captures
 * the CURRENT login and OVERWRITES the stored record. Prescribing it for a
 * merely-unreadable profile destroys an intact OAuth blob that cannot be
 * re-derived, and silently rebinds that name to whatever seat is live.
 */
export type CredentialState =
  | "present"
  | "absent"
  | "unreadable"
  /**
   * Readable, but its two halves contradict each other (a `max` token under a
   * `claude_team` seat, the live 2026-08-01 case). `use` refuses these, so a
   * picker that treats them as usable dead-ends the rotation permanently:
   * `nextInCycle` is deterministic, so every subsequent `next` picks the same
   * broken profile and fails again, never reaching the healthy ones behind it.
   */
  | "incoherent";

/** What `next` should do, decided from state alone. */
export type NextOutcome =
  /** Switch to `target`. */
  | {
      kind: "switch";
      target: Profile;
      stale: readonly string[];
      unreadable: readonly string[];
    }
  /** Nothing to switch to: every usable profile sits on the live seat. */
  | {
      kind: "already-active";
      target: Profile;
      stale: readonly string[];
      unreadable: readonly string[];
    }
  /** Registry is empty — the one case `add <name>` actually fixes. */
  | { kind: "empty" }
  /** Registered, but no stored credentials anywhere. */
  | { kind: "no-credentials"; names: readonly string[] }
  /** Readable but unusable — `use` would refuse every one of them. */
  | { kind: "all-incoherent"; names: readonly string[] }
  /** The keychain could not be read; say so instead of prescribing `add`. */
  | { kind: "unreadable"; names: readonly string[] }
  /** The live seat is unknown, so "is this the active one?" cannot be answered. */
  | { kind: "unknown-active" }
  /** Usable profiles exist but the picker chose none. */
  | { kind: "none" };

function sameSeat(p: Profile, active: string): boolean {
  return !!p.seatKey && p.seatKey.toLowerCase() === active.toLowerCase();
}

/**
 * Classify what `next` should do. Pure: the only I/O is done by the caller,
 * which probes the keychain ONCE and passes the result in.
 *
 * Lives here rather than in `cmdNext` because it is the decision the command
 * exists to make, and every sibling decision (`nextInCycle`, `rankProfiles`,
 * `seatIncoherence`) is a tested lib function. In the CLI it was reachable only
 * by running the binary against a real keychain, so the exit-code contract had
 * no coverage at all.
 *
 * `pick` receives only the usable candidates and returns the chosen one —
 * headroom-ranked or next-in-cycle, supplied by the caller.
 *
 * Two subtleties worth keeping:
 *
 *  - `active === null` is its own outcome, never "proceed". The headroom picker
 *    excludes the active seat by passing it to `rankProfiles`, so a null active
 *    excludes NOTHING and the picker will happily return the live account —
 *    "switching" to the seat already in use while reporting success. Refusing is
 *    the only answer that cannot be wrong.
 *  - the all-active case names `orderedProfiles(usable)[0]`, so both modes name
 *    the SAME profile. Naming the picker's own choice made the two modes print
 *    different names for identical state.
 */
export function classifyNextOutcome(opts: {
  profiles: readonly Profile[];
  active: string | null;
  credentials: ReadonlyMap<string, CredentialState>;
  pick: (candidates: readonly Profile[]) => Profile | null;
  /** True when `pick` filters the active seat out (headroom mode). */
  pickerExcludesActive: boolean;
}): NextOutcome {
  const { profiles, active, credentials, pick, pickerExcludesActive } = opts;
  if (profiles.length === 0) return { kind: "empty" };

  const stateOf = (p: Profile): CredentialState =>
    credentials.get(p.name) ?? "absent";

  const usable = profiles.filter((p) => stateOf(p) === "present");
  const unreadable = profiles.filter((p) => stateOf(p) === "unreadable");
  const stale = profiles.filter((p) => stateOf(p) === "absent").map((p) => p.name);

  // Unreadable blocks only when it is load-bearing — i.e. when no healthy
  // candidate exists. Reporting it outright, as the first version did, meant a
  // single denied ACL or oversized item hard-failed the whole rotation while
  // four other profiles sat switchable: the operator's window is exhausted and
  // the tool refuses to do the one thing that would help. When something IS
  // switchable the unreadable names ride along as a warning instead.
  const incoherent = profiles.filter((p) => stateOf(p) === "incoherent");
  if (usable.length === 0) {
    if (unreadable.length > 0) {
      return { kind: "unreadable", names: unreadable.map((p) => p.name) };
    }
    if (incoherent.length > 0) {
      return { kind: "all-incoherent", names: incoherent.map((p) => p.name) };
    }
    return { kind: "no-credentials", names: profiles.map((p) => p.name) };
  }

  // Both classes are reported alongside a successful pick rather than blocking
  // it: they name profiles the rotation had to skip, which is exactly what the
  // operator needs to know before the window closes.
  const unreadableNames = [
    ...unreadable.map((p) => p.name),
    ...incoherent.map((p) => p.name),
  ];

  // A null active seat is only unanswerable for a picker that EXCLUDES the
  // active seat — `--best` passes it to `rankProfiles`, so a null excludes
  // nothing and the picker would return the live account. Cycle mode has a
  // documented answer for it ("the active seat is not in the list, so start
  // from the beginning"), and it is the only path that can restore a login
  // when ~/.claude.json has lost its oauthAccount. Refusing there removed the
  // one recovery route at exactly the moment it is needed.
  if (active === null && pickerExcludesActive) return { kind: "unknown-active" };

  if (active !== null && usable.every((p) => sameSeat(p, active))) {
    const target = orderedProfiles(usable)[0];
    if (target) {
      return { kind: "already-active", target, stale, unreadable: unreadableNames };
    }
  }

  const target = pick(usable);
  if (!target) return { kind: "none" };
  if (active !== null && sameSeat(target, active)) {
    return { kind: "already-active", target, stale, unreadable: unreadableNames };
  }
  return { kind: "switch", target, stale, unreadable: unreadableNames };
}

/**
 * Flags for `reset` — the irreversible one.
 *
 * `reset` PREVIEWS by default and acts only under `--yes`, the inverse of
 * `next`. The asymmetry is deliberate: `next` is undone by another `next`,
 * whereas an OAuth blob cannot be re-derived, so the default of every path here
 * is the one that destroys nothing. That also means a mistyped flag degrades to
 * a preview rather than to a wipe.
 *
 * Unknown flags are a hard error rather than ignored: `--snapshots` silently
 * dropped to false would keep state the operator asked to clear, and a typo'd
 * `--yes` reading as a no-op is only safe if the operator is told why nothing
 * happened.
 */
export function parseResetFlags(args: readonly string[]): {
  confirmed: boolean;
  snapshots: boolean;
  unknown: string[];
} {
  const known = new Set(["--yes", "--dry-run", "--snapshots"]);
  return {
    // `--dry-run` wins over `--yes`. A contradictory pair resolves to the
    // reading that destroys nothing.
    confirmed: args.includes("--yes") && !args.includes("--dry-run"),
    snapshots: args.includes("--snapshots"),
    unknown: args.filter((a) => !known.has(a)),
  };
}

/**
 * Merge a freshly-captured profile into the registry.
 *
 * Dedupe is on name and SEAT — never on email or org alone. One address can
 * hold seats in several orgs, and one org holds many members, so filtering by
 * either component would evict a distinct seat that merely shares it.
 *
 * The rotation slot survives both refresh shapes: re-`add`ing the same name
 * (documented as the token-refresh path) keeps its own `order`; renaming a
 * seat inherits the displaced entry's. Only a genuinely new seat joins
 * unplaced, at the END of the cycle, so a refresh never reshuffles a sequence
 * the user deliberately arranged.
 */
export function mergeProfile(
  existing: readonly Profile[],
  entry: { name: string; email: string; seatKey: string; label?: string },
): { profiles: Profile[]; displaced?: Profile } {
  const prior = existing.find((p) => p.name === entry.name);
  const displaced = existing.find(
    (p) => p.name !== entry.name && p.seatKey === entry.seatKey,
  );
  const profiles = existing.filter(
    (p) => p.name !== entry.name && p.seatKey !== entry.seatKey,
  );
  const order = prior?.order ?? displaced?.order;
  profiles.push({
    name: entry.name,
    email: entry.email,
    seatKey: entry.seatKey,
    ...(entry.label ? { label: entry.label } : {}),
    ...(order !== undefined ? { order } : {}),
  });
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return { profiles, ...(displaced ? { displaced } : {}) };
}

export interface RankedProfile {
  profile: Profile;
  projection: Projection;
}

const CERTAINTY_RANK: Record<Certainty, number> = {
  reset: 0, // provably empty — best possible target
  floor: 1, // live window, known lower bound
  unknown: 2, // no data — never guess it's free
};

/**
 * Order profiles best-target-first.
 *
 * Snapshots are keyed by `seatKey`. A profile with no `seatKey` (an entry the
 * CLI could not backfill) joins to nothing and ranks `unknown` — correct, since
 * its usage genuinely cannot be attributed.
 *
 * `exclude` matches on profile name or seatKey. It deliberately does NOT match
 * on email or org alone: excluding the active account by either would also
 * exclude a different seat that merely shares that component.
 *
 * Sort is total and deterministic: certainty class, then 5h floor, then 7d
 * floor, then name. Deterministic ordering matters because `next` is used
 * non-interactively — the same state must always pick the same account.
 */
export function rankProfiles(
  profiles: readonly Profile[],
  snapshots: ReadonlyMap<string, UsageSnapshot>,
  now: number,
  opts: { exclude?: readonly string[] } = {},
): RankedProfile[] {
  const excluded = new Set(
    (opts.exclude ?? []).filter(Boolean).map((e) => e.toLowerCase()),
  );
  return profiles
    .filter(
      (p) =>
        !excluded.has(p.name.toLowerCase()) &&
        !(p.seatKey && excluded.has(p.seatKey.toLowerCase())),
    )
    .map((profile) => ({
      profile,
      projection: projectUsage(
        profile.seatKey
          ? snapshots.get(profile.seatKey.toLowerCase())
          : undefined,
        now,
      ),
    }))
    .sort((a, b) => {
      const c =
        CERTAINTY_RANK[a.projection.certainty] -
        CERTAINTY_RANK[b.projection.certainty];
      if (c !== 0) return c;
      if (a.projection.fivePct !== b.projection.fivePct) {
        return a.projection.fivePct - b.projection.fivePct;
      }
      if (a.projection.weekPct !== b.projection.weekPct) {
        return a.projection.weekPct - b.projection.weekPct;
      }
      return a.profile.name.localeCompare(b.profile.name);
    });
}

/**
 * Validate a decoded profile record before it is written over the live
 * credentials. A half-valid record is worse than none: it can leave the CLI
 * authenticated as one account while `~/.claude.json` claims another.
 */
export function validateStoredProfile(v: unknown): StoredProfile {
  if (typeof v !== "object" || v === null) {
    throw new Error("profile record is not an object");
  }
  const rec = v as Record<string, unknown>;
  if (typeof rec["credentials"] !== "string" || rec["credentials"] === "") {
    throw new Error("profile record is missing a `credentials` blob");
  }
  const acct = rec["oauthAccount"];
  if (typeof acct !== "object" || acct === null) {
    throw new Error("profile record is missing an `oauthAccount` object");
  }
  const a = acct as Record<string, unknown>;
  if (typeof a["emailAddress"] !== "string") {
    throw new Error("profile `oauthAccount` is missing `emailAddress`");
  }
  // Both halves of the seat key. Without them a stored profile cannot be told
  // apart from a sibling seat sharing its address or its org, so they are
  // required rather than defaulted.
  if (!seatKeyOf(a)) {
    throw new Error(
      "profile `oauthAccount` is missing `accountUuid`/`organizationUuid` — " +
        "re-run `add` while logged in as this account",
    );
  }
  return { credentials: rec["credentials"], oauthAccount: a };
}

/**
 * Detect a stored profile whose two halves describe different plans.
 *
 * The Keychain `Claude Code-credentials` item is GLOBAL — one entry per login
 * user, shared by every running `claude` process — and a token refresh rewrites
 * it in place. So a live session authenticated as account A can clobber the
 * credentials half moments after `use B` wrote B's, while `~/.claude.json`
 * still says B. `add`/the `use` re-capture then store that pair verbatim:
 * A's token under B's identity. The CLI presents A's token, the server
 * resolves entitlement from it rather than from B's seat, and a team seat with
 * a personal-org token bills as metered API usage — surfacing as "credit
 * balance is too low" on an account that has no metered balance at all.
 *
 * Observed live on 2026-08-01: profile `Net-T3` held a `max` token under an
 * `Evinced RD` (`claude_team`) seat — the only incoherent one of five team
 * profiles.
 *
 * Returns a human-readable reason, or null when the halves agree OR when
 * either side is unreadable. Deliberately fail-open: only a DEFINITE
 * contradiction between two known plan types is reported, so an unfamiliar
 * `organizationType` never blocks a switch.
 */
export function seatIncoherence(rec: StoredProfile): string | null {
  const orgType = rec.oauthAccount["organizationType"];
  if (typeof orgType !== "string") return null;
  const expected = EXPECTED_SUBSCRIPTION[orgType];
  if (!expected) return null;

  let sub: unknown;
  try {
    const creds = JSON.parse(rec.credentials) as Record<string, unknown>;
    const oauth = creds["claudeAiOauth"];
    if (typeof oauth !== "object" || oauth === null) return null;
    sub = (oauth as Record<string, unknown>)["subscriptionType"];
  } catch {
    return null;
  }
  if (typeof sub !== "string" || sub === "" || sub === expected) return null;

  const org = rec.oauthAccount["organizationName"];
  const where = typeof org === "string" ? ` (${org})` : "";
  return (
    `stored credentials are a \`${sub}\` token but the seat is ` +
    `\`${orgType}\`${where}, which expects \`${expected}\` — ` +
    `the two halves came from different logins`
  );
}

/**
 * `organizationType` → the `subscriptionType` its OAuth token must carry.
 * Org types absent from this map are not checked (see `seatIncoherence`).
 */
const EXPECTED_SUBSCRIPTION: Readonly<Record<string, string>> = {
  claude_team: "team",
  claude_max: "max",
};

/** Human-readable headroom line, e.g. `5H 12% (floor, 4m old) · 7D 61%`. */
export function describeProjection(p: Projection): string {
  if (p.certainty === "unknown") return "no snapshot — headroom unknown";
  const age = p.ageSec === null ? "" : `, ${formatAge(p.ageSec)} old`;
  const qual = p.certainty === "reset" ? "reset" : `floor${age}`;
  return `5H ${p.fivePct}% (${qual}) · 7D ${p.weekPct}%`;
}

export function formatAge(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
