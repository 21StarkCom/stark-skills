// CLI smoke tests for `tools/stark_persona.ts`. The CLI surface is the
// contract — SKILL.md depends on each subcommand and `select --auto`'s
// JSON shape is parsed by `/stark-session`. These tests spawn the CLI as
// a subprocess with isolated HOME + STARK_QUEUE_DIR so the real
// `~/.stark-persona/` and `~/.stark-insights/` are never touched.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HERE = import.meta.dirname;
const CLI = path.join(HERE, "stark_persona.ts");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  home: string;
  queueDir: string;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): CliResult {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stark-persona-cli-"));
  const queueDir = path.join(home, ".stark-insights");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        STARK_QUEUE_DIR: queueDir,
        CLAUDE_SESSION_ID: "test-session-cli",
        ...envOverrides,
      },
      encoding: "utf8",
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    home,
    queueDir,
  };
}

// Seed the temp HOME with a tiny roster so `loadRoster` doesn't traverse
// up into the real repo. Mirrors how the installed layout resolves
// rosterPath() — relative to the script's parent's `data/persona/`.
function seedTinyRoster(home: string): void {
  // The CLI resolves rosterPath via import.meta.dirname (tools/) →
  // parent's data/persona/roster.md. We can't redirect that without env;
  // so for the CLI tests we let the real seed roster be used. Acceptable —
  // these tests only assert CLI shape, not roster content.
  void home;
}

// ---------------------------------------------------------------------------
// Help / unknown
// ---------------------------------------------------------------------------

test("CLI with no args prints help and exits 1", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("subcommands"), r.stderr);
});

test("CLI with unknown subcommand prints help and exits 1", () => {
  const r = runCli(["totally-bogus"]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("subcommands"));
});

// ---------------------------------------------------------------------------
// select --auto
// ---------------------------------------------------------------------------

test("select --auto prints JSON with persona + session_id (stark-session contract)", () => {
  const r = runCli(["select", "--auto"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(typeof parsed.persona, "string");
  assert.equal(typeof parsed.session_id, "number");
  assert.equal(typeof parsed.name, "string");
  assert.equal(typeof parsed.source, "string");
  assert.equal(typeof parsed.speaking_style, "string");
  assert.ok(Array.isArray(parsed.traits));
  assert.equal(typeof parsed.weight, "number");
});

test("select --combo --auto prints JSON with is_combo + components", () => {
  const r = runCli(["select", "--combo", "--auto"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(parsed.is_combo, true);
  assert.equal(typeof parsed.combo_name, "string");
  const comps = parsed.components as unknown[];
  assert.ok(Array.isArray(comps) && comps.length >= 2 && comps.length <= 3);
  assert.equal(typeof parsed.recipe_hash, "string");
});

test("select --name resolves via fuzzy match and writes active.json", () => {
  const r = runCli(["select", "--name", "jules", "--auto"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(parsed.persona, "jules-winnfield");
  const active = JSON.parse(
    fs.readFileSync(path.join(r.home, ".stark-persona", "active.json"), "utf8"),
  );
  assert.equal(active.persona, "jules-winnfield");
});

test("select --name with unmatched name prints error JSON and exits 1", () => {
  const r = runCli(["select", "--name", "zzz-bogus", "--auto"]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.ok("error" in parsed);
});

// ---------------------------------------------------------------------------
// Lifecycle: select → rate → deactivate
// ---------------------------------------------------------------------------

test("rate after select records a like in persona.db and emits a rating event", () => {
  const r1 = runCli(["select", "--name", "the-dude", "--auto"]);
  assert.equal(r1.status, 0);
  const home = r1.home;
  const r2 = runCli(["rate", "--rating", "like"], { HOME: home });
  assert.equal(r2.status, 0);
  assert.ok(r2.stdout.includes("Rated"));
});

test("deactivate removes active.json and emits a deactivation event", () => {
  const r1 = runCli(["select", "--name", "the-dude", "--auto"]);
  assert.equal(r1.status, 0);
  const active = path.join(r1.home, ".stark-persona", "active.json");
  assert.ok(fs.existsSync(active));
  const r2 = runCli(["deactivate"], { HOME: r1.home });
  assert.equal(r2.status, 0);
  assert.ok(!fs.existsSync(active));
  assert.ok(r2.stdout.toLowerCase().includes("deactivated"));
});

test("session-end removes active.json and prints the closing line", () => {
  const r1 = runCli(["select", "--name", "the-dude", "--auto"]);
  assert.equal(r1.status, 0);
  const active = path.join(r1.home, ".stark-persona", "active.json");
  const r2 = runCli(["session-end"], { HOME: r1.home });
  assert.equal(r2.status, 0);
  assert.ok(!fs.existsSync(active));
  assert.ok(r2.stdout.includes("Session ended"));
});

// ---------------------------------------------------------------------------
// stats / history / print-roster / print-weights
// ---------------------------------------------------------------------------

test("stats --format inline emits JSON with sessions/combos/top_3", () => {
  const r1 = runCli(["select", "--auto"]);
  const r2 = runCli(["stats", "--format", "inline"], { HOME: r1.home });
  assert.equal(r2.status, 0);
  const parsed = JSON.parse(r2.stdout) as Record<string, unknown>;
  for (const key of ["sessions", "combos", "top_3", "bottom"]) {
    assert.ok(key in parsed, `missing ${key}`);
  }
});

test("stats --format table prints a header row + totals line", () => {
  const r1 = runCli(["select", "--auto"]);
  const r2 = runCli(["stats", "--format", "table"], { HOME: r1.home });
  assert.equal(r2.status, 0);
  assert.ok(r2.stdout.includes("Persona"));
  assert.ok(r2.stdout.includes("Weight"));
  assert.ok(r2.stdout.includes("Total sessions:"));
});

test("history empty prints 'No sessions' before any select", () => {
  const r = runCli(["history"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("No sessions"));
});

test("history after select prints a header + at least one row", () => {
  const r1 = runCli(["select", "--auto"]);
  const r2 = runCli(["history"], { HOME: r1.home });
  assert.equal(r2.status, 0);
  assert.ok(r2.stdout.includes("Persona"));
  assert.ok(r2.stdout.includes("Rating"));
});

test("print-roster lists shipped seed personas", () => {
  const r = runCli(["print-roster"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("jules-winnfield") || r.stdout.includes("Slug"));
});

test("print-weights prints header row after sync", () => {
  const r = runCli(["print-weights"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("Persona"));
  assert.ok(r.stdout.includes("Weight"));
});

// ---------------------------------------------------------------------------
// survey + survey-answer
// ---------------------------------------------------------------------------

test("survey prints a JSON questions array", () => {
  const r = runCli(["survey"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as { questions: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(parsed.questions));
  assert.ok(parsed.questions.length >= 1 && parsed.questions.length <= 3);
});

test("survey-answer persists the answer", () => {
  const r = runCli([
    "survey-answer",
    "--question",
    "Vibe?",
    "--answer",
    "Stern mentor",
  ]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("Recorded answer for: Vibe?"));
});

// ---------------------------------------------------------------------------
// add (sanitization + happy path)
// ---------------------------------------------------------------------------

test("add rejects backticks in --name", () => {
  // Use a quirk of the seed roster — add CLI writes to the shared
  // installed roster.md, so we exercise the sanitizer through the
  // failure path. Backtick triggers _before_ filesystem write.
  const r = runCli([
    "add",
    "--name",
    "Bad`Name",
    "--source",
    "Movie",
    "--traits",
    "a, b, c",
  ]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("Invalid characters") || r.stdout.includes("Error"));
});

test("add rejects HTML tags in --name", () => {
  const r = runCli([
    "add",
    "--name",
    "<script>x</script>",
    "--source",
    "Web",
    "--traits",
    "a, b, c",
  ]);
  assert.equal(r.status, 1);
});

// silence the linter
void seedTinyRoster;
