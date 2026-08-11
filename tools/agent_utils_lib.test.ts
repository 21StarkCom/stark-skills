// Tests for the agent-CLI dispatch utils — TypeScript ports of
// codex_utils.py, claude_utils.py, gemini_utils.py. Ported alongside the
// code from scripts/test_agent_utils.py. HOME is redirected for the
// config-dependent helpers so DEFAULT_MODELS (all agents enabled) applies.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeCmd, CLAUDE_MODEL } from "./claude_utils_lib.ts";
import {
  CODEX_MODEL,
  CODEX_REASONING_EFFORT_HIGH,
  CODEX_REASONING_EFFORT_MEDIUM,
  CODEX_REASONING_EFFORT_XHIGH,
  getCodexModel,
  parseJsonlOutput,
} from "./codex_utils_lib.ts";
import {
  GEMINI_MODEL,
  makeGeminiEnv,
  parseJsonOutput,
  setupGeminiHome,
  shouldFallbackToApiKey,
  tryGeminiApiKeyFallback,
  withGeminiSession,
} from "./gemini_utils_lib.ts";

function withScratchHome<T>(fn: () => T): T {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-utils-test-"));
  const prev = process.env.HOME;
  process.env.HOME = scratch;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// buildClaudeCmd
// ---------------------------------------------------------------------------

test("buildClaudeCmd: default command shape", () => {
  withScratchHome(() => {
    const cmd = buildClaudeCmd();
    assert.equal(cmd[0], "claude");
    assert.ok(cmd.includes("-p") && cmd.includes("-"));
    assert.ok(cmd.includes("--model") && cmd.includes(CLAUDE_MODEL));
    assert.ok(cmd.includes("--no-session-persistence"));
    assert.ok(!cmd.includes("--allowedTools"));
  });
});

test("buildClaudeCmd: json output format", () => {
  withScratchHome(() => {
    const cmd = buildClaudeCmd({ outputFormat: "json" });
    assert.equal(cmd[cmd.indexOf("--output-format") + 1], "json");
  });
});

test("buildClaudeCmd: allowed tools appended", () => {
  withScratchHome(() => {
    const cmd = buildClaudeCmd({ allowedTools: "Edit,Read,Bash" });
    assert.equal(cmd[cmd.indexOf("--allowedTools") + 1], "Edit,Read,Bash");
  });
});

// ---------------------------------------------------------------------------
// Codex constants + getCodexModel
// ---------------------------------------------------------------------------

test("CODEX_MODEL: non-empty string", () => {
  assert.ok(typeof CODEX_MODEL === "string" && CODEX_MODEL.length > 0);
});

test("codex model: matches global/config.json + model_rates", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const config = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "global", "config.json"), "utf8"),
  );
  const modelId = config.models.codex.model_id;
  assert.equal(modelId, CODEX_MODEL);
  assert.ok(modelId in config.model_rates);
  assert.ok(config.model_rates[modelId].input_per_1m_usd > 0);
});

test("getCodexModel: resolves to the configured model", () => {
  withScratchHome(() => {
    assert.equal(getCodexModel(), CODEX_MODEL);
  });
});

test("codex reasoning-effort constants are TOML key=value", () => {
  assert.ok(CODEX_REASONING_EFFORT_XHIGH.includes('"xhigh"'));
  assert.ok(CODEX_REASONING_EFFORT_HIGH.includes('"high"'));
  assert.ok(CODEX_REASONING_EFFORT_MEDIUM.includes('"medium"'));
});

// ---------------------------------------------------------------------------
// parseJsonlOutput (codex)
// ---------------------------------------------------------------------------

test("parseJsonlOutput: non-JSONL passthrough", () => {
  assert.equal(parseJsonlOutput("hello world"), "hello world");
  assert.equal(parseJsonlOutput(""), "");
});

test("parseJsonlOutput: agent_message format", () => {
  const events = [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.equal(parseJsonlOutput(events), "hello");
});

test("parseJsonlOutput: legacy message format", () => {
  const event = JSON.stringify({
    type: "item.completed",
    item: { type: "message", content: [{ type: "output_text", text: "legacy" }] },
  });
  assert.equal(parseJsonlOutput(event), "legacy");
});

test("parseJsonlOutput: multiple messages joined", () => {
  const events = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "p1" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "p2" } }),
  ].join("\n");
  assert.equal(parseJsonlOutput(events), "p1\np2");
});

test("parseJsonlOutput: ignores non-text items", () => {
  const events = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "ls" },
    }),
  ].join("\n");
  assert.equal(parseJsonlOutput(events), "ok");
});

// ---------------------------------------------------------------------------
// shouldFallbackToApiKey (gemini)
// ---------------------------------------------------------------------------

test("shouldFallbackToApiKey: matches known Vertex auth errors", () => {
  assert.ok(shouldFallbackToApiKey("Error 403: Forbidden"));
  assert.ok(shouldFallbackToApiKey("PERMISSION_DENIED: access denied"));
  assert.ok(shouldFallbackToApiKey("ModelNotFound: gemini-pro"));
});

test("shouldFallbackToApiKey: no match for unrelated errors", () => {
  assert.ok(!shouldFallbackToApiKey("Connection timeout"));
  assert.ok(!shouldFallbackToApiKey(""));
});

// ---------------------------------------------------------------------------
// tryGeminiApiKeyFallback (gemini) — key lookup injected
// ---------------------------------------------------------------------------

test("tryGeminiApiKeyFallback: injects the API key when one is available", () => {
  const kw = { env: { GEMINI_CLI_HOME: "/tmp/test-nonexistent" } as Record<string, string> };
  const applied = tryGeminiApiKeyFallback(kw, "task", "403", () => "test-key");
  assert.equal(applied, true);
  assert.equal(kw.env.GEMINI_API_KEY, "test-key");
  assert.equal(kw.env.GOOGLE_GENAI_USE_VERTEXAI, "false");
});

test("tryGeminiApiKeyFallback: no key → false", () => {
  const kw = { env: {} as Record<string, string> };
  assert.equal(tryGeminiApiKeyFallback(kw, "task", "403", () => null), false);
});

test("tryGeminiApiKeyFallback: no env → false", () => {
  assert.equal(tryGeminiApiKeyFallback({}, "task", "403", () => "key"), false);
});

// ---------------------------------------------------------------------------
// parseJsonOutput (gemini)
// ---------------------------------------------------------------------------

test("parseJsonOutput: single envelope", () => {
  assert.equal(parseJsonOutput(JSON.stringify({ response: "hi" })), "hi");
});

test("parseJsonOutput: array of envelopes joined", () => {
  const raw = JSON.stringify([{ response: "a" }, { response: "b" }]);
  assert.equal(parseJsonOutput(raw), "a\nb");
});

test("parseJsonOutput: passthrough for non-JSON / empty", () => {
  assert.equal(parseJsonOutput("text"), "text");
  assert.equal(parseJsonOutput(""), "");
});

test("parseJsonOutput: no response key → unchanged", () => {
  const raw = JSON.stringify({ error: "x" });
  assert.equal(parseJsonOutput(raw), raw);
});

// ---------------------------------------------------------------------------
// setupGeminiHome (gemini)
// ---------------------------------------------------------------------------

test("setupGeminiHome: creates the .gemini structure + projects.json", () => {
  const home = setupGeminiHome("agentutil-test-", "/tmp/proj", "t");
  try {
    assert.ok(fs.statSync(path.join(home, ".gemini")).isDirectory());
    const projects = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "projects.json"), "utf8"),
    );
    assert.equal(projects.projects["/tmp/proj"], "t");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("setupGeminiHome: approval mode patched into settings.json", () => {
  const home = setupGeminiHome("agentutil-test-", "/tmp/proj", "t", "plan");
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    assert.equal(settings.defaultApprovalMode, "plan");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("setupGeminiHome: vertex mode forces Vertex AI auth + global region", () => {
  process.env.STARK_GEMINI_AUTH = "vertex";
  // Pin the project explicitly. Without it `resolveVertexProject` falls through
  // to the host's `gcloud config get-value project`, so these assertions passed
  // only on a machine with gcloud configured — green here, red on any CI runner
  // and on a fresh checkout. The env var is precedence #1, so this exercises the
  // same code path deterministically.
  process.env.STARK_GEMINI_VERTEX_PROJECT = "test-vertex-project";
  const home = setupGeminiHome("agentutil-test-", "/tmp/proj", "t");
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    assert.equal(settings.security.auth.selectedType, "vertex-ai");
    assert.equal(settings.selectedAuthType, "vertex-ai");
    assert.equal(settings.security.auth.vertexAi.region, "global");
    assert.ok(settings.security.auth.vertexAi.projectId);
  } finally {
    delete process.env.STARK_GEMINI_AUTH;
    delete process.env.STARK_GEMINI_VERTEX_PROJECT;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("setupGeminiHome: oauth mode (default) selects oauth-personal, no vertexAi", () => {
  process.env.STARK_GEMINI_AUTH = "oauth";
  // Same reason as the vertex tests: oauth mode still resolves a project (it is
  // the Code Assist licensing project), so without this the assertion depends on
  // the host's gcloud config.
  process.env.STARK_GEMINI_VERTEX_PROJECT = "test-vertex-project";
  const home = setupGeminiHome("agentutil-test-", "/tmp/proj", "t");
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    assert.equal(settings.security.auth.selectedType, "oauth-personal");
    assert.equal(settings.selectedAuthType, "oauth-personal");
    assert.equal(settings.security.auth.vertexAi, undefined);
  } finally {
    delete process.env.STARK_GEMINI_AUTH;
    delete process.env.STARK_GEMINI_VERTEX_PROJECT;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// withGeminiSession (gemini)
// ---------------------------------------------------------------------------

test("withGeminiSession: creates a home and cleans it up", async () => {
  let captured = "";
  await withGeminiSession("agentutil-sess-", "/tmp/proj", "t", undefined, (home) => {
    captured = home;
    assert.ok(fs.existsSync(home));
  });
  assert.equal(fs.existsSync(captured), false);
});

test("withGeminiSession: cleans up even when the body throws", async () => {
  let captured = "";
  await assert.rejects(
    withGeminiSession("agentutil-sess-", "/tmp/proj", "t", undefined, (home) => {
      captured = home;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(fs.existsSync(captured), false);
});

// ---------------------------------------------------------------------------
// makeGeminiEnv (gemini)
// ---------------------------------------------------------------------------

test("makeGeminiEnv: sets GEMINI_CLI_HOME, keeps PATH, no trust by default", () => {
  const env = makeGeminiEnv("/tmp/h");
  assert.equal(env.GEMINI_CLI_HOME, "/tmp/h");
  assert.ok(!("GEMINI_CLI_TRUST_WORKSPACE" in env));
  assert.ok("PATH" in env);
});

test("makeGeminiEnv: trustWorkspace opt-in", () => {
  const env = makeGeminiEnv("/tmp/h", { trustWorkspace: true });
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, "true");
});

test("makeGeminiEnv: vertex mode forces Vertex AI env, overrides a host regional pin", () => {
  const prev = process.env.GOOGLE_CLOUD_LOCATION;
  process.env.STARK_GEMINI_AUTH = "vertex";
  // Pin the project explicitly. Without it `resolveVertexProject` falls through
  // to the host's `gcloud config get-value project`, so these assertions passed
  // only on a machine with gcloud configured — green here, red on any CI runner
  // and on a fresh checkout. The env var is precedence #1, so this exercises the
  // same code path deterministically.
  process.env.STARK_GEMINI_VERTEX_PROJECT = "test-vertex-project";
  process.env.GOOGLE_CLOUD_LOCATION = "us-east1";
  try {
    const env = makeGeminiEnv("/tmp/h");
    assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, "true");
    assert.ok(env.GOOGLE_CLOUD_PROJECT);
    assert.equal(env.GOOGLE_CLOUD_LOCATION, "global");
  } finally {
    delete process.env.STARK_GEMINI_AUTH;
    delete process.env.STARK_GEMINI_VERTEX_PROJECT;
    if (prev === undefined) delete process.env.GOOGLE_CLOUD_LOCATION;
    else process.env.GOOGLE_CLOUD_LOCATION = prev;
  }
});

test("makeGeminiEnv: oauth mode keeps Vertex env out, keeps licensing project", () => {
  process.env.STARK_GEMINI_AUTH = "oauth";
  // Same reason as the vertex tests: oauth mode still resolves a project (it is
  // the Code Assist licensing project), so without this the assertion depends on
  // the host's gcloud config.
  process.env.STARK_GEMINI_VERTEX_PROJECT = "test-vertex-project";
  try {
    const env = makeGeminiEnv("/tmp/h");
    assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.ok(env.GOOGLE_CLOUD_PROJECT, "Code Assist licensing project must survive");
  } finally {
    delete process.env.STARK_GEMINI_AUTH;
    delete process.env.STARK_GEMINI_VERTEX_PROJECT;
  }
});

test("makeGeminiEnv: strips Anthropic auth vars", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevAgents = process.env.ANTHROPIC_AGENTS;
  process.env.ANTHROPIC_API_KEY = "sk-ant-leak";
  process.env.ANTHROPIC_AGENTS = "sk-ant-src";
  try {
    const env = makeGeminiEnv("/tmp/h");
    assert.ok(!("ANTHROPIC_API_KEY" in env));
    assert.ok(!("ANTHROPIC_AGENTS" in env));
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevAgents === undefined) delete process.env.ANTHROPIC_AGENTS;
    else process.env.ANTHROPIC_AGENTS = prevAgents;
  }
});

test("GEMINI_MODEL: non-empty string", () => {
  assert.ok(typeof GEMINI_MODEL === "string" && GEMINI_MODEL.length > 0);
});
