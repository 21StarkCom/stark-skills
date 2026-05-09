import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HISTORY_SCHEMA_VERSION,
  GhError,
  acquireLock,
  applySeverityOverrides,
  buildMarker,
  buildReviewBody,
  classifyDispatchTier,
  computeExitCode,
  computeRunHash,
  dispatchDomains,
  emitReceipt,
  findExistingMarker,
  fmtDuration,
  progressEnabled,
  historyDir,
  nextRoundNumber,
  parseCli,
  partitionInlineVsBody,
  pickAllowlistedEnv,
  postReview,
  pruneHistory,
  renderHumanSummary,
  runClassifier,
  validatePathContainment,
  withRetry,
  writeRoundHistory,
  type AgentPort,
  type DispatchResult,
  type Receipt,
} from "./stark_review.ts";
import type { Finding, ResolvedConfig } from "./stark_review_lib.ts";

// ─── Test helpers ───────────────────────────────────────────────────────────

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bareConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
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
    history_retention_days: 0,
    lock_ttl_minutes: 30,
    ...over,
  };
}

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "abc123",
    domain: "security",
    agent: "codex",
    severity: "high",
    file: "src/x.ts",
    line: 10,
    title: "title",
    body: "body",
    classification: "fix",
    ...over,
  };
}

// ─── Task 4-1: parseCli ─────────────────────────────────────────────────────

test("parseCli: required flags missing fails", () => {
  const r = parseCli(["--pr", "1"]);
  assert.equal(r.config, undefined);
  assert.ok(r.errors.some((e) => e.includes("--repo")));
});

test("parseCli: happy path", () => {
  const wt = tmpDir("wt-");
  const cfg = tmpDir("cfg-");
  const r = parseCli([
    "--pr", "42",
    "--repo", "owner/repo",
    "--base", "main",
    "--worktree", wt,
    "--config-root", cfg,
    "--max-rounds", "5",
    "--json",
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config!.pr, 42);
  assert.equal(r.config!.maxRounds, 5);
  assert.equal(r.config!.json, true);
});

test("parseCli: --domains beats --quick with warning", () => {
  const wt = tmpDir("wt-");
  const cfg = tmpDir("cfg-");
  const r = parseCli([
    "--pr", "1", "--repo", "o/r", "--base", "main",
    "--worktree", wt, "--config-root", cfg,
    "--quick", "--domains", "security,architecture",
  ]);
  assert.deepEqual(r.config!.domains, ["security", "architecture"]);
  assert.equal(r.config!.quick, true);
  assert.ok(r.warnings.some((w) => /domains beats/.test(w)));
});

test("parseCli: --allow-untrusted-fix-loop warns about config requirement (Phase 9)", () => {
  const wt = tmpDir("wt-");
  const cfg = tmpDir("cfg-");
  const r = parseCli([
    "--pr", "1", "--repo", "o/r", "--base", "main",
    "--worktree", wt, "--config-root", cfg,
    "--allow-untrusted-fix-loop",
  ]);
  assert.equal(r.config!.allowUntrustedFixLoop, true);
  assert.ok(r.warnings.some((w) => /untrusted_fix_loop/.test(w)));
});

test("parseCli: rejects non-absolute --worktree", () => {
  const cfg = tmpDir("cfg-");
  const r = parseCli([
    "--pr", "1", "--repo", "o/r", "--base", "main",
    "--worktree", "rel/path", "--config-root", cfg,
  ]);
  assert.ok(r.errors.some((e) => /worktree must be absolute/.test(e)));
});

test("parseCli: rejects nonexistent worktree", () => {
  const cfg = tmpDir("cfg-");
  const r = parseCli([
    "--pr", "1", "--repo", "o/r", "--base", "main",
    "--worktree", "/nonexistent/abs/path/here-xyz",
    "--config-root", cfg,
  ]);
  assert.ok(r.errors.some((e) => /does not exist/.test(e)));
});

test("parseCli: --help short-circuits", () => {
  const r = parseCli(["--help"]);
  assert.equal(r.helpRequested, true);
});

// ─── Task 4-3: pickAllowlistedEnv & dispatch ────────────────────────────────

test("pickAllowlistedEnv: never includes GH_TOKEN/GITHUB_TOKEN/STARK_PUSH_TOKEN", () => {
  const env = {
    PATH: "/usr/bin",
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    STARK_PUSH_TOKEN: "secret",
    HOME: "/home/u",
  };
  const out = pickAllowlistedEnv(env, ["PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "STARK_PUSH_TOKEN"]);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/home/u");
  assert.equal(out.GH_TOKEN, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.STARK_PUSH_TOKEN, undefined);
});

test("dispatchDomains: concurrency capped + temp-dir-per-invocation", async () => {
  const config = bareConfig({ runtime: { ...bareConfig().runtime, max_concurrent_agents: 2 } });
  const observed: { cwd: string | undefined; envHasGhToken: boolean }[] = [];
  let inflight = 0;
  let peak = 0;

  const fakePort: AgentPort = {
    buildCommand: (prompt: string) => ({ cmd: "/bin/echo", args: [], stdin: prompt, env: {} }),
    parseOutput: (_stdout: string) => ({ findings: [], parseErrors: [] }),
  };
  const ports = new Map([["codex" as const, fakePort]]);

  const fakeSpawn = async (
    _cmd: string,
    _args: string[],
    o: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ) => {
    inflight++;
    peak = Math.max(peak, inflight);
    observed.push({
      cwd: o.cwd,
      envHasGhToken:
        !!(o.env?.GH_TOKEN ?? o.env?.GITHUB_TOKEN ?? o.env?.STARK_PUSH_TOKEN),
    });
    await new Promise((r) => setTimeout(r, 30));
    inflight--;
    return { stdout: "", stderr: "", status: 0 };
  };

  process.env.GH_TOKEN = "leak-me-please";
  try {
    const results = await dispatchDomains({
      assignments: Array.from({ length: 5 }, (_, i) => ({
        domain: `d${i}`,
        agent: "codex" as const,
        prompt: "x",
      })),
      ports,
      config,
      spawnFn: fakeSpawn as unknown as typeof fakeSpawn,
    });
    assert.equal(results.length, 5);
    assert.ok(peak <= 2, `concurrency cap not honored, peak=${peak}`);
    assert.ok(observed.every((o) => !o.envHasGhToken), "GH_TOKEN leaked into agent env");
    assert.ok(observed.every((o) => o.cwd !== undefined), "cwd should be a temp dir, never undefined");
  } finally {
    delete process.env.GH_TOKEN;
  }
});

test("dispatchDomains: failure of one domain does not abort siblings", async () => {
  const config = bareConfig();
  const fakePort: AgentPort = {
    buildCommand: (prompt: string) => ({ cmd: "/bin/echo", args: [], stdin: prompt, env: {} }),
    parseOutput: () => ({ findings: [], parseErrors: [] }),
  };
  const ports = new Map([["codex" as const, fakePort]]);
  let calls = 0;
  const fakeSpawn = async () => {
    calls++;
    if (calls === 1) return { stdout: "", stderr: "boom", status: 7 };
    return { stdout: "", stderr: "", status: 0 };
  };
  const results = await dispatchDomains({
    assignments: [
      { domain: "a", agent: "codex", prompt: "p" },
      { domain: "b", agent: "codex", prompt: "p" },
    ],
    ports, config,
    spawnFn: fakeSpawn as unknown as typeof fakeSpawn,
  });
  assert.equal(results.length, 2);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
});

// ─── Task 4-4: severity overrides + tier classification ─────────────────────

test("applySeverityOverrides: applied AFTER parseOutput", () => {
  const out = applySeverityOverrides(
    [makeFinding({ severity: "low", domain: "security" })],
    { security: "critical" },
  );
  assert.equal(out[0].severity, "critical");
});

test("classifyDispatchTier: tier1 partial / tier2 total / all_success", () => {
  const ok = (i: number): DispatchResult => ({
    domain: `d${i}`, agent: "codex", ok: true, findings: [], parseErrors: [], durationMs: 1,
  });
  const fail = (i: number): DispatchResult => ({
    domain: `d${i}`, agent: "codex", ok: false, findings: [], parseErrors: [], error: "x", durationMs: 1,
  });
  assert.equal(classifyDispatchTier([ok(0), ok(1)]), "all_success");
  assert.equal(classifyDispatchTier([ok(0), fail(1)]), "tier1_partial");
  assert.equal(classifyDispatchTier([fail(0), fail(1)]), "tier2_total");
  assert.equal(classifyDispatchTier([]), "tier2_total");
});

// ─── Task 4-5: validatePathContainment + classifier abort ───────────────────

test("validatePathContainment rejects ../ absolute and outside", () => {
  const wt = tmpDir("wt-");
  fs.writeFileSync(path.join(wt, "ok.txt"), "ok");
  assert.equal(validatePathContainment(wt, "ok.txt"), true);
  assert.equal(validatePathContainment(wt, "../../etc/passwd"), false);
  assert.equal(validatePathContainment(wt, "/etc/passwd"), false);
});

test("runClassifier aborts after 5 errors and marks remaining findings fix", async () => {
  const wt = tmpDir("wt-");
  const config = bareConfig();
  const failingPort: AgentPort = {
    buildCommand: (prompt: string) => ({ cmd: "/bin/echo", args: [], stdin: prompt, env: {} }),
    parseOutput: () => ({ findings: [], parseErrors: [] }),
  };
  const ports = new Map([["codex" as const, failingPort]]);
  const failSpawn = async () => ({ stdout: "no json here", stderr: "", status: 0 });

  const findings: Finding[] = Array.from({ length: 8 }, (_, i) => ({
    id: `id-${i}`, domain: "security", agent: "codex", severity: "high",
    file: null, line: null, title: `t${i}`, body: "b",
  }));
  const r = await runClassifier(findings, {
    worktree: wt,
    classifierAgent: "codex",
    ports,
    classifierPrompt: "classify",
    spawnFn: failSpawn as unknown as typeof failSpawn,
    config,
  });
  assert.equal(r.aborted, true);
  // All findings classified as fix
  assert.ok(r.findings.every((f) => f.classification === "fix"));
  // After abort, remaining findings get the aborted reason
  const aborted = r.findings.filter((f) => f.classification_reason === "classifier_aborted_after_5_errors");
  assert.ok(aborted.length >= 1);
});

test("runClassifier: path_rejected event recorded for ../ file", async () => {
  const wt = tmpDir("wt-");
  const config = bareConfig();
  const okPort: AgentPort = {
    buildCommand: (prompt: string) => ({ cmd: "/bin/echo", args: [], stdin: prompt, env: {} }),
    parseOutput: () => ({ findings: [], parseErrors: [] }),
  };
  const ports = new Map([["codex" as const, okPort]]);
  const okSpawn = async () => ({
    stdout: '{"classification":"fix","reason":"ok"}',
    stderr: "", status: 0,
  });
  const r = await runClassifier(
    [makeFinding({ file: "../escape.ts", line: 3 })],
    {
      worktree: wt, classifierAgent: "codex", ports,
      classifierPrompt: "c",
      spawnFn: okSpawn as unknown as typeof okSpawn,
      config,
    },
  );
  assert.ok(r.events.some((e) => e.type === "path_rejected"));
  assert.equal(r.findings[0].file, null);
  assert.equal(r.findings[0].line, null);
});

// ─── Task 4-6: history writer + pruning ─────────────────────────────────────

test("writeRoundHistory: schema matches Python multi_review.py shape", () => {
  const home = tmpDir("home-");
  const filePath = writeRoundHistory({
    home,
    repo: "owner/repo",
    pr: 7,
    round: 1,
    mode: "team",
    domain_agents: { security: "codex" },
    results: [{
      agent: "codex",
      model: "gpt-5.5",
      domain: "security",
      duration_s: 1.23,
      error: null,
      api_key_fallback: false,
      findings: [makeFinding({ classification: "fix" })],
    }],
  });
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(data.schema_version, HISTORY_SCHEMA_VERSION);
  assert.equal(data.repo, "owner/repo");
  assert.equal(data.pr, 7);
  assert.equal(data.round, 1);
  assert.equal(data.mode, "team");
  assert.equal(data.results[0].domain, "security");
  assert.equal(data.classification_summary.fix, 1);
  assert.equal(data.classification_summary.total, 1);
  assert.deepEqual(data.models, { codex: "gpt-5.5" });
});

test("nextRoundNumber: 1 when empty, max+1 otherwise", () => {
  const home = tmpDir("home-");
  const dir = historyDir(home, "o/r", 1);
  assert.equal(nextRoundNumber(dir), 1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "round-2.json"), "{}");
  fs.writeFileSync(path.join(dir, "round-5.json"), "{}");
  assert.equal(nextRoundNumber(dir), 6);
});

test("pruneHistory: retentionDays=0 disables pruning", () => {
  const home = tmpDir("home-");
  const r = pruneHistory({ home, retentionDays: 0, lockTtlMinutes: 30 });
  assert.equal(r.attempted, false);
});

test("pruneHistory: skips PR dirs whose review lock is held", () => {
  const home = tmpDir("home-");
  const lockDir = path.join(home, ".claude", "code-review", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const prDir = path.join(home, ".claude", "code-review", "history", "owner", "repo", "9");
  fs.mkdirSync(prDir, { recursive: true });
  fs.writeFileSync(path.join(prDir, "round-1.json"), "{}");
  // Make the dir look old
  const oldT = new Date(Date.now() - 365 * 86400 * 1000);
  fs.utimesSync(prDir, oldT, oldT);
  // Hold a fresh review lock
  const lockPath = path.join(lockDir, "owner-repo-9.lock");
  fs.writeFileSync(lockPath, `${process.pid}\n${os.hostname()}\n`);
  const r = pruneHistory({ home, retentionDays: 1, lockTtlMinutes: 30 });
  assert.ok(r.skipped.some((s) => s.dir === prDir), "should have skipped locked PR dir");
  assert.ok(fs.existsSync(prDir));
});

// ─── Task 4-7: postReview + 422 fallback ────────────────────────────────────

test("partitionInlineVsBody: classification!='fix' demoted to body, never dropped", () => {
  const findings: Finding[] = [
    makeFinding({ classification: "fix", severity: "high", file: "a.ts", line: 1 }),
    makeFinding({ id: "noise", classification: "noise", file: "a.ts", line: 2 }),
    makeFinding({ id: "off", classification: "fix", file: "x.ts", line: 1 }), // not in changed
    makeFinding({ id: "low", classification: "fix", severity: "low", file: "a.ts", line: 1 }), // below threshold
  ];
  const part = partitionInlineVsBody(findings, new Set(["a.ts"]), "medium");
  assert.equal(part.inline.length, 1);
  assert.equal(part.bodyFindings.length, 3);
});

test("fmtDuration: ms / s / m s formatting + carry on rounding", () => {
  assert.equal(fmtDuration(450), "450ms");
  assert.equal(fmtDuration(1500), "1.5s");
  assert.equal(fmtDuration(75_000), "1m 15s");
  assert.equal(fmtDuration(60_000), "1m 0s");
  // 119.5s would naively render as "1m 60s"; verify the carry to 2m 0s.
  assert.equal(fmtDuration(119_500), "2m 0s");
  assert.equal(fmtDuration(3_599_500), "60m 0s");
});

test("progressEnabled: STARK_REVIEW_QUIET=1 wins over VERBOSE=1", () => {
  const prev = { q: process.env.STARK_REVIEW_QUIET, v: process.env.STARK_REVIEW_VERBOSE };
  try {
    process.env.STARK_REVIEW_QUIET = "1";
    process.env.STARK_REVIEW_VERBOSE = "1";
    assert.equal(progressEnabled(), false);
    delete process.env.STARK_REVIEW_QUIET;
    assert.equal(progressEnabled(), true);
  } finally {
    if (prev.q === undefined) delete process.env.STARK_REVIEW_QUIET; else process.env.STARK_REVIEW_QUIET = prev.q;
    if (prev.v === undefined) delete process.env.STARK_REVIEW_VERBOSE; else process.env.STARK_REVIEW_VERBOSE = prev.v;
  }
});

test("progressEnabled: TTY default when neither env var is set", () => {
  const prev = {
    q: process.env.STARK_REVIEW_QUIET,
    v: process.env.STARK_REVIEW_VERBOSE,
    isTTY: (process.stderr as NodeJS.WriteStream).isTTY,
  };
  try {
    delete process.env.STARK_REVIEW_QUIET;
    delete process.env.STARK_REVIEW_VERBOSE;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    assert.equal(progressEnabled(), true, "TTY=true should enable progress");
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    assert.equal(progressEnabled(), false, "TTY=false should disable progress");
  } finally {
    Object.defineProperty(process.stderr, "isTTY", { value: prev.isTTY, configurable: true });
    if (prev.q !== undefined) process.env.STARK_REVIEW_QUIET = prev.q;
    if (prev.v !== undefined) process.env.STARK_REVIEW_VERBOSE = prev.v;
  }
});

test("progress output goes only to stderr when verbose, never stdout", async () => {
  // dispatchDomains exercises the full progress() chain across multiple calls.
  const prev = { v: process.env.STARK_REVIEW_VERBOSE };
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    process.env.STARK_REVIEW_VERBOSE = "1";
    const port: AgentPort = {
      buildCommand: () => ({ cmd: "true", args: [], stdin: "", env: {} }),
      parseOutput: () => ({ findings: [], parseErrors: [] }),
    };
    await dispatchDomains({
      assignments: [{ domain: "x", agent: "codex", prompt: "p" }],
      ports: new Map([["codex", port]]),
      config: {
        default_agent: "codex", domain_agents: {}, severity_overrides: {}, fix_threshold: "medium",
      } as never,
      spawnFn: async () => ({ stdout: "", stderr: "", status: 0 }),
    });
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (prev.v === undefined) delete process.env.STARK_REVIEW_VERBOSE; else process.env.STARK_REVIEW_VERBOSE = prev.v;
  }
  const stderrAll = stderrChunks.join("");
  const stdoutAll = stdoutChunks.join("");
  assert.ok(stderrAll.includes("stark-review:"), "expected progress on stderr");
  assert.ok(!stdoutAll.includes("stark-review:"), "progress must not leak to stdout");
});

test("dispatchDomains catch path normalizes non-Error throws (no TypeError)", async () => {
  const port: AgentPort = {
    buildCommand: () => { throw "string-throw" as unknown as Error; },
    parseOutput: () => ({ findings: [], parseErrors: [] }),
  };
  const results = await dispatchDomains({
    assignments: [{ domain: "x", agent: "codex", prompt: "p" }],
    ports: new Map([["codex", port]]),
    config: {
      default_agent: "codex", domain_agents: {}, severity_overrides: {}, fix_threshold: "medium",
    } as never,
    spawnFn: async () => ({ stdout: "", stderr: "", status: 0 }),
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, "string-throw");
});

test("partitionInlineVsBody: inline + body sorted critical → high → medium → low", () => {
  const findings: Finding[] = [
    makeFinding({ id: "f-low",  severity: "low",      file: "a.ts", line: 5, title: "low-a" }),
    makeFinding({ id: "f-crit", severity: "critical", file: "a.ts", line: 9, title: "crit-a" }),
    makeFinding({ id: "f-med",  severity: "medium",   file: "a.ts", line: 7, title: "med-a" }),
    makeFinding({ id: "f-high", severity: "high",     file: "a.ts", line: 2, title: "high-a" }),
    // body-side (different file, will demote)
    makeFinding({ id: "b-low",  severity: "low",      file: "x.ts", line: 1, title: "low-x" }),
    makeFinding({ id: "b-crit", severity: "critical", file: "x.ts", line: 1, title: "crit-x" }),
  ];
  const part = partitionInlineVsBody(findings, new Set(["a.ts"]), "low");
  assert.deepEqual(
    part.inline.map((c) => c.origin!.severity),
    ["critical", "high", "medium", "low"],
  );
  assert.deepEqual(
    part.bodyFindings.map((f) => f.severity),
    ["critical", "low"],
  );
});

test("buildReviewBody: marker is the first line", () => {
  const marker = buildMarker(2, "codex", "abc");
  const body = buildReviewBody(marker, "summary", []);
  assert.ok(body.startsWith(marker));
  assert.match(body, /^<!-- stark-review:round=2:agent=codex:run=abc -->\n\nsummary/);
});

test("postReview: 422 first retry demotes specific indices, then body-only", async () => {
  const findings: Finding[] = [
    makeFinding({ classification: "fix", severity: "high", file: "a.ts", line: 1 }),
    makeFinding({ id: "id2", classification: "fix", severity: "high", file: "a.ts", line: 2 }),
  ];
  let post = 0;
  const ghMock = async (_p: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method !== "POST") return { status: 200, data: [], headers: {} };
    post++;
    if (post === 1) {
      throw new GhError(422, JSON.stringify({ errors: [{ index: 0, message: "comments[0] line not in diff" }] }), {});
    }
    if (post === 2) {
      throw new GhError(422, JSON.stringify({ errors: [{ index: 0, message: "still bad" }] }), {});
    }
    return { status: 200, data: { id: 999 }, headers: {} };
  };
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings, changedFiles: new Set(["a.ts"]), fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "deadbeef", dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });
  assert.equal(post, 3);
  assert.equal(r.posted, true);
  assert.equal(r.fallbacksApplied, 2);
  assert.ok(
    r.attempts.some((a) => a.status === "body_only"),
    "expected a body_only attempt in the trail",
  );
  assert.equal(r.attempts.at(-1)!.status, "ok");
});

test("postReview: --dry-run skips POST and records payload summary", async () => {
  const r = await postReview({
    repo: "o/r", pr: 5, round: 1, agent: "codex", runHash: "h",
    findings: [makeFinding({ classification: "fix" })],
    changedFiles: new Set(["src/x.ts"]), fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "abc", dryRun: true,
  });
  assert.equal(r.posted, false);
  assert.equal(r.payloadSummary.inlineCount, 1);
});

// ─── Task 4-8: retry policy ─────────────────────────────────────────────────

test("withRetry: backs off 1/4/16s for 5xx and gives up after 3", async () => {
  let calls = 0;
  const slept: number[] = [];
  const sleepFn = async (ms: number) => { slept.push(ms); };
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new GhError(500, "boom", {});
  }, { sleepFn }));
  assert.equal(calls, 4); // initial + 3 retries
  assert.deepEqual(slept, [1000, 4000, 16000]);
});

test("withRetry: honors Retry-After (numeric seconds)", async () => {
  const slept: number[] = [];
  const sleepFn = async (ms: number) => { slept.push(ms); };
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new GhError(429, "rate", { "retry-after": "7" });
  }, { sleepFn, attempts: 2 }));
  assert.equal(slept[0], 7000);
});

test("withRetry: 4xx (non-rate) does not retry", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    throw new GhError(404, "nope", {});
  }));
  assert.equal(calls, 1);
});

test("withRetry: beforeRetry stopReason short-circuits as success", async () => {
  let calls = 0;
  const sleepFn = async () => {};
  const r = await withRetry<unknown>(async () => {
    calls++;
    throw new GhError(500, "boom", {});
  }, {
    sleepFn,
    beforeRetry: async () => ({ stopReason: "marker_found" }),
  });
  assert.equal(calls, 1);
  assert.equal(r, undefined);
});

// ─── Task 4-9: lock + run hash ──────────────────────────────────────────────

test("computeRunHash: stable for sorted domains, different for changed inputs", () => {
  const a = computeRunHash({
    pr_head_sha: "abc",
    domains: ["security", "architecture"],
    agents_resolved: { security: "codex", architecture: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  const b = computeRunHash({
    pr_head_sha: "abc",
    domains: ["architecture", "security"],
    agents_resolved: { architecture: "codex", security: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  assert.equal(a, b);
  const c = computeRunHash({
    pr_head_sha: "def",
    domains: ["security"],
    agents_resolved: { security: "codex" },
    severity_overrides: {},
    fix_threshold: "medium",
  });
  assert.notEqual(a, c);
});

test("acquireLock: O_EXCL then release", async () => {
  const home = tmpDir("home-");
  const h = await acquireLock({ home, repo: "owner/repo", pr: 1, lockTtlMinutes: 30 });
  assert.ok(fs.existsSync(h.path));
  h.release();
  assert.equal(fs.existsSync(h.path), false);
});

test("acquireLock: lock_held when contended", async () => {
  const home = tmpDir("home-");
  const h = await acquireLock({ home, repo: "owner/repo", pr: 2, lockTtlMinutes: 30 });
  try {
    let slept = 0;
    let nowMs = Date.now();
    await assert.rejects(
      acquireLock({
        home, repo: "owner/repo", pr: 2, lockTtlMinutes: 30,
        waitMs: 1500,
        sleepFn: async (ms: number) => { slept += ms; nowMs += ms; },
        now: () => nowMs,
      }),
      (err: unknown) => {
        const e = err as { code?: string };
        return e.code === "lock_held";
      },
    );
    assert.ok(slept >= 1500, `expected at least 1500ms slept, got ${slept}`);
  } finally {
    h.release();
  }
});

test("acquireLock: stale lock reclaimed when mtime expired AND pid dead", async () => {
  const home = tmpDir("home-");
  const lockDir = path.join(home, ".claude", "code-review", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, "owner-repo-3.lock");
  fs.writeFileSync(lockPath, "999999\nnowhere\n"); // dead pid
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const h = await acquireLock({ home, repo: "owner/repo", pr: 3, lockTtlMinutes: 30 });
  assert.ok(fs.existsSync(h.path));
  h.release();
});

// ─── Task 4-10: receipt + summary ───────────────────────────────────────────

test("renderHumanSummary + emitReceipt --json: stdout is JSON, stderr is text", () => {
  const r: Receipt = {
    ok: true, schema_version: 1, repo: "o/r", pr: 1,
    agent: null, agents_resolved: { security: "codex" },
    domains: ["security"],
    rounds: [{
      round: 1, findings: 0,
      summary: { fix: 0, noise: 0, false_positive: 0, ignored: 0, unclassified: 0, total: 0 },
      failed_results: [], parse_errors: [], classifier_errors: [], duration_ms: 1,
    }],
    fixes_pushed: 0, comments_posted: 0, unposted_reviews: [], history_files: [],
  };
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  emitReceipt(r, true, {
    stdout: { write: (c: string) => { outChunks.push(c); return true; } } as NodeJS.WritableStream,
    stderr: { write: (c: string) => { errChunks.push(c); return true; } } as NodeJS.WritableStream,
  });
  assert.equal(JSON.parse(outChunks.join("")).pr, 1);
  assert.match(errChunks.join(""), /stark-review/);
});

test("computeExitCode: 0 only when ok, no failures, no unposted", () => {
  const base: Receipt = {
    ok: true, schema_version: 1, repo: "o/r", pr: 1,
    agent: null, agents_resolved: {}, domains: [], rounds: [],
    fixes_pushed: 0, comments_posted: 0, unposted_reviews: [], history_files: [],
  };
  assert.equal(computeExitCode(base), 0);
  assert.equal(computeExitCode({ ...base, unposted_reviews: [{ round: 1, reason: "5xx" }] }), 1);
  const withFailure: Receipt = {
    ...base,
    rounds: [{
      round: 1, findings: 0,
      summary: { fix: 0, noise: 0, false_positive: 0, ignored: 0, unclassified: 0, total: 0 },
      failed_results: [{ domain: "security", agent: "codex", error: "x" }],
      parse_errors: [], classifier_errors: [], duration_ms: 1,
    }],
  };
  assert.equal(computeExitCode(withFailure), 1);
  const failure: Receipt = {
    ok: false, schema_version: 1, repo: "o/r", pr: 1,
    error: { code: "dispatch_failure", message: "all domains failed" },
    rounds: [],
  };
  assert.equal(computeExitCode(failure), 1);
});

// ─── findExistingMarker / GhError plumbing ──────────────────────────────────

test("findExistingMarker: matches review whose body starts with marker", async () => {
  const marker = buildMarker(1, "codex", "h");
  const ghMock = async () => ({
    status: 200,
    data: [{ body: `${marker}\n\nhello` }, { body: "unrelated" }],
    headers: {},
  });
  const found = await findExistingMarker({
    repo: "o/r", pr: 1, marker,
    ghJsonFn: ghMock as Parameters<typeof findExistingMarker>[0]["ghJsonFn"],
  });
  assert.equal(found, true);
});
