import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyNextOutcome,
  applyOrder,
  deleteAnyProfileArgv,
  deleteProfileArgv,
  describeProjection,
  mergeProfile,
  nextInCycle,
  orderedProfiles,
  parseNextFlags,
  parseResetFlags,
  formatAge,
  formatSnapshot,
  parseSnapshot,
  projectUsage,
  rankProfiles,
  readClaudeCredsArgv,
  removeProfile,
  resolveClaudeKeychainAccount,
  seatKeyOf,
  sanitizeKey,
  snapshotPath,
  seatIncoherence,
  validateStoredProfile,
  writeClaudeCredsArgv,
  writeProfileArgv,
  type CredentialState,
  type Profile,
  type UsageSnapshot,
} from "./cc_account_lib.ts";

const NOW = 1_800_000_000;

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    seatKey: "acct-a:org-a",
    email: "a@evinced.net",
    fivePct: 40,
    fiveReset: NOW + 3600,
    weekPct: 20,
    weekReset: NOW + 86400,
    stampedAt: NOW - 60,
    ...over,
  };
}

// ── snapshot wire format ────────────────────────────────────────────────

test("snapshot: round-trips through format/parse", () => {
  const s = snap();
  const back = parseSnapshot(formatSnapshot(s));
  assert.deepEqual(back, s);
});

test("snapshot: parse tolerates missing numeric fields", () => {
  const out = parseSnapshot("seat_key=org-x\nemail=x@y.net\nfive_pct=\n");
  assert.equal(out?.seatKey, "org-x");
  assert.equal(out?.fivePct, 0);
  assert.equal(out?.fiveReset, 0);
});

test("snapshot: parse rejects a record with no seat key", () => {
  assert.equal(parseSnapshot("five_pct=10\n"), null);
  assert.equal(parseSnapshot("email=x@y.net\nfive_pct=10\n"), null);
  assert.equal(parseSnapshot(""), null);
});

test("snapshot: no truncation can understate usage", () => {
  // The statusline redirects onto the file with no temp+rename (a fork per
  // tick), so a reader can observe a partial write. The safety property is NOT
  // "no prefix parses" — a cut inside the trailing `seat_key=` line still
  // yields a key. It is that `org_uuid` is written LAST, so any prefix that
  // parses at all necessarily contains every preceding line complete. A record can
  // therefore never be read with a falsely LOW percentage, which is the only
  // direction that causes harm: it would sort the account first and route work
  // to a window that may in fact be exhausted.
  const full = formatSnapshot(snap({ fivePct: 96, fiveReset: NOW + 600 }));
  let parsedAny = false;
  for (let cut = 0; cut <= full.length; cut++) {
    const partial = parseSnapshot(full.slice(0, cut));
    if (partial === null) continue;
    parsedAny = true;
    assert.equal(
      partial.fivePct,
      96,
      `prefix of length ${cut} parsed with an understated percentage`,
    );
    assert.equal(partial.fiveReset, NOW + 600);
  }
  assert.ok(parsedAny, "at least the complete record parses");
});

test("snapshot: a seat key truncated mid-write matches no profile, so it reads unknown", () => {
  const full = formatSnapshot(snap({ seatKey: "acct-s1:org-s1", fivePct: 96 }));
  const partial = parseSnapshot(full.slice(0, full.length - 5));
  assert.notEqual(partial, null, "this prefix does still parse");
  assert.notEqual(partial?.seatKey, "org-s1", "but the org key is truncated");
  // So the real profile finds no snapshot and is ranked `unknown` (last),
  // rather than inheriting a stray reading.
  const ranked = rankProfiles(
    [{ name: "s1", email: "a@evinced.net", seatKey: "acct-s1:org-s1" }],
    new Map([[sanitizeKey(partial!.seatKey), partial!]]),
    NOW,
  );
  assert.equal(ranked[0]?.projection.certainty, "unknown");
});

test("snapshot: parse ignores junk lines rather than throwing", () => {
  const out = parseSnapshot("seat_key=o\n\n# comment\nfive_pct=7\n");
  assert.equal(out?.fivePct, 7);
});

test("snapshot: non-numeric values degrade to 0, never NaN", () => {
  const out = parseSnapshot("seat_key=o\nfive_pct=abc\n");
  assert.equal(out?.fivePct, 0);
  assert.ok(!Number.isNaN(out?.fivePct));
});

// ── the core inference ──────────────────────────────────────────────────

test("projectUsage: a rolled 5h window is provably empty, however stale", () => {
  const p = projectUsage(
    snap({ fivePct: 97, fiveReset: NOW - 1, stampedAt: NOW - 604800 }),
    NOW,
  );
  assert.equal(p.fivePct, 0);
  assert.equal(p.certainty, "reset");
});

test("projectUsage: inside a live window the reading is a lower bound", () => {
  const p = projectUsage(snap({ fivePct: 55, fiveReset: NOW + 10 }), NOW);
  assert.equal(p.fivePct, 55);
  assert.equal(p.certainty, "floor");
});

test("projectUsage: reset epoch of 0 (absent field) is never treated as rolled", () => {
  const p = projectUsage(snap({ fivePct: 33, fiveReset: 0 }), NOW);
  assert.equal(p.certainty, "floor", "0 means unknown, not 'already reset'");
  assert.equal(p.fivePct, 33);
});

test("projectUsage: 5h and 7d windows roll independently", () => {
  const p = projectUsage(
    snap({ fivePct: 80, fiveReset: NOW - 1, weekPct: 64, weekReset: NOW + 99 }),
    NOW,
  );
  assert.equal(p.fivePct, 0, "5h rolled");
  assert.equal(p.weekPct, 64, "7d still live");
});

test("projectUsage: a live 5h window keeps certainty even when 7d rolled", () => {
  const p = projectUsage(
    snap({ fivePct: 91, fiveReset: NOW + 60, weekReset: NOW - 1 }),
    NOW,
  );
  assert.equal(p.certainty, "floor", "5h drives certainty — it gates sessions");
  assert.equal(p.weekPct, 0);
});

test("projectUsage: no snapshot is 'unknown', not 'empty'", () => {
  const p = projectUsage(undefined, NOW);
  assert.equal(p.certainty, "unknown");
  assert.equal(p.ageSec, null);
});

test("projectUsage: age never goes negative on a future-stamped snapshot", () => {
  const p = projectUsage(snap({ stampedAt: NOW + 500 }), NOW);
  assert.equal(p.ageSec, 0);
});

// ── ranking ─────────────────────────────────────────────────────────────

const PROFILES: Profile[] = [
  { name: "com", email: "aryeh.kiovetsky@evinced.com", seatKey: "acct-com:org-com" },
  { name: "s1", email: "aryeh.stark.1@evinced.net", seatKey: "acct-s1:org-s1" },
  { name: "s2", email: "aryeh.stark.2@evinced.net", seatKey: "acct-s2:org-s2" },
];

function snapMap(entries: Record<string, UsageSnapshot>) {
  return new Map(Object.entries(entries));
}

test("rankProfiles: provably-reset beats a low live floor", () => {
  const ranked = rankProfiles(
    PROFILES,
    snapMap({
      "acct-s1:org-s1": snap({ seatKey: "acct-s1:org-s1", fivePct: 5, fiveReset: NOW + 600 }),
      "acct-s2:org-s2": snap({ seatKey: "acct-s2:org-s2", fivePct: 99, fiveReset: NOW - 1 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.profile.name, "s2", "rolled window wins outright");
  assert.equal(ranked[1]?.profile.name, "s1");
});

test("rankProfiles: unknown sorts last — never optimistically assumed free", () => {
  const ranked = rankProfiles(
    PROFILES,
    snapMap({
      "acct-s1:org-s1": snap({ seatKey: "acct-s1:org-s1", fivePct: 88, fiveReset: NOW + 600 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.profile.name, "s1", "88% known beats no data");
  assert.equal(ranked.at(-1)?.projection.certainty, "unknown");
});

test("rankProfiles: excludes by profile name and by seatKey", () => {
  const byName = rankProfiles(PROFILES, new Map(), NOW, { exclude: ["s1"] });
  assert.deepEqual(byName.map((r) => r.profile.name), ["com", "s2"]);

  const byOrg = rankProfiles(PROFILES, new Map(), NOW, {
    exclude: ["acct-com:org-com"],
  });
  assert.deepEqual(byOrg.map((r) => r.profile.name), ["s1", "s2"]);
});

test("rankProfiles: exclusion is case-insensitive", () => {
  const out = rankProfiles(PROFILES, new Map(), NOW, {
    exclude: ["ACCT-S1:ORG-S1", "COM"],
  });
  assert.deepEqual(out.map((r) => r.profile.name), ["s2"]);
});

test("rankProfiles: snapshot lookup is case-insensitive on seatKey", () => {
  const ranked = rankProfiles(
    [{ name: "s1", email: "x@evinced.net", seatKey: "ACCT-S1:ORG-S1" }],
    snapMap({
      "acct-s1:org-s1": snap({ seatKey: "acct-s1:org-s1", fivePct: 42, fiveReset: NOW + 60 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.projection.fivePct, 42);
  assert.equal(ranked[0]?.projection.certainty, "floor");
});

test("rankProfiles: ties break deterministically by name", () => {
  const m = snapMap({
    "acct-s1:org-s1": snap({ seatKey: "acct-s1:org-s1", fivePct: 10, fiveReset: NOW + 60 }),
    "acct-s2:org-s2": snap({ seatKey: "acct-s2:org-s2", fivePct: 10, fiveReset: NOW + 60 }),
  });
  const a = rankProfiles(PROFILES, m, NOW).map((r) => r.profile.name);
  const b = rankProfiles([...PROFILES].reverse(), m, NOW).map(
    (r) => r.profile.name,
  );
  assert.deepEqual(a, b, "input order must not change the pick");
});

test("rankProfiles: empty profile list yields empty ranking", () => {
  assert.deepEqual(rankProfiles([], new Map(), NOW), []);
});

// ── two orgs, one email (the real-world case that broke this) ───────────
//
// aryeh.kiovetsky@evinced.net holds BOTH a seat in the Evinced RD team org and
// a personal Max org. Same address, same accountUuid, different organizationUuid
// — and entirely independent rate-limit budgets. The first cut keyed on email
// and conflated them.

const SHARED_EMAIL = "aryeh.kiovetsky@evinced.net";
const TWO_ORGS: Profile[] = [
  { name: "Net-T0", email: SHARED_EMAIL, seatKey: "acct-t0:org-team", label: "Evinced RD" },
  { name: "Net-M0", email: SHARED_EMAIL, seatKey: "acct-t0:org-max", label: "personal" },
];

test("same-email profiles keep independent usage readings", () => {
  const ranked = rankProfiles(
    TWO_ORGS,
    snapMap({
      "acct-t0:org-team": snap({ seatKey: "acct-t0:org-team", fivePct: 92, fiveReset: NOW + 600 }),
      "acct-t0:org-max": snap({ seatKey: "acct-t0:org-max", fivePct: 4, fiveReset: NOW + 600 }),
    }),
    NOW,
  );
  // Keyed by email these collapsed to one file and reported each other's usage.
  assert.equal(ranked[0]?.profile.name, "Net-M0");
  assert.equal(ranked[0]?.projection.fivePct, 4);
  assert.equal(ranked[1]?.projection.fivePct, 92);
});

test("excluding the active seat does not exclude its same-email sibling", () => {
  const out = rankProfiles(TWO_ORGS, new Map(), NOW, { exclude: ["acct-t0:org-team"] });
  assert.deepEqual(out.map((r) => r.profile.name), ["Net-M0"]);
});

// The inverse collision, which org-only keying missed: aryeh.kiovetsky and
// aryeh.stark.1 are BOTH members of Evinced RD. Same org, different member,
// and Team limits are per-member — so two independent budgets.
const SAME_ORG: Profile[] = [
  { name: "Net-T0", email: "aryeh.kiovetsky@evinced.net", seatKey: "acct-t0:org-team", label: "Evinced RD" },
  { name: "Net-T1", email: "aryeh.stark.1@evinced.net", seatKey: "acct-t1:org-team", label: "Evinced RD" },
];

test("same-org profiles keep independent usage readings", () => {
  const ranked = rankProfiles(
    SAME_ORG,
    snapMap({
      "acct-t0:org-team": snap({ seatKey: "acct-t0:org-team", fivePct: 95, fiveReset: NOW + 600 }),
      "acct-t1:org-team": snap({ seatKey: "acct-t1:org-team", fivePct: 3, fiveReset: NOW + 600 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.profile.name, "Net-T1");
  assert.equal(ranked[0]?.projection.fivePct, 3);
  assert.equal(ranked[1]?.projection.fivePct, 95);
});

test("excluding one member of an org does not exclude the other", () => {
  const out = rankProfiles(SAME_ORG, new Map(), NOW, {
    exclude: ["acct-t0:org-team"],
  });
  assert.deepEqual(out.map((r) => r.profile.name), ["Net-T1"]);
});

test("a profile with no seatKey ranks unknown rather than borrowing a reading", () => {
  const ranked = rankProfiles(
    [{ name: "legacy", email: SHARED_EMAIL }],
    snapMap({
      "acct-t0:org-team": snap({ seatKey: "acct-team:org-team", fivePct: 7, fiveReset: NOW + 600 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.projection.certainty, "unknown");
});

test("snapshotPath: same-email orgs get distinct files", () => {
  assert.notEqual(
    snapshotPath("/h", "org-team"),
    snapshotPath("/h", "org-max"),
  );
});

test("snapshots from earlier keying schemes are rejected, not misattributed", () => {
  // Earlier wire formats ended at `email=`, then at `org_uuid=`. Neither can be
  // assigned to one specific seat, so neither may parse at all.
  const legacy =
    "five_pct=88\nfive_reset=0\nweek_pct=10\nweek_reset=0\n" +
    `stamped_at=${NOW}\nemail=${SHARED_EMAIL}\n`;
  assert.equal(parseSnapshot(legacy), null);
  const orgKeyed = legacy + "org_uuid=org-team\n";
  assert.equal(parseSnapshot(orgKeyed), null);
});

test("seatKeyOf: requires BOTH halves — either alone would merge seats", () => {
  assert.equal(
    seatKeyOf({ accountUuid: "a1", organizationUuid: "o1" }),
    "a1:o1",
  );
  assert.equal(seatKeyOf({ accountUuid: "a1" }), null, "org missing");
  assert.equal(seatKeyOf({ organizationUuid: "o1" }), null, "account missing");
  assert.equal(
    seatKeyOf({ accountUuid: "", organizationUuid: "o1" }),
    null,
    "blank account",
  );
  assert.equal(seatKeyOf({ accountUuid: "a1", organizationUuid: 42 }), null);
  assert.equal(seatKeyOf({}), null);
  assert.equal(seatKeyOf(null), null);
  assert.equal(seatKeyOf(undefined), null);
});

// ── seat coherence ──────────────────────────────────────────────────────

/** Build a stored profile whose halves can be set independently. */
function pair(orgType: string, subType: unknown) {
  const oauth =
    subType === undefined ? {} : { claudeAiOauth: { subscriptionType: subType } };
  return {
    credentials: JSON.stringify(oauth),
    oauthAccount: {
      emailAddress: "a@evinced.net",
      accountUuid: "acct-a",
      organizationUuid: "org-a",
      organizationName: "Evinced RD",
      organizationType: orgType,
    },
  };
}

test("seatIncoherence: flags a max token stored under a team seat", () => {
  // The live Net-T3 shape: `claude_team` seat, `max` credentials. Naming both
  // sides matters — the message is the only place the cause is still visible
  // by the time the CLI reports a billing error.
  const why = seatIncoherence(pair("claude_team", "max"));
  assert.match(String(why), /`max` token/);
  assert.match(String(why), /`claude_team`/);
  assert.match(String(why), /Evinced RD/);
});

test("seatIncoherence: flags a team token stored under a max seat", () => {
  assert.match(String(seatIncoherence(pair("claude_max", "team"))), /`team` token/);
});

test("seatIncoherence: passes matched halves", () => {
  assert.equal(seatIncoherence(pair("claude_team", "team")), null);
  assert.equal(seatIncoherence(pair("claude_max", "max")), null);
});

test("seatIncoherence: fails open on anything it cannot read", () => {
  // Only a DEFINITE contradiction between two KNOWN plan types blocks a
  // switch. An unfamiliar org type, a missing field, or an unparseable
  // credentials blob must never strand a working profile.
  assert.equal(seatIncoherence(pair("claude_enterprise", "max")), null);
  assert.equal(seatIncoherence(pair("claude_team", undefined)), null);
  assert.equal(seatIncoherence(pair("claude_team", "")), null);
  assert.equal(seatIncoherence(pair("claude_team", 7)), null);
  assert.equal(
    seatIncoherence({ ...pair("claude_team", "max"), credentials: "not json" }),
    null,
  );
  assert.equal(
    seatIncoherence({
      credentials: JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } }),
      oauthAccount: { emailAddress: "a@b.net" },
    }),
    null,
  );
});

// ── stored profile validation ───────────────────────────────────────────

test("validateStoredProfile: accepts a well-formed record", () => {
  const ok = validateStoredProfile({
    credentials: "{\"accessToken\":\"x\"}",
    oauthAccount: {
      emailAddress: "a@evinced.net",
      organizationType: "team",
      accountUuid: "acct-a",
      organizationUuid: "org-a",
    },
  });
  assert.equal(ok.oauthAccount["emailAddress"], "a@evinced.net");
  assert.equal(seatKeyOf(ok.oauthAccount), "acct-a:org-a");
});

test("validateStoredProfile: rejects a record missing either seat half", () => {
  // Without both halves a stored profile cannot be told apart from a sibling
  // seat sharing its address or its org — refused, not stored ambiguously.
  for (const acct of [
    { emailAddress: "a@evinced.net" },
    { emailAddress: "a@evinced.net", accountUuid: "a1" },
    { emailAddress: "a@evinced.net", organizationUuid: "o1" },
  ]) {
    assert.throws(
      () => validateStoredProfile({ credentials: "x", oauthAccount: acct }),
      /accountUuid.*organizationUuid/,
    );
  }
});

test("validateStoredProfile: rejects half-valid records", () => {
  // A record missing either half would desync the CLI from ~/.claude.json.
  assert.throws(() => validateStoredProfile(null), /not an object/);
  assert.throws(
    () =>
      validateStoredProfile({
        oauthAccount: {
          emailAddress: "a@b.net",
          accountUuid: "a",
          organizationUuid: "o",
        },
      }),
    /credentials/,
  );
  assert.throws(
    () => validateStoredProfile({ credentials: "x" }),
    /oauthAccount/,
  );
  assert.throws(
    () => validateStoredProfile({ credentials: "", oauthAccount: {} }),
    /credentials/,
  );
  assert.throws(
    () => validateStoredProfile({ credentials: "x", oauthAccount: {} }),
    /emailAddress/,
  );
  assert.throws(
    () =>
      validateStoredProfile({
        credentials: "x",
        oauthAccount: {
          emailAddress: "a@b.net",
          accountUuid: "a1",
          organizationUuid: "",
        },
      }),
    /organizationUuid/,
  );
});

// ── removal ─────────────────────────────────────────────────────────────

test("removeProfile: drops the named entry and reports it", () => {
  const { profiles, removed } = removeProfile(
    [
      { name: "Com-Max", email: "a@x.com", seatKey: "a:1", order: 0 },
      { name: "Net-T0", email: "b@x.net", seatKey: "b:2", order: 1 },
    ],
    "Net-T0",
  );
  assert.equal(removed?.name, "Net-T0");
  assert.deepEqual(
    profiles.map((p) => p.name),
    ["Com-Max"],
  );
});

test("removeProfile: name match is case-insensitive", () => {
  const { removed } = removeProfile(
    [{ name: "Net-T0", email: "b@x.net", seatKey: "b:2" }],
    "net-t0",
  );
  assert.equal(removed?.name, "Net-T0");
});

test("removeProfile: an unknown name removes nothing", () => {
  const { profiles, removed } = removeProfile(
    [{ name: "Com-Max", email: "a@x.com", seatKey: "a:1" }],
    "nope",
  );
  assert.equal(removed, undefined);
  assert.equal(profiles.length, 1);
});

test("removeProfile: survivors keep their slots, gaps and all", () => {
  // Order values are a sort key, not positions — renumbering after a removal
  // would silently rewrite an arrangement the user set by hand.
  const { profiles } = removeProfile(
    [
      { name: "a", email: "a@x", seatKey: "a:1", order: 0 },
      { name: "b", email: "b@x", seatKey: "b:2", order: 1 },
      { name: "c", email: "c@x", seatKey: "c:3", order: 2 },
    ],
    "b",
  );
  assert.equal(profiles.find((p) => p.name === "a")?.order, 0);
  assert.equal(profiles.find((p) => p.name === "c")?.order, 2);
  assert.deepEqual(
    orderedProfiles(profiles).map((p) => p.name),
    ["a", "c"],
  );
});

// ── next flags ──────────────────────────────────────────────────────────

test("parseNextFlags: switching is the default — no flag needed", () => {
  // `next` exists to advance the rotation. Requiring `--apply` made the common
  // case two commands and the bare form a no-op that looked like a failure.
  assert.deepEqual(parseNextFlags([]), { apply: true, best: false, unknown: [] });
});

test("parseNextFlags: --dry-run previews without switching", () => {
  assert.deepEqual(parseNextFlags(["--dry-run"]), {
    apply: false,
    best: false,
    unknown: [],
  });
});

test("parseNextFlags: --apply still accepted, now a no-op", () => {
  // Kept for muscle memory and any script that already passes it.
  assert.deepEqual(parseNextFlags(["--apply"]), {
    apply: true,
    best: false,
    unknown: [],
  });
});

test("parseNextFlags: --dry-run wins over --apply", () => {
  // The safe reading of a contradictory pair: never switch unasked.
  assert.deepEqual(parseNextFlags(["--apply", "--dry-run"]), {
    apply: false,
    best: false,
    unknown: [],
  });
});

test("parseNextFlags: --best composes with both modes", () => {
  assert.deepEqual(parseNextFlags(["--best"]), {
    apply: true,
    best: true,
    unknown: [],
  });
  assert.deepEqual(parseNextFlags(["--best", "--dry-run"]), {
    apply: false,
    best: true,
    unknown: [],
  });
});

// ── registry merge ──────────────────────────────────────────────────────

test("mergeProfile: re-adding the same name keeps its rotation slot", () => {
  // `add` is documented as safe to re-run to refresh a rotated token — that
  // must not silently unplace the profile from the cycle.
  const { profiles } = mergeProfile(
    [
      { name: "Com-Max", email: "a@x.com", seatKey: "a:1", order: 0 },
      { name: "Net-T0", email: "b@x.net", seatKey: "b:2", order: 1 },
    ],
    { name: "Com-Max", email: "a@x.com", seatKey: "a:1" },
  );
  assert.equal(profiles.find((p) => p.name === "Com-Max")?.order, 0);
  assert.equal(profiles.length, 2);
});

test("mergeProfile: renaming a seat inherits the displaced entry's slot", () => {
  const { profiles, displaced } = mergeProfile(
    [{ name: "old", email: "a@x.com", seatKey: "a:1", order: 3 }],
    { name: "new", email: "a@x.com", seatKey: "a:1" },
  );
  assert.equal(displaced?.name, "old");
  assert.equal(profiles.find((p) => p.name === "new")?.order, 3);
  assert.ok(!profiles.some((p) => p.name === "old"));
});

test("mergeProfile: a genuinely new seat joins unplaced", () => {
  const { profiles, displaced } = mergeProfile(
    [{ name: "a", email: "a@x.com", seatKey: "a:1", order: 0 }],
    { name: "b", email: "b@x.net", seatKey: "b:2" },
  );
  assert.equal(displaced, undefined);
  assert.equal(profiles.find((p) => p.name === "b")?.order, undefined);
});

test("mergeProfile: dedupes on name and seat, never on email or org", () => {
  // Two seats sharing an address must both survive an add of either.
  const { profiles } = mergeProfile(
    [
      { name: "T0", email: "a@x.net", seatKey: "acct:org-t", order: 0 },
      { name: "M0", email: "a@x.net", seatKey: "acct:org-m", order: 1 },
    ],
    { name: "T0", email: "a@x.net", seatKey: "acct:org-t" },
  );
  assert.ok(profiles.some((p) => p.name === "M0"));
  assert.equal(profiles.length, 2);
});

// ── paths + formatting ──────────────────────────────────────────────────

test("sanitizeKey: lowercases, strips path-hostile chars, keeps seats distinct", () => {
  assert.equal(sanitizeKey("A1:B5C2BF52-78F2-4DD7"), "a1_b5c2bf52-78f2-4dd7");
  assert.equal(sanitizeKey("a/../../b"), "a_.._.._b");
  assert.ok(!sanitizeKey("a/b").includes("/"), "no path separators");
});

test("snapshotPath: keyed by seat, lands under the home .claude dir", () => {
  const p = snapshotPath("/Users/aryeh", "67ce42fe:32e87edd");
  assert.equal(p, "/Users/aryeh/.claude/.cc-usage-67ce42fe_32e87edd");
});

test("keychain argv: writes use -U so an existing item updates in place", () => {
  assert.ok(writeClaudeCredsArgv("aryeh", "blob").includes("-U"));
  assert.ok(writeProfileArgv("s1", "blob").includes("-U"));
});

test("keychain argv: live-creds access targets the caller's account, never `root`", () => {
  // The Claude CLI keys its `Claude Code-credentials` item by the login user.
  // The original release hardcoded `root` — a stale relic entry — so `use`
  // wrote credentials the CLI never read and `add` captured a dead Feb token
  // into every profile. The account is now caller-supplied.
  const read = readClaudeCredsArgv("aryeh");
  assert.deepEqual(read.slice(read.indexOf("-a"), read.indexOf("-a") + 2), [
    "-a",
    "aryeh",
  ]);
  assert.ok(!read.includes("root"));
  const write = writeClaudeCredsArgv("aryeh", "blob");
  assert.ok(write.includes("aryeh"));
  assert.ok(!write.includes("root"));
});

test("resolveClaudeKeychainAccount: mirrors the CLI — USER env, `unknown` fallback", () => {
  // Evidence for the mirror: the CLI itself left an `acct=unknown` item behind
  // when run with USER unset. Matching its resolution exactly means this tool
  // always touches the entry the CLI will actually read in the same env.
  assert.equal(resolveClaudeKeychainAccount({ USER: "aryeh" }), "aryeh");
  assert.equal(resolveClaudeKeychainAccount({ USER: " aryeh " }), "aryeh");
  assert.equal(resolveClaudeKeychainAccount({}), "unknown");
  assert.equal(resolveClaudeKeychainAccount({ USER: "" }), "unknown");
  assert.equal(resolveClaudeKeychainAccount({ USER: "   " }), "unknown");
});

test("keychain argv: profile deletes are scoped to one profile item", () => {
  const argv = deleteProfileArgv("s1");
  assert.ok(argv.includes("delete-generic-password"));
  assert.ok(argv.includes("stark-cc-token"));
  assert.ok(argv.includes("s1"));
  // A delete that named no account, or named the live service, would wipe the
  // login the user is currently authenticated as.
  assert.ok(argv.includes("-a"));
  assert.ok(!argv.includes("Claude Code-credentials"));
});

test("keychain argv: the un-named delete stays scoped to stark-cc-token", () => {
  // `reset` loops this to drain orphaned records too, so it deliberately names
  // NO account. The service scope is therefore the only thing standing between
  // it and the live login — assert it hard.
  const argv = deleteAnyProfileArgv();
  assert.deepEqual(argv, [
    "delete-generic-password",
    "-s",
    "stark-cc-token",
  ]);
  assert.ok(!argv.includes("Claude Code-credentials"));
  assert.ok(!argv.includes("-a"), "naming an account would defeat the drain");
});

test("parseResetFlags: destroys nothing without --yes", () => {
  assert.equal(parseResetFlags([]).confirmed, false);
  assert.equal(parseResetFlags(["--snapshots"]).confirmed, false);
  assert.equal(parseResetFlags(["--yes"]).confirmed, true);
});

test("parseResetFlags: --dry-run overrides --yes, in either order", () => {
  // A contradictory pair must resolve to the reading that destroys nothing —
  // OAuth blobs cannot be re-derived.
  assert.equal(parseResetFlags(["--yes", "--dry-run"]).confirmed, false);
  assert.equal(parseResetFlags(["--dry-run", "--yes"]).confirmed, false);
});

test("parseResetFlags: reports unknown flags instead of ignoring them", () => {
  // `--snapshot` silently parsing to false would keep state the operator asked
  // to clear, and a typo'd `--yes` reading as a no-op is only safe if it is
  // explained. Both surface as unknown.
  assert.deepEqual(parseResetFlags(["--snapshot"]).unknown, ["--snapshot"]);
  assert.deepEqual(parseResetFlags(["--Yes"]).unknown, ["--Yes"]);
  assert.deepEqual(parseResetFlags(["--yes", "--snapshots"]).unknown, []);
});

test("parseResetFlags: --snapshots is independent of confirmation", () => {
  assert.equal(parseResetFlags(["--snapshots"]).snapshots, true);
  assert.equal(parseResetFlags(["--yes", "--snapshots"]).snapshots, true);
  assert.equal(parseResetFlags(["--yes"]).snapshots, false);
});

test("keychain argv: profile writes target the stark-cc-token service", () => {
  const argv = writeProfileArgv("s1", "blob");
  assert.ok(argv.includes("stark-cc-token"));
  assert.ok(argv.includes("s1"));
  // The live Claude item must never be touched by a profile write.
  assert.ok(!argv.includes("Claude Code-credentials"));
});

test("formatAge: scales across units", () => {
  assert.equal(formatAge(45), "45s");
  assert.equal(formatAge(120), "2m");
  assert.equal(formatAge(7200), "2h");
  assert.equal(formatAge(172800), "2d");
});

test("describeProjection: labels reset, floor, and unknown distinctly", () => {
  assert.match(
    describeProjection(projectUsage(snap({ fiveReset: NOW - 1 }), NOW)),
    /reset/,
  );
  assert.match(
    describeProjection(projectUsage(snap({ fiveReset: NOW + 60 }), NOW)),
    /floor/,
  );
  assert.match(describeProjection(projectUsage(undefined, NOW)), /unknown/);
});


// ── rotation cycle ──────────────────────────────────────────────────────

const CYCLE: Profile[] = [
  { name: "Com-Max", email: "k@evinced.com", seatKey: "a0:o0", order: 0 },
  { name: "Net-T0", email: "k@evinced.net", seatKey: "a1:team", order: 1 },
  { name: "Net-M0", email: "k@evinced.net", seatKey: "a1:max", order: 2 },
  { name: "Net-T1", email: "s1@evinced.net", seatKey: "a2:team", order: 3 },
];

test("orderedProfiles: placed ascend, unplaced follow by name", () => {
  const mixed: Profile[] = [
    { name: "zeta", email: "z@x.net", seatKey: "z:1" },
    { name: "alpha", email: "a@x.net", seatKey: "a:1" },
    { name: "second", email: "s@x.net", seatKey: "s:1", order: 1 },
    { name: "first", email: "f@x.net", seatKey: "f:1", order: 0 },
  ];
  assert.deepEqual(
    orderedProfiles(mixed).map((p) => p.name),
    ["first", "second", "alpha", "zeta"],
  );
});

test("orderedProfiles: does not mutate its input", () => {
  const input = [...CYCLE].reverse();
  const before = input.map((p) => p.name);
  orderedProfiles(input);
  assert.deepEqual(input.map((p) => p.name), before);
});

test("nextInCycle: advances one step", () => {
  assert.equal(nextInCycle(CYCLE, "a1:team")?.name, "Net-M0");
  assert.equal(nextInCycle(CYCLE, "a1:max")?.name, "Net-T1");
});

test("nextInCycle: wraps at the end", () => {
  assert.equal(nextInCycle(CYCLE, "a2:team")?.name, "Com-Max");
});

test("nextInCycle: case-insensitive on the active seat", () => {
  assert.equal(nextInCycle(CYCLE, "A1:TEAM")?.name, "Net-M0");
});

test("nextInCycle: an unregistered active seat starts the cycle", () => {
  assert.equal(nextInCycle(CYCLE, "unknown:seat")?.name, "Com-Max");
  assert.equal(nextInCycle(CYCLE, null)?.name, "Com-Max");
});

test("nextInCycle: skips profiles that cannot be switched to", () => {
  // No stored credentials => stopping there would dead-end the rotation.
  const ok = (p: Profile) => p.name !== "Net-M0";
  assert.equal(nextInCycle(CYCLE, "a1:team", ok)?.name, "Net-T1");
});

test("nextInCycle: skipping the active profile still advances", () => {
  const ok = (p: Profile) => p.name !== "Net-T0";
  // active is Net-T0 itself, which is filtered out — fall back to cycle start
  assert.equal(nextInCycle(CYCLE, "a1:team", ok)?.name, "Com-Max");
});

test("nextInCycle: a single eligible profile returns itself", () => {
  const ok = (p: Profile) => p.name === "Com-Max";
  assert.equal(nextInCycle(CYCLE, "a0:o0", ok)?.name, "Com-Max");
});

test("nextInCycle: nothing eligible returns null", () => {
  assert.equal(nextInCycle(CYCLE, "a1:team", () => false), null);
  assert.equal(nextInCycle([], "a1:team"), null);
});

test("nextInCycle: full lap visits every profile exactly once", () => {
  const seen: string[] = [];
  let seat = "a0:o0";
  for (let i = 0; i < CYCLE.length; i++) {
    const n = nextInCycle(CYCLE, seat);
    assert.ok(n, "cycle must not dead-end");
    seen.push(n.name);
    seat = n.seatKey;
  }
  assert.deepEqual(seen, ["Net-T0", "Net-M0", "Net-T1", "Com-Max"]);
  assert.equal(new Set(seen).size, CYCLE.length, "no repeats within one lap");
});

test("applyOrder: places listed names in the given sequence", () => {
  const out = applyOrder(CYCLE, ["Net-T1", "Com-Max"]);
  assert.deepEqual(
    orderedProfiles(out).map((p) => p.name),
    ["Net-T1", "Com-Max", "Net-M0", "Net-T0"], // unlisted fall back to name order
  );
});

test("applyOrder: omitted profiles stay in the cycle, just unplaced", () => {
  const out = applyOrder(CYCLE, ["Net-T1"]);
  assert.equal(out.length, CYCLE.length, "nobody is dropped");
  assert.equal(out.find((p) => p.name === "Net-T1")?.order, 0);
  assert.equal(out.find((p) => p.name === "Com-Max")?.order, undefined);
});

test("applyOrder: is case-insensitive and ignores unknown names", () => {
  const out = applyOrder(CYCLE, ["net-t1", "ghost"]);
  assert.equal(out.find((p) => p.name === "Net-T1")?.order, 0);
});

// ---------------------------------------------------------------------------
// classifyNextOutcome — the `next` decision table
//
// Previously inlined in `cmdNext`, so the exit-code contract this covers was
// reachable only by running the binary against a real Keychain.
// ---------------------------------------------------------------------------

const SEAT_A = "aaaa:oooo";
const SEAT_B = "bbbb:oooo";

function prof(name: string, seatKey: string, order?: number): Profile {
  return {
    name,
    email: `${name}@example.net`,
    seatKey,
    ...(order === undefined ? {} : { order }),
  };
}

function creds(
  entries: Record<string, CredentialState>,
): Map<string, CredentialState> {
  return new Map(Object.entries(entries));
}

const pickFirst = (c: readonly Profile[]): Profile | null => c[0] ?? null;

test("classifyNextOutcome: empty registry is the only `add`-fixable state", () => {
  const out = classifyNextOutcome({
    profiles: [],
    active: SEAT_A,
    credentials: creds({}),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "empty");
});

test("classifyNextOutcome: an unreadable keychain is NOT reported as absent", () => {
  // The destructive confusion: `absent` prescribes `add`, which overwrites the
  // stored record with the current login. An unreadable probe says nothing
  // about what the keychain holds, so it must never reach `stale` — the list
  // whose printed remedy is exactly that.
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B)],
    active: SEAT_A,
    credentials: creds({ P1: "unreadable", P2: "present" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "switch");
  assert.deepEqual(out.kind === "switch" ? [...out.stale] : ["!"], []);
  assert.deepEqual(out.kind === "switch" ? [...out.unreadable] : [], ["P1"]);
});

test("classifyNextOutcome: one unreadable profile does NOT block a healthy switch", () => {
  // The first version returned `unreadable` here, so a single denied ACL
  // hard-failed the whole rotation while other profiles sat switchable — the
  // operator's window is exhausted and the tool refuses to help. It blocks
  // only when nothing is usable; otherwise the names ride along as a warning.
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B), prof("Locked", "cccc:oooo")],
    active: SEAT_A,
    credentials: creds({ P1: "present", P2: "present", Locked: "unreadable" }),
    pick: (c) => c.find((p) => p.name === "P2") ?? null,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "switch");
  assert.deepEqual(out.kind === "switch" ? [...out.unreadable] : [], ["Locked"]);
});

test("classifyNextOutcome: unreadable blocks only when nothing is usable", () => {
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B)],
    active: SEAT_A,
    credentials: creds({ P1: "unreadable", P2: "absent" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "unreadable");
  assert.deepEqual(out.kind === "unreadable" ? [...out.names] : [], ["P1"]);
});

test("classifyNextOutcome: an incoherent profile is skipped, not switched to", () => {
  // `use` refuses an incoherent profile, so treating it as usable dead-ends
  // the rotation forever: the picker is deterministic and selects it again on
  // every run, never reaching the healthy profiles behind it.
  const out = classifyNextOutcome({
    profiles: [prof("Bad", SEAT_B), prof("Good", "cccc:oooo")],
    active: SEAT_A,
    credentials: creds({ Bad: "incoherent", Good: "present" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "switch");
  assert.equal(out.kind === "switch" ? out.target.name : "", "Good");
  assert.deepEqual(out.kind === "switch" ? [...out.unreadable] : [], ["Bad"]);
});

test("classifyNextOutcome: every profile incoherent is its own outcome", () => {
  const out = classifyNextOutcome({
    profiles: [prof("Bad", SEAT_B)],
    active: SEAT_A,
    credentials: creds({ Bad: "incoherent" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "all-incoherent");
});

test("classifyNextOutcome: no stored credentials anywhere names every profile", () => {
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B)],
    active: SEAT_A,
    credentials: creds({ P1: "absent", P2: "absent" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "no-credentials");
  assert.deepEqual(out.kind === "no-credentials" ? [...out.names] : [], ["P1", "P2"]);
});

test("classifyNextOutcome: cycle mode still recovers when the active seat is unknown", () => {
  // The sole route back from a ~/.claude.json that lost its oauthAccount:
  // cycle mode's documented "start from the beginning". Refusing here removed
  // the one command that writes both credential halves back.
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B)],
    active: null,
    credentials: creds({ P1: "present", P2: "present" }),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "switch");
  assert.equal(out.kind === "switch" ? out.target.name : "", "P1");
});

test("classifyNextOutcome: an unknown active seat refuses rather than switching", () => {
  // The regression this pins: the headroom picker excludes the active seat by
  // passing it to rankProfiles, so a null active excludes NOTHING — it would
  // return the live account and report a successful switch onto the seat
  // already in use.
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A)],
    active: null,
    credentials: creds({ P1: "present" }),
    pick: pickFirst,
    // --best excludes the active seat via rankProfiles, so a null active
    // excludes nothing and the picker would return the live account.
    pickerExcludesActive: true,
  });
  assert.equal(out.kind, "unknown-active");
});

test("classifyNextOutcome: only the active seat is usable → already-active, not empty", () => {
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A)],
    active: SEAT_A,
    // A picker that excludes the active seat (headroom mode) returns null here.
    credentials: creds({ P1: "present" }),
    pick: () => null,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "already-active");
  assert.equal(out.kind === "already-active" ? out.target.name : "", "P1");
});

test("classifyNextOutcome: two profiles on ONE seat name the same profile either mode", () => {
  // Must bite on a picker that would choose something OTHER than the
  // ordered-first profile. The first version passed `pickFirst`, which returns
  // the same entry `orderedProfiles` does, and both pickers took the
  // all-active early return before `pick` was ever called — so the assertion
  // held by construction and the mode-divergence fix was unpinned.
  const profiles = [prof("Zed", SEAT_A, 0), prof("P1", SEAT_A, 1)];
  const credentials = creds({ Zed: "present", P1: "present" });
  let pickCalled = false;
  const lastPicker = (c: readonly Profile[]): Profile | null => {
    pickCalled = true;
    return c[c.length - 1] ?? null;
  };
  const excluding = classifyNextOutcome({
    profiles,
    active: SEAT_A,
    credentials,
    pick: () => null,
    pickerExcludesActive: true,
  });
  const permissive = classifyNextOutcome({
    profiles,
    active: SEAT_A,
    credentials,
    pick: lastPicker,
    pickerExcludesActive: false,
  });
  assert.equal(excluding.kind, "already-active");
  assert.equal(permissive.kind, "already-active");
  assert.equal(
    excluding.kind === "already-active" ? excluding.target.name : "x",
    permissive.kind === "already-active" ? permissive.target.name : "y",
  );
  // Both must name the ordered-first profile, NOT whatever the picker prefers.
  assert.equal(
    permissive.kind === "already-active" ? permissive.target.name : "",
    "Zed",
  );
  assert.equal(pickCalled, false, "all-active short-circuits before pick");
});

test("classifyNextOutcome: a real switch reports the profiles it had to skip", () => {
  // The silent-collapse case: without `stale`, a rotation emptied down to one
  // usable seat reported a clean result and never named the broken profiles.
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("P2", SEAT_B), prof("Ghost", "cccc:oooo")],
    active: SEAT_A,
    credentials: creds({ P1: "present", P2: "present", Ghost: "absent" }),
    pick: (c) => c.find((p) => p.name === "P2") ?? null,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "switch");
  assert.equal(out.kind === "switch" ? out.target.name : "", "P2");
  assert.deepEqual(out.kind === "switch" ? [...out.stale] : [], ["Ghost"]);
});

test("classifyNextOutcome: already-active also reports stale profiles", () => {
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A), prof("Ghost", SEAT_B)],
    active: SEAT_A,
    credentials: creds({ P1: "present", Ghost: "absent" }),
    pick: () => null,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "already-active");
  assert.deepEqual(out.kind === "already-active" ? [...out.stale] : [], ["Ghost"]);
});

test("classifyNextOutcome: a missing credentials entry defaults to absent", () => {
  const out = classifyNextOutcome({
    profiles: [prof("P1", SEAT_A)],
    active: SEAT_A,
    credentials: creds({}),
    pick: pickFirst,
    pickerExcludesActive: false,
  });
  assert.equal(out.kind, "no-credentials");
});

// ---------------------------------------------------------------------------
// parseNextFlags — unknown flags
// ---------------------------------------------------------------------------

test("parseNextFlags: unknown flags are surfaced, not ignored", () => {
  // Each of these used to parse to `{apply: true}` — a live account swap when
  // a preview was asked for.
  for (const typo of ["--dry-rn", "--dryrun", "-n", "--bset"]) {
    assert.deepEqual(parseNextFlags([typo]).unknown, [typo], `${typo} must be reported`);
  }
});

test("parseNextFlags: the known flags still parse and report nothing unknown", () => {
  assert.deepEqual(parseNextFlags(["--dry-run"]), {
    apply: false,
    best: false,
    unknown: [],
  });
  assert.deepEqual(parseNextFlags(["--best", "--apply"]), {
    apply: true,
    best: true,
    unknown: [],
  });
  assert.deepEqual(parseNextFlags([]), { apply: true, best: false, unknown: [] });
});
