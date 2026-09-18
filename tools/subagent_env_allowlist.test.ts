// Parity guard for `subagent_env_allowlist`, which is declared in three
// independent places:
//
//   1. `global/config.json`                        — the shipped data
//   2. `stark_config_lib.ts::DEFAULT_RUNTIME`      — the no-config default
//   3. `agent_dispatch_lib.ts::DEFAULT_RUNTIME_ALLOWLIST` — the dispatch default
//
// Nothing pinned them together, and they were already divergent (8 entries vs
// 6) with `npm test` green: `stark_config_lib.test.ts` compares
// `getRuntimeConfig()` to `DEFAULT_RUNTIME` under a scratch HOME, so it passes
// no matter what the shipped JSON says. The failure that costs a session is
// dropping USER from one copy only — a dispatch keeps working while a no-config
// cron invocation fails every claude dispatch with "Not logged in · Please run
// /login" and nothing pointing at the env.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AGENT_ENV_ALLOWLIST, isCredentialEnvKey } from "./agent_env_lib.ts";
import { DEFAULT_RUNTIME_ALLOWLIST } from "./agent_dispatch_lib.ts";
import { DEFAULT_RUNTIME } from "./stark_config_lib.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const runtime of ["claude", "codex"]) {
  test(`${runtime} dispatch scrubs Gemini credentials and preserves the process floor`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-env-parity-"));
    try {
      const toolDir = path.join(root, "tools");
      fs.mkdirSync(toolDir);
      for (const source of [path.join(REPO_ROOT, "tools"), ...(runtime === "codex" ? [path.join(REPO_ROOT, "runtime-overrides/codex/tools")] : [])]) {
        for (const name of fs.readdirSync(source)) {
          if (name.endsWith(".ts") && !name.endsWith(".test.ts")) fs.copyFileSync(path.join(source, name), path.join(toolDir, name));
        }
      }
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ runtime: { subagent_env_allowlist: ["GH_TOKEN"] } }));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { makeGeminiEnv, buildAgentEnv, releaseAgentTempDir } from "./tools/agent_dispatch_lib.ts";
        import { pickAllowlistedEnv } from "./tools/agent_env_lib.ts";
        const source = { USER: "fixture-user", GH_TOKEN: "fixture-github", OPENAI_API_KEY: "fixture-openai", EXAMPLE_SECRET: "fixture-secret",
          DATABASE_URL: "fixture-database", TEST_DATABASE_URL: "fixture-test-database" };
        assert.deepEqual(pickAllowlistedEnv(source, Object.keys(source)), { USER: "fixture-user" });
        const gemini = makeGeminiEnv("/tmp/fixture-gemini");
        for (const key of ["GH_TOKEN", "OPENAI_API_KEY", "EXAMPLE_SECRET"]) assert.equal(gemini[key], undefined, key);
        assert.equal(gemini.USER, "fixture-user");
        const child = await buildAgentEnv("codex", "review");
        try {
          assert.equal(child.env.USER, "fixture-user");
          assert.ok(child.env.PATH);
          assert.equal(child.env.GH_TOKEN, undefined);
        } finally { releaseAgentTempDir(child.tempDir); }
        console.log("credential filtering and process floor passed");
      `], {
        cwd: root, encoding: "utf8", timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: "fixture-user", LANG: "en_US.UTF-8",
          STARK_ASSET_ROOT: root, CLAUDE_PLUGIN_ROOT: root, STARK_GEMINI_AUTH: "oauth", STARK_GEMINI_VERTEX_PROJECT: "fixture-project",
          GH_TOKEN: "fixture-github", OPENAI_API_KEY: "fixture-openai", EXAMPLE_SECRET: "fixture-secret" },
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout, /credential filtering and process floor passed/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

function shippedAllowlist(): string[] {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "global", "config.json"), "utf8");
  const cfg = JSON.parse(raw) as {
    runtime?: { subagent_env_allowlist?: unknown };
  };
  const list = cfg.runtime?.subagent_env_allowlist;
  assert.ok(Array.isArray(list), "global/config.json has no runtime.subagent_env_allowlist");
  return list as string[];
}

test("the two TS defaults are the same list", () => {
  assert.deepEqual(
    [...DEFAULT_RUNTIME_ALLOWLIST],
    [...DEFAULT_RUNTIME.subagent_env_allowlist],
    "agent_dispatch_lib::DEFAULT_RUNTIME_ALLOWLIST and " +
      "stark_config_lib::DEFAULT_RUNTIME.subagent_env_allowlist must stay identical",
  );
});

test("the shipped config is a superset of the TS default", () => {
  // Superset, not equality: the defaults are a FLOOR that config extends
  // (both readers union rather than replace), so config may carry extra
  // entries — but it must never drop one the no-config path relies on.
  const shipped = new Set(shippedAllowlist());
  for (const key of DEFAULT_RUNTIME_ALLOWLIST) {
    assert.ok(
      shipped.has(key),
      `global/config.json omits ${key}, which the TS default guarantees`,
    );
  }
});

test("USER survives in every copy", () => {
  // Load-bearing, not cosmetic: without USER the claude CLI cannot resolve its
  // Keychain identity. Reproduction pinned in agent_env_lib.ts.
  assert.ok(DEFAULT_RUNTIME_ALLOWLIST.includes("USER"));
  assert.ok(DEFAULT_RUNTIME.subagent_env_allowlist.includes("USER"));
  assert.ok(AGENT_ENV_ALLOWLIST.includes("USER"));
  assert.ok(shippedAllowlist().includes("USER"));
});

test("no allowlist carries a headless-claude OAuth seat var", () => {
  // The claude CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN (+ _SCOPES)
  // alone. Allowlisting any of them forwards whatever the LAUNCHING shell
  // carries, which shadows a seat a dispatch site deliberately injected — the
  // subprocess then bills an account nobody chose. Rationale in
  // agent_env_lib.ts::AGENT_ENV_ALLOWLIST.
  //
  // The credential test below already covers the two `*_TOKEN` names via
  // isCredentialEnvKey; `_SCOPES` matches no credential pattern, so without
  // this test the rule holds for two names out of three.
  const banned = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  ];
  for (const [label, list] of [
    ["global/config.json", shippedAllowlist()],
    ["DEFAULT_RUNTIME_ALLOWLIST", [...DEFAULT_RUNTIME_ALLOWLIST]],
    ["DEFAULT_RUNTIME", [...DEFAULT_RUNTIME.subagent_env_allowlist]],
    ["AGENT_ENV_ALLOWLIST", [...AGENT_ENV_ALLOWLIST]],
  ] as const) {
    for (const key of banned) {
      assert.ok(
        !list.includes(key),
        `${label} allowlists ${key}; an ambient value would shadow an injected seat`,
      );
    }
  }
});

test("no allowlist ships a credential", () => {
  // The allowlists are data; a credential added to one would be forwarded to a
  // subprocess whose input is untrusted diff text. Cross-check every copy
  // against the denylist so the two mechanisms cannot contradict each other.
  for (const [label, list] of [
    ["global/config.json", shippedAllowlist()],
    ["DEFAULT_RUNTIME_ALLOWLIST", [...DEFAULT_RUNTIME_ALLOWLIST]],
    ["DEFAULT_RUNTIME", [...DEFAULT_RUNTIME.subagent_env_allowlist]],
    ["AGENT_ENV_ALLOWLIST", [...AGENT_ENV_ALLOWLIST]],
  ] as const) {
    for (const key of list) {
      assert.ok(
        !isCredentialEnvKey(key),
        `${label} allowlists credential-shaped key ${key}`,
      );
    }
  }
});

test("isCredentialEnvKey blocks the credentials that reach a gemini --yolo lead", () => {
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_ADMIN_TOKEN",
    "STARK_PUSH_TOKEN",
    "STARK_EXAMPLE_PRIVATE_KEY",
    "STARK_EXAMPLE_SECRET",
    "STARK_EXAMPLE_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AGENTS",
    "OPENAI_API_KEY",
  ]) {
    assert.ok(isCredentialEnvKey(key), `${key} must be treated as a credential`);
  }
});

test("isCredentialEnvKey keeps an agent's own model auth", () => {
  // Withholding these breaks dispatch instead of protecting anything: the
  // gemini path authenticates with them.
  for (const key of ["GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.ok(!isCredentialEnvKey(key), `${key} must stay available to gemini`);
  }
  // And ordinary process/config vars must not be swept up.
  for (const key of ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR"]) {
    assert.ok(!isCredentialEnvKey(key), `${key} is not a credential`);
  }
});
