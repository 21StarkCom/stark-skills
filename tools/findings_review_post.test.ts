import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  DEFAULT_GENERATED_PATHS,
  GH_MAX_BUFFER,
  anchorableLinesFromPatch,
  bodyFor,
  compileGeneratedMatchers,
  defaultRun,
  buildHumanSummary,
  flattenSlurped,
  globToRegExp,
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
import { partitionInlineVsBody, postReview, buildReviewBody } from "./stark_review.ts";

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
  { filename: "web/src/__fixtures__/index.json", patch: "@@ -1,1 +1,2 @@\n a\n+b" },
  { filename: "engine/internal/install/install.go", patch: "@@ -40,2 +40,3 @@\n ctx\n+added\n tail" },
]);

const SYNC_PAYLOAD: ReportFindingsPayload = {
  level: "xhigh",
  findings: [
    { file: "vendor/stark-skills/tools/gru.ts", line: 11, short_summary: "vendor snapshot", summary: "s", verdict: "CONFIRMED" },
    { file: "dist/claude/stark-ops/skills/gru/SKILL.md", line: 2, short_summary: "dist copy", summary: "s" },
    { file: "index.json", line: 4, short_summary: "root index", summary: "s" },
    { file: "web/src/__fixtures__/index.json", line: 2, short_summary: "hand-written fixture", summary: "s" },
    { file: "engine/internal/install/install.go", line: 41, short_summary: "real source bug", summary: "s", verdict: "CONFIRMED" },
  ],
};

const GENERATED_PATHS = ["vendor/**", "dist/**", "index.json"] as const;

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
    // No finding is lost on the way: 3 demoted + 2 still anchored.
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
    assert.match(plan.humanSummary, /3 findings on generated paths/);
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
    assert.equal(result.payloadSummary.bodyFindingsCount, 3);
    assert.equal(plan.generated.enabled, true);
    assert.deepEqual(
      plan.generated.entries.map((e) => [e.file, e.line, e.pattern]),
      [
        ["vendor/stark-skills/tools/gru.ts", 11, "vendor/**"],
        ["dist/claude/stark-ops/skills/gru/SKILL.md", 2, "dist/**"],
        ["index.json", 4, "index.json"],
      ],
    );
  });

  test("a hand-written fixture whose basename matches a glob keeps its inline thread", () => {
    // Globs are anchored against the whole path. Under gitignore's basename
    // rule, `index.json` would also swallow bifrost's source fixtures — whose
    // findings ARE fixable where they are posted.
    const matchers = compileGeneratedMatchers(DEFAULT_GENERATED_PATHS);
    assert.equal(matchGeneratedPath("index.json", matchers), "index.json");
    assert.equal(matchGeneratedPath("web/src/__fixtures__/index.json", matchers), null);
    assert.equal(matchGeneratedPath("engine/internal/install/testdata/index.json", matchers), null);
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
    const matchers = compileGeneratedMatchers(DEFAULT_GENERATED_PATHS);
    assert.equal(matchGeneratedPath(null, matchers), null);
    assert.equal(matchGeneratedPath(undefined, matchers), null);
    assert.equal(matchGeneratedPath("", matchers), null);
  });

  test("a leading ./ is normalized before matching", () => {
    const matchers = compileGeneratedMatchers(DEFAULT_GENERATED_PATHS);
    assert.equal(matchGeneratedPath("./index.json", matchers), "index.json");
    assert.equal(matchGeneratedPath("./vendor/a.ts", matchers), "vendor/**");
  });
});

describe("globToRegExp", () => {
  test("a single star stays inside one path segment", () => {
    assert.equal(globToRegExp("dist/*.js").test("dist/a.js"), true);
    assert.equal(globToRegExp("dist/*.js").test("dist/nested/a.js"), false);
  });

  test("a doubled star crosses path separators but needs at least one segment", () => {
    assert.equal(globToRegExp("vendor/**").test("vendor/a/b/c.ts"), true);
    assert.equal(globToRegExp("vendor/**").test("vendor/a.ts"), true);
    assert.equal(globToRegExp("vendor/**").test("vendor"), false);
    assert.equal(globToRegExp("vendor/**").test("my-vendor/a.ts"), false);
  });

  test("a leading doubled star plus slash also matches zero segments", () => {
    assert.equal(globToRegExp("**/index.json").test("index.json"), true);
    assert.equal(globToRegExp("**/index.json").test("a/b/index.json"), true);
  });

  test("regex metacharacters in a pattern are literal", () => {
    assert.equal(globToRegExp("index.json").test("indexXjson"), false);
    assert.equal(globToRegExp("a+b.json").test("a+b.json"), true);
    assert.equal(globToRegExp("a+b.json").test("aab.json"), false);
  });

  test("a pattern is anchored at both ends", () => {
    assert.equal(globToRegExp("dist/**").test("x/dist/a.js"), false);
    assert.equal(globToRegExp("index.json").test("index.json.bak"), false);
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
