// Tests for `tools/runtime_env_lib.ts` — the subagent environment
// builder ported from `scripts/runtime_env.py`. Only the non-review
// (no GitHub App token) paths are exercised so tests stay offline.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";

import {
  buildAgentEnv,
  cleanupStaleTempDirs,
  makeTempDir,
} from "./runtime_env_lib.ts";

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

test("buildAgentEnv: claude/local → ANTHROPIC_API_KEY injected from ANTHROPIC_AGENTS", async () => {
  const resolved = await withEnv({ ANTHROPIC_AGENTS: "secret-key" }, () =>
    buildAgentEnv("claude", "local"),
  );
  assert.equal(resolved["ANTHROPIC_API_KEY"], "secret-key");
  assert.equal(resolved["ANTHROPIC_AGENTS"], undefined, "source var must not leak");
  fs.rmSync(resolved["STARK_AGENT_TMPDIR"], { recursive: true, force: true });
});

test("buildAgentEnv: claude with no ANTHROPIC_AGENTS → throws", async () => {
  await withEnv({ ANTHROPIC_AGENTS: undefined }, async () => {
    await assert.rejects(
      () => buildAgentEnv("claude", "local"),
      /ANTHROPIC_AGENTS not set/,
    );
  });
});
