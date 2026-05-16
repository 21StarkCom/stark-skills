import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendAudit,
  auditLogPath,
  buildTrustedTestEnv,
  cleanupStaleForkRemote,
  evaluateFixLoopGate,
  parseFixerOutput,
  pushBranch,
  resolvePushTarget,
  stageFiles,
  validateStagePaths,
  parseCli,
  MAX_ROUNDS_CEILING,
  PathRejectedError,
  PushTargetUnauthorizedError,
  FixerParseError,
} from "./stark_review.ts";
import type { ResolvedConfig } from "./stark_review_lib.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase9-${prefix}-`));
}

function baseConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    quick_domains: [],
    default_agent: "codex",
    domain_agents: {},
    severity_overrides: {},
    fix_threshold: "medium",
    runtime: {
      lock_ttl_minutes: 30,
      subagent_env_allowlist: ["PATH", "HOME"],
      max_concurrent_agents: 3,
      temp_dir_prefix: "stark-test",
      large_pr_file_threshold: 40,
      large_pr_line_threshold: 3000,
      large_pr_timeout_s: 1800,
    },
    test_command: null,
    untrusted_fix_loop: false,
    history_retention_days: 90,
    lock_ttl_minutes: 30,
    ...over,
  };
}

// ─── Task 9-1: evaluateFixLoopGate (7 rule branches) ────────────────────────

test("evaluateFixLoopGate: (a) noFixLoop → soft skip", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: false, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: true,
  });
  assert.equal(r.allow, false);
  assert.equal(r.terminal, false);
  assert.equal(r.reason, "no_fix_loop");
});

test("evaluateFixLoopGate: (b) no test_command → soft skip", () => {
  for (const tc of [null, undefined, "", "   "]) {
    const r = evaluateFixLoopGate({
      testCommand: tc as any, prHeadIsFork: false, maintainerCanModify: false,
      cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
    });
    assert.equal(r.allow, false);
    assert.equal(r.terminal, false);
    assert.equal(r.reason, "no_test_command");
  }
});

test("evaluateFixLoopGate: (b') empty test_command + allowNoTestCommand → allow", () => {
  for (const tc of [null, undefined, "", "   "]) {
    const r = evaluateFixLoopGate({
      testCommand: tc as any, prHeadIsFork: false, maintainerCanModify: false,
      cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
      allowNoTestCommand: true,
    });
    assert.equal(r.allow, true, `tc=${JSON.stringify(tc)} should allow`);
    assert.equal(r.terminal, false);
  }
});

test("evaluateFixLoopGate: (b') empty test_command + allowNoTestCommand on fork w/ MCM → allow", () => {
  const r = evaluateFixLoopGate({
    testCommand: null, prHeadIsFork: true, maintainerCanModify: true,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
    allowNoTestCommand: true,
  });
  assert.equal(r.allow, true);
  assert.equal(r.reason, "fork_with_mcm");
});

test("evaluateFixLoopGate: noFixLoop wins even when allowNoTestCommand is true", () => {
  const r = evaluateFixLoopGate({
    testCommand: null, prHeadIsFork: false, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: true,
    allowNoTestCommand: true,
  });
  assert.equal(r.allow, false);
  assert.equal(r.reason, "no_fix_loop");
});

test("evaluateFixLoopGate: (c) same-repo PR → allow", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: false, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
  });
  assert.equal(r.allow, true);
});

test("evaluateFixLoopGate: (d) fork+MCM → allow", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: true, maintainerCanModify: true,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
  });
  assert.equal(r.allow, true);
});

test("evaluateFixLoopGate: (e) fork no MCM no CLI opt-in → soft skip fork_no_mcm", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: true, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: false, configUntrustedFixLoop: false, noFixLoop: false,
  });
  assert.equal(r.allow, false);
  assert.equal(r.terminal, false);
  assert.equal(r.reason, "fork_no_mcm");
});

test("evaluateFixLoopGate: (f) CLI opt-in but config disabled → terminal auth_denied", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: true, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: true, configUntrustedFixLoop: false, noFixLoop: false,
  });
  assert.equal(r.allow, false);
  assert.equal(r.terminal, true);
  assert.equal(r.reason, "auth_denied");
});

test("evaluateFixLoopGate: (g) both opt-ins → allow", () => {
  const r = evaluateFixLoopGate({
    testCommand: "make test", prHeadIsFork: true, maintainerCanModify: false,
    cliAllowUntrustedFixLoop: true, configUntrustedFixLoop: true, noFixLoop: false,
  });
  assert.equal(r.allow, true);
});

// ─── Task 9-3: validateStagePaths ───────────────────────────────────────────

test("validateStagePaths rejects absolute paths", () => {
  const wt = tmpDir("wt");
  assert.throws(() => validateStagePaths(wt, ["/etc/passwd"]), PathRejectedError);
});

test("validateStagePaths rejects '..' segments", () => {
  const wt = tmpDir("wt");
  assert.throws(() => validateStagePaths(wt, ["../escape.txt"]), PathRejectedError);
  assert.throws(() => validateStagePaths(wt, ["foo/../../bar"]), PathRejectedError);
});

test("validateStagePaths rejects symlink-as-leaf escaping worktree", () => {
  const wt = tmpDir("wt");
  const target = tmpDir("ext");
  fs.writeFileSync(path.join(target, "secret.txt"), "x");
  fs.symlinkSync(path.join(target, "secret.txt"), path.join(wt, "leak.txt"));
  assert.throws(
    () => validateStagePaths(wt, ["leak.txt"]),
    PathRejectedError,
  );
});

test("validateStagePaths rejects symlink-as-ancestor escaping worktree", () => {
  const wt = tmpDir("wt");
  const target = tmpDir("ext");
  fs.mkdirSync(path.join(target, "inner"), { recursive: true });
  fs.writeFileSync(path.join(target, "inner", "x.txt"), "x");
  // Make 'subdir' inside the worktree a symlink pointing OUTSIDE.
  fs.symlinkSync(target, path.join(wt, "subdir"));
  assert.throws(
    () => validateStagePaths(wt, ["subdir/inner/x.txt"]),
    PathRejectedError,
  );
});

test("validateStagePaths returns cleaned list for safe paths", () => {
  const wt = tmpDir("wt");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "a.ts"), "x");
  fs.writeFileSync(path.join(wt, "b.ts"), "x");
  const r = validateStagePaths(wt, ["src/a.ts", "b.ts"]);
  assert.deepEqual(r, ["src/a.ts", "b.ts"]);
});

// stageFiles uses git add -- (asserted by checking it never spawns 'add -A')
test("stageFiles uses 'git add --' explicit paths, never -A", async () => {
  const wt = tmpDir("wt");
  fs.writeFileSync(path.join(wt, "f.ts"), "x");
  const calls: { cmd: string; args: string[] }[] = [];
  const fakeSpawn = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { stdout: "", stderr: "", status: 0 };
  };
  const r = await stageFiles({ worktree: wt, paths: ["f.ts"], spawnFn: fakeSpawn as any });
  assert.deepEqual(r.staged, ["f.ts"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "git");
  assert.ok(calls[0].args.includes("add"));
  assert.ok(calls[0].args.includes("--"));
  assert.ok(!calls[0].args.includes("-A"));
});

// Source-level guard: argv literal "-A" never appears in non-comment code.
test("source: stark_review.ts never uses `git add -A` in argv", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname!, "stark_review.ts"), "utf8");
  // Strip block and line comments so the negative check looks at code only.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.ok(!/"-A"/.test(code), "argv literal '-A' must not appear in code");
  assert.ok(!/'(-A)'/.test(code), "argv literal '-A' (single-quoted) must not appear in code");
});

// ─── Task 9-2: parseFixerOutput ─────────────────────────────────────────────

test("parseFixerOutput: valid object", () => {
  const r = parseFixerOutput('{"modified_files":["a.ts","b.ts"],"summary":"did things"}');
  assert.deepEqual(r.modified_files, ["a.ts", "b.ts"]);
  assert.equal(r.summary, "did things");
});

test("parseFixerOutput: rejects framing chatter (strict whole-trim parse)", () => {
  assert.throws(
    () => parseFixerOutput('chatter\n{"modified_files":[],"summary":"none"}\nmore'),
    FixerParseError,
  );
  assert.throws(
    () => parseFixerOutput('{"modified_files":[],"summary":"none"}\ntrailing prose'),
    FixerParseError,
  );
  assert.throws(
    () => parseFixerOutput('```json\n{"modified_files":[],"summary":"x"}\n```'),
    FixerParseError,
  );
});

test("parseFixerOutput: rejects malformed", () => {
  assert.throws(() => parseFixerOutput(""), FixerParseError);
  assert.throws(() => parseFixerOutput("not json"), FixerParseError);
  assert.throws(() => parseFixerOutput('{"modified_files":"oops","summary":"x"}'), FixerParseError);
  assert.throws(() => parseFixerOutput('{"modified_files":[1],"summary":"x"}'), FixerParseError);
  assert.throws(() => parseFixerOutput('{"modified_files":[],"summary":42}'), FixerParseError);
});

// ─── Task 9-5: buildTrustedTestEnv ──────────────────────────────────────────

test("buildTrustedTestEnv uses default allowlist when not configured", () => {
  const env = buildTrustedTestEnv(
    { PATH: "/bin", HOME: "/h", FOO: "bar" } as any,
    baseConfig(),
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.FOO, undefined);
});

test("buildTrustedTestEnv strips token vars regardless of allowlist", () => {
  const cfg = baseConfig();
  cfg.runtime.test_env_allowlist = ["PATH", "GH_TOKEN", "STARK_PUSH_TOKEN", "GITHUB_TOKEN"];
  const env = buildTrustedTestEnv(
    { PATH: "/bin", GH_TOKEN: "secret", STARK_PUSH_TOKEN: "x", GITHUB_TOKEN: "y" } as any,
    cfg,
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.STARK_PUSH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("buildTrustedTestEnv distinct from subagent allowlist", () => {
  const cfg = baseConfig();
  cfg.runtime.subagent_env_allowlist = ["PATH"];
  cfg.runtime.test_env_allowlist = ["PATH", "NODE_PATH"];
  const env = buildTrustedTestEnv(
    { PATH: "/bin", NODE_PATH: "/node", HOME: "/h" } as any,
    cfg,
  );
  assert.equal(env.NODE_PATH, "/node");
  assert.equal(env.HOME, undefined);
});

// ─── Task 9-4: push target / fork askpass ───────────────────────────────────

test("resolvePushTarget: same-repo → origin", () => {
  const t = resolvePushTarget({
    prHeadIsFork: false, prHeadRef: "feature", prHeadRepoFullName: "o/r",
    prHeadCloneUrl: "https://github.com/o/r.git", maintainerCanModify: false,
  });
  assert.equal(t.kind, "origin");
  assert.equal(t.ref, "feature");
});

test("resolvePushTarget: fork → fork target with cloneUrl (no token in URL)", () => {
  const t = resolvePushTarget({
    prHeadIsFork: true, prHeadRef: "feature", prHeadRepoFullName: "u/r",
    prHeadCloneUrl: "https://github.com/u/r.git", maintainerCanModify: true,
  });
  assert.equal(t.kind, "fork");
  assert.equal(t.cloneUrl, "https://github.com/u/r.git");
  assert.ok(!t.cloneUrl!.includes("@"));
  assert.ok(!t.cloneUrl!.includes("x-access-token"));
});

test("resolvePushTarget: fork without MCM → throws PushTargetUnauthorizedError", () => {
  assert.throws(
    () =>
      resolvePushTarget({
        prHeadIsFork: true,
        prHeadRef: "feature",
        prHeadRepoFullName: "u/r",
        prHeadCloneUrl: "https://github.com/u/r.git",
        maintainerCanModify: false,
      }),
    PushTargetUnauthorizedError,
  );
});

// ─── --max-rounds: default, valid override, ceiling ────────────────────────

const REQUIRED_ARGS = [
  "--pr", "1",
  "--repo", "o/r",
  "--base", "main",
  "--worktree", process.cwd(),
  "--config-root", process.cwd(),
];

test("parseCli: --max-rounds defaults to 3", () => {
  const r = parseCli(REQUIRED_ARGS);
  assert.equal(r.config?.maxRounds, 3);
});

test("parseCli: --max-rounds accepts a value at the ceiling", () => {
  const r = parseCli([...REQUIRED_ARGS, "--max-rounds", String(MAX_ROUNDS_CEILING)]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config?.maxRounds, MAX_ROUNDS_CEILING);
});

test("parseCli: --max-rounds rejects values above the ceiling", () => {
  const r = parseCli([...REQUIRED_ARGS, "--max-rounds", String(MAX_ROUNDS_CEILING + 1)]);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some((e) => /ceiling/.test(e)));
  assert.equal(r.config, undefined);
});

test("pushBranch: same-repo uses origin, no token in env, no extraheader", async () => {
  const wt = tmpDir("wt");
  const calls: { cmd: string; args: string[]; env?: any }[] = [];
  const fakeSpawn = async (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, env: opts?.env });
    return { stdout: "", stderr: "", status: 0 };
  };
  const r = await pushBranch({
    worktree: wt,
    target: { kind: "origin", ref: "main", fullName: "o/r" },
    spawnFn: fakeSpawn as any,
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-C", wt, "push", "origin", "HEAD:main"]);
  // Argv must not contain extraheader, http.extraHeader, or any token literal.
  for (const a of calls[0].args) {
    assert.ok(!/extraheader/i.test(a));
    assert.ok(!a.includes("ghp_"));
  }
});

test("pushBranch: fork uses GIT_ASKPASS, never URL-embedded token", async () => {
  const wt = tmpDir("wt");
  const calls: { cmd: string; args: string[]; env?: any }[] = [];
  let askpassPath: string | undefined;
  const fakeSpawn = async (cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, env: opts?.env });
    if (opts?.env?.GIT_ASKPASS) askpassPath = opts.env.GIT_ASKPASS;
    return { stdout: "", stderr: "", status: 0 };
  };
  const TOKEN = "ghs_supersecrettoken";
  const r = await pushBranch({
    worktree: wt,
    target: {
      kind: "fork", ref: "feat", fullName: "u/r",
      cloneUrl: "https://github.com/u/r.git",
    },
    token: TOKEN,
    spawnFn: fakeSpawn as any,
  });
  assert.equal(r.ok, true);
  // The push call must include GIT_ASKPASS env, GIT_TERMINAL_PROMPT=0, and STARK_PUSH_TOKEN.
  const pushCall = calls.find((c) => c.args.includes("push") && c.args.includes("stark-fork-push"));
  assert.ok(pushCall, "push call should target stark-fork-push remote");
  assert.equal(pushCall!.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(pushCall!.env.STARK_PUSH_TOKEN, TOKEN);
  assert.ok(pushCall!.env.GIT_ASKPASS && pushCall!.env.GIT_ASKPASS.endsWith("askpass.sh"));
  // Argv must NOT include the token or extraheader.
  for (const a of pushCall!.args) {
    assert.ok(!a.includes(TOKEN));
    assert.ok(!/extraheader/i.test(a));
  }
  // Ensure remote was added with the bare cloneUrl (no embedded credentials).
  const addCall = calls.find((c) => c.args.includes("add") && c.args.includes("stark-fork-push"));
  assert.ok(addCall);
  assert.ok(addCall!.args.some((a) => a === "https://github.com/u/r.git"));
  assert.ok(!addCall!.args.some((a) => a.includes(TOKEN)));
  // askpass file should be cleaned up.
  if (askpassPath) {
    assert.ok(!fs.existsSync(askpassPath), "askpass.sh should be deleted after push");
  }
  // Remote remove should be called on cleanup.
  assert.ok(calls.some((c) => c.args.includes("remove") && c.args.includes("stark-fork-push")));
});

test("pushBranch: non-fast-forward stderr → conflict=true", async () => {
  const wt = tmpDir("wt");
  const fakeSpawn = async () => ({
    stdout: "", stderr: "! [rejected] feature -> feature (non-fast-forward)", status: 1,
  });
  const r = await pushBranch({
    worktree: wt,
    target: { kind: "origin", ref: "feat", fullName: "o/r" },
    spawnFn: fakeSpawn as any,
  });
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
});

test("cleanupStaleForkRemote removes the remote when present", async () => {
  const wt = tmpDir("wt");
  const calls: { args: string[] }[] = [];
  const fakeSpawn = async (_cmd: string, args: string[]) => {
    calls.push({ args });
    if (args[args.length - 1] === "remote") {
      return { stdout: "origin\nstark-fork-push\n", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  await cleanupStaleForkRemote(wt, fakeSpawn as any);
  assert.ok(calls.some((c) => c.args.includes("remove") && c.args.includes("stark-fork-push")));
});

// ─── Task 9-6: audit log ────────────────────────────────────────────────────

test("auditLogPath under ~/.claude/code-review/audit/{org}/{repo}/{pr}.jsonl", () => {
  const p = auditLogPath("/h", "owner/name", 42);
  assert.equal(p, "/h/.claude/code-review/audit/owner/name/42.jsonl");
});

test("appendAudit appends JSONL line with ts and round, creates parent dirs", () => {
  const home = tmpDir("home");
  appendAudit({ action: "stage", round: 1, files: ["a.ts"] }, { home, repo: "o/r", pr: 7 });
  appendAudit({ action: "commit", round: 1, sha: "abc" }, { home, repo: "o/r", pr: 7 });
  const p = auditLogPath(home, "o/r", 7);
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const ev0 = JSON.parse(lines[0]);
  assert.equal(ev0.action, "stage");
  assert.equal(ev0.round, 1);
  assert.deepEqual(ev0.files, ["a.ts"]);
  assert.ok(typeof ev0.ts === "string" && ev0.ts.length > 0);
});

test("appendAudit redactInLogs scrubs token values from any field", () => {
  const home = tmpDir("home");
  const TOKEN = "ghs_topsecret_abc123";
  appendAudit(
    { action: "push", round: 2, sha: "deadbeef", reason: `token=${TOKEN} pushed`, head_repo: "o/r" } as any,
    { home, repo: "o/r", pr: 9, redactInLogs: [TOKEN] },
  );
  const raw = fs.readFileSync(auditLogPath(home, "o/r", 9), "utf8");
  assert.ok(!raw.includes(TOKEN), "token must not appear in audit log");
  assert.ok(raw.includes("***REDACTED***"));
});

test("appendAudit emits all six required action types over the lifecycle", () => {
  const home = tmpDir("home");
  for (const action of ["commit", "push", "stage", "post", "skip", "deny"] as const) {
    appendAudit({ action, round: 1 } as any, { home, repo: "o/r", pr: 1 });
  }
  const lines = fs.readFileSync(auditLogPath(home, "o/r", 1), "utf8").trim().split("\n");
  assert.equal(lines.length, 6);
  const actions = lines.map((l) => JSON.parse(l).action);
  assert.deepEqual(actions, ["commit", "push", "stage", "post", "skip", "deny"]);
});
