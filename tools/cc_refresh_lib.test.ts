import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLIENT_ID,
  DEFAULT_MARGIN_MS,
  TOKEN_URL,
  accessTokenHoursLeft,
  activeCopyIsStale,
  buildRefreshRequest,
  classifyRefresh,
  mergeRefreshedCredentials,
  parseRefreshFlags,
  parseRefreshResponse,
  readOauthBlob,
  seatKeyOfTokens,
  seatMismatch,
  type RefreshedTokens,
} from "./cc_refresh_lib.ts";

const NOW = 1_786_000_000_000;

/** A token response in the shape measured against the live endpoint. */
function response(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token_type: "Bearer",
    access_token: "at-new",
    expires_in: 28800,
    refresh_token: "rt-new",
    scope: "user:inference user:profile",
    token_uuid: "tok-1",
    refresh_token_expires_in: 2405096,
    organization: { uuid: "org-1", name: "Evinced RD" },
    account: { uuid: "acct-1", email_address: "a@example.com" },
    ...over,
  });
}

function blob(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: NOW + 3.6e6,
      refreshTokenExpiresAt: NOW + 20 * 8.64e7,
      scopes: ["user:inference"],
      subscriptionType: "team",
      rateLimitTier: "default_claude_max_5x",
      ...over,
    },
  });
}

test("buildRefreshRequest sends the grant the endpoint expects", () => {
  const req = buildRefreshRequest("rt-old");
  assert.equal(req.url, TOKEN_URL);
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), {
    grant_type: "refresh_token",
    refresh_token: "rt-old",
    client_id: CLIENT_ID,
  });
});

test("buildRefreshRequest rejects an empty token", () => {
  assert.throws(() => buildRefreshRequest(""), /empty/);
});

test("parseRefreshResponse converts durations to absolute timestamps", () => {
  const t = parseRefreshResponse(response(), NOW);
  assert.equal(t.accessToken, "at-new");
  assert.equal(t.refreshToken, "rt-new");
  assert.equal(t.expiresAt, NOW + 28800 * 1000);
  assert.equal(t.refreshTokenExpiresAt, NOW + 2405096 * 1000);
  assert.deepEqual(t.scopes, ["user:inference", "user:profile"]);
  assert.equal(t.accountUuid, "acct-1");
  assert.equal(t.organizationUuid, "org-1");
  assert.equal(t.accountEmail, "a@example.com");
  assert.equal(t.organizationName, "Evinced RD");
});

test("parseRefreshResponse refuses a response with no refresh_token", () => {
  // Rotation is the measured behavior, so reusing the sent token would store a
  // dead credential and report success.
  const body = JSON.parse(response()) as Record<string, unknown>;
  delete body["refresh_token"];
  assert.throws(
    () => parseRefreshResponse(JSON.stringify(body), NOW),
    /no refresh_token/,
  );
});

test("parseRefreshResponse refuses missing access_token and expires_in", () => {
  assert.throws(
    () => parseRefreshResponse(response({ access_token: "" }), NOW),
    /no access_token/,
  );
  assert.throws(
    () => parseRefreshResponse(response({ expires_in: 0 }), NOW),
    /expires_in/,
  );
});

test("parseRefreshResponse reports non-JSON and non-object bodies", () => {
  assert.throws(() => parseRefreshResponse("<html>502</html>", NOW), /non-JSON/);
  assert.throws(() => parseRefreshResponse("[]", NOW), /non-object/);
  assert.throws(() => parseRefreshResponse("null", NOW), /non-object/);
});

test("seatKeyOfTokens builds the registry's own seat key", () => {
  const t = parseRefreshResponse(response(), NOW);
  assert.equal(seatKeyOfTokens(t), "acct-1:org-1");
});

test("seatMismatch catches a same-plan-type swap the old guard could not see", () => {
  const t = parseRefreshResponse(response(), NOW);
  const msg = seatMismatch(t, "acct-2:org-1");
  assert.ok(msg && /acct-1:org-1/.test(msg) && /acct-2:org-1/.test(msg));
});

test("seatMismatch is silent on a match, and case-insensitive", () => {
  const t = parseRefreshResponse(response(), NOW);
  assert.equal(seatMismatch(t, "acct-1:org-1"), null);
  assert.equal(seatMismatch(t, "ACCT-1:ORG-1"), null);
});

test("seatMismatch fails open when either side is unknown", () => {
  const t = parseRefreshResponse(response(), NOW);
  assert.equal(seatMismatch(t, undefined), null);
  const anon = parseRefreshResponse(
    response({ organization: null, account: null }),
    NOW,
  );
  assert.equal(seatMismatch(anon, "acct-1:org-1"), null);
});

test("mergeRefreshedCredentials keeps fields the CLI owns", () => {
  const t = parseRefreshResponse(response(), NOW);
  const merged = JSON.parse(mergeRefreshedCredentials(blob(), t));
  const o = merged.claudeAiOauth;
  assert.equal(o.accessToken, "at-new");
  assert.equal(o.refreshToken, "rt-new");
  assert.equal(o.expiresAt, NOW + 28800 * 1000);
  // Not ours to rewrite — `seatIncoherence` and the statusline both read these.
  assert.equal(o.subscriptionType, "team");
  assert.equal(o.rateLimitTier, "default_claude_max_5x");
});

test("mergeRefreshedCredentials keeps existing scopes when the server omits them", () => {
  const t = parseRefreshResponse(response({ scope: undefined }), NOW);
  const o = JSON.parse(mergeRefreshedCredentials(blob(), t)).claudeAiOauth;
  assert.deepEqual(o.scopes, ["user:inference"]);
});

test("mergeRefreshedCredentials rejects a blob it cannot understand", () => {
  const t = parseRefreshResponse(response(), NOW);
  assert.throws(() => mergeRefreshedCredentials("not json", t), /not JSON/);
  assert.throws(() => mergeRefreshedCredentials("{}", t), /claudeAiOauth/);
});

test("classifyRefresh: fresh, due, dead, unknown", () => {
  assert.equal(classifyRefresh(blob(), NOW), "fresh");
  // Inside the margin counts as due — renewing early is free, being caught
  // mid-dispatch is not.
  assert.equal(
    classifyRefresh(blob({ expiresAt: NOW + DEFAULT_MARGIN_MS - 1 }), NOW),
    "due",
  );
  assert.equal(classifyRefresh(blob({ expiresAt: NOW - 1 }), NOW), "due");
  assert.equal(
    classifyRefresh(blob({ refreshTokenExpiresAt: NOW - 1 }), NOW),
    "dead",
  );
  assert.equal(classifyRefresh(blob({ refreshToken: "" }), NOW), "dead");
  assert.equal(classifyRefresh("{}", NOW), "unknown");
});

test("classifyRefresh treats a missing access expiry as due, not undecidable", () => {
  const b = blob();
  const parsed = JSON.parse(b);
  delete parsed.claudeAiOauth.expiresAt;
  assert.equal(classifyRefresh(JSON.stringify(parsed), NOW), "due");
});

test("accessTokenHoursLeft goes negative for an expired token", () => {
  assert.equal(accessTokenHoursLeft(blob(), NOW), 1);
  assert.equal(accessTokenHoursLeft(blob({ expiresAt: NOW - 22 * 3.6e6 }), NOW), -22);
  assert.equal(accessTokenHoursLeft("{}", NOW), null);
});

test("readOauthBlob tolerates junk", () => {
  assert.equal(readOauthBlob("nope"), null);
  assert.equal(readOauthBlob("{}"), null);
  assert.ok(readOauthBlob(blob()));
});

test("parseRefreshFlags: names, --all, margin", () => {
  assert.deepEqual(parseRefreshFlags(["Max-1"]), {
    all: false,
    dryRun: false,
    marginMs: DEFAULT_MARGIN_MS,
    names: ["Max-1"],
    json: false,
  });
  const all = parseRefreshFlags(["--all", "--dry-run", "--margin-hours", "2"]);
  assert.equal(all.all, true);
  assert.equal(all.dryRun, true);
  assert.equal(all.marginMs, 2 * 3.6e6);
});

test("parseRefreshFlags hard-errors on typos instead of acting", () => {
  // The repo's own history: `--dry-rn` parsing to "do it for real" is how a
  // preview became a live mutation. Here that would rotate every token.
  assert.throws(() => parseRefreshFlags(["--all", "--dry-rn"]), /unknown flag/);
  assert.throws(() => parseRefreshFlags(["-n", "Max-1"]), /unknown flag/);
  assert.throws(() => parseRefreshFlags(["--all", "Max-1"]), /no profile names/);
  assert.throws(() => parseRefreshFlags([]), /name a profile/);
  assert.throws(
    () => parseRefreshFlags(["--all", "--margin-hours", "soon"]),
    /--margin-hours/,
  );
  assert.throws(
    () => parseRefreshFlags(["--all", "--margin-hours", "-1"]),
    /--margin-hours/,
  );
});

test("a full renewal round-trips into a blob the CLI can consume", () => {
  const t: RefreshedTokens = parseRefreshResponse(response(), NOW);
  const merged = mergeRefreshedCredentials(blob({ expiresAt: NOW - 1 }), t);
  assert.equal(classifyRefresh(merged, NOW), "fresh");
  assert.equal(accessTokenHoursLeft(merged, NOW), 8);
});

test("activeCopyIsStale spots the token rotation nothing else can see", () => {
  // The live item rotated; the stored copy still holds the dead token while its
  // own expiresAt reads hours ahead — so `classifyRefresh` says `fresh` and the
  // profile is silently unusable. This is the Team-3/Team-4 failure.
  const stored = blob({ refreshToken: "rt-old", expiresAt: NOW + 8 * 3.6e6 });
  const live = blob({ refreshToken: "rt-rotated" });
  assert.equal(activeCopyIsStale(stored, live), true);
  assert.equal(classifyRefresh(stored, NOW), "fresh");
});

test("activeCopyIsStale is false when the copies agree", () => {
  assert.equal(activeCopyIsStale(blob(), blob()), false);
});

test("activeCopyIsStale never claims staleness from an unreadable blob", () => {
  // `use`/`add` already refuse on unparseable blobs; a "stale" verdict here
  // would send the operator to re-capture over a different problem.
  assert.equal(activeCopyIsStale("nope", blob()), false);
  assert.equal(activeCopyIsStale(blob(), "{}"), false);
  assert.equal(activeCopyIsStale(blob({ refreshToken: "" }), blob()), false);
});
