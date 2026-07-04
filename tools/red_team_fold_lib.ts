// tools/red_team_fold_lib.ts
//
// Fold orchestrator types + hash-guarded fix-plan run selection (rt4).
//
// `resolveFixPlanForFold` is the stale-guard at the heart of the fold
// pipeline: it decides which prior fix-plan run (if any) is safe to fold
// into the artifact currently on disk. A fix plan is only ever adopted
// when the caller can prove it was generated against the artifact text as
// it exists *right now* (sidecar hash match), or when the operator has
// explicitly named the run they want folded (source-run-id'd DB
// fallback). It never silently picks "whatever's latest" — that would risk
// folding a stale or foreign plan into an artifact that has since moved on.
import { createHash } from "node:crypto";
import type { RedTeamFixPlan } from "./red_team_lib.ts";

/** Outcome the fold host applies to a single fix-plan move. */
export type Disposition = "accept" | "modify" | "reject" | "apply_failed";

/** A concrete text edit proposed for one move (old → new). */
export interface FoldPatch {
  move_id: string;
  old: string;
  new: string;
}

/** Per-move fold decision + audit trail, one per `FixPlanMove`. */
export interface MoveDisposition {
  move_id: string;
  addressed_finding_ids: string[];
  disposition: Disposition;
  rationale: string;
  patch: FoldPatch | null;
  move_snapshot_json: string;
}

/** A resolved fix plan plus provenance: which run produced it, and the
 *  artifact hash it was resolved against (the *current* artifact's hash,
 *  not necessarily the hash recorded at generation time). */
export interface FixPlanSource {
  fixPlan: RedTeamFixPlan;
  sourceRunId: string;
  artifactHash: string;
}

/** SHA-256 hex digest of a string, UTF-8 encoded. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface ResolveOpts {
  artifactText: string;
  sidecar: { fixPlanJson: string | null; runId: string | null; artifactHash: string | null } | null;
  explicitFixPlanJson: string | null;
  dbLatest: { fixPlanJson: string; runId: string; artifactHash: string } | null;
  sourceRunId: string | null;
  forceStale: boolean;
}

/**
 * Resolve which fix plan (if any) the fold host should apply, in strict
 * precedence order:
 *
 *   1. Explicit override (`explicitFixPlanJson`, e.g. `--fix-plan-json`)
 *      always wins — the caller handed us the plan directly, so there is
 *      no staleness question to ask.
 *   2. The adjacent sidecar — only when its recorded `artifactHash`
 *      matches the current artifact's hash (or `forceStale` is set). A
 *      mismatch means the artifact was edited since the plan was
 *      generated, so it is rejected as `stale_fix_plan` rather than
 *      silently folded.
 *   3. The DB's latest run for this artifact — but *only* when the caller
 *      passes an explicit `sourceRunId` naming the run they intend to
 *      fold. There is no "just use latest" path: `dbLatest` present with
 *      no `sourceRunId` is `source_run_id_required`, never a silent
 *      auto-pick.
 *   4. Otherwise `no_fix_plan_found`.
 */
export function resolveFixPlanForFold(opts: ResolveOpts): {
  source: FixPlanSource | null;
  status: "ok" | "no_fix_plan_found" | "stale_fix_plan" | "source_run_id_required";
} {
  const curHash = sha256Hex(opts.artifactText);

  // 1) explicit override
  if (opts.explicitFixPlanJson) {
    return {
      status: "ok",
      source: {
        fixPlan: JSON.parse(opts.explicitFixPlanJson),
        sourceRunId: opts.sourceRunId ?? "explicit",
        artifactHash: curHash,
      },
    };
  }

  // 2) adjacent sidecar — only on hash match (rt4)
  if (opts.sidecar?.fixPlanJson && opts.sidecar.runId) {
    if (opts.sidecar.artifactHash === curHash || opts.forceStale) {
      return {
        status: "ok",
        source: {
          fixPlan: JSON.parse(opts.sidecar.fixPlanJson),
          sourceRunId: opts.sidecar.runId,
          artifactHash: curHash,
        },
      };
    }
    return { status: "stale_fix_plan", source: null };
  }

  // 3) DB fallback — only with explicit --source-run-id (never "latest")
  if (opts.dbLatest) {
    if (!opts.sourceRunId) return { status: "source_run_id_required", source: null };
    if (opts.dbLatest.artifactHash !== curHash && !opts.forceStale) {
      return { status: "stale_fix_plan", source: null };
    }
    return {
      status: "ok",
      source: {
        fixPlan: JSON.parse(opts.dbLatest.fixPlanJson),
        sourceRunId: opts.dbLatest.runId,
        artifactHash: curHash,
      },
    };
  }

  return { status: "no_fix_plan_found", source: null };
}
