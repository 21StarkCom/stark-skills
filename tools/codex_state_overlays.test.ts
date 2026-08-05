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
import {
  archiveOldFiles,
  cleanInfra,
} from "../runtime-overrides/codex/tools/housekeeping_infra.ts";

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

test("Codex housekeeping cleans only Codex-owned state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-housekeeping-isolation-"));
  const claudeSentinel = path.join(root, ".claude", "code-review", "keep.json");
  const staleSession = path.join(root, ".stark", "code-review", "sessions", "old.json");
  fs.mkdirSync(path.dirname(claudeSentinel), { recursive: true });
  fs.mkdirSync(path.dirname(staleSession), { recursive: true });
  fs.writeFileSync(claudeSentinel, "claude-owned\n");
  fs.writeFileSync(staleSession, "{}\n");
  const before = fs.readFileSync(claudeSentinel);

  const savedState = process.env.STARK_STATE_ROOT;
  delete process.env.STARK_STATE_ROOT;
  try {
    const receipt = cleanInfra({
      homeDir: root,
      cwd: root,
      now: new Date("2026-08-05T00:00:00Z"),
      ageProvider: () => new Date("2020-01-01T00:00:00Z"),
    });
    assert.equal(fs.existsSync(staleSession), false);
    assert.deepEqual(fs.readFileSync(claudeSentinel), before);
    assert.deepEqual(receipt.statuslineStateRemoved, []);
    assert.deepEqual(receipt.symlinksRepaired, []);
    assert.equal(receipt.errors.length, 0);
  } finally {
    if (savedState === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = savedState;
    fs.rmSync(root, { recursive: true });
  }
});

test("Codex housekeeping preserves monthly archives and terminates tar options", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-housekeeping-archive-"));
  const source = path.join(root, "automation", "logs");
  const archives = path.join(root, "archives");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(archives, { recursive: true });
  const hostileName = "--checkpoint-action=exec";
  const oldFile = path.join(source, hostileName);
  const priorArchive = path.join(archives, "automation-logs-2020-01.tar.gz");
  fs.writeFileSync(oldFile, "old log\n");
  fs.writeFileSync(priorArchive, "prior archive\n");
  const priorBytes = fs.readFileSync(priorArchive);
  const calls: string[][] = [];

  try {
    const results = archiveOldFiles(
      { slug: "automation-logs", rootDir: source },
      archives,
      30,
      {
        now: new Date("2026-08-05T00:00:00Z"),
        ageProvider: () => new Date("2020-01-15T00:00:00Z"),
        tarRunner: (args) => {
          calls.push([...args]);
          if (args[0] === "-czf") fs.writeFileSync(args[1], "new archive\n");
          return "";
        },
      },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].archive, path.join(archives, "automation-logs-2020-01-2.tar.gz"));
    assert.deepEqual(fs.readFileSync(priorArchive), priorBytes);
    assert.deepEqual(calls[0].slice(2), ["-C", source, "--", hostileName]);
    assert.equal(fs.existsSync(oldFile), false);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
