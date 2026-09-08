import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  stateRoot,
  stateRootForHome,
} from "../runtime-overrides/codex/tools/asset_root_lib.ts";
import {
  defaultProjectsDir,
  resolveSessionId,
} from "../runtime-overrides/codex/tools/session_id_lib.ts";
import {
  defaultSessionsDir,
  saveState,
} from "../runtime-overrides/codex/tools/session_state_lib.ts";
import { emitAlert } from "../runtime-overrides/codex/tools/alert_delivery_lib.ts";
import { logResult } from "../runtime-overrides/codex/tools/failure_classifier_lib.ts";

test("Codex state roots default outside Claude and honor STARK_STATE_ROOT", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};
  assert.equal(
    stateRoot(emptyEnv),
    path.join(os.homedir(), ".stark", "code-review"),
  );
  assert.equal(
    stateRootForHome("/tmp/codex-home", emptyEnv),
    path.join("/tmp/codex-home", ".stark", "code-review"),
  );

  const overridden: NodeJS.ProcessEnv = { STARK_STATE_ROOT: "/tmp/stark-state" };
  assert.equal(stateRoot(overridden), "/tmp/stark-state");
  assert.equal(
    stateRootForHome("/tmp/codex-home", overridden),
    "/tmp/stark-state",
  );
  assert.equal(
    defaultSessionsDir(overridden),
    path.join("/tmp/stark-state", "sessions"),
  );
});

test("Codex session IDs use CODEX_THREAD_ID and never Claude markers", () => {
  assert.equal(
    resolveSessionId({
      env: {
        CODEX_THREAD_ID: "  codex-thread-42  ",
        CLAUDE_SESSION_ID: "claude-session-must-be-ignored",
      },
      projectsDir: path.join(os.homedir(), ".claude", "projects"),
    }),
    "codex-thread-42",
  );

  const fallback = resolveSessionId({
    env: { CLAUDE_SESSION_ID: "claude-session-must-be-ignored" },
    projectsDir: path.join(os.homedir(), ".claude", "projects"),
  });
  assert.match(
    fallback,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(defaultProjectsDir().includes(`${path.sep}.claude${path.sep}`), false);
});

test("Codex default writes leave a sentinel Claude tree byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-isolation-"));
  const sentinel = path.join(root, ".claude", "code-review", "sentinel.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "claude-owned\n");
  const before = fs.readFileSync(sentinel);

  const saved = {
    HOME: process.env.HOME,
    STARK_STATE_ROOT: process.env.STARK_STATE_ROOT,
  };
  process.env.HOME = root;
  delete process.env.STARK_STATE_ROOT;
  try {
    emitAlert({ level: "info", source: "test", message: "isolated" });
    logResult(
      {
        category: "UNCLASSIFIED",
        confidence: 0,
        pattern_id: null,
        recommended_action: "inspect",
      },
      "stderr.txt",
    );
    saveState({
      session_id: "codex-thread",
      started_at: "2026-08-05T00:00:00Z",
      branch: "main",
      repo: "owner/repo",
      tasks_completed: [],
      last_checkpoint: null,
      context: {},
      name: null,
      start_head: null,
    });

    assert.ok(fs.existsSync(path.join(root, ".stark", "code-review", "alerts.jsonl")));
    assert.ok(fs.existsSync(path.join(root, ".stark", "code-review", "healer.jsonl")));
    assert.ok(fs.existsSync(path.join(root, ".stark", "code-review", "sessions", "codex-thread.json")));
    assert.deepEqual(fs.readFileSync(sentinel), before);
    assert.deepEqual(fs.readdirSync(path.dirname(sentinel)), ["sentinel.txt"]);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.STARK_STATE_ROOT === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = saved.STARK_STATE_ROOT;
    fs.rmSync(root, { recursive: true });
  }
});
