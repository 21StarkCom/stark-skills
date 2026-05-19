import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

import {
  buildLeadGeneratePrompt,
  buildRevisePrompt,
  buildWingReviewPayload,
  DEFAULT_LEAD,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_WING,
  isPlainObject,
  runPlanDispatch,
  WING_TIMEOUT_DEFAULT_SEC,
} from "./plan_dispatch.ts";

// --- Defaults sanity --------------------------------------------------------

describe("defaults", () => {
  test("lead and wing differ by default (copilot parity)", () => {
    assert.notEqual(DEFAULT_LEAD, DEFAULT_WING);
    assert.equal(DEFAULT_LEAD, "claude");
    assert.equal(DEFAULT_WING, "codex");
  });

  test("max-rounds + timeouts match copilot", () => {
    assert.equal(DEFAULT_MAX_ROUNDS, 4);
    assert.equal(DEFAULT_TIMEOUT_SEC, 900);
    assert.equal(WING_TIMEOUT_DEFAULT_SEC, 600);
  });
});

// --- buildLeadGeneratePrompt -----------------------------------------------

describe("buildLeadGeneratePrompt", () => {
  test("appends design content under the H2 header", () => {
    const out = buildLeadGeneratePrompt("GENERATE-TEMPLATE", "DESIGN-CONTENT");
    assert.match(out, /GENERATE-TEMPLATE/);
    assert.match(out, /## Design document to plan from/);
    assert.match(out, /DESIGN-CONTENT/);
    // Template comes before design (lead reads instructions, then doc).
    assert.ok(out.indexOf("GENERATE-TEMPLATE") < out.indexOf("DESIGN-CONTENT"));
  });
});

// --- buildWingReviewPayload ------------------------------------------------

describe("buildWingReviewPayload", () => {
  test("includes review template, design, and draft", () => {
    const out = buildWingReviewPayload("REVIEW-TEMPLATE", "DESIGN-X", "DRAFT-Y", []);
    assert.match(out, /REVIEW-TEMPLATE/);
    assert.match(out, /## Design document the plan must implement/);
    assert.match(out, /DESIGN-X/);
    assert.match(out, /## Plan draft under review/);
    assert.match(out, /DRAFT-Y/);
  });

  test("substitutes '(empty draft)' for blank draft", () => {
    const out = buildWingReviewPayload("R", "D", "   ", []);
    assert.match(out, /\(empty draft\)/);
  });

  test("renders prior rounds section when present", () => {
    const out = buildWingReviewPayload("R", "D", "draft", [
      { round_num: 1, verdict: "revise", blocking_findings: ["nit"], summary: "small fix" },
    ]);
    assert.match(out, /Prior review history/);
    assert.match(out, /### Round 1: revise/);
    assert.match(out, /- nit/);
    assert.match(out, /Summary: small fix/);
  });

  test("omits prior rounds section on round 1", () => {
    const out = buildWingReviewPayload("R", "D", "draft", []);
    assert.doesNotMatch(out, /Prior review history/);
  });
});

// --- buildRevisePrompt -----------------------------------------------------

describe("buildRevisePrompt", () => {
  test("embeds findings as bullet list", () => {
    const out = buildRevisePrompt("REVISE-TEMPLATE", "DESIGN", "PRIOR-DRAFT", ["a", "b"], 2);
    assert.match(out, /Round 2/);
    assert.match(out, /REVISE-TEMPLATE/);
    assert.match(out, /- a/);
    assert.match(out, /- b/);
    assert.match(out, /DESIGN/);
    assert.match(out, /PRIOR-DRAFT/);
  });

  test("falls back to placeholder when findings empty", () => {
    const out = buildRevisePrompt("T", "D", "P", [], 3);
    assert.match(out, /\(no specific findings/);
  });
});

// --- runPlanDispatch preflight rejections ----------------------------------
// These never call the real CLIs: they return PreflightFailure synchronously
// before any spawn() because the lead/wing pair fails validation.

describe("runPlanDispatch preflight", () => {
  const baseOpts = {
    designContent: "DESIGN",
    generatePrompt: "G",
    reviewPrompt: "R",
    revisePrompt: "V",
    maxRounds: 1,
    timeoutSec: 10,
    wingTimeoutSec: 10,
  };

  test("lead == wing returns lead_eq_wing error", async () => {
    const r = await runPlanDispatch({
      ...baseOpts,
      lead: "claude",
      wing: "claude",
    });
    assert.equal((r as { error: string }).error, "lead_eq_wing");
    assert.deepEqual((r as { rounds: unknown[] }).rounds, []);
  });

  test("invalid agent returns invalid_agent error", async () => {
    const r = await runPlanDispatch({
      ...baseOpts,
      // @ts-expect-error testing runtime rejection of unknown agent
      lead: "not-an-agent",
      wing: "codex",
    });
    assert.equal((r as { error: string }).error, "invalid_agent");
  });
});

// --- isPlainObject re-export sanity ----------------------------------------

describe("isPlainObject (re-exported)", () => {
  test("matches copilot's behavior", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ verdict: "approve" }), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("s"), false);
  });
});

// --- CLI smoke -------------------------------------------------------------

describe("CLI", () => {
  test("--help exits 0 and prints usage", () => {
    const file = path.resolve(import.meta.dirname ?? "", "plan_dispatch.ts");
    const out = execFileSync(
      "node",
      ["--experimental-strip-types", file, "--help"],
      { encoding: "utf-8" },
    );
    assert.match(out, /Usage: plan_dispatch/);
  });

  test("missing --design-file exits 2", () => {
    const file = path.resolve(import.meta.dirname ?? "", "plan_dispatch.ts");
    try {
      execFileSync(
        "node",
        [
          "--experimental-strip-types", file,
          "--generate-prompt-file", "/tmp/g.md",
          "--review-prompt-file", "/tmp/r.md",
          "--revise-prompt-file", "/tmp/v.md",
        ],
        { encoding: "utf-8" },
      );
      assert.fail("should have exited non-zero");
    } catch (err) {
      const e = err as { status?: number };
      assert.equal(e.status, 2);
    }
  });

  test("unknown arg exits 2 with usage", () => {
    const file = path.resolve(import.meta.dirname ?? "", "plan_dispatch.ts");
    try {
      execFileSync(
        "node",
        ["--experimental-strip-types", file, "--bogus-flag"],
        { encoding: "utf-8" },
      );
      assert.fail("should have exited non-zero");
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      assert.equal(e.status, 2);
      const stderr = e.stderr?.toString() ?? "";
      assert.match(stderr, /unknown arg: --bogus-flag/);
    }
  });
});
