import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  GH_MAX_BUFFER,
  anchorableLinesFromPatch,
  bodyFor,
  defaultRun,
  buildHumanSummary,
  flattenSlurped,
  isAnchorable,
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
    const ctx = parsePrContext("abc123\n", JSON.stringify([
      { filename: "a.ts", patch: "@@ -1,1 +1,2 @@\n ctx\n+added" },
      { filename: "b/c.ts", patch: "@@ -1,1 +1,1 @@\n ctx" },
    ]));
    assert.equal(ctx.headSha, "abc123");
    assert.deepEqual([...ctx.changedFiles].sort(), ["a.ts", "b/c.ts"]);
  });

  test("missing head sha is a hard error — a review with no commit_id cannot anchor", () => {
    assert.throws(() => parsePrContext("  \n", "[]"), /head sha/);
  });

  test("a file with no patch maps to null, so every line stays anchorable", () => {
    const ctx = parsePrContext("sha", JSON.stringify([{ filename: "big.bin" }]));
    assert.equal(ctx.anchorable.get("big.bin"), null);
    assert.equal(isAnchorable(ctx.anchorable, "big.bin", 99999), true);
  });

  test("a file absent from the PR is never anchorable", () => {
    const ctx = parsePrContext("sha", JSON.stringify([{ filename: "a.ts", patch: "@@ -1 +1 @@\n x" }]));
    assert.equal(isAnchorable(ctx.anchorable, "elsewhere.ts", 1), false);
  });
});

// --- hunk parsing ------------------------------------------------------------

describe("anchorableLinesFromPatch", () => {
  test("added and context lines are anchorable, deleted lines are not", () => {
    // new-side numbering: 10 ctx, 11 added, 12 ctx  (the removed line has no
    // right-side number at all)
    const lines = anchorableLinesFromPatch("@@ -10,2 +10,3 @@\n keep\n+new\n-gone\n tail");
    assert.deepEqual([...lines].sort((a, b) => a - b), [10, 11, 12]);
  });

  test("multiple hunks each restart the cursor from their own header", () => {
    const lines = anchorableLinesFromPatch(
      "@@ -1,1 +1,1 @@\n a\n@@ -50,2 +60,2 @@\n b\n c",
    );
    assert.deepEqual([...lines].sort((a, b) => a - b), [1, 60, 61]);
  });

  test("a gap between hunks is NOT anchorable — the PR #870 failure", () => {
    // Hunks covering new lines 10-11 and 139-140: line 123 falls between them.
    // GitHub 422s on it, names no index, and postReview's fallback then demotes
    // every other anchor in the batch.
    const lines = anchorableLinesFromPatch("@@ -10,2 +10,2 @@\n a\n b\n@@ -120,2 +139,2 @@\n c\n d");
    assert.equal(lines.has(139), true);
    assert.equal(lines.has(123), false);
  });

  test("the no-newline marker does not advance the cursor", () => {
    const lines = anchorableLinesFromPatch("@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file");
    assert.deepEqual([...lines].sort((a, b) => a - b), [1, 2]);
  });

  test("text before any hunk header is ignored", () => {
    assert.equal(anchorableLinesFromPatch("diff --git a/x b/x\n+stray").size, 0);
  });
});

describe("flattenSlurped", () => {
  test("flattens the array-of-pages --slurp shape", () => {
    const out = flattenSlurped(JSON.stringify([[{ filename: "a" }], [{ filename: "b" }]]));
    assert.deepEqual(JSON.parse(out), [{ filename: "a" }, { filename: "b" }]);
  });

  test("a single already-flat array passes through", () => {
    const out = flattenSlurped(JSON.stringify([{ filename: "a" }]));
    assert.deepEqual(JSON.parse(out), [{ filename: "a" }]);
  });
});

// --- anchor filtering end to end --------------------------------------------

describe("toFindings anchor validation", () => {
  const ctx = parsePrContext("sha", JSON.stringify([
    { filename: "a.ts", patch: "@@ -10,2 +10,2 @@\n keep\n+new" },
  ]));

  test("a finding on an in-hunk line keeps its anchor", () => {
    const [f] = toFindings({ findings: [{ file: "a.ts", line: 11, summary: "s" }] }, "claude", ctx.anchorable);
    assert.equal(f.line, 11);
    assert.doesNotMatch(f.body, /not anchorable/);
  });

  test("a finding outside every hunk loses its anchor but keeps the location in the body", () => {
    const [f] = toFindings({ findings: [{ file: "a.ts", line: 999, summary: "s" }] }, "claude", ctx.anchorable);
    assert.equal(f.line, null, "line must be null or GitHub 422s the whole batch");
    assert.match(f.body, /\*\*Location:\*\* `a\.ts:999` \(outside this PR's diff — not anchorable\)/);
    assert.match(f.body, /s/);
  });

  test("one unanchorable finding does not cost the others their anchors", () => {
    const findings = toFindings({
      findings: [
        { file: "a.ts", line: 10, short_summary: "good" },
        { file: "a.ts", line: 999, short_summary: "bad anchor" },
        { file: "a.ts", line: 11, short_summary: "also good" },
      ],
    }, "claude", ctx.anchorable);
    const { inline, bodyFindings } = partitionInlineVsBody(findings, ctx.changedFiles, "low");
    assert.equal(inline.length, 2);
    assert.equal(bodyFindings.length, 1);
    assert.equal(inline.length + bodyFindings.length, 3);
  });

  test("omitting the anchor map preserves the old file-granularity behavior", () => {
    const [f] = toFindings({ findings: [{ file: "a.ts", line: 999, summary: "s" }] }, "claude");
    assert.equal(f.line, 999);
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

// --- subprocess buffering ----------------------------------------------------

describe("defaultRun", () => {
  // `gh api /pulls/N/files --paginate --slurp` carries every file's full PATCH,
  // so its payload scales with the DIFF, not with the number of findings. Node's
  // 1 MiB spawnSync default silently killed the child on a 78-file PR (measured
  // 1.27 MB), and the tool reported `failed (exit null):` with empty stderr —
  // a review-posting tool failing precisely on the large PRs whose findings
  // matter most. 2 MB here is over the old default and far under the new one.
  test("returns the whole payload when it exceeds Node's 1 MiB default", () => {
    const bytes = 2 * 1024 * 1024;
    const r = defaultRun(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(${bytes}))`,
    ]);
    assert.equal(r.status, 0, `expected a clean exit, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.length, bytes);
  });

  test("GH_MAX_BUFFER is well above the payloads gh actually returns", () => {
    assert.ok(GH_MAX_BUFFER > 1024 * 1024, "must exceed Node's default");
  });

  // A signal kill sets status null and leaves stderr empty, which is
  // indistinguishable from a crash. The caller interpolates stderr straight
  // into its error, so an empty one produced a message ending in a bare colon.
  test("a signal kill with no stderr is explained, not reported as empty", () => {
    const r = defaultRun(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    assert.equal(r.status, null, "expected a signal kill, not a normal exit");
    assert.notEqual(r.stderr, "", "a killed child must not report empty stderr");
    assert.match(r.stderr, /terminated/);
  });
});
