/**
 * stark-persona — TypeScript port of the session persona system.
 *
 * Slice 1 (this file): read-only surface — PersonaRecord shape, roster
 * parsing (#152), active-state read/write/delete (#153), and the pure
 * selection-engine math: `computeWeight`, `getDateMatches`,
 * `fuzzyMatchPersona`. The DB + selection + emission write paths land in
 * Slice 2 alongside the CLI; the Python `scripts/stark_persona.py`
 * remains authoritative until then.
 *
 * Ported 1:1 from `scripts/stark_persona.py`. No schema migrations, no
 * behavior changes, no new flags. Field names are camelCased on the TS
 * side (`speakingStyle`, `dateSignals`, `signatureQuotes`,
 * `voiceProfile`) but the `active.json` payload + insights envelopes
 * stay snake_case so the cross-language contract holds.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
