/**
 * stark-persona — TypeScript port of the session persona system.
 *
 * Ported 1:1 from `scripts/stark_persona.py`. No schema migrations, no
 * behavior changes, no new flags. Field names are camelCased on the TS
 * side (`speakingStyle`, `dateSignals`, `signatureQuotes`,
 * `voiceProfile`) but the `active.json` payload + insights envelopes
 * stay snake_case so the cross-language contract holds.
 *
 * Surface:
 *   - Read-only (Slice 1): PersonaRecord, parseRoster, loadRoster,
 *     loadActive/writeActive/deleteActive, computeWeight,
 *     getDateMatches, fuzzyMatchPersona.
 *   - Write (Slice 2): initDb, syncWeights, selectSinglePersona,
 *     selectCombo, recordRating, recordSurveyAnswer, recomputeWeight,
 *     sanitizeInput, detectType, addPersona,
 *     makeRandom, SURVEY_POOL.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface PersonaRecord {
  slug: string;
  name: string;
  source: string;
  type: "character" | "person";
  category?: string;
  domain?: string;
  archetype?: string;
  traits: string[];
  catchphrase?: string;
  signatureQuotes: string[];
  voiceProfile: string[];
  speakingStyle: string;
  dateSignals: Record<string, string>; // label → YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function dataDir(): string {
  return path.join(os.homedir(), ".stark-persona");
}

export function dbPath(): string {
  return path.join(dataDir(), "persona.db");
}

export function activePath(): string {
  return path.join(dataDir(), "active.json");
}

// Roster path: install location is `~/.claude/code-review/data/persona/roster.md`
// (symlinked from the repo). Resolve relative to this module so dev + installed
// invocations both find it.
export function rosterPath(): string {
  return path.resolve(import.meta.dirname, "..", "data", "persona", "roster.md");
}

const MINIMAL_SEED = `# Persona Roster

## Jules Winnfield
- **Slug:** jules-winnfield
- **Source:** Pulp Fiction (1994)
- **Type:** character
- **Traits:** intense, philosophical, dramatic, righteous, intimidating
- **Catchphrase:** "Allow me to retort."
- **Speaking style:** Biblical references, rhetorical questions, sudden intensity shifts.
- **Date signals:** Samuel L. Jackson birthday: 1948-12-21

## The Dude
- **Slug:** the-dude
- **Source:** The Big Lebowski (1998)
- **Type:** character
- **Traits:** zen, lazy, confused, stubborn, philosophical
- **Catchphrase:** "That's just, like, your opinion, man."
- **Speaking style:** Rambling, non-sequiturs, bowling metaphors, perpetual bewilderment.
- **Date signals:** Jeff Bridges birthday: 1949-12-04
`;

export function ensureDirs(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Roster parsing (#152)
// ---------------------------------------------------------------------------

interface FieldBlock {
  value: string | null;
  items: string[];
}

const FIELD_RE = /^-\s+\*\*(.+?):\*\*\s*(.*)$/;

function parseFieldBlocks(lines: string[]): Map<string, FieldBlock> {
  const fields = new Map<string, FieldBlock>();
  let currentName: string | null = null;
  let currentValue = "";
  let currentItems: string[] = [];

  const flush = () => {
    if (currentName === null) return;
    fields.set(currentName, {
      value: currentValue.trim() || null,
      items: [...currentItems],
    });
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const match = line.match(FIELD_RE);
    if (match) {
      flush();
      currentName = match[1].trim();
      currentValue = match[2].trim();
      currentItems = [];
      continue;
    }
    if (currentName === null) continue;
    if (line.startsWith("  - ")) {
      currentItems.push(line.slice(4).trim());
      continue;
    }
    if (!line.trim()) continue;
    // Wrapped continuation lines: attach to last item if there's a list,
    // otherwise to the scalar value.
    if (currentItems.length > 0) {
      currentItems[currentItems.length - 1] =
        `${currentItems[currentItems.length - 1]} ${line.trim()}`;
    } else {
      currentValue = `${currentValue} ${line.trim()}`.trim();
    }
  }
  flush();
  return fields;
}

function extractField(fields: Map<string, FieldBlock>, name: string): string | null {
  const block = fields.get(name);
  if (!block) return null;
  return block.value;
}

const EMPTY_TOKENS = new Set(["(none)", "none"]);

function extractListField(fields: Map<string, FieldBlock>, name: string): string[] {
  const block = fields.get(name);
  if (!block) return [];
  if (block.items.length > 0) {
    return block.items
      .map((item) => item.trim())
      .filter((item) => item && !EMPTY_TOKENS.has(item.toLowerCase()));
  }
  const value = block.value;
  if (value && value.trim() && !EMPTY_TOKENS.has(value.trim().toLowerCase())) {
    return [value.trim()];
  }
  return [];
}

function stripQuotes(s: string): string {
  // Python: `value.strip('"').strip("'")` — chained .strip strips ALL
  // matching quote chars from each end. Match that semantics.
  let out = s;
  while (out.length > 0 && (out.startsWith('"') || out.endsWith('"'))) {
    if (out.startsWith('"')) out = out.slice(1);
    if (out.endsWith('"')) out = out.slice(0, -1);
    if (out.length === 0) break;
    if (!out.startsWith('"') && !out.endsWith('"')) break;
  }
  while (out.length > 0 && (out.startsWith("'") || out.endsWith("'"))) {
    if (out.startsWith("'")) out = out.slice(1);
    if (out.endsWith("'")) out = out.slice(0, -1);
    if (out.length === 0) break;
    if (!out.startsWith("'") && !out.endsWith("'")) break;
  }
  return out;
}

function parsePersonaSection(
  name: string,
  lines: string[],
  startLine: number,
): PersonaRecord {
  const fields = parseFieldBlocks(lines);

  const slug = extractField(fields, "Slug");
  if (!slug) {
    throw new Error(
      `Line ~${startLine}: persona '${name}' missing required field 'Slug'`,
    );
  }
  const source = extractField(fields, "Source");
  if (!source) {
    throw new Error(
      `Line ~${startLine}: persona '${name}' missing required field 'Source'`,
    );
  }
  const ptype = extractField(fields, "Type");
  if (!ptype) {
    throw new Error(
      `Line ~${startLine}: persona '${name}' missing required field 'Type'`,
    );
  }
  if (ptype !== "character" && ptype !== "person") {
    throw new Error(
      `Line ~${startLine}: persona '${name}' has invalid type '${ptype}' ` +
        `(must be 'character' or 'person')`,
    );
  }

  const traitsRaw = extractField(fields, "Traits") ?? "";
  const traits = traitsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (traits.length < 3 || traits.length > 5) {
    throw new Error(
      `Line ~${startLine}: persona '${name}' has ${traits.length} traits ` +
        `(must have 3-5)`,
    );
  }

  const catchphraseRaw = extractField(fields, "Catchphrase");
  let catchphrase: string | undefined;
  if (catchphraseRaw && !["(none)", "none", ""].includes(catchphraseRaw)) {
    catchphrase = stripQuotes(catchphraseRaw);
  }

  const speakingStyle = extractField(fields, "Speaking style") ?? "";
  if (!speakingStyle) {
    throw new Error(
      `Line ~${startLine}: persona '${name}' missing required field 'Speaking style'`,
    );
  }

  const category = extractField(fields, "Category") ?? undefined;
  const domain = extractField(fields, "Domain") ?? undefined;
  const archetype = extractField(fields, "Archetype") ?? undefined;

  const sigQuoteSrc =
    extractListField(fields, "Signature quote fragments").length > 0
      ? extractListField(fields, "Signature quote fragments")
      : extractListField(fields, "Signature quotes");
  const signatureQuotes = sigQuoteSrc.map(stripQuotes);

  const voiceProfile = extractListField(fields, "Voice profile");

  // Date signals: collect candidates from both list-bullets and scalar value,
  // then scan each for "Label: YYYY-MM-DD" runs (multiple per line allowed).
  const dateSignals: Record<string, string> = {};
  const dsList = extractListField(fields, "Date signals");
  const dsScalar = extractField(fields, "Date signals");
  const candidates = dsList.length > 0 ? dsList : dsScalar ? [dsScalar] : [];
  const datePattern = /([^:,]+?):\s*(\d{4}-\d{2}-\d{2})/g;
  for (const candidate of candidates) {
    for (const m of candidate.matchAll(datePattern)) {
      dateSignals[m[1].trim()] = m[2];
    }
  }

  const record: PersonaRecord = {
    slug,
    name,
    source,
    type: ptype,
    traits,
    signatureQuotes,
    voiceProfile,
    speakingStyle,
    dateSignals,
  };
  if (category) record.category = category;
  if (domain) record.domain = domain;
  if (archetype) record.archetype = archetype;
  if (catchphrase !== undefined) record.catchphrase = catchphrase;
  return record;
}

export function parseRoster(text: string): PersonaRecord[] {
  const lines = text.split("\n");
  const sections: Array<{ name: string; startLine: number; body: string[] }> = [];

  let currentName: string | null = null;
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      if (currentName !== null) {
        sections.push({
          name: currentName,
          startLine: currentStart,
          body: currentLines,
        });
      }
      currentName = line.slice(3).trim();
      currentStart = i + 1; // 1-indexed line number, matches Python
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  if (currentName !== null) {
    sections.push({
      name: currentName,
      startLine: currentStart,
      body: currentLines,
    });
  }

  return sections.map((s) => parsePersonaSection(s.name, s.body, s.startLine));
}

export function loadRoster(rosterFile?: string): PersonaRecord[] {
  const file = rosterFile ?? rosterPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, MINIMAL_SEED);
  }
  const text = fs.readFileSync(file, "utf8");
  return parseRoster(text);
}

// ---------------------------------------------------------------------------
// Active state (#153)
// ---------------------------------------------------------------------------

export function loadActive(file?: string): Record<string, unknown> | null {
  const p = file ?? activePath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

export function writeActive(data: unknown, file?: string): void {
  const p = file ?? activePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Python uses `path.with_suffix(".tmp")` — replaces the FINAL suffix only,
  // so `active.json` → `active.tmp`. Match that to preserve the on-disk
  // contract any external watcher might rely on.
  const tmp = p.replace(/\.[^./\\]+$/, ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

export function deleteActive(file?: string): void {
  const p = file ?? activePath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

// ---------------------------------------------------------------------------
// Selection engine math (#154, #155)
// ---------------------------------------------------------------------------

export interface PersonaStats {
  selection_count: number;
  like_count: number;
  hate_count: number;
}

export function computeWeight(stats: Partial<PersonaStats>): number {
  const selectionCount = stats.selection_count ?? 0;
  const likeCount = stats.like_count ?? 0;
  const hateCount = stats.hate_count ?? 0;

  if (selectionCount === 0) return 1.5; // discovery boost

  const net = likeCount - hateCount;
  if (net > 0) {
    return 1.0 + Math.min(net, 5) * 0.4; // max 3.0
  }
  if (net < 0) {
    return Math.max(0.2, 1.0 + net * 0.4); // floor 0.2
  }
  return 1.0;
}

const DATE_SIGNAL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getDateMatches(
  roster: PersonaRecord[],
  today?: Date,
): PersonaRecord[] {
  const d = today ?? new Date();
  // Use UTC components so getDateMatches is invariant under local TZ —
  // mirrors Python's `datetime.date.today()` semantics when tests pass an
  // explicit date.
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const matches: PersonaRecord[] = [];
  for (const persona of roster) {
    for (const dateStr of Object.values(persona.dateSignals)) {
      const m = dateStr.match(DATE_SIGNAL_RE);
      if (!m) continue;
      const sigMonth = Number(m[2]);
      const sigDay = Number(m[3]);
      if (sigMonth === month && sigDay === day) {
        matches.push(persona);
        break; // one match per persona is enough
      }
    }
  }
  return matches;
}

// difflib.SequenceMatcher's ratio() — port of the classic ratcliff-obershelp
// similarity used by Python's stdlib. The Python implementation is well
// documented and stable; this is a faithful port of the same algorithm.
function sequenceMatcherRatio(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 && lenB === 0) return 1.0;
  if (lenA === 0 || lenB === 0) return 0.0;

  // Build b2j: char → list of indices in b
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < lenB; i++) {
    const c = b[i];
    const arr = b2j.get(c);
    if (arr) arr.push(i);
    else b2j.set(c, [i]);
  }

  function findLongestMatch(alo: number, ahi: number, blo: number, bhi: number) {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newJ2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newJ2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newJ2len;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  const stack: Array<[number, number, number, number]> = [[0, lenA, 0, lenB]];
  let matches = 0;
  while (stack.length > 0) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const { i, j, size } = findLongestMatch(alo, ahi, blo, bhi);
    if (size > 0) {
      matches += size;
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + size < ahi && j + size < bhi) {
        stack.push([i + size, ahi, j + size, bhi]);
      }
    }
  }
  return (2.0 * matches) / (lenA + lenB);
}

export function fuzzyMatchPersona(
  roster: PersonaRecord[],
  name: string,
): PersonaRecord | null {
  const query = name.toLowerCase().trim();

  // Exact slug or name match
  for (const p of roster) {
    if (p.slug === name || p.name.toLowerCase() === query) return p;
  }

  const score = (candidate: string): number => {
    const c = candidate.toLowerCase();
    if (query === c) return 1.0;
    if (query.includes(c) || c.includes(query)) return 0.95;

    let ratio = sequenceMatcherRatio(query, c);
    const tokens = c.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    if (
      tokens.some(
        (t) => t.length >= 3 && (t.startsWith(query) || query.startsWith(t)),
      )
    ) {
      ratio = Math.max(ratio, 0.85);
    }
    return ratio;
  };

  let best: PersonaRecord | null = null;
  let bestScore = 0;
  for (const p of roster) {
    const s = Math.max(score(p.slug), score(p.name));
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  if (best && bestScore >= 0.72) return best;
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (Mulberry32) — replaces Python random.Random's seeded
// MT for ports. Different stream from Python (so tests assert behavioral
// properties — counts, weighted bias, not specific picks), but
// reproducible per seed for deterministic test runs.
// ---------------------------------------------------------------------------

export interface RandomLike {
  random(): number;
  randInt(a: number, b: number): number; // inclusive of both, like Python's random.randint
  choice<T>(arr: T[]): T;
  choices<T>(arr: T[], weights: number[], k: number): T[];
  sample<T>(arr: T[], k: number): T[];
}

export function makeRandom(seed?: number): RandomLike {
  let state =
    seed === undefined
      ? ((Date.now() ^ Math.floor(Math.random() * 0xffff_ffff)) >>> 0)
      : (seed >>> 0);
  if (state === 0) state = 0xdeadbeef;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const random = (): number => next();
  const randInt = (a: number, b: number): number =>
    a + Math.floor(next() * (b - a + 1));
  const choice = <T>(arr: T[]): T => {
    if (arr.length === 0) throw new Error("choice from empty array");
    return arr[Math.floor(next() * arr.length)];
  };
  const choices = <T>(arr: T[], weights: number[], k: number): T[] => {
    if (arr.length === 0) throw new Error("choices from empty array");
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return Array.from({ length: k }, () => choice(arr));
    const cum: number[] = [];
    let running = 0;
    for (const w of weights) {
      running += w;
      cum.push(running);
    }
    const out: T[] = [];
    for (let n = 0; n < k; n++) {
      const r = next() * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      out.push(arr[lo]);
    }
    return out;
  };
  const sample = <T>(arr: T[], k: number): T[] => {
    if (k > arr.length) throw new Error("sample size exceeds population");
    // Fisher-Yates partial shuffle of indices, then map.
    const idx = arr.map((_, i) => i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(next() * (idx.length - i));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    return idx.slice(0, k).map((i) => arr[i]);
  };
  return { random, randInt, choice, choices, sample };
}

// ---------------------------------------------------------------------------
// Database (#151)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `\
CREATE TABLE IF NOT EXISTS sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at              TEXT,
    persona               TEXT    NOT NULL,
    combo                 TEXT,
    deactivated           INTEGER NOT NULL DEFAULT 0,
    is_combo              INTEGER NOT NULL DEFAULT 0,
    combo_components      TEXT,
    date_signal_matched   INTEGER NOT NULL DEFAULT 0,
    date_signal_reason    TEXT
);

CREATE TABLE IF NOT EXISTS ratings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
    persona     TEXT    NOT NULL,
    rating      TEXT    NOT NULL CHECK (rating IN ('like', 'hate')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question    TEXT    NOT NULL,
    answer      TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weights (
    persona     TEXT    PRIMARY KEY,
    weight      REAL    NOT NULL DEFAULT 1.0,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorite_combos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    combo       TEXT    NOT NULL UNIQUE,
    rating      REAL    NOT NULL DEFAULT 0.0,
    times_used  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

const SESSION_MIGRATIONS: ReadonlyArray<[string, string]> = [
  ["is_combo", "INTEGER NOT NULL DEFAULT 0"],
  ["combo_components", "TEXT"],
  ["date_signal_matched", "INTEGER NOT NULL DEFAULT 0"],
  ["date_signal_reason", "TEXT"],
];

function ensureIndex(
  db: DatabaseSync,
  table: string,
  name: string,
  column: string,
  unique: boolean,
): void {
  const existing = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?",
    )
    .get(table, name) as { name: string } | undefined;
  if (existing) return;
  const uq = unique ? "UNIQUE" : "";
  db.exec(`CREATE ${uq} INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
}

function migrateSessions(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>).map((r) => r.name);
  const existing = new Set(cols);
  for (const [col, typedef] of SESSION_MIGRATIONS) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${typedef}`);
    }
  }
  ensureIndex(db, "ratings", "idx_ratings_session_id", "session_id", true);
  ensureIndex(db, "favorite_combos", "idx_favorite_combos_combo", "combo", true);
}

export function initDb(file?: string): DatabaseSync {
  const target = file ?? dbPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(SCHEMA_SQL);
  migrateSessions(db);
  return db;
}

export function syncWeights(roster: PersonaRecord[], db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare("SELECT persona FROM weights").all() as Array<{ persona: string }>).map(
      (r) => r.persona,
    ),
  );
  const insert = db.prepare("INSERT INTO weights (persona, weight) VALUES (?, ?)");
  for (const record of roster) {
    if (!existing.has(record.slug)) {
      // 1.5 mirrors compute_weight(0 selections) — discovery boost.
      insert.run(record.slug, 1.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function getPersonaStats(db: DatabaseSync, slug: string): PersonaStats {
  const sel = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE persona = ?")
    .get(slug) as { n: number };
  const likes = db
    .prepare(
      "SELECT COUNT(*) AS n FROM ratings WHERE persona = ? AND rating = 'like'",
    )
    .get(slug) as { n: number };
  const hates = db
    .prepare(
      "SELECT COUNT(*) AS n FROM ratings WHERE persona = ? AND rating = 'hate'",
    )
    .get(slug) as { n: number };
  return {
    selection_count: Number(sel.n),
    like_count: Number(likes.n),
    hate_count: Number(hates.n),
  };
}

export function recomputeWeight(db: DatabaseSync, slug: string): number {
  const stats = getPersonaStats(db, slug);
  const newWeight = computeWeight(stats);
  db.prepare(
    `INSERT INTO weights (persona, weight, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')`,
  ).run(slug, newWeight, newWeight);
  return newWeight;
}

function weightedRandomPick(
  roster: PersonaRecord[],
  db: DatabaseSync,
  rng: RandomLike,
): PersonaRecord {
  const weights: number[] = [];
  for (const p of roster) weights.push(computeWeight(getPersonaStats(db, p.slug)));
  return rng.choices(roster, weights, 1)[0];
}

// ---------------------------------------------------------------------------
// Selection (#154, #155, #156)
// ---------------------------------------------------------------------------

interface PersistOpts {
  persona: PersonaRecord;
  db: DatabaseSync;
  activeFile?: string;
  isCombo?: boolean;
  comboComponents?: string;
  dateSignalMatched?: boolean;
  dateSignalReason?: string;
  env?: NodeJS.ProcessEnv;
}

function persistSelection(opts: PersistOpts): Record<string, unknown> {
  const {
    persona,
    db,
    activeFile,
    isCombo = false,
    comboComponents,
    dateSignalMatched = false,
    dateSignalReason,
    env,
  } = opts;

  const stats = getPersonaStats(db, persona.slug);
  stats.selection_count += 1; // count this selection
  const newWeight = computeWeight(stats);

  const cur = db
    .prepare(
      `INSERT INTO sessions
         (persona, is_combo, combo_components, date_signal_matched, date_signal_reason)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      persona.slug,
      isCombo ? 1 : 0,
      comboComponents ?? null,
      dateSignalMatched ? 1 : 0,
      dateSignalReason ?? null,
    );
  const sessionId = Number(cur.lastInsertRowid);

  db.prepare(
    `INSERT INTO weights (persona, weight, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')`,
  ).run(persona.slug, newWeight, newWeight);

  const result: Record<string, unknown> = {
    session_id: sessionId,
    persona: persona.slug,
    name: persona.name,
    source: persona.source,
    traits: persona.traits,
    speaking_style: persona.speakingStyle,
    weight: newWeight,
  };
  if (persona.catchphrase) result.catchphrase = persona.catchphrase;
  if (dateSignalMatched) {
    result.date_signal_matched = true;
    if (dateSignalReason !== undefined) result.date_signal_reason = dateSignalReason;
  }
  if (isCombo) {
    result.is_combo = true;
    result.combo_components = comboComponents ? JSON.parse(comboComponents) : [];
  }

  writeActive(result, activeFile);

  return result;
}

export interface SelectSingleOpts {
  roster: PersonaRecord[];
  db: DatabaseSync;
  name?: string;
  auto?: boolean;
  activeFile?: string;
  rng?: RandomLike;
  today?: Date;
  env?: NodeJS.ProcessEnv;
}

export function selectSinglePersona(opts: SelectSingleOpts): Record<string, unknown> {
  const { roster, db, name, activeFile, env } = opts;
  const rng = opts.rng ?? makeRandom();
  let persona: PersonaRecord;
  let dateSignalMatched = false;
  let dateSignalReason: string | undefined;

  if (name) {
    const match = fuzzyMatchPersona(roster, name);
    if (!match) return { error: `No persona matching '${name}' found in roster` };
    persona = match;
  } else {
    const dateMatches = getDateMatches(roster, opts.today);
    if (dateMatches.length > 0 && rng.random() < 0.25) {
      persona = rng.choice(dateMatches);
      dateSignalMatched = true;
      const checkDate = opts.today ?? new Date();
      const month = checkDate.getUTCMonth() + 1;
      const day = checkDate.getUTCDate();
      for (const [label, dateStr] of Object.entries(persona.dateSignals)) {
        const m = dateStr.match(DATE_SIGNAL_RE);
        if (!m) continue;
        if (Number(m[2]) === month && Number(m[3]) === day) {
          dateSignalReason = label;
          break;
        }
      }
    } else {
      persona = weightedRandomPick(roster, db, rng);
    }
  }

  return persistSelection({
    persona,
    db,
    activeFile,
    dateSignalMatched,
    dateSignalReason,
    env,
  });
}

export interface SelectComboOpts {
  roster: PersonaRecord[];
  db: DatabaseSync;
  activeFile?: string;
  rng?: RandomLike;
  env?: NodeJS.ProcessEnv;
}

export function selectCombo(opts: SelectComboOpts): Record<string, unknown> {
  const { roster, db, activeFile, env } = opts;
  const rng = opts.rng ?? makeRandom();

  if (roster.length < 2) {
    return { error: "Need at least 2 personas in roster for a combo" };
  }

  const count = roster.length >= 3 ? rng.choice([2, 3]) : 2;

  const chosen: PersonaRecord[] = [];
  let remaining = [...roster];
  for (let i = 0; i < count; i++) {
    const pick = weightedRandomPick(remaining, db, rng);
    chosen.push(pick);
    remaining = remaining.filter((p) => p.slug !== pick.slug);
  }

  interface ComboComponent {
    slug: string;
    name: string;
    traits: string[];
  }

  const components: ComboComponent[] = [];
  const allTraits: string[] = [];
  for (const p of chosen) {
    const max = Math.min(2, p.traits.length);
    const traitCount = rng.randInt(1, max);
    const selected = rng.sample(p.traits, traitCount);
    components.push({ slug: p.slug, name: p.name, traits: selected });
    allTraits.push(...selected);
  }

  const names = chosen.map((p) => p.name);
  const comboName =
    names.length === 2 ? `${names[0]} meets ${names[1]}` : names.join(" × ");

  const styles = chosen
    .map((p) => p.speakingStyle)
    .filter((s) => s.length > 0);
  const speakingStyle = styles.length > 0 ? styles.join(" Blended with: ") : "";

  const sortedSlugs = [...chosen.map((p) => p.slug)].sort();
  const recipeHash = crypto
    .createHash("sha256")
    .update(sortedSlugs.join("|"))
    .digest("hex")
    .slice(0, 12);

  const comboComponentsJson = JSON.stringify(components);
  const primary = chosen[0];

  const cur = db
    .prepare(
      `INSERT INTO sessions
         (persona, combo, is_combo, combo_components)
       VALUES (?, ?, 1, ?)`,
    )
    .run(primary.slug, comboName, comboComponentsJson);
  const sessionId = Number(cur.lastInsertRowid);

  for (const p of chosen) {
    const stats = getPersonaStats(db, p.slug);
    stats.selection_count += 1;
    const w = computeWeight(stats);
    db.prepare(
      `INSERT INTO weights (persona, weight, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')`,
    ).run(p.slug, w, w);
  }

  const result: Record<string, unknown> = {
    session_id: sessionId,
    combo_name: comboName,
    is_combo: true,
    components,
    all_traits: allTraits,
    speaking_style: speakingStyle,
    recipe_hash: recipeHash,
  };

  writeActive(result, activeFile);

  return result;
}

// ---------------------------------------------------------------------------
// Feedback (#158)
// ---------------------------------------------------------------------------

export const SURVEY_POOL: ReadonlyArray<{ question: string; choices: string[] }> = [
  {
    question: "Which vibe do you prefer for code reviews?",
    choices: ["Stern mentor", "Encouraging coach", "Sarcastic friend", "Zen master"],
  },
  {
    question: "Pick a trait you'd want more of:",
    choices: ["Wit", "Intensity", "Calmness", "Absurdity"],
  },
  {
    question: "What tone works best for error messages?",
    choices: ["Dramatic", "Deadpan", "Sympathetic", "Comedic"],
  },
  {
    question: "How weird should combos get?",
    choices: ["Keep it mild", "Surprise me sometimes", "Maximum chaos"],
  },
  {
    question: "Catchphrases in responses — yay or nay?",
    choices: ["Love them", "Occasionally", "Never"],
  },
  {
    question: "Persona persistence across sessions?",
    choices: ["New every time", "Keep a good one for a while", "Let me choose"],
  },
];

export interface RecordRatingOpts {
  db: DatabaseSync;
  rating: "like" | "hate";
  activeFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function recordRating(opts: RecordRatingOpts): string {
  const { db, rating, activeFile, env } = opts;
  const active = loadActive(activeFile);
  if (active === null) return "No active persona session.";

  const sessionId = active.session_id as number | undefined;
  if (sessionId === undefined) return "No session_id in active.json.";

  let slug = active.persona as string | undefined;
  const isCombo = Boolean(active.is_combo);
  if (!slug && isCombo) {
    const components = (active.components as Array<{ slug?: string }> | undefined) ?? [];
    if (components.length > 0) slug = components[0].slug;
  }
  if (!slug) return "Cannot determine persona from active.json.";

  db.prepare(
    `INSERT OR REPLACE INTO ratings (session_id, persona, rating) VALUES (?, ?, ?)`,
  ).run(sessionId, slug, rating);

  recomputeWeight(db, slug);

  if (isCombo) {
    let components =
      (active.components as Array<{ slug?: string }> | undefined) ??
      (active.combo_components as Array<{ slug?: string }> | string | undefined);
    if (typeof components === "string") components = JSON.parse(components);
    const list = (components ?? []) as Array<{ slug?: string }>;
    for (const comp of list) {
      const compSlug = comp.slug;
      if (compSlug && compSlug !== slug) {
        const stats = getPersonaStats(db, compSlug);
        const base = computeWeight(stats);
        const diluted = 1.0 + (base - 1.0) * 0.5;
        db.prepare(
          `INSERT INTO weights (persona, weight, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')`,
        ).run(compSlug, diluted, diluted);
      }
    }
    if (rating === "like") {
      const comboName = (active.combo_name as string | undefined) ?? "";
      if (comboName) {
        db.prepare(
          `INSERT INTO favorite_combos (combo, rating, times_used)
           VALUES (?, 1.0, 1)
           ON CONFLICT(combo) DO UPDATE SET
               rating = rating + 1.0,
               times_used = times_used + 1`,
        ).run(comboName);
      }
    }
  }

  const emoji = rating === "like" ? "\u{1F44D}" : "\u{1F44E}";
  const name =
    (active.name as string | undefined) ??
    (active.combo_name as string | undefined) ??
    slug;
  return `${emoji} Rated ${name} as ${rating}.`;
}

export interface RecordSurveyOpts {
  db: DatabaseSync;
  question: string;
  answer: string;
  activeFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function recordSurveyAnswer(opts: RecordSurveyOpts): void {
  const { db, question, answer, activeFile, env } = opts;
  db.prepare("INSERT INTO survey_responses (question, answer) VALUES (?, ?)").run(
    question,
    answer,
  );
  const active = loadActive(activeFile);
  const sessionId =
    active && typeof active.session_id === "number"
      ? (active.session_id as number)
      : null;
}

// ---------------------------------------------------------------------------
// Add (#160)
// ---------------------------------------------------------------------------

const SANITIZE_PATTERNS: ReadonlyArray<RegExp> = [
  /`/, // backticks (covers single and triple)
  /<[^>]+>/, // HTML tags
];

export function sanitizeInput(value: string, fieldName: string): string {
  for (const pat of SANITIZE_PATTERNS) {
    if (pat.test(value)) {
      throw new Error(
        `Invalid characters in ${fieldName}: backticks, code blocks, and HTML tags are not allowed.`,
      );
    }
  }
  return value.trim();
}

const PERSON_KEYWORDS = new Set([
  "comedian",
  "actor",
  "actress",
  "singer",
  "musician",
  "host",
  "presenter",
  "anchor",
  "personality",
  "stand-up",
]);

export function detectType(source: string): "character" | "person" {
  const lower = source.toLowerCase();
  for (const kw of PERSON_KEYWORDS) {
    if (lower.includes(kw)) return "person";
  }
  return "character";
}

export interface AddPersonaOpts {
  name: string;
  source: string;
  traitsRaw: string;
  rosterFile?: string;
  dbFile?: string;
}

export function addPersona(opts: AddPersonaOpts): string {
  const name = sanitizeInput(opts.name, "name");
  const source = sanitizeInput(opts.source, "source");
  const traitsRaw = sanitizeInput(opts.traitsRaw, "traits");

  const traits = traitsRaw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (traits.length < 3 || traits.length > 5) {
    throw new Error(`Need 3-5 traits, got ${traits.length}.`);
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const ptype = detectType(source);

  const target = opts.rosterFile ?? rosterPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const section = `
## ${name}
- **Slug:** ${slug}
- **Category:** drama
- **Domain:** Custom
- **Source:** ${source}
- **Type:** ${ptype}
- **Archetype:** custom add
- **Traits:** ${traits.join(", ")}
- **Catchphrase:** (none)
- **Signature quote fragments:**
  - (add short iconic lines)
- **Voice profile:**
  - Cadence: (to be filled in)
  - Humor: (to be filled in)
  - Tells: (to be filled in)
- **Speaking style:** (to be filled in)
- **Date signals:**
  - (none)
`;

  const existing = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8")
    : "# Persona Roster\n";
  const newContent = existing.replace(/\s+$/, "") + "\n" + section;

  // Atomic append via tmp + rename, like the Python tempfile.mkstemp path.
  const tmp = path.join(
    path.dirname(target),
    `.roster.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, newContent);
  fs.renameSync(tmp, target);

  // Pre-register a 1.5 weight row so the new persona is immediately eligible.
  const db = initDb(opts.dbFile);
  try {
    db.prepare(
      "INSERT OR REPLACE INTO weights (persona, weight) VALUES (?, ?)",
    ).run(slug, 1.5);
  } finally {
    db.close();
  }
  return slug;
}
