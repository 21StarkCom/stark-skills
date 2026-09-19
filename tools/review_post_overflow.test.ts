// Tests for `postReview`'s oversize-review-body degrade (STARK-6094).
//
// Before this, an over-cap body 422'd on `body is too long` carrying no
// `errors[].index`, so `extract422Indices` returned `[]`, the no-drop fallback
// folded the remaining inline comments into that SAME body, retried it *larger*,
// 422'd again and reported `unposted` — every finding lost, not one. The only
// protection was a refusal in `findings_review_post.ts`, which posted nothing
// and covered no other caller.
//
// The degrade: the highest-severity body findings that fit stay in the review
// body, the rest are posted in full as follow-up issue comments on the same PR
// and cross-linked from the body. Nothing is dropped, truncated or summarized.
//
// These live in their own file rather than `review_post_lib.test.ts` so the
// concurrent work on that suite does not have to merge around them.

import { strict as assert } from "node:assert";
import test from "node:test";

import { buildMarker, type Finding } from "./finding_lib.ts";
import {
  buildReviewBody,
  GhError,
  GITHUB_ISSUE_COMMENT_MAX,
  GITHUB_REVIEW_BODY_MAX,
  overflowLinkFor,
  partitionInlineVsBody,
  planBodySplit,
  postReview,
  renderOverflowComment,
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

/** Body findings big enough to blow the cap, each uniquely identifiable. The
 * files are deliberately absent from `changedFiles`, which is what routes them
 * to the shared review body — the exact shape the generated-path split
 * (STARK-5637) made common. */
function oversizeBodyFindings(n: number, chars = 9_000): Finding[] {
  return Array.from({ length: n }, (_, i) =>
    makeFinding({
      id: `big${i}`,
      title: `OVERSIZE-FINDING-${i}`,
      body: `marker-${i} ` + "x".repeat(chars),
      file: `out/of/diff-${i}.ts`,
      line: i + 1,
    }),
  );
}

/** A `gh` mock that records every POST body, split by endpoint. */
function recordingGh() {
  const reviews: string[] = [];
  const comments: string[] = [];
  let commentId = 500;
  const gh = async (p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    const body = (opts.body as { body: string }).body;
    if (p.includes("/issues/")) {
      commentId++;
      comments.push(body);
      return {
        status: 201,
        data: {
          id: commentId,
          html_url: `https://github.com/o/r/pull/5#issuecomment-${commentId}`,
        },
        headers: {},
      };
    }
    reviews.push(body);
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  return { gh, reviews, comments };
}

type GhFn = Parameters<typeof postReview>[0]["ghJsonFn"];

const BASE = {
  repo: "o/r",
  pr: 5,
  round: 1,
  agent: "codex" as const,
  runHash: "h",
  fixThreshold: "low" as const,
  humanSummary: "s",
  prHeadSha: "sha",
};

test("the caps are named constants pinned to GitHub's documented limits", () => {
  assert.equal(GITHUB_REVIEW_BODY_MAX, 65536);
  assert.equal(GITHUB_ISSUE_COMMENT_MAX, 65536);
});

test("postReview: an over-cap body still posts, and every finding stays reachable", async () => {
  const findings = oversizeBodyFindings(12);
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: false,
    ghJsonFn: gh as GhFn,
  });

  assert.equal(r.posted, true, "the review must land, not 422 into nothing");
  assert.equal(r.unposted, undefined);
  assert.equal(reviews.length, 1);
  assert.ok(comments.length > 0, "expected at least one overflow comment");

  // Nothing dropped and nothing truncated: every finding's unique title AND its
  // full body text is reachable somewhere on the PR.
  const reachable = `${reviews.join("\n")}\n${comments.join("\n")}`;
  for (const f of findings) {
    assert.ok(reachable.includes(f.title), `${f.title} unreachable on the PR`);
    assert.ok(reachable.includes(f.body), `${f.title}'s body was truncated`);
  }

  // The review body is under the cap and cross-links every overflow comment.
  assert.ok(
    reviews[0].length <= GITHUB_REVIEW_BODY_MAX,
    `review body was ${reviews[0].length} chars, over the ${GITHUB_REVIEW_BODY_MAX} cap`,
  );
  for (const id of r.bodyOverflowComments!) {
    assert.ok(reviews[0].includes(`#issuecomment-${id}`), `body does not link comment ${id}`);
  }
  assert.equal(r.bodyOverflowComments!.length, comments.length);
  assert.equal(r.bodyOverflow!.cap, GITHUB_REVIEW_BODY_MAX);
  assert.equal(
    r.bodyOverflow!.findingsInBody + r.bodyOverflow!.findingsInOverflow,
    findings.length,
    "findings in must equal findings reachable",
  );
});

test("postReview: every overflow comment fits under the issue-comment cap", async () => {
  const findings = oversizeBodyFindings(60, 4_000);
  const { gh, comments } = recordingGh();
  await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: false,
    ghJsonFn: gh as GhFn,
  });
  assert.ok(comments.length > 1, "expected the overflow to span several comments");
  for (const c of comments) {
    assert.ok(c.length <= GITHUB_ISSUE_COMMENT_MAX, `overflow comment was ${c.length} chars`);
  }
});

test("postReview: an absurd html_url is clamped, so the body stays under the cap", async () => {
  // The footer reserve is only an upper bound if a link line cannot exceed it.
  // A returned `html_url` longer than the reserve is discarded in favour of the
  // canonical #issuecomment link, whose length GitHub's own owner/repo name
  // limits bound. Without the clamp the body renders over the cap and 422s
  // exactly as before — and it cannot be repaired by moving findings out, since
  // each one moved adds a whole new link line.
  //
  // Small findings pack the body prefix tight against the cap, so the footer
  // reserve — not a 9 KB finding boundary — is what the links must fit inside.
  const findings = oversizeBodyFindings(250, 300);
  const reviews: string[] = [];
  let commentId = 0;
  const gh = async (p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    if (p.includes("/issues/")) {
      commentId++;
      return {
        status: 201,
        data: { id: commentId, html_url: `https://github.example/${"u".repeat(900)}#c${commentId}` },
        headers: {},
      };
    }
    reviews.push((opts.body as { body: string }).body);
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: false,
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, true);
  assert.ok(
    reviews[0].length <= GITHUB_REVIEW_BODY_MAX,
    `review body was ${reviews[0].length} chars, over the ${GITHUB_REVIEW_BODY_MAX} cap`,
  );
  assert.equal(
    r.bodyOverflow!.findingsInBody + r.bodyOverflow!.findingsInOverflow,
    findings.length,
    "clamping a link must not lose a finding",
  );
  assert.ok(!reviews[0].includes("u".repeat(900)), "the absurd url must not be rendered");
  assert.match(reviews[0], /#issuecomment-1\b/, "the canonical link is used instead");
});

test("overflowLinkFor: keeps a sane html_url, falls back for a missing or absurd one", () => {
  assert.equal(
    overflowLinkFor("o/r", 5, 42, "https://github.com/o/r/pull/5#issuecomment-42"),
    "https://github.com/o/r/pull/5#issuecomment-42",
  );
  assert.equal(overflowLinkFor("o/r", 5, 42, undefined), "https://github.com/o/r/pull/5#issuecomment-42");
  assert.equal(overflowLinkFor("o/r", 5, undefined, ""), "https://github.com/o/r/pull/5#issuecomment-unknown");
  assert.equal(
    overflowLinkFor("o/r", 5, 42, `https://x/${"u".repeat(900)}`),
    "https://github.com/o/r/pull/5#issuecomment-42",
  );
  // The canonical link is bounded by GitHub's own owner (39) + repo (100) limits.
  const worst = overflowLinkFor(`${"o".repeat(39)}/${"r".repeat(100)}`, 999999, 99999999999, undefined);
  assert.ok(worst.length + 64 <= 320, `worst-case canonical link was ${worst.length} chars`);
});

test("postReview: the overflow split is deterministic for a fixed payload", async () => {
  const findings = oversizeBodyFindings(12);
  const run = async () => {
    const { gh, reviews, comments } = recordingGh();
    const r = await postReview({
      ...BASE,
      findings,
      changedFiles: new Set<string>(),
      dryRun: false,
      ghJsonFn: gh as GhFn,
    });
    return { reviews, comments, split: r.bodyOverflow };
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a.split, b.split);
  assert.deepEqual(a.comments, b.comments);
  assert.deepEqual(a.reviews, b.reviews);
});

test("postReview: a payload under the cap is byte-identical to the plain build", async () => {
  const findings = [
    makeFinding({ id: "b1", file: "out/x.ts", line: 3, title: "t1" }),
    makeFinding({ id: "b2", file: "out/y.ts", line: 4, title: "t2" }),
  ];
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: false,
    ghJsonFn: gh as GhFn,
  });
  const expected = buildReviewBody(
    buildMarker(1, "codex", "h"),
    "s",
    partitionInlineVsBody(findings, new Set<string>(), "low").bodyFindings,
  );
  assert.equal(reviews[0], expected, "under the cap the body must not change at all");
  assert.equal(comments.length, 0, "no overflow comment for a payload that fits");
  assert.equal(r.bodyOverflow, undefined);
  assert.equal(r.bodyOverflowComments, undefined);
});

test("postReview: dry-run reports the overflow split without posting anything", async () => {
  const findings = oversizeBodyFindings(12);
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: true,
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, false);
  assert.equal(reviews.length, 0);
  assert.equal(comments.length, 0);
  assert.ok(r.bodyOverflow!.chunks > 0);
  assert.equal(
    r.bodyOverflow!.findingsInBody + r.bodyOverflow!.findingsInOverflow,
    findings.length,
  );
});

test("postReview: a 422-fallback rebuild reuses overflow comments, never duplicating them", async () => {
  // The anchor fallback rebuilds the body with the demoted findings. That must
  // not re-post the overflow chunks it already created on the PR.
  const findings: Finding[] = [
    ...oversizeBodyFindings(12),
    makeFinding({ id: "anchored", file: "a.ts", line: 1, title: "ANCHORED" }),
  ];
  const { gh, reviews, comments } = recordingGh();
  let reviewPosts = 0;
  const flaky = async (p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method === "POST" && !p.includes("/issues/")) {
      reviewPosts++;
      if (reviewPosts === 1) throw new GhError(422, "line must be part of the diff", {});
    }
    return await gh(p, opts);
  };
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set(["a.ts"]),
    dryRun: false,
    ghJsonFn: flaky as GhFn,
  });
  assert.equal(r.posted, true);
  assert.equal(reviews.length, 1, "exactly one review landed");
  assert.equal(new Set(comments).size, comments.length, "no duplicate overflow comment bodies");
  assert.equal(r.bodyOverflowComments!.length, comments.length);
  const reachable = `${reviews.join("\n")}\n${comments.join("\n")}`;
  assert.ok(reachable.includes("ANCHORED"), "the demoted finding survived the rebuild");
  for (const f of findings) assert.ok(reachable.includes(f.title), `${f.title} was lost`);
});

test("postReview: a failed overflow comment reports unposted instead of losing findings", async () => {
  const findings = oversizeBodyFindings(12);
  let reviewPosts = 0;
  const gh = async (p: string, opts?: { method?: string }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    if (p.includes("/issues/")) throw new GhError(403, "no write access", {});
    reviewPosts++;
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    ...BASE,
    findings,
    changedFiles: new Set<string>(),
    dryRun: false,
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, false);
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason!, /overflow_comment_failed/);
  assert.equal(reviewPosts, 0, "a review missing its overflow links must not be posted");
});

test("planBodySplit: severity order decides what stays in the body", () => {
  const findings = [
    makeFinding({ id: "c", severity: "critical", title: "CRIT", body: "z".repeat(30_000) }),
    makeFinding({ id: "h", severity: "high", title: "HIGH", body: "z".repeat(30_000) }),
    makeFinding({ id: "l", severity: "low", title: "LOW", body: "z".repeat(30_000) }),
  ];
  // Input is pre-sorted severity-desc by partitionInlineVsBody; planBodySplit
  // keeps the longest prefix that fits, so the lowest severities overflow.
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), findings, "M");
  assert.deepEqual(plan.kept.map((f) => f.title), ["CRIT", "HIGH"]);
  assert.deepEqual(plan.chunks.flat().map((f) => f.title), ["LOW"]);
});

test("planBodySplit: a single over-cap finding gets its own chunk rather than truncation", () => {
  const huge = makeFinding({ id: "huge", title: "HUGE", body: "y".repeat(80_000), file: "o/x.ts" });
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  assert.equal(plan.kept.length, 0);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].length, 1);
  assert.ok(renderOverflowComment("M", 1, plan.chunks[0]).includes("y".repeat(80_000)));
});
