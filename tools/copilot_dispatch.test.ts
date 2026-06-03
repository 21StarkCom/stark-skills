import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  collectDiff,
  createWorktree,
  cleanupWorktree,
  extractVerdictJson,
  isPlainObject,
  normalizeVerdict,
  parseCodexJsonl,
  parseGeminiJson,
  buildReviewPayload,
  buildClaudeCmd,
  buildFixPrompt,
  restoreWorktree,
  sanitizeRef,
  shouldFallbackToApiKey,
  snapshotWorktree,
  tokenizeShell,
  DEFAULT_GOAL_MAX_BUDGET_USD,
  VALID_AGENTS,
} from "./copilot_dispatch.ts";

// --- extractVerdictJson ----------------------------------------------------

describe("extractVerdictJson", () => {
  test("parses fenced ```json block", () => {
    const text =
      "Some preamble.\n\n```json\n" +
      '{"verdict": "approve", "blocking_findings": [], ' +
      '"non_blocking_suggestions": ["x"], "summary": "lgtm"}\n```\n';
    const v = extractVerdictJson(text);
    assert.ok(v !== null);
    const n = normalizeVerdict(v!);
    assert.deepEqual(n, { verdict: "approve", blocking: [], suggestions: ["x"], summary: "lgtm" });
  });

  test("parses bare trailing JSON object", () => {
    const text = 'analysis here\n{"verdict":"revise","blocking_findings":["a","b"]}';
    const v = extractVerdictJson(text);
    assert.ok(v !== null);
    const n = normalizeVerdict(v!);
    assert.equal(n.verdict, "revise");
    assert.deepEqual(n.blocking, ["a", "b"]);
  });

  test("returns null when no JSON present", () => {
    assert.equal(extractVerdictJson("just prose, no json at all"), null);
  });

  test("unknown verdict normalizes to unparseable", () => {
    const v = extractVerdictJson('```json\n{"verdict":"maybe"}\n```');
    assert.ok(v !== null);
    assert.equal(normalizeVerdict(v!).verdict, "unparseable");
  });

  test("picks last fenced block when multiple present", () => {
    const text =
      '```json\n{"verdict":"revise","blocking_findings":["old"]}\n```\n' +
      "later thoughts\n" +
      '```json\n{"verdict":"approve","blocking_findings":[]}\n```\n';
    const v = extractVerdictJson(text);
    assert.equal(normalizeVerdict(v!).verdict, "approve");
  });

  test("ignores braces inside JSON strings (no desync)", () => {
    // The naive Python scanner desyncs on `{` inside a string. Our scanner
    // tracks string state. The verdict object has a body field containing
    // a literal `{` — depth must not drop to 0 prematurely.
    const text =
      '```json\n{"verdict":"approve","summary":"contains a } and { mid-string"}\n```';
    const v = extractVerdictJson(text);
    assert.ok(v !== null);
    const n = normalizeVerdict(v!);
    assert.equal(n.verdict, "approve");
    assert.equal(n.summary, "contains a } and { mid-string");
  });

  test("skips non-verdict objects when scanning for trailing object", () => {
    // First object lacks verdict; should fall through to second.
    const text =
      '{"unrelated": 1}\n' +
      'analysis...\n' +
      '{"verdict":"block","blocking_findings":["x"]}';
    const v = extractVerdictJson(text);
    assert.ok(v !== null);
    assert.equal(normalizeVerdict(v!).verdict, "block");
  });
});

// --- normalizeVerdict ------------------------------------------------------

describe("normalizeVerdict", () => {
  test("coerces non-string list items to strings", () => {
    const n = normalizeVerdict({ verdict: "revise", blocking_findings: [1, true, "ok"] });
    assert.deepEqual(n.blocking, ["1", "true", "ok"]);
  });

  test("ignores non-array blocking_findings (no character-iteration footgun)", () => {
    // Python's [str(x) for x in ...] would iterate over characters of a
    // string. Our toStringList must guard against this.
    const n = normalizeVerdict({ verdict: "revise", blocking_findings: "oops" });
    assert.deepEqual(n.blocking, []);
  });

  test("trims and lowercases verdict", () => {
    assert.equal(normalizeVerdict({ verdict: "  APPROVE  " }).verdict, "approve");
  });

  test("treats missing verdict as unparseable", () => {
    assert.equal(normalizeVerdict({}).verdict, "unparseable");
  });
});

// --- parseCodexJsonl -------------------------------------------------------

describe("parseCodexJsonl", () => {
  test("passes through non-JSONL output unchanged", () => {
    assert.equal(parseCodexJsonl("plain text"), "plain text");
  });

  test("extracts agent_message events", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"other"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"world"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "hello\nworld");
  });

  test("extracts legacy message+content events", () => {
    const raw = '{"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}';
    assert.equal(parseCodexJsonl(raw), "hi");
  });

  test("skips malformed JSON lines", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
      'not json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "a\nb");
  });
});

// --- parseGeminiJson -------------------------------------------------------

describe("parseGeminiJson", () => {
  test("unwraps single response envelope", () => {
    assert.equal(parseGeminiJson('{"response":"hello"}'), "hello");
  });

  test("joins array of response envelopes", () => {
    assert.equal(parseGeminiJson('[{"response":"a"},{"response":"b"}]'), "a\nb");
  });

  test("passes through non-envelope output", () => {
    assert.equal(parseGeminiJson("plain text"), "plain text");
  });
});

// --- isPlainObject / sanitizeRef ------------------------------------------

describe("isPlainObject", () => {
  test("true for plain objects", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
  });
  test("false for arrays, null, primitives", () => {
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("s"), false);
    assert.equal(isPlainObject(1), false);
  });
});

describe("sanitizeRef", () => {
  test("replaces unsafe chars with dashes", () => {
    assert.equal(sanitizeRef("phase 1/task:2"), "phase-1-task-2");
  });
  test("preserves alphanumerics and dot/underscore/dash", () => {
    assert.equal(sanitizeRef("a.b-c_d-1"), "a.b-c_d-1");
  });
});

// --- shouldFallbackToApiKey -----------------------------------------------

describe("shouldFallbackToApiKey", () => {
  test("matches known ADC failure patterns", () => {
    assert.equal(shouldFallbackToApiKey("UNAUTHENTICATED"), true);
    assert.equal(shouldFallbackToApiKey("DefaultCredentialsError: ..."), true);
    assert.equal(shouldFallbackToApiKey("got 403 from server"), true);
  });
  test("returns false for unrelated stderr", () => {
    assert.equal(shouldFallbackToApiKey("connection refused"), false);
  });
});

// --- tokenizeShell --------------------------------------------------------

describe("tokenizeShell", () => {
  test("splits on whitespace", () => {
    assert.deepEqual(tokenizeShell("npm test --silent"), ["npm", "test", "--silent"]);
  });
  test("respects single quotes", () => {
    assert.deepEqual(tokenizeShell("a 'b c' d"), ["a", "b c", "d"]);
  });
  test("respects double quotes with escapes", () => {
    assert.deepEqual(tokenizeShell('a "b\\"c" d'), ["a", 'b"c', "d"]);
  });
  test("throws on unterminated quote", () => {
    assert.throws(() => tokenizeShell('a "b'), /unterminated quote/);
  });
});

// --- VALID_AGENTS sanity --------------------------------------------------

describe("VALID_AGENTS", () => {
  test("contains exactly the three known agents", () => {
    assert.deepEqual([...VALID_AGENTS].sort(), ["claude", "codex", "gemini"]);
  });
});

// --- buildReviewPayload / buildFixPrompt -----------------------------------

describe("buildReviewPayload", () => {
  test("includes test result and diff", () => {
    const out = buildReviewPayload("REVIEW", "TASK", "@@diff", true, []);
    assert.match(out, /REVIEW/);
    assert.match(out, /TASK/);
    assert.match(out, /passed/);
    assert.match(out, /@@diff/);
  });
  test("substitutes '(empty diff)' for blank diff", () => {
    const out = buildReviewPayload("R", "T", "   ", null, []);
    assert.match(out, /\(empty diff\)/);
    assert.match(out, /no test command/);
  });
  test("renders prior rounds section when present", () => {
    const out = buildReviewPayload("R", "T", "d", false, [
      { round_num: 1, verdict: "revise", blocking_findings: ["nit"], summary: "small fix" },
    ]);
    assert.match(out, /Prior review history/);
    assert.match(out, /### Round 1: revise/);
    assert.match(out, /- nit/);
    assert.match(out, /Summary: small fix/);
  });
});

describe("buildFixPrompt", () => {
  test("embeds findings as bullet list", () => {
    const out = buildFixPrompt("BASE", "TASK", ["a", "b"], 2);
    assert.match(out, /Round 2/);
    assert.match(out, /- a/);
    assert.match(out, /- b/);
    assert.match(out, /BASE/);
    assert.match(out, /TASK/);
  });
  test("falls back to placeholder when findings empty", () => {
    const out = buildFixPrompt("B", "T", [], 3);
    assert.match(out, /\(no findings — fix anyway\)/);
  });
});

// --- snapshot / restore / collectDiff (real git, tmp repo) -----------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "f.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  // Lead-style staged change.
  writeFileSync(path.join(dir, "f.txt"), "lead-version\n");
  git(dir, "add", "-A");
  return dir;
}

describe("snapshotWorktree / restoreWorktree", () => {
  test("snapshot is stable across repeated calls on unchanged worktree", async () => {
    const dir = makeRepo();
    try {
      const s1 = await snapshotWorktree(dir);
      const s2 = await snapshotWorktree(dir);
      assert.deepEqual(s1, s2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects in-place modification of a staged file (regression)", async () => {
    // git status --porcelain stays byte-identical when a staged path's
    // content is replaced and re-staged. The write-tree based snapshot
    // must detect it.
    const dir = makeRepo();
    try {
      const pre = await snapshotWorktree(dir);
      writeFileSync(path.join(dir, "f.txt"), "wing-mutated\n");
      git(dir, "add", "-A");
      const post = await snapshotWorktree(dir);
      assert.notEqual(pre[1], post[1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects new untracked file", async () => {
    const dir = makeRepo();
    try {
      const pre = await snapshotWorktree(dir);
      writeFileSync(path.join(dir, "new.txt"), "wing-added\n");
      const post = await snapshotWorktree(dir);
      assert.notEqual(pre[1], post[1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("restore brings worktree back to a deterministic HEAD state", async () => {
    const dir = makeRepo();
    try {
      const pre = await snapshotWorktree(dir);
      writeFileSync(path.join(dir, "f.txt"), "wing-mutated\n");
      writeFileSync(path.join(dir, "extra.txt"), "garbage\n");
      git(dir, "add", "-A");
      await restoreWorktree(dir, pre);
      const after = await snapshotWorktree(dir);
      const headTree = git(dir, "rev-parse", "HEAD^{tree}").trim();
      assert.equal(after[1], headTree);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("collectDiff", () => {
  test("returns diff text, files, and numstat totals", async () => {
    const dir = makeRepo();
    try {
      const d = await collectDiff(dir);
      assert.ok(d.diff.includes("lead-version"));
      assert.deepEqual(d.files, ["f.txt"]);
      assert.equal(d.added, 1);
      assert.equal(d.removed, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// --- createWorktree / cleanupWorktree -------------------------------------

describe("createWorktree / cleanupWorktree", () => {
  test("creates and removes a worktree at the expected path", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-wt-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@example.com");
      git(dir, "config", "user.name", "Test");
      writeFileSync(path.join(dir, "f.txt"), "x\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "i");
      const wt = await createWorktree(dir, "claude", "phase-1/task-1");
      assert.ok(wt.endsWith("autopilot-claude-phase-1-task-1"));
      assert.ok(existsSync(wt));
      await cleanupWorktree(dir, wt, "autopilot/claude/phase-1-task-1");
      assert.equal(existsSync(wt), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// --- CLI smoke (--help, missing args) -------------------------------------

describe("buildClaudeCmd (goal mode)", () => {
  test("default (no promptArg) reads stdin via `-p -` and sets no budget", () => {
    const { cmd, args } = buildClaudeCmd({ allowedTools: "Read" });
    assert.equal(cmd, "claude");
    const pIdx = args.indexOf("-p");
    assert.equal(args[pIdx + 1], "-");
    assert.equal(args.includes("--max-budget-usd"), false);
  });

  test("promptArg routes the prompt as the `-p` ARGUMENT (enables /goal loop)", () => {
    const goalPrompt = "/goal tests pass\n\nimplement the thing";
    const { args } = buildClaudeCmd({ promptArg: goalPrompt, maxBudgetUsd: 5 });
    const pIdx = args.indexOf("-p");
    assert.equal(args[pIdx + 1], goalPrompt);
    assert.notEqual(args[pIdx + 1], "-");
  });

  test("maxBudgetUsd adds the runaway guard flag", () => {
    const { args } = buildClaudeCmd({ promptArg: "/goal x", maxBudgetUsd: 7 });
    const bIdx = args.indexOf("--max-budget-usd");
    assert.notEqual(bIdx, -1);
    assert.equal(args[bIdx + 1], "7");
  });

  test("non-positive / NaN budget never emits the flag", () => {
    for (const bad of [0, -3, Number.NaN]) {
      const { args } = buildClaudeCmd({ promptArg: "/goal x", maxBudgetUsd: bad });
      assert.equal(args.includes("--max-budget-usd"), false, `budget=${bad}`);
    }
  });

  test("DEFAULT_GOAL_MAX_BUDGET_USD is a positive number", () => {
    assert.equal(typeof DEFAULT_GOAL_MAX_BUDGET_USD, "number");
    assert.ok(DEFAULT_GOAL_MAX_BUDGET_USD > 0);
  });
});

describe("CLI", () => {
  test("--help exits 0 and prints usage", () => {
    const file = path.resolve(import.meta.dirname ?? "", "copilot_dispatch.ts");
    const out = execFileSync(
      "node",
      ["--experimental-strip-types", file, "--help"],
      { encoding: "utf-8" },
    );
    assert.match(out, /Usage: copilot_dispatch/);
  });

  test("missing prompt files (no --cleanup) exits 2", () => {
    const file = path.resolve(import.meta.dirname ?? "", "copilot_dispatch.ts");
    try {
      execFileSync(
        "node",
        ["--experimental-strip-types", file, "--repo-root", "/tmp", "--step-id", "x"],
        { encoding: "utf-8" },
      );
      assert.fail("should have exited non-zero");
    } catch (err) {
      const e = err as { status?: number };
      assert.equal(e.status, 2);
    }
  });

  test("--goal-max-budget-usd rejects non-positive / non-numeric values (exit 2)", () => {
    const file = path.resolve(import.meta.dirname ?? "", "copilot_dispatch.ts");
    for (const bad of ["0", "-1", "abc"]) {
      try {
        execFileSync(
          "node",
          ["--experimental-strip-types", file,
            "--repo-root", "/tmp", "--step-id", "x",
            "--implement-prompt-file", "/tmp/i", "--review-prompt-file", "/tmp/r",
            "--step-task-file", "/tmp/t", "--goal-max-budget-usd", bad],
          { encoding: "utf-8", stdio: "pipe" },
        );
        assert.fail(`should have exited non-zero for budget=${bad}`);
      } catch (err) {
        const e = err as { status?: number };
        assert.equal(e.status, 2, `budget=${bad}`);
      }
    }
  });

  test("--help documents the goal-mode flags", () => {
    const file = path.resolve(import.meta.dirname ?? "", "copilot_dispatch.ts");
    const out = execFileSync(
      "node", ["--experimental-strip-types", file, "--help"], { encoding: "utf-8" },
    );
    assert.match(out, /--goal-condition/);
    assert.match(out, /--goal-max-budget-usd/);
  });
});
