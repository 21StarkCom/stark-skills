// Tests for `tools/review_post_lib.ts`.
//
// Ported from the buried `stark_review.phase4.test.ts` / `stark_review.test.ts`
// when `/stark-review` was retired (STARK-6098). The dispatcher those suites
// exercised is gone, but the posting path they pinned is now the path
// `/code-review` findings travel on (`findings_review_post.ts`), so its two
// load-bearing guarantees keep their tests here:
//
//   - **No finding is ever dropped.** A 422 on an unanchorable inline comment
//     demotes that comment to the review body and retries; a second 422 demotes
//     every anchor. The finding survives either way.
//   - **A POST is never duplicated.** The retry wrapper re-reads the review
//     marker between attempts, so a successful-but-unacknowledged POST
//     short-circuits instead of posting twice.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";

import { buildMarker, type Finding } from "./finding_lib.ts";
import {
  BODY_REASON_HEADINGS,
  buildReviewBody,
  findExistingMarker,
  GhError,
  ghJsonOnce,
  OUT_OF_DIFF_HEADING,
  partitionInlineVsBody,
  postReview,
  renderAgentsResolvedSummary,
  selectPostingAgent,
  withRetry,
} from "./review_post_lib.ts";

/** Match a heading constant literally — they carry `/`, `.` and `—`. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "abc123",
    domain: "security",
    agent: "codex",
    severity: "high",
    file: "src/x.ts",
    line: 10,
    title: "title",
    body: "body",
    classification: "fix",
    ...over,
  };
}

// ─── partitionInlineVsBody ──────────────────────────────────────────────────

test("partitionInlineVsBody: classification!='fix' demoted to body, never dropped", () => {
  const findings: Finding[] = [
    makeFinding({ classification: "fix", severity: "high", file: "a.ts", line: 1 }),
    makeFinding({ id: "noise", classification: "noise", file: "a.ts", line: 2 }),
    makeFinding({ id: "off", classification: "fix", file: "x.ts", line: 1 }), // not in changed
    makeFinding({ id: "low", classification: "fix", severity: "low", file: "a.ts", line: 1 }), // below threshold
  ];
  const part = partitionInlineVsBody(findings, new Set(["a.ts"]), "medium");
  assert.equal(part.inline.length, 1);
  assert.equal(part.bodyFindings.length, 3);
});

test("partitionInlineVsBody: inline + body sorted critical → high → medium → low", () => {
  const findings: Finding[] = [
    makeFinding({ id: "f-low",  severity: "low",      file: "a.ts", line: 5, title: "low-a" }),
    makeFinding({ id: "f-crit", severity: "critical", file: "a.ts", line: 9, title: "crit-a" }),
    makeFinding({ id: "f-med",  severity: "medium",   file: "a.ts", line: 7, title: "med-a" }),
    makeFinding({ id: "f-high", severity: "high",     file: "a.ts", line: 2, title: "high-a" }),
    // body-side (different file, will demote)
    makeFinding({ id: "b-low",  severity: "low",      file: "x.ts", line: 1, title: "low-x" }),
    makeFinding({ id: "b-crit", severity: "critical", file: "x.ts", line: 1, title: "crit-x" }),
  ];
  const part = partitionInlineVsBody(findings, new Set(["a.ts"]), "low");
  assert.deepEqual(
    part.inline.map((c) => c.origin!.severity),
    ["critical", "high", "medium", "low"],
  );
  assert.deepEqual(
    part.bodyFindings.map((f) => f.severity),
    ["critical", "low"],
  );
});

// ─── buildReviewBody ────────────────────────────────────────────────────────

test("buildReviewBody: marker is the first line", () => {
  const marker = buildMarker(2, "codex", "abc");
  const body = buildReviewBody(marker, "summary", []);
  assert.ok(body.startsWith(marker));
  assert.match(body, /^<!-- stark-review:round=2:agent=codex:run=abc -->\n\nsummary/);
});

// ─── body-finding grouping by reason (STARK-6096) ───────────────────────────

test("buildReviewBody: out-of-diff findings live under the canonical heading", () => {
  // The class this heading was written about: findings with no anchor, and
  // findings whose file is not in the PR's diff. It must keep naming exactly
  // those, and nothing else.
  const body = buildReviewBody("MARKER", "summary", [
    makeFinding({ title: "unanchored", file: null, line: null }),
    makeFinding({ title: "outside the diff", file: "untouched.ts", line: 4 }),
  ]);
  assert.match(body, /## Cross-cutting \/ out-of-diff findings/);
  assert.match(body, /unanchored/);
  assert.match(body, /outside the diff/);
});

test("buildReviewBody: no body_reason renders byte-identically to the ungrouped form", () => {
  // The golden-output guard: every other caller passes findings with no reason,
  // and their reviews must not shift by a single byte.
  const findings = [
    makeFinding({ title: "one", file: "a.ts", line: 1, body: "why one" }),
    makeFinding({ title: "two", file: null, line: null, body: "why two" }),
  ];
  const expected = [
    "MARKER",
    "",
    "summary",
    "",
    "## Cross-cutting / out-of-diff findings",
    "",
    "- **high** [security] (a.ts:1) — one",
    "  why one",
    "- **high** [security] ((no anchor)) — two",
    "  why two",
  ].join("\n");
  assert.equal(buildReviewBody("MARKER", "summary", findings), expected);
});

test("buildReviewBody: generated-path findings do not sit under the out-of-diff heading", () => {
  // The defect: an in-diff finding on a real file and line, withheld from a
  // thread because its path is generated, filed under a heading that says it
  // was outside the diff — which reads as "out of scope".
  const body = buildReviewBody("MARKER", "summary", [
    makeFinding({ title: "gru drift", file: "vendor/stark-skills/tools/gru.ts", line: 11, body_reason: "generated_path" }),
  ]);
  assert.doesNotMatch(body, /out-of-diff/);
  assert.match(body, /## Findings on generated paths — withheld from inline threads/);
  assert.match(body, /vendor\/stark-skills\/tools\/gru\.ts:11/);
});

test("buildReviewBody: the generated heading claims neither in-diff nor out-of-diff", () => {
  // A reviewer can report a finding on a generated file the PR never touched,
  // so the heading spans both cases and may assert neither. Saying "in-diff"
  // over an entry whose own note reads "outside this PR's diff" is the same
  // class of falsehood STARK-6096 fixed, pointing the other way.
  assert.doesNotMatch(BODY_REASON_HEADINGS.generated_path, /\bin-diff\b/i);
  assert.doesNotMatch(BODY_REASON_HEADINGS.generated_path, /out-of-diff/i);
});

test("buildReviewBody: an unrecognised body_reason keeps its finding in the body", () => {
  // The no-drop guarantee outranks the grouping. A label this build does not
  // know degrades to the unlabelled group; it must never form a heading-less
  // group that the render loop skips, deleting the finding from the review.
  const body = buildReviewBody("MARKER", "summary", [
    // Cast: the point of the test is a value the union does not admit, which is
    // what any older/newer caller or hand-written payload can still supply.
    makeFinding({ title: "from the future", body_reason: "future_reason" as never }),
  ]);
  assert.match(body, /— from the future/);
  assert.match(body, new RegExp(escapeRe(OUT_OF_DIFF_HEADING)));
});

test("buildReviewBody: a mixed body renders both headings with each finding exactly once", () => {
  const body = buildReviewBody("MARKER", "summary", [
    makeFinding({ title: "classic", file: null, line: null }),
    makeFinding({ title: "generated", file: "dist/x.js", line: 3, body_reason: "generated_path" }),
    makeFinding({ title: "classic two", file: "untouched.ts", line: 9 }),
  ]);
  assert.match(body, new RegExp(escapeRe(OUT_OF_DIFF_HEADING)));
  assert.match(body, new RegExp(escapeRe(BODY_REASON_HEADINGS.generated_path)));
  for (const title of ["classic", "generated", "classic two"]) {
    const hits = body.split("\n").filter((l) => l.endsWith(`— ${title}`)).length;
    assert.equal(hits, 1, `${title} must appear exactly once`);
  }
  // Each finding sits under its own heading, not merely somewhere in the body.
  const outIdx = body.indexOf(OUT_OF_DIFF_HEADING);
  const genIdx = body.indexOf(BODY_REASON_HEADINGS.generated_path);
  // Labelled first: the generated-path preamble lives in `humanSummary`, above
  // every group, and says "each is listed below" — it must not be separated
  // from the findings it introduces by an unrelated group.
  assert.ok(genIdx < outIdx, "labelled group renders directly under the preamble");
  assert.ok(body.indexOf("— generated") < outIdx, "generated findings stay above the out-of-diff heading");
  assert.ok(body.indexOf("— classic two") > outIdx, "classic findings sit under their own heading");
});

test("renderAgentsResolvedSummary: emits per-domain agent list", () => {
  const out = renderAgentsResolvedSummary({
    security: "claude", "test-coverage": "codex", architecture: "gemini",
  });
  assert.match(out, /## agents_resolved/);
  assert.match(out, /`security` → `claude`/);
  assert.match(out, /`test-coverage` → `codex`/);
  assert.match(out, /`architecture` → `gemini`/);
});

test("buildReviewBody: includes agents_resolved summary for mixed resolved-agent runs", () => {
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "claude", "test-coverage": "codex" },
  });
  assert.match(body, /## agents_resolved/);
  assert.match(body, /security.*claude/s);
  assert.match(body, /test-coverage.*codex/s);
});

test("buildReviewBody: includes agents_resolved when one agent yields zero findings", () => {
  // Mixed agents but an empty body-findings list — the per-domain summary is
  // what makes a mixed run debuggable from the posted review alone, so it must
  // not be conditioned on any agent having produced findings.
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "claude", "test-coverage": "codex" },
  });
  assert.match(body, /## agents_resolved/, "must show even when no findings span agents");
});

test("buildReviewBody: omits agents_resolved for single-agent runs", () => {
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "codex", "test-coverage": "codex" },
  });
  assert.doesNotMatch(body, /## agents_resolved/);
});

test("buildReviewBody: rendering is back-compatible without agentsResolved", () => {
  const body = buildReviewBody("MARKER", "summary", []);
  assert.match(body, /^MARKER\n\nsummary/);
  assert.doesNotMatch(body, /agents_resolved/);
});

test("selectPostingAgent: majority wins; ties broken by lexicographic order", () => {
  const findings = (agents: string[]): Finding[] =>
    agents.map((a, i) => ({
      id: String(i), domain: "d",
      agent: a as Finding["agent"],
      severity: "low", file: null, line: null,
      title: "t", body: "",
    }));
  assert.equal(selectPostingAgent(findings(["codex", "codex", "claude"])), "codex");
  // tie: claude / codex (one each) — lexicographic 'claude' < 'codex'
  assert.equal(selectPostingAgent(findings(["codex", "claude"])), "claude");
  assert.equal(selectPostingAgent([]), null);
});

// ─── postReview: the no-drop 422 fallback ───────────────────────────────────

test("postReview: 422 first retry demotes specific indices, then body-only", async () => {
  const findings: Finding[] = [
    makeFinding({ classification: "fix", severity: "high", file: "a.ts", line: 1 }),
    makeFinding({ id: "id2", classification: "fix", severity: "high", file: "a.ts", line: 2 }),
  ];
  let post = 0;
  const ghMock = async (_p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    post++;
    if (post === 1) {
      throw new GhError(422, JSON.stringify({ errors: [{ index: 0, message: "comments[0] line not in diff" }] }), {});
    }
    if (post === 2) {
      throw new GhError(422, JSON.stringify({ errors: [{ index: 0, message: "still bad" }] }), {});
    }
    return { status: 200, data: { id: 999 }, headers: {} };
  };
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings, changedFiles: new Set(["a.ts"]), fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "deadbeef", dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });
  assert.equal(post, 3);
  assert.equal(r.posted, true);
  assert.equal(r.fallbacksApplied, 2);
  assert.ok(
    r.attempts.some((a) => a.status === "body_only"),
    "expected a body_only attempt in the trail",
  );
  assert.equal(r.attempts.at(-1)!.status, "ok");
});

test("postReview: a demoted anchor keeps its finding in the review body", async () => {
  // The whole point of the fallback: the anchor is what GitHub rejected, not
  // the finding. Body text must still carry the rejected finding's title.
  const findings: Finding[] = [
    makeFinding({ id: "kept", title: "unanchorable but real", file: "a.ts", line: 1 }),
  ];
  let bodySeen = "";
  let post = 0;
  const ghMock = async (_p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    post++;
    if (post === 1) throw new GhError(422, "line must be part of the diff", {});
    bodySeen = (opts.body as { body: string }).body;
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings, changedFiles: new Set(["a.ts"]), fixThreshold: "low",
    humanSummary: "s", prHeadSha: "sha", dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });
  assert.equal(r.posted, true);
  assert.match(bodySeen, /unanchorable but real/);
});

test("postReview: a 422-demoted finding loses its body_reason label", async () => {
  // `body_reason` records why a finding was routed to the body up front. This
  // one is in the body because GitHub rejected its anchor — the unlabelled
  // class — so carrying the label over would file it under a heading naming a
  // different reason.
  const findings: Finding[] = [
    makeFinding({ id: "kept", title: "rejected anchor", file: "a.ts", line: 1, body_reason: "generated_path" }),
  ];
  let bodySeen = "";
  let post = 0;
  const ghMock = async (_p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    post++;
    if (post === 1) throw new GhError(422, "line must be part of the diff", {});
    bodySeen = (opts.body as { body: string }).body;
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings, changedFiles: new Set(["a.ts"]), fixThreshold: "low",
    humanSummary: "s", prHeadSha: "sha", dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });
  assert.equal(r.posted, true);
  assert.match(bodySeen, /rejected anchor/, "the finding still reaches the body");
  assert.ok(
    bodySeen.includes(OUT_OF_DIFF_HEADING),
    "a rejected anchor is the unlabelled class",
  );
  assert.ok(
    !bodySeen.includes(BODY_REASON_HEADINGS.generated_path),
    "the pre-posting label must not survive the demotion",
  );
});

test("postReview: --dry-run skips POST and records payload summary", async () => {
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings: [makeFinding({ classification: "fix" })],
    changedFiles: new Set(["src/x.ts"]), fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "abc", dryRun: true,
  });
  assert.equal(r.posted, false);
  assert.equal(r.payloadSummary.inlineCount, 1);
});

test("postReview: retry exhaustion surfaces as unposted rather than throwing", async () => {
  const ghMock = async (_p: string, opts?: { method?: string }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    throw new GhError(500, "server on fire", {});
  };
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]),
    fixThreshold: "low", humanSummary: "s", prHeadSha: "sha", dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
    retryFn: ((fn: () => Promise<unknown>) => fn()) as Parameters<typeof postReview>[0]["retryFn"],
  });
  assert.equal(r.posted, false);
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason ?? "", /^http_500/);
});

// ─── Retry policy ───────────────────────────────────────────────────────────

test("withRetry: backs off 1/4/16s for 5xx and gives up after 3", async () => {
  let calls = 0;
  const slept: number[] = [];
  const sleepFn = async (ms: number) => { slept.push(ms); };
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new GhError(500, "boom", {});
  }, { sleepFn }));
  assert.equal(calls, 4); // initial + 3 retries
  assert.deepEqual(slept, [1000, 4000, 16000]);
});

test("withRetry: honors Retry-After (numeric seconds)", async () => {
  const slept: number[] = [];
  const sleepFn = async (ms: number) => { slept.push(ms); };
  await assert.rejects(withRetry(async () => {
    throw new GhError(429, "rate", { "retry-after": "7" });
  }, { sleepFn, attempts: 2 }));
  assert.equal(slept[0], 7000);
});

test("withRetry: 4xx (non-rate) does not retry", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new GhError(404, "nope", {});
  }));
  assert.equal(calls, 1);
});

test("withRetry: beforeRetry stopReason short-circuits as success", async () => {
  let calls = 0;
  const sleepFn = async () => {};
  const r = await withRetry<unknown>(async () => {
    calls++;
    throw new GhError(500, "boom", {});
  }, {
    sleepFn,
    beforeRetry: async () => ({ stopReason: "marker_found" }),
  });
  assert.equal(calls, 1);
  assert.equal(r, undefined);
});

// ─── Marker idempotency ─────────────────────────────────────────────────────

test("findExistingMarker: matches review whose body starts with marker", async () => {
  const marker = buildMarker(1, "codex", "h");
  const ghMock = async () => ({
    status: 200,
    data: [{ body: `${marker}\n\nhello` }, { body: "unrelated" }],
    headers: {},
  });
  const found = await findExistingMarker({
    repo: "o/r", pr: 1, marker,
    ghJsonFn: ghMock as Parameters<typeof findExistingMarker>[0]["ghJsonFn"],
  });
  assert.equal(found, true);
});

test("findExistingMarker: a review merely CONTAINING the marker does not match", async () => {
  const marker = buildMarker(1, "codex", "h");
  const ghMock = async () => ({
    status: 200,
    data: [{ body: `quoting a previous run: ${marker}` }],
    headers: {},
  });
  const found = await findExistingMarker({
    repo: "o/r", pr: 1, marker,
    ghJsonFn: ghMock as Parameters<typeof findExistingMarker>[0]["ghJsonFn"],
  });
  assert.equal(found, false);
});

// ─── ghJsonOnce: a terminated `gh` names its cause (STARK-6112) ─────────────
//
// Driven through a REAL fake `gh` on PATH rather than an injected spawn seam:
// the defect lived in how a signal kill crosses `spawnCollect` → `ghJsonOnce`,
// and a seam would let that mapping rot while the test stayed green.

/** Run `fn` with a throwaway `gh` shell script first on PATH. */
async function withFakeGh(script: string, fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(nodePath.join(dir, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${nodePath.delimiter}${prevPath ?? ""}`;
  try {
    await fn();
  } finally {
    // Assigning `undefined` to an env var stores the STRING "undefined".
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ghJsonOnce: a gh killed before writing stderr names the signal, not a bare 'failed:'", async () => {
  await withFakeGh("kill -TERM $$", async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), (err: unknown) => {
      assert.ok(err instanceof GhError);
      assert.equal(err.status, -1);
      assert.doesNotMatch(err.message, /failed:\s*$/);
      assert.match(err.message, /terminated: killed by signal SIGTERM/);
      // `postReview` builds `unpostedReason` from `err.body`, never the message —
      // so the body is what actually reaches the operator on the posting path.
      assert.match(err.body, /terminated: killed by signal SIGTERM/);
      return true;
    });
  });
});

test("ghJsonOnce: the termination cause precedes a chatty child's stderr and survives the 400-char slice", async () => {
  // 600 chars of noise: a cause appended AFTER it would be sliced away.
  const noise = "w".repeat(600);
  await withFakeGh(`printf '%s' '${noise}' >&2\nkill -KILL $$`, async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), (err: unknown) => {
      assert.ok(err instanceof GhError);
      const cause = err.message.indexOf("killed by signal SIGKILL");
      const own = err.message.indexOf("www");
      assert.ok(cause >= 0, `cause missing from: ${err.message}`);
      assert.ok(own > cause, "child stderr must FOLLOW the cause");
      return true;
    });
  });
});

test("ghJsonOnce: a gh killed mid-paginate is a failure, never a truncated 200", async () => {
  // One complete page reached stdout before the kill. Parsed alone it is a
  // valid 200 with one review — silently missing every later page.
  const page = 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[{"id":1}]';
  await withFakeGh(`printf '${page}'\nkill -KILL $$`, async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), /killed by signal SIGKILL/);
  });
});

test("ghJsonOnce: a normal non-zero exit keeps the child's own stderr and names the exit code", async () => {
  await withFakeGh("echo 'gh: connection refused' >&2\nexit 7", async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), (err: unknown) => {
      assert.ok(err instanceof GhError);
      assert.match(err.message, /failed: gh exited 7: gh: connection refused/);
      assert.doesNotMatch(err.message, /terminated/);
      assert.match(err.body, /^gh exited 7: gh: connection refused/);
      return true;
    });
  });
});

test("ghJsonOnce: a gh killed before draining a large POST body names the signal, not an EPIPE crash", async () => {
  // The posting path is the one that writes stdin. A body larger than the pipe
  // buffer is still queued when the child dies, so the write fails with EPIPE
  // on `child.stdin` — an unlistened stream error is an uncaught exception that
  // kills the whole tool before `close` can report the cause.
  const body = { body: "x".repeat(4 * 1024 * 1024) };
  await withFakeGh("kill -KILL $$", async () => {
    await assert.rejects(
      ghJsonOnce("/repos/o/r/pulls/1/reviews", { method: "POST", body }),
      (err: unknown) => {
        assert.ok(err instanceof GhError, `expected GhError, got: ${String(err)}`);
        assert.match(err.body, /killed by signal SIGKILL/);
        return true;
      },
    );
  });
});

test("ghJsonOnce: a gh that EXITS non-zero mid-paginate is a failure, never a truncated 200", async () => {
  // Same truncation as the signal kill, reached by a plain exit: page 1 landed,
  // page 2 died at the transport (no HTTP block to parse), gh exited 1.
  const page = 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[{"id":1}]';
  await withFakeGh(`printf '${page}'\necho 'gh: connection reset by peer' >&2\nexit 1`, async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), (err: unknown) => {
      assert.ok(err instanceof GhError);
      assert.equal(err.status, -1);
      assert.match(err.body, /^gh exited 1 after a partial 2xx response: gh: connection reset by peer/);
      return true;
    });
  });
});

test("ghJsonOnce: an HTTP error behind gh's exit 1 keeps its real status and body", async () => {
  // The partial-2xx guard keys on the exit code, and gh exits 1 on every HTTP
  // error too. A 422 must still arrive as a 422 with GitHub's body intact — it
  // is the no-drop fallback's only input.
  const resp = 'HTTP/2.0 422 Unprocessable Entity\\r\\n\\r\\n{"errors":[{"index":0}]}';
  await withFakeGh(`printf '${resp}'\necho 'gh: HTTP 422' >&2\nexit 1`, async () => {
    await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/reviews"), (err: unknown) => {
      assert.ok(err instanceof GhError);
      assert.equal(err.status, 422);
      assert.equal(err.body, '{"errors":[{"index":0}]}');
      return true;
    });
  });
});

// ─── ghJsonOnce: a hung `gh` is bounded (STARK-6113) ────────────────────────

/**
 * `node:test` has no default timeout, and the regression these tests exist to
 * catch is a call that NEVER settles — so without this a broken bound stalls
 * the suite (and the required `test` check) instead of failing it. Measured:
 * the settle-on-`close` mutant hung indefinitely before this was added.
 */
const HANG_GUARD = { timeout: 30_000 };

/** Assert a timeout rejection that names the bound, and that it came promptly. */
async function assertTimesOut(p: Promise<unknown>, ms: number): Promise<void> {
  const started = Date.now();
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof GhError);
    assert.equal(err.status, -1, "a timeout must stay non-retriable");
    assert.match(err.message, new RegExp(`timed out after ${ms} ms`));
    assert.match(err.body, new RegExp(`timed out after ${ms} ms`), "postReview reads err.body");
    return true;
  });
  assert.ok(Date.now() - started < 10_000, "the hung gh was not bounded");
}

test("ghJsonOnce: a hung gh is bounded, and the error names the timeout and its value", HANG_GUARD, async () => {
  await withFakeGh("exec sleep 20", async () => {
    await assertTimesOut(ghJsonOnce("/repos/o/r/pulls/1/files", { timeoutMs: 300 }), 300);
  });
});

test("ghJsonOnce: the bound holds when a GRANDCHILD keeps gh's pipes open", HANG_GUARD, async () => {
  // No `exec`: `sleep` is a grandchild that inherits stdout/stderr. Killing the
  // shell alone leaves the pipes open, so a settle that waits for `close` would
  // hang for as long as the grandchild lives — the bound in name only.
  await withFakeGh("sleep 20", async () => {
    await assertTimesOut(ghJsonOnce("/repos/o/r/pulls/1/files", { timeoutMs: 300 }), 300);
  });
});

test("ghJsonOnce: a timed-out gh with a complete page on stdout is a failure, never a truncated 200", HANG_GUARD, async () => {
  const page = 'HTTP/2.0 200 OK\\r\\n\\r\\n[{"id":1}]';
  await withFakeGh(`printf '${page}'\nexec sleep 20`, async () => {
    await assertTimesOut(ghJsonOnce("/repos/o/r/pulls/1/files", { timeoutMs: 300 }), 300);
  });
});

test("ghJsonOnce: STARK_GH_TIMEOUT_MS overrides the default bound; an unusable value is refused before spawning", HANG_GUARD, async () => {
  const prev = process.env.STARK_GH_TIMEOUT_MS;
  try {
    process.env.STARK_GH_TIMEOUT_MS = "300";
    await withFakeGh("exec sleep 20", async () => {
      await assertTimesOut(ghJsonOnce("/repos/o/r/pulls/1/files"), 300);
    });
    process.env.STARK_GH_TIMEOUT_MS = "0";
    await withFakeGh("exec sleep 20", async () => {
      await assert.rejects(ghJsonOnce("/repos/o/r/pulls/1/files"), /STARK_GH_TIMEOUT_MS must be/);
    });
  } finally {
    if (prev === undefined) delete process.env.STARK_GH_TIMEOUT_MS;
    else process.env.STARK_GH_TIMEOUT_MS = prev;
  }
});

test("ghJsonOnce: a gh that finishes inside the bound leaves no timer holding the process open", async () => {
  const page = 'HTTP/2.0 200 OK\\r\\n\\r\\n[{"id":1}]';
  await withFakeGh(`printf '${page}'`, async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    // 5 s, not the production 120 s: if the timer ever leaks again, the suite
    // lingers 5 s and fails here — instead of stalling for the full bound.
    await ghJsonOnce("/repos/o/r/pulls/1/reviews", { timeoutMs: 5_000 });
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.equal(after, before, "the bound's timer outlived the call it bounded");
  });
});

test("ghJsonOnce: a healthy gh still parses (the fake-gh harness itself works)", async () => {
  const page = 'HTTP/2.0 200 OK\\r\\n\\r\\n[{"id":1}]';
  await withFakeGh(`printf '${page}'`, async () => {
    const r = await ghJsonOnce("/repos/o/r/pulls/1/reviews");
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, [{ id: 1 }]);
  });
});
