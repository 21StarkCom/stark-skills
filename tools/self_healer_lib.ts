/**
 * Self-healer — TypeScript port of `scripts/self_healer.py` (407 LOC).
 *
 * Given a stderr capture and a pattern id, decides whether to suggest a
 * fix or auto-apply it. Walks a gate ladder:
 *   guard cmd → max_per_session → auto-mode allowlist → circuit breaker
 *   → suggest/auto branch → execute → outcome → circuit update.
 *
 * Improvements over the Python (matches the healer_canary precedent):
 *   - Atomic writes for `healer-session.json` and `healer-circuits.json`
 *     (tmp + rename). Python was naive `write_text(...)`.
 *   - Critical/warning alerts go directly through `alert_delivery_lib` —
 *     `scripts/alert_delivery.py` import is gone. Self_healer was its
 *     last consumer, so the Python comes out in the same slice.
 *   - Test coverage from 0 → 22 cases. The Python had no tests at all
 *     for a module that auto-modifies files.
 *
 * Preserved (don't break consumers):
 *   - All file formats: `healer.jsonl`, `healer-circuits.json`,
 *     `healer-session.json`, `healer_patterns.json`.
 *   - CLI surface: `--pattern-id ID --stderr-file PATH [--mode
 *     suggest|auto] [--json]`.
 *   - Result shape: same keys (`status`, `reason`, `pattern_id`,
 *     `action`, `verify_passed`, `requires_confirmation`).
 *   - Gate semantics: same order, same outcomes, same downgrade rule
 *     (mode=auto + pattern not in auto_patterns → effective=suggest).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emitAlert } from "./alert_delivery_lib.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function defaultBaseDir(): string {
  return path.join(os.homedir(), ".claude", "code-review");
}

export function defaultPatternsPath(): string {
  return path.join(defaultBaseDir(), "scripts", "healer_patterns.json");
}

export function defaultSessionPath(): string {
  return path.join(defaultBaseDir(), "healer-session.json");
}

export function defaultCircuitsPath(): string {
  return path.join(defaultBaseDir(), "healer-circuits.json");
}

export function defaultLogPath(): string {
  return path.join(defaultBaseDir(), "healer.jsonl");
}

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export interface HealerPattern {
  id: string;
  action: string;
  guard?: string | null;
  verify_command?: string;
  requires_confirmation?: boolean;
  max_per_session?: number;
  [key: string]: unknown;
}

export interface CircuitState {
  consecutive_failures?: number;
  tripped_at?: string | null;
  ever_tripped?: boolean;
  last_reset_at?: string;
  [key: string]: unknown;
}

export type HealMode = "suggest" | "auto";

// ---------------------------------------------------------------------------
// Atomic write helper (mirrors healer_canary_lib)
// ---------------------------------------------------------------------------

function writeAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function readJsonOrNull(p: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session counters
// ---------------------------------------------------------------------------

export function readSession(sessionPath?: string): Record<string, number> {
  const data = readJsonOrNull(sessionPath ?? defaultSessionPath());
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return data as Record<string, number>;
}

export function writeSession(
  data: Record<string, number>,
  sessionPath?: string,
): void {
  writeAtomic(sessionPath ?? defaultSessionPath(), JSON.stringify(data));
}

export function sessionCount(patternId: string, sessionPath?: string): number {
  const data = readSession(sessionPath);
  const v = data[patternId];
  return typeof v === "number" ? v : 0;
}

export function sessionIncrement(patternId: string, sessionPath?: string): void {
  const data = readSession(sessionPath);
  data[patternId] = (data[patternId] ?? 0) + 1;
  writeSession(data, sessionPath);
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export function loadCircuits(
  circuitsPath?: string,
): Record<string, CircuitState> {
  const data = readJsonOrNull(circuitsPath ?? defaultCircuitsPath());
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return data as Record<string, CircuitState>;
}

export function writeCircuits(
  data: Record<string, CircuitState>,
  circuitsPath?: string,
): void {
  writeAtomic(
    circuitsPath ?? defaultCircuitsPath(),
    JSON.stringify(data, null, 2),
  );
}

interface CircuitOpts {
  now: Date;
  circuitsPath?: string;
}

function parseTimestamp(s: string | null | undefined): Date | null {
  if (typeof s !== "string") return null;
  const normalized = s.replace(/Z$/, "+00:00");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isCircuitTripped(
  patternId: string,
  threshold: number,
  opts: CircuitOpts,
): boolean {
  const state = loadCircuits(opts.circuitsPath)[patternId] ?? {};
  const tripTime = parseTimestamp(state.tripped_at as string | null | undefined);
  if (tripTime) {
    const ageMs = opts.now.getTime() - tripTime.getTime();
    if (ageMs < 24 * 3600 * 1000) return true;
  }
  return Number(state.consecutive_failures ?? 0) >= threshold;
}

export function recordCircuitFailure(
  patternId: string,
  threshold: number,
  opts: CircuitOpts,
): boolean {
  const circuits = loadCircuits(opts.circuitsPath);
  const state: CircuitState = { ...(circuits[patternId] ?? {}) };
  state.consecutive_failures = Number(state.consecutive_failures ?? 0) + 1;
  let newlyTripped = false;
  if (state.consecutive_failures >= threshold && !state.tripped_at) {
    state.tripped_at = isoZ(opts.now);
    state.ever_tripped = true;
    newlyTripped = true;
  }
  circuits[patternId] = state;
  writeCircuits(circuits, opts.circuitsPath);
  return newlyTripped;
}

export function recordCircuitSuccess(
  patternId: string,
  opts: CircuitOpts,
): void {
  const circuits = loadCircuits(opts.circuitsPath);
  const state: CircuitState = { ...(circuits[patternId] ?? {}) };
  state.consecutive_failures = 0;
  state.tripped_at = null;
  state.last_reset_at = isoZ(opts.now);
  circuits[patternId] = state;
  writeCircuits(circuits, opts.circuitsPath);
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function runVerify(cmd: string): boolean {
  const result = spawnSync(cmd, [], {
    shell: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  return result.status === 0;
}

interface ExecutionOutcome {
  success: boolean;
  verify_passed: boolean;
}

/**
 * Execute a pattern's action. The `refresh_token` action shells out to the
 * TS GitHub-App CLI to mint a fresh installation token. All other actions
 * are stubs that print "not yet implemented" and return success=true.
 */
function executeAction(
  pattern: HealerPattern,
  scriptsDir: string,
  logFn: (msg: string) => void,
): ExecutionOutcome {
  let success = true;
  if (pattern.action === "refresh_token") {
    // scriptsDir is `<base>/scripts`; the TS CLI sits at `<base>/tools/`.
    const toolsDir = path.join(path.dirname(scriptsDir), "tools");
    const result = spawnSync(
      "node",
      ["--experimental-strip-types", path.join(toolsDir, "github_app.ts"), "token"],
      { encoding: "utf8", timeout: 30_000 },
    );
    success = result.status === 0;
  } else if (pattern.action === "release_stale_lock") {
    logFn("no lock path specified, skipping");
    success = true;
  } else {
    logFn(`action ${pattern.action} not yet implemented`);
    success = true;
  }
  const verifyPassed = runVerify(pattern.verify_command ?? "true");
  return { success, verify_passed: verifyPassed };
}

// ---------------------------------------------------------------------------
// Log helper (append-only, matches Python `_log`)
// ---------------------------------------------------------------------------

function appendLog(entry: Record<string, unknown>, logPath: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // fail-open — matches Python try/except
  }
}

// ---------------------------------------------------------------------------
// Public flow — runHeal
// ---------------------------------------------------------------------------

export interface RunHealOpts {
  patternId: string;
  stderrFile: string;
  mode: HealMode;
  /** Per-pattern circuit-trip threshold (Python: `config.self_heal.circuit_breaker_threshold`, default 3). */
  threshold?: number;
  /** Patterns whose mode=auto is honored (Python: `config.self_heal.auto_patterns`). */
  autoPatterns?: string[];
  /** Path overrides; defaults from `defaultBaseDir()`. */
  patternsPath?: string;
  sessionPath?: string;
  circuitsPath?: string;
  logPath?: string;
  /** Override for the alert_delivery base dir. */
  alertsBaseDir?: string;
  /** Override for the scripts dir. Defaults to `~/.claude/code-review/scripts`; the
   * sibling `tools/` directory hosts the GitHub-App TS CLI used by `refresh_token`. */
  scriptsDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Optional sink for the "no lock path specified" style action stub output. Defaults to stdout. */
  log?: (msg: string) => void;
}

export interface RunHealResult {
  exit: number;
  result: Record<string, unknown>;
}

export function runHeal(opts: RunHealOpts): RunHealResult {
  const now = opts.now ?? new Date();
  const threshold = opts.threshold ?? 3;
  const autoPatterns = new Set(opts.autoPatterns ?? []);
  const patternsPath = opts.patternsPath ?? defaultPatternsPath();
  const sessionPath = opts.sessionPath ?? defaultSessionPath();
  const circuitsPath = opts.circuitsPath ?? defaultCircuitsPath();
  const logPath = opts.logPath ?? defaultLogPath();
  const alertsBaseDir = opts.alertsBaseDir; // undefined => alert_delivery default
  const scriptsDir = opts.scriptsDir ?? path.join(defaultBaseDir(), "scripts");
  const logFn = opts.log ?? ((s: string) => process.stdout.write(`${s}\n`));

  // -------- Load patterns --------
  const patternsRaw = readJsonOrNull(patternsPath);
  if (!Array.isArray(patternsRaw)) {
    return {
      exit: 1,
      result: { error: `Cannot load patterns: ${patternsPath}` },
    };
  }
  const pattern = (patternsRaw as HealerPattern[]).find(
    (p) => p.id === opts.patternId,
  );
  if (!pattern) {
    return {
      exit: 1,
      result: { error: `Pattern not found: ${opts.patternId}` },
    };
  }

  // -------- stderr-file must exist --------
  if (!fs.existsSync(opts.stderrFile)) {
    return {
      exit: 1,
      result: { error: `stderr file not found: ${opts.stderrFile}` },
    };
  }

  const ts = isoZ(now);

  // -------- Gate: guard cmd --------
  if (pattern.guard) {
    const guard = spawnSync(pattern.guard, [], {
      shell: true,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (guard.status !== 0) {
      const result: Record<string, unknown> = {
        status: "aborted",
        reason: "guard_failed",
        guard: pattern.guard,
      };
      if (guard.error) result.error = String(guard.error);
      appendLog(
        {
          timestamp: ts,
          pattern_id: pattern.id,
          action: pattern.action,
          mode: opts.mode,
          status: "aborted",
          reason: "guard_failed",
        },
        logPath,
      );
      return { exit: 0, result };
    }
  }

  // -------- Gate: max_per_session --------
  if (typeof pattern.max_per_session === "number") {
    const count = sessionCount(pattern.id, sessionPath);
    if (count >= pattern.max_per_session) {
      return {
        exit: 0,
        result: {
          status: "aborted",
          reason: "max_per_session_reached",
          pattern_id: pattern.id,
          count,
          max_per_session: pattern.max_per_session,
        },
      };
    }
  }

  // -------- Auto-mode gate (effective mode downgrade) --------
  let effectiveMode: HealMode = opts.mode;
  if (opts.mode === "auto" && !autoPatterns.has(pattern.id)) {
    effectiveMode = "suggest";
  }

  // -------- Gate: circuit breaker (auto mode only) --------
  if (effectiveMode === "auto" && isCircuitTripped(pattern.id, threshold, { now, circuitsPath })) {
    const result: Record<string, unknown> = {
      status: "skipped",
      reason: "circuit_open",
      pattern_id: pattern.id,
      action: pattern.action,
    };
    appendLog(
      {
        timestamp: ts,
        pattern_id: pattern.id,
        action: pattern.action,
        mode: "auto",
        status: "skipped",
        reason: "circuit_open",
      },
      logPath,
    );
    try {
      emitAlert({
        level: "warning",
        source: "self_healer",
        message: `Pattern ${pattern.id} circuit is open — auto-heal skipped`,
        baseDir: alertsBaseDir,
      });
    } catch {
      // alert delivery is best-effort; never break the heal flow.
    }
    return { exit: 0, result };
  }

  // -------- Suggest mode --------
  if (effectiveMode === "suggest") {
    const result: Record<string, unknown> = {
      status: "suggested",
      pattern_id: pattern.id,
      action: pattern.action,
      requires_confirmation: pattern.requires_confirmation ?? false,
    };
    appendLog(
      {
        timestamp: ts,
        pattern_id: pattern.id,
        action: pattern.action,
        mode: effectiveMode,
        status: "suggested",
      },
      logPath,
    );
    return { exit: 0, result };
  }

  // -------- Auto + requires_confirmation → skip (won't auto-apply) --------
  if (pattern.requires_confirmation === true) {
    const result: Record<string, unknown> = {
      status: "skipped",
      reason: "requires_confirmation",
      pattern_id: pattern.id,
      action: pattern.action,
    };
    appendLog(
      {
        timestamp: ts,
        pattern_id: pattern.id,
        action: pattern.action,
        mode: "auto",
        status: "skipped",
      },
      logPath,
    );
    return { exit: 0, result };
  }

  // -------- Auto mode: execute --------
  const execution = executeAction(pattern, scriptsDir, logFn);
  if (typeof pattern.max_per_session === "number" && execution.success) {
    sessionIncrement(pattern.id, sessionPath);
  }

  const result: Record<string, unknown> = {
    status: "applied",
    pattern_id: pattern.id,
    action: pattern.action,
    verify_passed: execution.verify_passed,
  };
  appendLog(
    {
      timestamp: ts,
      pattern_id: pattern.id,
      action: pattern.action,
      mode: "auto",
      status: "applied",
    },
    logPath,
  );

  // -------- Circuit update based on outcome --------
  if (execution.success && execution.verify_passed) {
    recordCircuitSuccess(pattern.id, { now, circuitsPath });
  } else {
    const newlyTripped = recordCircuitFailure(pattern.id, threshold, {
      now,
      circuitsPath,
    });
    if (newlyTripped) {
      try {
        emitAlert({
          level: "critical",
          source: "self_healer",
          message: `Pattern ${pattern.id} circuit tripped after ${threshold} consecutive failures`,
          baseDir: alertsBaseDir,
        });
      } catch {
        // best-effort
      }
    }
  }

  return { exit: 0, result };
}
