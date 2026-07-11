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
import fs from "node:fs";
import path from "node:path";
import { extractVerdictJson, isPlainObject, run } from "./copilot_dispatch.ts";
import { parseFixPlanOutput, scrubEnv, sidecarPathFor } from "./red_team_lib.ts";
import type { FixPlanMove, RedTeamFinding, RedTeamFixPlan } from "./red_team_lib.ts";
import { applyPatches, type FixerPatch } from "./stark_review_doc_lib.ts";
import {
  buildCommand as buildClaudeCommand,
  normalizeOutput as normalizeClaudeOutput,
} from "./agent_claude.ts";
import type { BuiltCommand } from "./agent_codex.ts";
import { assetPromptsDir } from "./asset_root_lib.ts";
import { getRedTeamConfig } from "./stark_config_lib.ts";
import { computeDispatchCost } from "./cost_lib.ts";
import {
  connect,
  loadAuditPolicy,
  recordDispositions,
  recordFoldRun,
  type DispositionRow,
  type FoldRunRow,
} from "./red_team_audit_lib.ts";
import { applyToField } from "./red_team_audit_text_lib.ts";
import {
  apiGet,
  apiPatch,
  prComment,
  prCreate,
  prList,
  resolveAppName,
  type AppName,
} from "./github_app_lib.ts";

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

// ── Task 7: least-privilege decider dispatch (rt1) + prompt assembly ─────
//
// The fold decider is Claude, acting AS the artifact's author, triaging a
// fix plan whose text (and whatever the artifact/findings carry) is
// untrusted — it may contain prompt injection aimed at the model. Three
// independent defenses:
//
//   1. `assembleFoldPrompt` wraps every untrusted block in a hash-stamped
//      `<<<RED_TEAM_INPUT>>>` envelope with the system prompt (`foldMd`)
//      placed OUTSIDE the delimiters, so the model's actual instructions
//      never share a "region" with attacker-controlled text.
//   2. `buildDeciderEnv` gives the model subprocess ONLY model auth
//      (`scrubEnv()` + HOME + ANTHROPIC_API_KEY) — the call to Anthropic is
//      the single sanctioned egress. The repo/publishing credential
//      (GITHUB_TOKEN/GH_TOKEN) is deliberately absent (as is OPENAI_*), so a
//      successful injection still has no credential to reach GitHub with.
//      The host mints the GitHub token later, AFTER audit, to open the PR —
//      never inside this subprocess. This is the load-bearing invariant
//      (rt1): even if defense 1 fails, defense 2 holds.
//   3. `buildDeciderCommand` disables every tool (`--disallowedTools Bash
//      Edit Write Read WebFetch WebSearch Task NotebookEdit`). The decider
//      only emits JSON — it needs zero tools — so even a jailbroken model
//      has no Bash/Write/WebFetch primitive to exfiltrate or mutate with.

/**
 * Wrap one untrusted block in a hash-stamped `<<<RED_TEAM_INPUT>>>` envelope.
 *
 * Escapes any delimiter markers already present in `body` BEFORE hashing +
 * wrapping. Without this, a body containing the literal string
 * `<<<END_RED_TEAM_INPUT name="...">>>` (or `<<<RED_TEAM_INPUT ...>>>`) could
 * forge an early boundary, spilling attacker-controlled text out of its
 * envelope and into the region where only `foldMd` (the system prompt) is
 * supposed to issue instructions — defeating the injection defense
 * `assembleFoldPrompt` is built around.
 *
 * Same replacement strings as `wrapFixPlanInput` (this file's sibling
 * wrapper in `red_team_lib.ts`, ~line 1977), so the whole red-team subsystem
 * escapes delimiters identically. Not imported because `wrapFixPlanInput`
 * isn't exported; replicated inline instead.
 */
function block(name: string, body: string): string {
  const escaped = body
    .replace(/<<<RED_TEAM_INPUT/g, "&lt;&lt;&lt;RED_TEAM_INPUT")
    .replace(/<<<END_RED_TEAM_INPUT/g, "&lt;&lt;&lt;END_RED_TEAM_INPUT");
  return `<<<RED_TEAM_INPUT name="${name}" hash="${sha256Hex(escaped)}">>>\n${escaped}\n<<<END_RED_TEAM_INPUT name="${name}">>>`;
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
 * Tools the fold decider is forbidden from using. It only emits JSON
 * dispositions, so it needs none of them — disabling the mutating/exfil
 * primitives (Bash/Edit/Write/Read/WebFetch/WebSearch/Task/NotebookEdit)
 * means even a jailbroken model has no way to run a command, touch the
 * filesystem, or make a network call from inside the subprocess (rt1
 * defense 3).
 */
export const DECIDER_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
] as const;

/**
 * Build the least-privilege env for the decider subprocess (rt1 defense 2).
 *
 * Starts from `scrubEnv()` (PATH/USER/SHELL/LANG/LC_ALL/TMPDIR — no HOME, no
 * credentials) and re-adds ONLY what the model call itself needs: `HOME`
 * (so the Claude CLI can find its config) and `ANTHROPIC_API_KEY` (the one
 * sanctioned egress — the call to Anthropic). `ANTHROPIC_AGENTS` is honored
 * as the source var and surfaced as `ANTHROPIC_API_KEY`, matching
 * `agent_claude.ts::buildEnv`. The repo/publishing credential
 * (`GITHUB_TOKEN`/`GH_TOKEN`) and `OPENAI_*` are deliberately NOT
 * re-added — a prompt-injected artifact that talks past the delimiter
 * defense still finds no GitHub token to reach the repo with. The host
 * mints the GitHub token separately, after audit, when it opens the PR.
 */
export function buildDeciderEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = scrubEnv(source);
  if (typeof source.HOME === "string") env.HOME = source.HOME;
  const apiKey = source.ANTHROPIC_API_KEY ?? source.ANTHROPIC_AGENTS;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}

/**
 * Build the full decider command: the shared headless-Claude argv
 * (`agent_claude.ts::buildCommand`) plus the tool-restriction flag
 * (`--disallowedTools <names...>`, appended at the END so the variadic
 * consumes nothing else) and the least-privilege env from
 * `buildDeciderEnv`. `buildCommand`'s own `env` (which carries
 * `ANTHROPIC_API_KEY` but also nothing else it shouldn't) is REPLACED with
 * `buildDeciderEnv()` so this is the single, testable source of truth for
 * the decider's argv + env (rt1 defenses 2 + 3).
 */
export function buildDeciderCommand(prompt: string, model: string): BuiltCommand {
  const built = buildClaudeCommand(prompt, model);
  return {
    ...built,
    args: [...built.args, "--disallowedTools", ...DECIDER_DISALLOWED_TOOLS],
    env: buildDeciderEnv(),
  };
}

/**
 * Dispatch the fold decider: a single headless Claude call over the
 * assembled prompt, built by `buildDeciderCommand` (least-privilege env +
 * tool restriction — rt1 defenses 2 + 3).
 *
 * `timeoutMs` is converted to `run()`'s `timeoutSec` (rounding up, floor 1s,
 * so a sub-second budget never collapses to an immediate timeout).
 */
export async function dispatchDecider(a: {
  prompt: string;
  model: string;
  timeoutMs: number;
}): Promise<{ raw_output: string; input_tokens: number; output_tokens: number; error: string | null }> {
  const built = buildDeciderCommand(a.prompt, a.model);
  const timeoutSec = Math.max(1, Math.ceil(a.timeoutMs / 1000));

  const res = await run(built.cmd, built.args, {
    env: built.env, // rt1: least-privilege — model auth only, no GitHub/OpenAI token
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

// ── Task 8: decision-log renderer (design §5.4) ──────────────────────────

/**
 * Per-move section-header label for each `Disposition` (design §5.4's
 * illustrative `REJECTED` / `MODIFIED`) — a past-tense/state label, not a
 * raw uppercase of the disposition verb (`"reject".toUpperCase()` would
 * render `REJECT`, not `REJECTED`).
 */
const DISPOSITION_LABEL: Record<Disposition, string> = {
  accept: "ACCEPTED",
  modify: "MODIFIED",
  reject: "REJECTED",
  apply_failed: "APPLY_FAILED",
};

/**
 * Render the `<artifact>.fold.md` decision-log body: a header line with
 * accept/modify/reject (+ apply-failed, when present) counts, followed by
 * one `##` section per move showing its disposition, the finding IDs it
 * addresses, and the decider's rationale.
 *
 * This is a plain audit-trail renderer over already-decided
 * `MoveDisposition[]` — no re-derivation of the dispositions themselves
 * (that's `parseDispositions`/`applyFold`'s job); it only formats what it is
 * given.
 */
export function renderFoldLog(a: {
  artifactPath: string;
  sourceRunId: string;
  deciderModel: string;
  dispositions: MoveDisposition[];
}): string {
  const c = { accept: 0, modify: 0, reject: 0, apply_failed: 0 };
  for (const d of a.dispositions) c[d.disposition]++;
  const lines = [
    `# Fold decision log — ${a.artifactPath}`,
    `Fix plan: ${a.sourceRunId}  ·  Decider: ${a.deciderModel}  ·  ` +
      `${c.accept} accepted / ${c.modify} modified / ${c.reject} rejected` +
      (c.apply_failed ? ` / ${c.apply_failed} apply-failed` : ""),
    "",
  ];
  for (const d of a.dispositions) {
    lines.push(`## ${d.move_id} — ${DISPOSITION_LABEL[d.disposition]}`);
    lines.push(`Addresses: ${d.addressed_finding_ids.join(", ") || "—"}`);
    lines.push(d.rationale, "");
  }
  return lines.join("\n");
}

// ── Task 10: runFold orchestrator (audit-before-publish, budget, rt1/rt2) ─

/** Terminal status of a fold run. */
export type FoldStatus =
  | "ok"
  | "no_moves"
  | "skipped_budget_exhausted_fold"
  | "no_fix_plan_found"
  | "stale_fix_plan"
  | "source_run_id_required"
  | "decider_dispatch_failed";

/** Result of a fold run (design §5.5). */
export interface FoldResult {
  fold_run_id: string;
  source_run_id: string;
  decider_model: string;
  dispositions: MoveDisposition[];
  /** `accept` count (patch landed). */
  applied_count: number;
  modified_count: number;
  rejected_count: number;
  apply_failed_count: number;
  cost_usd: number;
  duration_s: number;
  /** The folded artifact text (whether or not it was written to disk). */
  revised_doc: string;
  status: FoldStatus;
  pr_url: string | null;
}

/** The dispatch shape shared by `dispatchDecider` and injected test doubles. */
export type DeciderFn = (a: {
  prompt: string;
  model: string;
  timeoutMs: number;
}) => Promise<{ raw_output: string; input_tokens: number; output_tokens: number; error: string | null }>;

/** Args for the fold PR helper. */
export interface OpenOrEditFoldPrArgs {
  repo: string | null;
  marker: string;
  body: string;
  branch: string | null;
  base: string | null;
  prNumber: number | null;
  artifactRelPath: string;
  sourceRunId: string;
  app: AppName;
  /** Open the fold PR as a draft. Defaults to true (draft-by-default policy);
   *  the fold PR is reviewable-and-never-merged, so a draft is the natural state. */
  draft?: boolean;
}

/** The PR-side shape shared by `openOrEditFoldPr` and injected test doubles. */
export type PrFn = (a: OpenOrEditFoldPrArgs) => Promise<{ pr_url: string | null; pr_number: number | null }>;

export interface RunFoldOpts {
  /** Absolute path to the artifact (design/plan doc) being folded. */
  artifactPath: string;
  /** Audit DB path (already resolved by the caller). */
  dbPath: string;
  /** Triage only — no file writes, no audit, no PR. */
  dryRun: boolean;
  /** Whether the caller wants a PR opened/edited (AND `red_team.fold.open_pr`). */
  openPr: boolean;
  /** Open the fold PR as a draft (default true). CLI `--ready` sets this false. */
  draft?: boolean;

  /** Pre-resolved fix-plan source (tests + a CLI that resolved upstream). When
   *  omitted, runFold resolves it via `resolveFoldFixPlanSource`. */
  fixPlanSource?: FixPlanSource;
  /** Resolution inputs, used only when `fixPlanSource` is absent. */
  explicitFixPlanJson?: string | null;
  sourceRunId?: string | null;
  forceStale?: boolean;

  /** Optional decider-model override (operator `--model`). The fold decider
   *  runs on the Claude CLI (`buildDeciderCommand`), so this must be a Claude
   *  model id; omitted → `red_team.fold.model` (claude-opus-4-8). */
  model?: string;

  /** System/triage-contract prompt. When omitted, read from
   *  `<assetPromptsDir>/red-team/fold.md` (the production path). */
  foldMd?: string;
  /** Source spec, folded into the prompt as context (optional). */
  sourceSpec?: string | null;
  /** Findings the fix plan addresses, folded into the prompt as context. */
  findings?: RedTeamFinding[];

  /** Relative-to-repo artifact path for the decision log, PR marker, and audit
   *  row. Defaults to the artifact's basename. */
  artifactRelPath?: string;
  /** `design` | `plan` — recorded on the fold-run row. */
  stage?: string;
  /** Repo `owner/name` for the PR. */
  repo?: string | null;
  /** Head branch for a fresh PR. */
  branch?: string | null;
  /** Base branch for a fresh PR (defaults to `main`). */
  base?: string | null;
  /** Existing PR to edit in place. */
  prNumber?: number | null;

  /** Injectables (tests). */
  deciderFn?: DeciderFn;
  prFn?: PrFn;
  onAudit?: () => void;
  onPr?: () => void;
  readFileFn?: (p: string) => string;
  writeFileFn?: (p: string, data: string) => void;
}

/** The `.fold.md` decision-log sidecar path for an artifact. Mirrors
 *  `sidecarPathFor` (`.red-team.md`) but for the fold log. */
export function foldSidecarPathFor(artifactPath: string): string {
  if (artifactPath.endsWith(".md")) return artifactPath.slice(0, -3) + ".fold.md";
  return artifactPath + ".fold.md";
}

/** Parse the `Run ID` from a red-team sidecar header line
 *  (`- **Run ID:** \`<id>\``). Returns null when absent. */
export function parseSidecarRunId(sidecarText: string): string | null {
  const m = /\*\*Run ID:\*\*\s*`([^`]+)`/.exec(sidecarText);
  return m ? m[1]! : null;
}

interface ResolveFoldSourceOpts {
  artifactPath: string;
  /** Current artifact text (already read by the caller). */
  artifactText: string;
  dbPath: string;
  explicitFixPlanJson?: string | null;
  sourceRunId?: string | null;
  forceStale?: boolean;
  readFileFn?: (p: string) => string;
}

/** Load `fix_plan_json` (and `fix_plan_status`) for a run id from the audit DB.
 *  Returns null when the row/column is empty. Never throws on a missing row. */
function loadFixPlanJsonForRun(dbPath: string, runId: string): string | null {
  let db: ReturnType<typeof connect> | null = null;
  try {
    db = connect(dbPath);
    const row = db
      .prepare("SELECT fix_plan_json FROM red_team_runs WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as { fix_plan_json?: string | null } | undefined;
    const json = row?.fix_plan_json;
    return typeof json === "string" && json.length > 0 ? json : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Resolve which fix plan the fold host should apply — the "real DB-load site".
 *
 * The fix-plan JSON is NOT stored in the `.red-team.md` sidecar markdown; it
 * lives in the audit DB (`red_team_runs.fix_plan_json`), keyed by `run_id`.
 * The sidecar's header carries the `Run ID`. Resolution:
 *   1. `explicitFixPlanJson` (e.g. `--fix-plan-json`) wins outright.
 *   2. Otherwise resolve the run id: `sourceRunId` (`--source-run-id`) if
 *      given, else the sidecar's `Run ID`. Load its `fix_plan_json` from the
 *      DB. `JSON.parse` is GUARDED here — a null/malformed value returns
 *      `no_fix_plan_found` instead of throwing (the delegate
 *      `resolveFixPlanForFold` parses again downstream, but only after this
 *      shape check has passed).
 *
 * LIMITATION (rt4, v1): the red-team CHALLENGE does not record the artifact's
 * content hash, so there is no stored baseline to detect post-challenge edits
 * against on a first fold. For v1 we pass the CURRENT artifact hash as the
 * source hash, so `resolveFixPlanForFold`'s staleness check always matches and
 * a fresh challenge resolves `ok`. True edit-detection needs challenge-side
 * hashing (a follow-up). `--force-stale` is still threaded through for when
 * challenge-side hashing lands.
 */
export function resolveFoldFixPlanSource(opts: ResolveFoldSourceOpts): {
  source: FixPlanSource | null;
  status: FoldStatus;
} {
  const readFileFn = opts.readFileFn ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const curHash = sha256Hex(opts.artifactText);

  // 1) Explicit override — no DB, no staleness question.
  if (opts.explicitFixPlanJson) {
    try {
      JSON.parse(opts.explicitFixPlanJson);
    } catch {
      return { source: null, status: "no_fix_plan_found" };
    }
    const r = resolveFixPlanForFold({
      artifactText: opts.artifactText,
      sidecar: null,
      explicitFixPlanJson: opts.explicitFixPlanJson,
      dbLatest: null,
      sourceRunId: opts.sourceRunId ?? null,
      forceStale: opts.forceStale ?? false,
    });
    return { source: r.source, status: r.status as FoldStatus };
  }

  // 2) Resolve the run id: explicit --source-run-id, else the sidecar header.
  let runId = opts.sourceRunId ?? null;
  if (!runId) {
    const sidecarPath = sidecarPathFor(opts.artifactPath);
    try {
      runId = parseSidecarRunId(readFileFn(sidecarPath));
    } catch {
      runId = null;
    }
  }
  if (!runId) return { source: null, status: "no_fix_plan_found" };

  // Load + GUARD the DB fix-plan JSON (decision rt: guard at the DB-load site).
  const fixPlanJson = loadFixPlanJsonForRun(opts.dbPath, runId);
  if (!fixPlanJson) return { source: null, status: "no_fix_plan_found" };
  try {
    JSON.parse(fixPlanJson);
  } catch {
    return { source: null, status: "no_fix_plan_found" };
  }

  // With --source-run-id, drive the DB fallback path (requires the id, which we
  // have); otherwise present it as the adjacent sidecar. Either way the source
  // hash is the CURRENT hash (see LIMITATION above), so staleness matches.
  const r = opts.sourceRunId
    ? resolveFixPlanForFold({
        artifactText: opts.artifactText,
        sidecar: null,
        explicitFixPlanJson: null,
        dbLatest: { fixPlanJson, runId, artifactHash: curHash },
        sourceRunId: opts.sourceRunId,
        forceStale: opts.forceStale ?? false,
      })
    : resolveFixPlanForFold({
        artifactText: opts.artifactText,
        sidecar: { fixPlanJson, runId, artifactHash: curHash },
        explicitFixPlanJson: null,
        dbLatest: null,
        sourceRunId: null,
        forceStale: opts.forceStale ?? false,
      });
  return { source: r.source, status: r.status as FoldStatus };
}

/**
 * Open a fresh fold PR (or edit an existing one's decision-log comment).
 *
 * Focused helper over `github_app_lib` (create + comment), authored by the
 * run's App (`stark-claude`). Find-by-marker, edit-or-create keeps ONE
 * updatable fold comment per artifact. NEVER merges. No-ops (returns
 * `{null,null}`) when there is no `repo` to publish to — so the orchestrator's
 * unit tests, which never pass a live repo, never touch the network. Its live
 * behavior is validated at Task 15.
 *
 * The caller (the `/stark-red-team-fold` skill / CLI) is responsible for the
 * git side — committing the folded artifact + `.fold.md` and pushing the
 * branch — before this runs, exactly as the challenge splits skill-side git
 * from CLI-side GitHub API calls. This helper only touches the GitHub API.
 */
export async function openOrEditFoldPr(
  a: OpenOrEditFoldPrArgs,
): Promise<{ pr_url: string | null; pr_number: number | null }> {
  if (!a.repo) return { pr_url: null, pr_number: null };
  const app = resolveAppName(a.app);

  // 1) Locate the target PR: explicit number, else an open PR for the branch.
  let prNumber = a.prNumber ?? null;
  if (prNumber === null && a.branch) {
    const list = (await prList(a.repo, "open", app)) as Array<Record<string, unknown>>;
    for (const pr of list) {
      const head = pr["head"] as Record<string, unknown> | undefined;
      const ref = head && typeof head["ref"] === "string" ? head["ref"] : "";
      if (ref === a.branch) {
        prNumber = typeof pr["number"] === "number" ? (pr["number"] as number) : null;
        break;
      }
    }
  }

  // 2) Create the PR when none exists yet (needs a pushed branch).
  let prUrl: string | null = null;
  if (prNumber === null && a.branch) {
    const created = (await prCreate(a.repo, {
      head: a.branch,
      base: a.base ?? "main",
      title: `Red-team fold: ${a.artifactRelPath}`,
      body:
        `${a.marker}\n\nFolded the red-team fix plan into \`${a.artifactRelPath}\` ` +
        `(source run \`${a.sourceRunId}\`). Decision log posted as a comment below.`,
      draft: a.draft ?? true,
      app,
    })) as Record<string, unknown>;
    prNumber = typeof created["number"] === "number" ? (created["number"] as number) : null;
    prUrl = typeof created["html_url"] === "string" ? (created["html_url"] as string) : null;
  }

  if (prNumber === null) return { pr_url: prUrl, pr_number: null };

  // 3) Find-by-marker, edit-or-create the fold decision-log comment.
  try {
    const comments = (await apiGet(
      `/repos/${a.repo}/issues/${prNumber}/comments`,
      { per_page: 100 },
      app,
    )) as Array<Record<string, unknown>>;
    const existing = comments.find(
      (c) => typeof c["body"] === "string" && (c["body"] as string).includes(a.marker),
    );
    if (existing && typeof existing["id"] === "number") {
      await apiPatch(`/repos/${a.repo}/issues/comments/${existing["id"] as number}`, { body: a.body }, app);
    } else {
      await prComment(a.repo, prNumber, a.body, app);
    }
  } catch {
    // Comment posting failed — the PR still exists; surface its URL so the
    // caller can retry the comment out of band.
    await prComment(a.repo, prNumber, a.body, app).catch(() => {});
  }

  if (!prUrl) prUrl = `https://github.com/${a.repo}/pull/${prNumber}`;
  return { pr_url: prUrl, pr_number: prNumber };
}

/** Tally dispositions by verb. */
function tallyDispositions(dispositions: MoveDisposition[]): {
  accept: number;
  modify: number;
  reject: number;
  apply_failed: number;
} {
  const c = { accept: 0, modify: 0, reject: 0, apply_failed: 0 };
  for (const d of dispositions) c[d.disposition]++;
  return c;
}

/**
 * Orchestrate one fold cycle: resolve the fix-plan source → assemble the
 * decider prompt → dispatch → budget-gate → parse + validate dispositions →
 * apply to a working copy → render the decision log → write artifact +
 * `.fold.md` → AUDIT (before any publish) → open/edit the PR. NEVER merges.
 *
 * Ordering invariants:
 *   - The budget gate runs BEFORE any write, audit, or PR — an over-budget
 *     dispatch persists nothing (rt5).
 *   - Audit (`recordFoldRun` + `recordDispositions`, with FU-rt6 retention on
 *     the free-text fields) happens strictly BEFORE the PR side effect, so a
 *     PR never references an unaudited fold (rt2).
 *   - `--dry-run` triages into the return value and writes nothing.
 *   - Zero moves short-circuits before the (paid) decider call.
 */
export async function runFold(opts: RunFoldOpts): Promise<FoldResult> {
  const readFileFn = opts.readFileFn ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const writeFileFn = opts.writeFileFn ?? ((p: string, d: string) => fs.writeFileSync(p, d, "utf8"));
  const cfg = getRedTeamConfig().fold;
  const deciderModel = opts.model ?? cfg.model;

  const artifactText = readFileFn(opts.artifactPath);
  const artifactHash = sha256Hex(artifactText);
  const artifactRelPath = opts.artifactRelPath ?? path.basename(opts.artifactPath);
  const stage = opts.stage ?? "spec";

  // 1) Resolve the fix-plan source (pre-resolved by caller, else DB-load site).
  let src: FixPlanSource;
  if (opts.fixPlanSource) {
    src = opts.fixPlanSource;
  } else {
    const resolved = resolveFoldFixPlanSource({
      artifactPath: opts.artifactPath,
      artifactText,
      dbPath: opts.dbPath,
      explicitFixPlanJson: opts.explicitFixPlanJson ?? null,
      sourceRunId: opts.sourceRunId ?? null,
      forceStale: opts.forceStale ?? false,
      readFileFn,
    });
    if (resolved.status !== "ok" || !resolved.source) {
      return makeFoldResult({
        status: resolved.status,
        fold_run_id: "",
        source_run_id: opts.sourceRunId ?? "",
        decider_model: deciderModel,
        revised_doc: artifactText,
      });
    }
    src = resolved.source;
  }

  const foldRunId = `fold-${src.sourceRunId}-${artifactHash.slice(0, 8)}`;

  // 2) No moves → short-circuit before the (paid) decider call. No diff, no PR.
  if (src.fixPlan.moves.length === 0) {
    return makeFoldResult({
      status: "no_moves",
      fold_run_id: foldRunId,
      source_run_id: src.sourceRunId,
      decider_model: deciderModel,
      revised_doc: artifactText,
    });
  }

  // 3) Assemble prompt + dispatch the decider.
  const foldMd =
    opts.foldMd ?? readFileFn(path.join(assetPromptsDir(), "red-team", "fold.md"));
  const prompt = assembleFoldPrompt({
    foldMd,
    artifact: artifactText,
    sourceSpec: opts.sourceSpec ?? null,
    fixPlan: src.fixPlan,
    findings: opts.findings ?? [],
  });
  const t0 = Date.now();
  const decider: DeciderFn = opts.deciderFn ?? dispatchDecider;
  const out = await decider({ prompt, model: deciderModel, timeoutMs: cfg.timeout_s * 1000 });
  const cost = computeDispatchCost(deciderModel, out.input_tokens, out.output_tokens);
  const durationS = (Date.now() - t0) / 1000;

  // 3b) Decider dispatch failure — bail BEFORE any write, audit, or PR.
  //     `dispatchDecider` sets `error` to claude_unavailable/timeout/non-zero
  //     exit; on those `raw_output` is empty, so parseDispositions yields
  //     nothing and the rest of the pipeline would persist a "0 accepted /
  //     0 modified / 0 rejected" artifact + `.fold.md` + audit row (+ PR)
  //     under status "ok" — indistinguishable from a genuine "reviewed
  //     everything, changed nothing" fold. A dispatch failure is NOT a clean
  //     empty fold, so it gets its own terminal status and writes nothing
  //     (audit integrity). Cost is $0 on dispatch errors (tokens are 0), so
  //     the budget gate below never catches this path.
  if (out.error !== null) {
    return makeFoldResult({
      status: "decider_dispatch_failed",
      fold_run_id: foldRunId,
      source_run_id: src.sourceRunId,
      decider_model: deciderModel,
      revised_doc: artifactText,
      cost_usd: cost,
      duration_s: durationS,
    });
  }

  // 4) Budget gate — BEFORE any write, audit, or PR (rt5).
  if (cost > cfg.max_cost_usd) {
    return makeFoldResult({
      status: "skipped_budget_exhausted_fold",
      fold_run_id: foldRunId,
      source_run_id: src.sourceRunId,
      decider_model: deciderModel,
      revised_doc: artifactText,
      cost_usd: cost,
      duration_s: durationS,
    });
  }

  // 5) Parse + validate dispositions, apply to a working copy.
  //     Invalid decider rows are NOT dropped: per design §12 every one must
  //     still appear in the tally, the decision log, and the audit, recorded
  //     as apply_failed so the fold trail is complete (audit integrity). Each
  //     carries patch:null, so applyFold's accept/modify-with-patch filter
  //     skips it and it flows through untouched into counts/log/audit.
  //     FOLLOW-UP: design §12 also calls for one bounded decider retry before
  //     recording an invalid entry as apply_failed; that retry is deferred —
  //     the required audit-integrity behavior (record, don't drop) lands here.
  const { dispositions: parsed, invalid } = parseDispositions(out.raw_output, src.fixPlan.moves);
  const movesById = new Map(src.fixPlan.moves.map((m) => [m.id, m]));
  const invalidAsFailed: MoveDisposition[] = invalid.map((iv) => ({
    move_id: iv.move_id,
    addressed_finding_ids: [],
    disposition: "apply_failed",
    rationale: `decider produced an invalid disposition (${iv.reason}); recorded as apply_failed for audit completeness`,
    patch: null,
    move_snapshot_json: JSON.stringify(movesById.get(iv.move_id) ?? {}),
  }));
  const applied = applyFold(artifactText, [...parsed, ...invalidAsFailed]);
  const counts = tallyDispositions(applied.dispositions);

  // 6) Render the decision log.
  const foldLog = renderFoldLog({
    artifactPath: artifactRelPath,
    sourceRunId: src.sourceRunId,
    deciderModel,
    dispositions: applied.dispositions,
  });

  const result = makeFoldResult({
    status: "ok",
    fold_run_id: foldRunId,
    source_run_id: src.sourceRunId,
    decider_model: deciderModel,
    dispositions: applied.dispositions,
    applied_count: counts.accept,
    modified_count: counts.modify,
    rejected_count: counts.reject,
    apply_failed_count: counts.apply_failed,
    cost_usd: cost,
    duration_s: durationS,
    revised_doc: applied.newDoc,
  });

  // 7) Dry-run: triage only — no writes, no audit, no PR.
  if (opts.dryRun) return result;

  // 8) Write the folded artifact + decision log.
  writeFileFn(opts.artifactPath, applied.newDoc);
  writeFileFn(foldSidecarPathFor(opts.artifactPath), foldLog);

  // 9) AUDIT BEFORE PUBLISH (rt2) — retention policy on the free-text fields.
  const policy = loadAuditPolicy();
  const foldRow: FoldRunRow = {
    fold_run_id: foldRunId,
    source_run_id: src.sourceRunId,
    stage,
    artifact_relative_path: artifactRelPath,
    artifact_hash: artifactHash,
    fix_plan_hash: sha256Hex(JSON.stringify(src.fixPlan.moves)),
    repo: opts.repo ?? null,
    pr_number: opts.prNumber ?? null,
    decider_model: deciderModel,
    accepted_count: counts.accept,
    modified_count: counts.modify,
    rejected_count: counts.reject,
    apply_failed_count: counts.apply_failed,
    cost_usd: cost,
    duration_s: durationS,
  };
  recordFoldRun(foldRow, opts.dbPath);
  const dispositionRows: DispositionRow[] = applied.dispositions.map((d) => ({
    fold_run_id: foldRunId,
    source_run_id: src.sourceRunId,
    move_id: d.move_id,
    addressed_finding_ids: JSON.stringify(d.addressed_finding_ids),
    disposition: d.disposition,
    rationale: applyToField(d.rationale, policy).stored,
    move_snapshot_json: applyToField(d.move_snapshot_json, policy).stored,
  }));
  recordDispositions(dispositionRows, opts.dbPath);
  opts.onAudit?.();

  // 10) THEN publish (host mints the token here, never in the decider env).
  //     Never merges.
  let prUrl: string | null = null;
  if (cfg.open_pr && opts.openPr) {
    const marker = `<!-- stark-red-team-fold: source_run_id=${src.sourceRunId} artifact=${artifactRelPath} -->`;
    const prFn: PrFn = opts.prFn ?? openOrEditFoldPr;
    const pr = await prFn({
      repo: opts.repo ?? null,
      marker,
      body: `${marker}\n\n${foldLog}`,
      branch: opts.branch ?? null,
      base: opts.base ?? null,
      prNumber: opts.prNumber ?? null,
      artifactRelPath,
      sourceRunId: src.sourceRunId,
      app: "stark-claude",
      draft: opts.draft ?? true,
    });
    prUrl = pr.pr_url;
    opts.onPr?.();
  }

  return { ...result, pr_url: prUrl };
}

/** Build a `FoldResult` with sensible zero-defaults for the fields the caller
 *  doesn't set (counts, cost, pr_url). */
function makeFoldResult(
  p: Pick<FoldResult, "status" | "fold_run_id" | "source_run_id" | "decider_model" | "revised_doc"> &
    Partial<FoldResult>,
): FoldResult {
  return {
    dispositions: [],
    applied_count: 0,
    modified_count: 0,
    rejected_count: 0,
    apply_failed_count: 0,
    cost_usd: 0,
    duration_s: 0,
    pr_url: null,
    ...p,
  };
}
