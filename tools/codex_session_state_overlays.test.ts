import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultBaseDir as alertBaseDir,
} from "../runtime-overrides/codex/tools/alert_delivery_lib.ts";
import {
  defaultBaseDir as healerBaseDir,
  defaultCircuitsPath,
  defaultConfigPath as healerConfigPath,
  defaultLogPath,
  defaultPatternsPath,
  cmdDemote,
  loadConfig as loadHealerConfig,
} from "../runtime-overrides/codex/tools/healer_canary_lib.ts";
import {
  collectAvailableSkills,
  collectBoard,
  collectHealerCategories,
  collectStart,
  realDeps,
  type Deps,
} from "../runtime-overrides/codex/tools/stark_session_lib.ts";
import {
  defaultConfigPath as routerConfigPath,
  defaultSkillUsagePath,
} from "../runtime-overrides/codex/tools/skill_router_lib.ts";

type EnvPatch = Record<string, string | undefined>;

async function withEnv<T>(patch: EnvPatch, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function stubDeps(run: Deps["run"]): Deps {
  return {
    home: "/users/codex",
    scriptsDir: "/plugin/scripts",
    toolsDir: "/plugin/tools",
    now: () => new Date("2026-08-05T00:00:00Z"),
    run,
    readFile: async () => null,
    fileExists: async () => false,
  };
}

test("Codex runtime overlays separate immutable assets from mutable state", async () => {
  await withEnv(
    {
      STARK_ASSET_ROOT: "/opt/stark-plugin",
      STARK_PLUGIN_ROOT: undefined,
      STARK_STATE_ROOT: "/var/tmp/stark-state",
    },
    () => {
      assert.equal(alertBaseDir(), "/var/tmp/stark-state");
      assert.equal(healerBaseDir(), "/var/tmp/stark-state");
      assert.equal(defaultCircuitsPath(), "/var/tmp/stark-state/healer-circuits.json");
      assert.equal(defaultLogPath(), "/var/tmp/stark-state/healer.jsonl");
      assert.equal(defaultSkillUsagePath(), "/var/tmp/stark-state/history/skill-usage.json");

      assert.equal(defaultPatternsPath(), "/opt/stark-plugin/scripts/healer_patterns.json");
      assert.equal(healerConfigPath(), "/var/tmp/stark-state/config.json");
      assert.equal(routerConfigPath(), "/opt/stark-plugin/config.json");
    },
  );
});

test("healer canary overlays mutable config without changing its packaged baseline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-healer-config-"));
  const assets = path.join(root, "plugin");
  const state = path.join(root, "state");
  fs.mkdirSync(assets, { recursive: true });
  const packaged = path.join(assets, "config.json");
  fs.writeFileSync(packaged, JSON.stringify({
    source: "packaged",
    self_heal: { circuit_breaker_threshold: 7, auto_patterns: ["safe-pattern"] },
  }));
  const before = fs.readFileSync(packaged);

  try {
    await withEnv(
      { STARK_ASSET_ROOT: assets, STARK_STATE_ROOT: state },
      () => {
        assert.deepEqual(loadHealerConfig().self_heal, {
          circuit_breaker_threshold: 7,
          auto_patterns: ["safe-pattern"],
        });
        assert.equal(cmdDemote("safe-pattern", {}).ok, true);
        assert.deepEqual(loadHealerConfig().self_heal, {
          circuit_breaker_threshold: 7,
          auto_patterns: [],
        });
        assert.deepEqual(fs.readFileSync(packaged), before);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")),
          { self_heal: { auto_patterns: [] } },
        );

        fs.writeFileSync(packaged, JSON.stringify({
          source: "updated-package",
          self_heal: { circuit_breaker_threshold: 9, auto_patterns: ["new-default"] },
        }));
        assert.deepEqual(loadHealerConfig(), {
          source: "updated-package",
          self_heal: { circuit_breaker_threshold: 9, auto_patterns: [] },
        });
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("stark-session defaults injected homes to Codex-owned roots", async () => {
  await withEnv(
    {
      STARK_ASSET_ROOT: undefined,
      STARK_PLUGIN_ROOT: undefined,
      STARK_STATE_ROOT: undefined,
    },
    () => {
      const deps = realDeps({ home: "/users/codex" });
      assert.equal(deps.scriptsDir, "/users/codex/.stark/code-review/scripts");
      assert.equal(deps.toolsDir, "/users/codex/.stark/code-review/tools");
    },
  );
});

test("stark-session invokes packaged TS tools and discovers Codex skills", async () => {
  await withEnv({ STARK_STATE_ROOT: undefined }, async () => {
    const calls: Array<{ cmd: string[]; env?: NodeJS.ProcessEnv }> = [];
    const deps = stubDeps(async (cmd, opts) => {
      calls.push({ cmd: [...cmd], env: opts?.env });
      if (cmd.some((token) => token.endsWith("/github_projects.ts"))) {
        return { stdout: "[]", stderr: "", code: 0 };
      }
      if (cmd[0] === "sh") {
        return {
          stdout: [
            "/users/codex/.codex/skills/personal/SKILL.md",
            "/repo/.agents/skills/project/SKILL.md",
            "/plugin/skills/native/SKILL.md",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "unavailable", code: 127 };
    });

    assert.deepEqual(await collectBoard(deps, []), {
      in_flight: [],
      blocked: [],
      needs_attention: [],
    });
    const boardCall = calls.find((entry) =>
      entry.cmd.some((token) => token.endsWith("/github_projects.ts")),
    );
    assert.deepEqual(boardCall?.cmd.slice(0, 3), [
      "node",
      "--no-warnings",
      "/plugin/tools/github_projects.ts",
    ]);

    assert.deepEqual(await collectAvailableSkills(deps, []), [
      "native",
      "personal",
      "project",
    ]);
    const discovery = calls.find((entry) => entry.cmd[0] === "sh")?.cmd.join(" ") ?? "";
    assert.match(discovery, /\.codex/);
    assert.match(discovery, /\.agents\/skills/);
    assert.match(discovery, /\/plugin/);

    await collectHealerCategories(deps, []);
    const reads: string[] = [];
    const readDeps = { ...deps, readFile: async (file: string) => {
      reads.push(file);
      return null;
    } };
    await collectHealerCategories(readDeps, []);
    assert.deepEqual(reads, [path.join("/users/codex", ".stark", "code-review", "healer.jsonl")]);

    await collectStart(deps, {
      session_id: "codex-thread-1",
      start_head: null,
      started_at: "",
      walltimeMs: 1_000,
    });
    const child = calls.find((entry) =>
      entry.cmd.some((token) => token.endsWith("/session_state.ts")),
    );
    assert.equal(child?.env?.CODEX_THREAD_ID, "codex-thread-1");
    assert.equal(child?.env?.CLAUDE_SESSION_ID, undefined);
  });
});
