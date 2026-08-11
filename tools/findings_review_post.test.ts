import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  bodyFor,
  buildHumanSummary,
  parseArgs,
  parsePrContext,
  severityFromVerdict,
  titleFor,
  toFindings,
  type ReportFindingsPayload,
} from "./findings_review_post.ts";
import { partitionInlineVsBody } from "./stark_review.ts";

// --- mapping -----------------------------------------------------------------

describe("severityFromVerdict", () => {
  test("CONFIRMED infers high, everything else medium", () => {
    assert.equal(severityFromVerdict("CONFIRMED"), "high");
    assert.equal(severityFromVerdict("PLAUSIBLE"), "medium");
    assert.equal(severityFromVerdict(undefined), "medium");
  });
});

describe("titleFor", () => {
  test("prefers short_summary", () => {
    assert.equal(
      titleFor({ short_summary: "off-by-one in cursor", summary: "The cursor loop..." }),
      "off-by-one in cursor",
    );
  });

  test("falls back to the first line of summary", () => {
    assert.equal(titleFor({ summary: "first line\nsecond line" }), "first line");
  });

  test("truncates a long fallback title", () => {
    const t = titleFor({ summary: "x".repeat(300) });
    assert.equal(t.length, 120);
    assert.ok(t.endsWith("…"));
  });

  test("never returns an empty title", () => {
    assert.equal(titleFor({}), "(untitled finding)");
  });
});

describe("bodyFor", () => {
  test("renders summary, failure scenario and outcome", () => {
    const b = bodyFor({
      summary: "Nil deref when the cache is cold.",
      failure_scenario: "First request after boot → panic.",
      outcome: "fixed",
    });
    assert.match(b, /Nil deref when the cache is cold\./);
    assert.match(b, /\*\*Failure scenario:\*\* First request after boot → panic\./);
    assert.match(b, /\*\*Outcome:\*\* `fixed`/);
  });

  test("degrades to a placeholder rather than an empty comment body", () => {
    assert.equal(bodyFor({}), "(no detail provided)");
  });
});

describe("toFindings", () => {
  test("maps every field and defaults the domain to correctness", () => {
    const [f] = toFindings(
      { findings: [{ file: "a.ts", line: 12, short_summary: "bug", summary: "s", verdict: "CONFIRMED" }] },
      "claude",
    );
    assert.equal(f.file, "a.ts");
    assert.equal(f.line, 12);
    assert.equal(f.title, "bug");
    assert.equal(f.severity, "high");
    assert.equal(f.domain, "correctness");
    assert.equal(f.agent, "claude");
    assert.match(f.id, /^[0-9a-f]{12}$/);
  });

  test("classification is 'fix' — partitionInlineVsBody requires it for anchoring", () => {
    const fs_ = toFindings({ findings: [{ file: "a.ts", line: 1, summary: "s" }] }, "claude");
    assert.equal(fs_[0].classification, "fix");
  });

  test("absent file/line become null, which routes to the review body", () => {
    const [f] = toFindings({ findings: [{ summary: "no anchor" }] }, "codex");
    assert.equal(f.file, null);
    assert.equal(f.line, null);
  });
});

// --- the no-drop invariant ---------------------------------------------------

describe("no finding is ever dropped", () => {
  const payload: ReportFindingsPayload = {
    level: "high",
    findings: [
      { file: "changed.ts", line: 10, short_summary: "anchored", summary: "in a changed file", verdict: "CONFIRMED" },
      { file: "untouched.ts", line: 4, short_summary: "unchanged file", summary: "not in the diff" },
      { short_summary: "no anchor", summary: "file is null" },
    ],
  };

  test("inline + body findings account for every input finding", () => {
    const findings = toFindings(payload, "claude");
    const { inline, bodyFindings } = partitionInlineVsBody(
      findings,
      new Set(["changed.ts"]),
      "low",
    );
    assert.equal(inline.length + bodyFindings.length, findings.length);
    assert.equal(findings.length, 3);
  });

  test("only the finding anchored in a changed file goes inline", () => {
    const findings = toFindings(payload, "claude");
    const { inline, bodyFindings } = partitionInlineVsBody(
      findings,
      new Set(["changed.ts"]),
      "low",
    );
    assert.equal(inline.length, 1);
    assert.equal(inline[0].path, "changed.ts");
    assert.equal(inline[0].line, 10);
    assert.deepEqual(
      bodyFindings.map((f) => f.title).sort(),
      ["no anchor", "unchanged file"],
    );
  });

  test("fixThreshold 'low' filters nothing out by severity", () => {
    const findings = toFindings(
      { findings: [{ file: "changed.ts", line: 1, summary: "plausible only", verdict: "PLAUSIBLE" }] },
      "claude",
    );
    const { inline } = partitionInlineVsBody(findings, new Set(["changed.ts"]), "low");
    assert.equal(inline.length, 1);
  });
});

// --- review body -------------------------------------------------------------

describe("buildHumanSummary", () => {
  test("counts by severity and states that severity is inferred", () => {
    const findings = toFindings(
      { findings: [{ summary: "a", verdict: "CONFIRMED" }, { summary: "b" }] },
      "claude",
    );
    const body = buildHumanSummary(findings, "high");
    assert.match(body, /2 findings/);
    assert.match(body, /1 high, 1 medium/);
    assert.match(body, /inferred/);
    assert.match(body, /Review effort level: `high`/);
  });

  test("empty findings still render a body", () => {
    assert.match(buildHumanSummary([], undefined), /No findings\./);
  });
});

// --- PR context --------------------------------------------------------------

describe("parsePrContext", () => {
  test("extracts head sha and changed file paths", () => {
    const ctx = parsePrContext(JSON.stringify({
      headRefOid: "abc123",
      files: [{ path: "a.ts" }, { path: "b/c.ts" }],
    }));
    assert.equal(ctx.headSha, "abc123");
    assert.deepEqual([...ctx.changedFiles].sort(), ["a.ts", "b/c.ts"]);
  });

  test("missing headRefOid is a hard error — a review with no commit_id cannot anchor", () => {
    assert.throws(() => parsePrContext(JSON.stringify({ files: [] })), /headRefOid/);
  });
});

// --- CLI ---------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses the full flag set", () => {
    const a = parseArgs(["--repo", "o/r", "--pr", "7", "--findings", "f.json", "--app", "codex", "--dry-run"]);
    assert.deepEqual(a, { repo: "o/r", pr: 7, findingsPath: "f.json", agent: "codex", dryRun: true });
  });

  test("defaults the posting identity to claude", () => {
    assert.equal(parseArgs(["--repo", "o/r", "--pr", "1", "--findings", "-"]).agent, "claude");
  });

  test("unknown flags hard-error rather than parsing to a silent no-op", () => {
    assert.throws(
      () => parseArgs(["--repo", "o/r", "--pr", "1", "--findings", "-", "--dryrun"]),
      /unknown argument: --dryrun/,
    );
  });

  test("rejects a non-numeric or non-positive PR number", () => {
    assert.throws(() => parseArgs(["--repo", "o/r", "--pr", "x", "--findings", "-"]), /positive integer/);
    assert.throws(() => parseArgs(["--repo", "o/r", "--pr", "0", "--findings", "-"]), /positive integer/);
  });

  test("rejects an unknown --app", () => {
    assert.throws(
      () => parseArgs(["--repo", "o/r", "--pr", "1", "--findings", "-", "--app", "gpt"]),
      /--app must be one of/,
    );
  });

  test("required flags are enforced", () => {
    assert.throws(() => parseArgs(["--pr", "1", "--findings", "-"]), /--repo is required/);
    assert.throws(() => parseArgs(["--repo", "o/r", "--findings", "-"]), /--pr is required/);
    assert.throws(() => parseArgs(["--repo", "o/r", "--pr", "1"]), /--findings is required/);
  });

  test("a flag missing its value errors instead of consuming the next flag", () => {
    assert.throws(() => parseArgs(["--repo"]), /--repo requires a value/);
  });
});
