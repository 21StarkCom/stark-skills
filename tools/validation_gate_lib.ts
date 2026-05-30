/**
 * Validation gate — TypeScript port of `scripts/validation_gate.py`.
 *
 * Runs lint/typecheck/test commands for a repo and reports structured
 * results. Commands come from `validation_gate.per_repo_commands` in the
 * global config, or are auto-discovered from repo marker files when no
 * config entry exists.
 *
 * The Python imported `config_loader`; this port reads config via
 * `stark_config_lib.ts:loadGlobalConfig()` (same on-disk file).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getValidationGateConfig } from "./stark_config_lib.ts";

const ALLOWED_DISCOVERY_COMMANDS: ReadonlySet<string> = new Set([
  "npm test",
  "pytest",
  "make test",
  "python3 -m pytest",
]);

const DEFAULT_TIMEOUT_SECONDS = 60;

function logDir(): string {
  return path.join(os.homedir(), ".claude", "code-review", "logs");
}

export interface CheckResult {
  name: string;
  command: string | null;
  passed: boolean;
  duration_s: number;
  failure_pattern: string | null;
  stdout: string;
  stderr: string;
}

export interface ValidationResult {
  repo: string;
  checks: Array<{
    name: string;
    command: string | null;
    passed: boolean;
    duration_s: number;
    failure_pattern: string | null;
  }>;
  overall: "pass" | "fail";
  stderr_path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the repo name from `git remote get-url origin`, or `_default`. */
function getRepoName(repoRoot: string): string {
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: repoRoot,
    });
    if (r.status === 0) {
      let url = (r.stdout ?? "").trim();
      if (url.endsWith(".git")) url = url.slice(0, -4);
      const parts = url.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1];
    }
  } catch {
    // fall through
  }
  return "_default";
}

interface DiscoverResult {
  test_cmd: string | null;
  _security_rejected?: string;
}

/** Auto-discover the test command from repo marker files. */
function discoverCommands(repoRoot: string): DiscoverResult {
  let testCmd: string | null = null;

  if (fs.existsSync(path.join(repoRoot, "package.json"))) {
    testCmd = "npm test";
  } else if (fs.existsSync(path.join(repoRoot, "Makefile"))) {
    testCmd = "make test";
  } else if (
    fs.existsSync(path.join(repoRoot, "pytest.ini")) ||
    fs.existsSync(path.join(repoRoot, "pyproject.toml"))
  ) {
    testCmd = "pytest";
  }

  if (testCmd !== null && !ALLOWED_DISCOVERY_COMMANDS.has(testCmd)) {
    return { test_cmd: null, _security_rejected: testCmd };
  }
  return { test_cmd: testCmd };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Run a single check. Returns a result record. */
function runCheck(
  name: string,
  command: string | null,
  repoRoot: string,
  timeoutS: number,
): CheckResult {
  if (!command) {
    return {
      name,
      command,
      passed: false,
      duration_s: 0.0,
      failure_pattern: "TEST_COMMAND_MISSING",
      stdout: "",
      stderr: "",
    };
  }

  const start = performance.now();
  const r = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    timeout: timeoutS * 1000,
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationS = round3((performance.now() - start) / 1000);

  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === "ETIMEDOUT") {
    return {
      name,
      command,
      passed: false,
      duration_s: durationS,
      failure_pattern: "TIMEOUT",
      stdout: "",
      stderr: `Command timed out after ${timeoutS}s`,
    };
  }
  if (r.error) {
    return {
      name,
      command,
      passed: false,
      duration_s: durationS,
      failure_pattern: "TEST_FAILURE",
      stdout: "",
      stderr: String(r.error.message ?? r.error),
    };
  }

  const passed = r.status === 0;
  let failurePattern: string | null = null;
  if (!passed) {
    if (name === "lint") failurePattern = "LINT_ERROR";
    else if (name === "typecheck") failurePattern = "TYPE_ERROR";
    else failurePattern = "TEST_FAILURE";
  }
  return {
    name,
    command,
    passed,
    duration_s: durationS,
    failure_pattern: failurePattern,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function localTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Write combined stderr to a timestamped log file. Returns the path. */
function writeStderrLog(checks: CheckResult[]): string {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `run-${localTimestamp()}.stderr`);

  let combined = "";
  for (const check of checks) {
    if (check.stderr) {
      combined += `=== ${check.name} (${check.command}) ===\n${check.stderr}\n`;
    }
  }
  fs.writeFileSync(logPath, combined);
  return logPath;
}

// ---------------------------------------------------------------------------
// Config access — via the shared stark_config_lib section accessor.
// ---------------------------------------------------------------------------

/** Resolve the per-check timeout: config `timeout_seconds`, else 60. */
export function getConfiguredTimeout(): number {
  const n = Number(getValidationGateConfig().timeout_seconds);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_TIMEOUT_SECONDS;
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

export function runValidationGate(
  repoRoot: string,
  timeoutS: number,
): ValidationResult {
  const repo = getRepoName(repoRoot);

  const perRepoRaw = (getValidationGateConfig() as Record<string, unknown>)[
    "per_repo_commands"
  ];
  const perRepo: Record<string, unknown> =
    perRepoRaw && typeof perRepoRaw === "object" && !Array.isArray(perRepoRaw)
      ? (perRepoRaw as Record<string, unknown>)
      : {};
  // Python: `per_repo_commands.get(repo) or per_repo_commands.get("_default")`
  const configEntryRaw = perRepo[repo] || perRepo["_default"];
  const configEntry =
    configEntryRaw &&
    typeof configEntryRaw === "object" &&
    !Array.isArray(configEntryRaw)
      ? (configEntryRaw as Record<string, unknown>)
      : null;

  const checks: CheckResult[] = [];

  if (configEntry !== null) {
    const lintCmd = (configEntry["lint_cmd"] as string) || null;
    const typecheckCmd = (configEntry["typecheck_cmd"] as string) || null;
    const testCmd = (configEntry["test_cmd"] as string) || null;

    if (lintCmd) checks.push(runCheck("lint", lintCmd, repoRoot, timeoutS));
    if (typecheckCmd) {
      checks.push(runCheck("typecheck", typecheckCmd, repoRoot, timeoutS));
    }
    if (testCmd) checks.push(runCheck("test", testCmd, repoRoot, timeoutS));
  } else {
    const discovered = discoverCommands(repoRoot);
    if (discovered._security_rejected) {
      checks.push({
        name: "test",
        command: discovered._security_rejected,
        passed: false,
        duration_s: 0.0,
        failure_pattern: "SECURITY_REJECTED",
        stdout: "",
        stderr: `Discovered command '${discovered._security_rejected}' is not in the allowlist.`,
      });
    } else if (discovered.test_cmd) {
      checks.push(runCheck("test", discovered.test_cmd, repoRoot, timeoutS));
    }
    // else: no commands found — overall will be "pass" (nothing to fail)
  }

  const stderrPath = writeStderrLog(checks);

  const meaningful = checks.filter(
    (c) => c.failure_pattern !== "TEST_COMMAND_MISSING",
  );
  const overall: "pass" | "fail" =
    meaningful.length > 0
      ? meaningful.every((c) => c.passed)
        ? "pass"
        : "fail"
      : "pass";

  return {
    repo,
    checks: checks.map((c) => ({
      name: c.name,
      command: c.command,
      passed: c.passed,
      duration_s: c.duration_s,
      failure_pattern: c.failure_pattern,
    })),
    overall,
    stderr_path: stderrPath,
  };
}

/** Test seam — internal helpers exposed for unit testing only. */
export const __test = { discoverCommands, getRepoName, runCheck, localTimestamp };

export function formatTable(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`Validation gate — repo: ${result.repo}`);
  lines.push(`Overall: ${result.overall.toUpperCase()}`);
  lines.push("");
  if (result.checks.length === 0) {
    lines.push("  No checks ran (no commands configured or discovered).");
  } else {
    lines.push(
      `  ${"Check".padEnd(12)} ${"Cmd".padEnd(40)} ${"Passed".padEnd(8)} ${"Duration".padStart(10)} Pattern`,
    );
    lines.push(`  ${"-".repeat(80)}`);
    for (const c of result.checks) {
      const status = c.passed ? "YES" : "NO";
      const cmd = (c.command ?? "").slice(0, 38);
      const pattern = c.failure_pattern ?? "";
      const dur = `${c.duration_s.toFixed(2)}s`;
      lines.push(
        `  ${c.name.padEnd(12)} ${cmd.padEnd(40)} ${status.padEnd(8)} ${dur.padStart(9)} ${pattern}`,
      );
    }
  }
  lines.push("");
  lines.push(`Stderr log: ${result.stderr_path}`);
  return lines.join("\n");
}
