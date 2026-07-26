// Tests for `tools/stark_config_lib.ts` — the minimal config-loader
// subset preflight depends on. Covers the security model (locked-fields
// and the deep-merge semantics.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DEFAULT_MODELS,
  DEFAULT_MODEL_LIMITS,
  DEFAULT_MODEL_RATES,
  DEFAULT_RUNTIME,
  discoverConfig,
  getContextCompactionConfig,
  getCostConfig,
  getModelId,
  getModelLimit,
  getModelLimits,
  getModelRates,
  getModelsConfig,
  getRuntimeConfig,
  getSelfHealConfig,
  getSkillActivationConfig,
  getValidationGateConfig,
  getWriteSpecConfig,
  isAgentEnabled,
  loadGlobalConfig,
} from "./stark_config_lib.ts";

async function withScratchHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stark-config-test-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = scratch;
  try {
    return await fn(scratch);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function writeGlobalConfig(home: string, config: unknown): void {
  const file = path.join(home, ".claude", "code-review", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------

test("loadGlobalConfig: returns {} when config file is absent", async () => {
  await withScratchHome(() => {
    assert.deepEqual(loadGlobalConfig(), {});
  });
});

test("loadGlobalConfig: returns {} on parse error (and warns)", async () => {
  await withScratchHome((home) => {
    const file = path.join(home, ".claude", "code-review", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json{");
    assert.deepEqual(loadGlobalConfig(), {});
  });
});

test("loadGlobalConfig: returns {} when top-level value isn't an object", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, ["array", "not", "object"]);
    assert.deepEqual(loadGlobalConfig(), {});
  });
});

test("loadGlobalConfig: returns the parsed object when valid", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, { foo: 1, bar: { baz: 2 } });
    assert.deepEqual(loadGlobalConfig(), { foo: 1, bar: { baz: 2 } });
  });
});

// ---------------------------------------------------------------------------
// getModelsConfig + isAgentEnabled
// ---------------------------------------------------------------------------

test("getModelsConfig: returns DEFAULT_MODELS when no global override", async () => {
  await withScratchHome(() => {
    const models = getModelsConfig();
    assert.deepEqual(models, DEFAULT_MODELS);
  });
});

test("getModelsConfig: partial override merges nested keys (preserves model_id)", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, {
      models: { gemini: { enabled: false } },
    });
    const models = getModelsConfig();
    assert.equal(models["gemini"]!.enabled, false);
    // model_id from DEFAULT_MODELS must survive partial override.
    assert.equal(models["gemini"]!.model_id, "gemini-3.1-pro-preview");
    // Other agents untouched.
    assert.equal(models["claude"]!.enabled, true);
    assert.equal(models["codex"]!.enabled, true);
  });
});

test("isAgentEnabled: returns false for unknown agent (defensive)", async () => {
  await withScratchHome(() => {
    assert.equal(isAgentEnabled("nonexistent"), false);
  });
});

test("isAgentEnabled: reflects override", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, { models: { gemini: { enabled: false } } });
    assert.equal(isAgentEnabled("gemini"), false);
    assert.equal(isAgentEnabled("claude"), true);
  });
});

// ---------------------------------------------------------------------------
// getModelRates
// ---------------------------------------------------------------------------

test("getModelRates: returns DEFAULT_MODEL_RATES when no override", async () => {
  await withScratchHome(() => {
    assert.deepEqual(getModelRates(), DEFAULT_MODEL_RATES);
  });
});

test("getModelRates: extra entries from global config are merged in", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, {
      model_rates: {
        "custom-model": { input_per_1m_usd: 7, output_per_1m_usd: 21 },
      },
    });
    const rates = getModelRates();
    assert.deepEqual(rates["custom-model"], {
      input_per_1m_usd: 7,
      output_per_1m_usd: 21,
    });
    // Defaults survive.
    assert.deepEqual(rates["gpt-5.5-pro"], {
      input_per_1m_usd: 25,
      output_per_1m_usd: 100,
    });
  });
});

test("getModelLimit: gpt-5.5-pro returns its verified 128k/1.05M limits", async () => {
  await withScratchHome(() => {
    assert.deepEqual(getModelLimit("gpt-5.5-pro"), {
      max_output_tokens: 128_000,
      context_window: 1_050_000,
    });
  });
});

test("getModelLimit: unknown model falls back to the conservative floor", async () => {
  await withScratchHome(() => {
    assert.deepEqual(getModelLimit("no-such-model"), DEFAULT_MODEL_LIMITS._fallback);
  });
});

test("getModelLimits: global config override merges over defaults", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, {
      model_limits: {
        "custom-model": { max_output_tokens: 4096, context_window: 32000 },
      },
    });
    const limits = getModelLimits();
    assert.deepEqual(limits["custom-model"], {
      max_output_tokens: 4096,
      context_window: 32000,
    });
    // Verified default survives the merge.
    assert.deepEqual(limits["gpt-5.5-pro"], {
      max_output_tokens: 128_000,
      context_window: 1_050_000,
    });
  });
});

// ---------------------------------------------------------------------------
// discoverConfig — preflight only reads `agents`, so that's what we test
// ---------------------------------------------------------------------------

test("discoverConfig: returns empty when no config files anywhere", async () => {
  await withScratchHome(async (home) => {
    const prevCwd = process.cwd();
    const sub = path.join(home, "empty-repo");
    fs.mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    try {
      assert.deepEqual(discoverConfig(), {});
    } finally {
      process.chdir(prevCwd);
    }
  });
});

test("discoverConfig: repo .code-review/config.json wins over global", async () => {
  await withScratchHome(async (home) => {
    writeGlobalConfig(home, { agents: ["claude", "codex"] });
    const repoDir = path.join(home, "fake-repo");
    fs.mkdirSync(path.join(repoDir, ".code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ agents: ["codex"] }),
    );
    const prevCwd = process.cwd();
    process.chdir(repoDir);
    try {
      const cfg = discoverConfig();
      // Repo-level array replaces global (REPLACE field semantics).
      assert.deepEqual(cfg["agents"], ["codex"]);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

test("discoverConfig: keys not present at the more-specific layer fall through to global", async () => {
  await withScratchHome(async (home) => {
    writeGlobalConfig(home, { agents: ["claude"], other_key: "from-global" });
    const repoDir = path.join(home, "fake-repo");
    fs.mkdirSync(path.join(repoDir, ".code-review"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".code-review", "config.json"),
      JSON.stringify({ agents: ["codex"] }),
    );
    const prevCwd = process.cwd();
    process.chdir(repoDir);
    try {
      const cfg = discoverConfig();
      assert.equal(cfg["other_key"], "from-global");
      assert.deepEqual(cfg["agents"], ["codex"]);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3a — section accessors + getModelId (full config_loader.py port)
// ---------------------------------------------------------------------------

test("getModelId: returns the configured model id, null for unknown agent", async () => {
  await withScratchHome(() => {
    assert.equal(getModelId("claude"), "claude-opus-5[1m]");
    assert.equal(getModelId("nonexistent"), null);
  });
});

test("getModelId: reflects a global override", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, { models: { codex: { model_id: "gpt-9" } } });
    assert.equal(getModelId("codex"), "gpt-9");
  });
});

test("section accessors: return their DEFAULT_* when no override", async () => {
  await withScratchHome(() => {
    assert.deepEqual(getRuntimeConfig(), DEFAULT_RUNTIME);
    assert.equal(getSelfHealConfig().mode, "suggest");
    assert.equal(getValidationGateConfig().timeout_seconds, 60);
    assert.equal(getSkillActivationConfig().max_suggestions, 2);
    assert.equal(getContextCompactionConfig().checkpoint_interval_minutes, 15);
    assert.equal(getCostConfig().hard_stop_usd, 100);
  });
});

test("getRuntimeConfig: partial override merges, sibling defaults survive", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, { runtime: { max_concurrent_agents: 8 } });
    const cfg = getRuntimeConfig();
    assert.equal(cfg.max_concurrent_agents, 8);
    // Untouched defaults survive the partial override.
    assert.equal(cfg.lock_ttl_minutes, 30);
    assert.equal(cfg.temp_dir_prefix, "stark-env");
  });
});

test("test_write_spec_config_defaults: concrete defaults with no config file", async () => {
  await withScratchHome(() => {
    const cfg = getWriteSpecConfig();
    assert.equal(cfg.lead_agent, "claude");
    assert.equal(cfg.wing_agent, "codex");
    assert.equal(cfg.wing_reasoning_effort, "xhigh");
    assert.equal(cfg.max_rounds, 3);
    assert.equal(cfg.timeout_s, 900);
    assert.equal(cfg.wing_timeout_s, 600);
    assert.equal(cfg.max_input_chars, 200000);
    assert.equal(cfg.history_keep_runs, 20);
    assert.equal(cfg.open_pr, true);
  });
});

test("getWriteSpecConfig: partial override deep-merges, sibling defaults survive", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, { write_spec: { max_rounds: 5, open_pr: false } });
    const cfg = getWriteSpecConfig();
    assert.equal(cfg.max_rounds, 5);
    assert.equal(cfg.open_pr, false);
    // Untouched defaults survive the partial override.
    assert.equal(cfg.lead_agent, "claude");
    assert.equal(cfg.wing_agent, "codex");
    assert.equal(cfg.wing_reasoning_effort, "xhigh");
    assert.equal(cfg.timeout_s, 900);
    assert.equal(cfg.wing_timeout_s, 600);
    assert.equal(cfg.max_input_chars, 200000);
    assert.equal(cfg.history_keep_runs, 20);
  });
});

test("getValidationGateConfig: surfaces extra keys like per_repo_commands", async () => {
  await withScratchHome((home) => {
    writeGlobalConfig(home, {
      validation_gate: { per_repo_commands: { _default: { test_cmd: "npm test" } } },
    });
    const cfg = getValidationGateConfig() as Record<string, unknown>;
    assert.deepEqual(cfg["per_repo_commands"], {
      _default: { test_cmd: "npm test" },
    });
    // Default fields still present.
    assert.equal((cfg as { timeout_seconds: number }).timeout_seconds, 60);
  });
});

// ---------------------------------------------------------------------------
// CLI — `--model <agent>` (consumed by stark-phase-execute's goal loop)
// ---------------------------------------------------------------------------

test("CLI: --model prints the resolved id; unknown agent exits 1 with no stdout", () => {
  const cli = path.join(import.meta.dirname, "stark_config_lib.ts");
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-cli-"));
  fs.writeFileSync(
    path.join(pluginRoot, "config.json"),
    JSON.stringify({ models: { claude: { enabled: true, model_id: "test-model-id" } } }),
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });

  const ok = run(["--model", "claude"]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "test-model-id");

  // Unknown agent → exit 1 and empty stdout, so a caller's
  // `$(… || echo <fallback>)` guard actually fires.
  const missing = run(["--model", "nonexistent"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");

  // --help stays side-effect-free and exits cleanly (skill smoke-test contract).
  assert.equal(run(["--help"]).status, 0);
});
