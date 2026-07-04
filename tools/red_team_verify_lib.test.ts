// Tests for the red-team refutation pass (Task #2).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  aggregateVerdicts,
  applyDecision,
  buildRefuterPrompt,
  DEFAULT_VERIFY_CONFIG,
  lensForFinding,
  parseRefutationVerdict,
  refuteFindings,
  verifyKillSwitchActive,
  type RefutationVerdict,
  type RefuteFn,
} from "./red_team_verify_lib.ts";
import type { RedTeamFinding, Severity } from "./red_team_lib.ts";

function finding(over: Partial<RedTeamFinding> = {}): RedTeamFinding {
  return {
    id: over.id ?? "rt1",
    persona: over.persona ?? "cost-ops",
    severity: over.severity ?? "high",
    concern: over.concern ?? "Some concern",
    consequence: over.consequence ?? "Some consequence",
    counter_proposal: over.counter_proposal ?? "Do X instead",
    trade_off: over.trade_off ?? "gives up Y",
    reason_for_uncertainty: over.reason_for_uncertainty ?? null,
    risk_key: over.risk_key ?? "some-risk",
    affected_component: over.affected_component ?? "comp",
    failure_mode: "failure_mode" in over ? (over.failure_mode ?? null) : "cost",
    concern_hash: over.concern_hash ?? "hash",
  };
}

// ── parseRefutationVerdict — signal-preservation rules ─────────────────────

test("parse: drop WITH a cited span → drop", () => {
  const raw = JSON.stringify({ disposition: "drop", cited_span: "the doc says X", rationale: "addressed" });
  const v = parseRefutationVerdict(raw, "already-addressed", "high");
  assert.equal(v.disposition, "drop");
  assert.equal(v.cited_span, "the doc says X");
});

test("parse: drop WITHOUT a cited span → fails safe to uphold", () => {
  const raw = JSON.stringify({ disposition: "drop", cited_span: "  ", rationale: "vibes" });
  const v = parseRefutationVerdict(raw, "correctness", "high");
  assert.equal(v.disposition, "uphold");
});

test("parse: downgrade with span + strictly-lower severity → downgrade", () => {
  const raw = JSON.stringify({ disposition: "downgrade", new_severity: "low", cited_span: "playground scope" });
  const v = parseRefutationVerdict(raw, "already-addressed", "high");
  assert.equal(v.disposition, "downgrade");
  assert.equal(v.new_severity, "low");
});

test("parse: downgrade to a HIGHER severity → clamped to uphold", () => {
  const raw = JSON.stringify({ disposition: "downgrade", new_severity: "critical", cited_span: "x" });
  const v = parseRefutationVerdict(raw, "security", "high");
  assert.equal(v.disposition, "uphold");
});

test("parse: downgrade with no severity or no span → uphold", () => {
  assert.equal(parseRefutationVerdict(JSON.stringify({ disposition: "downgrade", cited_span: "x" }), "correctness", "high").disposition, "uphold");
  assert.equal(parseRefutationVerdict(JSON.stringify({ disposition: "downgrade", new_severity: "low" }), "correctness", "high").disposition, "uphold");
});

test("parse: garbage / non-JSON → uphold", () => {
  assert.equal(parseRefutationVerdict("not json at all", "correctness", "high").disposition, "uphold");
  assert.equal(parseRefutationVerdict(JSON.stringify({ disposition: "banana" }), "correctness", "high").disposition, "uphold");
});

// ── applyDecision ──────────────────────────────────────────────────────────

test("applyDecision: drop → null finding", () => {
  const { finding: f, action } = applyDecision(finding(), { disposition: "drop", new_severity: null });
  assert.equal(f, null);
  assert.equal(action, "dropped");
});

test("applyDecision: downgrade lowers severity", () => {
  const { finding: f, action } = applyDecision(finding({ severity: "critical" }), { disposition: "downgrade", new_severity: "medium" });
  assert.equal(action, "downgraded");
  assert.equal(f?.severity, "medium");
});

test("applyDecision: downgrade to a non-lower severity is ignored (uphold)", () => {
  const { finding: f, action } = applyDecision(finding({ severity: "low" }), { disposition: "downgrade", new_severity: "high" });
  assert.equal(action, "upheld");
  assert.equal(f?.severity, "low");
});

// ── aggregateVerdicts (majority) ───────────────────────────────────────────

function vd(disposition: RefutationVerdict["disposition"], sev?: Severity): RefutationVerdict {
  return { disposition, new_severity: sev ?? null, cited_span: disposition === "uphold" ? null : "span", rationale: null, lens: "correctness" };
}

test("aggregate: single drop wins (votes=1)", () => {
  assert.deepEqual(aggregateVerdicts([vd("drop")], "high"), { disposition: "drop", new_severity: null });
});

test("aggregate: 2/3 drop is a majority → drop", () => {
  assert.equal(aggregateVerdicts([vd("drop"), vd("drop"), vd("uphold")], "high").disposition, "drop");
});

test("aggregate: split 1 drop / 1 uphold (no majority) → uphold", () => {
  assert.equal(aggregateVerdicts([vd("drop"), vd("uphold")], "high").disposition, "uphold");
});

test("aggregate: majority downgrade picks the LEAST reduction", () => {
  const d = aggregateVerdicts([vd("downgrade", "low"), vd("downgrade", "medium")], "critical");
  assert.equal(d.disposition, "downgrade");
  assert.equal(d.new_severity, "medium"); // closest to original
});

// ── lensForFinding ─────────────────────────────────────────────────────────

test("lensForFinding maps failure_mode to a lens", () => {
  assert.equal(lensForFinding(finding({ failure_mode: "security" })), "security");
  assert.equal(lensForFinding(finding({ failure_mode: "availability" })), "reproduces");
  assert.equal(lensForFinding(finding({ failure_mode: "cost" })), "already-addressed");
  assert.equal(lensForFinding(finding({ failure_mode: "correctness" })), "correctness");
  assert.equal(lensForFinding(finding({ failure_mode: null })), "correctness");
});

// ── refuteFindings orchestration (injected fake refuter) ───────────────────

test("refuteFindings: drops refuted, downgrades over-rated, keeps un-refutable", async () => {
  const findings = [
    finding({ id: "keep", severity: "critical", concern: "real blocker" }),
    finding({ id: "drop", severity: "high", concern: "already handled" }),
    finding({ id: "down", severity: "high", concern: "over-rated" }),
  ];
  const refuteFn: RefuteFn = async (prompt) => {
    if (prompt.includes("already handled")) {
      return { raw_output: JSON.stringify({ disposition: "drop", cited_span: "the doc handles it" }), error: null };
    }
    if (prompt.includes("over-rated")) {
      return { raw_output: JSON.stringify({ disposition: "downgrade", new_severity: "low", cited_span: "playground scope" }), error: null };
    }
    return { raw_output: JSON.stringify({ disposition: "uphold" }), error: null };
  };
  const r = await refuteFindings({ findings, artifact: "A", sourceSpec: "S", cfg: DEFAULT_VERIFY_CONFIG, refuteFn });
  const ids = r.findings.map((f) => f.id);
  assert.deepEqual(ids, ["keep", "down"]); // "drop" removed
  assert.equal(r.findings.find((f) => f.id === "keep")!.severity, "critical"); // untouched
  assert.equal(r.findings.find((f) => f.id === "down")!.severity, "low"); // recalibrated
  assert.deepEqual(
    { dropped: r.summary.dropped, downgraded: r.summary.downgraded, upheld: r.summary.upheld },
    { dropped: 1, downgraded: 1, upheld: 1 },
  );
});

test("refuteFindings: a refuter ERROR keeps the finding (never drops on failure)", async () => {
  const findings = [finding({ id: "x", severity: "critical" })];
  const refuteFn: RefuteFn = async () => ({ raw_output: "", error: "claude_unavailable" });
  const r = await refuteFindings({ findings, artifact: "A", sourceSpec: "S", cfg: DEFAULT_VERIFY_CONFIG, refuteFn });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.severity, "critical");
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.errors, 1);
});

test("refuteFindings: REQUEST_HUMAN_REVIEW findings are never refuted", async () => {
  const findings = [finding({ id: "hr", counter_proposal: "REQUEST_HUMAN_REVIEW", severity: "high" })];
  let called = false;
  const refuteFn: RefuteFn = async () => {
    called = true;
    return { raw_output: JSON.stringify({ disposition: "drop", cited_span: "x" }), error: null };
  };
  const r = await refuteFindings({ findings, artifact: "A", sourceSpec: "S", cfg: DEFAULT_VERIFY_CONFIG, refuteFn });
  assert.equal(called, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.summary.skipped, 1);
});

// ── misc ─────────────────────────────────────────────────────────────────

test("buildRefuterPrompt carries the finding + lens + both inputs", () => {
  const p = buildRefuterPrompt({
    finding: finding({ concern: "MY_CONCERN" }),
    artifact: "MY_ARTIFACT",
    sourceSpec: "MY_SPEC",
    lens: "security",
    maxInputChars: 10_000,
  });
  assert.match(p, /MY_CONCERN/);
  assert.match(p, /MY_ARTIFACT/);
  assert.match(p, /MY_SPEC/);
  assert.match(p, /Lens: SECURITY/);
});

test("verifyKillSwitchActive honors documented env values", () => {
  assert.equal(verifyKillSwitchActive({ STARK_RED_TEAM_VERIFY_KILL: "1" }), true);
  assert.equal(verifyKillSwitchActive({ STARK_RED_TEAM_VERIFY_KILL: "true" }), true);
  assert.equal(verifyKillSwitchActive({ STARK_RED_TEAM_VERIFY_KILL: "off" } as NodeJS.ProcessEnv), false);
  assert.equal(verifyKillSwitchActive({}), false);
});
