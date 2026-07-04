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
import { extractVerdictJson, isPlainObject, run } from "./copilot_dispatch.ts";
import { parseFixPlanOutput, scrubEnv } from "./red_team_lib.ts";
import type { FixPlanMove, RedTeamFinding, RedTeamFixPlan } from "./red_team_lib.ts";
import { applyPatches, type FixerPatch } from "./stark_review_doc_lib.ts";
import {
  buildCommand as buildClaudeCommand,
  normalizeOutput as normalizeClaudeOutput,
} from "./agent_claude.ts";

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

/** Coerce to a string, or `""` for anything that isn't one. */
function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the disposition decider's raw JSON output into validated
 * `MoveDisposition[]` plus an `invalid[]` list of rejected rows.
 *
 * Extraction: `extractVerdictJson` only matches a top-level object carrying
 * a `"verdict"` key (the copilot lead/wing review shape) — the decider's
 * `{summary, dispositions}` envelope never has one, so it is tried first
 * (in case a future prompt revision wraps dispositions in a verdict
 * envelope) and, when it comes back without a `dispositions` array, this
 * falls back to `parseFixPlanOutput` — the same best-effort JSON-object
 * extraction (direct parse → fenced ```block → first `{`..last `}` slice,
 * no required key) already used for the structurally-identical fix-plan
 * envelope — rather than re-implementing that scan here.
 *
 * Validation, per row: `move_id` must match one of `moves`; `disposition`
 * must be `accept` | `modify` | `reject`; `rationale` must be non-empty;
 * `accept`/`modify` additionally require `patch.old` non-empty. Anything
 * failing a rule is dropped into `invalid[]` with a reason string instead
 * of the output array.
 */
export function parseDispositions(
  rawOutput: string,
  moves: FixPlanMove[],
): { dispositions: MoveDisposition[]; invalid: Array<{ move_id: string; reason: string }> } {
  const dispositions: MoveDisposition[] = [];
  const invalid: Array<{ move_id: string; reason: string }> = [];
  const byId = new Map(moves.map((m) => [m.id, m]));

  const fromVerdict = extractVerdictJson(rawOutput);
  const obj: Record<string, unknown> =
    fromVerdict && Array.isArray(fromVerdict["dispositions"]) ? fromVerdict : parseFixPlanOutput(rawOutput);
  const rows: unknown[] = Array.isArray(obj["dispositions"]) ? (obj["dispositions"] as unknown[]) : [];

  for (const rawRow of rows) {
    const r: Record<string, unknown> = isPlainObject(rawRow) ? rawRow : {};

    const moveId = strOrEmpty(r["move_id"]);
    const move = byId.get(moveId);
    if (!move) {
      invalid.push({ move_id: moveId || "(missing)", reason: "unknown_move_id" });
      continue;
    }

    const dispRaw = r["disposition"];
    const disp: "accept" | "modify" | "reject" | null =
      dispRaw === "accept" || dispRaw === "modify" || dispRaw === "reject" ? dispRaw : null;
    if (!disp) {
      invalid.push({ move_id: moveId, reason: "bad_disposition" });
      continue;
    }

    const rationale = strOrEmpty(r["rationale"]).trim();
    if (!rationale) {
      invalid.push({ move_id: moveId, reason: "empty_rationale" });
      continue;
    }

    let patch: FoldPatch | null = null;
    if (disp === "accept" || disp === "modify") {
      const patchObj: Record<string, unknown> = isPlainObject(r["patch"]) ? r["patch"] : {};
      const old = strOrEmpty(patchObj["old"]);
      const nw = strOrEmpty(patchObj["new"]);
      if (!old) {
        invalid.push({ move_id: moveId, reason: "accept_without_patch" });
        continue;
      }
      patch = { move_id: moveId, old, new: nw };
    }

    const addressedRaw = r["addressed_finding_ids"];
    const addressed_finding_ids = Array.isArray(addressedRaw)
      ? addressedRaw.map((x) => String(x))
      : move.addressed_finding_ids;

    dispositions.push({
      move_id: moveId,
      addressed_finding_ids,
      disposition: disp,
      rationale,
      patch,
      move_snapshot_json: JSON.stringify(move),
    });
  }

  return { dispositions, invalid };
}

/**
 * Apply the `accept`/`modify` dispositions' patches to `doc` via the shared
 * `applyPatches` engine, then reconcile the outcome back onto the
 * disposition list.
 *
 * `reject` dispositions (and any `accept`/`modify` row with a null `patch`,
 * which `parseDispositions` never emits but a caller-constructed list could)
 * contribute no patch and pass through untouched. Every patch that
 * `applyPatches` could not land — `old` absent or non-unique in the current
 * document — flips that move's disposition to `apply_failed`; its
 * `rationale` (and every other field) is preserved so the audit trail still
 * shows *why* the decider wanted the change, just not that it landed.
 * Successfully applied patches keep their original `accept`/`modify`
 * disposition.
 *
 * Reconciliation keys off the `FixerPatch` object *identity* (the same
 * reference `applyPatches` echoes back in `failures[].patch`), not the
 * `move_id` string — `parseDispositions` never dedupes judgments, so two
 * dispositions can legitimately share a `move_id`, and string-keyed
 * reconciliation would flip both to `apply_failed` even when only one of
 * their patches actually failed.
 */
export function applyFold(
  doc: string,
  dispositions: MoveDisposition[],
): { newDoc: string; dispositions: MoveDisposition[] } {
  const toApply = dispositions.filter(
    (d) => d.patch && (d.disposition === "accept" || d.disposition === "modify"),
  );
  // 1:1 map each FixerPatch object back to its source disposition, so failures
  // reconcile by identity rather than by `move_id` string. `parseDispositions`
  // never dedupes judgments, so two dispositions can legitimately share a
  // `move_id` (a malformed/duplicate decider payload); reconciling by string
  // equality would flip BOTH to apply_failed even when only one patch failed,
  // mislabeling the move whose edit actually landed in `newDoc`.
  const patchToDisposition = new Map<FixerPatch, MoveDisposition>();
  const patches: FixerPatch[] = toApply.map((d) => {
    const p: FixerPatch = { finding_id: d.move_id, old: d.patch!.old, new: d.patch!.new };
    patchToDisposition.set(p, d);
    return p;
  });
  const res = applyPatches(doc, patches);
  const failedDispositions = new Set<MoveDisposition>(
    res.failures.map((f) => patchToDisposition.get(f.patch)!),
  );
  const out = dispositions.map((d) =>
    failedDispositions.has(d) ? { ...d, disposition: "apply_failed" as Disposition } : d,
  );
  return { newDoc: res.newDoc, dispositions: out };
}

// ── Task 7: token-less decider dispatch (rt1) + prompt assembly ──────────
//
// The fold decider is Claude, acting AS the artifact's author, triaging a
// fix plan whose text (and whatever the artifact/findings carry) is
// untrusted — it may contain prompt injection aimed at the model. Two
// independent defenses:
//
//   1. `assembleFoldPrompt` wraps every untrusted block in a hash-stamped
//      `<<<RED_TEAM_INPUT>>>` envelope with the system prompt (`foldMd`)
//      placed OUTSIDE the delimiters, so the model's actual instructions
//      never share a "region" with attacker-controlled text.
//   2. `dispatchDecider` runs the model subprocess with a token-less env
//      (`scrubEnv()` — no GITHUB_TOKEN/GH_TOKEN/OPENAI_*) so a successful
//      injection still has no credential to exfiltrate. This is the
//      load-bearing invariant (rt1): even if defense 1 fails, defense 2
//      holds.

/** Wrap one untrusted block in a hash-stamped `<<<RED_TEAM_INPUT>>>` envelope. */
function block(name: string, body: string): string {
  return `<<<RED_TEAM_INPUT name="${name}" hash="${sha256Hex(body)}">>>\n${body}\n<<<END_RED_TEAM_INPUT name="${name}">>>`;
}

/**
 * Assemble the full prompt sent to the fold decider.
 *
 * `foldMd` (the system/triage-contract prompt) is placed first, OUTSIDE any
 * delimiter — it is the only text the decider treats as instructions. The
 * artifact, source spec (when present), fix-plan moves, and findings are
 * each wrapped via `block()` so a prompt injection embedded in any of them
 * (e.g. text inside the artifact claiming to be a new system instruction)
 * is legible to the model only as content under review, matching the
 * injection-defense contract described in `fold.md` and, in spirit,
 * `preamble.md`.
 *
 * Only `fixPlan.moves` is serialized (not the full `RedTeamFixPlan`
 * envelope) — the decider triages moves, it has no use for the fix-plan's
 * own dispatch metadata (cost, duration, raw_output, ...).
 */
export function assembleFoldPrompt(a: {
  foldMd: string;
  artifact: string;
  sourceSpec: string | null;
  fixPlan: RedTeamFixPlan;
  findings: RedTeamFinding[];
}): string {
  const parts: string[] = [a.foldMd, "", block("artifact", a.artifact)];
  if (a.sourceSpec) parts.push(block("source_spec", a.sourceSpec));
  parts.push(block("fix_plan", JSON.stringify(a.fixPlan.moves, null, 2)));
  parts.push(block("findings", JSON.stringify(a.findings, null, 2)));
  return parts.join("\n");
}

/**
 * Extract `usage.input_tokens` / `usage.output_tokens` from Claude's
 * `--output-format json` envelope (`{"type":"result",...,"usage":{...}}`).
 * Text unwrapping is `normalizeClaudeOutput` (agent_claude.ts) — no existing
 * port needs token counts (the multi-review dispatcher discards them), so
 * this is a small local addition rather than a shared export. Malformed or
 * missing usage fields degrade to 0 rather than throwing — a parse miss
 * here must never fail the whole dispatch.
 */
function parseClaudeUsage(stdout: string): { input_tokens: number; output_tokens: number } {
  const trimmed = stdout.trim();
  if (!trimmed) return { input_tokens: 0, output_tokens: 0 };
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (isPlainObject(obj)) {
      const usage = obj["usage"];
      if (isPlainObject(usage)) {
        const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
        const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
        return { input_tokens: inputTokens, output_tokens: outputTokens };
      }
    }
  } catch {
    // Not JSON (or malformed) — no usage available; text is still returned
    // by the caller via normalizeClaudeOutput's own passthrough fallback.
  }
  return { input_tokens: 0, output_tokens: 0 };
}

/**
 * Dispatch the fold decider: a single headless Claude call over the
 * assembled prompt.
 *
 * Command/argv construction is delegated to `agent_claude.ts::buildCommand`
 * — the real, exported "headless Claude dispatch" builder shared with the
 * multi-review orchestrator (`stark_review.ts`'s claude `AgentPort`); it
 * already accepts an explicit `model` and emits the `-p - --output-format
 * json --model <m> --no-session-persistence` argv shape. Its OWN `env` is
 * deliberately NOT used here: `buildCommand` populates `ANTHROPIC_API_KEY`
 * (fine for its normal callers, which need Claude to authenticate itself),
 * but the fold decider must run with nothing beyond `scrubEnv()` — no
 * GitHub token, no OpenAI key, full stop (rt1). A prompt-injected artifact
 * that talks its way past the injection defense in `assembleFoldPrompt`
 * still finds no credential to exfiltrate in this subprocess's env.
 *
 * `timeoutMs` is converted to `run()`'s `timeoutSec` (rounding up, floor 1s,
 * so a sub-second budget never collapses to an immediate timeout).
 */
export async function dispatchDecider(a: {
  prompt: string;
  model: string;
  timeoutMs: number;
}): Promise<{ raw_output: string; input_tokens: number; output_tokens: number; error: string | null }> {
  const built = buildClaudeCommand(a.prompt, a.model);
  const timeoutSec = Math.max(1, Math.ceil(a.timeoutMs / 1000));

  const res = await run(built.cmd, built.args, {
    env: scrubEnv(), // rt1: token-less — NOT built.env (which carries ANTHROPIC_API_KEY)
    stdin: built.stdin,
    timeoutSec,
  });

  if (res.notFound) {
    return { raw_output: "", input_tokens: 0, output_tokens: 0, error: "claude_unavailable" };
  }
  if (res.timedOut) {
    return { raw_output: normalizeClaudeOutput(res.stdout), input_tokens: 0, output_tokens: 0, error: "timeout" };
  }
  if (res.code !== 0) {
    return {
      raw_output: normalizeClaudeOutput(res.stdout),
      input_tokens: 0,
      output_tokens: 0,
      error: `claude exited ${res.code ?? "null"}: ${res.stderr.slice(0, 500)}`,
    };
  }

  const usage = parseClaudeUsage(res.stdout);
  return {
    raw_output: normalizeClaudeOutput(res.stdout),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    error: null,
  };
}
