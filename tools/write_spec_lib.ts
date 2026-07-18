/**
 * write_spec_lib.ts — SECTION_IDS parser + contract verdict extractor.
 *
 * The structural bound the /stark-write-spec design rests on: a closed-enum
 * verdict over a fixed, host-owned id set. Because the wing may only speak in
 * terms of SECTION_IDS, the loop cannot grow the spec's sections, and the host
 * never trusts the wing's `done` — it recomputes it over the full id set.
 *
 * `extractContractVerdictJson` is deliberately distinct from copilot's
 * `extractVerdictJson`: a contract verdict has `items`/`done`/`summary` and NO
 * `verdict` key, so the two must never grab each other's objects. Both share
 * the `collectJsonCandidates` scan (copilot_dispatch.ts) to avoid drift.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAgentEnv,
  buildClaudeCmd,
  buildCodexCmd,
  collectJsonCandidates,
  isPlainObject,
  parseCodexJsonl,
  releaseAgentTempDir,
  run,
} from "./copilot_dispatch.ts";
import {
  CODEX_REASONING_EFFORT_HIGH,
  CODEX_REASONING_EFFORT_MEDIUM,
  CODEX_REASONING_EFFORT_XHIGH,
} from "./codex_utils_lib.ts";
import { assetPromptsDir, stateRoot } from "./asset_root_lib.ts";
import { DEFAULT_WRITE_SPEC, getModelId, getWriteSpecConfig } from "./stark_config_lib.ts";
import { computeDispatchCost } from "./cost_lib.ts";
import { writeJsonAtomic } from "./stark_review_doc_lib.ts";

/**
 * The sole runtime authority for spec section ids. A host typed literal — the
 * contract asset (global/prompts/write-spec/contract.md) mirrors these, but a
 * 10th asset id is dropped at runtime until this literal is deliberately edited.
 */
export const SECTION_IDS = [
  "intent",
  "scope",
  "interfaces",
  "behavior",
  "ssot",
  "security",
  "test-plan",
  "accessibility",
  "open-questions",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/**
 * Per-section coverage status. `done` requires every section satisfied or a
 * reasoned `n_a`. `over_scoped` (the #677 bidirectional-gate lesson — the wing
 * asking to cut excessive scope) is a valid revise signal that blocks `done`
 * just like `underspecified`/`missing`.
 */
export const STATUS_VALUES = [
  "satisfied",
  "underspecified",
  "n_a",
  "missing",
  "over_scoped",
] as const;

export type Status = (typeof STATUS_VALUES)[number];

export interface ContractItem {
  section: SectionId;
  status: Status;
  note: string;
}

export interface ContractVerdict {
  items: ContractItem[];
  done: boolean;
  summary: string;
}

export interface NormalizedContractVerdict {
  verdict: ContractVerdict;
  droppedSections: string[];
}

const SECTION_ID_SET: ReadonlySet<string> = new Set(SECTION_IDS);
const STATUS_SET: ReadonlySet<string> = new Set(STATUS_VALUES);

function isSectionId(v: unknown): v is SectionId {
  return typeof v === "string" && SECTION_ID_SET.has(v);
}

/**
 * A section is satisfied for `done` purposes when it is `satisfied` or a
 * reasoned `n_a`. `underspecified`/`missing` (and reason-less `n_a`, which is
 * downgraded to `underspecified` upstream) all block.
 */
function statusCounts(status: Status): boolean {
  return status === "satisfied" || status === "n_a";
}

/**
 * Host-side `done` recomputation over the FULL SECTION_IDS set. Never trusts
 * the wing's `done`: every known section must be present and satisfied/n_a.
 */
export function computeDone(items: ContractItem[]): boolean {
  const bySection = new Map<string, ContractItem>();
  for (const it of items) bySection.set(it.section, it);
  for (const id of SECTION_IDS) {
    const it = bySection.get(id);
    if (!it || !statusCounts(it.status)) return false;
  }
  return true;
}

/**
 * Extract the LAST JSON candidate that parses to a contract-shaped verdict:
 * a plain object with an `items` array AND a `done` key. Deliberately rejects
 * copilot verdict objects (`{verdict: ...}`) — they have no `items`/`done`.
 * Returns the raw parsed object (pre-normalization) or null.
 */
export function extractContractVerdictJson(
  text: string,
): Record<string, unknown> | null {
  const candidates = collectJsonCandidates(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!);
      if (isPlainObject(obj) && Array.isArray(obj["items"]) && "done" in obj) {
        return obj;
      }
    } catch { /* skip */ }
  }
  return null;
}

function coerceString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize a raw parsed contract verdict into a trusted ContractVerdict.
 *
 * - Drops items whose `section` is not in SECTION_IDS (recorded in the
 *   camelCase `droppedSections` return field).
 * - Coerces unknown `status` to `underspecified`.
 * - Downgrades reason-less `n_a` to `underspecified` (an unexplained
 *   not-applicable is not trustworthy coverage).
 * - Synthesizes a `missing` item for any absent known id.
 * - Recomputes `done` host-side over the full SECTION_IDS set via computeDone
 *   (never trusting the wing's `done`).
 *
 * The public field name is `droppedSections` everywhere — snake_case
 * `dropped_sections` is NOT used.
 */
export function normalizeContractVerdict(
  raw: unknown,
): NormalizedContractVerdict {
  const droppedSections: string[] = [];
  const bySection = new Map<SectionId, ContractItem>();

  const rawItems =
    isPlainObject(raw) && Array.isArray(raw["items"]) ? raw["items"] : [];

  for (const entry of rawItems) {
    if (!isPlainObject(entry)) continue;
    const section = entry["section"];
    if (!isSectionId(section)) {
      if (typeof section === "string" && section.length > 0) {
        droppedSections.push(section);
      }
      continue;
    }
    let status: Status = STATUS_SET.has(entry["status"] as string)
      ? (entry["status"] as Status)
      : "underspecified";
    const note = coerceString(entry["note"]);
    // Reason-less n_a is not trustworthy coverage → downgrade to underspecified.
    if (status === "n_a" && note.trim().length === 0) {
      status = "underspecified";
    }
    // First occurrence of a known section wins; ignore later duplicates.
    if (!bySection.has(section)) {
      bySection.set(section, { section, status, note });
    }
  }

  // Synthesize a `missing` item for any absent known id.
  for (const id of SECTION_IDS) {
    if (!bySection.has(id)) {
      bySection.set(id, { section: id, status: "missing", note: "" });
    }
  }

  // Emit items in canonical SECTION_IDS order.
  const items: ContractItem[] = SECTION_IDS.map((id) => bySection.get(id)!);
  const summary = isPlainObject(raw) ? coerceString(raw["summary"]) : "";

  return {
    verdict: { items, done: computeDone(items), summary },
    droppedSections,
  };
}

// ── Dispatch primitives (#699) ───────────────────────────────────────────
//
// The deterministic, individually-testable building blocks the lead/wing
// loop composes: the slug contract, the command boundary (least-privilege
// no-tools for claude, read-only for codex), the claude JSON envelope parse,
// and in-band contract delivery. Kept apart from the state machine so each
// surface is provable on its own.

/**
 * Derive the spec slug from the `--out` path ALONE. The basename must match
 * `docs/specs/YYYY-MM-DD-<slug>-spec.md`; the `<slug>` capture is returned.
 *
 * There is deliberately NO `--slug` flag — the slug is a pure function of the
 * out path, so a caller can never desync the filename from the slug. A
 * non-conforming path throws rather than guessing.
 */
export function deriveSlugFromOut(outPath: string): string {
  const base = path.basename(outPath);
  const m = /^\d{4}-\d{2}-\d{2}-(?<slug>.+)-spec\.md$/.exec(base);
  if (!m || !m.groups?.slug) {
    throw new Error(
      `out path must match docs/specs/YYYY-MM-DD-<slug>-spec.md; got ${base}`,
    );
  }
  return m.groups.slug;
}

/**
 * Tools every write-spec agent is forbidden from using. Copied VERBATIM from
 * `red_team_fold_lib.ts::DECIDER_DISALLOWED_TOOLS` (the fold decider's
 * disallowedTools) — the write-spec lead/wing only emit spec text + JSON
 * verdicts over an in-band contract, so they need zero tools. Disabling the
 * mutating/exfil primitives means even a jailbroken model has no Bash/Write/
 * WebFetch primitive to run a command, touch the filesystem, or make a
 * network call from inside the subprocess.
 *
 * Keep in sync with `red_team_fold_lib.ts::DECIDER_DISALLOWED_TOOLS` (copied
 * verbatim to avoid coupling this module to the fold subsystem's audit/git/DB
 * transitive deps).
 */
export const NO_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
] as const;

/** Which write-spec agent a command is being built for. */
export type WriteSpecAgent = "claude" | "codex";

/** A resolved subprocess argv. */
export interface AgentCommand {
  cmd: string;
  args: string[];
}

/**
 * The per-agent model flag. This is command-surface knowledge the lib owns
 * (claude pins via `--model`, codex via `-m`); the CLI passes a model id as
 * DATA and never reaches into the produced argv itself.
 */
function modelFlagFor(agent: WriteSpecAgent): string {
  return agent === "codex" ? "-m" : "--model";
}

/**
 * Pin `model` into a freshly-built agent argv by replacing the value after the
 * agent's model flag (appending the flag if the base builder didn't emit it).
 * Mutates + returns `args`. Used only by the lib's own builders, so no external
 * caller depends on argv ordering.
 */
function pinModelFlag(agent: WriteSpecAgent, args: string[], model: string): string[] {
  const flag = modelFlagFor(agent);
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    args[idx + 1] = model;
  } else {
    args.push(flag, model);
  }
  return args;
}

/**
 * Claude argv: the shared headless-Claude command (`buildClaudeCmd`,
 * `--output-format json`) with NO tools grantable (empty `allowedTools`, so
 * `--allowedTools` is never emitted) plus `--disallowedTools <NO_TOOLS...>`
 * appended at the END (mirrors `red_team_fold_lib.ts::buildDeciderCommand`).
 */
function claudeAgentCmd(model?: string): AgentCommand {
  const built = buildClaudeCmd({ outputFormat: "json", allowedTools: "" });
  const args = [...built.args, "--disallowedTools", ...NO_TOOLS];
  if (model) pinModelFlag("claude", args, model);
  return { cmd: built.cmd, args };
}

/** Reasoning-effort levels a write-spec codex agent may run at. */
export type CodexEffort = "medium" | "high" | "xhigh";

/**
 * Map a config effort string to the canonical `-c model_reasoning_effort="…"`
 * flag string owned by `codex_utils_lib.ts` (never re-derived inline). Unknown
 * values fall back to `xhigh` (the adversarial-pass default).
 */
function codexReasoningEffort(effort: string): string {
  switch (effort) {
    case "medium":
      return CODEX_REASONING_EFFORT_MEDIUM;
    case "high":
      return CODEX_REASONING_EFFORT_HIGH;
    case "xhigh":
    default:
      return CODEX_REASONING_EFFORT_XHIGH;
  }
}

/**
 * Codex argv: consumes `copilot_dispatch.ts::buildCodexCmd` (the SOLE owner of
 * the `codex exec` command surface) for the read-only cmd/base args, overriding
 * the reasoning effort with the resolved `-c` flag from `codex_utils_lib.ts`.
 */
function codexAgentCmd(effort: string, model?: string): AgentCommand {
  const built = buildCodexCmd({
    readOnly: true,
    reasoningEffort: codexReasoningEffort(effort),
  });
  const args = built.args;
  if (model) pinModelFlag("codex", args, model);
  return { cmd: built.cmd, args };
}

/**
 * Build the LEAD (spec author) command for `agent`. Claude runs no-tools;
 * codex runs read-only at `high` effort. An optional `model` id is pinned into
 * the argv via the agent's model flag (the `--lead-model` CLI override, passed
 * as data — never post-hoc argv surgery).
 */
export function buildLeadCmd(agent: WriteSpecAgent, model?: string): AgentCommand {
  return agent === "codex" ? codexAgentCmd("high", model) : claudeAgentCmd(model);
}

/**
 * Build the WING (contract verifier) command for `agent`. Claude runs
 * no-tools; codex runs read-only at the configured `effort` (default `xhigh` —
 * the adversarial pass gets the higher reasoning budget). `effort` is threaded
 * from `write_spec.wing_reasoning_effort` so the config knob is honored. An
 * optional `model` id is pinned into the argv via the agent's model flag (the
 * `--wing-model` CLI override).
 */
export function buildWingCmd(
  agent: WriteSpecAgent,
  effort: string = "xhigh",
  model?: string,
): AgentCommand {
  return agent === "codex" ? codexAgentCmd(effort, model) : claudeAgentCmd(model);
}

/** The text + token usage unwrapped from a claude `--output-format json` run. */
export interface ClaudeEnvelope {
  text: string;
  usage: Record<string, unknown> | null;
}

/**
 * Parse claude's `--output-format json` stdout envelope
 * (`{"result": "...", "usage": {...}}`) into `{text, usage}`. On any parse
 * failure the raw stdout is returned verbatim as `text` with `usage: null`,
 * so a non-JSON reply (or a plain-text CLI) still surfaces its content.
 */
export function parseClaudeJson(raw: string): ClaudeEnvelope {
  try {
    const obj = JSON.parse(raw);
    if (isPlainObject(obj)) {
      const result = obj["result"];
      const usage = obj["usage"];
      return {
        text: typeof result === "string" ? result : "",
        usage: isPlainObject(usage) ? usage : null,
      };
    }
  } catch {
    /* not JSON — fall through to raw passthrough */
  }
  return { text: raw, usage: null };
}

// ── Per-agent token accounting + cost aggregation (#703) ─────────────────
//
// Cost visibility is a first-class receipt field: every invocation (each lead
// draft/revise, each wing verify, and each parse-retry re-dispatch) records the
// tokens it burned and its dollar cost. Usage is read from each agent's NATIVE
// stdout shape. A missing usage field degrades to a {0,0} floor plus a
// `cost_notes[]` entry — the loop must NEVER crash because an agent omitted a
// token count.

/** Token counts extracted from one agent invocation's raw stdout. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** False when no usage field was present (→ {0,0} floor + a cost note). */
  available: boolean;
}

/** One row per invocation in the receipt's `cost_breakdown`. */
export interface CostBreakdownRow {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost_usd: number;
}

/** One entry per invocation whose usage was unavailable. */
export interface CostNote {
  invocation: string;
  reason: string;
}

const USAGE_UNAVAILABLE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  available: false,
};

/** Read a finite numeric field from a plain object, else null. */
function numField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pull cumulative input/output tokens out of ONE codex `token_count` event.
 * Codex nests the running totals under `info.total_token_usage` (newer CLI);
 * older shapes put them directly on `info` or the event itself. Returns null
 * when neither token field is present.
 */
function usageFromCodexEvent(
  ev: Record<string, unknown>,
): { input: number; output: number } | null {
  const info = isPlainObject(ev["info"]) ? ev["info"] : ev;
  const usage = isPlainObject(info["total_token_usage"])
    ? info["total_token_usage"]
    : info;
  const i = numField(usage, "input_tokens");
  const o = numField(usage, "output_tokens");
  if (i === null && o === null) return null;
  return { input: i ?? 0, output: o ?? 0 };
}

/**
 * Extract token usage for one agent invocation from its RAW stdout.
 *
 * - `claude` — `parseClaudeJson(raw).usage` (`input_tokens`/`output_tokens`).
 *   A `null` usage (text-fallback path) yields the unavailable floor.
 * - `codex` — the JSONL `token_count` events are CUMULATIVE. Take the totals
 *   from the FINAL `token_count` event; NEVER sum across events (summing
 *   cumulative snapshots overcounts).
 * - `gemini` — generic `usageMetadata.promptTokenCount`/`candidatesTokenCount`.
 *
 * Any absent usage → `{0,0}` with `available: false`. Never throws.
 */
export function extractAgentUsage(
  agent: WriteSpecAgent | string,
  rawOutput: string,
): AgentUsage {
  if (agent === "claude") {
    const env = parseClaudeJson(rawOutput);
    if (env.usage) {
      const i = numField(env.usage, "input_tokens");
      const o = numField(env.usage, "output_tokens");
      if (i !== null || o !== null) {
        return { inputTokens: i ?? 0, outputTokens: o ?? 0, available: true };
      }
    }
    return USAGE_UNAVAILABLE;
  }

  if (agent === "codex") {
    // Walk every line; the LAST token_count event holds the cumulative totals.
    let last: { input: number; output: number } | null = null;
    for (const line of rawOutput.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      if (!isPlainObject(ev) || ev["type"] !== "token_count") continue;
      const u = usageFromCodexEvent(ev);
      if (u) last = u; // final event wins — never accumulate
    }
    if (last) {
      return { inputTokens: last.input, outputTokens: last.output, available: true };
    }
    return USAGE_UNAVAILABLE;
  }

  if (agent === "gemini") {
    try {
      const obj = JSON.parse(rawOutput);
      const source = Array.isArray(obj) ? obj[obj.length - 1] : obj;
      if (isPlainObject(source) && isPlainObject(source["usageMetadata"])) {
        const um = source["usageMetadata"];
        const i = numField(um, "promptTokenCount");
        const o = numField(um, "candidatesTokenCount");
        if (i !== null || o !== null) {
          return { inputTokens: i ?? 0, outputTokens: o ?? 0, available: true };
        }
      }
    } catch {
      /* not JSON — fall through to the unavailable floor */
    }
    return USAGE_UNAVAILABLE;
  }

  return USAGE_UNAVAILABLE;
}

/** Header the contract is prepended under, so every agent sees it in-band. */
export const CONTRACT_HEADER =
  "## Spec Contract (authoritative — the 9 sections and their done-when bars)";

/**
 * Read + validate the spec contract asset ONCE, from
 * `<assetPromptsDir>/write-spec/contract.md`. This is the SOLE file reader in
 * this module — `composePrompt` is pure and takes the returned text as an
 * argument. Throws if the file is missing or empty (an agent with no file
 * tools must receive the contract in-band; a silent empty contract would let
 * the loop run with no done-when bars).
 */
export function loadContractText(): string {
  const p = path.join(assetPromptsDir(), "write-spec", "contract.md");
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`spec contract not found at ${p}: ${(e as Error).message}`);
  }
  if (text.trim().length === 0) {
    throw new Error(`spec contract at ${p} is empty`);
  }
  return text;
}

/**
 * Compose the full prompt sent to a write-spec agent. PURE — no file IO; the
 * caller passes `contractText` (from `loadContractText`, read once at dispatch
 * start). The authoritative contract is prepended under `CONTRACT_HEADER`, so
 * every generate/verify/revise request carries the 9 sections + done-when bars
 * in-band (the agents have no file tools to fetch them), followed by the
 * per-agent template and the concrete brief.
 */
export function composePrompt(
  agentPromptText: string,
  contractText: string,
  briefText: string,
): string {
  return [
    CONTRACT_HEADER,
    "",
    contractText.trimEnd(),
    "",
    agentPromptText.trimEnd(),
    "",
    briefText.trimEnd(),
  ].join("\n");
}

// ── Intent-brief assembly + source-material truncation (#702) ────────────
//
// The composed prompt must stay under the model input budget
// (`write_spec.max_input_chars`) without ever dropping the operator's actual
// ask. Only bulk SOURCE MATERIAL is trimmed — the Ask / Constraints / Target
// sections are preserved VERBATIM, and a visible marker is appended iff any
// source content was actually cut. `assembleBriefForDispatch` is PURE.

/**
 * The exact marker appended when (and only when) source material was truncated.
 * A downstream agent seeing this knows bulk context was cut — while the Ask /
 * Constraints / Target it must honor are still present verbatim.
 */
export const TRUNCATION_MARKER =
  "\n\n<!-- TRUNCATED: source material exceeded max_input_chars -->";

/**
 * Heading words that mark a section as protected (never truncated). Matched
 * case-insensitively against the leading word of an ATX heading's text.
 */
const PROTECTED_HEADINGS = /^(ask|constraints|target)\b/i;

interface BriefSection {
  text: string;
  isProtected: boolean;
}

/**
 * Split a brief into sections at ATX-heading (`#`..`######`) boundaries,
 * keeping each heading with the body that follows it (and any preamble before
 * the first heading as an unprotected leading section). A section is protected
 * when its heading's leading word is Ask / Constraints / Target.
 */
function splitBriefSections(briefText: string): BriefSection[] {
  const parts = briefText.split(/(?=^#{1,6}[ \t]+)/m);
  const sections: BriefSection[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    const m = /^(#{1,6})[ \t]+(.*)$/m.exec(part.split("\n", 1)[0] ?? "");
    const headingText = m ? m[2]!.trim() : "";
    sections.push({ text: part, isProtected: PROTECTED_HEADINGS.test(headingText) });
  }
  return sections;
}

/**
 * Assemble the intent brief for dispatch, enforcing the `cap`
 * (`write_spec.max_input_chars`) input budget.
 *
 * - Under cap → returned VERBATIM (passthrough, no marker).
 * - Over cap → only SOURCE MATERIAL (non Ask/Constraints/Target sections) is
 *   truncated, in document order, until the result fits within `cap`; the
 *   Ask / Constraints / Target sections are kept verbatim in place, and
 *   {@link TRUNCATION_MARKER} is appended.
 *
 * Invariants: the marker is present iff truncation actually occurred, and the
 * result never exceeds `cap` — except the pathological case where the protected
 * sections alone exceed `cap` (they are never truncated, so they still win).
 */
export function assembleBriefForDispatch(briefText: string, cap: number): string {
  if (briefText.length <= cap) return briefText;

  const sections = splitBriefSections(briefText);
  const protectedTotal = sections
    .filter((s) => s.isProtected)
    .reduce((n, s) => n + s.text.length, 0);

  // Budget for source material after reserving protected text + the marker.
  const sourceBudget = Math.max(0, cap - protectedTotal - TRUNCATION_MARKER.length);

  let remaining = sourceBudget;
  let truncated = false;
  const out: string[] = [];
  for (const s of sections) {
    if (s.isProtected) {
      out.push(s.text);
      continue;
    }
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    if (s.text.length <= remaining) {
      out.push(s.text);
      remaining -= s.text.length;
    } else {
      out.push(s.text.slice(0, remaining));
      remaining = 0;
      truncated = true;
    }
  }

  let result = out.join("");
  if (truncated) result += TRUNCATION_MARKER;
  return result;
}

// ── The lead/wing loop + durable exit writer (#700) ──────────────────────
//
// The bounded round 1..N state machine: the lead drafts (round 1) or revises
// (rounds 2+), the wing verifies the draft into a ContractVerdict, and the
// host early-exits on a host-recomputed `done`. Every non-crash return writes
// the spec (--out) + receipt.json to disk — those two writes are FATAL. The
// loop is bounded by max_rounds and short-circuits on three terminal failure
// modes (empty draft, byte-identical revision, unparseable wing verdict) so it
// can never spin.

/** Which write-spec agent role a prompt template drives. */
export type WriteSpecRole = "generate" | "verify" | "revise";

/**
 * The closed set of terminal outcomes. `contract_satisfied` is the ONLY
 * success; the other four are bounded-loop breakers that each map to a
 * distinct `error.code`.
 */
export type FinalVerdict =
  | "contract_satisfied"
  | "max_rounds_unsatisfied"
  | "lead_empty_draft"
  | "unchanged_revision"
  | "wing_unparseable";

/**
 * The durable run record. `contract_status` is the FINAL normalized
 * nine-section {section,status,note} array (every SECTION_IDS id present) that
 * Tasks 5-2/5-3 read to build the PR table, select unsatisfied items, mutate
 * Open Questions, and emit accepted_gaps.
 */
export interface WriteSpecReceipt {
  ok: boolean;
  final_verdict: FinalVerdict;
  slug: string;
  spec_path: string;
  run_dir: string;
  rounds: number;
  lead_agent: string;
  wing_agent: string;
  contract_status: ContractItem[];
  dropped_sections: string[];
  summary: string;
  /** Total USD across EVERY invocation (lead + wing + parse-retries). */
  cost_usd: number;
  /** One row per invocation, in invocation order. */
  cost_breakdown: CostBreakdownRow[];
  /** One entry per invocation whose usage was unavailable (floored to {0,0}). */
  cost_notes: CostNote[];
  error?: { code: string; message: string };
}

/** Options for a single write-spec run. */
export interface RunWriteSpecOpts {
  /** Destination spec path — `docs/specs/YYYY-MM-DD-<slug>-spec.md`. */
  out: string;
  /** The concrete brief / intent the spec must satisfy. */
  brief: string;
  leadAgent?: WriteSpecAgent;
  wingAgent?: WriteSpecAgent;
  maxRounds?: number;
  /** Override the lead model id (`--lead-model`). Passed as data to the builder. */
  leadModel?: string | null;
  /** Override the wing model id (`--wing-model`). Passed as data to the builder. */
  wingModel?: string | null;
  /** Override the lead dispatch timeout in seconds (`--timeout`). */
  leadTimeoutS?: number | null;
  /** Override the wing dispatch timeout in seconds (`--wing-timeout`). */
  wingTimeoutS?: number | null;
  /** Override the slug-derived run dir (tests point this at a temp tree). */
  runDir?: string;
}

/** The config-resolved default knobs, read once. The SOLE home for the
 * write-spec fallback literals — the CLI and the loop both consume these so a
 * dry-run's printed numbers can never diverge from what a real run uses. */
export interface WriteSpecDefaults {
  maxRounds: number;
  leadTimeoutS: number;
  wingTimeoutS: number;
  wingEffort: string;
  inputCap: number;
}

/** Resolve the write-spec defaults from config (with the built-in fallbacks). */
export function resolveWriteSpecDefaults(): WriteSpecDefaults {
  const cfg = getWriteSpecConfig();
  return {
    maxRounds: Number(cfg.max_rounds) || DEFAULT_WRITE_SPEC.max_rounds,
    leadTimeoutS: Number(cfg.timeout_s) || DEFAULT_WRITE_SPEC.timeout_s,
    wingTimeoutS: Number(cfg.wing_timeout_s) || DEFAULT_WRITE_SPEC.wing_timeout_s,
    wingEffort: String(cfg.wing_reasoning_effort || DEFAULT_WRITE_SPEC.wing_reasoning_effort),
    inputCap: Number(cfg.max_input_chars) || DEFAULT_WRITE_SPEC.max_input_chars,
  };
}

/**
 * Injectable seam so the loop is testable without real LLM calls. Each field
 * defaults to a real implementation via {@link defaultWriteSpecDeps}; tests
 * pass mocks for the dispatch + write surfaces.
 */
/**
 * A dispatch return. A bare string is the parsed text (usage then reads over
 * that same string — typically unavailable, as with test mocks). The rich form
 * carries both the parsed `text` and the untouched `raw` stdout so token usage
 * can be extracted from the agent's native envelope.
 */
export type AgentDispatchResult = string | { text: string; raw: string };

export interface WriteSpecDeps {
  loadContract: () => string;
  loadAgentPrompt: (agent: WriteSpecAgent, role: WriteSpecRole) => string;
  /** Lead authoring dispatch — returns the raw spec draft text (or {text,raw}). */
  dispatchLead: (
    ctx: { round: number; prompt: string },
  ) => Promise<AgentDispatchResult>;
  /** Wing verify dispatch — returns the verdict text (or {text,raw}). */
  dispatchWing: (
    ctx: { round: number; attempt: number; prompt: string },
  ) => Promise<AgentDispatchResult>;
  /** FATAL spec + receipt writer (never swallow a failure). */
  writeArtifacts: (
    runDir: string,
    specText: string,
    receipt: WriteSpecReceipt,
  ) => void;
}

/** An all-`missing` nine-id array — the fail-closed contract_status floor. */
function allMissingItems(): ContractItem[] {
  return SECTION_IDS.map((id) => ({ section: id, status: "missing", note: "" }));
}

/** The reminder appended to the wing's ONE retry after a malformed verdict. */
const WING_FORMAT_REMINDER =
  "\n\n---\nYour previous reply did not contain a parseable ContractVerdict. " +
  "Reply with EXACTLY ONE fenced ```json block whose object has `items` " +
  "(an array of {section,status,note}), `done`, and `summary` — nothing else.";

/**
 * Read a per-agent role template from
 * `<assetPromptsDir>/write-spec/<agent>/<role>.md`.
 */
export function loadAgentPromptText(
  agent: WriteSpecAgent,
  role: WriteSpecRole,
): string {
  const p = path.join(assetPromptsDir(), "write-spec", agent, `${role}.md`);
  return readFileSync(p, "utf8");
}

/** Atomic text write (tmp + rename in the same dir). */
function writeTextAtomic(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}`,
  );
  writeFileSync(tmp, text);
  renameSync(tmp, filePath);
}

/**
 * FATAL exit writer: writes the spec to `receipt.spec_path` and `receipt.json`
 * to `runDir`, both atomically. Called on EVERY non-crash return. If either
 * write throws, the caller must NOT swallow it — a verdict reported without the
 * spec on disk is a lie.
 */
export function writeExitArtifacts(
  runDir: string,
  specText: string,
  receipt: WriteSpecReceipt,
): void {
  mkdirSync(runDir, { recursive: true });
  writeTextAtomic(receipt.spec_path, specText);
  writeJsonAtomic(path.join(runDir, "receipt.json"), receipt);
}

/** Build the concrete-brief text a revise round hands the lead. */
function buildReviseBrief(priorDraft: string, unsatisfied: ContractItem[]): string {
  const lines = unsatisfied.map(
    (it) => `- [${it.status}] ${it.section}: ${it.note || "(no note)"}`,
  );
  return [
    "Revise the spec draft below. Address ONLY these non-satisfied contract",
    "items — do not re-open or rewrite already-satisfied sections:",
    "",
    ...lines,
    "",
    "--- CURRENT DRAFT ---",
    priorDraft,
  ].join("\n");
}

/** Build the concrete-brief text the wing verifies against. */
function buildVerifyBrief(draft: string): string {
  return [
    "Verify the spec draft below against the authoritative contract. Emit a",
    "ContractVerdict JSON (items/done/summary) covering every contract section.",
    "",
    "--- DRAFT UNDER REVIEW ---",
    draft,
  ].join("\n");
}

/** Per-run overrides the CLI threads through as DATA (never argv surgery). */
export interface WriteSpecDispatchOverrides {
  leadModel?: string | null;
  wingModel?: string | null;
  leadTimeoutS?: number | null;
  wingTimeoutS?: number | null;
}

/** The real dispatch + write dependencies. Model/timeout overrides are passed
 * as data and threaded into the lib's own argv builders + `run` timeouts. */
export function defaultWriteSpecDeps(
  leadAgent: WriteSpecAgent,
  wingAgent: WriteSpecAgent,
  overrides: WriteSpecDispatchOverrides = {},
): WriteSpecDeps {
  const defaults = resolveWriteSpecDefaults();
  const leadTimeout = overrides.leadTimeoutS ?? defaults.leadTimeoutS;
  const wingTimeout = overrides.wingTimeoutS ?? defaults.wingTimeoutS;
  const leadCmd = buildLeadCmd(leadAgent, overrides.leadModel ?? undefined);
  const wingCmd = buildWingCmd(
    wingAgent,
    defaults.wingEffort,
    overrides.wingModel ?? undefined,
  );

  async function dispatch(
    agent: WriteSpecAgent,
    cmd: AgentCommand,
    prompt: string,
    timeoutSec: number,
  ): Promise<{ text: string; raw: string }> {
    const { env, tempDir } = await buildAgentEnv(agent, "local");
    try {
      const res = await run(cmd.cmd, cmd.args, {
        env,
        stdin: prompt,
        timeoutSec,
      });
      if (res.notFound) {
        throw new Error(`write-spec: ${agent} CLI not found (${cmd.cmd})`);
      }
      if (res.code !== 0) {
        throw new Error(
          `write-spec: ${agent} exited ${res.code}: ${res.stderr.slice(0, 400)}`,
        );
      }
      // Return BOTH the parsed text and the untouched stdout so the loop can
      // read native token usage off the raw envelope.
      const raw = res.stdout;
      const text =
        agent === "codex" ? parseCodexJsonl(raw) : parseClaudeJson(raw).text;
      return { text, raw };
    } finally {
      releaseAgentTempDir(tempDir);
    }
  }

  return {
    loadContract: loadContractText,
    loadAgentPrompt: loadAgentPromptText,
    dispatchLead: ({ prompt }) => dispatch(leadAgent, leadCmd, prompt, leadTimeout),
    dispatchWing: ({ prompt }) => dispatch(wingAgent, wingCmd, prompt, wingTimeout),
    writeArtifacts: writeExitArtifacts,
  };
}

/**
 * Run the bounded lead/wing write-spec loop. Loads the contract ONCE, then for
 * each round the lead drafts/revises and the wing verifies into a
 * host-recomputed ContractVerdict. Early-exits on `done`; otherwise revises
 * with only the non-satisfied items. Terminates on empty draft, byte-identical
 * revision, unparseable wing verdict (after ONE retry), or max_rounds. Writes
 * the spec + receipt.json on EVERY non-crash return (FATAL writes).
 *
 * `ok === (final_verdict === 'contract_satisfied')`.
 */
export async function runWriteSpec(
  opts: RunWriteSpecOpts,
  deps?: Partial<WriteSpecDeps>,
): Promise<WriteSpecReceipt> {
  const leadAgent: WriteSpecAgent = opts.leadAgent ?? (DEFAULT_WRITE_SPEC.lead_agent as WriteSpecAgent);
  const wingAgent: WriteSpecAgent = opts.wingAgent ?? (DEFAULT_WRITE_SPEC.wing_agent as WriteSpecAgent);
  const defaults = resolveWriteSpecDefaults();
  const maxRounds = Math.max(1, opts.maxRounds ?? defaults.maxRounds);
  // Enforce the input budget on the operator's intent brief up front: only
  // source material is trimmed; Ask/Constraints/Target survive verbatim.
  const assembledBrief = assembleBriefForDispatch(opts.brief, defaults.inputCap);

  const d: WriteSpecDeps = {
    ...defaultWriteSpecDeps(leadAgent, wingAgent, {
      leadModel: opts.leadModel,
      wingModel: opts.wingModel,
      leadTimeoutS: opts.leadTimeoutS,
      wingTimeoutS: opts.wingTimeoutS,
    }),
    ...deps,
  };

  const slug = deriveSlugFromOut(opts.out);
  const runDir =
    opts.runDir ?? path.join(stateRoot(), "write-spec", "history", slug);
  const contractText = d.loadContract();

  // Per-role model ids (override → configured → agent name floor) drive the
  // cost math; an unknown model falls back to the `_fallback` rate.
  const leadModel = opts.leadModel ?? getModelId(leadAgent) ?? leadAgent;
  const wingModel = opts.wingModel ?? getModelId(wingAgent) ?? wingAgent;

  // Cost accounting accumulators — one breakdown row per invocation.
  const costBreakdown: CostBreakdownRow[] = [];
  const costNotes: CostNote[] = [];
  let costUsd = 0;

  /** Record one invocation's usage + cost; return its parsed text. */
  function recordInvocation(
    result: AgentDispatchResult,
    agent: WriteSpecAgent,
    model: string,
    invocation: string,
  ): string {
    const { text, raw } =
      typeof result === "string" ? { text: result, raw: result } : result;
    const usage = extractAgentUsage(agent, raw);
    if (!usage.available) {
      costNotes.push({ invocation, reason: "usage_unavailable" });
    }
    const cost = computeDispatchCost(model, usage.inputTokens, usage.outputTokens);
    costUsd += cost;
    costBreakdown.push({
      agent,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost_usd: cost,
    });
    return text;
  }

  let priorDraft: string | null = null;
  let specText = "";
  let lastGoodVerdict: ContractVerdict | null = null;
  let roundsRun = 0;
  let finalVerdict: FinalVerdict = "max_rounds_unsatisfied";

  for (let round = 1; round <= maxRounds; round++) {
    roundsRun = round;

    // ── Lead: draft (round 1) or revise (rounds 2+) ──────────────────────
    let leadBrief: string;
    let leadRole: WriteSpecRole;
    if (round === 1 || priorDraft === null) {
      leadRole = "generate";
      leadBrief = assembledBrief;
    } else {
      leadRole = "revise";
      const unsatisfied = (lastGoodVerdict?.items ?? []).filter(
        (it) => it.status !== "satisfied" && it.status !== "n_a",
      );
      leadBrief = buildReviseBrief(priorDraft, unsatisfied);
    }
    const leadPrompt = composePrompt(
      d.loadAgentPrompt(leadAgent, leadRole),
      contractText,
      leadBrief,
    );
    const leadResult = await d.dispatchLead({ round, prompt: leadPrompt });
    const draft = recordInvocation(
      leadResult,
      leadAgent,
      leadModel,
      `lead round ${round} (${leadRole})`,
    );

    if (draft.trim().length === 0) {
      // Empty draft: preserve any prior draft as the on-disk spec.
      finalVerdict = "lead_empty_draft";
      specText = priorDraft ?? "";
      break;
    }
    if (priorDraft !== null && draft === priorDraft) {
      // Byte-identical revision: the lead is stuck; break the loop.
      finalVerdict = "unchanged_revision";
      specText = draft;
      break;
    }
    specText = draft;

    // ── Wing: verify → ContractVerdict (ONE retry on malformed JSON) ─────
    const verifyTemplate = d.loadAgentPrompt(wingAgent, "verify");
    let normalized: NormalizedContractVerdict | null = null;
    for (let attempt = 1; attempt <= 2 && !normalized; attempt++) {
      const brief =
        buildVerifyBrief(draft) + (attempt === 2 ? WING_FORMAT_REMINDER : "");
      const wingPrompt = composePrompt(verifyTemplate, contractText, brief);
      const wingResult = await d.dispatchWing({ round, attempt, prompt: wingPrompt });
      const wingRaw = recordInvocation(
        wingResult,
        wingAgent,
        wingModel,
        `wing round ${round} attempt ${attempt}`,
      );
      const extracted = extractContractVerdictJson(wingRaw);
      if (extracted) {
        try {
          normalized = normalizeContractVerdict(extracted);
        } catch {
          normalized = null;
        }
      }
    }

    if (!normalized) {
      // Two malformed verdicts → terminate with the draft preserved.
      finalVerdict = "wing_unparseable";
      break;
    }

    lastGoodVerdict = normalized.verdict;
    if (normalized.verdict.done) {
      finalVerdict = "contract_satisfied";
      break;
    }

    // Non-done → carry the draft forward for a revise round.
    priorDraft = draft;
  }

  const contractStatus = lastGoodVerdict?.items ?? allMissingItems();
  const droppedSections: string[] = [];
  const ok = finalVerdict === "contract_satisfied";
  const summary = lastGoodVerdict?.summary ?? "";

  const receipt: WriteSpecReceipt = {
    ok,
    final_verdict: finalVerdict,
    slug,
    spec_path: opts.out,
    run_dir: runDir,
    rounds: roundsRun,
    lead_agent: leadAgent,
    wing_agent: wingAgent,
    contract_status: contractStatus,
    dropped_sections: droppedSections,
    summary,
    cost_usd: costUsd,
    cost_breakdown: costBreakdown,
    cost_notes: costNotes,
    ...(ok
      ? {}
      : {
          error: {
            code: finalVerdict,
            message: summary || `write-spec terminated: ${finalVerdict}`,
          },
        }),
  };

  // FATAL: never report a verdict without the spec + receipt on disk.
  d.writeArtifacts(runDir, specText, receipt);

  return receipt;
}
