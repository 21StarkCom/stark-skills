// Tests for `tools/agent_gemini.ts`.
//
// Ported from the buried `stark_review.test.ts` (STARK-6098). The dispatcher
// that file exercised is gone, but `agent_gemini.ts` is not — it is one of the
// three agent ports `/stark-jury` drives through `jury_dispatch.ts`, and it was
// the only one of the three with no test file of its own, so deleting
// `stark_review.test.ts` would have left it at zero coverage.
//
// Two of these are guards, not descriptions:
//
//   - **Workspace trust is granted by an explicit mark, never by a name.** The
//     gemini CLI runs tools inside the cwd it trusts; trusting a directory
//     because it merely looks dispatcher-made would trust any path an attacker
//     can get named that way.
//   - **No push/posting credential reaches the subprocess env**, whose entire
//     input is untrusted text.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as agentGemini from "./agent_gemini.ts";

test("agent_gemini: buildCommand emits gemini -o json with model and stdin prompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gemtest-"));
  try {
    const built = agentGemini.buildCommand("hi", "gemini-3.1-pro-preview", {
      cwd: tmp,
      trustedGeneratedCwd: true,
    });
    assert.equal(built.cmd, "gemini");
    assert.deepEqual(built.args, ["-o", "json", "-m", "gemini-3.1-pro-preview", "-p", "-"]);
    assert.equal(built.stdin, "hi");
    // API key never on argv.
    for (const a of built.args) assert.ok(!a.includes("AIza"), "key on argv");
    // Forbidden tokens absent.
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "STARK_PUSH_TOKEN"]) {
      assert.ok(!(k in built.env), `forbidden ${k} in built.env`);
    }
    // Project dir registered in projects.json under GEMINI_CLI_HOME.
    const home = built.env.GEMINI_CLI_HOME;
    assert.ok(home, "GEMINI_CLI_HOME must be set");
    assert.equal(built.env.GEMINI_CLI_TRUST_WORKSPACE, "true");
    const projects = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "projects.json"), "utf8"),
    );
    assert.ok(tmp in projects.projects, `dispatch cwd ${tmp} must be registered`);
    // settings.json auth type follows the resolved auth mode.
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    if (process.env.GEMINI_API_KEY) {
      assert.equal(settings.selectedAuthType, "gemini-api-key");
    } else if (process.env.STARK_GEMINI_AUTH === "vertex") {
      assert.equal(settings.selectedAuthType, "vertex-ai");
      assert.equal(built.env.GOOGLE_GENAI_USE_VERTEXAI, "true");
      assert.equal(built.env.GOOGLE_CLOUD_LOCATION, "global");
    } else {
      // oauth default: creds ride the copied oauth files, no Vertex env.
      assert.equal(settings.selectedAuthType, "oauth-personal");
      assert.equal(built.env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent_gemini: workspace trust requires an explicit generated-cwd mark", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-worktree-"));
  try {
    const built = agentGemini.buildCommand("hi", undefined, { cwd: tmp });
    assert.ok(!("GEMINI_CLI_TRUST_WORKSPACE" in built.env));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent_gemini: stark-named non-temp cwd is not trusted by name", () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), "stark-outside-"));
  try {
    const built = agentGemini.buildCommand("hi", undefined, { cwd: tmp });
    assert.ok(!("GEMINI_CLI_TRUST_WORKSPACE" in built.env));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent_gemini: API-key fallback disables Vertex env", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gemtest-"));
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-xyz";
  try {
    const built = agentGemini.buildCommand("hi", undefined, { cwd: tmp });
    assert.equal(built.env.GEMINI_API_KEY, "test-key-xyz");
    assert.equal(built.env.GOOGLE_GENAI_USE_VERTEXAI, "false");
    assert.ok(!("GOOGLE_CLOUD_PROJECT" in built.env));
    // Argv must NOT contain the key.
    for (const a of built.args) assert.ok(!a.includes("test-key-xyz"));
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent_gemini: parseOutput unwraps {response: ...} envelope", () => {
  const finding = { domain: "perf", severity: "medium", title: "T" };
  const stdout = JSON.stringify({ response: JSON.stringify(finding) });
  const { findings, parseErrors } = agentGemini.parseOutput(stdout);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
  assert.equal(findings[0].agent, "gemini");
});

test("agent_gemini: normalizeOutput unwraps Gemini envelope", () => {
  const stdout = JSON.stringify({ response: '{"classification":"fix","reason":"x"}' });
  const text = agentGemini.normalizeOutput(stdout);
  assert.match(text, /"classification":"fix"/);
});
