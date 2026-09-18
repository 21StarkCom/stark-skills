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
import test from "node:test";

import { buildMarker, type Finding } from "./finding_lib.ts";
import {
  buildReviewBody,
  findExistingMarker,
  GhError,
  partitionInlineVsBody,
  postReview,
  renderAgentsResolvedSummary,
  selectPostingAgent,
  withRetry,
} from "./review_post_lib.ts";

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
