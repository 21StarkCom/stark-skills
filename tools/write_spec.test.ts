/**
 * write_spec.test.ts — CLI-boundary tests for the write-spec dispatcher.
 *
 * The CLI runs `main` on import, so these exercise it as a real subprocess
 * (`node --experimental-strip-types tools/write_spec.ts ...`) — the same shape
 * the skill invokes. Covers: --help, the gemini v1 rejection message, argument
 * validation, and the side-effect-free --dry-run contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReceipt } from "./write_spec.ts";
import type { WriteSpecReceipt } from "./write_spec_lib.ts";

const CLI = fileURLToPath(new URL("./write_spec.ts", import.meta.url));

// `--intent-brief` is a PATH to a markdown brief file (not inline text), so the
// tests write a real temp brief and pass its path. BRIEF_MARKER is a distinctive
// token used to assert the file CONTENTS (not the path string) flow through.
const BRIEF_MARKER = `WS-BRIEF-CONTENTS-${process.pid}`;
const BRIEF = path.join("/tmp", `ws-brief-${process.pid}.md`);
fs.writeFileSync(BRIEF, `Ask: Build a widget\nConstraints: none\n${BRIEF_MARKER}\n`);

/** A minimal receipt for exercising the human render. */
function fakeReceipt(over: Partial<WriteSpecReceipt> = {}): WriteSpecReceipt {
  return {
    ok: true,
    final_verdict: "contract_satisfied",
    slug: "s",
    spec_path: "docs/specs/2026-07-18-s-spec.md",
    run_dir: "/tmp/run",
    run_id: "r1",
    rounds: 1,
    lead_agent: "claude",
    wing_agent: "codex",
    contract_status: [],
    dropped_sections: [],
    summary: "",
    cost_usd: 0.1234,
    cost_breakdown: [
      { agent: "claude", model: "m", inputTokens: 1, outputTokens: 2, cost_usd: 0.1234 },
    ],
    cost_notes: [],
    persistence_errors: [],
    ...over,
  };
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, ...args],
    { encoding: "utf8" },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// A canonical basename so deriveSlugFromOut resolves rather than throwing.
function canonicalOut(tag: string): string {
  return path.join("/tmp", `2026-07-18-wsdry-${tag}-${process.pid}-spec.md`);
}

test("renderReceipt surfaces cost on the human path", () => {
  const out = renderReceipt(fakeReceipt());
  assert.match(out, /cost:\s+\$0\.1234 \(1 invocation\)/);
  // No unavailable note when cost_notes is empty.
  assert.doesNotMatch(out, /some usage unavailable/);
});

test("renderReceipt flags unavailable usage and pluralizes invocations", () => {
  const out = renderReceipt(
    fakeReceipt({
      cost_usd: 0.5,
      cost_breakdown: [
        { agent: "claude", model: "m", inputTokens: 1, outputTokens: 2, cost_usd: 0.3 },
        { agent: "codex", model: "m", inputTokens: 0, outputTokens: 0, cost_usd: 0 },
      ],
      cost_notes: [{ invocation: "wing:verify", reason: "usage_unavailable" }],
    }),
  );
  assert.match(out, /cost:\s+\$0\.5000 \(2 invocations\) \(some usage unavailable\)/);
});

test("write_spec --help exits 0 and prints usage", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: write_spec\.ts/);
  assert.match(r.stdout, /--intent-brief/);
});

test("gemini is rejected at validation with the exact v1 message", () => {
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", canonicalOut("gem"),
    "--lead", "gemini",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unsupported agent: gemini \(claude\|codex only at v1\)/);
});

test("gemini rejected on --wing too", () => {
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", canonicalOut("gemw"),
    "--wing", "gemini",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unsupported agent: gemini \(claude\|codex only at v1\)/);
});

test("missing required flags exit 2", () => {
  assert.equal(runCli(["--out", canonicalOut("noBrief")]).code, 2);
  assert.equal(runCli(["--intent-brief", BRIEF]).code, 2);
});

test("unknown argument exits 2", () => {
  const r = runCli(["--intent-brief", BRIEF, "--out", canonicalOut("unk"), "--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown argument: --bogus/);
});

test("non-canonical --out is rejected before dispatch", () => {
  const r = runCli(["--intent-brief", BRIEF, "--out", "/tmp/not-a-spec.md", "--dry-run"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must match docs\/specs\/YYYY-MM-DD-<slug>-spec\.md/);
});

test("a non-agent --lead value hits the generic rejection (not the gemini branch)", () => {
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", canonicalOut("badlead"),
    "--lead", "grok",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--lead must be claude or codex; got grok/);
  // NOT the gemini-specific message.
  assert.doesNotMatch(r.stderr, /unsupported agent/);
});

test("a non-agent --wing value hits the generic rejection", () => {
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", canonicalOut("badwing"),
    "--wing", "llama",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--wing must be claude or codex; got llama/);
});

for (const [flag, value] of [
  ["--max-rounds", "abc"], // NaN
  ["--max-rounds", "0"], // not positive
  ["--timeout", "-5"], // negative
  ["--wing-timeout", "1.5"], // non-integer
] as const) {
  test(`parsePosInt rejects ${flag} ${value}`, () => {
    const r = runCli([
      "--intent-brief", BRIEF,
      "--out", canonicalOut(`pos-${flag.slice(2)}-${value.replace(/\W/g, "")}`),
      flag, value,
    ]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(`\\${flag} must be a positive integer; got ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
}

test("--dry-run prints the planned dispatch (with derived slug) and writes nothing", () => {
  const out = canonicalOut("plan");
  // Guard: ensure a clean slate.
  if (fs.existsSync(out)) fs.rmSync(out);
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", out,
    "--lead", "claude",
    "--wing", "codex",
    "--json",
    "--dry-run",
  ]);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.slug, `wsdry-plan-${process.pid}`);
  assert.equal(plan.out, out);
  assert.equal(plan.lead_agent, "claude");
  assert.equal(plan.wing_agent, "codex");
  assert.ok(Array.isArray(plan.lead_cmd) && plan.lead_cmd.length > 0);
  assert.ok(Array.isArray(plan.wing_cmd) && plan.wing_cmd.length > 0);
  // Side-effect-free: no --out file created by the dry run.
  assert.equal(fs.existsSync(out), false);
});

test("--dry-run threads model overrides into the planned argv", () => {
  const out = canonicalOut("model");
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", out,
    "--lead", "claude",
    "--lead-model", "claude-fable-5",
    "--wing", "codex",
    "--wing-model", "gpt-5.6-sol",
    "--json",
    "--dry-run",
  ]);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.lead_model, "claude-fable-5");
  assert.equal(plan.wing_model, "gpt-5.6-sol");
  assert.ok(plan.lead_cmd.includes("claude-fable-5"));
  assert.ok(plan.wing_cmd.includes("gpt-5.6-sol"));
  assert.equal(fs.existsSync(out), false);
});

test("--intent-brief pointing at a missing file fails with a clear error", () => {
  const missing = path.join("/tmp", `ws-brief-missing-${process.pid}.md`);
  if (fs.existsSync(missing)) fs.rmSync(missing);
  const r = runCli([
    "--intent-brief", missing,
    "--out", canonicalOut("missing"),
    "--dry-run",
  ]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read --intent-brief PATH/);
  assert.match(r.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--intent-brief file CONTENTS (not the path) flow through to the assembled prompt", () => {
  const out = canonicalOut("contents");
  const r = runCli([
    "--intent-brief", BRIEF,
    "--out", out,
    "--lead", "claude",
    "--wing", "codex",
    "--json",
    "--dry-run",
  ]);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  // The distinctive marker from the brief file's CONTENTS must appear in the
  // composed lead prompt (the assembled brief), proving the file was read.
  assert.ok(plan.lead_prompt.includes(BRIEF_MARKER));
  assert.ok(plan.wing_prompt.includes(BRIEF_MARKER));
  // And the raw path string is NOT what got assembled as the brief body.
  assert.ok(!plan.lead_prompt.includes(BRIEF));
});
