import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  _resetAgentPortCacheForTests,
  _resetTokenCacheForTests,
  buildReviewBody,
  loadAgentPort,
  renderAgentsResolvedSummary,
  resolveAgentPorts,
  selectPostingAgent,
  tokenForAgent,
} from "./stark_review.ts";
import * as agentClaude from "./agent_claude.ts";
import * as agentGemini from "./agent_gemini.ts";
import type { Finding } from "./stark_review_lib.ts";

// ─── Phase 3 contracts: codex port stays available ──────────────────────────

test("loadAgentPort: returns codex port that builds a valid command", async () => {
  _resetAgentPortCacheForTests();
  const port = await loadAgentPort("codex");
  const built = port.buildCommand("hi");
  assert.equal(built.cmd, "codex");
  assert.ok(built.args.includes("--json"));
});

test("loadAgentPort: caches modules across calls", async () => {
  _resetAgentPortCacheForTests();
  const a = await loadAgentPort("codex");
  const b = await loadAgentPort("codex");
  assert.equal(a, b);
});

test("agent modules import without throwing", () => {
  assert.equal(typeof agentClaude.buildCommand, "function");
  assert.equal(typeof agentGemini.buildCommand, "function");
});

test("resolveAgentPorts: succeeds for mixed-agent run with real ports", async () => {
  _resetAgentPortCacheForTests();
  const map = await resolveAgentPorts({
    architecture: "codex",
    security: "claude",
    performance: "gemini",
  });
  assert.equal(map.size, 3);
  assert.ok(map.has("codex"));
  assert.ok(map.has("claude"));
  assert.ok(map.has("gemini"));
});

// ─── Task 8-1: agent_claude.ts port ─────────────────────────────────────────

test("agent_claude: buildCommand emits claude CLI argv with model pinning", () => {
  const built = agentClaude.buildCommand("hello", "claude-opus-4-7");
  assert.equal(built.cmd, "claude");
  assert.deepEqual(built.args, [
    "-p", "-",
    "--output-format", "json",
    "--model", "claude-opus-4-7",
    "--no-session-persistence",
  ]);
  assert.equal(built.stdin, "hello");
  // Forbidden tokens never reach the agent CLI env.
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "STARK_PUSH_TOKEN"]) {
    assert.ok(!(k in built.env), `forbidden ${k} in built.env`);
  }
});

test("agent_claude: buildCommand defaults to pinned CLAUDE_DEFAULT_MODEL", () => {
  const built = agentClaude.buildCommand("hi");
  const i = built.args.indexOf("--model");
  assert.ok(i >= 0);
  assert.equal(built.args[i + 1], agentClaude.CLAUDE_DEFAULT_MODEL);
});

test("agent_claude: parseOutput unwraps JSON envelope and parses JSONL findings", () => {
  const finding = {
    domain: "security", severity: "high", title: "X",
  };
  const stdout = JSON.stringify({
    type: "result", subtype: "success",
    result: JSON.stringify(finding),
  });
  const { findings, parseErrors } = agentClaude.parseOutput(stdout);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
  assert.equal(findings[0].agent, "claude");
});

test("agent_claude: parseOutput tolerates malformed records", () => {
  const stdout = JSON.stringify({
    result: '{ not valid json\n{"domain":"d","severity":"x","title":"t"}',
  });
  const { findings, parseErrors } = agentClaude.parseOutput(stdout);
  assert.equal(findings.length, 0);
  assert.ok(parseErrors.length >= 1);
});

// ─── Task 8-2: agent_gemini.ts port ─────────────────────────────────────────

test("agent_gemini: buildCommand emits gemini -o json with model and stdin prompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemtest-"));
  try {
    const built = agentGemini.buildCommand("hi", "gemini-3.1-pro-preview", { cwd: tmp });
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
    const projects = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "projects.json"), "utf8"),
    );
    assert.ok(tmp in projects.projects, `dispatch cwd ${tmp} must be registered`);
    // Settings.json forces Vertex AI when no GEMINI_API_KEY.
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    if (process.env.GEMINI_API_KEY) {
      assert.equal(settings.selectedAuthType, "gemini-api-key");
    } else {
      assert.equal(settings.selectedAuthType, "vertex-ai");
      assert.equal(built.env.GOOGLE_GENAI_USE_VERTEXAI, "true");
      assert.equal(built.env.GOOGLE_CLOUD_LOCATION, "global");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent_gemini: API-key fallback disables Vertex env", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemtest-"));
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

// ─── Task 8-3 / 8-4: per-agent token + receipt visibility ───────────────────

test("tokenForAgent: caches per process and surfaces failures", async () => {
  _resetTokenCacheForTests();
  let calls = 0;
  const fakeSpawn = async () => {
    calls++;
    return { stdout: "ghs_fake_token_123\n", stderr: "", status: 0 };
  };
  const t1 = await tokenForAgent("codex", { repo: "o/r", spawnFn: fakeSpawn });
  const t2 = await tokenForAgent("codex", { repo: "o/r", spawnFn: fakeSpawn });
  assert.equal(t1, "ghs_fake_token_123");
  assert.equal(t1, t2);
  assert.equal(calls, 1, "token must be cached after first resolution");
});

test("tokenForAgent: throws on subprocess failure", async () => {
  _resetTokenCacheForTests();
  const fakeSpawn = async () => ({ stdout: "", stderr: "boom", status: 1 });
  await assert.rejects(
    tokenForAgent("claude", { repo: "o/r", spawnFn: fakeSpawn }),
    /tokenForAgent\(claude\) failed/,
  );
});

test("renderAgentsResolvedSummary: emits per-domain agent list", () => {
  const out = renderAgentsResolvedSummary({
    security: "claude", performance: "codex", architecture: "gemini",
  });
  assert.match(out, /## agents_resolved/);
  assert.match(out, /`security` → `claude`/);
  assert.match(out, /`performance` → `codex`/);
  assert.match(out, /`architecture` → `gemini`/);
});

test("buildReviewBody: includes agents_resolved summary for mixed resolved-agent runs", () => {
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "claude", performance: "codex" },
  });
  assert.match(body, /## agents_resolved/);
  assert.match(body, /security.*claude/s);
  assert.match(body, /performance.*codex/s);
});

test("buildReviewBody: includes agents_resolved when one agent yields zero findings", () => {
  // Mixed domain_agents but only one agent produced findings — Task 8-4
  // requires the per-domain agents_resolved summary to remain visible.
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "claude", performance: "codex" },
  });
  assert.match(body, /## agents_resolved/, "must show even when no findings span agents");
});

test("buildReviewBody: omits agents_resolved for single-agent runs", () => {
  const body = buildReviewBody("MARKER", "summary", [], {
    agentsResolved: { security: "codex", performance: "codex" },
  });
  assert.doesNotMatch(body, /## agents_resolved/);
});

test("buildReviewBody: rendering is back-compatible without agentsResolved", () => {
  const body = buildReviewBody("MARKER", "summary", []);
  assert.match(body, /^MARKER\n\nsummary/);
  assert.doesNotMatch(body, /agents_resolved/);
});

test("selectPostingAgent: majority wins; ties broken by lexicographic order", () => {
  const findings = (agents: string[]): Finding[] =>
    agents.map((a, i) => ({
      id: String(i), domain: "d",
      agent: a as Finding["agent"],
      severity: "low", file: null, line: null,
      title: "t", body: "",
    }));
  assert.equal(selectPostingAgent(findings(["codex", "codex", "claude"])), "codex");
  // tie: claude / codex (one each) — lexicographic 'claude' < 'codex'
  assert.equal(selectPostingAgent(findings(["codex", "claude"])), "claude");
  assert.equal(selectPostingAgent([]), null);
});

// ─── Task 8-4: classifyOne envelope unwrapping (final blocker) ──────────────

test("classifyOne: parses classification through gemini -o json envelope", async () => {
  // This is the final wing-blocker fix: classifyOne must use the agent port's
  // parser/normalizer to extract classification, otherwise gemini-as-classifier
  // sees `{"response":"..."}` and fails to find `"classification"`.
  const { runClassifier } = await import("./stark_review.ts");
  const geminiPort = await loadAgentPort("gemini");
  const finding: Finding = {
    id: "f1", domain: "security", agent: "codex",
    severity: "high", file: null, line: null,
    title: "title", body: "body",
  };
  const fakeSpawn = async () => ({
    stdout: JSON.stringify({
      response: JSON.stringify({ classification: "fix", reason: "real bug" }),
    }),
    stderr: "",
    status: 0,
  });
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
  try {
    const result = await runClassifier([finding], {
      worktree: wt,
      classifierAgent: "gemini",
      ports: new Map([["gemini", geminiPort]]),
      classifierPrompt: "classify",
      spawnFn: fakeSpawn,
      config: {
        quick_domains: [], default_agent: "gemini",
        domain_agents: {}, severity_overrides: {}, fix_threshold: "medium",
        runtime: {
          lock_ttl_minutes: 30, subagent_env_allowlist: ["PATH", "HOME"],
          max_concurrent_agents: 1, temp_dir_prefix: "stark-test",
          large_pr_file_threshold: 40, large_pr_line_threshold: 3000,
          large_pr_timeout_s: 1800,
        },
        test_command: null, untrusted_fix_loop: false,
        history_retention_days: 0, lock_ttl_minutes: 30,
      },
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, "fix");
    assert.equal(result.findings[0].classification_reason, "real bug");
    assert.equal(result.events.length, 0);
    assert.equal(result.aborted, false);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("classifyOne: parses classification through claude --output-format json envelope", async () => {
  const { runClassifier } = await import("./stark_review.ts");
  const port = await loadAgentPort("claude");
  const finding: Finding = {
    id: "f1", domain: "security", agent: "codex",
    severity: "high", file: null, line: null,
    title: "title", body: "body",
  };
  const fakeSpawn = async () => ({
    stdout: JSON.stringify({
      type: "result", subtype: "success",
      result: JSON.stringify({ classification: "noise", reason: "low impact" }),
    }),
    stderr: "",
    status: 0,
  });
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
  try {
    const result = await runClassifier([finding], {
      worktree: wt,
      classifierAgent: "claude",
      ports: new Map([["claude", port]]),
      classifierPrompt: "classify",
      spawnFn: fakeSpawn,
      config: {
        quick_domains: [], default_agent: "claude",
        domain_agents: {}, severity_overrides: {}, fix_threshold: "medium",
        runtime: {
          lock_ttl_minutes: 30, subagent_env_allowlist: ["PATH", "HOME"],
          max_concurrent_agents: 1, temp_dir_prefix: "stark-test",
          large_pr_file_threshold: 40, large_pr_line_threshold: 3000,
          large_pr_timeout_s: 1800,
        },
        test_command: null, untrusted_fix_loop: false,
        history_retention_days: 0, lock_ttl_minutes: 30,
      },
    });
    assert.equal(result.findings[0].classification, "noise");
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
