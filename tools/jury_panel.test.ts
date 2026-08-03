// Tests for `tools/jury_panel.ts` — panel spec parsing + validation.
//
// The bar these tests hold: validation runs BEFORE a dispatch that costs
// dollars and minutes per seat, so every rejection path is worth a case and
// every rejection must name what is wrong (a bare "invalid panel" would send
// the operator back to the spec text to guess).

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CODEX_BUILDER_DEFAULT_EFFORT,
  DEFAULT_PANEL_SPEC,
  EFFORT_CLI_DEFAULT,
  EFFORT_NOT_APPLICABLE,
  PanelError,
  SEAT_EFFORT_LEVELS,
  SEAT_IDS,
  effortForManifest,
  formatPanel,
  parsePanel,
  validatePanelSpec,
  type PanelDeps,
} from "./jury_panel.ts";

// Pinned tables so the suite never depends on the machine's global config.
const TABLES: PanelDeps = {
  rates: {
    "claude-opus-5": {},
    "gpt-5.5-pro": {},
    "gemini-3.1-pro-preview": {},
    "rates-only-model": {},
    _fallback: {},
  },
  limits: {
    "claude-opus-5": {},
    "gpt-5.5-pro": {},
    "gemini-3.1-pro-preview": {},
    "limits-only-model": {},
    _fallback: {},
  },
};

function errorsFor(spec: string, deps: PanelDeps = TABLES): string[] {
  const result = validatePanelSpec(spec, deps);
  assert.equal(result.ok, false, `expected "${spec}" to be rejected`);
  return result.ok ? [] : result.errors;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("default resolution: absent/empty spec resolves to DEFAULT_PANEL_SPEC", () => {
  const expected = [
    { seat: "claude", model: "claude-opus-5", effort: "max" },
    { seat: "codex", model: "gpt-5.5-pro", effort: "xhigh" },
    { seat: "gemini", model: "gemini-3.1-pro-preview", effort: null },
  ];
  for (const spec of [undefined, null, "", "   "]) {
    const panel = parsePanel(spec, TABLES);
    assert.deepEqual(panel.seats, expected, `spec=${JSON.stringify(spec)}`);
  }
  assert.deepEqual(parsePanel(DEFAULT_PANEL_SPEC, TABLES).seats, expected);
});

test("the gemini seat carries no effort and the manifest records n/a", () => {
  const panel = parsePanel(DEFAULT_PANEL_SPEC, TABLES);
  const gemini = panel.seats.find((s) => s.seat === "gemini");
  assert.ok(gemini);
  assert.equal(gemini.effort, null);
  assert.equal(effortForManifest(gemini), EFFORT_NOT_APPLICABLE);
  assert.equal(effortForManifest(panel.seats[0]), "max");
  // The vendor-has-no-knob fact lives in one table, and gemini is the entry.
  assert.equal(SEAT_EFFORT_LEVELS.gemini, null);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("seats are canonicalized into SEAT_IDS order regardless of spec order", () => {
  const panel = parsePanel(
    "gemini=gemini-3.1-pro-preview,codex=gpt-5.5-pro:high,claude=claude-opus-5:low",
    TABLES,
  );
  assert.deepEqual(
    panel.seats.map((s) => s.seat),
    [...SEAT_IDS],
  );
});

test("a subset panel is legitimate (a vendor being down is not a spec error)", () => {
  const panel = parsePanel("claude=claude-opus-5:max,gemini=gemini-3.1-pro-preview", TABLES);
  assert.deepEqual(
    panel.seats.map((s) => s.seat),
    ["claude", "gemini"],
  );
});

test("whitespace around seats, models and efforts is tolerated", () => {
  const panel = parsePanel(" claude = claude-opus-5 : max , codex=gpt-5.5-pro:xhigh ", TABLES);
  assert.deepEqual(panel.seats, [
    { seat: "claude", model: "claude-opus-5", effort: "max" },
    { seat: "codex", model: "gpt-5.5-pro", effort: "xhigh" },
  ]);
});

test("formatPanel round-trips through parsePanel", () => {
  const spec = "claude=claude-opus-5:max,gemini=gemini-3.1-pro-preview";
  const once = parsePanel(spec, TABLES);
  assert.equal(formatPanel(once), spec);
  assert.deepEqual(parsePanel(formatPanel(once), TABLES).seats, once.seats);
  assert.equal(formatPanel(parsePanel(undefined, TABLES)), DEFAULT_PANEL_SPEC);
});

// ---------------------------------------------------------------------------
// Strict model-id rejection — BOTH tables
// ---------------------------------------------------------------------------

test("unknown model id is rejected and names both missing tables", () => {
  const [err] = errorsFor("claude=claude-opus-6:max");
  assert.match(err, /claude-opus-6/);
  assert.match(err, /model_rates and model_limits/);
});

test("a model in model_rates but not model_limits is still rejected", () => {
  const [err] = errorsFor("claude=rates-only-model:max");
  assert.match(err, /model_limits/);
  assert.doesNotMatch(err, /model_rates and/);
});

test("a model in model_limits but not model_rates is still rejected", () => {
  const [err] = errorsFor("claude=limits-only-model:max");
  assert.match(err, /model_rates/);
  assert.doesNotMatch(err, /and model_limits/);
});

test("_fallback is a table sentinel, not a dispatchable model", () => {
  const [err] = errorsFor("claude=_fallback:max");
  assert.match(err, /unknown model "_fallback"/);
});

test("strictness reads the tables it is given (a real row makes a real panel)", () => {
  const before = validatePanelSpec("gemini=some-future-model", TABLES);
  assert.equal(before.ok, false);
  const after = validatePanelSpec("gemini=some-future-model", {
    rates: { "some-future-model": {} },
    limits: { "some-future-model": {} },
  });
  assert.equal(after.ok, true);
});

// ---------------------------------------------------------------------------
// Effort rejection
// ---------------------------------------------------------------------------

test("effort on the gemini seat is rejected, never silently dropped", () => {
  const [err] = errorsFor("gemini=gemini-3.1-pro-preview:high");
  assert.match(err, /gemini/);
  assert.match(err, /no reasoning-effort knob/);
  assert.match(err, new RegExp(EFFORT_NOT_APPLICABLE));
});

test("an effort level the vendor does not accept is rejected", () => {
  // "max" is a claude level; codex tops out at xhigh.
  const [codexErr] = errorsFor("codex=gpt-5.5-pro:max");
  assert.match(codexErr, /unknown effort "max"/);
  assert.match(codexErr, /minimal, low, medium, high, xhigh/);

  // "minimal" is a codex level; claude has no such level.
  const [claudeErr] = errorsFor("claude=claude-opus-5:minimal");
  assert.match(claudeErr, /unknown effort "minimal"/);
  assert.match(claudeErr, /low, medium, high, xhigh, max/);
});

test("every documented level is accepted for the seat that documents it", () => {
  for (const level of SEAT_EFFORT_LEVELS.claude as readonly string[]) {
    assert.equal(validatePanelSpec(`claude=claude-opus-5:${level}`, TABLES).ok, true, level);
  }
  for (const level of SEAT_EFFORT_LEVELS.codex as readonly string[]) {
    assert.equal(validatePanelSpec(`codex=gpt-5.5-pro:${level}`, TABLES).ok, true, level);
  }
});

test("a trailing colon with no effort is a typo, not an omitted effort", () => {
  const [err] = errorsFor("claude=claude-opus-5:");
  assert.match(err, /empty effort/);
});

// ---------------------------------------------------------------------------
// Shape rejection
// ---------------------------------------------------------------------------

test("shape errors: unknown seat, duplicate seat, missing =, stray comma, no model", () => {
  assert.match(errorsFor("gpt=gpt-5.5-pro:high")[0], /unknown seat/);
  assert.match(
    errorsFor("claude=claude-opus-5:max,claude=claude-opus-5:low")[0],
    /named more than once/,
  );
  assert.match(errorsFor("claude-opus-5")[0], /expected seat=model\[:effort\]/);
  assert.match(errorsFor("claude=claude-opus-5:max,")[0], /empty seat entry/);
  assert.match(errorsFor("claude=")[0], /missing model id/);
  assert.match(errorsFor("claude=:max")[0], /missing model id/);
});

test("every problem in the spec is reported, not just the first", () => {
  const errors = errorsFor("gpt=x,gemini=gemini-3.1-pro-preview:high,claude=nope:max");
  assert.equal(errors.length, 3);
  assert.match(errors[0], /unknown seat/);
  assert.match(errors[1], /no reasoning-effort knob/);
  assert.match(errors[2], /unknown model/);
});

test("parsePanel throws PanelError carrying every error; the message lists them", () => {
  assert.throws(
    () => parsePanel("gpt=x,claude=nope:max", TABLES),
    (err: unknown) => {
      assert.ok(err instanceof PanelError);
      assert.equal(err.name, "PanelError");
      assert.equal(err.errors.length, 2);
      assert.match(err.message, /invalid panel spec/);
      assert.match(err.message, /unknown seat/);
      assert.match(err.message, /unknown model/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// code-review regressions (PR #838): the manifest records what actually runs
// ---------------------------------------------------------------------------

test("effortForManifest: an omitted codex effort records the builder's pinned default", () => {
  assert.equal(
    effortForManifest({ seat: "codex", model: "gpt-5.5-pro", effort: null }),
    CODEX_BUILDER_DEFAULT_EFFORT,
  );
  assert.equal(
    effortForManifest({ seat: "claude", model: "claude-opus-5", effort: null }),
    EFFORT_CLI_DEFAULT,
  );
  assert.equal(
    effortForManifest({ seat: "gemini", model: "gemini-3.1-pro-preview", effort: null }),
    EFFORT_NOT_APPLICABLE,
  );
  assert.equal(
    effortForManifest({ seat: "codex", model: "gpt-5.5-pro", effort: "xhigh" }),
    "xhigh",
  );
});

test("the builder-default constant stays in lockstep with agent_codex", async () => {
  const codex = await import("./agent_codex.ts");
  assert.equal(CODEX_BUILDER_DEFAULT_EFFORT, codex.DEFAULT_REASONING_EFFORT);
  assert.deepEqual([...SEAT_EFFORT_LEVELS.codex ?? []], [...codex.CODEX_EFFORT_LEVELS]);
});
