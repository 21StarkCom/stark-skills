// Slice 2 tests for `tools/stark_persona_lib.ts` — write surface:
// SQLite schema (#151), syncWeights, selectSinglePersona (#154),
// selectCombo (#156), recordRating + favorite-combo dilution (#158),
// add-persona sanitization (#160), session-end / deactivate, and
// insights emission via `tools/emit_queue_lib.ts` (#162 port).

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addPersona,
  detectType,
  initDb,
  loadRoster,
  makeRandom,
  recordRating,
  recordSurveyAnswer,
  sanitizeInput,
  selectCombo,
  selectSinglePersona,
  syncWeights,
} from "./stark_persona_lib.ts";
import type { PersonaRecord } from "./stark_persona_lib.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SEED_ROSTER = path.join(REPO_ROOT, "data", "persona", "roster.md");
const EXPECTED_TABLES = new Set([
  "sessions",
  "ratings",
  "survey_responses",
  "weights",
  "favorite_combos",
]);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stark-persona-writes-"));
}

interface TestCtx {
  dir: string;
  dbFile: string;
  activeFile: string;
  queueDir: string;
  env: NodeJS.ProcessEnv;
}

function ctx(): TestCtx {
  const dir = tmp();
  const queueDir = path.join(dir, "stark-insights");
  return {
    dir,
    dbFile: path.join(dir, "persona.db"),
    activeFile: path.join(dir, "active.json"),
    queueDir,
    env: {
      ...process.env,
      STARK_QUEUE_DIR: queueDir,
      CLAUDE_SESSION_ID: "test-session-write",
    },
  };
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function queueEvents(queueDir: string): Array<Record<string, unknown>> {
  const dbFile = path.join(queueDir, "queue.db");
  if (!fs.existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db
      .prepare("SELECT event_json FROM pending ORDER BY id")
      .all() as Array<{ event_json: string }>;
    return rows.map((r) => JSON.parse(r.event_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// initDb (#151)
// ---------------------------------------------------------------------------

test("initDb creates all expected tables", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  try {
    assert.deepEqual(tableNames(db), EXPECTED_TABLES);
  } finally {
    db.close();
  }
});

test("initDb is idempotent", () => {
  const c = ctx();
  initDb(c.dbFile).close();
  const db = initDb(c.dbFile);
  try {
    assert.deepEqual(tableNames(db), EXPECTED_TABLES);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// syncWeights
// ---------------------------------------------------------------------------

test("syncWeights creates a 1.5 weight row for every roster entry", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const rows = db
      .prepare("SELECT persona, weight FROM weights ORDER BY persona")
      .all() as Array<{ persona: string; weight: number }>;
    const slugs = new Set(rows.map((r) => r.persona));
    assert.deepEqual(slugs, new Set(roster.map((r) => r.slug)));
    for (const row of rows) assert.equal(row.weight, 1.5);
  } finally {
    db.close();
  }
});

test("syncWeights is idempotent and preserves existing tuned weights", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    db.prepare("UPDATE weights SET weight = 2.0 WHERE persona = 'the-dude'").run();
    syncWeights(roster, db);
    const row = db
      .prepare("SELECT weight FROM weights WHERE persona = 'the-dude'")
      .get() as { weight: number };
    assert.equal(row.weight, 2.0);
  } finally {
    db.close();
  }
});

test("syncWeights only inserts personas missing from the weights table", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const full = loadRoster(SEED_ROSTER);
  try {
    syncWeights(full.slice(0, 2), db);
    const before = db.prepare("SELECT COUNT(*) AS n FROM weights").get() as { n: number };
    assert.equal(Number(before.n), 2);
    syncWeights(full, db);
    const after = db.prepare("SELECT COUNT(*) AS n FROM weights").get() as { n: number };
    assert.equal(Number(after.n), full.length);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// selectSinglePersona (#154, #155)
// ---------------------------------------------------------------------------

test("selectSinglePersona returns a valid persona dict + writes active.json", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectSinglePersona({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    assert.ok(!("error" in result), `unexpected error: ${JSON.stringify(result)}`);
    for (const key of ["session_id", "persona", "name", "speaking_style"]) {
      assert.ok(key in result, `missing ${key}`);
    }
    const slugs = new Set(roster.map((r) => r.slug));
    assert.ok(slugs.has(result.persona as string));
    assert.ok(fs.existsSync(c.activeFile));
    const written = JSON.parse(fs.readFileSync(c.activeFile, "utf8"));
    assert.equal(written.persona, result.persona);
    assert.equal(written.session_id, result.session_id);
  } finally {
    db.close();
  }
});

test("selectSinglePersona by name resolves via fuzzy match", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectSinglePersona({
      roster,
      db,
      name: "jules",
      activeFile: c.activeFile,
      env: c.env,
    });
    assert.equal(result.persona, "jules-winnfield");
  } finally {
    db.close();
  }
});

test("selectSinglePersona returns error on unmatched name", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    const result = selectSinglePersona({
      roster,
      db,
      name: "zzz-nobody",
      activeFile: c.activeFile,
      env: c.env,
    });
    assert.ok("error" in result);
    assert.ok(!fs.existsSync(c.activeFile));
  } finally {
    db.close();
  }
});

test("selectSinglePersona heavily-liked persona wins more than uniform avg", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster: PersonaRecord[] = [
    {
      slug: "jules-winnfield",
      name: "Jules Winnfield",
      source: "Pulp Fiction",
      type: "character",
      traits: ["intense", "dramatic", "righteous"],
      signatureQuotes: [],
      voiceProfile: [],
      speakingStyle: "Biblical.",
      dateSignals: {},
    },
    {
      slug: "the-dude",
      name: "The Dude",
      source: "The Big Lebowski",
      type: "character",
      traits: ["zen", "lazy", "stubborn"],
      signatureQuotes: [],
      voiceProfile: [],
      speakingStyle: "Rambling.",
      dateSignals: {},
    },
    {
      slug: "deadpool",
      name: "Deadpool",
      source: "Deadpool",
      type: "character",
      traits: ["sarcastic", "violent", "chaotic"],
      signatureQuotes: [],
      voiceProfile: [],
      speakingStyle: "Meta.",
      dateSignals: {},
    },
  ];
  try {
    syncWeights(roster, db);
    // 5 like-rated sessions for jules → compute_weight saturates to ~3.0.
    for (let i = 0; i < 5; i++) {
      const cur = db
        .prepare("INSERT INTO sessions (persona) VALUES (?)")
        .run("jules-winnfield");
      db.prepare(
        "INSERT INTO ratings (session_id, persona, rating) VALUES (?, ?, 'like')",
      ).run(cur.lastInsertRowid, "jules-winnfield");
    }
    const picks = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const result = selectSinglePersona({
        roster,
        db,
        activeFile: c.activeFile,
        rng: makeRandom(i + 1),
        env: c.env,
      });
      const slug = result.persona as string;
      picks.set(slug, (picks.get(slug) ?? 0) + 1);
    }
    const uniform = 300 / roster.length;
    assert.ok(
      (picks.get("jules-winnfield") ?? 0) > uniform,
      `jules ${picks.get("jules-winnfield")} <= uniform avg ${uniform}`,
    );
  } finally {
    db.close();
  }
});

test("selectSinglePersona honors date signals at ~25% gate", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const today = new Date(Date.UTC(2026, 11, 21)); // Jules's birthday
    let hits = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      const result = selectSinglePersona({
        roster,
        db,
        activeFile: c.activeFile,
        rng: makeRandom(i + 1),
        today,
        env: c.env,
      });
      if (result.date_signal_matched) hits++;
    }
    const ratio = hits / trials;
    assert.ok(ratio > 0.1 && ratio < 0.45, `date hit ratio ${ratio} outside 10-45%`);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// selectCombo (#156)
// ---------------------------------------------------------------------------

test("selectCombo returns 2-3 components with 1-2 traits each + recipe hash", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectCombo({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    assert.ok(!("error" in result));
    assert.equal(result.is_combo, true);
    const components = result.components as Array<{ slug: string; name: string; traits: string[] }>;
    assert.ok(components.length >= 2 && components.length <= 3);
    for (const comp of components) {
      assert.ok(comp.traits.length >= 1 && comp.traits.length <= 2);
    }
    assert.equal(typeof result.combo_name, "string");
    assert.equal(typeof result.recipe_hash, "string");
    assert.equal(typeof result.speaking_style, "string");
  } finally {
    db.close();
  }
});

test("selectCombo writes is_combo session row + combo_components JSON", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectCombo({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    const row = db
      .prepare(
        "SELECT is_combo, combo_components, combo FROM sessions WHERE id = ?",
      )
      .get(result.session_id as number) as {
      is_combo: number;
      combo_components: string;
      combo: string;
    };
    assert.equal(Number(row.is_combo), 1);
    const parsed = JSON.parse(row.combo_components) as unknown[];
    assert.ok(parsed.length >= 2);
  } finally {
    db.close();
  }
});

test("selectCombo recipe_hash is deterministic for the same chosen personas", () => {
  const c = ctx();
  const roster = loadRoster(SEED_ROSTER);
  const db1 = initDb(path.join(c.dir, "p1.db"));
  syncWeights(roster, db1);
  const r1 = selectCombo({
    roster,
    db: db1,
    activeFile: path.join(c.dir, "a1.json"),
    rng: makeRandom(42),
    env: c.env,
  });
  db1.close();
  const db2 = initDb(path.join(c.dir, "p2.db"));
  syncWeights(roster, db2);
  const r2 = selectCombo({
    roster,
    db: db2,
    activeFile: path.join(c.dir, "a2.json"),
    rng: makeRandom(42),
    env: c.env,
  });
  db2.close();
  assert.equal(r1.recipe_hash, r2.recipe_hash);
});

// ---------------------------------------------------------------------------
// recordRating (#158)
// ---------------------------------------------------------------------------

test("recordRating upserts on session_id — last rating wins, no duplicates", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectSinglePersona({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    const sessionId = result.session_id as number;
    recordRating({ db, rating: "like", activeFile: c.activeFile, env: c.env });
    recordRating({ db, rating: "hate", activeFile: c.activeFile, env: c.env });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM ratings WHERE session_id = ?")
      .get(sessionId) as { n: number };
    assert.equal(Number(count.n), 1);
    const rating = db
      .prepare("SELECT rating FROM ratings WHERE session_id = ?")
      .get(sessionId) as { rating: string };
    assert.equal(rating.rating, "hate");
  } finally {
    db.close();
  }
});

test("recordRating on a combo populates favorite_combos when liked", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const combo = selectCombo({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    recordRating({ db, rating: "like", activeFile: c.activeFile, env: c.env });
    const fav = db
      .prepare("SELECT combo, times_used FROM favorite_combos WHERE combo = ?")
      .get(combo.combo_name as string) as { combo: string; times_used: number };
    assert.ok(fav);
    assert.equal(Number(fav.times_used), 1);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// recordSurveyAnswer
// ---------------------------------------------------------------------------

test("recordSurveyAnswer persists question + answer", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  try {
    recordSurveyAnswer({
      db,
      question: "Vibe?",
      answer: "Stern mentor",
      activeFile: c.activeFile,
      env: c.env,
    });
    const row = db
      .prepare("SELECT question, answer FROM survey_responses")
      .get() as { question: string; answer: string };
    assert.equal(row.question, "Vibe?");
    assert.equal(row.answer, "Stern mentor");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// addPersona / sanitizeInput / detectType
// ---------------------------------------------------------------------------

test("sanitizeInput rejects backticks", () => {
  assert.throws(() => sanitizeInput("Bad`Name", "name"), /Invalid characters/);
});

test("sanitizeInput rejects HTML tags", () => {
  assert.throws(() => sanitizeInput("<script>x</script>", "name"), /Invalid characters/);
});

test("detectType: 'comedian' → person, default → character", () => {
  assert.equal(detectType("Israeli comedian, stand-up"), "person");
  assert.equal(detectType("The Big Lebowski (1998)"), "character");
});

test("addPersona appends a section and registers a 1.5 weight row", () => {
  const c = ctx();
  const rosterFile = path.join(c.dir, "roster.md");
  fs.writeFileSync(rosterFile, "# Persona Roster\n");
  const slug = addPersona({
    name: "Tony Montana",
    source: "Scarface (1983)",
    traitsRaw: "ambitious, volatile, dramatic",
    rosterFile,
    dbFile: c.dbFile,
  });
  assert.equal(slug, "tony-montana");
  const content = fs.readFileSync(rosterFile, "utf8");
  assert.ok(content.includes("## Tony Montana"));
  assert.ok(content.includes("tony-montana"));
  assert.ok(content.includes("character"));
  const db = new DatabaseSync(c.dbFile);
  try {
    const row = db
      .prepare("SELECT weight FROM weights WHERE persona = ?")
      .get("tony-montana") as { weight: number };
    assert.equal(row.weight, 1.5);
  } finally {
    db.close();
  }
});

test("addPersona detects person type from source keyword", () => {
  const c = ctx();
  const rosterFile = path.join(c.dir, "roster.md");
  fs.writeFileSync(rosterFile, "# Persona Roster\n");
  addPersona({
    name: "Dave Chappelle",
    source: "Comedian, stand-up",
    traitsRaw: "witty, sharp, fearless",
    rosterFile,
    dbFile: c.dbFile,
  });
  const content = fs.readFileSync(rosterFile, "utf8");
  assert.ok(content.includes("Type:** person"));
});

test("addPersona rejects bad trait count", () => {
  const c = ctx();
  const rosterFile = path.join(c.dir, "roster.md");
  fs.writeFileSync(rosterFile, "# Persona Roster\n");
  assert.throws(
    () =>
      addPersona({
        name: "Only Two",
        source: "Source",
        traitsRaw: "a, b",
        rosterFile,
        dbFile: c.dbFile,
      }),
    /3-5 traits/,
  );
});

// ---------------------------------------------------------------------------
// Insights emission via emit_queue_lib.ts (#162 port)
// ---------------------------------------------------------------------------

test("selectSinglePersona emits a persona_event selection into the insights queue", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectSinglePersona({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    const events = queueEvents(c.queueDir);
    const matching = events.filter(
      (e) => e.type === "persona_event" &&
        (e.payload as Record<string, unknown>).subtype === "selection",
    );
    assert.equal(matching.length, 1);
    const payload = matching[0].payload as Record<string, unknown>;
    assert.equal(payload.persona, result.persona);
    assert.equal(payload.is_combo, false);
    assert.equal(payload.persona_session_id, result.session_id);
    // Producer must never use the envelope's `session_id` key inside the payload.
    assert.ok(!("session_id" in payload));
  } finally {
    db.close();
  }
});

test("recordRating emits a persona_event rating into the insights queue", () => {
  const c = ctx();
  const db = initDb(c.dbFile);
  const roster = loadRoster(SEED_ROSTER);
  try {
    syncWeights(roster, db);
    const result = selectSinglePersona({
      roster,
      db,
      activeFile: c.activeFile,
      rng: makeRandom(42),
      env: c.env,
    });
    recordRating({ db, rating: "like", activeFile: c.activeFile, env: c.env });
    const events = queueEvents(c.queueDir);
    const matching = events.filter(
      (e) => e.type === "persona_event" &&
        (e.payload as Record<string, unknown>).subtype === "rating",
    );
    assert.equal(matching.length, 1);
    const payload = matching[0].payload as Record<string, unknown>;
    assert.equal(payload.rating, "like");
    assert.equal(payload.persona, result.persona);
    assert.equal(payload.persona_session_id, result.session_id);
  } finally {
    db.close();
  }
});

test("makeRandom is deterministic given the same seed", () => {
  const r1 = makeRandom(99);
  const r2 = makeRandom(99);
  for (let i = 0; i < 50; i++) {
    assert.equal(r1.random(), r2.random());
  }
});
