/**
 * Human-review halt recovery (FU-rt8) — TS port of
 * `scripts/red_team_human_review.py`.
 *
 * The red-team gate halts when a finding's `counter_proposal` is
 * `REQUEST_HUMAN_REVIEW`. This module persists operator acknowledgements
 * by the FU-rt8 `accept_key` (`{repo}:{stage}:{persona}:{concern_hash}`)
 * so a fresh dispatcher run computing the same accept_key for the same
 * concern (different run_id / round / finding_id slot) sees the prior
 * acceptance and stops halting.
 *
 * Phase 5a scope: this lib exists alongside Python
 * `red_team_human_review.py`; neither is canonical writer yet. The
 * thin CLI wrappers (`tools/red_team_status.ts`, `tools/red_team_accept.ts`)
 * are also TS ports of `red_team_status.py` / `red_team_accept.py`.
 */

import { DatabaseSync } from "node:sqlite";

import { connect, initDb, initRedTeamTables } from "./red_team_audit_lib.ts";

const CREATE_TABLE_SQL = `\
CREATE TABLE IF NOT EXISTS red_team_human_review_accepts (
    accept_key TEXT PRIMARY KEY,
    stable_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    concern_hash TEXT NOT NULL,
    concern_excerpt TEXT,
    accepted_by TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    note TEXT,
    version INTEGER NOT NULL DEFAULT 2
);

CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_run
    ON red_team_human_review_accepts(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_stable
    ON red_team_human_review_accepts(stable_key);
`;

const ACCEPTS_V2_COLUMNS: ReadonlyArray<[string, string]> = [
  ["accept_key", "TEXT"],
];

/** Build the canonical accept_key for one concern. Refuses unresolved /
 *  "unknown" repos so an accept can never collide with a different
 *  repo's halt namespace (PR-#430 review fix #10). Mirrors Python
 *  `red_team_types.compute_accept_key`. */
export function computeAcceptKey(args: {
  stage: string;
  persona: string;
  concernHash: string;
  repo: string | null | undefined;
}): string {
  if (!args.repo || args.repo === "unknown") {
    throw new Error(
      `compute_accept_key requires a resolved repository identifier; got ${JSON.stringify(
        args.repo,
      )}. Accept keys are repo-scoped to prevent cross-repo collisions; fix repo detection (e.g., run inside the target git checkout, or pass --repo) before accepting human-review halts.`,
    );
  }
  return `${args.repo}:${args.stage}:${args.persona}:${args.concernHash}`;
}

export function initTable(dbPath: string): void {
  initDb(dbPath, CREATE_TABLE_SQL);
  migrateAcceptsV2(dbPath);
}

function migrateAcceptsV2(dbPath: string): void {
  const db = connect(dbPath);
  try {
    const existing = new Set(
      (
        db.prepare("PRAGMA table_info(red_team_human_review_accepts)").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    for (const [name, decl] of ACCEPTS_V2_COLUMNS) {
      if (!existing.has(name)) {
        db.exec(
          `ALTER TABLE red_team_human_review_accepts ADD COLUMN ${name} ${decl}`,
        );
        existing.add(name);
      }
    }
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_stable " +
          "ON red_team_human_review_accepts(stable_key)",
      );
    } catch {
      /* index may already exist on legacy DB */
    }
  } finally {
    db.close();
  }
}

/** Mirrors Python `_resolve_accepted_by` — defaults to $USER, then
 *  "manual" if even that is unset. Never returns an empty string. */
export function resolveAcceptedBy(
  value: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (value) return value;
  return env.USER || "manual";
}

export interface PendingHalt {
  stable_key: string;
  run_id: string;
  stage: string;
  round_num: number;
  persona: string;
  finding_id: string;
  concern_hash: string;
  concern_excerpt: string | null;
  repo: string | null;
  pr_number: number | null;
  artifact_relative_path: string | null;
  created_at: string | null;
}

export interface FindingMetadata {
  stable_key: string;
  run_id: string;
  stage: string;
  round_num: number;
  persona: string;
  finding_id: string;
  concern_hash: string;
  concern_excerpt: string | null;
  repo: string | null;
  severity: string;
  counter_proposal: string;
}

/** Best-effort init of the upstream `red_team_findings` + `red_team_runs`
 *  tables used by `listPendingHalts` and `lookupFindingMetadata`.
 *  Importing from audit_lib at module top is fine in TS (no cycle). */
export function initRedTeamFindingsDependency(dbPath: string): void {
  initRedTeamTables(dbPath);
}

/** Record an operator acceptance for one human-review finding.
 *  Idempotent via `INSERT OR IGNORE`: re-accepting the same concern from
 *  a different run is a no-op (keeps the original timestamp). */
export function acceptFinding(args: {
  stableKey: string;
  runId: string;
  stage: string;
  roundNum: number;
  persona: string;
  findingId: string;
  concernHash: string;
  concernExcerpt: string | null;
  repo: string | null;
  acceptedBy?: string | null;
  note?: string | null;
  dbPath: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const acceptKey = computeAcceptKey({
    stage: args.stage,
    persona: args.persona,
    concernHash: args.concernHash,
    repo: args.repo,
  });
  initTable(args.dbPath);
  const db = connect(args.dbPath);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO red_team_human_review_accepts (" +
        "accept_key, stable_key, run_id, stage, round_num, persona, finding_id, " +
        "concern_hash, concern_excerpt, accepted_by, note" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      acceptKey,
      args.stableKey,
      args.runId,
      args.stage,
      args.roundNum,
      args.persona,
      args.findingId,
      args.concernHash,
      args.concernExcerpt,
      resolveAcceptedBy(args.acceptedBy, args.env),
      args.note ?? null,
    );
  } finally {
    db.close();
  }
}

/** Return true if the operator has accepted this concern. Pass either
 *  `acceptKey` (cross-run canonical) or `stableKey` (per-occurrence) —
 *  exactly one. */
export function isAccepted(
  args: { acceptKey?: string; stableKey?: string; dbPath: string },
): boolean {
  const hasAccept = args.acceptKey !== undefined;
  const hasStable = args.stableKey !== undefined;
  if (hasAccept === hasStable) {
    throw new Error("provide exactly one of acceptKey or stableKey");
  }
  initTable(args.dbPath);
  const db = connect(args.dbPath);
  try {
    let row: unknown;
    if (hasAccept) {
      row = db
        .prepare(
          "SELECT 1 FROM red_team_human_review_accepts WHERE accept_key = ?",
        )
        .get(args.acceptKey!);
    } else {
      row = db
        .prepare(
          "SELECT 1 FROM red_team_human_review_accepts WHERE stable_key = ?",
        )
        .get(args.stableKey!);
    }
    return row !== undefined && row !== null;
  } finally {
    db.close();
  }
}

/** Split findings into unaccepted vs already-accepted-keys, by cross-run
 *  accept_key lookup. `findings` only needs to expose
 *  `{persona, concern_hash, counter_proposal}` so the same TS shape used
 *  by the dispatcher's `RedTeamFinding` works directly. */
export interface MinimalFinding {
  persona: string;
  concern_hash: string;
  counter_proposal: string;
}

export function filterHumanReviewFindings<F extends MinimalFinding>(args: {
  findings: readonly F[];
  stage: string;
  repo: string | null | undefined;
  dbPath: string;
}): { unaccepted: F[]; matchedKeys: string[] } {
  initTable(args.dbPath);
  const db = connect(args.dbPath);
  let acceptedSet: Set<string>;
  try {
    const rows = db
      .prepare(
        "SELECT accept_key FROM red_team_human_review_accepts " +
          "WHERE stage = ? AND accept_key IS NOT NULL",
      )
      .all(args.stage) as Array<{ accept_key: string }>;
    acceptedSet = new Set(rows.map((r) => r.accept_key));
  } finally {
    db.close();
  }
  const unaccepted: F[] = [];
  const matchedKeys: string[] = [];
  for (const f of args.findings) {
    if (f.counter_proposal !== "REQUEST_HUMAN_REVIEW") continue;
    const acceptKey = computeAcceptKey({
      stage: args.stage,
      persona: f.persona,
      concernHash: f.concern_hash,
      repo: args.repo,
    });
    if (acceptedSet.has(acceptKey)) {
      matchedKeys.push(acceptKey);
    } else {
      unaccepted.push(f);
    }
  }
  return { unaccepted, matchedKeys };
}

/** Return every unaccepted human-review finding in the audit DB.
 *  Drives the `red-team status` display. */
export function listPendingHalts(args: {
  repo?: string | null;
  stage?: string | null;
  dbPath: string;
}): PendingHalt[] {
  initTable(args.dbPath);
  initRedTeamFindingsDependency(args.dbPath);
  const whereClauses: string[] = ["f.counter_proposal = 'REQUEST_HUMAN_REVIEW'"];
  const params: unknown[] = [];
  if (args.repo !== undefined && args.repo !== null) {
    whereClauses.push("r.repo = ?");
    params.push(args.repo);
  }
  if (args.stage !== undefined && args.stage !== null) {
    whereClauses.push("f.stage = ?");
    params.push(args.stage);
  }
  // Mirrors Python's accept_key reconstruction. Legacy rows with null
  // repo fall back to the literal "unknown" prefix to match
  // computeAcceptKey(repo=null)'s pre-refusal shape (but note: new
  // code refuses to construct that key — this SQL is for retroactive
  // matching against old persisted rows only).
  const acceptKeyExpr =
    "(COALESCE(r.repo, 'unknown') || ':' || f.stage || ':' || f.persona " +
    "|| ':' || COALESCE(f.concern_hash, ''))";
  const sql =
    "SELECT f.stable_key, f.run_id, f.stage, f.round_num, f.persona, " +
    "f.finding_id, f.concern_hash, " +
    "COALESCE(f.concern, ''), r.repo, r.pr_number, r.artifact_relative_path, " +
    "r.created_at " +
    "FROM red_team_findings f " +
    "LEFT JOIN red_team_runs r ON r.run_id = f.run_id " +
    "WHERE " +
    whereClauses.join(" AND ") +
    " AND f.stable_key IS NOT NULL " +
    "AND f.concern_hash IS NOT NULL " +
    `AND ${acceptKeyExpr} NOT IN (` +
    "SELECT accept_key FROM red_team_human_review_accepts WHERE accept_key IS NOT NULL" +
    ") " +
    "ORDER BY r.created_at DESC";
  const db = connect(args.dbPath);
  try {
    const rows = db.prepare(sql).all(...(params as never[])) as Array<{
      stable_key: string;
      run_id: string;
      stage: string;
      round_num: number;
      persona: string;
      finding_id: string;
      concern_hash: string;
      [k: string]: unknown;
    }>;
    return rows.map((r): PendingHalt => {
      const cols = Object.values(r);
      // node:sqlite returns objects keyed by column alias; some columns
      // here have computed/unaliased names. Use positional access for
      // the no-alias cases to mirror the Python tuple indexing.
      const concernExcerpt = (cols[7] ?? null) as string | null;
      return {
        stable_key: r.stable_key,
        run_id: r.run_id,
        stage: r.stage,
        round_num: r.round_num,
        persona: r.persona,
        finding_id: r.finding_id,
        concern_hash: r.concern_hash,
        concern_excerpt: concernExcerpt || null,
        repo: (r.repo ?? null) as string | null,
        pr_number: (r.pr_number ?? null) as number | null,
        artifact_relative_path: (r.artifact_relative_path ?? null) as string | null,
        created_at: (r.created_at ?? null) as string | null,
      };
    });
  } finally {
    db.close();
  }
}

/** Look up a stable key's full row so the CLI can show what's being
 *  accepted. Returns null when no row matches. */
export function lookupFindingMetadata(args: {
  stableKey: string;
  dbPath: string;
}): FindingMetadata | null {
  initRedTeamFindingsDependency(args.dbPath);
  const db = connect(args.dbPath);
  try {
    const row = db
      .prepare(
        "SELECT f.stable_key, f.run_id, f.stage, f.round_num, f.persona, " +
          "f.finding_id, f.concern_hash, f.concern, f.severity, " +
          "f.counter_proposal, r.repo " +
          "FROM red_team_findings f " +
          "LEFT JOIN red_team_runs r ON r.run_id = f.run_id " +
          "WHERE f.stable_key = ? " +
          "ORDER BY f.id DESC LIMIT 1",
      )
      .get(args.stableKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      stable_key: row.stable_key as string,
      run_id: row.run_id as string,
      stage: row.stage as string,
      round_num: row.round_num as number,
      persona: row.persona as string,
      finding_id: row.finding_id as string,
      concern_hash: row.concern_hash as string,
      concern_excerpt: (row.concern ?? null) as string | null,
      repo: (row.repo ?? null) as string | null,
      severity: row.severity as string,
      counter_proposal: row.counter_proposal as string,
    };
  } finally {
    db.close();
  }
}

// Reference imports kept for callers that prefer pulling DB helpers
// through one module. Re-exporting lets a CLI bundle import just from
// here.
export { connect as connectAuditDb } from "./red_team_audit_lib.ts";

// Silence the unused-warning on DatabaseSync (kept in scope so the
// callers can construct connections without importing node:sqlite
// directly if they don't want to).
void DatabaseSync;
