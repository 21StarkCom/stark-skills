// Tests for `tools/runtime_env_lib.ts` — the subagent environment
// builder ported from `scripts/runtime_env.py`. Only the non-review
// (no GitHub App token) paths are exercised so tests stay offline.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgentEnv,
  cleanupStaleTempDirs,
  makeTempDir,
} from "./runtime_env_lib.ts";

/**
 * Run `fn` against a scratch HOME holding exactly the given global config.
 *
 * Without this, `buildAgentEnv` → `getRuntimeConfig()` → `loadGlobalConfig()`
 * reads whatever `~/.claude/code-review/config.json` happens to be on the host:
 * a symlink into this repo on a dev Mac, absent in CI. That made the suite's
 * config source machine-dependent and left both `subagent_env_allowlist`
 * defaults completely unexercised — the three `buildAgentEnv` assertions passed
 * under either config because they only check that a key `BLOCKED_KEYS` already
 * removes unconditionally is absent.
 *
 * CLAUDE_PLUGIN_ROOT is cleared too: `assetConfigPath()` prefers it over HOME,
 * so leaving it set would silently defeat the isolation.
 */
async function withConfigHome<T>(
  config: unknown,
  fn: (home: string) => Promise<T> | T,
): Promise<T> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stark-runtime-env-test-"));
  const dir = path.join(scratch, ".claude", "code-review");
  fs.mkdirSync(dir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  }
  const prevHome = process.env["HOME"];
  const prevPluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  process.env["HOME"] = scratch;
  delete process.env["CLAUDE_PLUGIN_ROOT"];
  try {
    return await fn(scratch);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevPluginRoot === undefined) delete process.env["CLAUDE_PLUGIN_ROOT"];
    else process.env["CLAUDE_PLUGIN_ROOT"] = prevPluginRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// makeTempDir
// ---------------------------------------------------------------------------

test("makeTempDir: creates a 0700 dir under the given prefix", () => {
  const dir = makeTempDir("stark-env-test");
  try {
    const st = fs.statSync(dir);
    assert.ok(st.isDirectory());
    assert.equal(st.mode & 0o777, 0o700);
    assert.match(dir, new RegExp(`/tmp/stark-env-test-${process.pid}-[0-9a-f]{8}$`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cleanupStaleTempDirs
// ---------------------------------------------------------------------------

test("cleanupStaleTempDirs: removes a dir owned by a dead PID, keeps a live one", () => {
  const prefix = `stark-cleanup-test-${process.pid}`;
  // Dead PID — astronomically high, past any kernel cap.
  const deadDir = `/tmp/${prefix}-999999999-deadbeef`;
  // Live PID — this process.
  const liveDir = `/tmp/${prefix}-${process.pid}-livebeef`;
  fs.mkdirSync(deadDir, { recursive: true });
  fs.mkdirSync(liveDir, { recursive: true });
  try {
    cleanupStaleTempDirs(prefix);
    assert.equal(fs.existsSync(deadDir), false, "dead-PID dir should be removed");
    assert.equal(fs.existsSync(liveDir), true, "live-PID dir should survive");
  } finally {
    fs.rmSync(deadDir, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildAgentEnv
// ---------------------------------------------------------------------------

test("buildAgentEnv: codex/local → no Anthropic key, sanitized, has tmpdir", async () => {
  const resolved = await withEnv({ ANTHROPIC_AGENTS: "secret-key" }, () =>
    buildAgentEnv("codex", "local"),
  );
  assert.equal(resolved["ANTHROPIC_API_KEY"], undefined);
  assert.equal(resolved["ANTHROPIC_AGENTS"], undefined, "source var must not leak");
  assert.equal(resolved["GH_TOKEN"], undefined, "no bot token for non-review ops");
  assert.ok(resolved["STARK_AGENT_TMPDIR"], "tmpdir injected");
  fs.rmSync(resolved["STARK_AGENT_TMPDIR"], { recursive: true, force: true });
});

test("buildAgentEnv: claude/local subscription mode (default) → no ANTHROPIC_API_KEY", async () => {
  const resolved = await withEnv(
    { STARK_CLAUDE_AUTH: "subscription", ANTHROPIC_AGENTS: "secret-key" },
    () => buildAgentEnv("claude", "local"),
  );
  assert.equal(resolved["ANTHROPIC_API_KEY"], undefined, "subscription mode must not inject the key");
  assert.equal(resolved["ANTHROPIC_AGENTS"], undefined, "source var must not leak");
  fs.rmSync(resolved["STARK_AGENT_TMPDIR"], { recursive: true, force: true });
});

test("buildAgentEnv: claude/local never injects ANTHROPIC_API_KEY, whatever the host sets", async () => {
  // The metered-API mode is gone: a legacy STARK_CLAUDE_AUTH=api must not
  // resurrect key injection, and a set-but-unused ANTHROPIC_AGENTS must not
  // leak or make dispatch throw.
  const resolved = await withEnv(
    { STARK_CLAUDE_AUTH: "api", ANTHROPIC_AGENTS: "secret-key", ANTHROPIC_API_KEY: "sk-stale" },
    () => buildAgentEnv("claude", "local"),
  );
  assert.equal(resolved["ANTHROPIC_API_KEY"], undefined, "no key injection in subscription-only mode");
  assert.equal(resolved["ANTHROPIC_AGENTS"], undefined, "source var must not leak");
  fs.rmSync(resolved["STARK_AGENT_TMPDIR"], { recursive: true, force: true });
});

test("buildAgentEnv: claude with no ANTHROPIC_AGENTS → succeeds (OAuth dispatch)", async () => {
  const resolved = await withEnv({ STARK_CLAUDE_AUTH: undefined, ANTHROPIC_AGENTS: undefined }, () =>
    buildAgentEnv("claude", "local"),
  );
  assert.equal(resolved["ANTHROPIC_API_KEY"], undefined);
  assert.ok(resolved["HOME"], "HOME carried so the CLI finds its OAuth credentials");
  fs.rmSync(resolved["STARK_AGENT_TMPDIR"], { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// allowlist floor — under REAL config isolation, so the assertion is about the
// config layering rather than about whatever config the host happens to have
// ---------------------------------------------------------------------------

test("buildAgentEnv: a config allowlist that omits USER cannot strip it", async () => {
  // The regression this pins: `deepMerge` replaces arrays wholesale, so a
  // config trimming the list used to drop USER outright — and the claude CLI
  // then fails with "Not logged in · Please run /login" with nothing naming
  // the env as the cause. The default is a floor; config only extends it.
  await withConfigHome(
    { runtime: { subagent_env_allowlist: ["PATH", "HOME"] } },
    async (home) => {
      const resolved = await withEnv(
        { USER: "someone", CUSTOM_THING: "kept" },
        () => buildAgentEnv("claude", "implement"),
      );
      assert.equal(
        (await resolved)["USER"],
        "someone",
        "USER must survive a config allowlist that omits it",
      );
      assert.ok(home);
    },
  );
});

test("buildAgentEnv: an allowlisted credential is still withheld", async () => {
  // Defense in depth: the allowlist is user-editable data whose file is
  // symlinked into this repo, so a config layer must not be able to re-arm
  // credential forwarding into a subprocess that ingests untrusted diff text.
  await withConfigHome(
    {
      runtime: {
        subagent_env_allowlist: ["PATH", "HOME", "USER", "GH_TOKEN", "ANTHROPIC_AGENTS"],
      },
    },
    async () => {
      const resolved = await withEnv(
        { GH_TOKEN: "ghp_leak", ANTHROPIC_AGENTS: "sk-ant-leak" },
        () => buildAgentEnv("claude", "implement"),
      );
      const env = await resolved;
      assert.equal(env["GH_TOKEN"], undefined, "GH_TOKEN must not be forwarded");
      assert.equal(env["ANTHROPIC_AGENTS"], undefined, "Anthropic key must not be forwarded");
      fs.rmSync(env["STARK_AGENT_TMPDIR"]!, { recursive: true, force: true });
    },
  );
});
