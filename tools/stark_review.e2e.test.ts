// Phase 6 — Task 6-5: opt-in integration tests gated on STARK_REVIEW_E2E=1.
//
// Unit tests catch logic bugs; these scenarios catch wiring bugs by exercising
// the dispatcher through real spawn() of the fake gh / codex / git binaries
// from tools/fixtures/bin/. Default `npm test` skips this file (the env var
// is unset); the weekly CI cron sets STARK_REVIEW_E2E=1 to run it.
//
// Each scenario uses a temp git repo with a committed `.code-review/config.json`
// so `loadTrustedConfig` reads valid bytes from the base ref. Fake gh returns
// canned PR metadata + an empty review list; fake codex emits a single
// JSONL agent_message containing one finding (or fails, depending on scenario).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { main } from "./stark_review.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.join(here, "fixtures", "bin");
const REPLAYS = path.join(here, "fixtures", "replays");

const E2E_ENABLED = process.env.STARK_REVIEW_E2E === "1";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitCommitAll(dir: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
}

function setupTrustedRepo(): { repo: string; worktree: string } {
  const repo = tmpDir("e2e-repo-");
  gitInit(repo);
  fs.mkdirSync(path.join(repo, ".code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({
      default_agent: "codex",
      quick_domains: ["security"],
      severity_overrides: {},
      fix_threshold: "medium",
      runtime: {
        lock_ttl_minutes: 30,
        subagent_env_allowlist: ["PATH", "HOME"],
        max_concurrent_agents: 2,
        temp_dir_prefix: "stark-e2e",
        large_pr_file_threshold: 40,
        large_pr_line_threshold: 3000,
        large_pr_timeout_s: 60,
      },
      history_retention_days: 0,
      lock_ttl_minutes: 30,
    }),
  );
  // The dispatcher reads global prompts from <configRoot>/prompts/<agent>/
  // (filesystem, not git show). Place them there.
  fs.mkdirSync(path.join(repo, "prompts", "codex"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "prompts", "codex", "agent.md"),
    "You are a security reviewer.",
  );
  fs.writeFileSync(
    path.join(repo, "prompts", "codex", "04-security.md"),
    "Review the diff for security issues.",
  );
  gitCommitAll(repo, "init");
  // Worktree: a separate temp dir, since loadTrustedConfig forbids configRoot
  // resolving inside it.
  const worktree = tmpDir("e2e-wt-");
  return { repo, worktree };
}

function withFakePath<T>(
  fixture: string,
  fn: (ctx: { logPath: string; home: string }) => Promise<T>,
): Promise<T> {
  const origPath = process.env.PATH;
  const origHome = process.env.HOME;
  const origLog = process.env.STARK_TEST_LOG;
  const fakeHome = tmpDir("e2e-home-");
  const logPath = path.join(fakeHome, "calls.log");
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${origPath ?? ""}`;
  process.env.HOME = fakeHome;
  process.env.STARK_TEST_FIXTURE = fixture;
  process.env.STARK_TEST_LOG = logPath;
  return fn({ logPath, home: fakeHome }).finally(() => {
    process.env.PATH = origPath;
    process.env.HOME = origHome;
    if (origLog === undefined) delete process.env.STARK_TEST_LOG;
    else process.env.STARK_TEST_LOG = origLog;
    delete process.env.STARK_TEST_FIXTURE;
  });
}

function readCalls(logPath: string): Array<{ bin: string; argv: string[] }> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: buf };
  } finally {
    process.stderr.write = orig;
  }
}

test("E2E: opt-in suite is skipped when STARK_REVIEW_E2E is unset (sentinel)", () => {
  // This test exists to make the gating explicit: when E2E is unset, the
  // remaining tests below short-circuit. Default CI must NOT run them.
  if (!E2E_ENABLED) {
    assert.equal(process.env.STARK_REVIEW_E2E ?? "", "");
    return;
  }
  // When E2E is set, this sentinel is a no-op.
  assert.ok(true);
});

test("E2E: happy dry-run posts no review and produces ok:true receipt", async (t) => {
  if (!E2E_ENABLED) { t.skip("STARK_REVIEW_E2E unset"); return; }
  const { repo, worktree } = setupTrustedRepo();
  const fixture = path.join(REPLAYS, "happy-dry-run");
  await withFakePath(fixture, async () => {
    const argv = [
      "--pr", "1",
      "--repo", "owner/repo",
      "--base", "HEAD",
      "--worktree", worktree,
      "--config-root", repo,
      "--domains", "security",
      "--dry-run",
      "--json",
    ];
    const { receipt, exitCode } = await main(argv);
    assert.equal(receipt.ok, true, "expected ok:true receipt for happy dry-run");
    assert.equal(exitCode, 0);
    if (receipt.ok) {
      assert.equal(receipt.unposted_reviews.length, 0);
      assert.equal(receipt.comments_posted, 0, "dry-run must not record posted comments");
    }
  });
});

test("E2E: --allow-untrusted-fix-loop emits the V1 warning AND makes zero edits via main()", async (t) => {
  if (!E2E_ENABLED) { t.skip("STARK_REVIEW_E2E unset"); return; }
  const { repo, worktree } = setupTrustedRepo();
  const fixture = path.join(REPLAYS, "happy-dry-run");
  const { result, stderr } = await captureStderr(() =>
    withFakePath(fixture, async ({ logPath }) => {
      const { receipt, exitCode } = await main([
        "--pr", "1",
        "--repo", "owner/repo",
        "--base", "HEAD",
        "--worktree", worktree,
        "--config-root", repo,
        "--domains", "security",
        "--allow-untrusted-fix-loop",
        "--dry-run",
        "--json",
      ]);
      const calls = readCalls(logPath);
      const gitMutations = calls.filter(
        (c) => c.bin === "git" && ["add", "commit", "push"].includes(c.argv[0]),
      );
      return { receipt, exitCode, gitMutations };
    }),
  );
  assert.match(
    stderr,
    /fix loop not enabled in V1/i,
    "main() must surface the V1 fix-loop warning to stderr",
  );
  assert.equal(
    result.gitMutations.length,
    0,
    `fix-loop denied implies zero edits; got ${JSON.stringify(result.gitMutations)}`,
  );
  assert.equal(result.receipt.ok, true);
  assert.equal(result.exitCode, 0);
});

test("E2E: dispatch failure surfaces ok:false with error.code='dispatch_failure'", async (t) => {
  if (!E2E_ENABLED) { t.skip("STARK_REVIEW_E2E unset"); return; }
  const { repo, worktree } = setupTrustedRepo();
  // dispatch-failure scenario: no codex-output.jsonl file present (codex fake
  // emits empty output); but more importantly, we plant a fake codex that
  // exits 1 — see /dispatch-failure replay dir.
  const fixture = path.join(REPLAYS, "dispatch-failure");
  fs.mkdirSync(fixture, { recursive: true });
  // Plant a sentinel file that the fake codex shell wrapper checks for. For
  // simplicity, we override the fake codex via PATH using a one-shot script.
  const overrideBin = tmpDir("e2e-bin-");
  fs.writeFileSync(
    path.join(overrideBin, "codex"),
    "#!/bin/sh\necho 'dispatch failure simulated' >&2\nexit 7\n",
  );
  fs.chmodSync(path.join(overrideBin, "codex"), 0o755);
  // gh from fake bin still serves PR metadata.
  fs.writeFileSync(
    path.join(fixture, "api_repos_owner_repo_pulls_2.json"),
    JSON.stringify({ head: { sha: "abc" }, title: "t", body: "b" }),
  );
  fs.writeFileSync(
    path.join(fixture, "api_repos_owner_repo_pulls_2_files.json"),
    JSON.stringify([{ filename: "src/h.ts" }]),
  );

  const origPath = process.env.PATH;
  const origHome = process.env.HOME;
  const fakeHome = tmpDir("e2e-home-");
  process.env.PATH = `${overrideBin}${path.delimiter}${FAKE_BIN}${path.delimiter}${origPath ?? ""}`;
  process.env.HOME = fakeHome;
  process.env.STARK_TEST_FIXTURE = fixture;
  try {
    const { receipt, exitCode } = await main([
      "--pr", "2",
      "--repo", "owner/repo",
      "--base", "HEAD",
      "--worktree", worktree,
      "--config-root", repo,
      "--domains", "security",
      "--json",
    ]);
    assert.equal(exitCode, 1);
    assert.equal(receipt.ok, false);
    if (!receipt.ok) {
      // Acceptance criterion: this test must catch a regression in the
      // dispatcher-failure path specifically. A pr_fetch / config / agent
      // failure passing here would defeat that, so pin the code exactly.
      assert.equal(
        receipt.error.code,
        "dispatch_failure",
        `expected dispatch_failure, got ${receipt.error.code}: ${receipt.error.message}`,
      );
    }
  } finally {
    process.env.PATH = origPath;
    process.env.HOME = origHome;
    delete process.env.STARK_TEST_FIXTURE;
  }
});
