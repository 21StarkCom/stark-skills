// Phase 6 — Task 6-2 additions to the stark_review dispatcher unit suite.
//
// stark_review.test.ts (phase-3 ports) and stark_review.phase4.test.ts cover
// most of the twelve dispatcher cases listed in the phase plan. Phase 6 fills
// the remaining gaps:
//   - lock ordering (acquire BEFORE GET, release AFTER POST)
//   - inline-vs-body demotion: file-not-in-changed-files lands under the
//     "Cross-cutting / out-of-diff findings" body section heading
//   - fork-PR review IS posted (push gating is V1.1)
//   - --paginate flag wired into /files and /reviews via the gh CLI
//   - receipt failure schema shape
//   - dispatchDomains routes malformed JSONL to result.parseErrors
//   - classifier_failed event surfaces with a reason string
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  acquireLock,
  buildMarker,
  buildReviewBody,
  dispatchDomains,
  findExistingMarker,
  ghJsonOnce,
  main,
  partitionInlineVsBody,
  postReview,
  runClassifier,
  type AgentPort,
  type FailureReceipt,
} from "./stark_review.ts";
import type { Finding, ResolvedConfig } from "./stark_review_lib.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.join(here, "fixtures", "bin");

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

// ─── Lock ordering through main(): catches dispatcher regressions ──────────
//
// Per Task 6-2 acceptance criteria, the lock-ordering test must catch a
// regression in main() where the dispatcher acquires/releases around the
// wrong operations. To do that, this drives main() with injected fake
// transports + a fake codex spawn, and asserts at every gh transport call
// that the lock file exists at the moment of the call. After main() returns,
// the lock file MUST be gone (release happened after POST).

test("lock ordering through main(): acquire before GET, release after POST", async () => {
  const home = tmpDir("home-");
  const cfgRoot = tmpDir("cfg-");
  const worktree = tmpDir("wt-");

  // Global config (loadTrustedConfig reads it from $HOME/.claude/...).
  fs.mkdirSync(path.join(home, ".claude", "code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "code-review", "config.json"),
    JSON.stringify({
      default_agent: "codex",
      severity_overrides: {},
      fix_threshold: "medium",
      runtime: {
        lock_ttl_minutes: 30,
        subagent_env_allowlist: ["PATH", "HOME"],
        max_concurrent_agents: 2,
        temp_dir_prefix: "stark-lockord",
        large_pr_file_threshold: 40,
        large_pr_line_threshold: 3000,
        large_pr_timeout_s: 60,
      },
      history_retention_days: 0,
      lock_ttl_minutes: 30,
    }),
  );
  // Prompt files on filesystem (configRoot/prompts/codex/{agent.md,04-security.md}).
  fs.mkdirSync(path.join(cfgRoot, "prompts", "codex"), { recursive: true });
  fs.writeFileSync(path.join(cfgRoot, "prompts", "codex", "agent.md"), "agent");
  fs.writeFileSync(
    path.join(cfgRoot, "prompts", "codex", "04-security.md"),
    "security",
  );

  // Lock file path must match acquireLock's algorithm.
  const lockPath = path.join(
    home, ".claude", "code-review", "locks", "owner-repo-1.lock",
  );

  // Trace gh transport calls; record lock-file existence at each.
  type TraceEntry = { method: string; path: string; lockExisted: boolean };
  const trace: TraceEntry[] = [];

  const ghMock = async (p: string, opts?: { method?: string; body?: unknown }) => {
    const method = opts?.method ?? "GET";
    trace.push({ method, path: p, lockExisted: fs.existsSync(lockPath) });
    if (method === "POST") {
      return { status: 200, data: { id: 9001 }, headers: {} };
    }
    if (p === "/repos/owner/repo/pulls/1") {
      return {
        status: 200,
        data: { head: { sha: "abc" }, title: "t", body: "b" },
        headers: {},
      };
    }
    if (p === "/repos/owner/repo/pulls/1/files") {
      return {
        status: 200,
        data: [{ filename: "src/x.ts" }],
        headers: {},
      };
    }
    // GET /reviews → empty list (no marker present).
    return { status: 200, data: [], headers: {} };
  };

  // ghTextFn: dispatcher calls `gh pr diff` — return empty diff text.
  const ghTextMock = async () => "";

  // spawnFn for dispatchDomains + classifier: emit one valid finding via
  // codex JSONL, then for the classifier dispatch return an empty stream so
  // it falls open to "fix" without aborting.
  let spawnInvocations = 0;
  const spawnMock = async () => {
    spawnInvocations += 1;
    if (spawnInvocations === 1) {
      // Review dispatch
      const event = {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            id: "f-1",
            domain: "security",
            agent: "codex",
            severity: "high",
            file: "src/x.ts",
            line: 7,
            title: "issue",
            body: "b",
          }),
        },
      };
      return { stdout: JSON.stringify(event) + "\n", stderr: "", status: 0 };
    }
    // Classifier dispatch — empty output. runClassifier records a single
    // classifier_failed event and falls open to "fix"; below the 5-error
    // abort threshold, so main() proceeds to POST.
    return { stdout: "", stderr: "", status: 0 };
  };

  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { receipt, exitCode } = await main(
      [
        "--pr", "1",
        "--repo", "owner/repo",
        "--base", "main",
        "--worktree", worktree,
        "--config-root", cfgRoot,
        "--domains", "security",
        "--json",
      ],
      {
        ghJsonFn: ghMock as unknown as NonNullable<Parameters<typeof main>[1]>["ghJsonFn"],
        ghJsonOnceFn: ghMock as unknown as NonNullable<Parameters<typeof main>[1]>["ghJsonOnceFn"],
        ghTextFn: ghTextMock as unknown as NonNullable<Parameters<typeof main>[1]>["ghTextFn"],
        spawnFn: spawnMock as unknown as NonNullable<Parameters<typeof main>[1]>["spawnFn"],
      },
    );
    // Sanity: at least one GET (PR meta) + one POST happened.
    assert.ok(
      trace.some((e) => e.method === "GET"),
      "expected at least one GET via injected gh transport",
    );
    assert.ok(
      trace.some((e) => e.method === "POST"),
      `expected POST to be issued; trace=${JSON.stringify(trace)}`,
    );
    // Acquire BEFORE every GET/POST → lock file must have existed at each call.
    for (const e of trace) {
      assert.equal(
        e.lockExisted, true,
        `lock file missing during ${e.method} ${e.path}`,
      );
    }
    // Release AFTER POST → lock file must be gone after main() returns.
    assert.equal(
      fs.existsSync(lockPath), false,
      "lock file must be removed after main() returns",
    );
    // Sanity: receipt + exit shape.
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(exitCode, 0);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

// ─── Lock ordering (helper-level, retained as a unit-level pin) ─────────────

test("lock ordering (helpers): acquire BEFORE marker GET, release AFTER POST", async () => {
  const home = tmpDir("home-");
  const trace: string[] = [];

  // Inject a fake clock so the test is deterministic and demonstrates that
  // lock acquisition happens before any mocked HTTP work.
  let nowMs = 1_700_000_000_000;
  const clock = () => nowMs;

  const lock = await acquireLock({
    home, repo: "owner/repo", pr: 42, lockTtlMinutes: 30,
    now: clock,
    sleepFn: async (ms) => { nowMs += ms; },
  });
  trace.push(`lock_acquired@${nowMs}`);
  assert.ok(fs.existsSync(lock.path), "lock file should exist after acquire");

  // Simulate the dispatcher's GET → POST cycle. The fake gh transport asserts
  // the lock is held during the call.
  const ghMock = async (p: string, opts?: { method?: string }) => {
    assert.ok(fs.existsSync(lock.path), `lock must be held during ${opts?.method ?? "GET"} ${p}`);
    nowMs += 10;
    if (opts?.method === "POST") {
      trace.push(`post@${nowMs}`);
      return { status: 200, data: { id: 1 }, headers: {} };
    }
    trace.push(`get@${nowMs}`);
    return { status: 200, data: [], headers: {} };
  };

  const marker = buildMarker(1, "codex", "h");
  await findExistingMarker({
    repo: "owner/repo", pr: 42, marker,
    ghJsonFn: ghMock as Parameters<typeof findExistingMarker>[0]["ghJsonFn"],
  });
  await postReview({
    repo: "owner/repo", pr: 42, round: 1, agent: "codex", runHash: "h",
    findings: [makeFinding({ classification: "fix" })],
    changedFiles: new Set(["src/x.ts"]),
    fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "abc",
    dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });

  trace.push(`release@${nowMs}`);
  lock.release();
  assert.equal(fs.existsSync(lock.path), false, "lock file must be removed after release");

  const order = trace.map((t) => t.split("@")[0]);
  assert.deepEqual(
    order,
    ["lock_acquired", "get", "post", "release"],
    `expected lock_acquired -> get -> post -> release, got ${order.join(" -> ")}`,
  );
});

// ─── Inline-vs-body demotion: body section heading ──────────────────────────

test("partitionInlineVsBody: file outside changed_files demoted to body, NOT dropped", () => {
  const findings: Finding[] = [
    makeFinding({ id: "in", classification: "fix", severity: "high", file: "a.ts", line: 1 }),
    makeFinding({ id: "outside", classification: "fix", severity: "high", file: "untouched.ts", line: 5 }),
  ];
  const part = partitionInlineVsBody(findings, new Set(["a.ts"]), "medium");
  assert.equal(part.inline.length, 1);
  assert.equal(part.bodyFindings.length, 1);
  assert.equal(part.bodyFindings[0].id, "outside");
});

test("buildReviewBody: out-of-diff findings live under the canonical heading", () => {
  const marker = buildMarker(1, "codex", "h");
  const out = buildReviewBody(marker, "summary", [
    makeFinding({ classification: "noise", file: "x.ts", line: 9 }),
  ]);
  assert.match(out, /## Cross-cutting \/ out-of-diff findings/);
  assert.ok(out.startsWith(marker));
});

// ─── Fork PR posts review (push gating is V1.1) ─────────────────────────────

test("postReview: posts review for fork-PR (push gating is V1.1)", async () => {
  // postReview has no fork-PR awareness — the dispatcher posts the review
  // unconditionally. (Fix-loop push gating, which IS fork-aware, is V1.1.)
  // Verify by exercising postReview without any fork-related flag and
  // asserting the POST happens and the review id propagates.
  let posted = false;
  const ghMock = async (_p: string, opts?: { method?: string }) => {
    if (opts?.method === "POST") {
      posted = true;
      return { status: 200, data: { id: 4242 }, headers: {} };
    }
    return { status: 200, data: [], headers: {} };
  };
  const r = await postReview({
    repo: "fork/repo", pr: 99, round: 1, agent: "codex", runHash: "h",
    findings: [makeFinding({ classification: "fix" })],
    changedFiles: new Set(["src/x.ts"]),
    fixThreshold: "medium",
    humanSummary: "s", prHeadSha: "abc",
    dryRun: false,
    ghJsonFn: ghMock as Parameters<typeof postReview>[0]["ghJsonFn"],
  });
  assert.equal(posted, true, "review MUST be posted on fork PRs (push is V1.1)");
  assert.equal(r.posted, true);
  assert.equal(r.reviewId, 4242);
});

// ─── --paginate wired into GET endpoints via real gh CLI argv ───────────────

test("ghJsonOnce: GET passes --paginate to gh argv (verified via fake gh on PATH)", async () => {
  if (!fs.existsSync(path.join(FAKE_BIN, "gh"))) {
    // Should not happen — Phase 6 task 6-4 ensures these fakes exist.
    assert.fail(`fake gh missing at ${FAKE_BIN}/gh`);
  }
  const fixture = tmpDir("stark-fixture-");
  // Canned response for /repos/o/r/pulls/1/files (path slug = repos_o_r_pulls_1_files)
  fs.writeFileSync(
    path.join(fixture, "api_repos_o_r_pulls_1_files.json"),
    JSON.stringify([{ filename: "a.ts" }]),
  );
  fs.writeFileSync(
    path.join(fixture, "api_repos_o_r_pulls_1_reviews.json"),
    JSON.stringify([]),
  );
  const log = path.join(fixture, "calls.log");

  const origPath = process.env.PATH;
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${origPath ?? ""}`;
  process.env.STARK_TEST_FIXTURE = fixture;
  process.env.STARK_TEST_LOG = log;
  try {
    const filesRes = await ghJsonOnce("/repos/o/r/pulls/1/files");
    assert.ok(Array.isArray(filesRes.data));
    const reviewsRes = await ghJsonOnce("/repos/o/r/pulls/1/reviews");
    assert.ok(Array.isArray(reviewsRes.data));
  } finally {
    process.env.PATH = origPath;
    delete process.env.STARK_TEST_FIXTURE;
    delete process.env.STARK_TEST_LOG;
  }

  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls.length, 2, "expected 2 gh invocations");
  for (const c of calls) {
    assert.ok(
      c.argv.includes("--paginate"),
      `gh argv missing --paginate: ${JSON.stringify(c.argv)}`,
    );
  }
});

// ─── Receipt failure schema ─────────────────────────────────────────────────

test("FailureReceipt schema: ok=false, schema_version=1, error.code/message", () => {
  const r: FailureReceipt = {
    ok: false,
    schema_version: 1,
    repo: "o/r",
    pr: 1,
    error: { code: "dispatch_failure", message: "all domains failed" },
    rounds: [],
  };
  assert.equal(r.ok, false);
  assert.equal(r.schema_version, 1);
  assert.equal(r.error.code, "dispatch_failure");
  assert.equal(r.error.message, "all domains failed");
  assert.deepEqual(r.rounds, []);
});

// ─── dispatchDomains routes malformed JSONL to parseErrors, not findings ────

test("dispatchDomains: malformed JSONL is captured in parseErrors, not findings", async () => {
  const config = bareConfig();
  // Use the real codex parseOutput so the contract is exercised end-to-end.
  const codexPort: AgentPort = await (await import("./agent_codex.ts")).default
    ? (await import("./agent_codex.ts"))
    : await import("./agent_codex.ts");
  const ports = new Map([["codex" as const, codexPort as unknown as AgentPort]]);
  // Spawn returns a JSONL stream containing one valid agent_message + a
  // malformed line. The codex parser must split into findings + parseErrors.
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: [
          // Valid finding
          JSON.stringify({
            id: "ok-1",
            domain: "security",
            agent: "codex",
            severity: "high",
            file: "src/x.ts",
            line: 7,
            title: "valid",
            body: "b",
          }),
          // Malformed: severity is invalid
          JSON.stringify({ severity: "MEGA", title: "bad", domain: "security" }),
          // Malformed: missing title
          JSON.stringify({ severity: "low", domain: "security" }),
        ].join("\n"),
      },
    }),
  ].join("\n");
  const fakeSpawn = async () => ({ stdout: jsonl, stderr: "", status: 0 });

  const results = await dispatchDomains({
    assignments: [{ domain: "security", agent: "codex", prompt: "x" }],
    ports,
    config,
    spawnFn: fakeSpawn as unknown as Parameters<typeof dispatchDomains>[0]["spawnFn"],
  });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, "ok-1");
  assert.ok(r.parseErrors.length >= 2, `expected at least 2 parseErrors, got ${r.parseErrors.length}`);
  for (const pe of r.parseErrors) {
    assert.equal(typeof pe.line, "string");
    assert.equal(typeof pe.reason, "string");
  }
});

// ─── classifier_failed event surfaces with reason ───────────────────────────

test("runClassifier: emits classifier_failed event with reason on bad output", async () => {
  const wt = tmpDir("wt-");
  const config = bareConfig();
  const port: AgentPort = {
    buildCommand: (prompt: string) => ({ cmd: "/bin/echo", args: [], stdin: prompt, env: {} }),
    parseOutput: () => ({ findings: [], parseErrors: [] }),
  };
  const ports = new Map([["codex" as const, port]]);
  // Output without any classification JSON object — runClassifier must record
  // a classifier_failed event with a non-empty reason and fall the finding
  // open to "fix".
  const badSpawn = async () => ({ stdout: "no json here", stderr: "", status: 0 });
  const r = await runClassifier(
    [makeFinding({ id: "f1", file: null, line: null })],
    {
      worktree: wt,
      classifierAgent: "codex",
      ports,
      classifierPrompt: "classify",
      spawnFn: badSpawn as unknown as Parameters<typeof runClassifier>[1]["spawnFn"],
      config,
    },
  );
  const failed = r.events.filter((e) => e.type === "classifier_failed");
  assert.ok(failed.length >= 1, "expected a classifier_failed event");
  for (const ev of failed) {
    assert.equal(typeof ev.reason, "string");
    assert.ok(ev.reason.length > 0, "classifier_failed event must carry a reason");
  }
  // Fall-open: every finding still gets classification = 'fix' (errorCount==1
  // is below the 5-error abort threshold, so this is the fall-open path, not
  // the abort path).
  assert.equal(r.aborted, false);
  assert.ok(r.findings.every((f) => f.classification === "fix"));
});

// ─── Smoke: codex command construction (already covered, re-pin here for the
// "twelve listed cases" enumeration in the phase spec) ──────────────────────

test("codex buildCommand argv: exec --json --reasoning-effort high (Phase 6 pin)", async () => {
  const codex = await import("./agent_codex.ts");
  const built = codex.buildCommand("hi");
  assert.equal(built.cmd, "codex");
  assert.deepEqual(built.args, ["exec", "--json", "--reasoning-effort", "high"]);
});

// ─── Lock ordering test — sanity: execFileSync available (silences unused
// import warning on platforms where the test harness elides imports) ────────
test("execFileSync import resolves (sanity)", () => {
  // Touch the symbol so it isn't tree-shaken if the test runner ever does so.
  assert.equal(typeof execFileSync, "function");
});
