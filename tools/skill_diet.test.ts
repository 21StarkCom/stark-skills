// Unit tests for skill_diet detectors plus an integration smoke test for
// the CLI's --json and --check exit-code contract.

import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import {
  detectAll,
  detectInlineDispatchFailure,
  detectInlineGhAppTokenExport,
  detectInlineMultiAgentPosting,
  detectInlinePreflight,
  detectInlineScriptsConstants,
} from "./skill_diet.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "skill_diet.ts");

function makeRepo(t: TestContext): string | null {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-diet-"));
    fs.mkdirSync(path.join(tmp, ".git"));
    return tmp;
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return null;
  }
}

function runCli(repo: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

function writeSkill(repo: string, slug: string, body: string): void {
  const dir = path.join(repo, "skill", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

// ── Preflight ───────────────────────────────────────────────────

test("detectInlinePreflight flags an inline preflight block", () => {
  const raw = [
    "## Preflight",
    "",
    "Run environment validation:",
    "```bash",
    "python3 ~/.claude/code-review/scripts/preflight.py --workflow demo --json",
    "```",
    "Parse JSON: blocked → stop, degraded → warn, ready → continue.",
    "",
    "## Next",
    "",
  ].join("\n");
  const hits = detectInlinePreflight(raw);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].patternId, "inline-preflight");
  assert.equal(hits[0].startLine, 1); // ## Preflight
  assert.ok(hits[0].endLine >= 7);
  assert.equal(hits[0].refTarget, "standards/preflight.md");
});

test("detectInlinePreflight ignores skills already linking to the standard", () => {
  // The whole point of this detector — once a skill links to the canonical
  // standards doc, the inline copy is treated as already extracted.
  const raw = [
    "## Preflight",
    "",
    "Run [standard preflight](../../standards/preflight.md) with `--workflow demo`.",
    "",
    "## Next",
  ].join("\n");
  assert.deepEqual(detectInlinePreflight(raw), []);
});

test("detectInlinePreflight requires all three result keywords", () => {
  // A bare mention of preflight.py without blocked/degraded/ready is not
  // the canonical inline block — could be a code-path comment or a
  // diagnostic invocation.
  const raw = [
    "Sometimes we run `preflight.py` to debug.",
    "",
    "But that's all.",
  ].join("\n");
  assert.deepEqual(detectInlinePreflight(raw), []);
});

// ── Dispatch failure ────────────────────────────────────────────

test("detectInlineDispatchFailure flags the inline §2d block", () => {
  const raw = [
    "### 2d. Early termination check",
    "",
    "First, check dispatch health from the JSON output's `summary` field:",
    "- If `summary.succeeded == 0` (all sub-agents failed): this is a **dispatch failure**.",
    "  Run diagnostics: `which claude codex gemini`.",
    "  Skip remaining rounds.",
    "",
    "### 2e. Persist round",
  ].join("\n");
  const hits = detectInlineDispatchFailure(raw);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].patternId, "inline-dispatch-failure");
  assert.equal(hits[0].refTarget, "standards/dispatch-failure.md");
});

test("detectInlineDispatchFailure skips already-extracted skills", () => {
  const raw = [
    "### 2d. Early termination check",
    "",
    "Run the [shared dispatch-failure check](../../standards/dispatch-failure.md).",
  ].join("\n");
  assert.deepEqual(detectInlineDispatchFailure(raw), []);
});

// ── GitHub App token export ─────────────────────────────────────

test("detectInlineGhAppTokenExport flags every inline export line", () => {
  const raw = [
    "Setup:",
    "```bash",
    'export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)',
    "```",
    "",
    "Later:",
    'export GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-codex token)"',
  ].join("\n");
  const hits = detectInlineGhAppTokenExport(raw);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].startLine === hits[0].endLine);
  assert.equal(hits[0].patternId, "inline-gh-app-token-export");
});

// ── Multi-agent posting ─────────────────────────────────────────

test("detectInlineMultiAgentPosting flags blocks with 2+ agents close together", () => {
  const raw = [
    "Post per-agent comments:",
    "```bash",
    '$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review 42 --comment --body "..."',
    '$PYTHON $SCRIPTS/github_app.py --app stark-codex pr review 42 --comment --body "..."',
    '$PYTHON $SCRIPTS/github_app.py --app stark-gemini pr review 42 --comment --body "..."',
    "```",
  ].join("\n");
  const hits = detectInlineMultiAgentPosting(raw);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].patternId, "inline-multi-agent-posting");
});

test("detectInlineMultiAgentPosting ignores spread-out single-agent uses", () => {
  // A single agent invocation isn't the multi-post block.
  const raw = [
    '$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review 42 --comment --body "..."',
  ].join("\n");
  assert.deepEqual(detectInlineMultiAgentPosting(raw), []);
});

// ── Scripts/python constants ────────────────────────────────────

test("detectInlineScriptsConstants flags the constants block", () => {
  const raw = [
    "## Constants",
    "",
    "```bash",
    'SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"',
    'PYTHON="$SCRIPTS/.venv/bin/python3"',
    '[ -x "$PYTHON" ] || PYTHON=python3',
    "```",
  ].join("\n");
  const hits = detectInlineScriptsConstants(raw);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].patternId, "inline-scripts-constants");
  // Should absorb the chmod-fallback line.
  assert.equal(hits[0].endLine - hits[0].startLine, 2);
});

// ── detectAll ───────────────────────────────────────────────────

test("detectAll returns hits sorted by startLine", () => {
  const raw = [
    "## Preflight", // 1
    "",
    "python3 preflight.py --workflow demo", // 3
    "blocked / degraded / ready",
    "",
    "## Setup", // 6
    "",
    'export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)', // 8
  ].join("\n");
  const hits = detectAll(raw);
  // Both detectors should fire; results sorted ascending.
  assert.ok(hits.length >= 2);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].startLine >= hits[i - 1].startLine);
  }
});

// ── CLI integration ─────────────────────────────────────────────

test("CLI --json emits a summary and exits 0 by default", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(
      repo,
      "alpha",
      [
        "## Preflight",
        "python3 scripts/preflight.py --workflow alpha --json",
        "blocked / degraded / ready",
        "",
        "## Body",
      ].join("\n"),
    );
    const res = runCli(repo, ["--json"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.totals.skills, 1);
    assert.ok(parsed.totals.bytesInline > 0);
    assert.equal(parsed.reports[0].hits[0].patternId, "inline-preflight");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI --check exits non-zero when inline boilerplate remains", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(
      repo,
      "alpha",
      [
        "## Preflight",
        "python3 scripts/preflight.py --workflow alpha --json",
        "blocked / degraded / ready",
      ].join("\n"),
    );
    const res = runCli(repo, ["--check"]);
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI --check exits 0 when every skill links to the standard", (t) => {
  const repo = makeRepo(t);
  if (!repo) return;
  try {
    writeSkill(
      repo,
      "alpha",
      [
        "## Preflight",
        "Run [standard preflight](../../standards/preflight.md) with `--workflow alpha`.",
      ].join("\n"),
    );
    const res = runCli(repo, ["--check"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Regression: under Node 25's --experimental-strip-types, the entry-point
// gate goes silent when the script is invoked through a symlink (e.g.
// ~/.claude/code-review/tools/ → stark-skills/tools/). See
// review_setup_worktree for the full root cause. Guard by invoking through
// a real symlink and asserting the CLI parser actually runs.
test("CLI runs when invoked through a symlink (Node 25 strip-types regression)", (t) => {
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-diet-symlink-"));
  } catch (err) {
    t.skip(`os.tmpdir() unavailable: ${(err as Error).message}`);
    return;
  }
  const realScript = fileURLToPath(
    new URL("./skill_diet.ts", import.meta.url),
  );
  const linkedScript = path.join(tmp, "skill_diet.ts");
  try {
    fs.symlinkSync(realScript, linkedScript);
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", linkedScript, "--json"],
      { encoding: "utf8" },
    );
    // --json always prints a summary line; empty stdout means the gate
    // misfired and main() never ran.
    assert.ok(
      res.stdout.length > 0,
      `expected JSON output, got empty stdout (gate misfired). exit=${res.status}, stderr=${res.stderr}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
