import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  DEFAULT_GENERATED_PATHS,
  GH_MAX_BUFFER,
  GITHUB_REVIEW_BODY_MAX,
  TERMINATION_STDERR_TAIL,
  bodyTooLarge,
  anchorableLinesFromPatch,
  bodyFor,
  defaultRun,
  explainTermination,
  runCapturing,
  buildHumanSummary,
  flattenSlurped,
  isAnchorable,
  matchGeneratedPath,
  parseArgs,
  parsePrContext,
  planReview,
  severityFromVerdict,
  titleFor,
  toFindings,
  type ReportFindingsPayload,
} from "./findings_review_post.ts";
import {
  BODY_REASON_HEADINGS,
  buildReviewBody,
  OUT_OF_DIFF_HEADING,
  partitionInlineVsBody,
  postReview,
} from "./review_post_lib.ts";
import { buildMarker } from "./finding_lib.ts";

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
    const a = parseArgs(["--repo", "o/r", "--pr", "7", "--findings", "f.json", "--agent", "codex", "--dry-run"]);
    assert.deepEqual(a, {
      repo: "o/r",
      pr: 7,
      findingsPath: "f.json",
      agent: "codex",
      dryRun: true,
      generatedPaths: [...DEFAULT_GENERATED_PATHS],
    });
  });

  test("defaults the model attribution to claude", () => {
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

  test("rejects an unknown --agent", () => {
    assert.throws(
      () => parseArgs(["--repo", "o/r", "--pr", "1", "--findings", "-", "--agent", "gpt"]),
      /--agent must be one of/,
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

  // A signal kill sets status null, which is indistinguishable from a crash.
  // The caller interpolates stderr straight into its error, so an empty one
  // produced a message ending in a bare colon.
  test("a signal kill with no stderr is explained, not reported as empty", () => {
    const r = defaultRun(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGKILL')",
    ]);
    assert.equal(r.status, null, "expected a signal kill, not a normal exit");
    assert.notEqual(r.stderr, "", "a killed child must not report empty stderr");
    assert.match(r.stderr, /terminated/);
  });

  // The ENOBUFS explanation used to be gated on stderr being EMPTY. `gh` writes
  // to stderr routinely (rate-limit notices, warnings), and a child killed for
  // exceeding maxBuffer keeps whatever it had already written there — so the one
  // cause we can name precisely was swallowed by an unrelated warning, and the
  // caller interpolated that warning into `failed (exit null): gh: a warning`.
  // That is the same silent-on-large-PRs failure this tool exists to prevent,
  // just relocated to the maxBuffer boundary.
  //
  // Driven through `runCapturing` at 64 KiB rather than `defaultRun` at 64 MiB:
  // the kill path is identical, and the production constant would cost a 64 MiB
  // write in the child plus ~250 MB RSS in the parent on every `npm test`.
  // The child sequences its stdout flood behind the stderr write's callback —
  // Node pipe writes are asynchronous on macOS, so a bare write-then-flood can
  // race.
  test("names the maxBuffer cause even when the child wrote to stderr", () => {
    const cap = 64 * 1024;
    const r = runCapturing(process.execPath, [
      "-e",
      `process.stderr.write("gh: a warning\\n", () => process.stdout.write("x".repeat(${cap * 2})))`,
    ], cap);
    assert.equal(r.status, null, "expected a maxBuffer kill, not a normal exit");
    assert.match(r.stderr, /exceeded maxBuffer/, `cause not named: ${r.stderr}`);
    assert.match(r.stderr, /gh: a warning/, "the child's own stderr must be preserved");
    assert.ok(
      r.stderr.indexOf("exceeded maxBuffer") < r.stderr.indexOf("gh: a warning"),
      `the cause must precede the child's stderr, got: ${r.stderr}`,
    );
  });

  test("names the signal even when the child wrote to stderr", () => {
    const r = defaultRun(process.execPath, [
      "-e",
      "process.stderr.write('noise\\n', () => process.kill(process.pid, 'SIGKILL'))",
    ]);
    assert.equal(r.status, null);
    assert.match(r.stderr, /terminated/, `cause not named: ${r.stderr}`);
    assert.match(r.stderr, /noise/, "the child's own stderr must be preserved");
    assert.ok(
      r.stderr.indexOf("terminated") < r.stderr.indexOf("noise"),
      `the cause must precede the child's stderr, got: ${r.stderr}`,
    );
  });
});

// `explainTermination` is where the ordering and the size cap live. Both are
// invisible to the spawn-backed tests above — a chatty child only reveals them
// past the caller's 400-char slice — so pin them directly, with no subprocess.
describe("explainTermination", () => {
  test("a child that exited normally keeps its stderr verbatim", () => {
    assert.equal(explainTermination("gh", { status: 1 }, "gh: not found\n", 1024), "gh: not found\n");
  });

  // fetchPrContext reports `${stderr.slice(0, 400)}`. A cause appended after a
  // talkative child's stderr is truncated away — the original defect, relocated.
  test("the cause survives the caller's 400-char slice", () => {
    const noisy = "gh: rate limit warning. ".repeat(100);
    const msg = explainTermination(
      "gh",
      { status: null, signal: "SIGTERM", error: Object.assign(new Error("x"), { code: "ENOBUFS" }) },
      noisy,
      4242,
    );
    assert.match(msg.slice(0, 400), /exceeded maxBuffer \(4242 bytes\)/, `cause lost in slice: ${msg.slice(0, 400)}`);
  });

  // An ENOBUFS on the *stderr* stream would otherwise build a fresh maxBuffer
  // sized string that the caller discards one line later.
  test("the child's stderr is capped, not carried at maxBuffer size", () => {
    const huge = "e".repeat(TERMINATION_STDERR_TAIL * 4);
    const msg = explainTermination("gh", { status: null, signal: "SIGKILL" }, huge, 1024);
    assert.ok(msg.length < TERMINATION_STDERR_TAIL + 200, `uncapped stderr: ${msg.length} chars`);
    assert.match(msg, /killed by signal SIGKILL/);
  });

  test("a spawn failure with no stderr still names the error", () => {
    const msg = explainTermination(
      "gh",
      { status: null, signal: null, error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }) },
      "",
      1024,
    );
    assert.match(msg, /produced no stderr and was terminated: spawnSync gh ENOENT/);
  });
});

// --- generated-path routing --------------------------------------------------

/**
 * A bifrost-shaped sync PR: a regenerated snapshot of code already merged
 * upstream, plus two hand-written files that must keep their inline threads.
 * `web/src/__fixtures__/index.json` is the trap — a real source fixture whose
 * BASENAME matches the `index.json` default glob.
 */
const SYNC_PR_FILES = JSON.stringify([
  { filename: "vendor/stark-skills/tools/gru.ts", patch: "@@ -10,2 +10,3 @@\n keep\n+regenerated\n ctx" },
  { filename: "dist/claude/stark-ops/skills/gru/SKILL.md", patch: "@@ -1,1 +1,2 @@\n a\n+b" },
  { filename: "index.json", patch: "@@ -3,1 +3,2 @@\n x\n+y" },
  { filename: ".claude-plugin/marketplace.json", patch: "@@ -1,1 +1,2 @@\n a\n+b" },
  { filename: "web/src/__fixtures__/index.json", patch: "@@ -1,1 +1,2 @@\n a\n+b" },
  { filename: "engine/internal/install/install.go", patch: "@@ -40,2 +40,3 @@\n ctx\n+added\n tail" },
]);

const SYNC_PAYLOAD: ReportFindingsPayload = {
  level: "xhigh",
  findings: [
    { file: "vendor/stark-skills/tools/gru.ts", line: 11, short_summary: "vendor snapshot", summary: "s", verdict: "CONFIRMED" },
    { file: "dist/claude/stark-ops/skills/gru/SKILL.md", line: 2, short_summary: "dist copy", summary: "s" },
    { file: "index.json", line: 4, short_summary: "root index", summary: "s" },
    { file: ".claude-plugin/marketplace.json", line: 2, short_summary: "marketplace index", summary: "s" },
    { file: "web/src/__fixtures__/index.json", line: 2, short_summary: "hand-written fixture", summary: "s" },
    { file: "engine/internal/install/install.go", line: 41, short_summary: "real source bug", summary: "s", verdict: "CONFIRMED" },
  ],
};

const GENERATED_PATHS = ["vendor/**", "dist/**", ".claude-plugin/**", "index.json"] as const;

function syncPlan(generatedPaths: readonly string[] = GENERATED_PATHS) {
  const ctx = parsePrContext("headsha", SYNC_PR_FILES);
  return { ctx, plan: planReview(SYNC_PAYLOAD, ctx, { agent: "claude", generatedPaths }) };
}

describe("generated-path routing", () => {
  test("a sync PR leaves zero inline threads on generated paths", () => {
    const { plan } = syncPlan();
    const { inline, bodyFindings } = partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low");
    assert.deepEqual(
      inline.map((c) => c.path).sort(),
      ["engine/internal/install/install.go", "web/src/__fixtures__/index.json"],
    );
    for (const c of inline) {
      assert.doesNotMatch(c.path, /^(vendor|dist)\//, `${c.path} must not open an inline thread`);
    }
    // No finding is lost on the way: 4 demoted + 2 still anchored.
    assert.equal(inline.length + bodyFindings.length, SYNC_PAYLOAD.findings.length);
  });

  test("every generated-path finding reaches the review body with its file and line", () => {
    const { plan } = syncPlan();
    const { bodyFindings } = partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low");
    const body = buildReviewBody("<!-- marker -->", plan.humanSummary, bodyFindings);
    assert.match(body, /`vendor\/stark-skills\/tools\/gru\.ts:11`/);
    assert.match(body, /`dist\/claude\/stark-ops\/skills\/gru\/SKILL\.md:2`/);
    assert.match(body, /`index\.json:4`/);
  });

  test("generated-path findings are not filed under the out-of-diff heading (STARK-6096)", () => {
    // End to end: planReview tags them, buildReviewBody groups on the tag. A
    // reader scanning the review must not see an in-diff CONFIRMED finding on
    // `vendor/…/gru.ts:11` presented as being outside the PR's scope.
    const { plan } = syncPlan();
    // Which files were demoted is `plan.generated.entries` — the tool's own
    // answer for the globs this run passed. Re-deriving it from a hand-rolled
    // regex would silently diverge the moment `generatedPaths` changes.
    const demoted = new Set(plan.generated.entries.map((e) => e.file));
    assert.ok(demoted.size > 0, "the fixture must demote something");
    for (const f of plan.findings) {
      assert.equal(
        f.body_reason,
        demoted.has(f.file ?? "") ? "generated_path" : undefined,
        `${f.file} carries the wrong body_reason`,
      );
    }
    const { bodyFindings } = partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low");
    const body = buildReviewBody("<!-- marker -->", plan.humanSummary, bodyFindings);
    assert.ok(
      body.includes(BODY_REASON_HEADINGS.generated_path),
      "generated findings get their own accurate heading",
    );
    // Every body finding here is a generated one, so the out-of-diff heading
    // must be absent entirely — a stronger claim than "the generated ones sit
    // elsewhere", and one that cannot pass vacuously.
    assert.ok(
      !body.includes(OUT_OF_DIFF_HEADING),
      "no out-of-diff heading when every body finding is a generated-path one",
    );
    assert.match(body, /`vendor\/stark-skills\/tools\/gru\.ts:11`/);
  });

  test("a generated path outside the PR's diff is not called in-diff (STARK-6096)", () => {
    // A reviewer can report a finding on a generated file the PR never touched.
    // It still loses its thread, but the heading may not assert it was in the
    // diff while the entry's own note reads "outside this PR's diff" — that is
    // the same falsehood this ticket fixed, pointing the other way.
    const ctx = parsePrContext("headsha", JSON.stringify([
      { filename: "engine/internal/install/install.go", patch: "@@ -1,1 +1,2 @@\n a\n+b" },
    ]));
    const plan = planReview(
      { findings: [{ file: "vendor/untouched/foo.ts", line: 7, short_summary: "never touched", summary: "s" }] },
      ctx,
      { agent: "claude", generatedPaths: ["vendor/**"] },
    );
    const { bodyFindings } = partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low");
    const body = buildReviewBody("<!-- marker -->", plan.humanSummary, bodyFindings);
    assert.match(body, /outside this PR's diff/, "the per-finding note states the truth");
    assert.doesNotMatch(
      body,
      /^## .*\bIn-diff\b/im,
      "no heading may claim in-diff over an entry that says otherwise",
    );
  });

  test("a finding on an ordinary source path is unchanged", () => {
    const { plan } = syncPlan();
    const src = plan.findings.find((f) => f.file === "engine/internal/install/install.go");
    assert.ok(src);
    assert.equal(src.line, 41, "a source anchor survives untouched");
    assert.equal(src.severity, "high");
    assert.equal(src.classification, "fix");
    assert.doesNotMatch(src.body, /Generated output/);
  });

  test("demotion changes the thread, never the severity or the disposition", () => {
    const { plan } = syncPlan();
    const vendor = plan.findings.find((f) => f.file === "vendor/stark-skills/tools/gru.ts");
    assert.ok(vendor);
    assert.equal(vendor.severity, "high", "severity is inferred from verdict, not from the path");
    assert.equal(vendor.classification, "fix", "the split must not re-classify a finding");
    assert.equal(vendor.line, 11, "the finding keeps the line it would have anchored to");
    assert.match(vendor.body, /matched `vendor\/\*\*`/);
  });

  test("the preamble states generated, upstream, and the shared-branch block", () => {
    const { plan } = syncPlan();
    assert.match(plan.humanSummary, /4 findings on generated paths/);
    assert.match(plan.humanSummary, /\*\*generated output\*\*/i);
    assert.match(plan.humanSummary, /\*\*upstream\*\*/i);
    assert.match(plan.humanSummary, /\*\*shared\*\*/i);
    assert.match(plan.humanSummary, /required_conversation_resolution/);
    assert.match(plan.humanSummary, /Nothing is dropped, downgraded, or auto-resolved/);
  });

  test("the split is reported in the JSON summary: generated under body, source under inline", async () => {
    const { ctx, plan } = syncPlan();
    const result = await postReview({
      repo: "21StarkCom/bifrost",
      pr: 264,
      round: 1,
      agent: "claude",
      runHash: "test",
      findings: plan.findings,
      changedFiles: plan.inlineEligibleFiles,
      fixThreshold: "low",
      humanSummary: plan.humanSummary,
      prHeadSha: ctx.headSha,
      dryRun: true,
    });
    assert.equal(result.payloadSummary.inlineCount, 2);
    assert.equal(result.payloadSummary.bodyFindingsCount, 4);
    assert.equal(plan.generated.enabled, true);
    assert.deepEqual(
      plan.generated.entries.map((e) => [e.file, e.line, e.pattern]),
      [
        ["vendor/stark-skills/tools/gru.ts", 11, "vendor/**"],
        ["dist/claude/stark-ops/skills/gru/SKILL.md", 2, "dist/**"],
        ["index.json", 4, "index.json"],
        [".claude-plugin/marketplace.json", 2, ".claude-plugin/**"],
      ],
    );
  });

  test("a hand-written fixture whose basename matches a glob keeps its inline thread", () => {
    // Globs are anchored against the whole path. Under gitignore's basename
    // rule, `index.json` would also swallow bifrost's source fixtures — whose
    // findings ARE fixable where they are posted.
    assert.equal(matchGeneratedPath("index.json", DEFAULT_GENERATED_PATHS), "index.json");
    assert.equal(matchGeneratedPath("web/src/__fixtures__/index.json", DEFAULT_GENERATED_PATHS), null);
    assert.equal(matchGeneratedPath("engine/internal/install/testdata/index.json", DEFAULT_GENERATED_PATHS), null);
  });

  test("the default globs cover every path a bifrost sync PR machine-rewrites", () => {
    // Taken from `git show --stat` on a real sync commit plus bifrost's
    // `.gitattributes` `linguist-generated=true` rows. `.claude-plugin/**` was
    // missing from the first cut of this list, so the one file every sync
    // touches kept opening a gating thread — the exact failure the split exists
    // to prevent. `CHANGELOG.md` is the counter-case: a sync writes it, but it
    // is hand-reviewable, so it must keep its inline thread.
    for (const f of [
      "vendor/stark-skills/tools/gru.ts",
      "dist/claude/stark-ops/skills/gru/SKILL.md",
      "bundles/stark-ops.json",
      "catalog/stark-ops/bundle.yaml",
      ".claude-plugin/marketplace.json",
      "index.json",
    ]) {
      assert.notEqual(matchGeneratedPath(f, DEFAULT_GENERATED_PATHS), null, `${f} must demote`);
    }
    assert.equal(matchGeneratedPath("CHANGELOG.md", DEFAULT_GENERATED_PATHS), null);
  });

  test("a generated finding outside every hunk still carries its declared line", () => {
    const ctx = parsePrContext("sha", SYNC_PR_FILES);
    const plan = planReview(
      { findings: [{ file: "vendor/stark-skills/tools/gru.ts", line: 999, summary: "s" }] },
      ctx,
      { agent: "claude", generatedPaths: GENERATED_PATHS },
    );
    assert.equal(plan.findings[0].line, null, "an out-of-hunk anchor is still dropped");
    assert.match(plan.findings[0].body, /`vendor\/stark-skills\/tools\/gru\.ts:999`/);
    assert.equal(plan.generated.entries[0].line, 999);
  });

  test("an empty glob list anchors generated paths inline like any other file", () => {
    const { plan } = syncPlan([]);
    const { inline } = partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low");
    assert.equal(inline.length, SYNC_PAYLOAD.findings.length);
    assert.equal(plan.generated.enabled, false);
    assert.equal(plan.generated.entries.length, 0);
    assert.doesNotMatch(plan.humanSummary, /generated paths/);
  });

  test("the inline-eligible set drops every generated file, finding or not", () => {
    const { plan } = syncPlan();
    assert.deepEqual(
      [...plan.inlineEligibleFiles].sort(),
      ["engine/internal/install/install.go", "web/src/__fixtures__/index.json"],
    );
  });

  test("a finding with no file is never treated as generated", () => {
    assert.equal(matchGeneratedPath(null, DEFAULT_GENERATED_PATHS), null);
    assert.equal(matchGeneratedPath(undefined, DEFAULT_GENERATED_PATHS), null);
    assert.equal(matchGeneratedPath("", DEFAULT_GENERATED_PATHS), null);
  });

  test("a leading ./ is normalized before matching", () => {
    assert.equal(matchGeneratedPath("./index.json", DEFAULT_GENERATED_PATHS), "index.json");
    assert.equal(matchGeneratedPath("./vendor/a.ts", DEFAULT_GENERATED_PATHS), "vendor/**");
  });
});

describe("review-body size guard", () => {
  test("a body at the cap passes and one char over refuses", () => {
    assert.equal(bodyTooLarge(GITHUB_REVIEW_BODY_MAX), null);
    assert.equal(bodyTooLarge(0), null);
    const err = bodyTooLarge(GITHUB_REVIEW_BODY_MAX + 1);
    assert.ok(err);
    assert.match(err, /over GitHub's 65536-char limit/);
  });

  test("the refusal names both remedies, since the fallback would lose every finding", () => {
    // Over the cap the POST 422s with no errors[].index, so extract422Indices
    // returns [] and postReview folds the inline comments into the SAME body,
    // retries larger and reports unposted — nothing posted at all. That is
    // strictly worse than the gating threads this split exists to prevent.
    const err = bodyTooLarge(200_000);
    assert.ok(err);
    assert.match(err, /smaller[\s\S]*batches/);
    assert.match(err, /--generated-paths/);
  });

  test("the guard measures the body postReview actually builds, not an estimate", async () => {
    const { ctx, plan } = syncPlan();
    const result = await postReview({
      repo: "o/r",
      pr: 1,
      round: 1,
      agent: "claude",
      runHash: "test",
      findings: plan.findings,
      changedFiles: plan.inlineEligibleFiles,
      fixThreshold: "low",
      humanSummary: plan.humanSummary,
      prHeadSha: ctx.headSha,
      dryRun: true,
    });
    const rebuilt = buildReviewBody(
      buildMarker(1, "claude", "test"),
      plan.humanSummary,
      partitionInlineVsBody(plan.findings, plan.inlineEligibleFiles, "low").bodyFindings,
    );
    assert.equal(result.payloadSummary.bodyChars, rebuilt.length);
  });
});

describe("generated-path glob matching", () => {
  // `matchGeneratedPath` delegates to node:path's `matchesGlob`. These pin the
  // semantics the split depends on, so a change in that matcher is caught here
  // rather than by a finding silently losing (or gaining) a gating thread.
  const hit = (file: string, pattern: string) =>
    matchGeneratedPath(file, [pattern]) === pattern;

  test("a single star stays inside one path segment", () => {
    assert.equal(hit("dist/a.js", "dist/*.js"), true);
    assert.equal(hit("dist/nested/a.js", "dist/*.js"), false);
  });

  test("a doubled star crosses path separators but needs at least one segment", () => {
    assert.equal(hit("vendor/a/b/c.ts", "vendor/**"), true);
    assert.equal(hit("vendor/a.ts", "vendor/**"), true);
    assert.equal(hit("vendor", "vendor/**"), false);
    assert.equal(hit("my-vendor/a.ts", "vendor/**"), false);
  });

  test("a leading doubled star plus slash also matches zero segments", () => {
    assert.equal(hit("index.json", "**/index.json"), true);
    assert.equal(hit("a/b/index.json", "**/index.json"), true);
  });

  test("a literal dot is not a wildcard", () => {
    assert.equal(hit("indexXjson", "index.json"), false);
  });

  test("a pattern is anchored at both ends", () => {
    assert.equal(hit("x/dist/a.js", "dist/**"), false);
    assert.equal(hit("index.json.bak", "index.json"), false);
  });

  test("a dotfile directory glob matches, so .claude-plugin is reachable", () => {
    // A basename-blind or dot-skipping matcher would leave the one file every
    // bifrost sync rewrites still opening a gating thread.
    assert.equal(hit(".claude-plugin/marketplace.json", ".claude-plugin/**"), true);
  });
});

describe("parseArgs generated-path flags", () => {
  const base = ["--repo", "o/r", "--pr", "1", "--findings", "-"];

  test("the default glob list is the shipped one", () => {
    assert.deepEqual(parseArgs(base).generatedPaths, [...DEFAULT_GENERATED_PATHS]);
  });

  test("--generated-paths replaces the default list and trims each glob", () => {
    const a = parseArgs([...base, "--generated-paths", "build/**, out/*.json ,"]);
    assert.deepEqual(a.generatedPaths, ["build/**", "out/*.json"]);
  });

  test("--generated-paths with an empty value is refused, never a silent disable", () => {
    // A typo that quietly turned the split off would reintroduce exactly the
    // shared-branch block this routing exists to prevent.
    assert.throws(() => parseArgs([...base, "--generated-paths", ""]), /at least one glob/);
    assert.throws(() => parseArgs([...base, "--generated-paths", " , "]), /at least one glob/);
  });

  test("--no-generated-split is the only way to disable the split", () => {
    assert.deepEqual(parseArgs([...base, "--no-generated-split"]).generatedPaths, []);
  });

  test("a flag whose value is omitted refuses instead of eating the next flag", () => {
    // `--generated-paths --dry-run` used to parse to the glob list ["--dry-run"]:
    // matching nothing, so every generated finding regained a gating thread,
    // while --dry-run was consumed and never set, so the review really posted.
    assert.throws(
      () => parseArgs([...base, "--generated-paths", "--dry-run"]),
      /--generated-paths requires a value, got the flag --dry-run/,
    );
    assert.throws(() => parseArgs(["--repo", "--pr", "1", "--findings", "-"]), /got the flag --pr/);
  });

  test("`-` stays legal — it is the documented stdin value for --findings", () => {
    assert.equal(parseArgs(["--repo", "o/r", "--pr", "1", "--findings", "-"]).findingsPath, "-");
  });

  test("the last of the two flags wins", () => {
    assert.deepEqual(
      parseArgs([...base, "--no-generated-split", "--generated-paths", "x/**"]).generatedPaths,
      ["x/**"],
    );
    assert.deepEqual(
      parseArgs([...base, "--generated-paths", "x/**", "--no-generated-split"]).generatedPaths,
      [],
    );
  });
});
