/**
 * cc_refresh_lib.ts — out-of-band OAuth refresh for stored `/stark-cc-user`
 * profiles. Pure logic; every side effect lives in `cc_account.ts`.
 *
 * WHY THIS EXISTS
 *
 * A stored profile is a snapshot of the `Claude Code-credentials` blob. Its
 * access token lives 8 hours; its refresh token lives ~28 days. Nothing ever
 * renewed either, so a profile went stale within a day of being captured and
 * dead within a month, and the only known repair was `claude /login` per
 * account — eleven browser round-trips, monthly.
 *
 * Three facts, all measured against CLI 2.1.205 on 2026-08-09, make renewal
 * possible without a browser:
 *
 *   1. `POST https://platform.claude.com/v1/oauth/token` with
 *      `grant_type=refresh_token` and the CLI's own public client id returns a
 *      fresh pair — HTTP 200, `expires_in=28800` (8h) and
 *      `refresh_token_expires_in≈2405096` (~27.8 days).
 *   2. The refresh token ROTATES. The response carries a different one and the
 *      token that was sent is dead on arrival. A refresh whose result is not
 *      persisted therefore DESTROYS the profile — which is precisely how the
 *      profiles rotted: `use` restored a snapshot, the CLI refreshed, and the
 *      rotated token was never written back.
 *   3. `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` does NOT save you here. Injected with
 *      an expired access token, the CLI fails `401 OAuth access token has
 *      expired` without ever attempting a refresh (verified twice with the same
 *      token — the second run failed identically, so it was not consumed).
 *      Env-var auth is access-token-only and stateless.
 *
 * So: persist-or-lose. Every function below is built around fact 2 — the write
 * is not an optimisation, it is the difference between renewing a profile and
 * destroying it.
 */

/** Token endpoint, as embedded in the CLI binary (`/v1/oauth/token`). */
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Claude Code's public OAuth client id, read out of the CLI binary rather than
 * assumed. A public client has no secret — this is the same value the CLI's own
 * login flow sends, and refreshing with it is the documented OAuth grant, not a
 * side channel.
 */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Renew when the access token has less than this left. */
export const DEFAULT_MARGIN_MS = 30 * 60 * 1000;

export interface RefreshRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** A refreshed token pair plus the seat the server says it belongs to. */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute ms, derived from `expires_in` against the injected clock. */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes: string[];
  /** `account.uuid` — present in every observed response. */
  accountUuid?: string;
  organizationUuid?: string;
  accountEmail?: string;
  organizationName?: string;
}

export function buildRefreshRequest(
  refreshToken: string,
  opts: { clientId?: string; url?: string } = {},
): RefreshRequest {
  if (!refreshToken) throw new Error("refresh token is empty");
  return {
    url: opts.url ?? TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: opts.clientId ?? CLIENT_ID,
    }),
  };
}

/**
 * Parse a token response into absolute timestamps.
 *
 * `refresh_token` is REQUIRED, even though OAuth permits omitting it to mean
 * "keep using the old one". Rotation is the measured behavior, so an absent
 * field is a protocol change rather than a licence to reuse — and the failure
 * mode of guessing wrong is storing a token the server has already killed and
 * reporting the profile as renewed. Fail loudly instead.
 */
export function parseRefreshResponse(
  body: string,
  now: number,
): RefreshedTokens {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(
      `token endpoint returned non-JSON (${body.slice(0, 120)})`,
    );
  }
  // Arrays are checked explicitly: `typeof [] === "object"`, so a JSON array
  // body would slip through to the field checks and be reported as a missing
  // access_token — a malformed-envelope problem wearing a missing-field message.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("token endpoint returned a non-object");
  }
  const o = raw as Record<string, unknown>;
  const accessToken = o["access_token"];
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error("token response has no access_token");
  }
  const refreshToken = o["refresh_token"];
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new Error(
      "token response has no refresh_token — refusing to assume the one just " +
        "sent survived (it is rotated and dead in every observed response)",
    );
  }
  const expiresIn = typeof o["expires_in"] === "number" ? o["expires_in"] : 0;
  if (expiresIn <= 0) {
    throw new Error("token response has no positive expires_in");
  }
  const rtExpiresIn = o["refresh_token_expires_in"];
  const scope = o["scope"];
  const org = asObject(o["organization"]);
  const acct = asObject(o["account"]);

  const out: RefreshedTokens = {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
  };
  if (typeof rtExpiresIn === "number" && rtExpiresIn > 0) {
    out.refreshTokenExpiresAt = now + rtExpiresIn * 1000;
  }
  if (typeof acct?.["uuid"] === "string") out.accountUuid = acct["uuid"];
  if (typeof acct?.["email_address"] === "string") {
    out.accountEmail = acct["email_address"];
  }
  if (typeof org?.["uuid"] === "string") out.organizationUuid = org["uuid"];
  if (typeof org?.["name"] === "string") out.organizationName = org["name"];
  return out;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The seat the refreshed tokens actually belong to, in `/stark-cc-user`'s own
 * `accountUuid:organizationUuid` form — or null when the response omitted the
 * identity objects.
 */
export function seatKeyOfTokens(t: RefreshedTokens): string | null {
  return t.accountUuid && t.organizationUuid
    ? `${t.accountUuid}:${t.organizationUuid}`
    : null;
}

/**
 * Report — but never act on — a response describing a DIFFERENT seat than the
 * registry expected for this profile.
 *
 * This sees a hole nothing else could. A stored blob is opaque, so the only
 * identity signal used to be `subscriptionType`: `seatIncoherence` catches a
 * team/max swap and nothing finer. With ten seats split across five `max` and
 * five `team` orgs, every realistic mixup was invisible. The token endpoint
 * names the seat outright.
 *
 * WHY THIS IS A WARNING AND NOT A REFUSAL. The first cut skipped the write when
 * the seats disagreed — which THREW AWAY the rotated token and killed the
 * profile, the exact outcome the rest of this module is built to prevent. The
 * old token died the instant the response arrived; the new one is the only live
 * credential for that seat, and the caller is holding it. Refusing does not
 * restore the previous state, it destroys the current one.
 *
 * The disagreement is also not evidence that the credential is wrong. The
 * profile has been refreshing that seat's token all along, so the *registry
 * label* is what drifted — most cheaply by an `add` that re-pointed a name. So:
 * write the credential, surface the mismatch, and let the operator re-label.
 *
 * Fails open on an absent expectation or an identity-less response — an unknown
 * seat is not evidence of a wrong one.
 */
export function seatMismatch(
  t: RefreshedTokens,
  expectedSeatKey: string | undefined,
): string | null {
  if (!expectedSeatKey) return null;
  const actual = seatKeyOfTokens(t);
  if (!actual) return null;
  if (actual.toLowerCase() === expectedSeatKey.toLowerCase()) return null;
  return (
    `the token endpoint resolved this refresh token to seat ${actual}` +
    `${t.accountEmail ? ` (${t.accountEmail}` : ""}` +
    `${t.organizationName ? ` / ${t.organizationName})` : t.accountEmail ? ")" : ""}` +
    `, but the profile is registered as ${expectedSeatKey}`
  );
}

/**
 * Fold refreshed tokens into a stored credentials blob, preserving every field
 * the CLI wrote that we do not own — `subscriptionType`, `rateLimitTier` and
 * anything a later CLI version adds. Only the four token fields move.
 *
 * `scopes` is replaced only when the response listed them; an empty list is
 * "the server did not say", not "no scopes", and writing `[]` would strip the
 * grant the injected-env path depends on.
 */
export function mergeRefreshedCredentials(
  credentials: string,
  t: RefreshedTokens,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentials);
  } catch {
    throw new Error("stored credentials blob is not JSON");
  }
  const blob = asObject(parsed);
  const oauth = asObject(blob?.["claudeAiOauth"]);
  if (!blob || !oauth) {
    throw new Error("stored credentials blob has no claudeAiOauth object");
  }
  const next: Record<string, unknown> = {
    ...oauth,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  };
  if (t.refreshTokenExpiresAt !== undefined) {
    next["refreshTokenExpiresAt"] = t.refreshTokenExpiresAt;
  }
  if (t.scopes.length > 0) next["scopes"] = t.scopes;
  return JSON.stringify({ ...blob, claudeAiOauth: next });
}

/** Read `claudeAiOauth` out of a stored blob, or null when unreadable. */
export function readOauthBlob(
  credentials: string,
): Record<string, unknown> | null {
  try {
    return asObject(asObject(JSON.parse(credentials))?.["claudeAiOauth"]);
  } catch {
    return null;
  }
}

/** Absolute-ms number field, or undefined when absent/malformed. */
function msField(
  oauth: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const v = oauth?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export type RefreshVerdict =
  /** Access token still has more than the margin left. */
  | "fresh"
  /** Access token expired or inside the margin; refresh token still valid. */
  | "due"
  /** Refresh token itself has expired — only `claude /login` recovers this. */
  | "dead"
  /** The blob could not be read well enough to decide. */
  | "unknown";

/**
 * Decide what a profile needs, from its stored blob alone.
 *
 * A missing `expiresAt` counts as due, not unknown: a blob with tokens but no
 * expiry is one a refresh can repair, and treating it as undecidable would park
 * it in a state no command fixes. A missing refresh token is `dead` for the
 * opposite reason — there is nothing to send.
 */
export function classifyRefresh(
  credentials: string,
  now: number,
  marginMs: number = DEFAULT_MARGIN_MS,
): RefreshVerdict {
  const oauth = readOauthBlob(credentials);
  if (!oauth) return "unknown";
  if (typeof oauth["refreshToken"] !== "string" || !oauth["refreshToken"]) {
    return "dead";
  }
  const rtExp = msField(oauth, "refreshTokenExpiresAt");
  if (rtExp !== undefined && rtExp <= now) return "dead";
  const exp = msField(oauth, "expiresAt");
  if (exp === undefined) return "due";
  return exp - now > marginMs ? "fresh" : "due";
}

/** Hours of access-token life left, for display. Null when undecidable. */
export function accessTokenHoursLeft(
  credentials: string,
  now: number,
): number | null {
  const exp = msField(readOauthBlob(credentials), "expiresAt");
  return exp === undefined ? null : Math.round((exp - now) / 3.6e6);
}

/**
 * Does a stored profile still hold the same refresh token as the live Keychain
 * item? Only asked about the ACTIVE seat, where both are supposed to describe
 * one account.
 *
 * The failure this detects: the live `Claude Code-credentials` item is global
 * and every running `claude` rewrites it on refresh, rotating the token. The
 * stored copy keeps the token it was captured with — now dead — while its own
 * `expiresAt` field still reads hours into the future, so `classifyRefresh`
 * reports `fresh` and the active seat is skipped. The profile is silently
 * unusable and nothing says so until a `use` lands a dead credential.
 *
 * Observed twice in one hour on 2026-08-09: `Team-3` held `eeee5555` while the
 * live item had rotated to `ffff6666`, and `Team-4` — skipped as the active seat
 * by a full `refresh --all` — reached `400 invalid_grant` / `401 revoked` and
 * needed a browser login, the one outcome this fleet exists to avoid.
 *
 * **Three states, not a boolean.** The first cut returned `false` for both "the
 * tokens are identical" and "I could not compare them", and the caller printed
 * the former's message either way — an affirmative claim of health over a blob
 * it never parsed. `indeterminate` keeps those apart.
 */
export type ActiveCopyState =
  /** Stored copy holds the same refresh token the live item does. */
  | "match"
  /** Definitely different tokens — the live item has rotated since capture. */
  | "stale"
  /** A blob could not be read well enough to compare. Not a health claim. */
  | "indeterminate";

export function compareActiveCopy(
  storedCredentials: string,
  liveCredentials: string,
): ActiveCopyState {
  const a = readOauthBlob(storedCredentials)?.["refreshToken"];
  const b = readOauthBlob(liveCredentials)?.["refreshToken"];
  if (typeof a !== "string" || !a || typeof b !== "string" || !b) {
    return "indeterminate";
  }
  return a === b ? "match" : "stale";
}

/** What the CLI knows about the live global credentials item. */
export type LiveCredentials =
  | { state: "present"; credentials: string }
  | { state: "absent" }
  | { state: "unreadable" };

export interface ActiveSeatPlan {
  status: "active" | "stale-copy" | "corrupt";
  detail: string;
}

/**
 * Decide what to report for the profile that IS the active login.
 *
 * **It never writes, and that is the whole point of this function's existence.**
 * The first cut re-captured automatically — copying the live blob into the stored
 * profile — which reintroduced the clobber this tool was built to prevent, in a
 * worse form. Reproduced: with two same-plan seats, a live item holding seat A's
 * token (another session refreshed it) while `~/.claude.json` still names seat B
 * makes `compareActiveCopy` report `stale` for B purely because the strings
 * differ — it cannot tell "same account, rotated" from "different account". The
 * only guard available without a network call is `seatIncoherence`, which
 * compares plan strings and so fails open for `team`↔`team` and `max`↔`max`,
 * i.e. about half this fleet. The write would then bottle A's token under B's
 * identity, destroying B's non-re-derivable refresh token.
 *
 * Nothing local can identify whose token the live blob is: the blob carries no
 * account uuid, and the only identity source (`~/.claude.json`) is exactly what
 * has gone stale in this scenario. So detection is the deliverable and repair is
 * the operator's: `add <name>` after quitting other sessions, which is a
 * deliberate act carrying the warning this path cannot enforce.
 *
 * That still fixes the original defect, because the original defect was
 * SILENCE — `Team-4` reported `fresh` while its stored token was revoked.
 */
export function planActiveSeat(
  name: string,
  storedCredentials: string,
  live: LiveCredentials,
): ActiveSeatPlan {
  if (live.state === "absent") {
    return {
      status: "active",
      detail:
        "active login, but no live credentials item exists for this login " +
        "user — cannot compare; run `claude` and log in",
    };
  }
  if (live.state === "unreadable") {
    return {
      status: "active",
      detail:
        "active login; live credentials item unreadable (locked keychain or " +
        "denied ACL) — cannot compare. Unlock and retry; do NOT run `add`",
    };
  }
  switch (compareActiveCopy(storedCredentials, live.credentials)) {
    case "match":
      return {
        status: "active",
        detail: "active login; stored copy matches the live token",
      };
    case "indeterminate":
      // Reported as corrupt, matching what a NON-active profile with the same
      // blob gets from `classifyRefresh`. The active branch returns before that
      // classification runs, so without this the one profile guaranteed to be
      // in use is the one whose corruption goes unreported.
      return {
        status: "corrupt",
        detail:
          "active login, but the stored blob has no readable refresh token — " +
          `re-capture it with \`add ${name}\``,
      };
    case "stale":
      return {
        status: "stale-copy",
        detail:
          "stored copy is STALE — the live token has rotated since capture, so " +
          `the stored one is dead. Not re-captured automatically (the live item ` +
          `is shared and may hold another account's token). Quit other running ` +
          `\`claude\` sessions, then \`add ${name}\`.`,
      };
  }
}

export interface RefreshFlags {
  all: boolean;
  dryRun: boolean;
  marginMs: number;
  names: string[];
  json: boolean;
}

/**
 * Parse `refresh` argv. Unknown flags are a HARD ERROR, matching `next`/`reset`:
 * a typo that silently parsed to "refresh everything for real" is the shape
 * this repo has been bitten by before, and here the cost is a rotated token per
 * profile rather than a wasted run.
 */
export function parseRefreshFlags(args: readonly string[]): RefreshFlags {
  const out: RefreshFlags = {
    all: false,
    dryRun: false,
    marginMs: DEFAULT_MARGIN_MS,
    names: [],
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--margin-hours") {
      const v = args[++i];
      const n = v === undefined ? NaN : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          `--margin-hours needs a non-negative number, got ${JSON.stringify(v)}`,
        );
      }
      out.marginMs = n * 3.6e6;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag ${JSON.stringify(a)}`);
    } else out.names.push(a);
  }
  if (out.all && out.names.length > 0) {
    throw new Error("--all takes no profile names");
  }
  if (!out.all && out.names.length === 0) {
    throw new Error("name a profile, or pass --all");
  }
  return out;
}
