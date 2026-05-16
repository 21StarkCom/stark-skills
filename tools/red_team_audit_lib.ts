/**
 * SQLite audit lib for the stark-red-team pipeline.
 *
 * TS port of `scripts/red_team_audit.py` (the durable write layer).
 * Uses `node:sqlite` (built-in on Node 22+; we run Node 26). No npm dep.
 *
 * Tables:
 *   - red_team_runs           one row per full red-team cycle
 *   - red_team_persona_stats  per-persona per-round aggregate counts
 *   - red_team_findings       raw finding text under FU-rt6 retention
 *
 * Schema constants here MUST stay byte-equivalent to the Python original
 * - the parity test (`red_team_audit_parity.test.ts`) feeds identical
 * inputs into both implementations and diffs the resulting DB state.
 * Drift between TS writes and Python reads would corrupt audit history.
 *
 * Phase 5a scope: this lib exists alongside Python `red_team_audit.py`;
 * neither is the canonical writer yet. Phase 5b will cut the dispatcher
 * over to TS and delete the Python module.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import {
  applyToField,
  policyFromConfig,
  policyMode,
  type AuditRetentionPolicy,
} from "./red_team_audit_text_lib.ts";

// Schema --- identical (modulo whitespace) to
// `scripts/red_team_audit.py::_CREATE_TABLES`. Migrations (v1.2 +
// v1.3) ALTER on top of this so existing DBs stamped by the canonical
// audit CLI pick up the newer columns idempotently.

export const CREATE_TABLES_SQL = `\
CREATE TABLE IF NOT EXISTS red_team_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    rounds_used INTEGER NOT NULL,
    final_status TEXT NOT NULL,
    total_findings INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    high_count INTEGER NOT NULL,
    medium_count INTEGER NOT NULL,
    human_review_count INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    cost_usd REAL NOT NULL,
    model TEXT NOT NULL,
    caller TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    repo TEXT,
    artifact_relative_path TEXT,
    pr_number INTEGER,
    fix_plan_status TEXT,
    fix_plan_md TEXT,
    fix_plan_json TEXT,
    fix_plan_cost_usd REAL
);

CREATE TABLE IF NOT EXISTS red_team_persona_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    findings_raised INTEGER NOT NULL,
    findings_at_critical INTEGER NOT NULL,
    findings_at_high INTEGER NOT NULL,
    findings_at_medium INTEGER NOT NULL,
    human_review_requests INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS red_team_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    finding_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    severity TEXT NOT NULL,
    concern TEXT NOT NULL,
    consequence TEXT NOT NULL,
    counter_proposal TEXT NOT NULL,
    trade_off TEXT,
    reason_for_uncertainty TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    stable_key TEXT,
    concern_hash TEXT,
    risk_key TEXT,
    affected_component TEXT,
    failure_mode TEXT
);

CREATE INDEX IF NOT EXISTS idx_red_team_findings_run
    ON red_team_findings(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_red_team_findings_persona
    ON red_team_findings(persona, severity);
`;

const RED_TEAM_RUNS_V12_COLUMNS: ReadonlyArray<[string, string]> = [
  ["repo", "TEXT"],
  ["artifact_relative_path", "TEXT"],
  ["pr_number", "INTEGER"],
  ["fix_plan_status", "TEXT"],
  ["fix_plan_md", "TEXT"],
  ["fix_plan_json", "TEXT"],
  ["fix_plan_cost_usd", "REAL"],
];

const RED_TEAM_FINDINGS_V13_COLUMNS: ReadonlyArray<[string, string]> = [
  ["stable_key", "TEXT"],
  ["concern_hash", "TEXT"],
  ["risk_key", "TEXT"],
  ["affected_component", "TEXT"],
  ["failure_mode", "TEXT"],
  ["concern_excerpt_hash", "TEXT"],
  ["consequence_excerpt_hash", "TEXT"],
  ["counter_proposal_excerpt_hash", "TEXT"],
  ["trade_off_excerpt_hash", "TEXT"],
  ["reason_for_uncertainty_excerpt_hash", "TEXT"],
  ["retention_mode", "TEXT"],
];

/** Open a SQLite connection with WAL + busy_timeout pragmas.
 *  Caller owns lifetime - always close() in a try/finally. */
export function connect(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

/** Create parent dir if needed, then apply `schemaSql`. */
export function initDb(dbPath: string, schemaSql: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = connect(dbPath);
  try {
    db.exec(schemaSql);
  } finally {
    db.close();
  }
}

export function initRedTeamTables(dbPath: string): void {
  initDb(dbPath, CREATE_TABLES_SQL);
  migrateRedTeamRunsV12(dbPath);
  migrateRedTeamFindingsV13(dbPath);
}

function migrateRedTeamRunsV12(dbPath: string): void {
  const db = connect(dbPath);
  try {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(red_team_runs)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const [name, decl] of RED_TEAM_RUNS_V12_COLUMNS) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE red_team_runs ADD COLUMN ${name} ${decl}`);
        existing.add(name);
      }
    }
  } finally {
    db.close();
  }
}

function migrateRedTeamFindingsV13(dbPath: string): void {
  const db = connect(dbPath);
  try {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(red_team_findings)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const [name, decl] of RED_TEAM_FINDINGS_V13_COLUMNS) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE red_team_findings ADD COLUMN ${name} ${decl}`);
        existing.add(name);
      }
    }
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_red_team_findings_stable_key " +
          "ON red_team_findings(stable_key)",
      );
    } catch {
      // Index already exists or column missing on legacy DB; ignore.
    }
  } finally {
    db.close();
  }
}

export interface RedTeamRunRow {
  run_id: string;
  stage: string;
  rounds_used: number;
  final_status: string;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  human_review_count: number;
  duration_s: number;
  cost_usd: number;
  model: string;
  caller: string;
  repo?: string | null;
  artifact_relative_path?: string | null;
  pr_number?: number | null;
  fix_plan_status?: string | null;
  fix_plan_md?: string | null;
  fix_plan_json?: string | null;
  fix_plan_cost_usd?: number | null;
  created_at?: string | null;
}

export interface FindingRow {
  run_id: string;
  stage: string;
  round_num: number;
  finding_id: string;
  persona: string;
  severity: string;
  concern: string;
  consequence: string;
  counter_proposal: string;
  trade_off: string | null;
  reason_for_uncertainty: string | null;
  stable_key?: string | null;
  concern_hash?: string | null;
  risk_key?: string | null;
  affected_component?: string | null;
  failure_mode?: string | null;
}

export interface PersonaStatRow {
  run_id: string;
  stage: string;
  round_num: number;
  persona: string;
  findings_raised: number;
  findings_at_critical: number;
  findings_at_high: number;
  findings_at_medium: number;
  human_review_requests: number;
}

/** Recursively walk a JSON-decoded value, returning a new value whose
 *  object keys are sorted. Matches Python's `json.dumps(sort_keys=True)`
 *  which sorts at every level — top-level only would diverge on nested
 *  objects (e.g. inside `moves[]`), which is exactly the parity bug the
 *  audit_parity test caught on first run. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
    return sorted;
  }
  return value;
}

/** Strip raw_output from a serialized fix-plan JSON before audit storage.
 *  Mirrors Python `_sanitize_fix_plan_json` - re-serializes with sorted
 *  keys + compact separators so equivalent objects produce byte-identical
 *  strings. Non-dict shapes pass through unchanged. */
export function sanitizeFixPlanJson(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return s;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return s;
  const obj = { ...(parsed as Record<string, unknown>) };
  delete obj.raw_output;
  return JSON.stringify(sortKeysDeep(obj));
}

const RUN_INSERT_BASE_SQL =
  "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, " +
  "total_findings, critical_count, high_count, medium_count, " +
  "human_review_count, duration_s, cost_usd, model, caller, repo, " +
  "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, " +
  "fix_plan_json, fix_plan_cost_usd";

const RUN_INSERT_NO_CREATED =
  `${RUN_INSERT_BASE_SQL}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const RUN_INSERT_WITH_CREATED =
  `${RUN_INSERT_BASE_SQL}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Insert one red_team_runs row. Mirrors Python `record_red_team_run`,
 *  including the `created_at` branch (lets backfill pass an authoritative
 *  ISO timestamp instead of letting SQLite default to now). */
export function recordRedTeamRun(
  runData: RedTeamRunRow,
  dbPath: string,
): void {
  const sanitizedFixPlanJson = sanitizeFixPlanJson(runData.fix_plan_json ?? null);
  const createdAt = runData.created_at ?? null;
  const baseArgs = [
    runData.run_id,
    runData.stage,
    runData.rounds_used,
    runData.final_status,
    runData.total_findings,
    runData.critical_count,
    runData.high_count,
    runData.medium_count,
    runData.human_review_count,
    runData.duration_s,
    runData.cost_usd,
    runData.model,
    runData.caller,
    runData.repo ?? null,
    runData.artifact_relative_path ?? null,
    runData.pr_number ?? null,
    runData.fix_plan_status ?? "pending",
    runData.fix_plan_md ?? null,
    sanitizedFixPlanJson,
    runData.fix_plan_cost_usd ?? null,
  ];
  const db = connect(dbPath);
  try {
    let stmt: StatementSync;
    let args: unknown[];
    if (createdAt === null) {
      stmt = db.prepare(RUN_INSERT_NO_CREATED);
      args = baseArgs;
    } else {
      stmt = db.prepare(RUN_INSERT_WITH_CREATED);
      args = [...baseArgs, createdAt];
    }
    stmt.run(...(args as never[]));
  } finally {
    db.close();
  }
}

const FINDING_INSERT_SQL =
  "INSERT INTO red_team_findings (" +
  "run_id, stage, round_num, finding_id, " +
  "persona, severity, concern, consequence, counter_proposal, " +
  "trade_off, reason_for_uncertainty, " +
  "stable_key, concern_hash, risk_key, affected_component, failure_mode, " +
  "concern_excerpt_hash, consequence_excerpt_hash, " +
  "counter_proposal_excerpt_hash, trade_off_excerpt_hash, " +
  "reason_for_uncertainty_excerpt_hash, retention_mode" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function buildFindingInsertArgs(
  f: FindingRow,
  policy: AuditRetentionPolicy,
): unknown[] {
  const concern = applyToField(f.concern, policy);
  const consequence = applyToField(f.consequence, policy);
  const counter = applyToField(f.counter_proposal, policy);
  const tradeOff = applyToField(f.trade_off, policy);
  const reason = applyToField(f.reason_for_uncertainty, policy);
  return [
    f.run_id,
    f.stage,
    f.round_num,
    f.finding_id,
    f.persona,
    f.severity,
    concern.stored,
    consequence.stored,
    counter.stored,
    tradeOff.stored,
    reason.stored,
    f.stable_key ?? null,
    f.concern_hash ?? null,
    f.risk_key ?? null,
    f.affected_component ?? null,
    f.failure_mode ?? null,
    concern.hash,
    consequence.hash,
    counter.hash,
    tradeOff.hash,
    reason.hash,
    policyMode(policy),
  ];
}

/** Insert one durable red_team_findings row. Free-text fields are
 *  passed through the FU-rt6 retention policy. */
export function recordFinding(
  f: FindingRow,
  dbPath: string,
  policy: AuditRetentionPolicy,
): void {
  const db = connect(dbPath);
  try {
    db.prepare(FINDING_INSERT_SQL).run(
      ...(buildFindingInsertArgs(f, policy) as never[]),
    );
  } finally {
    db.close();
  }
}

/** Insert many findings in one connection, atomically. Same retention
 *  policy per row. Wrapped in BEGIN/COMMIT/ROLLBACK so a mid-batch
 *  failure leaves zero rows persisted — matches Python's deferred-commit
 *  semantics (`conn.execute()` * N, then a single `conn.commit()`). */
export function recordFindings(
  findings: readonly FindingRow[],
  dbPath: string,
  policy: AuditRetentionPolicy,
): void {
  const db = connect(dbPath);
  try {
    const stmt = db.prepare(FINDING_INSERT_SQL);
    db.exec("BEGIN");
    try {
      for (const f of findings) {
        stmt.run(...(buildFindingInsertArgs(f, policy) as never[]));
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore secondary failure */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

const PERSONA_INSERT_SQL =
  "INSERT INTO red_team_persona_stats (run_id, stage, round_num, persona, " +
  "findings_raised, findings_at_critical, findings_at_high, " +
  "findings_at_medium, human_review_requests) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function recordPersonaStats(
  stats: readonly PersonaStatRow[],
  dbPath: string,
): void {
  const db = connect(dbPath);
  try {
    const stmt = db.prepare(PERSONA_INSERT_SQL);
    db.exec("BEGIN");
    try {
      for (const s of stats) {
        stmt.run(
          s.run_id,
          s.stage,
          s.round_num,
          s.persona,
          s.findings_raised,
          s.findings_at_critical,
          s.findings_at_high,
          s.findings_at_medium,
          s.human_review_requests,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore secondary failure */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Update the persisted fix-plan state for an existing red-team run.
 *  Throws when no row exists for runId. */
export function recordFixPlan(
  runId: string,
  opts: {
    fixPlanMd: string | null;
    fixPlanJson: string | null;
    fixPlanCostUsd: number | null;
    fixPlanStatus: string;
  },
  dbPath: string,
): void {
  const sanitizedJson = sanitizeFixPlanJson(opts.fixPlanJson);
  const db = connect(dbPath);
  try {
    const stmt = db.prepare(
      "UPDATE red_team_runs " +
        "SET fix_plan_md = ?, fix_plan_json = ?, fix_plan_cost_usd = ?, " +
        "fix_plan_status = ? " +
        "WHERE run_id = ?",
    );
    const info = stmt.run(
      opts.fixPlanMd,
      sanitizedJson,
      opts.fixPlanCostUsd,
      opts.fixPlanStatus,
      runId,
    );
    if (info.changes !== 1) {
      throw new Error(`red_team_runs row not found for run_id=${JSON.stringify(runId)}`);
    }
  } finally {
    db.close();
  }
}

/** Delete rows older than `retentionDays` from runs + findings.
 *  Returns total rows deleted (sum across both tables). */
export function pruneRedTeamMetrics(
  retentionDays: number,
  dbPath: string,
): number {
  const cutoff = `-${retentionDays} days`;
  const db = connect(dbPath);
  try {
    db.exec("BEGIN");
    try {
      const r1 = db
        .prepare(
          "DELETE FROM red_team_runs WHERE created_at < " +
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
        )
        .run(cutoff);
      const r2 = db
        .prepare(
          "DELETE FROM red_team_findings WHERE created_at < " +
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
        )
        .run(cutoff);
      db.exec("COMMIT");
      return Number(r1.changes) + Number(r2.changes);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore secondary failure */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/** Resolve the audit retention policy from global/config.json.
 *  Mirrors Python `_resolve_audit_policy`. Callers that want an explicit
 *  policy (tests, calibration) should bypass this and build one via
 *  `policyFromConfig` directly. */
export function loadAuditPolicy(repoRoot: string): AuditRetentionPolicy {
  const cfgPath = path.join(repoRoot, "global", "config.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rt = parsed["red_team"];
    if (rt && typeof rt === "object" && !Array.isArray(rt)) {
      const audit = (rt as Record<string, unknown>)["audit"];
      if (audit && typeof audit === "object" && !Array.isArray(audit)) {
        return policyFromConfig(audit as Record<string, unknown>);
      }
    }
  } catch {
    /* fall through to default */
  }
  return policyFromConfig(null);
}
