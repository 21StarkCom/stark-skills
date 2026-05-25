/**
 * HTTP routes added in Phase 3. Currently only the retention-notify
 * route; Phase 4 will register the rest (`/api/runs`, auth, etc.).
 *
 * The retention listener is bound on a SEPARATE Fastify instance from
 * the main API listener (see `index.ts`'s `buildRetentionServer`) so
 * the listener-bind contract (host-loopback-only publish) is enforced
 * via Compose's `127.0.0.1:7701:7701` mapping, not via per-route
 * source-IP checks (which Docker's userland proxy makes unreliable).
 *
 * Phase 3 ships ONLY the route logic against a trusted loopback. Bearer
 * auth against `/data/prune_token` lands in Phase 4 Task 1 — the route
 * factory accepts an optional `requireBearer` predicate so the Phase 4
 * wiring can attach the prune-token check without rewriting this file.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";

import {
  abortRewriteBodySchema,
  preRenameBodySchema,
  retentionNotifyBodySchema,
  scanNowBodySchema,
  updateMtimeBodySchema,
  type AbortRewriteBody,
  type PreRenameBody,
  type RetentionNotifyBody,
  type ScanNowBody,
  type UpdateMtimeBody,
} from "./retention_notify_schemas.ts";

type DbHandle = Database.Database;
type DbStatement = Database.Statement<any[], any>;

export interface RetentionRouteDeps {
  db: DbHandle;
  /**
   * Phase 4 will install the Bearer-token check here. In Phase 3 the
   * dep is optional so unit tests can exercise the body without a
   * token-file dance.
   */
  requireBearer?: (req: FastifyRequest) => boolean;
  /**
   * Backend for `POST /api/internal/retention/scan-now`. Wired by
   * `index.ts` to `Tailer.scanNow(...)`. Optional so unit tests can
   * register the route without a real tailer; an unset value yields
   * a 503 from the handler.
   */
  triggerScan?: (target: {
    runId?: string;
    rotationIndex?: number;
  }) => Promise<void> | void;
}

interface PreRenameSql {
  setRewritePending: DbStatement;
  selectRewriteRow: DbStatement;
}

interface AbortRewriteSql {
  clearRewritePending: DbStatement;
}

interface UpdateMtimeSql {
  selectRewriteRow: DbStatement;
  deleteEventOffsetSeq: DbStatement;
  deleteChunkOffsetSeq: DbStatement;
  resetTailOffset: DbStatement;
  finishRewrite: DbStatement;
}

export function registerRetentionRoutes(
  app: FastifyInstance,
  deps: RetentionRouteDeps,
): void {
  const pre = preparePreRename(deps.db);
  const abort = prepareAbortRewrite(deps.db);
  const update = prepareUpdateMtime(deps.db);

  app.post("/api/internal/retention/notify", async (req, reply) => {
    if (deps.requireBearer && !deps.requireBearer(req)) {
      return reply.code(401).send({ ok: false, code: "unauthorized" });
    }

    const parsed = retentionNotifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, code: "bad_body", error: parsed.error.message });
    }
    const body: RetentionNotifyBody = parsed.data;

    switch (body.action) {
      case "pre-rename":
        return handlePreRename(deps.db, pre, body, reply);
      case "abort-rewrite":
        return handleAbortRewrite(deps.db, abort, body, reply);
      case "update-mtime":
        return handleUpdateMtime(deps.db, update, body, reply);
    }
  });

  // E7: explicit scan-now path. The prune CLI calls this when
  // pre-rename returns 409 `scan_pending` and the operator needs the
  // tailer to ingest a new file BEFORE the next chokidar / 10 s backup
  // sweep tick. Returns 200 once the scan completes; 400 on bad body;
  // 503 if no scan backend was wired (Phase 3 unit-test mode).
  //
  // §1.5.1 E7 / plan §Phase 3 Task 4 specify the normative path as
  // `/internal/retention/scan-now`. The `/api/internal/...` mirror is
  // kept for backwards compatibility with the existing notify routes
  // that all share the `/api/internal/` prefix; both paths reach the
  // same handler.
  for (const scanNowPath of [
    "/api/internal/retention/scan-now",
    "/internal/retention/scan-now",
  ]) {
    app.post(scanNowPath, async (req, reply) => {
      if (deps.requireBearer && !deps.requireBearer(req)) {
        return reply.code(401).send({ ok: false, code: "unauthorized" });
      }
      const parsed = scanNowBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, code: "bad_body", error: parsed.error.message });
      }
      if (!deps.triggerScan) {
        return reply.code(503).send({ ok: false, code: "scan_unavailable" });
      }
      const body: ScanNowBody = parsed.data;
      try {
        await deps.triggerScan({
          runId: body.run_id,
          rotationIndex: body.rotation_index,
        });
      } catch (err) {
        return reply.code(500).send({
          ok: false,
          code: "scan_failed",
          error: (err as Error).message,
        });
      }
      return reply.code(200).send({ ok: true, action: "scan-now" });
    });
  }
}

// --- pre-rename ----------------------------------------------------

function preparePreRename(db: DbHandle): PreRenameSql {
  return {
    selectRewriteRow: db.prepare(
      `SELECT rewrite_pending, rewrite_txn_id, rewrite_state
         FROM spool_files
        WHERE run_id = ? AND rotation_index = ?`,
    ),
    setRewritePending: db.prepare(
      // RT2: the destructive transition log lives in SQLite. Pre-rename
      // sets rewrite_state='pending' + rewrite_txn_id + target_size_bytes
      // so a startup-recovery sweep can correlate on-disk state with
      // the intended outcome.
      `UPDATE spool_files
          SET rewrite_pending = 1,
              rewrite_pending_size_bytes = ?,
              rewrite_pending_truncated_json = ?,
              rewrite_txn_id = ?,
              rewrite_state = 'pending',
              target_size_bytes = ?,
              target_mtime_ns = NULL
        WHERE run_id = ? AND rotation_index = ?`,
    ),
  };
}

function handlePreRename(
  db: DbHandle,
  stmts: PreRenameSql,
  body: PreRenameBody,
  reply: import("fastify").FastifyReply,
): unknown {
  // E7: pre-rename requires an existing spool_files row (the tailer
  // must have seen the file at least once). Returning 409 lets the
  // prune CLI back off + retry after the next chokidar / sweeper tick.
  // RT2: if a pending row already exists with a DIFFERENT txn id, the
  // current attempt is rejected — the prior attempt must finish (commit
  // or abort) first; the CLI must drive recovery via abort-rewrite.
  const txn = db.transaction((b: PreRenameBody) => {
    const row = stmts.selectRewriteRow.get(b.run_id, b.rotation_index) as
      | {
          rewrite_pending: number;
          rewrite_txn_id: string | null;
          rewrite_state: string | null;
        }
      | undefined;
    if (!row) return { code: "scan_pending" as const };
    if (
      row.rewrite_pending === 1 &&
      row.rewrite_txn_id !== null &&
      row.rewrite_txn_id !== b.rewrite_txn_id
    ) {
      return { code: "txn_in_progress" as const };
    }
    stmts.setRewritePending.run(
      b.new_size_bytes,
      JSON.stringify(b.truncated),
      b.rewrite_txn_id,
      b.new_size_bytes,
      b.run_id,
      b.rotation_index,
    );
    return { code: "ok" as const };
  });
  const result = txn(body) as {
    code: "ok" | "scan_pending" | "txn_in_progress";
  };
  if (result.code === "scan_pending") {
    return reply.code(409).send({ ok: false, code: "scan_pending" });
  }
  if (result.code === "txn_in_progress") {
    return reply.code(409).send({ ok: false, code: "txn_in_progress" });
  }
  // Re-validate the body MATCHES preRenameBodySchema strictly. The
  // discriminated union already accepted it, but re-parsing keeps the
  // schema as a contract surface a future test can grep for.
  preRenameBodySchema.parse(body);
  return reply
    .code(200)
    .send({ ok: true, pending: true, action: "pre-rename" });
}

// --- abort-rewrite -------------------------------------------------

function prepareAbortRewrite(db: DbHandle): AbortRewriteSql {
  return {
    clearRewritePending: db.prepare(
      // RT2: abort-rewrite sets the canonical terminal state so the
      // startup-recovery sweep won't re-pick this row, and clears the
      // pending fields so a fresh pre-rename attempt can start.
      `UPDATE spool_files
          SET rewrite_pending = 0,
              rewrite_pending_size_bytes = NULL,
              rewrite_pending_truncated_json = NULL,
              rewrite_state = 'aborted',
              target_size_bytes = NULL,
              target_mtime_ns = NULL,
              rewrite_txn_id = NULL
        WHERE run_id = ? AND rotation_index = ?`,
    ),
  };
}

function handleAbortRewrite(
  db: DbHandle,
  stmts: AbortRewriteSql,
  body: AbortRewriteBody,
  reply: import("fastify").FastifyReply,
): unknown {
  const txn = db.transaction((b: AbortRewriteBody) => {
    stmts.clearRewritePending.run(b.run_id, b.rotation_index);
  });
  txn(body);
  abortRewriteBodySchema.parse(body);
  return reply.code(200).send({ ok: true, action: "abort-rewrite" });
}

// --- update-mtime --------------------------------------------------

function prepareUpdateMtime(db: DbHandle): UpdateMtimeSql {
  return {
    selectRewriteRow: db.prepare(
      `SELECT rewrite_pending,
              rewrite_pending_size_bytes,
              rewrite_pending_truncated_json,
              rewrite_txn_id,
              rewrite_state
         FROM spool_files
        WHERE run_id = ? AND rotation_index = ?`,
    ),
    deleteEventOffsetSeq: db.prepare(
      `DELETE FROM event_offsets WHERE run_id = ? AND seq = ?`,
    ),
    deleteChunkOffsetSeq: db.prepare(
      `DELETE FROM chunk_offsets WHERE run_id = ? AND seq = ?`,
    ),
    resetTailOffset: db.prepare(
      `INSERT INTO tail_offsets (file_path, offset, mtime_ns)
       VALUES (?, 0, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         offset = 0,
         mtime_ns = excluded.mtime_ns`,
    ),
    finishRewrite: db.prepare(
      // RT2: update-mtime is the committed transition. Persist
      // target_mtime_ns so the startup-recovery sweep can finish-forward
      // an interrupted attempt and clears the per-txn columns.
      `UPDATE spool_files
          SET size_bytes = COALESCE(rewrite_pending_size_bytes, size_bytes),
              mtime_ns   = ?,
              rewrite_pending = 0,
              rewrite_pending_size_bytes = NULL,
              rewrite_pending_truncated_json = NULL,
              deleted_at = NULL,
              rewrite_state = 'committed',
              target_mtime_ns = ?,
              rewrite_txn_id = NULL
        WHERE run_id = ? AND rotation_index = ?`,
    ),
  };
}

function handleUpdateMtime(
  db: DbHandle,
  stmts: UpdateMtimeSql,
  body: UpdateMtimeBody,
  reply: import("fastify").FastifyReply,
): unknown {
  const txn = db.transaction(
    (b: UpdateMtimeBody) => {
      const row = stmts.selectRewriteRow.get(b.run_id, b.rotation_index) as
        | {
            rewrite_pending: number;
            rewrite_pending_size_bytes: number | null;
            rewrite_pending_truncated_json: string | null;
            rewrite_txn_id: string | null;
            rewrite_state: string | null;
          }
        | undefined;
      if (!row) return { code: "scan_pending" as const, cleared: 0 };
      if (
        row.rewrite_pending === 1 &&
        row.rewrite_txn_id !== null &&
        row.rewrite_txn_id !== b.rewrite_txn_id
      ) {
        return { code: "txn_mismatch" as const, cleared: 0 };
      }
      if (row.rewrite_pending !== 1) {
        // Idempotent retry path — pre-rename already cleared. Nothing
        // to delete; just patch the mtime if we have it.
        stmts.finishRewrite.run(
          b.new_mtime_ns,
          b.new_mtime_ns,
          b.run_id,
          b.rotation_index,
        );
        stmts.resetTailOffset.run(b.file_path, b.new_mtime_ns);
        return { code: "ok" as const, cleared: 0 };
      }
      // Parse the column-stored truncated set (the second-call body
      // intentionally carries NO truncated array — RT2 contract).
      const seqs = parseStoredTruncatedSeqs(row.rewrite_pending_truncated_json);
      for (const seq of seqs) {
        stmts.deleteChunkOffsetSeq.run(b.run_id, seq);
        stmts.deleteEventOffsetSeq.run(b.run_id, seq);
      }
      stmts.resetTailOffset.run(b.file_path, b.new_mtime_ns);
      stmts.finishRewrite.run(
        b.new_mtime_ns,
        b.new_mtime_ns,
        b.run_id,
        b.rotation_index,
      );
      return { code: "ok" as const, cleared: seqs.length };
    },
  );
  const result = txn(body) as
    | { code: "ok"; cleared: number }
    | { code: "scan_pending"; cleared: 0 }
    | { code: "txn_mismatch"; cleared: 0 };
  if (result.code === "scan_pending") {
    return reply.code(409).send({ ok: false, code: "scan_pending" });
  }
  if (result.code === "txn_mismatch") {
    return reply.code(409).send({ ok: false, code: "txn_mismatch" });
  }
  updateMtimeBodySchema.parse(body);
  return reply.code(200).send({
    ok: true,
    cleared: result.cleared,
    action: "update-mtime",
  });
}

function parseStoredTruncatedSeqs(stored: string | null): number[] {
  if (typeof stored !== "string" || stored.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const seq = (entry as Record<string, unknown>).seq;
      if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) {
        out.push(seq);
      }
    }
  }
  return out;
}
