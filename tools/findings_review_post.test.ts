import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodePathMod from "node:path";

import {
  DEFAULT_GENERATED_PATHS,
  GH_MAX_BUFFER,
  GITHUB_REVIEW_BODY_MAX,
  TERMINATION_STDERR_TAIL,
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
  parseGeneratedGlobs,
  parsePrContext,
  planReview,
  resolveGeneratedPaths,
  fetchGitattributes,
  severityFromVerdict,
  titleFor,
  toFindings,
  type ReportFindingsPayload,
  type GeneratedPathsSource,
} from "./findings_review_post.ts";
import {
  BODY_REASON_HEADINGS,
  buildReviewBody,
  GITHUB_REVIEW_BODY_MAX as LIB_CAP,
  OUT_OF_DIFF_HEADING,
  partitionInlineVsBody,
  postReview,
} from "./review_post_lib.ts";
import { DEFAULT_GENERATED_PATHS_CONFIG, type GeneratedPathsConfig } from "./stark_config_lib.ts";
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
      generatedPathsExplicit: false,
      addGeneratedPaths: [],
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

const BIFROST = "21StarkCom/bifrost";

/**
 * Verbatim from `21StarkCom/bifrost`'s `.gitattributes` — the five
 * `linguist-generated=true` rows plus the `text eol=lf` row that must NOT be
 * read as generated. `catalog/**` appears there only as `text eol=lf`; it
 * reaches the resolved list through the repo CONFIG entry, which is the one
 * deliberate addition.
 */
const BIFROST_GITATTRIBUTES = [
  "* text=auto eol=lf",
  "",
  "dist/**            linguist-generated=true",
  "vendor/**          linguist-generated=true",
  "index.json         linguist-generated=true",
  "bundles/**         linguist-generated=true",
  ".claude-plugin/**  linguist-generated=true",
  "catalog/**         text eol=lf",
  "",
].join("\n");

/** A config with no repo entries at all, so a layer under test stands alone. */
const BARE_CONFIG: GeneratedPathsConfig = {
  enabled: true,
  default: ["vendor/**", "dist/**", "bundles/**", ".claude-plugin/**", "index.json"],
  repos: {},
};


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

  test("the resolved bifrost list covers every path a sync PR machine-rewrites", () => {
    // Taken from `git show --stat` on a real sync commit plus bifrost's
    // `.gitattributes` `linguist-generated=true` rows. `.claude-plugin/**` was
    // missing from the first cut of the hand-copied list, so the one file every
    // sync touches kept opening a gating thread — the exact failure the split
    // exists to prevent. That is why the rows are now READ from the repo:
    // resolving them here, not restating them. `CHANGELOG.md` is the
    // counter-case: a sync writes it, but it is hand-reviewable, so it must
    // keep its inline thread.
    const { patterns } = resolveGeneratedPaths({
      repo: BIFROST,
      gitattributes: BIFROST_GITATTRIBUTES,
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    for (const f of [
      "vendor/stark-skills/tools/gru.ts",
      "dist/claude/stark-ops/skills/gru/SKILL.md",
      "bundles/stark-ops.json",
      "catalog/stark-ops/bundle.yaml",
      ".claude-plugin/marketplace.json",
      "index.json",
    ]) {
      assert.notEqual(matchGeneratedPath(f, patterns), null, `${f} must demote`);
    }
    assert.equal(matchGeneratedPath("CHANGELOG.md", patterns), null);
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
  test("the cap is re-exported from review_post_lib, which now owns the degrade", () => {
    // STARK-6094 moved the constant and its handling into postReview, which
    // degrades (overflow comments) instead of refusing. The re-export keeps the
    // name resolvable for anything importing it from this tool.
    assert.equal(GITHUB_REVIEW_BODY_MAX, LIB_CAP);
    assert.equal(GITHUB_REVIEW_BODY_MAX, 65536);
  });

  test("the summary measures the body postReview actually builds, not an estimate", async () => {
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


// --- generated-path resolution (STARK-6095) ----------------------------------

describe("parseGeneratedGlobs", () => {
  test("reads exactly the linguist-generated=true rows, in file order", () => {
    assert.deepEqual(parseGeneratedGlobs(BIFROST_GITATTRIBUTES), [
      "dist/**",
      "vendor/**",
      "index.json",
      "bundles/**",
      ".claude-plugin/**",
    ]);
  });

  test("a bare `linguist-generated` is Set, so it counts", () => {
    assert.deepEqual(parseGeneratedGlobs("gen/** linguist-generated"), ["gen/**"]);
  });

  test("a double-quoted pattern with a space survives intact", () => {
    // Splitting the whole line on whitespace tore `"my dir/*"` into the glob
    // `"my` — a garbage pattern that matches nothing and joins the list
    // silently, which is a fail-narrow wearing a parse bug's hat.
    assert.deepEqual(
      parseGeneratedGlobs('"my dir/*" linguist-generated=true'),
      ["my dir/*"],
    );
    assert.deepEqual(parseGeneratedGlobs('"my dir/*" text eol=lf'), []);
  });

  test("unset, negated and false rows are skipped, never inverted", () => {
    const text = [
      "a/** -linguist-generated",
      "b/** !linguist-generated",
      "c/** linguist-generated=false",
      "d/** linguist-vendored=true",
      "e/** text eol=lf",
    ].join("\n");
    assert.deepEqual(parseGeneratedGlobs(text), []);
  });

  test("comments, blanks and [attr] macro definitions are skipped", () => {
    const text = [
      "# dist/** linguist-generated=true",
      "",
      "   ",
      "[attr]binary -diff -merge -text linguist-generated=true",
      "real/** linguist-generated=true",
    ].join("\n");
    assert.deepEqual(parseGeneratedGlobs(text), ["real/**"]);
  });

  test("a leading slash is dropped and a trailing slash becomes a directory glob", () => {
    assert.deepEqual(
      parseGeneratedGlobs("/out.json linguist-generated=true\ngen/ linguist-generated=true"),
      ["out.json", "gen/**"],
    );
  });

  test("a slash-less pattern stays ROOT-anchored, diverging from git on purpose", () => {
    // git would match the basename at any depth. Doing that here would demote
    // bifrost's hand-written `web/src/__fixtures__/index.json`, whose findings
    // are fixable exactly where they are posted.
    const patterns = parseGeneratedGlobs("index.json linguist-generated=true");
    assert.deepEqual(patterns, ["index.json"]);
    assert.equal(matchGeneratedPath("index.json", patterns), "index.json");
    assert.equal(matchGeneratedPath("web/src/__fixtures__/index.json", patterns), null);
  });
});

describe("resolveGeneratedPaths precedence", () => {
  const layered: GeneratedPathsConfig = {
    enabled: true,
    default: ["default/**"],
    repos: { [BIFROST]: { paths: ["repocfg/**"] } },
  };

  test("layer 1 — an explicit --generated-paths outranks every other layer", () => {
    const r = resolveGeneratedPaths({
      repo: BIFROST,
      cliPaths: ["cli/**"],
      gitattributes: BIFROST_GITATTRIBUTES,
      config: layered,
    });
    assert.deepEqual(r.patterns, ["cli/**"]);
    assert.equal(r.source, "cli");
  });

  test("layer 2 — the repo config entry outranks the repo's .gitattributes", () => {
    const r = resolveGeneratedPaths({
      repo: BIFROST,
      gitattributes: BIFROST_GITATTRIBUTES,
      config: layered,
    });
    assert.deepEqual(r.patterns, ["repocfg/**"]);
    assert.equal(r.source, "repo-config");
  });

  test("layer 3 — .gitattributes outranks the built-in default", () => {
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: BIFROST_GITATTRIBUTES,
      config: layered,
    });
    assert.equal(r.source, "gitattributes");
    assert.ok(!r.patterns.includes("default/**"));
  });

  test("layer 4 — the built-in default is the last resort", () => {
    const r = resolveGeneratedPaths({ repo: "o/other", gitattributes: null, config: layered });
    assert.deepEqual(r.patterns, ["default/**"]);
    assert.equal(r.source, "default");
  });
});

describe("resolveGeneratedPaths against a real repo", () => {
  test("bifrost with no flags resolves its own five rows plus catalog/**", () => {
    // The acceptance case: sourced from the repo's `.gitattributes`, not from a
    // hand-copied mirror. `catalog/**` is the one deliberate addition and comes
    // from the repo-keyed config entry, because it is true of bifrost alone.
    const r = resolveGeneratedPaths({
      repo: BIFROST,
      gitattributes: BIFROST_GITATTRIBUTES,
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    assert.equal(r.source, "gitattributes");
    assert.deepEqual(r.patterns.slice().sort(), [
      ".claude-plugin/**",
      "bundles/**",
      "catalog/**",
      "dist/**",
      "index.json",
      "vendor/**",
    ]);
    assert.deepEqual(r.added, ["catalog/**"]);
    assert.deepEqual(r.warnings, []);
    // bifrost's declared `index.json` is slash-less: git would match it by
    // basename at any depth, this tool anchors it at the repo root on purpose
    // (STARK-5637). Disclosed in the summary, never as a stderr warning — a
    // warning here would fire on EVERY bifrost run and advise `**/index.json`,
    // which is precisely what STARK-5637 refused.
    assert.deepEqual(r.rootAnchored, ["index.json"]);
  });

  test("a repo declaring a glob the built-in default lacks honors it with no flag", () => {
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: "gen/proto/** linguist-generated=true",
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    assert.deepEqual(r.patterns, ["gen/proto/**"]);
    assert.equal(matchGeneratedPath("gen/proto/api.pb.go", r.patterns), "gen/proto/**");
  });

  test("a repo with a hand-written root index.json keeps its inline thread", () => {
    // The bifrost-shaped default used to be applied to every repo, so a
    // hand-written `index.json` silently lost the thread its finding needed.
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: "gen/proto/** linguist-generated=true",
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    assert.equal(matchGeneratedPath("index.json", r.patterns), null);
    assert.equal(matchGeneratedPath("catalog/thing.yaml", r.patterns), null);
  });
});

describe("resolveGeneratedPaths fails open, never narrow", () => {
  test("an absent .gitattributes falls back and warns", () => {
    const r = resolveGeneratedPaths({ repo: "o/other", gitattributes: null, config: BARE_CONFIG });
    assert.equal(r.source, "default");
    assert.deepEqual(r.patterns, BARE_CONFIG.default);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /\.gitattributes is absent/);
  });

  test("an UNREADABLE .gitattributes says so, and says the fallback may be wrong", () => {
    // A 404 and a 403/rate-limit are both "no text", but only the second means
    // the repo may well declare paths this run never saw — so the bifrost-shaped
    // fallback may be the wrong list for it, which is the exact defect
    // STARK-6095 exists to kill. Degrading both the same way silently hides it.
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: null,
      gitattributesFailure: "gh api ... failed (exit 1): HTTP 403: API rate limit exceeded",
      config: BARE_CONFIG,
    });
    assert.equal(r.source, "default");
    assert.deepEqual(r.patterns, BARE_CONFIG.default);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /could not be read/);
    assert.match(r.warnings[0], /rate limit exceeded/);
    assert.match(r.warnings[0], /may not describe this repo/);
  });

  test("a non-array glob list in config is refused, never spread into char globs", () => {
    // `"default": "vendor/**"` passes a `.length` truthiness test and spreads
    // into ["v","e","n",...] — one-character globs that match nothing. That is a
    // silent disable of the split wearing a config typo's hat, which is the one
    // outcome this whole path exists to prevent.
    const r = resolveGeneratedPaths({
      repo: "o/r",
      gitattributes: null,
      config: {
        enabled: true,
        default: "vendor/**" as unknown as string[],
        repos: { "o/r": { paths: "catalog/**" as unknown as string[] } },
      },
    });
    assert.ok(!r.patterns.includes("v"), "a string default must not become char globs");
    assert.deepEqual(r.patterns, [...DEFAULT_GENERATED_PATHS]);
    assert.ok(r.warnings.some((w) => /generated_paths\.default must be an array/.test(w)));
    assert.ok(r.warnings.some((w) => /\.paths must be an array/.test(w)));
  });

  test("an explicit --generated-paths outranks a global enabled:false", () => {
    // enabled:false is a GLOBAL default; the CLI is documented as the highest
    // layer. Letting config silently win hands the operator an empty list —
    // every finding back on a gating thread — after they named globs by hand.
    const r = resolveGeneratedPaths({
      repo: "o/r",
      cliPaths: ["vendor/**"],
      config: { enabled: false, default: ["dist/**"], repos: {} },
    });
    assert.equal(r.source, "cli");
    assert.deepEqual(r.patterns, ["vendor/**"]);
    assert.ok(r.warnings.some((w) => /outranks it/.test(w)));
    // Without a flag, enabled:false still disables.
    const off = resolveGeneratedPaths({
      repo: "o/r",
      config: { enabled: false, default: ["dist/**"], repos: {} },
    });
    assert.equal(off.source, "disabled");
    assert.deepEqual(off.patterns, []);
  });

  test("--no-generated-split swallowing --add-generated-paths is never silent", () => {
    const r = resolveGeneratedPaths({ repo: "o/r", cliPaths: [], cliAdd: ["gen/**"] });
    assert.equal(r.source, "disabled");
    assert.deepEqual(r.patterns, []);
    assert.ok(r.warnings.some((w) => /--add-generated-paths \(gen\/\*\*\) was ignored/.test(w)));
  });

  test("a .gitattributes with no generated rows falls back and warns", () => {
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: "* text=auto eol=lf\n",
      config: BARE_CONFIG,
    });
    assert.equal(r.source, "default");
    assert.deepEqual(r.patterns, BARE_CONFIG.default);
    assert.match(r.warnings[0], /declares no linguist-generated=true paths/);
  });

  test("an empty configured default still resolves to the built-in list", () => {
    // Never an empty list by accident: an empty list IS a silent disable.
    const r = resolveGeneratedPaths({
      repo: "o/other",
      gitattributes: null,
      config: { enabled: true, default: [], repos: {} },
    });
    assert.deepEqual(r.patterns, [...DEFAULT_GENERATED_PATHS]);
    assert.ok(r.patterns.length > 0);
  });

  test("only an explicit disable yields an empty list", () => {
    const off = resolveGeneratedPaths({ repo: BIFROST, cliPaths: [], config: BARE_CONFIG });
    assert.deepEqual(off.patterns, []);
    assert.equal(off.source, "disabled");

    const configOff = resolveGeneratedPaths({
      repo: BIFROST,
      gitattributes: BIFROST_GITATTRIBUTES,
      config: { ...BARE_CONFIG, enabled: false },
    });
    assert.deepEqual(configOff.patterns, []);
    assert.equal(configOff.source, "disabled");
    assert.match(configOff.warnings[0], /enabled is false/);
  });
});

describe("resolveGeneratedPaths extend vs replace", () => {
  test("--add-generated-paths yields the resolved list PLUS the glob", () => {
    const r = resolveGeneratedPaths({
      repo: "o/other",
      cliAdd: ["extra/**"],
      gitattributes: BIFROST_GITATTRIBUTES,
      config: BARE_CONFIG,
    });
    assert.equal(r.source, "gitattributes");
    assert.ok(r.patterns.includes("dist/**"), "the resolved list survives");
    assert.ok(r.patterns.includes("extra/**"), "and the added glob is layered on");
    assert.deepEqual(r.added, ["extra/**"]);
  });

  test("--generated-paths yields EXACTLY the glob, repo add included out", () => {
    const r = resolveGeneratedPaths({
      repo: BIFROST,
      cliPaths: ["only/**"],
      gitattributes: BIFROST_GITATTRIBUTES,
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    assert.deepEqual(r.patterns, ["only/**"]);
    assert.deepEqual(r.added, []);
  });

  test("--add-generated-paths still extends an explicit --generated-paths", () => {
    const r = resolveGeneratedPaths({
      repo: BIFROST,
      cliPaths: ["only/**"],
      cliAdd: ["also/**"],
      config: DEFAULT_GENERATED_PATHS_CONFIG,
    });
    assert.deepEqual(r.patterns, ["only/**", "also/**"]);
  });

  test("a duplicate glob is layered once", () => {
    const r = resolveGeneratedPaths({
      repo: "o/other",
      cliAdd: ["dist/**"],
      gitattributes: BIFROST_GITATTRIBUTES,
      config: BARE_CONFIG,
    });
    assert.equal(r.patterns.filter((g) => g === "dist/**").length, 1);
  });

  test("every source value is one of the declared union members", () => {
    const sources: GeneratedPathsSource[] = ["disabled", "cli", "repo-config", "gitattributes", "default"];
    for (const r of [
      resolveGeneratedPaths({ repo: "o/r", cliPaths: [], config: BARE_CONFIG }),
      resolveGeneratedPaths({ repo: "o/r", cliPaths: ["a/**"], config: BARE_CONFIG }),
      resolveGeneratedPaths({ repo: "o/r", gitattributes: BIFROST_GITATTRIBUTES, config: BARE_CONFIG }),
      resolveGeneratedPaths({ repo: "o/r", gitattributes: null, config: BARE_CONFIG }),
    ]) {
      assert.ok(sources.includes(r.source));
    }
  });
});

describe("fetchGitattributes", () => {
  test("asks for the raw file and returns its text", () => {
    const calls: string[][] = [];
    const text = fetchGitattributes(BIFROST, (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: BIFROST_GITATTRIBUTES, stderr: "" };
    });
    assert.equal(text, BIFROST_GITATTRIBUTES);
    assert.deepEqual(calls, [[
      "gh", "api", `repos/${BIFROST}/contents/.gitattributes`,
      "-H", "Accept: application/vnd.github.raw",
    ]]);
  });

  test("a 404 (no .gitattributes) returns null rather than throwing", () => {
    const text = fetchGitattributes("o/none", () => ({ status: 1, stdout: "", stderr: "HTTP 404" }));
    assert.equal(text, null);
  });
});

describe("parseArgs --add-generated-paths", () => {
  const base = ["--repo", "o/r", "--pr", "1", "--findings", "-"];

  test("no flag means no explicit list and nothing added", () => {
    const a = parseArgs(base);
    assert.equal(a.generatedPathsExplicit, false);
    assert.deepEqual(a.addGeneratedPaths, []);
  });

  test("--generated-paths and --no-generated-split both mark the list explicit", () => {
    assert.equal(parseArgs([...base, "--generated-paths", "x/**"]).generatedPathsExplicit, true);
    assert.equal(parseArgs([...base, "--no-generated-split"]).generatedPathsExplicit, true);
  });

  test("--add-generated-paths collects globs without marking the list explicit", () => {
    const a = parseArgs([...base, "--add-generated-paths", "gen/**, out/**"]);
    assert.deepEqual(a.addGeneratedPaths, ["gen/**", "out/**"]);
    assert.equal(a.generatedPathsExplicit, false, "adding must not suppress .gitattributes");
  });

  test("repeated --add-generated-paths accumulate", () => {
    const a = parseArgs([...base, "--add-generated-paths", "a/**", "--add-generated-paths", "b/**"]);
    assert.deepEqual(a.addGeneratedPaths, ["a/**", "b/**"]);
  });

  test("an empty or flag-shaped value is refused, never a silent no-op", () => {
    assert.throws(() => parseArgs([...base, "--add-generated-paths", ""]), /at least one glob/);
    assert.throws(
      () => parseArgs([...base, "--add-generated-paths", "--dry-run"]),
      /requires a value, got the flag --dry-run/,
    );
  });
});

// --- shipped-config drift ----------------------------------------------------
// The default glob list used to exist three times: as a frozen constant in
// `findings_review_post.ts`, as `DEFAULT_GENERATED_PATHS_CONFIG.default`, and in
// `global/config.json`. The first two are now one (the constant is derived), but
// `global/config.json` is JSON and cannot import — so it is pinned instead. It
// is the list a FRESH plugin install reads, and a glob added to the TS default
// but not to it means that install silently re-opens a gating thread on that
// path, which is the one failure this whole split exists to prevent. Same
// pattern as `subagent_env_allowlist.test.ts`.
describe("global/config.json generated_paths stays in step with the TS default", () => {
  const shipped = (): { enabled?: unknown; default?: unknown; repos?: unknown } => {
    const raw = nodeFs.readFileSync(
      nodePathMod.join(import.meta.dirname, "..", "global", "config.json"),
      "utf8",
    );
    const cfg = JSON.parse(raw) as { generated_paths?: Record<string, unknown> };
    assert.ok(cfg.generated_paths, "global/config.json has no generated_paths section");
    return cfg.generated_paths as { enabled?: unknown; default?: unknown; repos?: unknown };
  };

  test("the shipped default list matches the TS default exactly", () => {
    assert.deepEqual(shipped().default, [...DEFAULT_GENERATED_PATHS_CONFIG.default]);
  });

  test("the shipped repo entries match the TS repo entries exactly", () => {
    assert.deepEqual(shipped().repos, DEFAULT_GENERATED_PATHS_CONFIG.repos);
  });

  test("the shipped section is enabled, like the TS default", () => {
    assert.equal(shipped().enabled, DEFAULT_GENERATED_PATHS_CONFIG.enabled);
  });
});
