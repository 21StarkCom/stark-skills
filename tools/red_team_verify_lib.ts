// Red-team refutation / verification pass (Task #2).
//
// After the committee produces + validates findings, and before the gate
// counts blockers, each finding is adversarially challenged by a *distinct*
// agent (Claude, a second opinion vs the codex committee). The refuter tries
// to refute the finding FROM THE ARTIFACT TEXT ONLY and returns one of:
//
//   uphold     — cannot refute; the finding keeps its EXACT severity.
//   downgrade  — real but over-rated; recalibrate to an honest LOWER severity.
//   drop       — refuted by the text (already addressed / out of scope / wrong).
//
// Signal preservation is the invariant: a finding is dropped or downgraded
// ONLY when the refuter cites why from the artifact text, and a downgrade can
// only LOWER severity. A span-less drop/downgrade fails safe to `uphold`; an
// attempt to raise severity is clamped to `uphold`. The refuter can never add
// a finding or make the gate stricter — it is a pure noise-reducer.
//
// Design note: docs/specs/red-team-refutation-pass-2026-07-04.md

import { buildCommand as buildClaudeCommand, normalizeOutput as normalizeClaudeOutput } from "./agent_claude.ts";
import { run } from "./copilot_dispatch.ts";
import type { RedTeamFinding, Severity } from "./red_team_lib.ts";

/**
 * Extract the last balanced top-level `{...}` object from model text that
 * JSON-parses. Unlike `copilot_dispatch.extractVerdictJson` this does not
 * require any specific key (the refuter's object is keyed `disposition`, not
 * `verdict`). Returns null when nothing parses.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj: unknown = JSON.parse(candidates[i]!);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch { /* skip */ }
  }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────

export type RefutationDisposition = "uphold" | "downgrade" | "drop";

/** The four adversarial lenses. A finding is challenged through the lens that
 *  matches how it could fail, not one generic pass. */
export type RefutationLens =
  | "correctness"
  | "security"
  | "reproduces"
  | "already-addressed";

export interface RefutationVerdict {
  disposition: RefutationDisposition;
  /** Only meaningful for `downgrade`. */
  new_severity: Severity | null;
  /** Verbatim span from the artifact that justifies drop/downgrade. */
  cited_span: string | null;
  rationale: string | null;
  lens: RefutationLens;
}

export interface VerifyConfig {
  enabled: boolean;
  model: string;
  timeout_s: number;
  /** Refuters per finding; majority-vote when > 1. */
  votes: number;
  max_input_chars: number;
}

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  enabled: true,
  model: "claude-opus-4-8",
  timeout_s: 300,
  votes: 1,
  max_input_chars: 200_000,
};

export type FindingAction = "upheld" | "downgraded" | "dropped" | "skipped";

export interface RefuteSummary {
  total: number;
  upheld: number;
  downgraded: number;
  dropped: number;
  /** Human-review + errored refuters that were left untouched. */
  skipped: number;
  errors: number;
}

export interface RefuteResult {
  findings: RedTeamFinding[];
  summary: RefuteSummary;
  /** Per-finding audit trail (id → verdict + action), for the sidecar. */
  trail: Array<{
    id: string;
    action: FindingAction;
    original_severity: Severity;
    final_severity: Severity | null;
    verdicts: RefutationVerdict[];
  }>;
}

// ── Severity ordering (downgrade-only enforcement) ─────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

/** True when `a` is strictly less severe than `b`. */
function isLower(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] < SEVERITY_RANK[b];
}

// ── Lens selection ─────────────────────────────────────────────────────────

/** Choose the adversarial lens from the finding's failure_mode. */
export function lensForFinding(f: RedTeamFinding): RefutationLens {
  switch (f.failure_mode) {
    case "security":
    case "compliance":
      return "security";
    case "availability":
    case "data-loss":
      return "reproduces";
    case "operability":
    case "cost":
      return "already-addressed";
    default:
      return "correctness";
  }
}

const LENS_INSTRUCTION: Record<RefutationLens, string> = {
  correctness:
    "Lens: CORRECTNESS. Is the finding technically right about what the artifact does? If it mis-reads the design or attacks a mechanism the artifact doesn't actually use, refute it with the span that shows the real behavior.",
  security:
    "Lens: SECURITY. Does the threat actually apply to THIS artifact's trust model and scope? If the artifact is single-user/playground with no new trust boundary, or already constrains the surface, refute or downgrade with the span that scopes it.",
  reproduces:
    "Lens: DOES-IT-REPRODUCE. Can the failure actually occur given the artifact's stated flow? If the triggering sequence can't happen (no concurrency, no partition, no unbounded set), refute it with the span that rules it out.",
  "already-addressed":
    "Lens: ALREADY-ADDRESSED. Does the artifact already mitigate, scope out, or explicitly declare this out of scope ('what this is not' / playground)? If so, drop or downgrade citing that span.",
};

// ── Prompt ─────────────────────────────────────────────────────────────────

/** Truncate untrusted text to a char budget with an explicit marker. */
function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…[truncated for length]…";
}

export function buildRefuterPrompt(args: {
  finding: RedTeamFinding;
  artifact: string;
  sourceSpec: string;
  lens: RefutationLens;
  maxInputChars: number;
}): string {
  const { finding, artifact, sourceSpec, lens, maxInputChars } = args;
  // Split the char budget: most to the artifact, the rest to the source-spec.
  const artBudget = Math.floor(maxInputChars * 0.7);
  const specBudget = maxInputChars - artBudget;
  return [
    "You are an adversarial reviewer whose ONLY job is to try to REFUTE a single",
    "red-team finding using the artifact and source-spec text below. You are a",
    "second opinion, independent of the committee that produced the finding.",
    "",
    "Default posture: a finding SURVIVES unless you can point to the exact text",
    "that refutes or over-rates it. You may:",
    "  - UPHOLD  — you cannot refute it from the text; it keeps its severity.",
    "  - DOWNGRADE — the concern is real but the severity is inflated for this",
    "    artifact's actual scope; propose a LOWER severity (never higher).",
    "  - DROP — the text refutes it: already mitigated, explicitly out of scope",
    "    (e.g. a 'what this is not' / playground-scope statement), or factually",
    "    wrong about what the artifact does.",
    "",
    "You MUST cite a verbatim span from the artifact/source-spec for any DROP or",
    "DOWNGRADE. No span → you must UPHOLD. Do not invent scope the text doesn't",
    "state. Be honest: if it's a real, un-refutable blocker, UPHOLD it.",
    "",
    LENS_INSTRUCTION[lens],
    "",
    "── FINDING UNDER REVIEW ──",
    `persona: ${finding.persona}`,
    `severity: ${finding.severity}`,
    `failure_mode: ${finding.failure_mode ?? "unknown"}`,
    `concern: ${finding.concern}`,
    `consequence: ${finding.consequence}`,
    `counter_proposal: ${finding.counter_proposal}`,
    "",
    "── ARTIFACT ──",
    cap(artifact, artBudget),
    "",
    "── SOURCE SPEC ──",
    cap(sourceSpec, specBudget),
    "",
    "── OUTPUT ──",
    "Return ONE JSON object, no other text:",
    '{"disposition":"uphold|downgrade|drop","new_severity":"critical|high|medium|low|null","cited_span":"verbatim span or null","rationale":"one sentence"}',
  ].join("\n");
}

// ── Parse ────────────────────────────────────────────────────────────────

/**
 * Parse the refuter's JSON output into a verdict. Fails SAFE: any parse
 * problem, missing span on a drop/downgrade, or an attempt to raise severity
 * collapses to `uphold` (the finding is kept at its original severity). The
 * caller passes `current` so downgrade-only can be enforced here.
 */
export function parseRefutationVerdict(
  raw: string,
  lens: RefutationLens,
  current: Severity,
): RefutationVerdict {
  const upheld: RefutationVerdict = {
    disposition: "uphold",
    new_severity: null,
    cited_span: null,
    rationale: null,
    lens,
  };
  const obj = extractJsonObject(normalizeClaudeOutput(raw));
  if (!obj) return upheld;

  const disposition = obj.disposition;
  const span =
    typeof obj.cited_span === "string" && obj.cited_span.trim().length > 0
      ? obj.cited_span.trim()
      : null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale : null;
  const newSevRaw = typeof obj.new_severity === "string" ? obj.new_severity : null;
  const newSev =
    newSevRaw && VALID_SEVERITIES.has(newSevRaw) ? (newSevRaw as Severity) : null;

  if (disposition === "drop") {
    // Signal preservation: no cited span → keep the finding.
    if (!span) return { ...upheld, rationale };
    return { disposition: "drop", new_severity: null, cited_span: span, rationale, lens };
  }
  if (disposition === "downgrade") {
    // Need a span AND a strictly-lower target severity; otherwise uphold.
    if (!span || !newSev || !isLower(newSev, current)) return { ...upheld, rationale };
    return { disposition: "downgrade", new_severity: newSev, cited_span: span, rationale, lens };
  }
  return { ...upheld, rationale };
}

// ── Vote aggregation ───────────────────────────────────────────────────────

/**
 * Aggregate N verdicts for one finding into a single decision. Conservative,
 * majority-based, and signal-preserving:
 *   - DROP only when drops are a strict majority of the votes.
 *   - else DOWNGRADE when downgrades are a strict majority — to the LEAST
 *     reduction (highest proposed severity), so a split never over-cuts.
 *   - else UPHOLD.
 * With the default `votes: 1` this is just "the single verdict wins".
 */
export function aggregateVerdicts(
  verdicts: readonly RefutationVerdict[],
  current: Severity,
): { disposition: RefutationDisposition; new_severity: Severity | null } {
  const n = verdicts.length;
  if (n === 0) return { disposition: "uphold", new_severity: null };
  const drops = verdicts.filter((v) => v.disposition === "drop");
  const downs = verdicts.filter(
    (v) => v.disposition === "downgrade" && v.new_severity && isLower(v.new_severity, current),
  );
  if (drops.length * 2 > n) return { disposition: "drop", new_severity: null };
  if (downs.length * 2 > n) {
    // Least reduction: pick the highest (closest-to-original) proposed severity.
    let best: Severity | null = null;
    for (const v of downs) {
      if (!v.new_severity) continue;
      if (best === null || SEVERITY_RANK[v.new_severity] > SEVERITY_RANK[best]) {
        best = v.new_severity;
      }
    }
    if (best && isLower(best, current)) return { disposition: "downgrade", new_severity: best };
  }
  return { disposition: "uphold", new_severity: null };
}

/**
 * Apply an aggregated decision to a finding. Returns the (possibly severity-
 * adjusted) finding, or `null` when dropped.
 */
export function applyDecision(
  finding: RedTeamFinding,
  decision: { disposition: RefutationDisposition; new_severity: Severity | null },
): { finding: RedTeamFinding | null; action: FindingAction } {
  if (decision.disposition === "drop") return { finding: null, action: "dropped" };
  if (
    decision.disposition === "downgrade" &&
    decision.new_severity &&
    isLower(decision.new_severity, finding.severity)
  ) {
    return {
      finding: { ...finding, severity: decision.new_severity },
      action: "downgraded",
    };
  }
  return { finding, action: "upheld" };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export const REFUTER_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
] as const;

/** Injectable refuter fn (tests pass a fake; production uses `dispatchRefuter`).
 *  Given the assembled refuter prompt, returns raw model text (+ optional
 *  error). */
export type RefuteFn = (
  prompt: string,
  model: string,
) => Promise<{ raw_output: string; error: string | null }>;

/**
 * Dispatch one refuter: a token-less least-privilege headless Claude call
 * (mirrors the fold decider). `agent_claude.buildCommand`'s env already
 * excludes GitHub/OpenAI tokens; we append `--disallowedTools` so a
 * prompt-injected artifact cannot make the refuter touch the filesystem or
 * network.
 */
export async function dispatchRefuter(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<{ raw_output: string; error: string | null }> {
  const built = buildClaudeCommand(prompt, model);
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const res = await run(
    built.cmd,
    [...built.args, "--disallowedTools", ...REFUTER_DISALLOWED_TOOLS],
    { env: built.env, stdin: built.stdin, timeoutSec },
  );
  if (res.notFound) return { raw_output: "", error: "claude_unavailable" };
  if (res.timedOut) return { raw_output: normalizeClaudeOutput(res.stdout), error: "timeout" };
  if (res.code !== 0) {
    return {
      raw_output: normalizeClaudeOutput(res.stdout),
      error: `claude exited ${res.code ?? "null"}: ${res.stderr.slice(0, 500)}`,
    };
  }
  return { raw_output: normalizeClaudeOutput(res.stdout), error: null };
}

// ── Kill switch ────────────────────────────────────────────────────────────

export function verifyKillSwitchActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.STARK_RED_TEAM_VERIFY_KILL ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ── Orchestrator ─────────────────────────────────────────────────────────

function isHumanReview(f: RedTeamFinding): boolean {
  return f.counter_proposal === "REQUEST_HUMAN_REVIEW";
}

/**
 * Run the refutation pass over a set of findings. Human-review findings are
 * never refuted (they represent honest uncertainty that halts for a human, not
 * a claim to challenge). Refuter errors leave the finding untouched (fail-safe
 * — a refuter that can't run must not silently drop a real finding).
 *
 * Returns the surviving/recalibrated findings + a summary + a per-finding
 * audit trail. Order is preserved for the survivors.
 */
export async function refuteFindings(args: {
  findings: readonly RedTeamFinding[];
  artifact: string;
  sourceSpec: string;
  cfg: VerifyConfig;
  /** Test seam: overrides the real Claude dispatch. */
  refuteFn?: RefuteFn;
}): Promise<RefuteResult> {
  const { findings, artifact, sourceSpec, cfg } = args;
  const refuteFn: RefuteFn =
    args.refuteFn ??
    ((prompt, model) => dispatchRefuter(prompt, model, cfg.timeout_s * 1000));
  const votes = Math.max(1, Math.floor(cfg.votes || 1));

  const out: RedTeamFinding[] = [];
  const trail: RefuteResult["trail"] = [];
  const summary: RefuteSummary = {
    total: findings.length,
    upheld: 0,
    downgraded: 0,
    dropped: 0,
    skipped: 0,
    errors: 0,
  };

  for (const finding of findings) {
    // Never refute honest-uncertainty halts.
    if (isHumanReview(finding)) {
      out.push(finding);
      summary.skipped++;
      trail.push({
        id: finding.id,
        action: "skipped",
        original_severity: finding.severity,
        final_severity: finding.severity,
        verdicts: [],
      });
      continue;
    }

    const lens = lensForFinding(finding);
    const prompt = buildRefuterPrompt({
      finding,
      artifact,
      sourceSpec,
      lens,
      maxInputChars: cfg.max_input_chars,
    });

    const verdicts: RefutationVerdict[] = [];
    let errored = false;
    for (let i = 0; i < votes; i++) {
      let raw: { raw_output: string; error: string | null };
      try {
        raw = await refuteFn(prompt, cfg.model);
      } catch (err) {
        raw = { raw_output: "", error: (err as Error).message };
      }
      if (raw.error) {
        errored = true;
        continue; // fail-safe: a failed refuter contributes no verdict
      }
      verdicts.push(parseRefutationVerdict(raw.raw_output, lens, finding.severity));
    }

    // Every refuter errored → keep the finding untouched (never drop on error).
    if (verdicts.length === 0) {
      out.push(finding);
      summary.skipped++;
      if (errored) summary.errors++;
      trail.push({
        id: finding.id,
        action: "skipped",
        original_severity: finding.severity,
        final_severity: finding.severity,
        verdicts,
      });
      continue;
    }

    const decision = aggregateVerdicts(verdicts, finding.severity);
    const { finding: kept, action } = applyDecision(finding, decision);
    if (action === "dropped") summary.dropped++;
    else if (action === "downgraded") summary.downgraded++;
    else summary.upheld++;
    if (errored) summary.errors++;
    if (kept) out.push(kept);
    trail.push({
      id: finding.id,
      action,
      original_severity: finding.severity,
      final_severity: kept ? kept.severity : null,
      verdicts,
    });
  }

  return { findings: out, summary, trail };
}
