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
