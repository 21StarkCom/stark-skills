/**
 * Pre-flight environment validation — TypeScript port of
 * `scripts/preflight.py`.
 *
 * Runs a fixed registry of checks (CLI presence, keychain entries, App
 * auth, working-dir cleanliness, agent rotation, cost hard-stop, stale
 * locks, red-team config) and aggregates results into a
 * `PreFlightResult` whose `overall` field is one of `ready` /
 * `degraded` / `blocked`. Critical-tagged check failures escalate the
 * aggregate to `blocked`; non-critical failures or warns escalate to
 * `degraded`; all-pass stays `ready`.
 *
 * Results are appended as one JSON line to
 * `~/.claude/code-review/preflight.jsonl`. The append is best-effort —
 * a failure to write the log surfaces as a stderr warning and never
 * fails the run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getToken } from "./github_app_lib.ts";
import { isLockStale } from "./lock_helpers_lib.ts";
import {
  discoverConfig,
  getModelRates,
  getModelsConfig,
  getRedTeamConfig,
  isAgentEnabled,
  loadGlobalConfig,
} from "./stark_config_lib.ts";

// ---------------------------------------------------------------------------
// Paths + tunables — resolved lazily so tests can override HOME.
// ---------------------------------------------------------------------------

function logPath(): string {
  return path.join(os.homedir(), ".claude", "code-review", "preflight.jsonl");
}

function hardStopPath(): string {
  return path.join(os.homedir(), ".claude", "code-review", "cost-hard-stop");
}

// ---------------------------------------------------------------------------
// Result shape — JSON-stable across the Python and TS implementations.
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type Overall = "ready" | "degraded" | "blocked";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  duration_s: number;
}

export interface PreFlightResult {
  workflow: string;
  overall: Overall;
  checks: CheckResult[];
  recommended_mode: "abort" | "single-agent" | "full";
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

function runCmd(args: string[], timeoutMs: number = 5000): {
  ok: boolean;
  out: string;
} {
  const [cmd, ...rest] = args;
  if (!cmd) return { ok: false, out: "empty command" };
  let r;
  try {
    r = spawnSync(cmd, rest, { encoding: "utf8", timeout: timeoutMs });
  } catch (err) {
    return { ok: false, out: (err as Error).message };
  }
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, out: `not found: ${cmd}` };
    if (code === "ETIMEDOUT") {
      return { ok: false, out: `timed out after ${timeoutMs / 1000}s` };
    }
    return { ok: false, out: r.error.message };
  }
  if (r.status === 0) {
    const out = (r.stdout ?? "").trim();
    return { ok: true, out: out || "ok" };
  }
  const fallback =
    (r.stderr ?? "").trim() || (r.stdout ?? "").trim() || "non-zero exit";
  return { ok: false, out: fallback };
}

type CheckFn = () => Promise<[CheckStatus, string]> | [CheckStatus, string];

async function timed(fn: CheckFn): Promise<[CheckStatus, string, number]> {
  const t0 = performance.now();
  const result = await fn();
  const elapsed = Math.round((performance.now() - t0)) / 1000;
  return [result[0], result[1], Math.round(elapsed * 1000) / 1000];
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkCliClaude(): [CheckStatus, string] {
  const { ok, out } = runCmd(["claude", "--version"]);
  return ok ? ["pass", out] : ["fail", out];
}

export function checkCliCodex(): [CheckStatus, string] {
  const { ok, out } = runCmd(["codex", "--version"]);
  return ok ? ["pass", out] : ["fail", out];
}

export function checkCliGemini(): [CheckStatus, string] {
  if (!isAgentEnabled("gemini")) return ["skip", "gemini disabled in config"];
  const { ok, out } = runCmd(["gemini", "--version"]);
  return ok ? ["pass", out] : ["fail", out];
}

function keychainCheck(service: string): [CheckStatus, string] {
  const { ok, out } = runCmd([
    "security",
    "find-generic-password",
    "-s",
    service,
    "-w",
  ]);
  return ok ? ["pass", "key found"] : ["fail", `keychain: ${out}`];
}

export function checkKeychainClaude(): [CheckStatus, string] {
  return keychainCheck("STARK_CLAUDE_PRIVATE_KEY");
}

export function checkKeychainCodex(): [CheckStatus, string] {
  return keychainCheck("STARK_CODEX_PRIVATE_KEY");
}

export function checkKeychainGemini(): [CheckStatus, string] {
  if (!isAgentEnabled("gemini")) return ["skip", "gemini disabled in config"];
  return keychainCheck("STARK_GEMINI_PRIVATE_KEY");
}

export async function checkGithubApp(): Promise<[CheckStatus, string]> {
  try {
    const token = await getToken();
    return token
      ? ["pass", "token obtained"]
      : ["fail", "empty token returned"];
  } catch (err) {
    return ["fail", (err as Error).message];
  }
}

export function checkWorkingDir(): [CheckStatus, string] {
  const { ok, out } = runCmd(["git", "status", "--porcelain"]);
  if (!ok) return ["warn", `git status failed: ${out}`];
  if (out.trim() && out.trim() !== "ok") {
    return ["warn", "working directory has uncommitted changes"];
  }
  return ["pass", "clean"];
}

const TEAM_REVIEW_WORKFLOWS = new Set(["stark-team-review"]);

export function checkModelResolution(
  workflow?: string,
): [CheckStatus, string] {
  const models = getModelsConfig();
  const expected = ["claude", "codex"];
  const missing = expected.filter((a) => !(a in models));
  if (missing.length > 0) {
    return ["fail", `missing agent config: ${JSON.stringify(missing)}`];
  }
  const enabled = Object.entries(models)
    .filter(
      ([, cfg]) =>
        cfg && typeof cfg === "object" && Boolean((cfg as { enabled?: boolean }).enabled),
    )
    .map(([name]) => name)
    .sort();
  if (enabled.length === 0) {
    return ["fail", "no enabled agents in config"];
  }
  const disabled = Object.entries(models)
    .filter(
      ([, cfg]) =>
        cfg && typeof cfg === "object" && !((cfg as { enabled?: boolean }).enabled),
    )
    .map(([name]) => name)
    .sort();

  const isTeam = TEAM_REVIEW_WORKFLOWS.has(workflow ?? "");

  let dispatchList: string[] | null = null;
  let discoverWarning: string | null = null;
  try {
    const cfg = discoverConfig();
    const agentsList = cfg["agents"];
    if (agentsList === undefined) {
      // No override; the dispatcher uses the enabled set.
      dispatchList = [...enabled];
    } else if (
      Array.isArray(agentsList) &&
      agentsList.every((a) => typeof a === "string")
    ) {
      dispatchList = [...new Set(agentsList as string[])].sort();
    } else {
      // Don't include the raw value in the message — preflight.jsonl and
      // the durable queue would receive whatever the operator pasted in.
      discoverWarning = `config.agents is malformed (expected list[str], got ${Array.isArray(agentsList) ? "array<non-string>" : typeof agentsList})`;
    }
  } catch (err) {
    discoverWarning = `could not load review config: ${(err as Error).message}`;
  }

  if (discoverWarning !== null) {
    let msg = `enabled agents: ${JSON.stringify(enabled)}`;
    if (disabled.length > 0) {
      msg += `; disabled agents: ${JSON.stringify(disabled)}`;
    }
    const severity: CheckStatus = isTeam ? "fail" : "warn";
    return [severity, `${discoverWarning}; ${msg}`];
  }

  if (dispatchList === null) {
    // Unreachable today (no ImportError equivalent in TS) but kept for
    // structural parity with the Python.
    if (disabled.length > 0) {
      return [
        "pass",
        `enabled agents: ${JSON.stringify(enabled)}; disabled agents: ${JSON.stringify(disabled)}`,
      ];
    }
    return ["pass", `enabled agents: ${JSON.stringify(enabled)}`];
  }

  const enabledSet = new Set(enabled);
  const rotationSet = new Set(dispatchList);
  const dispatched = [...enabled].filter((a) => rotationSet.has(a)).sort();
  const enabledButExcluded = [...enabled]
    .filter((a) => !rotationSet.has(a))
    .sort();

  const notes: string[] = [`dispatched agents: ${JSON.stringify(dispatched)}`];
  if (enabledButExcluded.length > 0) {
    notes.push(
      `enabled but excluded from config.agents (silently skipped): ${JSON.stringify(enabledButExcluded)}`,
    );
  }
  if (disabled.length > 0) {
    notes.push(`disabled in models: ${JSON.stringify(disabled)}`);
  }

  if (dispatched.length === 0) {
    if (isTeam) {
      return [
        "fail",
        `team-review has no dispatchable agents — config.agents (${JSON.stringify([...rotationSet].sort())}) and enabled models (${JSON.stringify([...enabledSet].sort())}) don't overlap. Empty rotation would silently produce a clean 0-finding review.`,
      ];
    }
    notes.unshift(
      "no agents in the team-review intersection — single-agent dispatch may still work",
    );
    return ["warn", notes.join("; ")];
  }

  const status: CheckStatus = enabledButExcluded.length > 0 ? "warn" : "pass";
  return [status, notes.join("; ")];
}

export function checkCostHardStop(): [CheckStatus, string] {
  const p = hardStopPath();
  if (fs.existsSync(p)) return ["fail", `cost hard-stop active (${p})`];
  return ["pass", "no hard stop"];
}

export function checkDeprecatedConfig(): [CheckStatus, string] {
  let config: Record<string, unknown>;
  try {
    config = loadGlobalConfig();
  } catch (err) {
    return ["warn", `could not load config: ${(err as Error).message}`];
  }
  const automation = config["automation"];
  if (
    automation &&
    typeof automation === "object" &&
    !Array.isArray(automation) &&
    "model_pins" in (automation as Record<string, unknown>)
  ) {
    return [
      "warn",
      "automation.model_pins found in org/repo config override — remove it; use the 'models' block instead",
    ];
  }
  return ["pass", "no deprecated config keys"];
}

export function checkStaleLocks(): [CheckStatus, string] {
  const lockDirs = [
    path.join(os.homedir(), ".claude", "code-review"),
    "/tmp",
  ];
  const stale: string[] = [];
  for (const dir of lockDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".lock")) continue;
      const full = path.join(dir, name);
      if (isLockStale(full)) stale.push(full);
    }
  }
  if (stale.length > 0) {
    return ["warn", `stale lock files: ${stale.join(", ")}`];
  }
  return ["pass", "no stale locks"];
}

export function checkRedTeamModelRates(): [CheckStatus, string] {
  let cfg;
  try {
    cfg = getRedTeamConfig();
  } catch (err) {
    return ["warn", `could not load red_team config: ${(err as Error).message}`];
  }
  if (cfg.enabled === false) return ["skip", "red_team disabled in config"];
  const model = cfg.model;
  if (!model) return ["fail", "red_team.model is not set"];

  let rates;
  try {
    rates = getModelRates();
  } catch (err) {
    return ["warn", `could not load model_rates: ${(err as Error).message}`];
  }
  if (!(model in rates) || model === "_fallback") {
    return [
      "fail",
      `red_team.model '${model}' has no entry in model_rates — add one to global/config.json. _fallback is not accepted.`,
    ];
  }
  return ["pass", `rates found for ${model}`];
}

const RESPONSES_API_MODELS: ReadonlySet<string> = new Set([
  "o3",
  "o3-mini",
  "gpt-5.5-pro",
  "gpt-5.4-pro",
]);

/**
 * Resolve an OpenAI API key from the standard env-var pair: direct
 * `OPENAI_API_KEY`, or `OPENAI_API_KEY_FILE` + `OPENAI_API_KEY_LABEL`
 * pointing at a colon/equals-delimited credentials file with the label
 * to pluck. Mirrors `scripts/preflight.py::_resolve_openai_api_key`.
 */
export function resolveOpenaiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const direct = env["OPENAI_API_KEY"];
  if (direct) return direct;
  const filePath = env["OPENAI_API_KEY_FILE"];
  const label = env["OPENAI_API_KEY_LABEL"];
  if (!filePath || !label) return null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === label) return value;
  }
  return null;
}

export function checkRedTeamTransportAuth(): [CheckStatus, string] {
  let cfg;
  try {
    cfg = getRedTeamConfig();
  } catch (err) {
    return ["warn", `could not load red_team config: ${(err as Error).message}`];
  }
  if (cfg.enabled === false) return ["skip", "red_team disabled in config"];
  const model = cfg.model;
  if (!model || !RESPONSES_API_MODELS.has(model)) {
    return [
      "skip",
      `model ${JSON.stringify(model)} routes through codex CLI, not Responses API`,
    ];
  }
  if (resolveOpenaiApiKey() === null) {
    return [
      "fail",
      `red_team.model '${model}' routes through the Responses API but no OpenAI API key is available. Set OPENAI_API_KEY, or OPENAI_API_KEY_FILE+OPENAI_API_KEY_LABEL, in the environment.`,
    ];
  }
  return ["pass", `OpenAI API key resolved for ${model}`];
}

// ---------------------------------------------------------------------------
// Check registry: name → fn → is_critical. A `fail` status on a critical
// check sets `overall` to `blocked`. Order is preserved in the output.
// ---------------------------------------------------------------------------

export interface CheckDefinition {
  name: string;
  fn: (workflow?: string) => Promise<[CheckStatus, string]> | [CheckStatus, string];
  critical: boolean;
  workflowAware?: boolean;
}

export const CHECKS: ReadonlyArray<CheckDefinition> = [
  { name: "check_cli_claude", fn: checkCliClaude, critical: false },
  { name: "check_cli_codex", fn: checkCliCodex, critical: false },
  { name: "check_cli_gemini", fn: checkCliGemini, critical: false },
  { name: "check_keychain_claude", fn: checkKeychainClaude, critical: true },
  { name: "check_keychain_codex", fn: checkKeychainCodex, critical: true },
  { name: "check_keychain_gemini", fn: checkKeychainGemini, critical: true },
  { name: "check_github_app", fn: checkGithubApp, critical: true },
  { name: "check_working_dir", fn: checkWorkingDir, critical: false },
  {
    name: "check_model_resolution",
    fn: checkModelResolution,
    critical: true,
    workflowAware: true,
  },
  { name: "check_cost_hard_stop", fn: checkCostHardStop, critical: true },
  { name: "check_stale_locks", fn: checkStaleLocks, critical: false },
  { name: "check_deprecated_config", fn: checkDeprecatedConfig, critical: false },
  {
    name: "check_red_team_model_rates",
    fn: checkRedTeamModelRates,
    critical: true,
  },
  {
    name: "check_red_team_transport_auth",
    fn: checkRedTeamTransportAuth,
    critical: true,
  },
];

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateOverall(
  results: ReadonlyArray<{ status: CheckStatus; name: string }>,
  registry: ReadonlyArray<{ name: string; critical: boolean }> = CHECKS,
): { overall: Overall; recommendedMode: "abort" | "single-agent" | "full" } {
  const criticalSet = new Set(
    registry.filter((c) => c.critical).map((c) => c.name),
  );
  let hasCriticalFail = false;
  let hasDegraded = false;
  for (const r of results) {
    if (r.status === "fail") {
      if (criticalSet.has(r.name)) hasCriticalFail = true;
      else hasDegraded = true;
    } else if (r.status === "warn") {
      hasDegraded = true;
    }
  }
  if (hasCriticalFail) return { overall: "blocked", recommendedMode: "abort" };
  if (hasDegraded) return { overall: "degraded", recommendedMode: "single-agent" };
  return { overall: "ready", recommendedMode: "full" };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunPreflightOpts {
  workflow: string;
  skip?: ReadonlySet<string>;
  registry?: ReadonlyArray<CheckDefinition>;
}

export async function runPreflight(
  opts: RunPreflightOpts,
): Promise<PreFlightResult> {
  const skip = opts.skip ?? new Set<string>();
  const registry = opts.registry ?? CHECKS;
  const results: CheckResult[] = [];

  for (const def of registry) {
    if (skip.has(def.name)) {
      process.stderr.write(`  [SKIP-OVERRIDE] ${def.name}\n`);
      results.push({
        name: def.name,
        status: "skip",
        message: "skipped via --skip-check",
        duration_s: 0.0,
      });
      continue;
    }
    const callable: CheckFn = def.workflowAware
      ? () => def.fn(opts.workflow)
      : () => def.fn();
    const [status, message, duration_s] = await timed(callable);
    results.push({ name: def.name, status, message, duration_s });
  }

  const { overall, recommendedMode } = aggregateOverall(results, registry);

  return {
    workflow: opts.workflow,
    overall,
    checks: results,
    recommended_mode: recommendedMode,
    timestamp: new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
}

// ---------------------------------------------------------------------------
// Logging (best-effort)
// ---------------------------------------------------------------------------

export function logResult(result: PreFlightResult): void {
  const file = logPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(
      `preflight: warning: failed to write log: ${(err as Error).message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Human-readable table
// ---------------------------------------------------------------------------

const STATUS_SYMBOL: Record<CheckStatus, string> = {
  pass: "✓",
  fail: "✗",
  warn: "⚠",
  skip: "–",
};

const OVERALL_LABEL: Record<Overall, string> = {
  ready: "READY",
  degraded: "DEGRADED",
  blocked: "BLOCKED",
};

export function renderTable(result: PreFlightResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Preflight: ${result.workflow}  [${OVERALL_LABEL[result.overall]}]`);
  lines.push(`Check`.padEnd(30) + ` ${`St`.padEnd(5)} Message`);
  lines.push("-".repeat(72));
  for (const c of result.checks) {
    const sym = STATUS_SYMBOL[c.status] ?? "?";
    const dur = c.duration_s > 0 ? `(${c.duration_s.toFixed(3)}s)` : "";
    lines.push(
      `${c.name.padEnd(30)} ${sym} ${c.status.padEnd(5)}  ${c.message} ${dur}`.trimEnd(),
    );
  }
  lines.push("-".repeat(72));
  lines.push(`Recommended mode: ${result.recommended_mode}`);
  lines.push("");
  return lines.join("\n");
}
