// Tests for `tools/stark_persona_lib.ts` — the read-only surface of the
// persona TS port. Covers PersonaRecord/parseRoster (#152), active-state
// (#153), and selection-engine math: computeWeight (#154), date matches
// (#155), fuzzy name match (#155). Write surfaces (DB + selection + emit)
// land in Slice 2 alongside the CLI.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeWeight,
  deleteActive,
  fuzzyMatchPersona,
  getDateMatches,
  loadActive,
  loadRoster,
  parseRoster,
  writeActive,
} from "./stark_persona_lib.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SEED_ROSTER = path.join(REPO_ROOT, "data", "persona", "roster.md");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stark-persona-test-"));
}

// ---------------------------------------------------------------------------
// parseRoster / loadRoster (#152)
// ---------------------------------------------------------------------------

test("loadRoster parses the shipped seed roster", () => {
  const roster = loadRoster(SEED_ROSTER);
  assert.ok(roster.length >= 20, `expected >=20 personas, got ${roster.length}`);
  const slugs = new Set(roster.map((r) => r.slug));
  for (const required of [
    "jules-winnfield",
    "the-dude",
    "guri-alfi",
    "deadpool",
    "walter-white",
    "gandalf",
    "michael-scott",
  ]) {
    assert.ok(slugs.has(required), `roster missing ${required}`);
  }
});

test("loadRoster parses all PersonaRecord fields", () => {
  const roster = loadRoster(SEED_ROSTER);
  const jules = roster.find((r) => r.slug === "jules-winnfield");
  assert.ok(jules, "jules-winnfield not found");
  assert.equal(jules!.name, "Jules Winnfield");
  assert.equal(jules!.source, "Pulp Fiction (1994)");
  assert.equal(jules!.type, "character");
  assert.equal(jules!.traits.length, 5);
  assert.ok(jules!.traits.includes("intense"));
  assert.equal(jules!.catchphrase, "Allow me to retort.");
  assert.ok(jules!.speakingStyle.includes("Biblical"));
  assert.equal(jules!.dateSignals["Samuel L. Jackson birthday"], "1948-12-21");
});

test("parseRoster handles structured list fields and multi-date signals", () => {
  const md = [
    "# Persona Roster",
    "",
    "## Yoda",
    "- **Slug:** yoda",
    "- **Category:** sci-fi",
    "- **Domain:** Wildcards",
    "- **Source:** Star Wars: Episode V - The Empire Strikes Back (1980)",
    "- **Type:** character",
    "- **Archetype:** wise imp",
    "- **Traits:** wise, cryptic, playful",
    "- **Catchphrase:** \"Do or do not.\"",
    "- **Signature quote fragments:**",
    "  - \"Do or do not.\"",
    "  - \"Judge me by my size, do you?\"",
    "- **Voice profile:**",
    "  - Cadence: inverted syntax",
    "  - Humor: dry lesson wrapped in a riddle",
    "- **Speaking style:** Inverted syntax, gentle scolding, and old-master certainty.",
    "- **Date signals:**",
    "  - Star Wars Day: 2026-05-04",
    "  - Frank Oz birthday: 1944-05-25",
    "",
  ].join("\n");

  const roster = parseRoster(md);
  assert.equal(roster.length, 1);
  const yoda = roster[0];
  assert.equal(yoda.category, "sci-fi");
  assert.equal(yoda.domain, "Wildcards");
  assert.equal(yoda.archetype, "wise imp");
  assert.deepEqual(yoda.signatureQuotes, [
    "Do or do not.",
    "Judge me by my size, do you?",
  ]);
  assert.deepEqual(yoda.voiceProfile, [
    "Cadence: inverted syntax",
    "Humor: dry lesson wrapped in a riddle",
  ]);
  assert.deepEqual(yoda.dateSignals, {
    "Star Wars Day": "2026-05-04",
    "Frank Oz birthday": "1944-05-25",
  });
});

test("parseRoster detects person type from seed", () => {
  const roster = loadRoster(SEED_ROSTER);
  const guri = roster.find((r) => r.slug === "guri-alfi");
  assert.ok(guri);
  assert.equal(guri!.type, "person");
  assert.equal(guri!.catchphrase, "Right. No.");
});

test("loadRoster seeds a minimal roster when the file is missing", () => {
  const dir = tmp();
  const missing = path.join(dir, "nonexistent", "roster.md");
  const roster = loadRoster(missing);
  assert.equal(roster.length, 2);
  assert.ok(fs.existsSync(missing));
});

test("parseRoster rejects a section with no Slug", () => {
  const bad = [
    "# Persona Roster",
    "",
    "## No Slug Guy",
    "- **Source:** Somewhere",
    "- **Type:** character",
    "- **Traits:** a, b, c",
    "- **Speaking style:** Talks.",
  ].join("\n");
  assert.throws(() => parseRoster(bad), /missing required field 'Slug'/);
});

test("parseRoster rejects invalid Type", () => {
  const bad = [
    "# Persona Roster",
    "",
    "## Bad Type",
    "- **Slug:** bad-type",
    "- **Source:** Somewhere",
    "- **Type:** robot",
    "- **Traits:** a, b, c",
    "- **Speaking style:** Beeps.",
  ].join("\n");
  assert.throws(() => parseRoster(bad), /invalid type 'robot'/);
});

test("parseRoster rejects too few traits", () => {
  const bad = [
    "# Persona Roster",
    "",
    "## Few Traits",
    "- **Slug:** few-traits",
    "- **Source:** Somewhere",
    "- **Type:** character",
    "- **Traits:** a, b",
    "- **Speaking style:** Talks.",
  ].join("\n");
  assert.throws(() => parseRoster(bad), /2 traits/);
});

test("parseRoster rejects too many traits", () => {
  const bad = [
    "# Persona Roster",
    "",
    "## Many Traits",
    "- **Slug:** many-traits",
    "- **Source:** Somewhere",
    "- **Type:** character",
    "- **Traits:** a, b, c, d, e, f",
    "- **Speaking style:** Talks.",
  ].join("\n");
  assert.throws(() => parseRoster(bad), /6 traits/);
});

// ---------------------------------------------------------------------------
// active.json read/write/delete (#153)
// ---------------------------------------------------------------------------

test("loadActive returns null when the file is missing", () => {
  const dir = tmp();
  const result = loadActive(path.join(dir, "active.json"));
  assert.equal(result, null);
});

test("writeActive + loadActive roundtrip preserves data", () => {
  const dir = tmp();
  const p = path.join(dir, "active.json");
  const data = { persona: "jules-winnfield", session_id: 42 };
  writeActive(data, p);
  assert.deepEqual(loadActive(p), data);
});

test("writeActive is atomic — no .tmp file remains", () => {
  const dir = tmp();
  const p = path.join(dir, "active.json");
  writeActive({ test: true }, p);
  assert.ok(fs.existsSync(p));
  assert.ok(!fs.existsSync(p + ".tmp"));
  // Also assert the Python suffix-replacement form isn't left behind.
  assert.ok(!fs.existsSync(p.replace(/\.json$/, ".tmp")));
});

test("deleteActive removes an existing file", () => {
  const dir = tmp();
  const p = path.join(dir, "active.json");
  writeActive({ persona: "the-dude" }, p);
  assert.ok(fs.existsSync(p));
  deleteActive(p);
  assert.ok(!fs.existsSync(p));
});

test("deleteActive is a no-op when the file is missing", () => {
  const dir = tmp();
  deleteActive(path.join(dir, "active.json")); // must not throw
});

// ---------------------------------------------------------------------------
// computeWeight (#154)
// ---------------------------------------------------------------------------

test("computeWeight: untested persona gets 1.5 discovery boost", () => {
  assert.equal(
    computeWeight({ selection_count: 0, like_count: 0, hate_count: 0 }),
    1.5,
  );
});

test("computeWeight: liked persona scales by +0.4 per net like, capped at 3.0", () => {
  // net=2 -> 1.0 + 0.8 = 1.8
  assert.equal(
    computeWeight({ selection_count: 5, like_count: 3, hate_count: 1 }),
    1.8,
  );
  // net=5 -> 1.0 + 2.0 = 3.0 (max)
  assert.equal(
    computeWeight({ selection_count: 10, like_count: 6, hate_count: 1 }),
    3.0,
  );
  // net=10 -> capped at 5 -> 3.0
  assert.equal(
    computeWeight({ selection_count: 10, like_count: 10, hate_count: 0 }),
    3.0,
  );
});

test("computeWeight: hated persona scales by -0.4 per net hate, floored at 0.2", () => {
  // net=-1 -> 0.6
  assert.equal(
    computeWeight({ selection_count: 3, like_count: 0, hate_count: 1 }),
    0.6,
  );
  // net=-2 -> 0.2 (floor)
  assert.equal(
    computeWeight({ selection_count: 3, like_count: 0, hate_count: 2 }),
    0.2,
  );
  // net=-5 -> 0.2 (floor)
  assert.equal(
    computeWeight({ selection_count: 5, like_count: 0, hate_count: 5 }),
    0.2,
  );
});

test("computeWeight: neutral persona stays at 1.0", () => {
  assert.equal(
    computeWeight({ selection_count: 4, like_count: 2, hate_count: 2 }),
    1.0,
  );
  assert.equal(
    computeWeight({ selection_count: 1, like_count: 0, hate_count: 0 }),
    1.0,
  );
});

// ---------------------------------------------------------------------------
// getDateMatches (#155)
// ---------------------------------------------------------------------------

test("getDateMatches finds the persona whose date signal matches today (m/d)", () => {
  const roster = loadRoster(SEED_ROSTER);
  // Samuel L. Jackson birthday: 1948-12-21 → 12/21
  const matches = getDateMatches(roster, new Date(Date.UTC(2026, 11, 21)));
  const slugs = matches.map((p) => p.slug);
  assert.ok(slugs.includes("jules-winnfield"));
});

test("getDateMatches returns empty on a random non-birthday", () => {
  const roster = loadRoster(SEED_ROSTER);
  const matches = getDateMatches(roster, new Date(Date.UTC(2026, 2, 15)));
  assert.equal(matches.length, 0);
});

// ---------------------------------------------------------------------------
// fuzzyMatchPersona (#155)
// ---------------------------------------------------------------------------

test("fuzzyMatchPersona: exact slug hits", () => {
  const roster = loadRoster(SEED_ROSTER);
  const result = fuzzyMatchPersona(roster, "jules-winnfield");
  assert.ok(result);
  assert.equal(result!.slug, "jules-winnfield");
});

test("fuzzyMatchPersona: exact name, case-insensitive", () => {
  const roster = loadRoster(SEED_ROSTER);
  const result = fuzzyMatchPersona(roster, "the dude");
  assert.ok(result);
  assert.equal(result!.slug, "the-dude");
});

test("fuzzyMatchPersona: close typo resolves", () => {
  const roster = loadRoster(SEED_ROSTER);
  const result = fuzzyMatchPersona(roster, "deadpol");
  assert.ok(result);
  assert.equal(result!.slug, "deadpool");
});

test("fuzzyMatchPersona: returns null on nonsense", () => {
  const roster = loadRoster(SEED_ROSTER);
  const result = fuzzyMatchPersona(roster, "zzz-nonexistent-character-xyz");
  assert.equal(result, null);
});

test("fuzzyMatchPersona: prefix-style substring matches via partial name", () => {
  const roster = loadRoster(SEED_ROSTER);
  const result = fuzzyMatchPersona(roster, "jules");
  assert.ok(result);
  assert.equal(result!.slug, "jules-winnfield");
});
