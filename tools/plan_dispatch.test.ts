import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildLeadGeneratePrompt,
  buildRevisePrompt,
  buildWingReviewPayload,
  DEFAULT_LEAD,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_WING,
  deriveSpecSlug,
  derivePlanTarget,
  isPlainObject,
  runPlanDispatch,
  WING_TIMEOUT_DEFAULT_SEC,
} from "./plan_dispatch.ts";
import { parsePlanSlug, planPathFor } from "./forge_state_lib.ts";

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
  test("appends spec content under the H2 header", () => {
    const out = buildLeadGeneratePrompt("GENERATE-TEMPLATE", "DESIGN-CONTENT");
    assert.match(out, /GENERATE-TEMPLATE/);
    assert.match(out, /## Spec document to plan from/);
    assert.match(out, /DESIGN-CONTENT/);
    // Template comes before spec (lead reads instructions, then doc).
    assert.ok(out.indexOf("GENERATE-TEMPLATE") < out.indexOf("DESIGN-CONTENT"));
  });
});

// --- buildWingReviewPayload ------------------------------------------------

describe("buildWingReviewPayload", () => {
  test("includes review template, spec, and draft", () => {
    const out = buildWingReviewPayload("REVIEW-TEMPLATE", "DESIGN-X", "DRAFT-Y", []);
    assert.match(out, /REVIEW-TEMPLATE/);
    assert.match(out, /## Spec document the plan must implement/);
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

  test("frames prior findings as settled dispositions (anti-churn)", () => {
    const out = buildWingReviewPayload("R", "D", "draft", [
      { round_num: 1, verdict: "revise", blocking_findings: ["x"], summary: "s" },
    ]);
    // the draft under review is the response to those findings — wing must treat
    // them as settled unless the current draft still exhibits them
    assert.match(out, /already responds to|SETTLED|expected addressed/);
    assert.match(out, /shrink toward zero/);
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
    specContent: "DESIGN",
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

// --- spec-to-plan reports authoritative plan_path + plan_slug + plan PR in
// --- the spec convention (T1, standards/stage-completion-line.md) ----------
//
// `stark-spec-to-plan` is the sole producer of `plan_path`/`plan_slug`
// (spec §4 SSOT) — plan-to-tasks/copilot only ever consume the recorded
// slug. This suite pins the derivation itself: spec-slug extraction, the
// `docs/plans/YYYY-MM-DD-<slug>-plan.md` convention, and the round-trip
// through `forge_state_lib.ts`'s `parsePlanSlug`/`planPathFor` pair — the
// single owner of that path pattern, which this module must consume rather
// than re-encode.

describe("spec-to-plan reports authoritative plan_path + plan_slug + plan PR in the spec convention", () => {
  test("deriveSpecSlug strips date prefix and -spec suffix", () => {
    assert.equal(deriveSpecSlug("docs/specs/2026-03-27-auth-spec.md"), "auth");
  });

  test("deriveSpecSlug strips date prefix and -design suffix", () => {
    assert.equal(deriveSpecSlug("docs/specs/2026-03-27-auth-design.md"), "auth");
  });

  test("deriveSpecSlug handles a multi-word slug and nested path", () => {
    assert.equal(
      deriveSpecSlug("/abs/repo/docs/specs/2026-07-19-stark-forge-plan-scaffold-spec.md"),
      "stark-forge-plan-scaffold",
    );
  });

  test("deriveSpecSlug sanitizes an unconventional filename into a renderable token", () => {
    const slug = deriveSpecSlug("Some Weird File Name!!.md");
    assert.match(slug, /^[A-Za-z0-9._][A-Za-z0-9._-]*$/);
  });

  test("derivePlanTarget emits the docs/plans/YYYY-MM-DD-<slug>-plan.md convention", () => {
    const { plan_slug, plan_path } = derivePlanTarget(
      "docs/specs/2026-03-27-auth-spec.md",
      "2026-07-24",
    );
    assert.equal(plan_slug, "auth");
    assert.equal(plan_path, "docs/plans/2026-07-24-auth-plan.md");
    assert.match(plan_path, /^docs\/plans\/\d{4}-\d{2}-\d{2}-[^/]+-plan\.md$/);
  });

  test("plan_slug is the SPEC-slug derivation, not a re-parse of the plan filename", () => {
    // A plan filename that happened to differ from the spec's slug would
    // prove a re-parse; deriving from the spec path must ignore it entirely.
    const { plan_slug } = derivePlanTarget(
      "docs/specs/2026-03-27-checkout-flow-spec.md",
      "2026-07-24",
    );
    assert.equal(plan_slug, "checkout-flow");
    assert.notEqual(plan_slug, "unrelated-plan-name");
  });

  test("round-trips through forge_state_lib's parsePlanSlug/planPathFor pair", () => {
    const { plan_slug, plan_path } = derivePlanTarget(
      "docs/specs/2026-03-27-auth-spec.md",
      "2026-07-24",
    );
    assert.equal(parsePlanSlug(plan_path), plan_slug);
    assert.equal(plan_path, planPathFor(plan_slug, "2026-07-24"));
  });

  test("defaults the date segment to today (UTC) when --plan-date/date arg is omitted", () => {
    const today = new Date().toISOString().slice(0, 10);
    const { plan_path } = derivePlanTarget("docs/specs/2026-03-27-auth-spec.md");
    assert.ok(plan_path.startsWith(`docs/plans/${today}-`));
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

  test("missing --spec-file exits 2", () => {
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

  test("stdout JSON carries plan_path/plan_slug even on a synchronous preflight rejection", () => {
    // lead === wing short-circuits inside runPlanDispatch before any agent
    // spawn (see "runPlanDispatch preflight" above) — this exercises the
    // real CLI main() end-to-end (arg parse -> file reads -> derivePlanTarget
    // -> JSON stdout) fast and deterministically, no agent CLI required.
    const file = path.resolve(import.meta.dirname ?? "", "plan_dispatch.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-dispatch-cli-test-"));
    const specFile = path.join(dir, "2026-03-27-auth-spec.md");
    const genFile = path.join(dir, "g.md");
    const revFile = path.join(dir, "r.md");
    const revisFile = path.join(dir, "v.md");
    fs.writeFileSync(specFile, "spec content");
    fs.writeFileSync(genFile, "GEN");
    fs.writeFileSync(revFile, "REV");
    fs.writeFileSync(revisFile, "REVISE");

    let out = "";
    try {
      execFileSync(
        "node",
        [
          "--experimental-strip-types", file,
          "--spec-file", specFile,
          "--generate-prompt-file", genFile,
          "--review-prompt-file", revFile,
          "--revise-prompt-file", revisFile,
          "--lead", "claude",
          "--wing", "claude",
          "--plan-date", "2026-07-24",
        ],
        { encoding: "utf-8" },
      );
      assert.fail("should have exited non-zero (lead_eq_wing)");
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      assert.equal(e.status, 1);
      out = e.stdout ?? "";
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const parsed = JSON.parse(out);
    assert.equal(parsed.error, "lead_eq_wing");
    assert.equal(parsed.plan_slug, "auth");
    assert.equal(parsed.plan_path, "docs/plans/2026-07-24-auth-plan.md");
  });
});
