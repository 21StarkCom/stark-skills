import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  describeProjection,
  formatAge,
  formatSnapshot,
  parseSnapshot,
  projectUsage,
  rankProfiles,
  sanitizeEmail,
  snapshotPath,
  validateStoredProfile,
  writeClaudeCredsArgv,
  writeProfileArgv,
  type Profile,
  type UsageSnapshot,
} from "./cc_account_lib.ts";

const NOW = 1_800_000_000;

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
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
  const out = parseSnapshot("email=x@y.net\nfive_pct=\n");
  assert.equal(out?.email, "x@y.net");
  assert.equal(out?.fivePct, 0);
  assert.equal(out?.fiveReset, 0);
});

test("snapshot: parse rejects a record with no email", () => {
  assert.equal(parseSnapshot("five_pct=10\n"), null);
  assert.equal(parseSnapshot(""), null);
});

test("snapshot: no truncation can understate usage", () => {
  // The statusline redirects onto the file with no temp+rename (a fork per
  // tick), so a reader can observe a partial write. The safety property is NOT
  // "no prefix parses" — a cut inside the trailing `email=` line still yields
  // an email. It is that `email` is written LAST, so any prefix that parses at
  // all necessarily contains every preceding line complete. A record can
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

test("snapshot: an email truncated mid-write matches no profile, so it reads unknown", () => {
  const full = formatSnapshot(
    snap({ email: "aryeh.stark.1@evinced.net", fivePct: 96 }),
  );
  const partial = parseSnapshot(full.slice(0, full.length - 5));
  assert.notEqual(partial, null, "this prefix does still parse");
  assert.notEqual(
    partial?.email,
    "aryeh.stark.1@evinced.net",
    "but the email is truncated",
  );
  // So the real profile finds no snapshot and is ranked `unknown` (last),
  // rather than inheriting a stray reading.
  const ranked = rankProfiles(
    [{ name: "s1", email: "aryeh.stark.1@evinced.net" }],
    new Map([[sanitizeEmail(partial!.email), partial!]]),
    NOW,
  );
  assert.equal(ranked[0]?.projection.certainty, "unknown");
});

test("snapshot: parse ignores junk lines rather than throwing", () => {
  const out = parseSnapshot("email=x@y.net\n\n# comment\nfive_pct=7\n");
  assert.equal(out?.fivePct, 7);
});

test("snapshot: non-numeric values degrade to 0, never NaN", () => {
  const out = parseSnapshot("email=x@y.net\nfive_pct=abc\n");
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
  { name: "com", email: "aryeh.kiovetsky@evinced.com" },
  { name: "s1", email: "aryeh.stark.1@evinced.net" },
  { name: "s2", email: "aryeh.stark.2@evinced.net" },
];

function snapMap(entries: Record<string, UsageSnapshot>) {
  return new Map(Object.entries(entries));
}

test("rankProfiles: provably-reset beats a low live floor", () => {
  const ranked = rankProfiles(
    PROFILES,
    snapMap({
      "aryeh.stark.1@evinced.net": snap({
        email: "aryeh.stark.1@evinced.net",
        fivePct: 5,
        fiveReset: NOW + 600,
      }),
      "aryeh.stark.2@evinced.net": snap({
        email: "aryeh.stark.2@evinced.net",
        fivePct: 99,
        fiveReset: NOW - 1,
      }),
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
      "aryeh.stark.1@evinced.net": snap({
        email: "aryeh.stark.1@evinced.net",
        fivePct: 88,
        fiveReset: NOW + 600,
      }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.profile.name, "s1", "88% known beats no data");
  assert.equal(ranked.at(-1)?.projection.certainty, "unknown");
});

test("rankProfiles: excludes by profile name and by email", () => {
  const byName = rankProfiles(PROFILES, new Map(), NOW, { exclude: ["s1"] });
  assert.deepEqual(byName.map((r) => r.profile.name), ["com", "s2"]);

  const byEmail = rankProfiles(PROFILES, new Map(), NOW, {
    exclude: ["aryeh.kiovetsky@evinced.com"],
  });
  assert.deepEqual(byEmail.map((r) => r.profile.name), ["s1", "s2"]);
});

test("rankProfiles: exclusion is case-insensitive", () => {
  const out = rankProfiles(PROFILES, new Map(), NOW, {
    exclude: ["ARYEH.STARK.1@EVINCED.NET", "COM"],
  });
  assert.deepEqual(out.map((r) => r.profile.name), ["s2"]);
});

test("rankProfiles: snapshot lookup is case-insensitive on email", () => {
  const ranked = rankProfiles(
    [{ name: "s1", email: "Aryeh.Stark.1@Evinced.NET" }],
    snapMap({
      "aryeh.stark.1@evinced.net": snap({ fivePct: 42, fiveReset: NOW + 60 }),
    }),
    NOW,
  );
  assert.equal(ranked[0]?.projection.fivePct, 42);
  assert.equal(ranked[0]?.projection.certainty, "floor");
});

test("rankProfiles: ties break deterministically by name", () => {
  const m = snapMap({
    "aryeh.stark.1@evinced.net": snap({ fivePct: 10, fiveReset: NOW + 60 }),
    "aryeh.stark.2@evinced.net": snap({ fivePct: 10, fiveReset: NOW + 60 }),
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

// ── stored profile validation ───────────────────────────────────────────

test("validateStoredProfile: accepts a well-formed record", () => {
  const ok = validateStoredProfile({
    credentials: "{\"accessToken\":\"x\"}",
    oauthAccount: { emailAddress: "a@evinced.net", organizationType: "team" },
  });
  assert.equal(ok.oauthAccount["emailAddress"], "a@evinced.net");
});

test("validateStoredProfile: rejects half-valid records", () => {
  // A record missing either half would desync the CLI from ~/.claude.json.
  assert.throws(() => validateStoredProfile(null), /not an object/);
  assert.throws(
    () => validateStoredProfile({ oauthAccount: { emailAddress: "a@b.net" } }),
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
});

// ── paths + formatting ──────────────────────────────────────────────────

test("sanitizeEmail: lowercases and strips path-hostile characters", () => {
  assert.equal(sanitizeEmail("Aryeh.Stark.1@Evinced.NET"), "aryeh.stark.1@evinced.net");
  assert.equal(sanitizeEmail("a/../../b@x.net"), "a_.._.._b@x.net");
  assert.ok(!sanitizeEmail("a/b@x.net").includes("/"), "no path separators");
});

test("snapshotPath: lands under the home .claude dir", () => {
  const p = snapshotPath("/Users/aryeh", "aryeh.stark.1@evinced.net");
  assert.equal(p, "/Users/aryeh/.claude/.cc-usage-aryeh.stark.1@evinced.net");
});

test("keychain argv: writes use -U so an existing item updates in place", () => {
  assert.ok(writeClaudeCredsArgv("blob").includes("-U"));
  assert.ok(writeProfileArgv("s1", "blob").includes("-U"));
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
