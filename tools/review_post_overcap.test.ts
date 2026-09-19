// Tests for the two payload shapes `postReview`'s oversize-body degrade
// (STARK-6094) could not shrink, because neither is fixed by MOVING findings
// (STARK-6116):
//
//   1. ONE finding larger than an issue comment. `chunkOverflow` gave it its own
//      chunk "rather than truncation" — and that comment then 422'd on
//      `body is too long`, `syncOverflowSlot` caught it, and `postReview`
//      returned `unposted` with the review never posted: every finding in the
//      run lost to protect one.
//   2. A review body whose NON-finding parts (`humanSummary`, …) are already
//      over the cap. `planBodySplit` kept 0 findings and the body was still too
//      big → 422 with no `errors[].index` → the no-drop fallback folded the
//      inline comments into that same body → larger → 422 → `unposted`.
//
// The invariant both fixes hold is STARK-6094's: the review lands, and every
// byte of every finding is reachable from the PR. Nothing is dropped, and
// nothing is cut without the continuation being posted right next to it.

import { strict as assert } from "node:assert";
import test from "node:test";

import { buildMarker, type Finding } from "./finding_lib.ts";
import {
  buildReviewBody,
  countOverflowFindings,
  GhError,
  GITHUB_ISSUE_COMMENT_MAX,
  GITHUB_REVIEW_BODY_MAX,
  OVERFLOW_SEGMENT_DELIMITER,
  overflowPartOf,
  planBodySplit,
  postReview,
  relocatedSummaryStub,
  renderOverflowChunk,
  segmentChunks,
  splitTextToFit,
} from "./review_post_lib.ts";

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "abc123",
    domain: "security",
    agent: "codex",
    severity: "high",
    file: "out/of/diff.ts",
    line: 10,
    title: "title",
    body: "body",
    classification: "fix",
    ...over,
  };
}

/** Records every POST by endpoint; every issue comment gets a real id + url. */
function recordingGh() {
  const reviews: string[] = [];
  const comments: string[] = [];
  let commentId = 900;
  const gh = async (p: string, opts?: { method?: string; body?: unknown }) => {
    const method = opts?.method ?? "GET";
    if (method !== "POST" && method !== "PATCH") return { status: 200, data: [], headers: {} };
    const body = (opts!.body as { body: string }).body;
    // Enforce the cap the way GitHub does — a mock that accepts anything would
    // let an over-cap comment "post" and hide the very failure under test.
    if (body.length > GITHUB_REVIEW_BODY_MAX) {
      throw new GhError(422, '{"message":"Validation Failed","errors":[{"message":"body is too long (maximum is 65536 characters)"}]}', {});
    }
    if (p.includes("/issues/")) {
      commentId++;
      comments.push(body);
      return {
        status: 201,
        data: { id: commentId, html_url: `https://github.com/o/r/pull/5#issuecomment-${commentId}` },
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
  changedFiles: new Set<string>(),
  dryRun: false,
};

/** The text a segment comment carries, i.e. everything after its header. */
function segmentText(comment: string): string {
  const at = comment.indexOf(OVERFLOW_SEGMENT_DELIMITER);
  assert.ok(at >= 0, `not a segment comment: ${comment.slice(0, 120)}`);
  return comment.slice(at + OVERFLOW_SEGMENT_DELIMITER.length);
}

/** A body with line structure and a unique token per line, so a dropped,
 * duplicated or reordered span cannot reassemble to the original. */
function structuredText(chars: number): string {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; n < chars; i++) {
    const line = `line-${i}: ${"x".repeat(60)}`;
    lines.push(line);
    n += line.length + 1;
  }
  return lines.join("\n");
}

/** Exactly what `buildReviewBody` would have rendered for this one finding. */
function renderedFinding(f: Finding): string {
  const full = buildReviewBody("M", "s", [f]);
  return full.slice(full.indexOf(`- **${f.severity}**`));
}

// ─── Shape 1: one finding larger than an issue comment ──────────────────────

test("postReview: a single ~70 KB finding still posts the review, and every byte of it is reachable", async () => {
  const huge = makeFinding({ id: "huge", title: "HUGE-FINDING", body: structuredText(70_000) });
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({ ...BASE, findings: [huge], ghJsonFn: gh as GhFn });

  assert.equal(r.unposted, undefined, `unposted: ${r.unpostedReason}`);
  assert.equal(r.posted, true);
  assert.equal(reviews.length, 1, "the review itself must land");
  assert.ok(reviews[0].length <= GITHUB_REVIEW_BODY_MAX);
  assert.ok(comments.length >= 2, "a 70 KB finding needs at least two comments");
  for (const c of comments) {
    assert.ok(c.length <= GITHUB_ISSUE_COMMENT_MAX, `a continuation comment is ${c.length} chars — it would 422`);
  }
  assert.equal(
    comments.map(segmentText).join(""),
    renderedFinding(huge),
    "the segments, read in order, must reproduce the finding byte-for-byte",
  );
  // Every comment is linked from the review body — reachable, not just posted.
  for (let i = 0; i < comments.length; i++) {
    assert.match(reviews[0], new RegExp(`issuecomment-${901 + i}\\b`));
  }
});

test("postReview: each continuation says which segment it is, of how many, and of which finding", async () => {
  const huge = makeFinding({ id: "huge", title: "HUGE-FINDING", body: structuredText(140_000) });
  const { gh, comments } = recordingGh();
  await postReview({ ...BASE, findings: [huge], ghJsonFn: gh as GhFn });
  assert.ok(comments.length >= 3);
  comments.forEach((c, i) => {
    const header = c.slice(0, c.indexOf(OVERFLOW_SEGMENT_DELIMITER));
    assert.match(header, new RegExp(`segment ${i + 1} of ${comments.length}\\b`));
    assert.match(header, /HUGE-FINDING/, "a reader landing on segment 3 must learn which finding it belongs to");
  });
});

test("postReview: an over-cap finding does not take the findings around it down with it", async () => {
  const before = makeFinding({ id: "b", severity: "critical", title: "SMALL-CRITICAL", body: "small critical body" });
  const huge = makeFinding({ id: "huge", severity: "high", title: "HUGE-FINDING", body: structuredText(70_000) });
  const after = makeFinding({ id: "a", severity: "low", title: "SMALL-LOW", body: "small low body" });
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({ ...BASE, findings: [before, huge, after], ghJsonFn: gh as GhFn });

  assert.equal(r.posted, true, `unposted: ${r.unpostedReason}`);
  const everything = [reviews[0], ...comments].join("\n");
  for (const needle of ["SMALL-CRITICAL", "small critical body", "SMALL-LOW", "small low body", "HUGE-FINDING"]) {
    assert.ok(everything.includes(needle), `${needle} is not reachable from the PR`);
  }
  assert.ok(reviews[0].includes("SMALL-CRITICAL"), "the highest-severity finding that fits stays in the body");
  assert.equal(r.bodyOverflow!.findingsInBody + r.bodyOverflow!.findingsInOverflow, 3, "every finding counted once");
});

test("planBodySplit: an over-cap finding is segmented to fit, never truncated and never left over the cap", () => {
  const huge = makeFinding({ id: "huge", title: "HUGE", body: structuredText(80_000) });
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  assert.equal(plan.kept.length, 0);
  assert.ok(plan.chunks.length >= 2);
  plan.chunks.forEach((chunk, i) => {
    assert.ok(chunk.segment, "an over-cap finding travels as segments");
    assert.equal(chunk.segment!.index, i + 1);
    assert.equal(chunk.segment!.total, plan.chunks.length);
    assert.ok(renderOverflowChunk("M", i + 1, chunk).length <= GITHUB_ISSUE_COMMENT_MAX);
  });
  assert.equal(plan.chunks.map((c) => c.segment!.text).join(""), renderedFinding(huge));
});

test("planBodySplit: segments prefer a line boundary, so a reader is not handed half a line", () => {
  const huge = makeFinding({ id: "huge", title: "HUGE", body: structuredText(80_000) });
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  for (const chunk of plan.chunks.slice(0, -1)) {
    assert.ok(chunk.segment!.text.endsWith("\n"), "a non-final segment should end at a newline when one is in reach");
  }
});

test("planBodySplit: a text with NO line breaks is still segmented, and never splits a surrogate pair", () => {
  // 40k emoji = 80k UTF-16 units and not one newline: the hard-cut path, where
  // a cut at an odd offset would strand half a code point in each comment.
  const huge = makeFinding({ id: "huge", title: "HUGE", body: "😀".repeat(40_000) });
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  assert.ok(plan.chunks.length >= 2);
  for (const chunk of plan.chunks) {
    const t = chunk.segment!.text;
    assert.ok(!/[\uD800-\uDBFF]$/.test(t), "segment ends on a lone high surrogate");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(t), "segment starts on a lone low surrogate");
  }
  assert.equal(plan.chunks.map((c) => c.segment!.text).join(""), renderedFinding(huge));
});

test("splitTextToFit: an ODD budget over surrogate pairs backs off one unit instead of splitting a pair", () => {
  // The planBodySplit emoji test above can pass by luck — its cut lands on an
  // even offset whenever the header length happens to be even (the surrogate
  // mutant survived it). Budget 7 over 2-unit code points forces the odd cut.
  const text = "😀".repeat(50);
  const parts = splitTextToFit(text, 7);
  assert.equal(parts.join(""), text);
  for (const p of parts) {
    assert.ok(p.length <= 7);
    assert.ok(!/[\uD800-\uDBFF]$/.test(p), `segment ends on a lone high surrogate: ${JSON.stringify(p)}`);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p), `segment starts on a lone low surrogate: ${JSON.stringify(p)}`);
  }
});

test("splitTextToFit: text that fits is returned whole, and the empty string is one empty part", () => {
  assert.deepEqual(splitTextToFit("abc", 10), ["abc"]);
  assert.deepEqual(splitTextToFit("", 10), [""]);
  assert.deepEqual(splitTextToFit("abcdef", 3), ["abc", "def"]);
});

// ─── Shape 2: the non-finding body is already over the cap ──────────────────

test("postReview: a ~70 KB humanSummary still posts the review, with the full summary and every finding reachable", async () => {
  const summary = structuredText(70_000);
  const findings = [
    makeFinding({ id: "f1", severity: "critical", title: "FINDING-ONE", body: "first body" }),
    makeFinding({ id: "f2", severity: "low", title: "FINDING-TWO", body: "second body" }),
  ];
  const { gh, reviews, comments } = recordingGh();
  const r = await postReview({ ...BASE, humanSummary: summary, findings, ghJsonFn: gh as GhFn });

  assert.equal(r.unposted, undefined, `unposted: ${r.unpostedReason}`);
  assert.equal(r.posted, true);
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].length <= GITHUB_REVIEW_BODY_MAX, `body is ${reviews[0].length} chars`);
  for (const c of comments) assert.ok(c.length <= GITHUB_ISSUE_COMMENT_MAX);

  const summarySegments = comments.filter((c) => /review summary/i.test(c.slice(0, c.indexOf(OVERFLOW_SEGMENT_DELIMITER))));
  assert.ok(summarySegments.length >= 1, "the full summary must be posted somewhere");
  assert.equal(summarySegments.map(segmentText).join(""), summary, "the summary must be reproduced in full");

  const everything = [reviews[0], ...comments].join("\n");
  for (const needle of ["FINDING-ONE", "first body", "FINDING-TWO", "second body"]) {
    assert.ok(everything.includes(needle), `${needle} is not reachable from the PR`);
  }
  // The body must SAY the summary continues elsewhere — a silently shortened
  // summary is the truncation this whole path exists to avoid.
  assert.match(reviews[0], /summary.*(continues|in full)/is);
  assert.ok(reviews[0].includes("line-0:"), "the body keeps the head of the summary");
});

test("postReview: a relocated summary with inline comments does not enter the 422 fold-and-grow loop", async () => {
  // The original failure needed no body findings at all: the over-cap body 422'd
  // with no index, and the fallback folded the INLINE comments into it.
  const summary = structuredText(70_000);
  const inline = makeFinding({ id: "in", title: "INLINE-FINDING", file: "changed.ts", line: 3 });
  const { gh, reviews } = recordingGh();
  const r = await postReview({
    ...BASE,
    humanSummary: summary,
    findings: [inline],
    changedFiles: new Set(["changed.ts"]),
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, true, `unposted: ${r.unpostedReason}`);
  assert.equal(r.fallbacksApplied, 0, "an in-cap body must post first time, with its inline comment intact");
  assert.equal(reviews.length, 1);
});

test("postReview: a summary under the cap is never relocated (byte-identical body)", async () => {
  const summary = structuredText(20_000);
  const { gh, reviews, comments } = recordingGh();
  const f = makeFinding({ id: "f1", title: "FINDING-ONE" });
  await postReview({ ...BASE, humanSummary: summary, findings: [f], ghJsonFn: gh as GhFn });
  assert.equal(comments.length, 0);
  assert.equal(reviews[0], buildReviewBody(buildMarker(1, "codex", "h"), summary, [f]));
});

test("postReview: a non-finding body that is over the cap even WITHOUT its summary is refused by name, before any POST", async () => {
  // Nothing here can be moved: not findings, not the summary. The old path
  // 422'd, folded, grew and 422'd again; the honest outcome is one named refusal.
  let posts = 0;
  const gh = async (_p: string, opts?: { method?: string }) => {
    if (opts?.method === "POST" || opts?.method === "PATCH") posts++;
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    ...BASE,
    postingAgentNote: "n".repeat(70_000),
    findings: [makeFinding({ id: "f1", title: "FINDING-ONE" })],
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, false);
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason!, /body_over_cap_without_findings/);
  assert.equal(posts, 0, "no overflow comment may be posted for a review that cannot land");
});

// ─── Review findings on STARK-6116 itself ───────────────────────────────────

test("planBodySplit: a finding that fits alone only at the CURRENT part number is not posted one char over at the next", () => {
  // `chunkOverflow` sized a finding against the part number of the chunk being
  // built. When that chunk is non-empty the finding lands in the NEXT one, and
  // 9 → 10 adds a digit: a finding at exactly the cap became cap + 1 → 422 →
  // the whole run `unposted`.
  const cap = 3000;
  const findings: Finding[] = [];
  for (let i = 0; i < 9; i++) findings.push(makeFinding({ id: `s${i}`, title: `S${i}`, body: "z".repeat(2700) }));
  let n = 2600;
  const exactAt9 = () => makeFinding({ id: "e", title: "E", body: "e".repeat(n) });
  while (renderOverflowChunk("M", 9, { findings: [exactAt9()] }).length < cap) n++;
  assert.equal(renderOverflowChunk("M", 9, { findings: [exactAt9()] }).length, cap, "fixture: exactly at the cap as part 9");
  findings.push(makeFinding({ id: "tiny", title: "tiny", body: "q" }), exactAt9());

  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), findings, "M", 4500, cap);
  assert.ok(plan.chunks.length >= 10, "fixture: the exact-fit finding must land past the digit rollover");
  plan.chunks.forEach((chunk, i) => {
    const len = renderOverflowChunk("M", i + 1, chunk).length;
    assert.ok(len <= cap, `overflow comment ${i + 1} is ${len} chars against a ${cap}-char cap — it would 422`);
  });
  assert.equal(countOverflowFindings(plan.chunks) + plan.kept.length, findings.length, "every finding counted once");
});

test("postReview: a footer that links ONLY the relocated summary does not claim the comments carry findings", async () => {
  // Every finding fits in the body once the summary is out, so the linked
  // comments hold the summary and nothing else. "carry the remaining findings"
  // there is a false statement in the one place a reader is told where to look.
  const { gh, reviews } = recordingGh();
  const r = await postReview({
    ...BASE,
    humanSummary: structuredText(70_000),
    findings: [makeFinding({ id: "f1", title: "FINDING-ONE" })],
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.bodyOverflow!.findingsInOverflow, 0, "fixture: no finding left the body");
  const footer = reviews[0].slice(reviews[0].indexOf("## Overflow findings"));
  assert.doesNotMatch(footer, /carry the remaining findings/);
  assert.match(footer, /carry the review summary in full/);
});

test("postReview: a footer linking the relocated summary AND overflow findings says which comments are which", async () => {
  const { gh, reviews } = recordingGh();
  const r = await postReview({
    ...BASE,
    humanSummary: structuredText(70_000),
    findings: [makeFinding({ id: "huge", title: "HUGE", body: structuredText(70_000) })],
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.posted, true, `unposted: ${r.unpostedReason}`);
  const footer = reviews[0].slice(reviews[0].indexOf("## Overflow findings"));
  assert.match(footer, /carry the review summary \(overflow 1–2\) and the remaining findings in full/);
});

test("relocatedSummaryStub: a head cut inside a code fence is closed, so the pointer and links still render", () => {
  // An unclosed fence swallows everything after it — the pointer, the findings
  // and the overflow links — into one code block, where links are not links.
  const summary = `intro\n\n\`\`\`ts\n${"const x = 1; // filler\n".repeat(4000)}\`\`\`\n\nend`;
  const stub = relocatedSummaryStub(summary);
  const fences = stub.split("\n").filter((l) => /^`{3,}/.test(l));
  assert.equal(fences.length % 2, 0, `the stub leaves a code fence open: ${fences.length} fence line(s)`);
  assert.ok(stub.indexOf("```", stub.indexOf("```ts") + 1) < stub.indexOf("_…the review summary"), "closed BEFORE the pointer");
  // A head with no fence, or a balanced one, is left exactly as it was.
  const plain = relocatedSummaryStub(structuredText(10_000));
  assert.ok(!plain.includes("```"));
});

test("planBodySplit: a segment header clips a long title without stranding half a surrogate pair", () => {
  const title = `${"x".repeat(199)}😀tail`;
  const huge = makeFinding({ id: "huge", title, body: structuredText(70_000) });
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  const comment = renderOverflowChunk("M", 1, plan.chunks[0]);
  const header = comment.slice(0, comment.indexOf(OVERFLOW_SEGMENT_DELIMITER));
  assert.doesNotMatch(header, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "header carries a lone high surrogate");
});

test("planBodySplit: an unfittable plan reports the floor it measured, footer reserve included", () => {
  // `unfittable` is "non-finding body + the link footer for every overflow
  // comment > cap". The refusal used to report the body alone, so a payload the
  // FOOTER pushed over read as "310 chars against a 65536-char cap".
  const findings = Array.from({ length: 6 }, (_, i) => makeFinding({ id: `m${i}`, title: `M${i}`, body: "z".repeat(2700) }));
  const plan = planBodySplit((kept) => buildReviewBody("M", "s", kept), findings, "M", 1500, 3000);
  assert.equal(plan.unfittable, true);
  assert.ok(plan.floorChars! > 1500, `floorChars ${plan.floorChars} must be the over-cap number the refusal names`);
  assert.ok(buildReviewBody("M", "s", []).length < 1500, "fixture: the body alone is under the cap");
});

test("postReview: a 422-fallback rebuild that tips the body over relocates the summary and still lands", async () => {
  // First pass fits with no overflow at all; the demoted anchor is what pushes
  // the body over, with a summary too big for moving findings to fix.
  const summary = "S".repeat(65_300);
  const inline = makeFinding({ id: "in", title: "INLINE-FINDING", file: "changed.ts", line: 3, body: "inline body ".repeat(40) });
  const { gh, reviews, comments } = recordingGh();
  let rejected = false;
  const rejectAnchorOnce = async (p: string, o?: { method?: string; body?: unknown }) => {
    if (o?.method === "POST" && p.endsWith("/reviews") && !rejected) {
      rejected = true;
      throw new GhError(422, '{"message":"Unprocessable","errors":[{"field":"comments/0","message":"x"}]}', {});
    }
    return gh(p, o);
  };
  const r = await postReview({
    ...BASE,
    humanSummary: summary,
    findings: [inline],
    changedFiles: new Set(["changed.ts"]),
    ghJsonFn: rejectAnchorOnce as GhFn,
  });
  assert.equal(r.posted, true, `unposted: ${r.unpostedReason}`);
  assert.equal(r.bodyOverflow!.summaryRelocated, true);
  assert.ok(reviews[0].length <= GITHUB_REVIEW_BODY_MAX);
  assert.ok(reviews[0].includes("INLINE-FINDING"), "the demoted finding keeps the body");
  assert.equal(comments.map(segmentText).join(""), summary, "the summary is reproduced in full");
});

test("postReview: dry-run reports a relocated summary and a segmented finding without posting", async () => {
  let calls = 0;
  const gh = async () => { calls++; return { status: 200, data: [], headers: {} }; };
  const r = await postReview({
    ...BASE,
    dryRun: true,
    humanSummary: structuredText(70_000),
    findings: [makeFinding({ id: "huge", title: "HUGE", body: structuredText(70_000) })],
    ghJsonFn: gh as GhFn,
  });
  assert.equal(calls, 0);
  assert.equal(r.bodyOverflow!.summaryRelocated, true);
  assert.equal(r.bodyOverflow!.findingsInOverflow, 1, "a segmented finding is ONE finding, not one per segment");
  assert.ok(r.bodyOverflow!.chunks >= 4);
});

// ─── Review findings on STARK-6245 ──────────────────────────────────────────

test("a refusal reports the floor of the plan that would actually be used, not a relocation that never happened", async () => {
  // Relocating the summary costs OVERFLOW_PREAMBLE_RESERVE + OVERFLOW_LINK_RESERVE
  // of extra footer, so when the floor is blown by `postingAgentNote` the second
  // plan is refused too — and reporting ITS numbers tells the operator to
  // shorten by an amount that was never the real one, over a body whose summary
  // was never actually moved. The refusal must describe the un-relocated plan.
  const summary = structuredText(20_000);
  const note = "n".repeat(70_000);
  let posts = 0;
  const gh = async (_p: string, opts?: { method?: string }) => {
    if (opts?.method === "POST" || opts?.method === "PATCH") posts++;
    return { status: 200, data: { id: 1 }, headers: {} };
  };
  const r = await postReview({
    ...BASE,
    humanSummary: summary,
    postingAgentNote: note,
    findings: [makeFinding({ id: "f1", title: "FINDING-ONE" })],
    ghJsonFn: gh as GhFn,
  });
  assert.equal(r.unposted, true);
  assert.match(r.unpostedReason!, /body_over_cap_without_findings/);
  assert.equal(posts, 0, "no overflow comment may be posted for a review that cannot land");
  assert.equal(r.bodyOverflow?.summaryRelocated, undefined, "nothing was relocated, so nothing may claim it was");
  const nonFinding = Number(/— (\d+) of non-finding parts/.exec(r.unpostedReason!)?.[1]);
  assert.ok(
    nonFinding > summary.length + note.length,
    `the refusal measured ${nonFinding} chars — the stub, not the ${summary.length}-char summary the body still carries`,
  );
});

test("a segment header's position reads as prose, so a reader landing mid-way can parse it", () => {
  // `part 1: one finding,segment 1 of 2.` — the one navigation string a reader
  // arriving in the middle of a segmented text relies on.
  const huge = makeFinding({ id: "huge", title: "HUGE", body: structuredText(140_000) });
  const findingPlan = planBodySplit((kept) => buildReviewBody("M", "s", kept), [huge], "M");
  assert.match(renderOverflowChunk("M", 1, findingPlan.chunks[0]), /part 1: one finding, segment 1 of \d+\.\*\*/);

  const summaryChunks = segmentChunks({ of: "summary" }, structuredText(200_000), "M", GITHUB_ISSUE_COMMENT_MAX);
  assert.ok(summaryChunks.length > 1, "fixture: the summary must need more than one comment");
  assert.match(renderOverflowChunk("M", 1, summaryChunks[0]), /part 1: review summary, segment 1 of \d+\.\*\*/);

  // Still the inverse of the renderer: slot adoption reads the part number back
  // out of exactly these headers.
  assert.equal(overflowPartOf("M", renderOverflowChunk("M", 3, summaryChunks[0])), 3);
});
