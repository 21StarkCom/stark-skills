// Tests for `tools/jury.ts` — the CLI verbs, payload assembly, and both
// failure ladders.
//
// Every `run` here goes end to end through the REAL store, the REAL verifier
// and the REAL dispatch fan-out, with only the seat RUNNER faked: no vendor
// CLI is spawned, nothing bills, and the assertions are about files on disk
// rather than about mocks having been called.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DispatchDeps, RunOutcome, RunRequest, SeatBuilder, SeatRunner } from "./jury_dispatch.ts";
import type { SeatId } from "./jury_panel.ts";
import {
  BEGIN_MARKER,
  END_MARKER,
  HANDOFF_HEADER,
  JuryUsageError,
  OUTCOME_NEXT_STEP,
  SKILL_MODES,
  TASK_FRAMING,
  assemblePayload,
  defaultRepoRoot,
  formatHandoff,
  lintSkillReferences,
  listRows,
  main,
  modeFor,
  outcomeFailed,
  outcomeFor,
  parseArgs,
  resolveSkillId,
  runJury,
  showRun,
  skillPathFor,
  stripFrontmatter,
  type Io,
  type JuryRunResult,
  type RunDeps,
} from "./jury.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The three default-panel models, in both tables — panel validation is strict
 *  and checks both, so a test table missing one is a parse error, not a pass. */
const PANEL_DEPS = {
  rates: {
    "claude-opus-5": { input_per_1m_usd: 5, output_per_1m_usd: 25 },
    "gpt-5.5-pro": { input_per_1m_usd: 15, output_per_1m_usd: 120 },
    "gemini-3.1-pro-preview": { input_per_1m_usd: 2, output_per_1m_usd: 12 },
  },
  limits: {
    "claude-opus-5": { max_input_tokens: 200000, max_output_tokens: 64000 },
    "gpt-5.5-pro": { max_input_tokens: 400000, max_output_tokens: 128000 },
    "gemini-3.1-pro-preview": { max_input_tokens: 1048576, max_output_tokens: 65536 },
  },
};

const SEATS: SeatId[] = ["claude", "codex", "gemini"];

const VOICE_SKILL = [
  "---",
  "name: stark-voice",
  "description: write in the author's voice",
  "model: opus",
  "---",
  "",
  "## Method",
  "",
  "Short sentences. One idea each. No em-dashes, ever.",
  "Keep every number the brief gives you.",
].join("\n");

const JUDGE_SKILL = [
  "---",
  "name: stark-story-judge",
  "description: zero-context reader verdict",
  "---",
  "",
  "## Method",
  "",
  "Score seven dimensions 0-3, each with a verbatim quote from the post.",
  "State the total out of 21 and one verdict.",
].join("\n");

const SOURCE = [
  "# The midnight rollback",
  "",
  "We shipped the migration at midnight and it broke.",
  "",
  "Nobody wanted to say it out loud. The rollback plan was a wiki page.",
  "",
  "The pager stayed quiet. The alert had been muted in March.",
  "",
  "The fix cost us $1,013 in credits and a week of trust.",
].join("\n");

/** A rewrite candidate with no em-dash and no invented number: CLEAN under the
 *  voice rules, and long enough to clear the length floor. */
function cleanCandidate(tag: string): string {
  return [
    `# The midnight rollback (${tag})`,
    "",
    "We shipped the migration at midnight. It broke.",
    "",
    "Nobody said it out loud. The rollback plan was a wiki page.",
    "",
    "The pager stayed quiet. Someone had muted the alert in March.",
    "",
    "The fix cost us $1,013 in credits and a week of trust.",
  ].join("\n");
}

/** Same length class, one em-dash: DISQUALIFIED by `em-dash-zero`. */
function dirtyCandidate(tag: string): string {
  return cleanCandidate(tag).replace("It broke.", "It broke — loudly.");
}

interface JudgeRow {
  dim: string;
  score: number;
  quote: string | null;
}

const JUDGE_ROWS: JudgeRow[] = [
  { dim: "Hook", score: 3, quote: "We shipped the migration at midnight and it broke." },
  { dim: "One idea", score: 2, quote: "The rollback plan was a wiki page." },
  { dim: "Pull", score: 2, quote: "Nobody wanted to say it out loud." },
  { dim: "Voice", score: 3, quote: "The alert had been muted in March." },
  { dim: "Fluency", score: 3, quote: "The pager stayed quiet." },
  { dim: "Honesty", score: 2, quote: "a week of trust" },
  { dim: "Landing", score: 2, quote: "The fix cost us $1,013 in credits" },
];

function scorecard(rows: JudgeRow[] = JUDGE_ROWS, verdict = "PUBLISH AFTER FIXES"): string {
  const total = rows.reduce((a, r) => a + r.score, 0);
  const lines = [`VERDICT: ${verdict} - ${total}/21`, ""];
  for (const r of rows) {
    const quoted = r.quote === null ? "" : ` - "${r.quote}"`;
    lines.push(`- ${r.dim} - ${r.score}${quoted} - reads as intended.`);
  }
  return lines.join("\n");
}

/** A scorecard whose Hook row quotes a line the post never contained:
 *  DISQUALIFIED by `quote-anchoring`. */
function unanchoredScorecard(): string {
  return scorecard(
    JUDGE_ROWS.map((r) => (r.dim === "Hook" ? { ...r, quote: "A line the post never had." } : r)),
  );
}

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jury-cli-${tag}-`));
}

/** A throwaway repo root carrying just the skills a test dispatches. */
function makeRepo(skills: Record<string, string> = {}): string {
  const root = tmpDir("repo");
  const all: Record<string, string> = {
    "stark-voice": VOICE_SKILL,
    "stark-story-judge": JUDGE_SKILL,
    ...skills,
  };
  for (const [dir, body] of Object.entries(all)) {
    const target = path.join(root, "skill", dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), body);
  }
  return root;
}

function writeInputFile(name = "post.md", text = SOURCE): string {
  const dir = tmpDir("input");
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

/** A builder shaped enough to satisfy the codex guard in `buildSeatCommand`;
 *  argv shape itself is jury_dispatch's test, not this one's. */
const fakeBuilder: SeatBuilder = (prompt, model, ctx) => ({
  cmd: "fake-cli",
  args: ["exec", "--skip-git-repo-check", "--model", model ?? "?", ...(ctx?.effort ? ["--effort", ctx.effort] : [])],
  stdin: prompt,
  env: {},
});

type Reply = string | Partial<RunOutcome>;

function toOutcome(reply: Reply | undefined): RunOutcome {
  const base: RunOutcome = {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    notFound: false,
    stdinClosed: true,
    kill: null,
  };
  if (reply === undefined) return base;
  return typeof reply === "string" ? { ...base, stdout: reply } : { ...base, ...reply };
}

interface Fake {
  deps: DispatchDeps;
  requests: RunRequest[];
}

/** Fake dispatch deps: per-seat scripted replies, every filesystem edge stubbed,
 *  and a request log so a test can prove what each seat actually received. */
function fakeDispatch(
  replies: Partial<Record<SeatId, Reply>>,
  hook?: (req: RunRequest) => void,
): Fake {
  const requests: RunRequest[] = [];
  const runner: SeatRunner = async (req) => {
    requests.push(req);
    hook?.(req);
    return toOutcome(replies[req.seat]);
  };
  return {
    requests,
    deps: {
      runner,
      builders: { claude: fakeBuilder, codex: fakeBuilder, gemini: fakeBuilder },
      mkScratch: (seat) => `/tmp/jury-cli-scratch-${seat}`,
      cleanupScratch: () => {},
      config: {},
      rates: PANEL_DEPS.rates,
    },
  };
}

let clockTick = 0;

function runDeps(repoRoot: string, fake: Fake): RunDeps {
  clockTick = 0;
  return {
    repoRoot,
    dispatch: fake.deps,
    panel: PANEL_DEPS,
    now: new Date("2026-08-03T14:37:45Z"),
    rand: () => "beef",
    nowIso: () => {
      clockTick += 1;
      return `2026-08-03T14:3${clockTick % 10}:00.000Z`;
    },
  };
}

interface Scenario {
  result: JuryRunResult;
  root: string;
  fake: Fake;
}

async function scenario(
  skill: string,
  replies: Partial<Record<SeatId, Reply>>,
  opts: { source?: string; repo?: string; root?: string; hook?: (req: RunRequest) => void } = {},
): Promise<Scenario> {
  const root = opts.root ?? tmpDir("store");
  const repo = opts.repo ?? makeRepo();
  const fake = fakeDispatch(replies, opts.hook);
  const result = await runJury({
    skill,
    input: writeInputFile("post.md", opts.source ?? SOURCE),
    root,
    deps: runDeps(repo, fake),
  });
  return { result, root, fake };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function capture(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out: (t: string) => {
      io.stdout += t;
    },
    err: (t: string) => {
      io.stderr += t;
    },
  };
  return io;
}

// ---------------------------------------------------------------------------
// Skill ids + modes
// ---------------------------------------------------------------------------

test("the four skill ids resolve, and each carries its mode", () => {
  assert.deepEqual(Object.keys(SKILL_MODES).sort(), [
    "blog-sharpen",
    "story-edit",
    "story-judge",
    "voice",
  ]);
  assert.equal(modeFor(resolveSkillId("voice")), "rewrite");
  assert.equal(modeFor(resolveSkillId("story-edit")), "rewrite");
  assert.equal(modeFor(resolveSkillId("blog-sharpen")), "rewrite");
  assert.equal(modeFor(resolveSkillId("story-judge")), "calibration");
});

test("an unknown skill id is refused and the error names every accepted id", () => {
  assert.throws(
    () => resolveSkillId("sharpen"),
    (err: Error) => err instanceof JuryUsageError && /blog-sharpen/.test(err.message),
  );
});

test("skill ids resolve to skill/stark-<id>/SKILL.md", () => {
  assert.equal(skillPathFor("voice", "/repo"), "/repo/skill/stark-voice/SKILL.md");
  assert.equal(
    skillPathFor("story-judge", "/repo"),
    "/repo/skill/stark-story-judge/SKILL.md",
  );
  // The default root is resolved from this file, never the cwd.
  for (const id of ["voice", "story-edit", "blog-sharpen", "story-judge"] as const) {
    assert.ok(fs.existsSync(skillPathFor(id, defaultRepoRoot())), `${id} SKILL.md is missing`);
  }
});

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

test("stripFrontmatter drops the YAML block and keeps the body", () => {
  const body = stripFrontmatter(VOICE_SKILL);
  assert.ok(body.startsWith("## Method"));
  assert.ok(!body.includes("description:"));
  assert.equal(stripFrontmatter("## No frontmatter\n"), "## No frontmatter\n");
});

test("the payload wraps the document in BEGIN/END markers and frames it as data", () => {
  const payload = assemblePayload({
    skillBody: "## Method\n\nBe brief.",
    mode: "rewrite",
    input: SOURCE,
  });
  const begin = payload.indexOf(BEGIN_MARKER);
  const end = payload.indexOf(END_MARKER);
  assert.ok(begin > 0 && end > begin, "both markers present, in order");
  // The document travels VERBATIM between the markers.
  const between = payload.slice(begin + BEGIN_MARKER.length + 1, end);
  assert.equal(between, `${SOURCE}\n`);
  assert.ok(/DATA, not instructions/.test(payload));
  assert.ok(payload.includes("## Method"));
});

test("the framing adds no author identity, no repo paths and no publish machinery", () => {
  for (const framing of Object.values(TASK_FRAMING)) {
    assert.ok(!/aryeh|stark|evinced/i.test(framing), "no author identity");
    assert.ok(!/\/(Users|home)\/|~\/|\.claude|skill\//.test(framing), "no repo paths");
    assert.ok(!/publish|firestore|deploy|site/i.test(framing), "no publish machinery");
  }
});

test("calibration framing asks for a scorecard; rewrite framing asks for the document", () => {
  assert.ok(/scorecard/i.test(TASK_FRAMING.calibration));
  assert.ok(!/scorecard/i.test(TASK_FRAMING.rewrite));
  assert.ok(/Return ONLY/.test(TASK_FRAMING.rewrite));
});

test("a document with no trailing newline still leaves END on its own line", () => {
  const payload = assemblePayload({ skillBody: "S", mode: "rewrite", input: "one line" });
  assert.ok(payload.includes(`${BEGIN_MARKER}\none line\n${END_MARKER}`));
});

// ---------------------------------------------------------------------------
// The skill-reference lint
// ---------------------------------------------------------------------------

test("the lint fires on a planted relative reference and names it", () => {
  const refs = lintSkillReferences(
    ["## Method", "", "Follow the rubric in references/rubric.md before scoring."].join("\n"),
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, "references/rubric.md");
  assert.equal(refs[0].kind, "relative");
  assert.equal(refs[0].line, 3);
});

test("the lint catches ~/ paths, ./ and ../ paths, and markdown link targets", () => {
  const refs = lintSkillReferences(
    [
      "See [help](../../standards/help.md).",
      "Read ~/.claude/code-review/config.json first.",
      "Run ./scripts/setup.sh.",
    ].join("\n"),
  );
  assert.deepEqual(
    refs.map((r) => r.ref).sort(),
    ["../../standards/help.md", "./scripts/setup.sh", "~/.claude/code-review/config.json"],
  );
  assert.equal(refs.find((r) => r.ref.startsWith("~/"))?.kind, "home");
});

test("the lint ignores URLs and prose, and dedupes a repeated reference", () => {
  const refs = lintSkillReferences(
    [
      "Docs at https://example.com/docs/guide.md are fine.",
      "Ratios like 3.5 and words like e.g. are not paths.",
      "references/rubric.md",
      "references/rubric.md again",
    ].join("\n"),
  );
  assert.deepEqual(refs.map((r) => r.ref), ["references/rubric.md"]);
});

test("payload warnings from the lint land in the manifest and the handoff", async () => {
  const repo = makeRepo({
    "stark-voice": `${VOICE_SKILL}\n\nAlways consult references/rubric.md first.\n`,
  });
  const { result, root } = await scenario(
    "voice",
    { claude: cleanCandidate("a"), codex: cleanCandidate("b"), gemini: cleanCandidate("c") },
    { repo },
  );
  assert.equal(result.payloadWarnings.length, 1);
  assert.match(result.payloadWarnings[0], /references\/rubric\.md/);
  assert.match(result.payloadWarnings[0], /empty scratch cwd/);
  const manifest = readJson(path.join(result.paths.dir, "manifest.json"));
  assert.deepEqual(manifest.payload_warnings, result.payloadWarnings);
  assert.match(formatHandoff(result), /payload warnings:/);
  assert.ok(root.length > 0);
});

// ---------------------------------------------------------------------------
// run — end to end
// ---------------------------------------------------------------------------

test("run dispatches, verifies and stores every seat, and reports merge-ready", async () => {
  const { result } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: cleanCandidate("b"),
    gemini: cleanCandidate("c"),
  });

  assert.equal(result.skill, "voice");
  assert.equal(result.mode, "rewrite");
  assert.equal(result.outcome, "merge-ready");
  assert.equal(result.ladder, "complete");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.cleanSeats, SEATS);

  const dir = result.paths.dir;
  assert.ok(fs.existsSync(path.join(dir, "input.md")));
  assert.ok(fs.existsSync(path.join(dir, "prompt.md")));
  for (const seat of SEATS) {
    assert.ok(fs.existsSync(path.join(dir, "candidates", `${seat}.md`)), `${seat}.md`);
    assert.ok(fs.existsSync(path.join(dir, "candidates", `${seat}.meta.json`)), `${seat}.meta`);
    assert.ok(fs.existsSync(path.join(dir, "verify", `${seat}.json`)), `${seat} verdict`);
  }
  assert.equal(fs.readFileSync(path.join(dir, "input.md"), "utf8"), SOURCE);

  const manifest = readJson(path.join(dir, "manifest.json"));
  assert.equal(manifest.skill, "voice");
  assert.equal(manifest.mode, "rewrite");
  assert.equal(manifest.outcome, "merge-ready");
  assert.equal(manifest.finished_at, "2026-08-03T14:35:00.000Z");
  assert.equal(
    (manifest.panel as Array<Record<string, unknown>>).map((p) => p.effort).join(","),
    "max,xhigh,n/a",
  );
  assert.equal(
    (manifest.seats as Array<Record<string, unknown>>).every((s) => s.status === "clean"),
    true,
  );

  // One audit row per LLM call, appended as each seat returned.
  const audit = fs
    .readFileSync(path.join(dir, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((r) => r.kind), ["seat", "seat", "seat"]);
  assert.deepEqual([...audit.map((r) => r.seat)].sort(), [...SEATS].sort());
  assert.equal(audit.every((r) => r.verdict === "CLEAN"), true);
});

test("every seat receives a BYTE-IDENTICAL payload, and it is the stored prompt.md", async () => {
  const { result, fake } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: cleanCandidate("b"),
    gemini: cleanCandidate("c"),
  });
  assert.equal(fake.requests.length, 3);
  const stdins = fake.requests.map((r) => r.stdin);
  assert.equal(new Set(stdins).size, 1, "all three seats got the same bytes");

  const prompt = fs.readFileSync(path.join(result.paths.dir, "prompt.md"), "utf8");
  assert.equal(stdins[0], prompt);
  assert.ok(prompt.includes(BEGIN_MARKER) && prompt.includes(END_MARKER));
  assert.ok(prompt.includes(SOURCE), "the document travels verbatim");
  assert.ok(prompt.includes("## Method"), "the skill body travels");
  assert.ok(!prompt.includes("description: write in the author's voice"), "frontmatter stripped");
  assert.ok(!prompt.includes(result.paths.dir), "no repo/run paths in the payload");
});

test("the manifest SKELETON is on disk before the first seat is dispatched", async () => {
  // Its own store, scanned from the runner: a leftover run dir from another
  // test must not be able to satisfy this assertion.
  const root = tmpDir("store");
  const seen: Array<Record<string, unknown>> = [];
  await scenario(
    "voice",
    { claude: cleanCandidate("a"), codex: cleanCandidate("b"), gemini: cleanCandidate("c") },
    {
      root,
      hook: () => {
        for (const name of fs.readdirSync(root)) {
          for (const runId of fs.readdirSync(path.join(root, name))) {
            const file = path.join(root, name, runId, "manifest.json");
            if (fs.existsSync(file)) seen.push(readJson(file));
          }
        }
      },
    },
  );
  assert.equal(seen.length, 3, "one manifest read per in-flight seat");
  for (const skeleton of seen) {
    assert.equal(skeleton.finished_at, null, "still a skeleton while seats are in flight");
    assert.equal(skeleton.outcome, null);
    assert.equal(skeleton.skill, "voice");
    assert.equal(
      (skeleton.seats as Array<Record<string, unknown>>).every((s) => s.status === "pending"),
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// The rewrite ladder
// ---------------------------------------------------------------------------

test("rewrite ladder: two CLEAN and one DISQUALIFIED is merge-ready", async () => {
  const { result } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: dirtyCandidate("b"),
    gemini: cleanCandidate("c"),
  });
  assert.equal(result.outcome, "merge-ready");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.cleanSeats, ["claude", "gemini"]);
  const codex = result.seats.find((s) => s.seat === "codex");
  assert.equal(codex?.verdict, "DISQUALIFIED");
  assert.deepEqual(codex?.violations.map((v) => v.rule), ["em-dash-zero"]);
  assert.equal(readJson(path.join(result.paths.dir, "verify", "codex.json")).verdict, "DISQUALIFIED");
});

test("rewrite ladder: exactly one CLEAN candidate means NO merge", async () => {
  const { result } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: dirtyCandidate("b"),
    gemini: dirtyCandidate("c"),
  });
  assert.equal(result.outcome, "single-candidate");
  assert.equal(result.exitCode, 0, "one clean rewrite is a usable result, not a failure");
  assert.deepEqual(result.cleanSeats, ["claude"]);
  const handoff = formatHandoff(result);
  assert.match(handoff, /merge NOTHING/);
  assert.match(handoff, /theater/);
});

test("rewrite ladder: zero CLEAN candidates errors loudly with every violation listed", async () => {
  const { result } = await scenario("voice", {
    claude: dirtyCandidate("a"),
    codex: dirtyCandidate("b"),
    gemini: dirtyCandidate("c"),
  });
  assert.equal(result.outcome, "no-clean-candidates");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.cleanSeats, []);
  const handoff = formatHandoff(result);
  assert.match(handoff, /violations:/);
  for (const seat of SEATS) {
    assert.ok(
      new RegExp(`${seat}\\s+DISQUALIFY\\s+em-dash-zero`).test(handoff),
      `${seat}'s violation is listed`,
    );
  }
  assert.match(handoff, /RUN FAILED: zero CLEAN candidates/);
});

test("every seat failing is recorded, not thrown: the manifest names all three", async () => {
  const { result } = await scenario("voice", {
    claude: { code: 1, stderr: "claude: rate limited" },
    codex: { code: 1, stderr: "codex: rate limited" },
    gemini: { code: 1, stderr: "gemini: rate limited" },
  });
  assert.equal(result.ladder, "all-failed");
  assert.equal(result.outcome, "no-clean-candidates");
  assert.equal(result.exitCode, 1);

  const manifest = readJson(path.join(result.paths.dir, "manifest.json"));
  const dispatchError = String(manifest.dispatch_error);
  for (const seat of SEATS) assert.ok(dispatchError.includes(seat), `${seat} named`);
  // A failed seat writes no candidate, but its meta and audit row survive.
  for (const seat of SEATS) {
    assert.equal(fs.existsSync(path.join(result.paths.dir, "candidates", `${seat}.md`)), false);
    const meta = readJson(path.join(result.paths.dir, "candidates", `${seat}.meta.json`));
    assert.equal(meta.status, "failed");
    assert.equal((meta.failure as Record<string, unknown>).reason, "exit_nonzero");
  }
  assert.equal(fs.readFileSync(path.join(result.paths.dir, "audit.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("a partially failed panel still merges from the survivors", async () => {
  const { result } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: { code: 1, stderr: "boom" },
    gemini: cleanCandidate("c"),
  });
  assert.equal(result.ladder, "partial");
  assert.equal(result.outcome, "merge-ready");
  assert.equal(result.exitCode, 0);
  const codex = result.seats.find((s) => s.seat === "codex");
  assert.equal(codex?.status, "failed");
  assert.equal(codex?.candidatePath, null);
  assert.match(formatHandoff(result), /failure: exit_nonzero/);
});

// ---------------------------------------------------------------------------
// The calibration ladder
// ---------------------------------------------------------------------------

test("calibration ladder: two or more CLEAN scorecards is calibration-ready", async () => {
  const { result } = await scenario("story-judge", {
    claude: scorecard(),
    codex: scorecard(JUDGE_ROWS, "REWRITE"),
    gemini: scorecard(),
  });
  assert.equal(result.mode, "calibration");
  assert.equal(result.outcome, "calibration-ready");
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanSeats.length, 3);
  const handoff = formatHandoff(result);
  assert.match(handoff, /Never average, never rank, never a third judge/);
  assert.match(handoff, /disagreements left OPEN/);
});

test("calibration ladder: one CLEAN scorecard is a FAILED calibration", async () => {
  const { result } = await scenario("story-judge", {
    claude: scorecard(),
    codex: unanchoredScorecard(),
    gemini: "I could not judge this post.",
  });
  assert.equal(result.outcome, "single-scorecard");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.cleanSeats, ["claude"]);
  const handoff = formatHandoff(result);
  assert.match(handoff, /CALIBRATION FAILED \(single-scorecard\)/);
  assert.match(handoff, /no agreement measurement/);
  const codex = result.seats.find((s) => s.seat === "codex");
  assert.ok(codex?.violations.some((v) => v.rule === "quote-anchoring"));
});

test("calibration ladder: no CLEAN scorecard is labelled no-scorecard", async () => {
  const { result } = await scenario("story-judge", {
    claude: unanchoredScorecard(),
    codex: unanchoredScorecard(),
    gemini: { code: 1, stderr: "gemini: quota" },
  });
  assert.equal(result.outcome, "no-scorecard");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.cleanSeats, []);
  assert.match(formatHandoff(result), /CALIBRATION FAILED \(no-scorecard\)/);
});

test("the ladder table is decided by CLEAN COUNT, per mode", () => {
  assert.equal(outcomeFor("rewrite", 0), "no-clean-candidates");
  assert.equal(outcomeFor("rewrite", 1), "single-candidate");
  assert.equal(outcomeFor("rewrite", 3), "merge-ready");
  assert.equal(outcomeFor("calibration", 0), "no-scorecard");
  assert.equal(outcomeFor("calibration", 1), "single-scorecard");
  assert.equal(outcomeFor("calibration", 2), "calibration-ready");
  assert.deepEqual(
    (Object.keys(OUTCOME_NEXT_STEP) as Array<keyof typeof OUTCOME_NEXT_STEP>).filter(outcomeFailed),
    ["no-clean-candidates", "single-scorecard", "no-scorecard"],
  );
});

// ---------------------------------------------------------------------------
// The handoff block
// ---------------------------------------------------------------------------

test("the handoff block carries the header, the paths, every verdict and the next step", async () => {
  const { result } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: dirtyCandidate("b"),
    gemini: cleanCandidate("c"),
  });
  const handoff = formatHandoff(result);
  const lines = handoff.split("\n");
  assert.equal(lines[0], HANDOFF_HEADER);
  assert.match(handoff, new RegExp(`run:\\s+${result.runId}`));
  assert.match(handoff, /skill:\s+voice\s+mode: rewrite/);
  assert.match(handoff, /panel:\s+claude=claude-opus-5:max,codex=gpt-5\.5-pro:xhigh,gemini=gemini-3\.1-pro-preview/);
  assert.match(handoff, /outcome:\s+merge-ready\s+dispatch: complete/);
  assert.ok(handoff.includes(result.paths.dir));
  assert.ok(handoff.includes(result.paths.input));
  assert.ok(handoff.includes(result.paths.prompt));
  assert.match(handoff, /claude\s+claude-opus-5:max\s+CLEAN\s+candidates\/claude\.md/);
  assert.match(handoff, /gemini\s+gemini-3\.1-pro-preview\s+CLEAN/);
  assert.match(handoff, /codex\s+gpt-5\.5-pro:xhigh\s+DISQUALIFIED/);
  assert.match(handoff, /^next: /m);
  assert.ok(handoff.includes(result.paths.audit), "the session is told where its audit row goes");
});

test("run --json prints the machine shape with paths, verdicts and the next step", async () => {
  const root = tmpDir("store");
  const repo = makeRepo();
  const fake = fakeDispatch({
    claude: cleanCandidate("a"),
    codex: cleanCandidate("b"),
    gemini: cleanCandidate("c"),
  });
  const io = capture();
  const code = await main(
    ["run", "--skill", "voice", "--input", writeInputFile(), "--root", root, "--json"],
    io,
    runDeps(repo, fake),
  );
  assert.equal(code, 0);
  const payload = JSON.parse(io.stdout) as Record<string, unknown>;
  assert.equal(payload.outcome, "merge-ready");
  assert.equal(payload.skill, "voice");
  assert.equal((payload.seats as unknown[]).length, 3);
  assert.equal(payload.next_step, OUTCOME_NEXT_STEP["merge-ready"]);
  assert.ok(String(payload.merge).endsWith("merge.md"));
});

// ---------------------------------------------------------------------------
// list / show
// ---------------------------------------------------------------------------

test("list reports the runs in the store, and --name narrows to one input", async () => {
  const root = tmpDir("store");
  const repo = makeRepo();
  for (const name of ["alpha", "beta"]) {
    await runJury({
      skill: "voice",
      input: writeInputFile(`${name}.md`),
      root,
      deps: runDeps(
        repo,
        fakeDispatch({
          claude: cleanCandidate("a"),
          codex: cleanCandidate("b"),
          gemini: cleanCandidate("c"),
        }),
      ),
    });
  }
  const rows = listRows({ root });
  assert.equal(rows.length, 2);
  assert.deepEqual([...rows.map((r) => r.name)].sort(), ["alpha", "beta"]);
  assert.equal(rows.every((r) => r.outcome === "merge-ready"), true);
  assert.equal(rows.every((r) => r.skill === "voice"), true);
  assert.deepEqual(listRows({ root, name: "alpha" }).map((r) => r.name), ["alpha"]);

  const io = capture();
  assert.equal(await main(["list", "--root", root], io), 0);
  assert.match(io.stdout, /RUN\s+NAME\s+SKILL\s+OUTCOME/);
  assert.match(io.stdout, /alpha/);

  const jsonIo = capture();
  assert.equal(await main(["list", "--root", root, "--json"], jsonIo), 0);
  assert.equal((JSON.parse(jsonIo.stdout) as unknown[]).length, 2);
});

test("list on an empty store says so instead of failing", async () => {
  const io = capture();
  assert.equal(await main(["list", "--root", tmpDir("store")], io), 0);
  assert.match(io.stdout, /no jury runs found/);
});

test("show reads one run back out of the store, verdicts included", async () => {
  const { result, root } = await scenario("voice", {
    claude: cleanCandidate("a"),
    codex: dirtyCandidate("b"),
    gemini: cleanCandidate("c"),
  });
  const show = showRun(result.runId, { root });
  assert.equal(show.run_id, result.runId);
  assert.deepEqual(show.candidates, SEATS);
  assert.equal(show.seats.find((s) => s["seat"] === "codex")?.["verdict"], "DISQUALIFIED");
  assert.equal(show.manifest?.outcome, "merge-ready");

  const io = capture();
  assert.equal(await main(["show", result.runId, "--root", root], io), 0);
  assert.match(io.stdout, /skill:\s+voice/);
  assert.match(io.stdout, /codex\s+DISQUALIFIED/);

  const jsonIo = capture();
  assert.equal(await main(["show", result.runId, "--root", root, "--json"], jsonIo), 0);
  assert.equal((JSON.parse(jsonIo.stdout) as Record<string, unknown>).run_id, result.runId);
});

test("show refuses an unknown run id rather than printing an empty shell", async () => {
  const io = capture();
  assert.equal(await main(["show", "nope", "--root", tmpDir("store")], io), 2);
  assert.match(io.stderr, /no run "nope"/);
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test("--help prints usage and exits 0; a bare invocation exits 2", async () => {
  const help = capture();
  assert.equal(await main(["--help"], help), 0);
  assert.match(help.stdout, /Usage: jury\.ts <run\|list\|show>/);
  assert.match(help.stdout, /voice, story-edit, blog-sharpen, story-judge/);

  const bare = capture();
  assert.equal(await main([], bare), 2);
});

test("an unknown flag is a hard error, never a silent no-op", () => {
  assert.throws(() => parseArgs(["run", "--skil", "voice"]), /unknown flag "--skil"/);
  assert.throws(() => parseArgs(["run", "--skill"]), /--skill requires a value/);
  assert.throws(() => parseArgs(["run", "--timeout-sec", "0"]), /positive number/);
});

test("run refuses a missing flag, an unknown skill and an unreadable input", async () => {
  const root = tmpDir("store");
  const noSkill = capture();
  assert.equal(await main(["run", "--input", writeInputFile(), "--root", root], noSkill), 2);
  assert.match(noSkill.stderr, /run requires --skill/);

  const badSkill = capture();
  assert.equal(
    await main(["run", "--skill", "nope", "--input", writeInputFile(), "--root", root], badSkill, {
      repoRoot: makeRepo(),
      panel: PANEL_DEPS,
    }),
    2,
  );
  assert.match(badSkill.stderr, /unknown skill "nope"/);

  const badInput = capture();
  assert.equal(
    await main(
      ["run", "--skill", "voice", "--input", "/nope/missing.md", "--root", root],
      badInput,
      { repoRoot: makeRepo(), panel: PANEL_DEPS },
    ),
    2,
  );
  assert.match(badInput.stderr, /cannot read the input document/);
});

test("an invalid panel spec dies before anything is dispatched", async () => {
  const root = tmpDir("store");
  const fake = fakeDispatch({});
  const io = capture();
  const code = await main(
    [
      "run",
      "--skill",
      "voice",
      "--input",
      writeInputFile(),
      "--root",
      root,
      "--panel",
      "gemini=gemini-3.1-pro-preview:max",
    ],
    io,
    runDeps(makeRepo(), fake),
  );
  assert.equal(code, 2);
  assert.match(io.stderr, /takes no effort/);
  assert.equal(fake.requests.length, 0, "no seat was dispatched");
  assert.equal(fs.readdirSync(root).length, 0, "no run dir was created");
});
