// Smoke tests for the stark_session CLI module. We exercise the `main`
// entry function directly with stubbed argv to avoid spawning a child node
// process and to keep stdout capture cheap. Actual collector behavior is
// covered by stark_session_lib.test.ts.

import { strict as assert } from "node:assert";
import test from "node:test";

import { main } from "./stark_session.ts";
import type { Deps } from "./stark_session_lib.ts";

function makeStubDeps(runs: Array<{ cmd: string[]; stdout?: string; code?: number }>): Deps {
  const queue = [...runs];
  return {
    home: "/home/u",
    scriptsDir: "/scripts",
    toolsDir: "/tools",
    now: () => new Date("2026-05-18T12:00:00Z"),
    async run(cmd) {
      const idx = queue.findIndex(
        (s) => s.cmd.length <= cmd.length && s.cmd.every((tok, i) => tok === cmd[i]),
      );
      if (idx === -1) return { stdout: "", stderr: "", code: 127 };
      const s = queue.splice(idx, 1)[0];
      return { stdout: s.stdout ?? "", stderr: "", code: s.code ?? 0 };
    },
    async readFile() { return null; },
    async fileExists() { return false; },
  };
}

function captureStdout(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout.write as any) = (chunk: any) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  return {
    restore: () => {
      process.stdout.write = orig as any;
      return buf;
    },
  };
}

function captureStderr(): { restore: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr.write as any) = (chunk: any) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  return {
    restore: () => {
      process.stderr.write = orig as any;
      return buf;
    },
  };
}

test("main: prints usage with exit 0 on --help", async () => {
  const cap = captureStdout();
  const code = await main(["--help"]);
  const out = cap.restore();
  assert.equal(code, 0);
  assert.match(out, /stark-session CLI/);
});

test("main: exits 1 with usage when no subcommand given", async () => {
  const cap = captureStdout();
  const code = await main([]);
  cap.restore();
  assert.equal(code, 1);
});

test("main: exits 1 on unknown subcommand", async () => {
  const out = captureStdout();
  const err = captureStderr();
  const code = await main(["fnord"]);
  out.restore();
  const errMsg = err.restore();
  assert.equal(code, 1);
  assert.match(errMsg, /unknown subcommand/);
});

test("main start: returns parsed JSON envelope with errors slot present", async () => {
  // All collectors stub to no-op; we just check the envelope keys.
  const deps = makeStubDeps([
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"], stdout: JSON.stringify({
      session_id: "S", started_at: "", branch: "", repo: "",
      tasks_completed: [], last_checkpoint: null, name: null, start_head: null,
    }) },
    { cmd: ["git", "branch", "--show-current"], stdout: "feat/x\n" },
    { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
    { cmd: ["git", "status", "--short"], stdout: "" },
    { cmd: ["git", "stash", "list"], stdout: "" },
    { cmd: ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"], stdout: "" },
    { cmd: ["gh", "pr", "list", "--author", "@me"], stdout: "[]" },
    { cmd: ["gh", "pr", "view"], code: 1 },
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts"], stdout: JSON.stringify({ unacknowledged: [] }) },
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/healer_canary.ts"], stdout: JSON.stringify({ patterns: [] }) },
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts"], stdout: JSON.stringify({ suggestions: [] }) },
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts"], stdout: "{}" },
    { cmd: ["python3", "/scripts/github_projects.py"], stdout: "[]" },
    { cmd: ["sh", "-c"], stdout: "" },
  ]);
  const cap = captureStdout();
  const code = await main(["start", "--session-id", "S", "--started-at", "T", "--start-head", "SHA"], deps);
  const out = cap.restore();
  assert.equal(code, 0);
  const env = JSON.parse(out);
  assert.equal(env.session.session_id, "S");
  assert.equal(env.session.start_head, "SHA");
  assert.equal(env.session.started_at, "T");
  assert.ok(Array.isArray(env.errors));
  assert.ok("skills" in env && "git" in env);
});

test("main end: returns parsed JSON envelope with diff + branch + session", async () => {
  const deps = makeStubDeps([
    { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"], stdout: JSON.stringify({
      session_id: "S", started_at: "T", branch: "main", repo: "x/y",
      tasks_completed: [], last_checkpoint: null, name: null, start_head: "persisted",
    }) },
    { cmd: ["git", "diff", "--numstat", "persisted", "HEAD"], stdout: "3\t1\ta.ts\n" },
    { cmd: ["git", "diff", "--name-status", "persisted", "HEAD"], stdout: "M\ta.ts\n" },
    { cmd: ["git", "rev-parse", "--abbrev-ref", "@{u}"], stdout: "origin/main\n" },
    { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
    { cmd: ["gh", "pr", "view", "--json", "number"], code: 1 },
  ]);
  const cap = captureStdout();
  const code = await main(["end", "--session-id", "S", "--name", "topic-x"], deps);
  const out = cap.restore();
  assert.equal(code, 0);
  const env = JSON.parse(out);
  assert.equal(env.session.session_id, "S");
  assert.equal(env.session.name, "topic-x");
  assert.equal(env.session.start_head, "persisted");
  assert.equal(env.diff.added, 3);
  assert.equal(env.branch.upstream, "origin/main");
});
