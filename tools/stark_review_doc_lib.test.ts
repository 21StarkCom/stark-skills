import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyPatches,
  buildFixerPrompt,
  buildReviewerPrompt,
  classifyFindings,
  computeCoverage,
  deriveRunOutcome,
  discoverDomains,
  docFindingId,
  extractFixerJson,
  nextDomainTimeout,
  parseFixerOutput,
  parseReviewerOutput,
  pmap,
  resolveDocPromptSources,
  scaleTimeoutForDocSize,
  selectFindingsToFix,
  WING_FIXER_CONTRACT,
  type DocFinding,
} from "./stark_review_doc_lib.ts";

// ─── parseReviewerOutput ────────────────────────────────────────────────

describe("parseReviewerOutput", () => {
  test("parses a bare JSON array", () => {
    const raw = '[{"severity":"high","section":"Auth","title":"missing rate limit","description":"x","suggestion":"y"}]';
    const out = parseReviewerOutput(raw);
    assert.ok(out);
    assert.equal(out!.findings.length, 1);
    assert.equal(out!.findings[0]!.severity, "high");
    assert.equal(out!.emptyAck, false);
  });

  test("strips fenced code block", () => {
    const raw = 'preamble\n```json\n[{"severity":"low","title":"x"}]\n```\ntrailing prose';
    const out = parseReviewerOutput(raw);
    assert.ok(out);
    assert.equal(out!.findings.length, 1);
    assert.equal(out!.findings[0]!.title, "x");
  });

  test("recognizes the empty-array sentinel", () => {
    const out = parseReviewerOutput("[]");
    assert.ok(out);
    assert.equal(out!.findings.length, 0);
    assert.equal(out!.emptyAck, true);
  });

  test("returns null on prose-only output", () => {
    assert.equal(parseReviewerOutput("just some prose, no array"), null);
  });

  test("returns null on JSON object instead of array", () => {
    assert.equal(parseReviewerOutput('{"findings": []}'), null);
  });

  test("drops findings missing severity or title", () => {
    const raw = '[{"severity":"high","title":"ok"},{"title":"no severity"},{"severity":"low"},{}]';
    const out = parseReviewerOutput(raw);
    assert.ok(out);
    assert.equal(out!.findings.length, 1);
    assert.equal(out!.findings[0]!.title, "ok");
  });

  test("rejects invalid severity values", () => {
    const raw = '[{"severity":"urgent","title":"x"}]';
    const out = parseReviewerOutput(raw);
    assert.ok(out);
    assert.equal(out!.findings.length, 0);
  });

  test("tolerates uppercase severity", () => {
    const raw = '[{"severity":"HIGH","title":"x"}]';
    const out = parseReviewerOutput(raw);
    assert.ok(out);
    assert.equal(out!.findings.length, 1);
    assert.equal(out!.findings[0]!.severity, "high");
  });
});

// ─── extractFixerJson + parseFixerOutput ────────────────────────────────

describe("extractFixerJson", () => {
  test("picks last fenced JSON with patches key", () => {
    const text = 'thinking out loud...\n```json\n{"summary":"ok","patches":[{"finding_id":"a","old":"x","new":"y"}]}\n```\n';
    const obj = extractFixerJson(text);
    assert.ok(obj);
    assert.equal((obj as any).summary, "ok");
  });

  test("falls back to bare trailing JSON object", () => {
    const text = 'reasoning\n{"summary":"s","patches":[]}';
    const obj = extractFixerJson(text);
    assert.ok(obj);
    assert.deepEqual((obj as any).patches, []);
  });

  test("rejects JSON without patches key", () => {
    assert.equal(extractFixerJson('{"foo":"bar"}'), null);
  });

  test("ignores braces inside JSON strings (no desync)", () => {
    const text = '```json\n{"summary":"contains { and } mid-string","patches":[]}\n```';
    const obj = extractFixerJson(text);
    assert.ok(obj);
    assert.equal((obj as any).summary, "contains { and } mid-string");
  });

  test("returns null when no patches object present", () => {
    assert.equal(extractFixerJson("nothing here"), null);
  });
});

describe("parseFixerOutput", () => {
  test("returns parsed output on valid JSON", () => {
    const raw = '```json\n{"summary":"s","patches":[{"finding_id":"a","old":"o","new":"n"}],"skipped":[]}\n```';
    const r = parseFixerOutput(raw);
    assert.equal(r.error, null);
    assert.ok(r.parsed);
    assert.equal(r.parsed!.patches.length, 1);
    assert.equal(r.parsed!.summary, "s");
  });

  test("drops patches with empty old field", () => {
    const raw = '{"patches":[{"finding_id":"a","old":"","new":"n"},{"finding_id":"b","old":"x","new":"y"}]}';
    const r = parseFixerOutput(raw);
    assert.ok(r.parsed);
    assert.equal(r.parsed!.patches.length, 1);
    assert.equal(r.parsed!.patches[0]!.finding_id, "b");
  });

  test("error on missing patches array", () => {
    // extractFixerJson rejects objects without `patches`, so this surfaces as a
    // top-level no_json_object_with_patches error rather than patches_not_an_array.
    const r = parseFixerOutput('{"summary":"s"}');
    assert.ok(r.parsed === null);
    assert.equal(r.error, "no_json_object_with_patches");
  });

  test("captures skipped entries", () => {
    const raw = '{"patches":[],"skipped":[{"finding_id":"f1","reason":"author decision"}]}';
    const r = parseFixerOutput(raw);
    assert.ok(r.parsed);
    assert.equal(r.parsed!.skipped.length, 1);
    assert.equal(r.parsed!.skipped[0]!.reason, "author decision");
  });
});

// ─── applyPatches ───────────────────────────────────────────────────────

describe("applyPatches", () => {
  test("applies a single unique-match patch", () => {
    const doc = "alpha\nbeta\ngamma\n";
    const r = applyPatches(doc, [{ finding_id: "x", old: "beta", new: "BETA" }]);
    assert.equal(r.newDoc, "alpha\nBETA\ngamma\n");
    assert.equal(r.applied.length, 1);
    assert.equal(r.failures.length, 0);
  });

  test("rejects patch whose old appears multiple times", () => {
    const doc = "foo bar foo";
    const r = applyPatches(doc, [{ finding_id: "x", old: "foo", new: "FOO" }]);
    assert.equal(r.newDoc, doc);
    assert.equal(r.applied.length, 0);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0]!.reason, "old_ambiguous");
  });

  test("rejects patch whose old is not in the doc", () => {
    const r = applyPatches("hello", [{ finding_id: "x", old: "world", new: "Z" }]);
    assert.equal(r.applied.length, 0);
    assert.equal(r.failures[0]!.reason, "old_not_found");
  });

  test("rejects patch with empty old", () => {
    const r = applyPatches("hello", [{ finding_id: "x", old: "", new: "Z" }]);
    assert.equal(r.applied.length, 0);
    assert.equal(r.failures[0]!.reason, "empty_old");
  });

  test("preserves partial progress when some patches fail", () => {
    const doc = "foo bar foo\nbaz";
    const patches = [
      { finding_id: "1", old: "baz", new: "BAZ" },
      { finding_id: "2", old: "foo", new: "X" }, // ambiguous
    ];
    const r = applyPatches(doc, patches);
    assert.equal(r.newDoc, "foo bar foo\nBAZ");
    assert.equal(r.applied.length, 1);
    assert.equal(r.failures.length, 1);
  });

  test("ordering can dissolve duplicates between patches", () => {
    const doc = "foo X foo";
    const patches = [
      { finding_id: "1", old: "foo X foo", new: "ONE bar" },
      { finding_id: "2", old: "bar", new: "TWO" },
    ];
    const r = applyPatches(doc, patches);
    assert.equal(r.newDoc, "ONE TWO");
    assert.equal(r.applied.length, 2);
  });
});

// ─── classifyFindings ──────────────────────────────────────────────────

const mkFinding = (overrides: Partial<DocFinding>): DocFinding => ({
  id: "id",
  agent: "codex",
  domain: "security",
  severity: "high",
  section: "Auth",
  title: "title",
  description: "desc",
  suggestion: "sugg",
  ...overrides,
});

describe("classifyFindings", () => {
  test("fix when severity >= threshold and not seen before", () => {
    const out = classifyFindings(
      [mkFinding({ severity: "high" })],
      { priorFixed: [], fixThreshold: "medium" },
    );
    assert.equal(out[0]!.classification, "fix");
  });

  test("ignored when severity < threshold", () => {
    const out = classifyFindings(
      [mkFinding({ severity: "low" })],
      { priorFixed: [], fixThreshold: "medium" },
    );
    assert.equal(out[0]!.classification, "ignored");
  });

  test("recurring when (section, domain, agent) seen in prior rounds", () => {
    const prior = mkFinding({ section: "Auth", domain: "security", agent: "codex" });
    const cur = mkFinding({ section: "Auth", domain: "security", agent: "codex", title: "another title" });
    const out = classifyFindings([cur], { priorFixed: [prior], fixThreshold: "medium" });
    assert.equal(out[0]!.classification, "recurring");
  });

  test("noise for intra-round dup (same section+title)", () => {
    const a = mkFinding({ title: "X", section: "S1" });
    const b = mkFinding({ title: "X", section: "S1" });
    const out = classifyFindings([a, b], { priorFixed: [], fixThreshold: "medium" });
    assert.equal(out[0]!.classification, "fix");
    assert.equal(out[1]!.classification, "noise");
  });
});

describe("selectFindingsToFix", () => {
  test("includes fix + recurring, sorted by severity desc", () => {
    const out = selectFindingsToFix([
      mkFinding({ classification: "fix", severity: "medium" }),
      mkFinding({ classification: "ignored", severity: "low" }),
      mkFinding({ classification: "recurring", severity: "critical" }),
      mkFinding({ classification: "noise", severity: "high" }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.severity, "critical");
    assert.equal(out[1]!.severity, "medium");
  });
});

// ─── docFindingId ──────────────────────────────────────────────────────

describe("docFindingId", () => {
  test("stable for same inputs", () => {
    const a = docFindingId({ domain: "d", agent: "codex", section: "S", title: "T" });
    const b = docFindingId({ domain: "d", agent: "codex", section: "S", title: "T" });
    assert.equal(a, b);
  });
  test("case- and whitespace-insensitive on section/title", () => {
    const a = docFindingId({ domain: "d", agent: "codex", section: "Auth", title: "  X  " });
    const b = docFindingId({ domain: "d", agent: "codex", section: "AUTH", title: "x" });
    assert.equal(a, b);
  });
  test("differs across agents", () => {
    const a = docFindingId({ domain: "d", agent: "codex", section: "S", title: "T" });
    const b = docFindingId({ domain: "d", agent: "claude", section: "S", title: "T" });
    assert.notEqual(a, b);
  });
});

// ─── buildReviewerPrompt / buildFixerPrompt ─────────────────────────────

describe("buildReviewerPrompt", () => {
  test("includes the output contract and document body", () => {
    const out = buildReviewerPrompt({
      agentMd: "AGENT PRELUDE",
      domainPrompt: "DOMAIN PROMPT",
      doc: "# My Design\n\nthe content",
    });
    assert.match(out, /AGENT PRELUDE/);
    assert.match(out, /DOMAIN PROMPT/);
    assert.match(out, /## Output Contract/);
    assert.match(out, /# My Design/);
  });
});

describe("buildFixerPrompt", () => {
  test("includes the wing contract and the findings JSON", () => {
    const out = buildFixerPrompt({
      doc: "# Doc",
      findings: [mkFinding({ id: "abc", title: "T", section: "S" })],
      roundNum: 2,
    });
    assert.match(out, /Round 2/);
    assert.match(out, /WING_FIXER_CONTRACT|Output Contract/);
    assert.match(out, /"id": "abc"/);
  });

  test("retry section is included only when failures provided", () => {
    const base = buildFixerPrompt({ doc: "x", findings: [], roundNum: 1 });
    assert.equal(base.includes("Prior patch failures"), false);
    const retry = buildFixerPrompt({
      doc: "x",
      findings: [],
      roundNum: 1,
      retryFailures: [
        { patch: { finding_id: "f", old: "o", new: "n" }, reason: "old_not_found" },
      ],
    });
    assert.match(retry, /Prior patch failures/);
    assert.match(retry, /old_not_found/);
  });

  test("contract constant referenced", () => {
    // Ensure the constant is the one actually emitted (so updates flow through).
    const out = buildFixerPrompt({ doc: "x", findings: [], roundNum: 1 });
    const head = WING_FIXER_CONTRACT.split("\n")[0]!;
    assert.match(out, new RegExp(head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

// ─── discoverDomains / resolveDocPromptSources ──────────────────────────

describe("discoverDomains + resolveDocPromptSources", () => {
  test("merges per-agent and shared domains, agent wins", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-prompts-"));
    try {
      const promptsDir = path.join(tmp, "spec-review");
      mkdirSync(path.join(promptsDir, "codex"), { recursive: true });
      mkdirSync(path.join(promptsDir, "claude"), { recursive: true });
      mkdirSync(path.join(promptsDir, "domains"), { recursive: true });
      writeFileSync(path.join(promptsDir, "codex", "01-completeness.md"), "AGENT_CODEX");
      writeFileSync(path.join(promptsDir, "domains", "01-completeness.md"), "SHARED_DOMAIN");
      writeFileSync(path.join(promptsDir, "domains", "02-security.md"), "SECURITY_DOMAIN");
      writeFileSync(path.join(promptsDir, "codex", "agent.md"), "CODEX_AGENT_MD");

      const domains = discoverDomains(promptsDir, ["codex", "claude"]);
      assert.deepEqual(domains.map((d) => d.key).sort(), ["completeness", "security"]);

      const c = resolveDocPromptSources({
        agent: "codex",
        domain: "completeness",
        promptsDir,
        repoSubdir: "spec-prompts",
      });
      assert.equal(c.agentMd, "CODEX_AGENT_MD");
      assert.equal(c.domainPrompt, "AGENT_CODEX");

      // No codex-specific security file → falls back to shared/domains
      const s = resolveDocPromptSources({
        agent: "codex",
        domain: "security",
        promptsDir,
        repoSubdir: "spec-prompts",
      });
      assert.equal(s.domainPrompt, "SECURITY_DOMAIN");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("repo override beats global", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-prompts-"));
    try {
      const promptsDir = path.join(tmp, "spec-review");
      mkdirSync(path.join(promptsDir, "codex"), { recursive: true });
      writeFileSync(path.join(promptsDir, "codex", "01-completeness.md"), "GLOBAL");

      const repoDir = path.join(tmp, "repo");
      mkdirSync(path.join(repoDir, ".code-review", "spec-prompts", "codex"), { recursive: true });
      writeFileSync(
        path.join(repoDir, ".code-review", "spec-prompts", "codex", "01-completeness.md"),
        "REPO_OVERRIDE",
      );

      const r = resolveDocPromptSources({
        agent: "codex",
        domain: "completeness",
        promptsDir,
        repoDir,
        repoSubdir: "spec-prompts",
      });
      assert.equal(r.domainPrompt, "REPO_OVERRIDE");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("throws when prompt cannot be resolved anywhere", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doc-prompts-"));
    try {
      const promptsDir = path.join(tmp, "spec-review");
      mkdirSync(promptsDir, { recursive: true });
      assert.throws(
        () => resolveDocPromptSources({
          agent: "codex",
          domain: "nope",
          promptsDir,
          repoSubdir: "spec-prompts",
        }),
        /domain prompt not found/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── pmap ──────────────────────────────────────────────────────────────

describe("pmap", () => {
  test("caps concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await pmap([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80]);
    assert.ok(peak <= 3, `peak concurrency ${peak} > 3`);
  });

  test("rejects on limit <= 0", async () => {
    await assert.rejects(pmap([1], 0, async (x) => x));
  });
});

// ─── Coverage + adaptive timeouts ────────────────────────────────────────

describe("computeCoverage", () => {
  test("clean run has no gaps", () => {
    const rounds = [{ results: [{ domain: "viability", error: null }, { domain: "security", error: null }] }];
    const c = computeCoverage(rounds, ["viability", "security"]);
    assert.deepEqual(c.gaps, []);
    assert.equal(c.domains.viability!.completions, 1);
    assert.equal(c.domains.viability!.attempts, 1);
  });

  test("domain that only ever timed out is a gap", () => {
    const rounds = [
      { results: [{ domain: "viability", error: "timeout" }, { domain: "security", error: null }] },
      { results: [{ domain: "viability", error: "timeout" }, { domain: "security", error: null }] },
    ];
    const c = computeCoverage(rounds, ["viability", "security"]);
    assert.deepEqual(c.gaps, ["viability"]);
    assert.equal(c.domains.viability!.timeouts, 2);
    assert.equal(c.domains.viability!.completions, 0);
    assert.equal(c.domains.viability!.last_error, "timeout");
  });

  test("timeout then success is transient, NOT a gap", () => {
    const rounds = [
      { results: [{ domain: "viability", error: "timeout" }] },
      { results: [{ domain: "viability", error: null }] },
    ];
    const c = computeCoverage(rounds, ["viability"]);
    assert.deepEqual(c.gaps, []);
    assert.equal(c.domains.viability!.timeouts, 1);
    assert.equal(c.domains.viability!.completions, 1);
  });

  test("parse_error-only domain is a gap (never produced a usable review)", () => {
    const c = computeCoverage([{ results: [{ domain: "ssot", error: "parse_error" }] }], ["ssot"]);
    assert.deepEqual(c.gaps, ["ssot"]);
    assert.equal(c.domains.ssot!.timeouts, 0);
    assert.equal(c.domains.ssot!.last_error, "parse_error");
  });

  test("gaps are sorted and multi-domain", () => {
    const rounds = [{ results: [
      { domain: "viability", error: "timeout" },
      { domain: "completeness", error: "timeout" },
      { domain: "security", error: null },
    ] }];
    const c = computeCoverage(rounds, ["viability", "completeness", "security"]);
    assert.deepEqual(c.gaps, ["completeness", "viability"]);
  });
});

describe("adaptive timeouts", () => {
  test("nextDomainTimeout escalates 600→1200→1800 and caps at 3× base", () => {
    assert.equal(nextDomainTimeout(600, 600), 1200);
    assert.equal(nextDomainTimeout(1200, 600), 1800);
    assert.equal(nextDomainTimeout(1800, 600), 1800);
  });

  test("scaleTimeoutForDocSize: 1× small docs, linear growth, 3× cap", () => {
    assert.equal(scaleTimeoutForDocSize(600, 8_000), 600);
    assert.equal(scaleTimeoutForDocSize(600, 16_000), 600);
    assert.equal(scaleTimeoutForDocSize(600, 28_000), 1050);
    assert.equal(scaleTimeoutForDocSize(600, 200_000), 1800);
  });
});

describe("deriveRunOutcome", () => {
  test("coverage gaps → ok=false, exit 1, coverage_gap error", () => {
    const r = deriveRunOutcome({ dispatchFailureEarlyExit: false, coverageGaps: ["viability"] });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.equal(r.error!.code, "coverage_gap");
    assert.match(r.error!.message, /viability/);
  });

  test("dispatch failure wins over gaps", () => {
    const r = deriveRunOutcome({ dispatchFailureEarlyExit: true, coverageGaps: ["viability"] });
    assert.equal(r.error!.code, "dispatch_failure");
    assert.equal(r.exitCode, 1);
  });

  test("transient-only failures → ok=true, exit 0", () => {
    const r = deriveRunOutcome({ dispatchFailureEarlyExit: false, coverageGaps: [] });
    assert.deepEqual(r, { ok: true, exitCode: 0, error: null });
  });
});

// ─── Run-record durability helpers ──────────────────────────────────────

import {
  buildHistoryDir,
  newRunId,
  pruneRunDirs,
  updateLatestPointer,
  writeJsonAtomic,
} from "./stark_review_doc_lib.ts";
import { readFileSync, readdirSync, readlinkSync, symlinkSync, existsSync } from "node:fs";

describe("run-record durability helpers", () => {
  test("newRunId is sortable timestamp + pid", () => {
    const id = newRunId(new Date(2026, 6, 14, 9, 5, 3));
    assert.match(id, /^20260714-090503-\d+$/);
  });

  test("buildHistoryDir nests slug/runId", () => {
    const dir = buildHistoryDir({ home: "/h", promptsDir: "plan-review", docPath: "docs/plans/x.md", runId: "r1" });
    assert.equal(dir, "/h/.claude/code-review/history/plan-reviews/x/r1");
  });

  test("writeJsonAtomic leaves valid JSON and no tmp file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wja-"));
    try {
      const f = path.join(dir, "out.json");
      writeJsonAtomic(f, { a: 1 });
      assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: 1 });
      assert.deepEqual(readdirSync(dir), ["out.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("updateLatestPointer repoints atomically", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "latest-"));
    try {
      updateLatestPointer(dir, "run-a");
      updateLatestPointer(dir, "run-b");
      assert.equal(readlinkSync(path.join(dir, "latest")), "run-b");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("pruneRunDirs keeps newest N, skips latest pointer, returns pruned", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prune-"));
    try {
      for (const r of ["20260101-000000-1", "20260102-000000-1", "20260103-000000-1"]) {
        mkdirSync(path.join(dir, r), { recursive: true });
      }
      symlinkSync("20260103-000000-1", path.join(dir, "latest"));
      const pruned = pruneRunDirs(dir, 2);
      assert.deepEqual(pruned, ["20260101-000000-1"]);
      assert.ok(!existsSync(path.join(dir, "20260101-000000-1")));
      assert.ok(existsSync(path.join(dir, "20260103-000000-1")));
      assert.equal(readlinkSync(path.join(dir, "latest")), "20260103-000000-1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── Convergence pass helpers (ADR 0022) ─────────────────────────────────

import { buildConvergenceInput, resolveConvergencePromptSources } from "./stark_review_doc_lib.ts";

describe("convergence helpers", () => {
  test("buildConvergenceInput frames delta first, doc as context", () => {
    const input = buildConvergenceInput({ base: "abc123", delta: "+ new line\n- old line", doc: "# Doc body" });
    assert.match(input, /## Delta under review \(git diff abc123\.\.HEAD\)/);
    assert.match(input, /```diff\n\+ new line\n- old line\n```/);
    assert.match(input, /## Full document \(context only[\s\S]*# Doc body/);
    assert.ok(input.indexOf("Delta under review") < input.indexOf("Full document"));
  });

  test("resolveConvergencePromptSources: global prompt + agent.md, repo override wins", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "conv-"));
    try {
      const promptsDir = path.join(dir, "plan-review");
      mkdirSync(path.join(promptsDir, "codex"), { recursive: true });
      writeFileSync(path.join(promptsDir, "convergence.md"), "GLOBAL CONV");
      writeFileSync(path.join(promptsDir, "codex", "agent.md"), "AGENT MD");

      const global = resolveConvergencePromptSources({ agent: "codex", promptsDir, repoSubdir: "plan-prompts" });
      assert.ok(global);
      assert.equal(global!.domainPrompt, "GLOBAL CONV");
      assert.equal(global!.agentMd, "AGENT MD");

      const repoDir = path.join(dir, "repo");
      mkdirSync(path.join(repoDir, ".code-review", "plan-prompts"), { recursive: true });
      writeFileSync(path.join(repoDir, ".code-review", "plan-prompts", "convergence.md"), "REPO CONV");
      const overridden = resolveConvergencePromptSources({ agent: "codex", promptsDir, repoDir, repoSubdir: "plan-prompts" });
      assert.equal(overridden!.domainPrompt, "REPO CONV");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("resolveConvergencePromptSources: null when no convergence.md anywhere", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "conv2-"));
    try {
      assert.equal(resolveConvergencePromptSources({ agent: "codex", promptsDir: path.join(dir, "nope"), repoSubdir: "plan-prompts" }), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("shipped convergence prompts exist for both prompts-dirs and are not discoverable domains", () => {
    const promptsBase = path.join(import.meta.dirname, "..", "global", "prompts");
    for (const pd of ["spec-review", "plan-review"]) {
      const p = path.join(promptsBase, pd, "convergence.md");
      assert.ok(existsSync(p), `${p} missing`);
      const domains = discoverDomains(path.join(promptsBase, pd), ["codex", "claude", "gemini"]);
      assert.ok(!domains.some((d) => d.key === "convergence"), `${pd}: convergence leaked into discovered domains`);
    }
  });
});

// ─── capFindingsToFix (per-round fix cap, #4) ───────────────────────────

import { capFindingsToFix } from "./stark_review_doc_lib.ts";

describe("capFindingsToFix", () => {
  const sorted = [
    mkFinding({ id: "c1", classification: "fix", severity: "critical" }),
    mkFinding({ id: "h1", classification: "fix", severity: "high" }),
    mkFinding({ id: "m1", classification: "fix", severity: "medium" }),
    mkFinding({ id: "m2", classification: "recurring", severity: "medium" }),
  ];

  test("caps to top-N by severity, defers the rest", () => {
    const { selected, deferred } = capFindingsToFix(sorted, 2);
    assert.deepEqual(selected.map((f) => f.id), ["c1", "h1"]);
    assert.deepEqual(deferred.map((f) => f.id), ["m1", "m2"]);
  });

  test("cap 0 means uncapped", () => {
    const { selected, deferred } = capFindingsToFix(sorted, 0);
    assert.equal(selected.length, 4);
    assert.equal(deferred.length, 0);
  });

  test("cap >= length passes everything through", () => {
    const { selected, deferred } = capFindingsToFix(sorted, 10);
    assert.equal(selected.length, 4);
    assert.equal(deferred.length, 0);
  });

  test("severity bias end-to-end: selectFindingsToFix + cap keeps high/critical, defers medium", () => {
    const findings = [
      mkFinding({ id: "a", classification: "fix", severity: "medium" }),
      mkFinding({ id: "b", classification: "fix", severity: "critical" }),
      mkFinding({ id: "c", classification: "fix", severity: "medium" }),
      mkFinding({ id: "d", classification: "recurring", severity: "high" }),
    ];
    const { selected, deferred } = capFindingsToFix(selectFindingsToFix(findings), 2);
    assert.deepEqual(selected.map((f) => f.id), ["b", "d"]);
    assert.equal(deferred.every((f) => f.severity === "medium"), true);
  });
});

// ─── Deferred-scope fixer guard (#1) ────────────────────────────────────

describe("WING_FIXER_CONTRACT deferred-scope guard", () => {
  test("contract carries both the playground guard and the deferred-boundary guard", () => {
    assert.match(WING_FIXER_CONTRACT, /SCOPE GUARD — do not add production machinery to a playground document/);
    assert.match(WING_FIXER_CONTRACT, /DEFERRED-SCOPE GUARD — the document's own V1 boundary is binding, even on a production system/);
    assert.match(WING_FIXER_CONTRACT, /author deferred to V1 boundary \/ out of scope/);
    assert.match(WING_FIXER_CONTRACT, /What this is NOT/);
    assert.match(WING_FIXER_CONTRACT, /deferred to Phase 2/);
  });

  test("buildFixerPrompt ships the deferred-scope guard to the wing", () => {
    const prompt = buildFixerPrompt({
      doc: "# Spec\n\nV1 = listener only; SLOs/validation/retention deferred to Phase 2.",
      findings: [mkFinding({ id: "f1" })],
      roundNum: 1,
    });
    assert.match(prompt, /DEFERRED-SCOPE GUARD/);
    assert.match(prompt, /author deferred to V1 boundary \/ out of scope/);
  });
});

// ─── renderPriorRoundChanges + reviewer anti-churn note (#5) ─────────────

import { renderPriorRoundChanges } from "./stark_review_doc_lib.ts";

describe("renderPriorRoundChanges", () => {
  test("empty applied list renders nothing", () => {
    assert.equal(renderPriorRoundChanges([]), "");
  });

  test("renders the anti-churn instruction plus patch excerpts", () => {
    const out = renderPriorRoundChanges([
      { finding_id: "a", old: "x", new: "Added SLO section body" },
      { finding_id: "b", old: "gone", new: "" },
    ]);
    assert.match(out, /do not re-review it/);
    assert.match(out, /the correct finding is \*\*"revert it"\*\*, not "extend it"/);
    assert.match(out, /Added SLO section body/);
    assert.match(out, /\(text removed\)/);
  });

  test("fence-safe: excerpts containing ``` get a wider outer fence, even after truncation", () => {
    const inner = "Example:\n```bash\necho hi\n```\ndone";
    const out = renderPriorRoundChanges([{ finding_id: "a", old: "x", new: inner }]);
    assert.match(out, /````\n/);           // outer fence widened past the inner ```
    assert.ok(out.includes(inner));
    // Truncation cutting inside a fence still yields a balanced outer fence.
    const long = "```json\n" + "x".repeat(900) + "\n```";
    const cut = renderPriorRoundChanges([{ finding_id: "b", old: "x", new: long }]);
    const fenceRuns = cut.match(/`{4,}/g) ?? [];
    assert.equal(fenceRuns.length % 2, 0, "outer fences must pair up");
  });

  test("caps total size and notes omitted patches", () => {
    const patches = Array.from({ length: 20 }, (_, i) => ({
      finding_id: `f${i}`, old: "x", new: "y".repeat(700),
    }));
    const out = renderPriorRoundChanges(patches, 2000);
    assert.ok(out.length < 4000);
    assert.match(out, /more patch\(es\) omitted/);
  });

  test("buildReviewerPrompt places the note before the document", () => {
    const note = renderPriorRoundChanges([{ finding_id: "a", old: "x", new: "fix text" }]);
    const prompt = buildReviewerPrompt({
      agentMd: "AGENT", domainPrompt: "DOMAIN", doc: "# Doc body", priorRoundNote: note,
    });
    const noteIdx = prompt.indexOf("do not re-review it");
    const docIdx = prompt.indexOf("## Document under review");
    assert.ok(noteIdx !== -1 && docIdx !== -1 && noteIdx < docIdx);
  });

  test("buildReviewerPrompt without a note is unchanged", () => {
    const prompt = buildReviewerPrompt({ agentMd: "AGENT", domainPrompt: "DOMAIN", doc: "# Doc" });
    assert.ok(!prompt.includes("do not re-review it"));
  });
});

// ─── isReviewMutationCommitSubject (growth-baseline pinning, #6) ─────────

import { isReviewMutationCommitSubject } from "./stark_review_doc_lib.ts";

describe("isReviewMutationCommitSubject", () => {
  test("matches the pipeline's own unattended mutations", () => {
    for (const s of [
      "docs: spec-review round 2 fixes (8 applied)",
      "docs: plan-review round 1 fixes (3 applied)",
      "docs: spec-review coherence pass (4 patches, 120 chars removed)",
      "revert(review-doc): discard padding — hard growth cap breaker",
    ]) {
      assert.equal(isReviewMutationCommitSubject(s), true, s);
    }
  });

  test("does NOT match authored/operator commits — the baseline resets at them", () => {
    for (const s of [
      "docs(review): stage kotodama-spec.md for spec review",
      "docs: add kotodama V1 spec",
      "feat(kotodama): listener slice",
      "docs: spec-reviewed and approved", // near-miss prefix
      // Phase-5b fixes are operator-in-the-loop edits made AFTER the
      // growth-ack gate — they count as acceptance of the doc's size, so a
      // re-run must not re-litigate acked growth against an older baseline.
      "docs(review-spec): fix missing test plan (test-plan/high)",
      "docs(review-plan): fix sequencing gap (sequencing/medium)",
    ]) {
      assert.equal(isReviewMutationCommitSubject(s), false, s);
    }
  });
});

// ─── dedupeDocFindings (cross-domain refraction collapse) ────────────────

import { dedupeDocFindings } from "./stark_review_doc_lib.ts";

describe("dedupeDocFindings", () => {
  test("collapses one root cause refracted across 5 domains into one canonical finding", () => {
    const refraction = (domain: string, severity: "high" | "medium", title: string) =>
      mkFinding({
        id: domain, domain, severity, section: "State machine",
        title,
        description: "the done state can be reached with a false completion signal so downstream consumers see done prematurely",
      });
    const out = dedupeDocFindings([
      refraction("data-modeling", "medium", "false done state reachable"),
      refraction("api-design", "medium", "done signal can be false"),
      refraction("completeness", "high", "false done completion signal hole"),
      refraction("consistency", "medium", "done state contradiction on false signal"),
      refraction("test-plan", "medium", "no test for false done signal"),
      mkFinding({ id: "other", domain: "security", section: "Auth", title: "token in query string", description: "credentials leak via URL logging" }),
    ]);
    assert.equal(out.length, 2);
    const canonical = out.find((f) => f.section === "State machine")!;
    // Highest severity wins as canonical.
    assert.equal(canonical.severity, "high");
    assert.equal(canonical.domain, "completeness");
    assert.equal(canonical.cross_validated_by!.length, 4);
    assert.ok(canonical.cross_validated_by!.includes("data-modeling"));
    // The unrelated finding survives untouched, no cross_validated_by.
    assert.equal(out.find((f) => f.section === "Auth")!.cross_validated_by, undefined);
  });

  test("distinct findings in the same section are NOT merged", () => {
    const out = dedupeDocFindings([
      mkFinding({ id: "a", domain: "security", section: "Auth", title: "missing rate limit", description: "login endpoint accepts unlimited attempts enabling brute force" }),
      mkFinding({ id: "b", domain: "api-design", section: "Auth", title: "inconsistent error envelope", description: "the 401 response shape differs from every other endpoint response contract" }),
    ]);
    assert.equal(out.length, 2);
  });

  test("no empty-section wildcard: a section-less finding never merges into an anchored one", () => {
    // Losing a real finding is strictly worse than posting a duplicate — a
    // section-less finding matching any section on generic token overlap
    // silently dropped distinct findings.
    const out = dedupeDocFindings([
      mkFinding({ id: "a", domain: "completeness", section: "Rollout", severity: "high", title: "missing rollback trigger criteria", description: "rollback trigger criteria are not defined for the rollout" }),
      mkFinding({ id: "b", domain: "consistency", section: "", severity: "medium", title: "rollback trigger criteria undefined", description: "rollback trigger criteria missing from rollout definition" }),
    ]);
    assert.equal(out.length, 2);
  });

  test("both-empty sections still merge on overlap", () => {
    const out = dedupeDocFindings([
      mkFinding({ id: "a", domain: "completeness", section: "", severity: "high", title: "missing rollback trigger criteria", description: "rollback trigger criteria are not defined for the rollout" }),
      mkFinding({ id: "b", domain: "consistency", section: "", severity: "medium", title: "rollback trigger criteria undefined", description: "rollback trigger criteria missing from rollout definition" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.severity, "high");
  });

  test("recurring detection survives canonical-domain flips via cross_validated_by", () => {
    // Round 1 canonical: completeness (cross-validated by api-design). Round 2
    // the same concern comes back canonical under api-design — must still be
    // classified recurring.
    const prior = mkFinding({ id: "r1", domain: "completeness", section: "State machine", title: "false done", cross_validated_by: ["api-design"], classification: "fix" });
    const roundTwo = mkFinding({ id: "r2", domain: "api-design", section: "State machine", title: "done signal false" });
    const out = classifyFindings([roundTwo], { priorFixed: [prior], fixThreshold: "medium" });
    assert.equal(out[0]!.classification, "recurring");
  });
});

// ─── renderPriorDispositions (disposition threading) ─────────────────────

import { renderPriorDispositions } from "./stark_review_doc_lib.ts";

describe("renderPriorDispositions", () => {
  test("empty list renders nothing", () => {
    assert.equal(renderPriorDispositions([]), "");
  });

  test("renders each disposition with the re-raise contract", () => {
    const out = renderPriorDispositions([
      { finding: mkFinding({ id: "d1", title: "measurable success criterion", domain: "completeness", severity: "medium" }), disposition: "skipped", round: 1, reason: "accepted trade-off: declared playground scope" },
      { finding: mkFinding({ id: "d2", title: "missing error path", domain: "api-design", severity: "high" }), disposition: "fixed", round: 1 },
      { finding: mkFinding({ id: "d3", title: "minor wording", domain: "consistency", severity: "medium" }), disposition: "deferred", round: 1 },
    ]);
    assert.match(out, /Do NOT re-raise a finding whose resolution stands/);
    assert.match(out, /skipped by fixer.*accepted trade-off: declared playground scope/);
    assert.match(out, /fixed via patch.*round 1/);
    assert.match(out, /deferred to a later fix round — still open/);
    assert.match(out, /Re-raise ONLY when/);
  });

  test("reconciles to one entry per finding — the latest disposition wins", () => {
    const f = mkFinding({ id: "same", title: "deferred then fixed" });
    const out = renderPriorDispositions([
      { finding: f, disposition: "deferred", round: 1 },
      { finding: f, disposition: "fixed", round: 2 },
    ]);
    assert.match(out, /fixed via patch.*round 2/);
    assert.ok(!out.includes("still open"), "stale deferred line must not render");
    assert.equal((out.match(/deferred then fixed/g) ?? []).length, 1);
  });

  test("caps total size and notes omitted entries", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      finding: mkFinding({ title: `finding number ${i} with a reasonably long title for sizing`, id: `f${i}` }),
      disposition: "fixed" as const,
      round: 1,
    }));
    const out = renderPriorDispositions(many, 2000);
    assert.ok(out.length < 3500);
    assert.match(out, /more omitted/);
  });
});

// ─── Deletion-first wing contract (growth discipline) ────────────────────

describe("WING_FIXER_CONTRACT deletion-first", () => {
  test("contract instructs deletion-first fixing", () => {
    assert.match(WING_FIXER_CONTRACT, /DELETION-FIRST — fixes must be allowed to delete/);
    assert.match(WING_FIXER_CONTRACT, /deleting the wrong half/);
  });
});
