#!/usr/bin/env node
/**
 * stark-persona CLI — TypeScript port of `scripts/stark_persona.py`.
 *
 * Subcommands (CLI surface is the contract — SKILL.md depends on every
 * flag and `select --auto`'s JSON shape is parsed by stark-session):
 *
 *   select [--name NAME] [--combo] [--auto]
 *   deactivate
 *   rate --rating {like,hate}
 *   survey
 *   survey-answer --question Q --answer A
 *   add --name NAME --source SOURCE --traits TRAITS
 *   stats [--format {inline,table}]
 *   history
 *   print-roster
 *   print-weights
 *   session-end
 */

import {
  addPersona,
  deleteActive,
  ensureDirs,
  initDb,
  loadActive,
  loadRoster,
  makeRandom,
  recordRating,
  recordSurveyAnswer,
  selectCombo,
  selectSinglePersona,
  SURVEY_POOL,
  syncWeights,
  type RandomLike,
} from "./stark_persona_lib.ts";

// ---------------------------------------------------------------------------
// Tiny argv parser — only the flags we actually use (no yargs / commander).
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

// Optional explicit seed channel — used by tests that wrap the CLI.
function makeRng(): RandomLike {
  const seedEnv = process.env.STARK_PERSONA_SEED;
  if (seedEnv && /^\d+$/.test(seedEnv)) return makeRandom(Number(seedEnv));
  return makeRandom();
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdSelect(args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    const roster = loadRoster();
    if (roster.length === 0) {
      console.log(
        JSON.stringify({
          error: "roster is empty — populate with 'add' or seed roster.md",
        }),
      );
      return 1;
    }
    syncWeights(roster, db);

    const auto = flagBool(args, "auto");
    const combo = flagBool(args, "combo");
    const name = flagString(args, "name");

    const result = combo
      ? selectCombo({ roster, db, rng: makeRng() })
      : selectSinglePersona({ roster, db, name, auto, rng: makeRng() });

    if ("error" in result) {
      console.log(JSON.stringify(result));
      return 1;
    }

    if (auto) {
      console.log(JSON.stringify(result));
    } else if (result.is_combo) {
      console.log(`Combo: ${result.combo_name}`);
      const all = (result.all_traits as string[]).join(", ");
      console.log(`Traits: ${all}`);
      console.log(`Style: ${result.speaking_style}`);
      console.log(`Recipe: ${result.recipe_hash}`);
    } else {
      console.log(`Persona: ${result.name} (${result.persona})`);
      console.log(`Source: ${result.source}`);
      console.log(`Traits: ${(result.traits as string[]).join(", ")}`);
      console.log(`Style: ${result.speaking_style}`);
      if (result.catchphrase) console.log(`Catchphrase: ${result.catchphrase}`);
      if (result.date_signal_matched) {
        console.log(`Date match: ${result.date_signal_reason}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function cmdDeactivate(_args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    db.prepare(
      "UPDATE sessions SET deactivated = 1 WHERE id = (SELECT MAX(id) FROM sessions)",
    ).run();
  } finally {
    db.close();
  }
  deleteActive();
  console.log("Persona deactivated. Back to standard.");
  return 0;
}

function cmdRate(args: ParsedArgs): number {
  const rating = flagString(args, "rating");
  if (rating !== "like" && rating !== "hate") {
    console.error("Error: --rating must be 'like' or 'hate'");
    return 2;
  }
  ensureDirs();
  const db = initDb();
  try {
    const msg = recordRating({ db, rating });
    console.log(msg);
    return 0;
  } finally {
    db.close();
  }
}

function cmdSurvey(_args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    const rng = makeRng();
    const count = rng.randInt(1, 3);
    const want = Math.min(count, SURVEY_POOL.length);
    const picked = rng.sample([...SURVEY_POOL], want);
    const output = {
      questions: picked.map((q) => ({ question: q.question, choices: q.choices })),
    };
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function cmdSurveyAnswer(args: ParsedArgs): number {
  const question = flagString(args, "question");
  const answer = flagString(args, "answer");
  if (!question || !answer) {
    console.error("Error: --question and --answer are required");
    return 2;
  }
  ensureDirs();
  const db = initDb();
  try {
    recordSurveyAnswer({ db, question, answer });
    console.log(`Recorded answer for: ${question}`);
    return 0;
  } finally {
    db.close();
  }
}

function cmdAdd(args: ParsedArgs): number {
  const name = flagString(args, "name");
  const source = flagString(args, "source");
  const traitsRaw = flagString(args, "traits");
  if (!name || !source || !traitsRaw) {
    console.error("Error: --name, --source, and --traits are required");
    return 2;
  }
  ensureDirs();
  try {
    const slug = addPersona({ name, source, traitsRaw });
    const lower = source.toLowerCase();
    const isPerson = /comedian|actor|actress|singer|musician|host|presenter|anchor|personality|stand-up/.test(
      lower,
    );
    console.log(
      `Added ${name} (${slug}) to roster as ${isPerson ? "person" : "character"}.`,
    );
    return 0;
  } catch (err) {
    console.log(`Error: ${(err as Error).message}`);
    return 1;
  }
}

interface StatRow {
  persona: string;
  weight: number;
  selections: number;
  likes: number;
  hates: number;
}

function cmdStats(args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    }).n;
    const comboCount = (db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE is_combo = 1")
      .get() as { n: number }).n;
    const format = flagString(args, "format") ?? "inline";
    if (format === "table") {
      const rows = db
        .prepare(
          `SELECT w.persona, w.weight,
                  COALESCE(s.cnt, 0) AS selections,
                  COALESCE(rl.cnt, 0) AS likes,
                  COALESCE(rh.cnt, 0) AS hates
           FROM weights w
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM sessions GROUP BY persona) s
               ON w.persona = s.persona
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='like' GROUP BY persona) rl
               ON w.persona = rl.persona
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='hate' GROUP BY persona) rh
               ON w.persona = rh.persona
           ORDER BY w.weight DESC`,
        )
        .all() as unknown as StatRow[];
      console.log(
        `${"Persona".padEnd(25)} ${"Weight".padStart(7)} ${"Sel".padStart(5)} ${"Like".padStart(5)} ${"Hate".padStart(5)}`,
      );
      console.log(
        `${"-".repeat(25)} ${"-".repeat(7)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)}`,
      );
      for (const r of rows) {
        console.log(
          `${r.persona.padEnd(25)} ${r.weight.toFixed(2).padStart(7)} ${String(r.selections).padStart(5)} ${String(r.likes).padStart(5)} ${String(r.hates).padStart(5)}`,
        );
      }
      console.log(`\nTotal sessions: ${total} | Combos: ${comboCount}`);
    } else {
      const top3 = db
        .prepare("SELECT persona, weight FROM weights ORDER BY weight DESC LIMIT 3")
        .all() as Array<{ persona: string; weight: number }>;
      const bottom = db
        .prepare("SELECT persona, weight FROM weights ORDER BY weight ASC LIMIT 1")
        .get() as { persona: string; weight: number } | undefined;
      const data = {
        sessions: total,
        combos: comboCount,
        top_3: top3.map((r) => ({ persona: r.persona, weight: r.weight })),
        bottom: bottom ? { persona: bottom.persona, weight: bottom.weight } : null,
      };
      console.log(JSON.stringify(data));
    }
    return 0;
  } finally {
    db.close();
  }
}

interface HistoryRow {
  id: number;
  started_at: string | null;
  persona: string;
  is_combo: number;
  rating: string | null;
}

function cmdHistory(_args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.started_at, s.persona, s.is_combo,
                r.rating
         FROM sessions s
         LEFT JOIN ratings r ON r.session_id = s.id
         ORDER BY s.id DESC LIMIT 20`,
      )
      .all() as unknown as HistoryRow[];
    if (rows.length === 0) {
      console.log("No sessions recorded yet.");
      return 0;
    }
    console.log(
      `${"#".padEnd(4)} ${"Date".padEnd(20)} ${"Persona".padEnd(25)} ${"Rating".padEnd(8)} ${"Combo".padEnd(6)}`,
    );
    console.log(
      `${"-".repeat(4)} ${"-".repeat(20)} ${"-".repeat(25)} ${"-".repeat(8)} ${"-".repeat(6)}`,
    );
    for (const r of rows) {
      const emoji =
        r.rating === "like" ? "\u{1F44D}" : r.rating === "hate" ? "\u{1F44E}" : " ";
      const comboFlag = r.is_combo ? "✓" : "";
      const date = (r.started_at ?? "").slice(0, 16);
      console.log(
        `${String(r.id).padEnd(4)} ${date.padEnd(20)} ${r.persona.padEnd(25)} ${emoji.padEnd(8)} ${comboFlag.padEnd(6)}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

function cmdPrintRoster(_args: ParsedArgs): number {
  ensureDirs();
  const roster = loadRoster();
  if (roster.length === 0) {
    console.log("(empty roster)");
    return 0;
  }
  console.log(
    `${"Slug".padEnd(24)} ${"Category".padEnd(12)} ${"Name".padEnd(24)} ${"Source".padEnd(28)} ${"Type".padEnd(10)} ${"Traits"}`,
  );
  console.log(
    `${"-".repeat(24)} ${"-".repeat(12)} ${"-".repeat(24)} ${"-".repeat(28)} ${"-".repeat(10)} ${"-".repeat(30)}`,
  );
  for (const r of roster) {
    console.log(
      `${r.slug.padEnd(24)} ${(r.category ?? "-").slice(0, 12).padEnd(12)} ${r.name.padEnd(24)} ${r.source.slice(0, 28).padEnd(28)} ${r.type.padEnd(10)} ${r.traits.join(", ")}`,
    );
  }
  return 0;
}

function cmdPrintWeights(_args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    const roster = loadRoster();
    syncWeights(roster, db);
    const rows = db
      .prepare(
        `SELECT w.persona, w.weight,
                COALESCE(s.cnt, 0) AS selections,
                COALESCE(rl.cnt, 0) AS likes,
                COALESCE(rh.cnt, 0) AS hates
         FROM weights w
         LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM sessions GROUP BY persona) s
             ON w.persona = s.persona
         LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='like' GROUP BY persona) rl
             ON w.persona = rl.persona
         LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='hate' GROUP BY persona) rh
             ON w.persona = rh.persona
         ORDER BY w.weight DESC`,
      )
      .all() as unknown as StatRow[];
    console.log(
      `${"Persona".padEnd(30)} ${"Weight".padStart(8)} ${"Sel".padStart(5)} ${"Like".padStart(5)} ${"Hate".padStart(5)}`,
    );
    console.log(
      `${"-".repeat(30)} ${"-".repeat(8)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(5)}`,
    );
    if (rows.length === 0) {
      console.log("(no weights recorded)");
    } else {
      for (const r of rows) {
        console.log(
          `${r.persona.padEnd(30)} ${r.weight.toFixed(2).padStart(8)} ${String(r.selections).padStart(5)} ${String(r.likes).padStart(5)} ${String(r.hates).padStart(5)}`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function cmdSessionEnd(_args: ParsedArgs): number {
  ensureDirs();
  const db = initDb();
  try {
    db.prepare(
      "UPDATE sessions SET ended_at = datetime('now') WHERE id = (SELECT MAX(id) FROM sessions)",
    ).run();
  } finally {
    db.close();
  }
  const active = loadActive();
  // 20% chance: emit a fun-fact callout block for Claude to fill (matches Python).
  if (active && Math.random() < 0.2) {
    const name =
      (active.name as string | undefined) ??
      (active.combo_name as string | undefined) ??
      (active.persona as string | undefined) ??
      "this persona";
    console.log(`> **Fun fact about ${name}:**`);
    console.log(`> [Claude: generate a fun, surprising fact about ${name} here]`);
    console.log();
  }
  deleteActive();
  console.log("Session ended. Persona deactivated.");
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const SUBCOMMANDS: Record<string, (args: ParsedArgs) => number> = {
  select: cmdSelect,
  deactivate: cmdDeactivate,
  rate: cmdRate,
  survey: cmdSurvey,
  "survey-answer": cmdSurveyAnswer,
  add: cmdAdd,
  stats: cmdStats,
  history: cmdHistory,
  "print-roster": cmdPrintRoster,
  "print-weights": cmdPrintWeights,
  "session-end": cmdSessionEnd,
};

function printHelp(): void {
  const subs = Object.keys(SUBCOMMANDS).join(", ");
  console.error(
    `usage: stark_persona <subcommand> [args]\nsubcommands: ${subs}`,
  );
}

function main(argv: string[]): number {
  if (argv.length === 0) {
    printHelp();
    return 1;
  }
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS[sub];
  if (!handler) {
    printHelp();
    return 1;
  }
  return handler(parseArgs(rest));
}

process.exit(main(process.argv.slice(2)));
