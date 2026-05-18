/**
 * Red-team SQLite → insights-queue backfill engine.
 *
 * TS port of `scripts/red_team_backfill.py`. Pulls historical
 * `red_team_runs` + `red_team_findings` rows out of the audit DB,
 * builds the corresponding `red_team_run` / `red_team_finding` /
 * `red_team_fix_plan` envelopes, and enqueues them via the same
 * `red_team_emit_queue_cli.py` seam the live dispatcher uses (until
 * Phase 5b cuts that shell-out, at which point the enqueue function
 * gets swapped for the in-process TS lib).
 *
 * Scope flag mirrors Python:
 *   - `legacy`:  fix_plan_status IS NULL (pre-v1.2 rows)
 *   - `forward`: fix_plan_status IS NOT NULL (post-v1.2 rows)
 *   - `all`:     everything
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import {
  enqueueInsightsEvent,
  makeDedupeKey,
  type InsightsEnqueueResult,
} from "./red_team_lib.ts";

export type BackfillScope = "legacy" | "forward" | "all";

export interface BackfillStats {
  rows: number;
  skipped_rows: number;
  red_team_run: number;
  red_team_finding: number;
  red_team_fix_plan: number;
  enqueued: number;
  duplicates: number;
  dedupe_keys: string[];
}

interface RunRow {
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
  created_at: string;
  repo: string | null;
  artifact_relative_path: string | null;
  pr_number: number | null;
  fix_plan_status: string | null;
  fix_plan_md: string | null;
  fix_plan_json: string | null;
  fix_plan_cost_usd: number | null;
}

interface FindingRow {
  round_num: number;
  finding_id: string;
  persona: string;
  severity: string;
  concern: string;
  consequence: string;
  counter_proposal: string;
  trade_off: string | null;
  reason_for_uncertainty: string | null;
}

interface LoadedRow extends RunRow {
  findings: FindingRow[];
}

const SEVERITY_RANK_NUM: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};
const REQUEST_HUMAN_REVIEW = "REQUEST_HUMAN_REVIEW";
const RUN_LEVEL_FIX_PLAN_WARNINGS: ReadonlySet<string> = new Set(["over_budget_after_fix"]);

function loadRows(dbPath: string, scope: BackfillScope, limit: number | null): LoadedRow[] {
  const where =
    scope === "legacy"
      ? "WHERE fix_plan_status IS NULL"
      : scope === "forward"
        ? "WHERE fix_plan_status IS NOT NULL"
        : "";
  const limitSql = limit === null ? "" : " LIMIT ?";
  const params = limit === null ? [] : [limit];
  const db = new DatabaseSync(dbPath);
  try {
    const runRows = db
      .prepare(
        "SELECT run_id, stage, rounds_used, final_status, total_findings, " +
          "critical_count, high_count, medium_count, human_review_count, " +
          "duration_s, cost_usd, model, caller, created_at, repo, " +
          "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, " +
          "fix_plan_json, fix_plan_cost_usd " +
          `FROM red_team_runs ${where} ORDER BY created_at, id${limitSql}`,
      )
      .all(...(params as never[])) as unknown as RunRow[];
    const out: LoadedRow[] = [];
    for (const r of runRows) {
      const findings = db
        .prepare(
          "SELECT round_num, finding_id, persona, severity, concern, " +
            "consequence, counter_proposal, trade_off, reason_for_uncertainty " +
            "FROM red_team_findings WHERE run_id = ? AND stage = ? " +
            "ORDER BY round_num, id",
        )
        .all(r.run_id, r.stage) as unknown as FindingRow[];
      out.push({ ...r, findings });
    }
    return out;
  } finally {
    db.close();
  }
}

function worstSeverity(row: RunRow): string | null {
  if (row.critical_count > 0) return "critical";
  if (row.high_count > 0) return "high";
  if (row.medium_count > 0) return "medium";
  return null;
}

function blockingCount(findings: readonly FindingRow[]): number {
  return findings.filter(
    (f) =>
      f.counter_proposal !== REQUEST_HUMAN_REVIEW &&
      (SEVERITY_RANK_NUM[f.severity] ?? 0) >= SEVERITY_RANK_NUM.high,
  ).length;
}

function runWarningsFromFixPlanJson(fixPlanJson: string | null): string[] {
  if (!fixPlanJson) return [];
  let plan: unknown;
  try {
    plan = JSON.parse(fixPlanJson);
  } catch {
    return [];
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return [];
  const raw = (plan as Record<string, unknown>).warnings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((w): w is string => typeof w === "string" && RUN_LEVEL_FIX_PLAN_WARNINGS.has(w));
}

interface BackfillEnvelope {
  type: "red_team_run" | "red_team_finding" | "red_team_fix_plan";
  payload: Record<string, unknown>;
  dedupe_key: string;
}

/** Build the run envelope payload that matches Python's
 *  `red_team_insights.build_run_envelope`. Caller wraps in
 *  `{type, payload, dedupe_key}` for downstream enqueue. */
function buildRunPayloadFromRow(row: LoadedRow): Record<string, unknown> {
  const repoLabel = row.repo ?? "unknown";
  return {
    run_id: row.run_id,
    stage: row.stage,
    model: row.model,
    caller: row.caller,
    final_status: row.final_status,
    worst_severity: worstSeverity(row),
    passed: row.final_status === "clean",
    rounds_used: Math.trunc(row.rounds_used),
    total_findings: Math.trunc(row.total_findings),
    blocking_count: blockingCount(row.findings),
    human_review_count: Math.trunc(row.human_review_count),
    critical_count: Math.trunc(row.critical_count),
    high_count: Math.trunc(row.high_count),
    medium_count: Math.trunc(row.medium_count),
    duration_s: row.duration_s,
    cost_usd: row.cost_usd,
    repo: repoLabel,
    artifact_relative_path: row.artifact_relative_path,
    pr_number: row.pr_number,
    fix_plan_status: row.fix_plan_status ?? "absent_pre_v1_2",
    warnings: runWarningsFromFixPlanJson(row.fix_plan_json),
    round_outcomes: [],
    terminal_transition: null,
  };
}

function buildFindingPayloadFromRow(
  row: LoadedRow,
  finding: FindingRow,
): Record<string, unknown> {
  const repoLabel = row.repo ?? "unknown";
  return {
    run_id: row.run_id,
    stage: row.stage,
    round_num: Math.trunc(finding.round_num),
    finding_id: finding.finding_id,
    persona: finding.persona,
    severity: finding.severity,
    concern: finding.concern,
    consequence: finding.consequence,
    counter_proposal: finding.counter_proposal,
    trade_off: finding.trade_off,
    reason_for_uncertainty: finding.reason_for_uncertainty,
    is_human_review: finding.counter_proposal === REQUEST_HUMAN_REVIEW,
    repo: repoLabel,
    pr_number: row.pr_number,
  };
}

function listOfDicts(value: unknown, field: string): Array<Record<string, unknown>> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
    throw new Error(`malformed fix_plan_json: ${field} must be a list of objects`);
  }
  return value as Array<Record<string, unknown>>;
}

function listOfStrs(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new Error(`malformed fix_plan_json: ${field} must be a list of strings`);
  }
  return value as string[];
}

function addressedIds(moves: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of moves) {
    const ids = m.addressed_finding_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

function buildFixPlanPayloadFromRow(row: LoadedRow): Record<string, unknown> {
  if (row.fix_plan_json === null) {
    throw new Error("success row has no fix_plan_json");
  }
  let plan: unknown;
  try {
    plan = JSON.parse(row.fix_plan_json);
  } catch (err) {
    throw new Error(`malformed fix_plan_json: ${(err as Error).message}`);
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("malformed fix_plan_json: top-level value is not an object");
  }
  const planObj = plan as Record<string, unknown>;
  if (planObj.error !== undefined && planObj.error !== null) {
    throw new Error("success row has errored fix_plan_json");
  }
  const moves = listOfDicts(planObj.moves, "moves");
  const repoLabel = row.repo ?? "unknown";
  return {
    run_id: row.run_id,
    stage: row.stage,
    model: String(planObj.model ?? ""),
    reasoning_effort: String(planObj.reasoning_effort ?? ""),
    summary: String(planObj.summary ?? ""),
    notes: String(planObj.notes ?? ""),
    moves: moves.map((m) => ({ ...m })),
    move_count: moves.length,
    addressed_finding_ids: addressedIds(moves),
    unaddressed_finding_ids: listOfStrs(
      planObj.unaddressed_finding_ids,
      "unaddressed_finding_ids",
    ),
    orphan_finding_ids: listOfStrs(planObj.orphan_finding_ids, "orphan_finding_ids"),
    input_truncated: Boolean(planObj.input_truncated ?? false),
    input_omitted_finding_ids: listOfStrs(
      planObj.input_omitted_finding_ids,
      "input_omitted_finding_ids",
    ),
    warnings: listOfStrs(planObj.warnings, "warnings"),
    cost_usd: Number(planObj.cost_usd ?? 0),
    duration_s: Number(planObj.duration_s ?? 0),
    input_tokens: Math.trunc(Number(planObj.input_tokens ?? 0)),
    output_tokens: Math.trunc(Number(planObj.output_tokens ?? 0)),
    fix_plan_md: row.fix_plan_md ?? "",
    repo: repoLabel,
    pr_number: row.pr_number,
  };
}

export function buildEnvelopesForRow(row: LoadedRow): BackfillEnvelope[] {
  const stage = row.stage as "design" | "plan";
  const envelopes: BackfillEnvelope[] = [];
  envelopes.push({
    type: "red_team_run",
    payload: buildRunPayloadFromRow(row),
    dedupe_key: makeDedupeKey("run", { stage, runId: row.run_id }),
  });
  for (const f of row.findings) {
    envelopes.push({
      type: "red_team_finding",
      payload: buildFindingPayloadFromRow(row, f),
      dedupe_key: makeDedupeKey("finding", {
        stage,
        runId: row.run_id,
        roundNum: Math.trunc(f.round_num),
        findingId: f.finding_id,
      }),
    });
  }
  const fixPlanStatus = row.fix_plan_status ?? "absent_pre_v1_2";
  if (fixPlanStatus === "success" && row.fix_plan_json !== null) {
    envelopes.push({
      type: "red_team_fix_plan",
      payload: buildFixPlanPayloadFromRow(row),
      dedupe_key: makeDedupeKey("fix_plan", { stage, runId: row.run_id }),
    });
  }
  return envelopes;
}

export type EnqueueFn = (env: BackfillEnvelope) => InsightsEnqueueResult;

const defaultEnqueue: EnqueueFn = (env) =>
  enqueueInsightsEvent(env.type, env.payload, env.dedupe_key);

export interface RunBackfillArgs {
  dbPath: string;
  scope?: BackfillScope;
  limit?: number | null;
  dryRun?: boolean;
  manifestPath?: string | null;
  enqueueFn?: EnqueueFn;
  /** Caller hook for the "warning: skipping run_id=..." stderr line.
   *  Defaults to a real stderr write; tests pass a noop. */
  onSkip?: (runId: string, reason: string) => void;
  /** Call before loading — exists so callers can defer audit-table init
   *  (we wire it here to mirror Python's `init_red_team_tables` call). */
  ensureSchema?: (dbPath: string) => void;
}

export function runBackfill(args: RunBackfillArgs): BackfillStats {
  const scope: BackfillScope = args.scope ?? "legacy";
  if (scope !== "legacy" && scope !== "forward" && scope !== "all") {
    throw new Error(`unsupported scope: ${scope}`);
  }
  if (args.ensureSchema) args.ensureSchema(args.dbPath);
  const rows = loadRows(args.dbPath, scope, args.limit ?? null);
  const enqueue = args.enqueueFn ?? defaultEnqueue;
  const stats: BackfillStats = {
    rows: 0,
    skipped_rows: 0,
    red_team_run: 0,
    red_team_finding: 0,
    red_team_fix_plan: 0,
    enqueued: 0,
    duplicates: 0,
    dedupe_keys: [],
  };
  const onSkip =
    args.onSkip ??
    ((runId, reason) =>
      process.stderr.write(`warning: skipping run_id=${JSON.stringify(runId)}: ${reason}\n`));
  for (const row of rows) {
    let envelopes: BackfillEnvelope[];
    try {
      envelopes = buildEnvelopesForRow(row);
    } catch (err) {
      stats.skipped_rows += 1;
      onSkip(row.run_id, (err as Error).message);
      continue;
    }
    stats.rows += 1;
    for (const env of envelopes) {
      stats[env.type] += 1;
      stats.dedupe_keys.push(env.dedupe_key);
      if (args.dryRun) continue;
      const result = enqueue(env);
      if (!result.ok) {
        // Python's _default_enqueue treats None as duplicate; failed
        // enqueues raise. We get {ok:false} on subprocess error.
        process.stderr.write(
          `warning: enqueue failed for ${env.dedupe_key}: ${result.error ?? "unknown"}\n`,
        );
        continue;
      }
      if (result.duplicate) stats.duplicates += 1;
      else stats.enqueued += 1;
    }
  }
  if (args.manifestPath !== null && args.manifestPath !== undefined) {
    writeManifest({
      manifestPath: args.manifestPath,
      scope,
      dbPath: args.dbPath,
      dryRun: args.dryRun ?? false,
      dedupeKeys: stats.dedupe_keys,
    });
  }
  return stats;
}

function writeManifest(args: {
  manifestPath: string;
  scope: BackfillScope;
  dbPath: string;
  dryRun: boolean;
  dedupeKeys: readonly string[];
}): void {
  fs.mkdirSync(path.dirname(args.manifestPath), { recursive: true });
  const payload = {
    db_path: args.dbPath,
    dedupe_keys: [...args.dedupeKeys],
    dry_run: args.dryRun,
    scope: args.scope,
  };
  // Match Python `json.dumps(..., indent=2, sort_keys=True) + "\n"`.
  fs.writeFileSync(
    args.manifestPath,
    JSON.stringify(sortKeysDeep(payload), null, 2) + "\n",
    "utf8",
  );
}

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as T;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
    return sorted as T;
  }
  return value;
}
