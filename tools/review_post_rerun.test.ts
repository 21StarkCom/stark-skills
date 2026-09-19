// review_post_rerun.test.ts — postReview is idempotent across RUNS (STARK-6125).
//
// The marker-aware retry only re-reads the marker BETWEEN attempts of one run.
// A run whose POST landed but was reported `unposted` (gh signal-killed after a
// complete 2xx, or our own timeout kill) is followed by an operator rerun, and a
// fresh run that never looks at the PR first double-posts. These tests pin the
// up-front check: marker found → nothing is written, of any kind; and the
// overflow comments a truly failed run left behind are adopted, not re-posted.
//
// Run with:
//   node --test tools/review_post_rerun.test.ts

import { strict as assert } from "node:assert";
import test from "node:test";

import { buildMarker, type Finding } from "./finding_lib.ts";
import { computeRunHash } from "./findings_review_post.ts";
import { GhError, overflowPartOf, postReview, renderOverflowChunk, renderOverflowComment, withRetry } from "./review_post_lib.ts";

type GhFn = Parameters<typeof postReview>[0]["ghJsonFn"];
type GhOpts = { method?: string; body?: unknown };

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

/** Enough body findings to overflow the review-body cap into issue comments. */
function oversizeBodyFindings(n: number, chars = 9_000): Finding[] {
  return Array.from({ length: n }, (_, i) =>
    makeFinding({ id: `big${i}`, title: `big ${i}`, file: `gen/f${i}.ts`, body: "x".repeat(chars) }),
  );
}

const BASE = {
  repo: "o/r",
  pr: 5,
  round: 1,
  agent: "codex" as const,
  runHash: "h",
  fixThreshold: "low" as const,
  humanSummary: "s",
  prHeadSha: "sha",
  dryRun: false,
};
const MARKER = buildMarker(BASE.round, BASE.agent, BASE.runHash);

/** A fake PR: serves the reviews + issue-comments lists and records every write. */
function fakePr(seed: { reviews?: Array<{ id: number; body: string }>; failReviewPost?: boolean } = {}) {
  const reviews = [...(seed.reviews ?? [])];
  const comments: Array<{ id: number; body: string; html_url: string }> = [];
  const writes: string[] = [];
  let nextId = 500;
  const gh = async (p: string, opts?: GhOpts) => {
    const method = opts?.method ?? "GET";
    if (method === "GET") {
      if (p.endsWith("/pulls/5/reviews")) return { status: 200, data: reviews, headers: {} };
      if (p.endsWith("/issues/5/comments")) return { status: 200, data: comments, headers: {} };
      return { status: 200, data: [], headers: {} };
    }
    writes.push(`${method} ${p}`);
    const body = (opts!.body as { body: string }).body;
    if (method === "PATCH") {
      const id = Number(p.split("/").pop());
      comments.find((c) => c.id === id)!.body = body;
      return { status: 200, data: { id }, headers: {} };
    }
    if (p.includes("/issues/")) {
      const id = ++nextId;
      const html_url = `https://github.com/o/r/pull/5#issuecomment-${id}`;
      comments.push({ id, body, html_url });
      return { status: 201, data: { id, html_url }, headers: {} };
    }
    if (seed.failReviewPost) throw new GhError(500, "boom", {});
    const id = ++nextId;
    reviews.push({ id, body });
    return { status: 200, data: { id }, headers: {} };
  };
  return { gh: gh as GhFn, reviews, comments, writes };
}

const noRetry = (async (fn: () => Promise<unknown>) => fn()) as Parameters<typeof postReview>[0]["retryFn"];

test("a rerun against a PR already carrying the marker posts nothing and says so", async () => {
  const pr = fakePr({ reviews: [{ id: 77, body: `${MARKER}\n\nearlier run` }] });
  const r = await postReview({
    ...BASE, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]), ghJsonFn: pr.gh,
  });
  assert.deepEqual(pr.writes, [], "the review is already on the PR — nothing may be written");
  assert.equal(r.alreadyPosted, true);
  assert.equal(r.posted, true);
  assert.equal(r.unposted, undefined);
  assert.equal(r.reviewId, 77);
  assert.deepEqual(r.attempts, [], "no POST was attempted, so the trail records none");
});

test("the skip covers overflow comments too — before the first POST of ANY kind", async () => {
  const pr = fakePr({ reviews: [{ id: 77, body: `${MARKER}\n\nearlier run` }] });
  const r = await postReview({
    ...BASE, findings: oversizeBodyFindings(12), changedFiles: new Set<string>(), ghJsonFn: pr.gh,
  });
  assert.equal(r.alreadyPosted, true);
  assert.deepEqual(pr.writes, []);
});

test("a marker for a DIFFERENT run does not suppress this one", async () => {
  const pr = fakePr({ reviews: [{ id: 77, body: `${buildMarker(1, "codex", "other")}\n\nx` }] });
  const r = await postReview({
    ...BASE, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]), ghJsonFn: pr.gh,
  });
  assert.deepEqual(pr.writes, ["POST /repos/o/r/pulls/5/reviews"]);
  assert.equal(r.alreadyPosted, undefined);
  assert.equal(r.posted, true);
});

test("an unreadable reviews list refuses to post rather than risk a double-post", async () => {
  let writes = 0;
  const gh = async (_p: string, opts?: GhOpts) => {
    if ((opts?.method ?? "GET") !== "GET") {
      writes++;
      return { status: 200, data: { id: 2 }, headers: {} };
    }
    throw new GhError(502, "bad gateway", {});
  };
  const r = await postReview({
    ...BASE, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]), ghJsonFn: gh as GhFn,
  });
  assert.equal(writes, 0);
  assert.equal(r.posted, false);
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason ?? "", /^marker_check_failed: http_502: bad gateway/);
});

test("a 2xx reviews list that is not an array is unreadable, not empty — refuse", async () => {
  let writes = 0;
  const gh = async (_p: string, opts?: GhOpts) => {
    if ((opts?.method ?? "GET") !== "GET") {
      writes++;
      return { status: 200, data: { id: 2 }, headers: {} };
    }
    return { status: 200, data: null, headers: {} };
  };
  const r = await postReview({
    ...BASE, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]), ghJsonFn: gh as GhFn,
  });
  assert.equal(writes, 0, "'no marker' read out of a body that said nothing is the double-post");
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason ?? "", /^marker_check_failed: .*reviews list of o\/r#5 was not a JSON array/);
});

test("the up-front read and the between-retries read compose: a POST that lands on a 5xx is sent once", async () => {
  const pr = fakePr();
  let reviewPosts = 0;
  const gh = async (p: string, opts?: GhOpts) => {
    if (opts?.method === "POST" && p.endsWith("/pulls/5/reviews")) {
      reviewPosts++;
      // Landed, but the acknowledgement was lost.
      pr.reviews.push({ id: 88, body: (opts.body as { body: string }).body });
      throw new GhError(502, "bad gateway", {});
    }
    return pr.gh!(p, opts as never);
  };
  const r = await postReview({
    ...BASE, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]), ghJsonFn: gh as GhFn,
    retryFn: ((fn, o) => withRetry(fn, { ...o, sleepFn: async () => {} })) as typeof withRetry,
  });
  assert.equal(reviewPosts, 1, "the marker re-read must stop the retry");
  assert.equal(r.posted, true);
  assert.equal(r.reviewId, 88, "the stop names the review it found, as a rerun would");
  assert.equal(r.unposted, undefined);
  assert.equal(r.alreadyPosted, undefined, "THIS run sent it — the up-front read saw an empty PR");
});

test("dryRun never reads the PR", async () => {
  let calls = 0;
  const gh = async () => {
    calls++;
    return { status: 200, data: [], headers: {} };
  };
  await postReview({
    ...BASE, dryRun: true, findings: [makeFinding()], changedFiles: new Set(["src/x.ts"]),
    ghJsonFn: gh as GhFn,
  });
  assert.equal(calls, 0);
});

test("a rerun after the review POST truly failed adopts the overflow comments already on the PR", async () => {
  const findings = oversizeBodyFindings(12);
  const pr = fakePr({ failReviewPost: true });
  const r1 = await postReview({
    ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: pr.gh, retryFn: noRetry,
  });
  assert.equal(r1.unposted, true);
  const orphaned = pr.comments.map((c) => c.id);
  assert.ok(orphaned.length > 0, "fixture must leave orphaned overflow comments behind");

  // Same PR state, review POST now healthy.
  const rerun = fakePr();
  rerun.comments.push(...pr.comments);
  const r2 = await postReview({
    ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: rerun.gh,
  });
  assert.equal(r2.posted, true);
  assert.deepEqual(
    rerun.writes,
    ["POST /repos/o/r/pulls/5/reviews"],
    "identical chunks are reused: no second comment, no rewrite",
  );
  assert.deepEqual(r2.bodyOverflowComments, orphaned);
  for (const id of orphaned) assert.ok(rerun.reviews[0].body.includes(`#issuecomment-${id}`));
});

test("an adopted slot whose content changed is edited in place, never duplicated", async () => {
  const findings = oversizeBodyFindings(12);
  const rerun = fakePr();
  rerun.comments.push({
    id: 900,
    body: renderOverflowComment(MARKER, 1, [makeFinding({ title: "stale chunk" })]),
    html_url: "https://github.com/o/r/pull/5#issuecomment-900",
  });
  const r = await postReview({
    ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: rerun.gh,
  });
  assert.equal(r.posted, true);
  assert.equal(rerun.writes[0], "PATCH /repos/o/r/issues/comments/900");
  assert.ok(!rerun.comments.find((c) => c.id === 900)!.body.includes("stale chunk"));
});

for (const [name, listing] of [
  ["fails", () => { throw new GhError(502, "bad gateway", {}); }],
  ["is a 2xx that is not an array", () => ({ status: 200, data: null, headers: {} })],
] as const) {
  test(`an issue-comments listing that ${name} fails the run instead of re-posting every chunk`, async () => {
    const pr = fakePr();
    const gh = async (p: string, opts?: GhOpts) => {
      if ((opts?.method ?? "GET") === "GET" && p.endsWith("/issues/5/comments")) return listing();
      return pr.gh!(p, opts as never);
    };
    const r = await postReview({
      ...BASE, findings: oversizeBodyFindings(12), changedFiles: new Set<string>(), ghJsonFn: gh as GhFn,
    });
    assert.deepEqual(pr.writes, [], "unknown is not 'no comments': nothing may be written");
    assert.equal(r.posted, false);
    assert.equal(r.unposted, true);
    assert.match(r.unpostedReason ?? "", /^overflow_comment_failed: /);
  });
}

test("two comments claiming one slot: the first is adopted, the duplicate is left alone", async () => {
  const findings = oversizeBodyFindings(12);
  const first = fakePr();
  await postReview({ ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: first.gh });
  const part1 = first.comments[0];

  const rerun = fakePr();
  rerun.comments.push(
    { ...part1, id: 910, html_url: "https://github.com/o/r/pull/5#issuecomment-910" },
    // A pre-STARK-6125 rerun's duplicate of the same slot, stale on top.
    {
      id: 911,
      body: renderOverflowComment(MARKER, 1, [makeFinding({ title: "stale duplicate" })]),
      html_url: "https://github.com/o/r/pull/5#issuecomment-911",
    },
    ...first.comments.slice(1),
  );
  const r = await postReview({ ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: rerun.gh });
  assert.deepEqual(rerun.writes, ["POST /repos/o/r/pulls/5/reviews"], "last-match-wins would PATCH 911");
  assert.equal(r.bodyOverflowComments?.[0], 910);
  assert.ok(!rerun.reviews[0].body.includes("#issuecomment-911"));
});

test("an adopted slot past this plan's chunk count is neither linked nor reported", async () => {
  const findings = oversizeBodyFindings(12);
  const first = fakePr();
  const r1 = await postReview({ ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: first.gh });
  const chunks = r1.bodyOverflowComments!.length;

  const rerun = fakePr();
  rerun.comments.push(...first.comments, {
    id: 990,
    body: renderOverflowComment(MARKER, chunks + 1, [makeFinding({ title: "from a larger split" })]),
    html_url: "https://github.com/o/r/pull/5#issuecomment-990",
  });
  const r2 = await postReview({ ...BASE, findings, changedFiles: new Set<string>(), ghJsonFn: rerun.gh });
  assert.deepEqual(r2.bodyOverflowComments, r1.bodyOverflowComments, "990 is not part of this review");
  assert.equal(r2.bodyOverflow?.chunks, chunks);
  assert.ok(!rerun.reviews[0].body.includes("#issuecomment-990"));
});

test("computeRunHash: identical payloads share a marker, and nothing else does", () => {
  const four = ["a", "b", "c", "d"].map((t) => makeFinding({ id: `${t}`.repeat(12), title: t }));
  const base = computeRunHash(four, "s", "sha1");
  assert.equal(base, computeRunHash(structuredClone(four), "s", "sha1"));
  assert.match(base, /^[0-9a-f]{40}$/);
  // The old hash was the ids joined and cut at 40 chars = the first three. A
  // payload differing only in its FOURTH finding shared the marker, which the
  // up-front skip would turn into a swallowed review.
  assert.notEqual(base, computeRunHash(four.slice(0, 3), "s", "sha1"));
  // Ids derive from titles alone, so the body and the anchor must count too.
  assert.notEqual(base, computeRunHash([{ ...four[0], body: "new" }, ...four.slice(1)], "s", "sha1"));
  assert.notEqual(base, computeRunHash([{ ...four[0], line: 11 }, ...four.slice(1)], "s", "sha1"));
  assert.notEqual(base, computeRunHash([{ ...four[0], file: "src/y.ts" }, ...four.slice(1)], "s", "sha1"));
  assert.notEqual(base, computeRunHash([{ ...four[0], severity: "low" }, ...four.slice(1)], "s", "sha1"));
  assert.notEqual(
    base,
    computeRunHash([{ ...four[0], body_reason: "generated_path" }, ...four.slice(1)], "s", "sha1"),
    "the same finding filed under a different heading is a different review body",
  );
  assert.notEqual(base, computeRunHash(four, "s", "sha2"), "a new head is a new review");
  assert.notEqual(base, computeRunHash(four, "other summary", "sha1"));
});

test("overflowPartOf reads back exactly what renderOverflowComment wrote", () => {
  const body = renderOverflowComment(MARKER, 3, [makeFinding()]);
  assert.equal(overflowPartOf(MARKER, body), 3);
  assert.equal(overflowPartOf(buildMarker(1, "codex", "other"), body), null, "another run's comment");
  assert.equal(overflowPartOf(MARKER, `${MARKER}\n\na review body, not an overflow comment`), null);
  assert.equal(overflowPartOf(MARKER, `quoted:\n${body}`), null, "the marker must open the comment");
});

test("overflowPartOf recognises segment comments too, or a rerun re-posts every segment", () => {
  const summary = renderOverflowChunk(MARKER, 2, {
    findings: [],
    segment: { of: "summary", index: 1, total: 2, text: "t" },
  });
  const finding = renderOverflowChunk(MARKER, 4, {
    findings: [],
    segment: { of: "finding", finding: makeFinding(), index: 2, total: 3, text: "t" },
  });
  assert.equal(overflowPartOf(MARKER, summary), 2);
  assert.equal(overflowPartOf(MARKER, finding), 4);
});
