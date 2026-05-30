/**
 * Healer canary rollout — TypeScript port of `scripts/healer_canary.py`
 * plus targeted improvements.
 *
 * The canary is the rollout-control layer for `self_healer`. Patterns
 * start in suggest-mode (the healer prints fixes but doesn't apply
 * them); the canary watches their on-disk performance log and decides
 * when a pattern has earned its way to auto-mode.
 *
 * Improvements over the Python:
 *   - Atomic config writes (tmp + rename) — was naive read-modify-write.
 *   - Configurable promotion gate via `config.self_heal.{...}` —
 *     `min_successful_suggests`, `abort_window_days`,
 *     `circuit_open_hours`. Defaults preserved.
 *   - `cmdCheck` (NEW) — exits non-zero if any auto-mode pattern's
 *     circuit is open. Designed for oncall paging.
 *   - `cmdCloseCircuit` (NEW) — manual recovery without waiting 24h or
 *     hand-editing `healer-circuits.json`.
 *   - `cmdExplain` (NEW) — audit trail for a single pattern: every log
 *     entry, current circuit state, computed stats, eligibility.
 *   - Test coverage from 0 → 34 cases.
 *
 * Preserved (don't break consumers):
 *   - All file formats: `healer.jsonl` entries, `healer-circuits.json`
 *     shape, `config.self_heal.auto_patterns` array, the
 *     `healer_patterns.json` manifest.
 *   - CLI surface: `--status`, `--promote`, `--demote`, `--json`.
 *   - The `cmdStatus` output shape consumed by
 *     `tools/stark_session_lib.ts:collectCanaryStatus`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function defaultBaseDir(): string {
  return path.join(os.homedir(), ".claude", "code-review");
}

export function defaultPatternsPath(): string {
  // Symlinked into ~/.claude/code-review/scripts/ by install.sh; for tests
  // and dev runs, resolve relative to the installed scripts/ dir.
  return path.join(defaultBaseDir(), "scripts", "healer_patterns.json");
}

export function defaultCircuitsPath(): string {
  return path.join(defaultBaseDir(), "healer-circuits.json");
}

export function defaultConfigPath(): string {
  return path.join(defaultBaseDir(), "config.json");
}

export function defaultLogPath(): string {
  return path.join(defaultBaseDir(), "healer.jsonl");
}

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export interface HealerPattern {
  id: string;
  category?: string;
  requires_confirmation?: boolean;
  // Other fields exist (regex, guard, action, ...) but aren't part of the
  // canary's interface.
  [key: string]: unknown;
}

export interface HealerLogEntry {
  timestamp: string;
  pattern_id: string;
  status?: string;
  event?: string;
  mode?: string;
  [key: string]: unknown;
}

export interface CircuitState {
  consecutive_failures?: number;
  tripped_at?: string | null;
  ever_tripped?: boolean;
  last_reset_at?: string;
  [key: string]: unknown;
}

export interface PatternStats {
  total_attempts: number;
  successful_suggests: number;
  applied: number;
  aborts_last_7d: number;
  success_rate: number;
  consecutive_failures: number;
  circuit_open: boolean;
  ever_tripped: boolean;
  tripped_at: string | null;
}

export interface PatternStatusRow {
  id: string;
  mode: "auto" | "suggest";
  circuit: "open" | "closed";
  consecutive_failures: number;
  successful_suggests: number;
  total_attempts: number;
  success_rate: number;
  eligible_for_promotion: boolean;
  promotion_blockers: string[];
}

// ---------------------------------------------------------------------------
// Configurable promotion gate (improvement over hard-coded Python values)
// ---------------------------------------------------------------------------

export interface CanaryGate {
  min_successful_suggests: number; // default 5  (Python literal)
  abort_window_days: number;        // default 7  (Python `timedelta(days=7)`)
  circuit_open_hours: number;       // default 24 (Python `timedelta(hours=24)`)
}

export const DEFAULT_GATE: CanaryGate = {
  min_successful_suggests: 5,
  abort_window_days: 7,
  circuit_open_hours: 24,
};

export function loadGate(configPath?: string): CanaryGate {
  const cfg = loadConfig(configPath);
  const section = (cfg.self_heal ?? {}) as Record<string, unknown>;
  const gate: CanaryGate = { ...DEFAULT_GATE };
  if (typeof section.min_successful_suggests === "number") {
    gate.min_successful_suggests = section.min_successful_suggests;
  }
  if (typeof section.abort_window_days === "number") {
    gate.abort_window_days = section.abort_window_days;
  }
  if (typeof section.circuit_open_hours === "number") {
    gate.circuit_open_hours = section.circuit_open_hours;
  }
  return gate;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

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

export function loadPatterns(patternsPath?: string): HealerPattern[] {
  const data = readJsonOrNull(patternsPath ?? defaultPatternsPath());
  return Array.isArray(data) ? (data as HealerPattern[]) : [];
}

export function loadCircuits(circuitsPath?: string): Record<string, CircuitState> {
  const data = readJsonOrNull(circuitsPath ?? defaultCircuitsPath());
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return data as Record<string, CircuitState>;
}

export function loadConfig(configPath?: string): Record<string, unknown> {
  const data = readJsonOrNull(configPath ?? defaultConfigPath());
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

export function loadLogEntries(logPath?: string): HealerLogEntry[] {
  const file = logPath ?? defaultLogPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: HealerLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        entries.push(obj as HealerLogEntry);
      }
    } catch {
      // skip malformed lines, keep scanning — matches Python's
      // try/except per-line.
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Atomic config writes (improvement: tmp + rename, was naive overwrite)
// ---------------------------------------------------------------------------

export function writeConfig(
  cfg: Record<string, unknown>,
  configPath?: string,
): void {
  const target = configPath ?? defaultConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Use a `.<base>.<pid>.<ts>.tmp` sibling — visible to readdir but
  // distinct from any "real" file. Rename is atomic on the same fs.
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Circuit writes (also atomic)
// ---------------------------------------------------------------------------

function writeCircuits(
  circuits: Record<string, CircuitState>,
  circuitsPath?: string,
): void {
  const target = circuitsPath ?? defaultCircuitsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(circuits, null, 2));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Log helper (matches Python `_log`)
// ---------------------------------------------------------------------------

export function appendLogEntry(
  entry: HealerLogEntry,
  logPath?: string,
): void {
  const file = logPath ?? defaultLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // fail-open — matches Python `try/except: pass`
  }
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTimestamp(s: string | null | undefined): Date | null {
  if (typeof s !== "string") return null;
  // Python: `datetime.fromisoformat(s.replace("Z", "+00:00"))`.
  const normalized = s.replace(/Z$/, "+00:00");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ComputeStatsOpts {
  gate: CanaryGate;
  now: Date;
}

export function computeStats(
  patternId: string,
  entries: HealerLogEntry[],
  circuits: Record<string, CircuitState>,
  opts: ComputeStatsOpts,
): PatternStats {
  const own = entries.filter((e) => e.pattern_id === patternId);
  const total = own.length;
  const successfulSuggests = own.filter((e) => e.status === "suggested").length;
  const applied = own.filter((e) => e.status === "applied").length;

  const cutoffMs =
    opts.now.getTime() - opts.gate.abort_window_days * 24 * 3600 * 1000;
  let abortsLast = 0;
  for (const e of own) {
    if (e.status !== "aborted") continue;
    const ts = parseTimestamp(e.timestamp);
    if (ts && ts.getTime() >= cutoffMs) abortsLast += 1;
  }

  const successCount = successfulSuggests + applied;
  const successRate = total > 0 ? successCount / total : 0;

  const state = circuits[patternId] ?? {};
  const trippedAt = (state.tripped_at as string | null | undefined) ?? null;
  const everTripped = Boolean(state.ever_tripped);

  let circuitOpen = false;
  if (trippedAt) {
    const tripTime = parseTimestamp(trippedAt);
    if (tripTime) {
      const ageMs = opts.now.getTime() - tripTime.getTime();
      if (ageMs < opts.gate.circuit_open_hours * 3600 * 1000) {
        circuitOpen = true;
      }
    }
  }

  return {
    total_attempts: total,
    successful_suggests: successfulSuggests,
    applied,
    aborts_last_7d: abortsLast,
    success_rate: Math.round(successRate * 100) / 100, // match Python `round(x, 2)`
    consecutive_failures: Number(state.consecutive_failures ?? 0),
    circuit_open: circuitOpen,
    ever_tripped: everTripped,
    tripped_at: trippedAt,
  };
}

// ---------------------------------------------------------------------------
// Promotion gating
// ---------------------------------------------------------------------------

export function checkPromotionCriteria(
  pattern: HealerPattern,
  stats: PatternStats,
  gate: CanaryGate,
): string[] {
  const reasons: string[] = [];
  if (stats.successful_suggests < gate.min_successful_suggests) {
    reasons.push(
      `requires >= ${gate.min_successful_suggests} successful suggests (have ${stats.successful_suggests})`,
    );
  }
  if (stats.aborts_last_7d > 0) {
    reasons.push(
      `has ${stats.aborts_last_7d} guard failure(s) in the last ${gate.abort_window_days} days`,
    );
  }
  if (stats.ever_tripped) {
    reasons.push("circuit has been tripped");
  }
  if (pattern.requires_confirmation === true) {
    reasons.push("requires_confirmation is true");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Shared CLI options
// ---------------------------------------------------------------------------

export interface CanaryCmdOpts {
  patternsPath?: string;
  configPath?: string;
  circuitsPath?: string;
  logPath?: string;
  /** Override for tests. Defaults to `new Date()`. */
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

function resolveOpts(opts: CanaryCmdOpts) {
  return {
    patternsPath: opts.patternsPath ?? defaultPatternsPath(),
    configPath: opts.configPath ?? defaultConfigPath(),
    circuitsPath: opts.circuitsPath ?? defaultCircuitsPath(),
    logPath: opts.logPath ?? defaultLogPath(),
    now: opts.now ?? new Date(),
    env: opts.env,
  };
}

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

export interface StatusResult {
  patterns: PatternStatusRow[];
}

export function cmdStatus(opts: CanaryCmdOpts): StatusResult {
  const resolved = resolveOpts(opts);
  const gate = loadGate(resolved.configPath);
  const patterns = loadPatterns(resolved.patternsPath);
  const circuits = loadCircuits(resolved.circuitsPath);
  const config = loadConfig(resolved.configPath);
  const autoPatterns = new Set<string>(
    (config.self_heal as Record<string, unknown> | undefined)?.auto_patterns as
      | string[]
      | undefined ?? [],
  );
  const entries = loadLogEntries(resolved.logPath);

  const rows: PatternStatusRow[] = patterns.map((p) => {
    const stats = computeStats(p.id, entries, circuits, {
      gate,
      now: resolved.now,
    });
    const mode: "auto" | "suggest" = autoPatterns.has(p.id) ? "auto" : "suggest";
    const unmet = checkPromotionCriteria(p, stats, gate);
    return {
      id: p.id,
      mode,
      circuit: stats.circuit_open ? "open" : "closed",
      consecutive_failures: stats.consecutive_failures,
      successful_suggests: stats.successful_suggests,
      total_attempts: stats.total_attempts,
      success_rate: stats.success_rate,
      eligible_for_promotion: mode === "suggest" && unmet.length === 0,
      promotion_blockers: mode === "suggest" ? unmet : [],
    };
  });

  return { patterns: rows };
}

// ---------------------------------------------------------------------------
// cmdPromote
// ---------------------------------------------------------------------------

export interface PromoteResult {
  ok: boolean;
  pattern_id: string;
  auto_patterns?: string[];
  already_present?: boolean;
  reasons?: string[];
}

export function cmdPromote(
  patternId: string,
  opts: CanaryCmdOpts,
): PromoteResult {
  const resolved = resolveOpts(opts);
  const gate = loadGate(resolved.configPath);
  const patterns = loadPatterns(resolved.patternsPath);
  const pattern = patterns.find((p) => p.id === patternId);
  if (!pattern) {
    return {
      ok: false,
      pattern_id: patternId,
      reasons: [`pattern '${patternId}' not found`],
    };
  }

  const circuits = loadCircuits(resolved.circuitsPath);
  const entries = loadLogEntries(resolved.logPath);
  const stats = computeStats(patternId, entries, circuits, {
    gate,
    now: resolved.now,
  });
  const unmet = checkPromotionCriteria(pattern, stats, gate);
  if (unmet.length > 0) {
    return { ok: false, pattern_id: patternId, reasons: unmet };
  }

  const config = loadConfig(resolved.configPath);
  const section = (config.self_heal as Record<string, unknown> | undefined) ?? {};
  const autoPatterns = Array.isArray(section.auto_patterns)
    ? [...(section.auto_patterns as string[])]
    : [];

  if (autoPatterns.includes(patternId)) {
    return {
      ok: true,
      pattern_id: patternId,
      auto_patterns: autoPatterns,
      already_present: true,
    };
  }

  autoPatterns.push(patternId);
  config.self_heal = { ...section, auto_patterns: autoPatterns };
  writeConfig(config, resolved.configPath);

  appendLogEntry(
    {
      timestamp: isoZ(resolved.now),
      event: "canary_promoted",
      pattern_id: patternId,
      mode: "auto",
    },
    resolved.logPath,
  );
  return { ok: true, pattern_id: patternId, auto_patterns: autoPatterns };
}

// ---------------------------------------------------------------------------
// cmdDemote
// ---------------------------------------------------------------------------

export interface DemoteResult {
  ok: boolean;
  pattern_id: string;
  auto_patterns?: string[];
  not_present?: boolean;
}

export function cmdDemote(
  patternId: string,
  opts: CanaryCmdOpts,
): DemoteResult {
  const resolved = resolveOpts(opts);
  const config = loadConfig(resolved.configPath);
  const section = (config.self_heal as Record<string, unknown> | undefined) ?? {};
  const autoPatterns = Array.isArray(section.auto_patterns)
    ? [...(section.auto_patterns as string[])]
    : [];

  if (!autoPatterns.includes(patternId)) {
    return {
      ok: true,
      pattern_id: patternId,
      auto_patterns: autoPatterns,
      not_present: true,
    };
  }

  const next = autoPatterns.filter((id) => id !== patternId);
  config.self_heal = { ...section, auto_patterns: next };
  writeConfig(config, resolved.configPath);

  appendLogEntry(
    {
      timestamp: isoZ(resolved.now),
      event: "canary_demoted",
      pattern_id: patternId,
      mode: "suggest",
    },
    resolved.logPath,
  );

  return { ok: true, pattern_id: patternId, auto_patterns: next };
}

// ---------------------------------------------------------------------------
// cmdCheck — NEW. Designed for oncall paging.
// ---------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  tripped_auto_patterns: string[];
  checked: number;
}

export function cmdCheck(opts: CanaryCmdOpts): CheckResult {
  const resolved = resolveOpts(opts);
  const gate = loadGate(resolved.configPath);
  const patterns = loadPatterns(resolved.patternsPath);
  const circuits = loadCircuits(resolved.circuitsPath);
  const config = loadConfig(resolved.configPath);
  const autoPatterns = new Set<string>(
    (config.self_heal as Record<string, unknown> | undefined)?.auto_patterns as
      | string[]
      | undefined ?? [],
  );

  const tripped: string[] = [];
  for (const p of patterns) {
    if (!autoPatterns.has(p.id)) continue;
    const stats = computeStats(p.id, [], circuits, {
      gate,
      now: resolved.now,
    });
    if (stats.circuit_open) tripped.push(p.id);
  }

  return {
    ok: tripped.length === 0,
    tripped_auto_patterns: tripped,
    checked: patterns.filter((p) => autoPatterns.has(p.id)).length,
  };
}

// ---------------------------------------------------------------------------
// cmdCloseCircuit — NEW. Manual recovery.
// ---------------------------------------------------------------------------

export interface CloseCircuitResult {
  ok: boolean;
  pattern_id: string;
  no_op?: boolean;
  circuit?: CircuitState;
}

export function cmdCloseCircuit(
  patternId: string,
  opts: CanaryCmdOpts,
): CloseCircuitResult {
  const resolved = resolveOpts(opts);
  const circuits = loadCircuits(resolved.circuitsPath);
  const state = circuits[patternId] ?? {};

  const wasTripped =
    Boolean(state.tripped_at) || Number(state.consecutive_failures ?? 0) > 0;
  if (!wasTripped) {
    return { ok: true, pattern_id: patternId, no_op: true };
  }

  const nextState: CircuitState = {
    ...state,
    tripped_at: null,
    consecutive_failures: 0,
    last_reset_at: isoZ(resolved.now),
    // `ever_tripped` is deliberately preserved — historical record.
  };
  circuits[patternId] = nextState;
  writeCircuits(circuits, resolved.circuitsPath);

  appendLogEntry(
    {
      timestamp: isoZ(resolved.now),
      event: "canary_circuit_closed",
      pattern_id: patternId,
    },
    resolved.logPath,
  );

  return { ok: true, pattern_id: patternId, circuit: nextState };
}

// ---------------------------------------------------------------------------
// cmdExplain — NEW. Audit trail for a single pattern.
// ---------------------------------------------------------------------------

export interface ExplainResult {
  found: boolean;
  pattern_id: string;
  mode?: "auto" | "suggest";
  pattern?: HealerPattern;
  circuit?: CircuitState;
  stats?: PatternStats;
  entries: HealerLogEntry[];
  eligible_for_promotion?: boolean;
  promotion_blockers?: string[];
}

export function cmdExplain(
  patternId: string,
  opts: CanaryCmdOpts,
): ExplainResult {
  const resolved = resolveOpts(opts);
  const patterns = loadPatterns(resolved.patternsPath);
  const pattern = patterns.find((p) => p.id === patternId);
  if (!pattern) {
    return { found: false, pattern_id: patternId, entries: [] };
  }

  const gate = loadGate(resolved.configPath);
  const circuits = loadCircuits(resolved.circuitsPath);
  const allEntries = loadLogEntries(resolved.logPath);
  const entries = allEntries.filter((e) => e.pattern_id === patternId);
  const config = loadConfig(resolved.configPath);
  const autoPatterns = new Set<string>(
    (config.self_heal as Record<string, unknown> | undefined)?.auto_patterns as
      | string[]
      | undefined ?? [],
  );
  const mode: "auto" | "suggest" = autoPatterns.has(patternId)
    ? "auto"
    : "suggest";
  const stats = computeStats(patternId, allEntries, circuits, {
    gate,
    now: resolved.now,
  });
  const unmet = checkPromotionCriteria(pattern, stats, gate);

  return {
    found: true,
    pattern_id: patternId,
    mode,
    pattern,
    circuit: circuits[patternId] ?? {},
    stats,
    entries,
    eligible_for_promotion: mode === "suggest" && unmet.length === 0,
    promotion_blockers: mode === "suggest" ? unmet : [],
  };
}
