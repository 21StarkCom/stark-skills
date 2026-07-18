import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPEN_QUESTIONS_HEADING,
  OWNED_BLOCK_END,
  OWNED_BLOCK_START,
  appForLead,
  applyAcceptedGaps,
  buildOwnedBlock,
  buildSkillSummary,
  mergePrBody,
  parseAcceptedGaps,
  pickPrForHead,
  planBranchAction,
  shouldRunGitStep,
  shouldSkipCommit,
  type AcceptedGap,
  type OpenPr,
} from "./write_spec_land_lib.ts";
import { SECTION_IDS, type ContractItem, type WriteSpecReceipt } from "./write_spec_lib.ts";

function fakeReceipt(over: Partial<WriteSpecReceipt> = {}): WriteSpecReceipt {
  const contract_status: ContractItem[] = SECTION_IDS.map((section) => ({
    section,
    status: "satisfied",
    note: "",
  }));
  return {
    ok: true,
    final_verdict: "contract_satisfied",
    slug: "landing-helper",
    spec_path: "docs/specs/2026-07-18-landing-helper-spec.md",
    run_dir: "/tmp/run",
    run_id: "run-1",
    rounds: 1,
    lead_agent: "claude",
    wing_agent: "codex",
    contract_status,
    dropped_sections: [],
    summary: "all sections satisfied",
    cost_usd: 0.1234,
    cost_breakdown: [],
    cost_notes: [],
    persistence_errors: [],
    ...over,
  };
}

// ── test_lead_app_mapping ───────────────────────────────────────────────────

test("test_lead_app_mapping", () => {
  assert.equal(appForLead("claude"), "stark-claude");
  assert.equal(appForLead("codex"), "stark-codex");
  // Any non-codex value maps to stark-claude (total mapping over the union).
  assert.equal(appForLead("gemini"), "stark-claude");
});

// ── test_branch_adopt_or_create + test_stale_local_ff ───────────────────────

test("test_branch_adopt_or_create: the three standardized actions", () => {
  // local wins → checkout-ff (even if remote also exists).
  assert.equal(planBranchAction(true, true), "checkout-ff");
  assert.equal(planBranchAction(true, false), "checkout-ff");
  // no local, remote exists → checkout-track.
  assert.equal(planBranchAction(false, true), "checkout-track");
  // neither → create.
  assert.equal(planBranchAction(false, false), "create");
});

test("test_stale_local_ff: existing-local path is the fast-forward action", () => {
  // The existing-local path is ALWAYS checkout-ff — never a bare 'checkout'.
  const action = planBranchAction(true, true);
  assert.equal(action, "checkout-ff");
  assert.notEqual(action as string, "checkout");
});

// ── test_commit_idempotent ──────────────────────────────────────────────────

test("test_commit_idempotent: skip commit iff nothing staged", () => {
  assert.equal(shouldSkipCommit(true), true); // empty staged diff → skip
  assert.equal(shouldSkipCommit(false), false); // staged changes → commit
});

// ── test_dry_run_skips_git_steps ────────────────────────────────────────────

test("test_dry_run_skips_git_steps", () => {
  assert.equal(shouldRunGitStep(true), false); // dry run → no git
  assert.equal(shouldRunGitStep(false), true); // real run → git
});

// ── test_pick_pr_for_head ───────────────────────────────────────────────────

test("test_pick_pr_for_head", () => {
  const prs: OpenPr[] = [
    { number: 1, head: { ref: "other-branch" } },
    { number: 2, head: { ref: "target" }, html_url: "u2" },
    { number: 3, head: { ref: "target" } }, // dup ref never happens in practice
  ];
  const hit = pickPrForHead(prs, "target");
  assert.equal(hit?.number, 2); // first match wins
  assert.equal(pickPrForHead(prs, "missing"), null);
  assert.equal(pickPrForHead([], "target"), null);
  // Tolerates malformed entries (missing head/ref).
  assert.equal(pickPrForHead([{ number: 9 } as OpenPr], "target"), null);
});

// ── accepted-gaps schema ────────────────────────────────────────────────────

test("parseAcceptedGaps: validates + drops unknown sections", () => {
  assert.deepEqual(parseAcceptedGaps(null), []);
  assert.deepEqual(parseAcceptedGaps(undefined), []);
  const parsed = parseAcceptedGaps([
    { section: "security", status: "n_a", note: "single-user" },
    { section: "not-a-section", status: "x", note: "y" }, // dropped
    { section: "intent" }, // status/note coerce to ""
    "junk", // ignored
  ]);
  assert.deepEqual(parsed, [
    { section: "security", status: "n_a", note: "single-user" },
    { section: "intent", status: "", note: "" },
  ]);
  assert.throws(() => parseAcceptedGaps({ not: "an array" }));
});

// ── buildOwnedBlock ─────────────────────────────────────────────────────────

test("buildOwnedBlock: markers, every section, accepted gaps", () => {
  const gaps: AcceptedGap[] = [{ section: "accessibility", status: "n_a", note: "no UI" }];
  const block = buildOwnedBlock(fakeReceipt(), gaps);
  assert.ok(block.startsWith(OWNED_BLOCK_START));
  assert.ok(block.trimEnd().endsWith(OWNED_BLOCK_END));
  // Every SECTION_IDS id appears in the coverage table.
  for (const id of SECTION_IDS) {
    assert.ok(block.includes(`\`${id}\``), `missing section ${id}`);
  }
  assert.ok(block.includes("Accepted gaps"));
  assert.ok(block.includes("no UI"));
  assert.ok(block.includes("contract_satisfied"));
});

test("buildOwnedBlock: no gaps → no accepted-gaps section", () => {
  const block = buildOwnedBlock(fakeReceipt());
  assert.ok(!block.includes("Accepted gaps"));
});

test("buildOwnedBlock: pipes in a note never break the table row", () => {
  const receipt = fakeReceipt({
    contract_status: SECTION_IDS.map((section, i) => ({
      section,
      status: "satisfied",
      note: i === 0 ? "a | b\nc" : "",
    })),
  });
  const block = buildOwnedBlock(receipt);
  assert.ok(block.includes("a \\| b c")); // pipe escaped, newline flattened
});

// ── mergePrBody: the core idempotency contract ──────────────────────────────

test("test_pr_body_merge_preserves_other_content", () => {
  const oldBlock = buildOwnedBlock(fakeReceipt({ summary: "OLD-SUMMARY" }));
  const newBlock = buildOwnedBlock(fakeReceipt({ summary: "NEW-SUMMARY" }));

  const intro = "## Overview\nThis PR adds the landing helper.\n";
  const trailer = "\n---\nCloses #706\n";
  const body = intro + "\n" + oldBlock + trailer;

  const merged = mergePrBody(body, newBlock);
  // intro + trailer preserved verbatim.
  assert.ok(merged.startsWith(intro));
  assert.ok(merged.endsWith(trailer));
  // OLD gone, NEW present exactly once.
  assert.ok(!merged.includes("OLD-SUMMARY"));
  assert.equal(merged.split("NEW-SUMMARY").length - 1, 1);
  // exactly one owned span.
  assert.equal(merged.split(OWNED_BLOCK_START).length - 1, 1);
  assert.equal(merged.split(OWNED_BLOCK_END).length - 1, 1);
});

test("mergePrBody: no-marker body appends the block", () => {
  const block = buildOwnedBlock(fakeReceipt());
  const body = "Some hand-written PR description.";
  const merged = mergePrBody(body, block);
  assert.ok(merged.startsWith(body));
  assert.ok(merged.includes(OWNED_BLOCK_START));
  assert.ok(merged.includes(OWNED_BLOCK_END));
});

test("mergePrBody: empty body → the owned block verbatim", () => {
  const block = buildOwnedBlock(fakeReceipt());
  assert.equal(mergePrBody("", block), block);
  assert.equal(mergePrBody("   \n  ", block), block);
  assert.equal(mergePrBody(null, block), block);
  assert.equal(mergePrBody(undefined, block), block);
});

test("mergePrBody: re-merge is idempotent", () => {
  const block = buildOwnedBlock(fakeReceipt());
  const intro = "intro prose\n";
  const once = mergePrBody(intro, block);
  const twice = mergePrBody(once, block);
  assert.equal(twice, once);
  // A third pass is still stable.
  assert.equal(mergePrBody(twice, block), once);
});

test("mergePrBody: append then replace preserves surrounding content", () => {
  const b1 = buildOwnedBlock(fakeReceipt({ summary: "V1" }));
  const b2 = buildOwnedBlock(fakeReceipt({ summary: "V2" }));
  const intro = "keep me\n";
  const afterFirst = mergePrBody(intro, b1);
  const afterSecond = mergePrBody(afterFirst, b2);
  assert.ok(afterSecond.startsWith("keep me"));
  assert.ok(!afterSecond.includes("V1"));
  assert.ok(afterSecond.includes("V2"));
  assert.equal(afterSecond.split(OWNED_BLOCK_START).length - 1, 1);
});

// ── applyAcceptedGaps: mutation + idempotency (#707) ─────────────────────────

test("test_accept_with_gaps_mutation: appends verbatim, creates section, idempotent", () => {
  const spec = "# Spec\n\n## Intent\nDo the thing.\n";
  const items = ["security: single-user, no auth", "test-plan: manual only"];

  const once = applyAcceptedGaps(spec, items);
  // Section created.
  assert.ok(once.includes(OPEN_QUESTIONS_HEADING));
  // Each item appended VERBATIM as a bullet.
  assert.ok(once.includes("- security: single-user, no auth"));
  assert.ok(once.includes("- test-plan: manual only"));
  // Prior content preserved.
  assert.ok(once.startsWith("# Spec\n\n## Intent\nDo the thing."));

  // Idempotent — a second identical apply changes nothing.
  const twice = applyAcceptedGaps(once, items);
  assert.equal(twice, once);
  // A third pass is still stable.
  assert.equal(applyAcceptedGaps(twice, items), once);
});

test("applyAcceptedGaps: existing section appends, no duplicates", () => {
  const spec = "# Spec\n\n## Open Questions\n\n- already noted\n";
  const merged = applyAcceptedGaps(spec, ["already noted", "new gap"]);
  // The pre-existing bullet is not duplicated…
  assert.equal(merged.split("- already noted").length - 1, 1);
  // …and the new one is appended under the same section.
  assert.ok(merged.includes("- new gap"));
  // Only one Open Questions heading.
  assert.equal(merged.split(OPEN_QUESTIONS_HEADING).length - 1, 1);
  // Re-apply is idempotent.
  assert.equal(applyAcceptedGaps(merged, ["already noted", "new gap"]), merged);
});

test("applyAcceptedGaps: bullet-prefixed items and blanks handled", () => {
  const out = applyAcceptedGaps("# S\n", ["- pre-bulleted", "", "  ", "plain"]);
  assert.ok(out.includes("- pre-bulleted"));
  assert.ok(out.includes("- plain"));
  // Empty/whitespace-only items dropped (no empty bullet).
  assert.ok(!/\n- *\n/.test(out));
});

test("applyAcceptedGaps: no items returns input unchanged", () => {
  const spec = "# Spec\n\nbody\n";
  assert.equal(applyAcceptedGaps(spec, []), spec);
});

// ── buildSkillSummary: shape / outcome enum / dry-run nullability (#707) ─────

test("test_skill_summary_emits_accepted_gaps: accept outcome, receipt byte-identical", () => {
  const receipt = fakeReceipt({ final_verdict: "max_rounds_unsatisfied", ok: false });
  const gaps: AcceptedGap[] = [{ section: "security", status: "n_a", note: "single-user" }];

  const summary = buildSkillSummary({
    outcome: "authored_with_accepted_gaps",
    receipt,
    acceptedGaps: gaps,
    headlessAutoAccept: false,
    pr: { number: 707, url: "u" },
  });

  assert.equal(summary.skill, "stark-write-spec");
  assert.equal(summary.outcome, "authored_with_accepted_gaps");
  assert.equal(summary.spec_path, receipt.spec_path);
  assert.equal(summary.slug, receipt.slug);
  assert.equal(summary.final_verdict, "max_rounds_unsatisfied");
  assert.deepEqual(summary.accepted_gaps, gaps);
  assert.equal(summary.headless_auto_accept, false);
  assert.deepEqual(summary.pr, { number: 707, url: "u" });
  // Receipt echoed byte-for-byte.
  assert.equal(JSON.stringify(summary.dispatcher_receipt), JSON.stringify(receipt));
});

test("buildSkillSummary: headless variant sets headless_auto_accept true", () => {
  const receipt = fakeReceipt({ final_verdict: "max_rounds_unsatisfied", ok: false });
  const summary = buildSkillSummary({
    outcome: "authored_with_accepted_gaps",
    receipt,
    acceptedGaps: [{ section: "security", status: "n_a", note: "" }],
    headlessAutoAccept: true,
  });
  assert.equal(summary.headless_auto_accept, true);
});

test("buildSkillSummary: contract_satisfied emits [] + contract_satisfied", () => {
  const receipt = fakeReceipt();
  const summary = buildSkillSummary({ outcome: "contract_satisfied", receipt });
  assert.equal(summary.outcome, "contract_satisfied");
  assert.equal(summary.final_verdict, "contract_satisfied");
  assert.deepEqual(summary.accepted_gaps, []);
  assert.equal(summary.headless_auto_accept, false);
  assert.equal(summary.pr, null);
});

test("test_skill_summary_dry_run: nullable receipt/final_verdict, empty gaps", () => {
  const summary = buildSkillSummary({
    outcome: "dry_run",
    specPath: "docs/specs/2026-07-18-x-spec.md",
    slug: "x",
    // Even if a receipt/gaps were passed, a dry run resolves none.
    receipt: fakeReceipt(),
    acceptedGaps: [{ section: "security", status: "n_a", note: "ignored" }],
  });
  assert.equal(summary.outcome, "dry_run");
  assert.equal(summary.dispatcher_receipt, null);
  assert.equal(summary.final_verdict, null);
  assert.deepEqual(summary.accepted_gaps, []);
  assert.equal(summary.spec_path, "docs/specs/2026-07-18-x-spec.md");
  assert.equal(summary.slug, "x");
});

test("buildSkillSummary: aborted outcome carries receipt but no PR", () => {
  const receipt = fakeReceipt({ final_verdict: "max_rounds_unsatisfied", ok: false });
  const summary = buildSkillSummary({ outcome: "aborted", receipt });
  assert.equal(summary.outcome, "aborted");
  assert.equal(summary.final_verdict, "max_rounds_unsatisfied");
  assert.equal(summary.pr, null);
  assert.equal(JSON.stringify(summary.dispatcher_receipt), JSON.stringify(receipt));
});
