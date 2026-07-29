import type { AgentName, Finding, Severity } from "./stark_review_lib.ts";
import { findingId } from "./stark_review_lib.ts";
import type { BuildContext, BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";
import { AGENT_ENV_ALLOWLIST, resolvedPath } from "./agent_env_lib.ts";
import { applyClaudeAuth } from "./claude_auth_lib.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5[1m]";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "critical", "high", "medium", "low",
]);

const KNOWN_FINDING_KEYS: ReadonlySet<string> = new Set([
  "id", "domain", "agent", "severity", "file", "line",
  "title", "body", "classification", "classification_reason", "extra",
]);

// Allowlist owner is agent_env_lib.ts — see AGENT_ENV_ALLOWLIST there for why
// USER is load-bearing. Auth is subscription-only (see claude_auth_lib.ts), so
// the CLI rides HOME's OAuth credentials and no Anthropic API key is ever
// forwarded; GH_TOKEN/GITHUB_TOKEN/STARK_PUSH_TOKEN stay excluded so the
// reviewer subprocess cannot exfiltrate posting credentials.
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.PATH = resolvedPath(env.PATH);
  applyClaudeAuth(env);
  return env;
}

/**
 * argv ceiling for the serialized schema. The binding limit is **per argv
 * string**, not the total vector: Linux caps a single argument at
 * MAX_ARG_STRLEN = 32 * PAGE_SIZE = 128 KiB no matter how large ARG_MAX is
 * (macOS is looser — ~1 MiB across the whole vector). 120 KiB stays under the
 * tighter per-string cap on every platform we dispatch from — CI runners
 * included — and fails loudly here instead of as an opaque E2BIG from spawn.
 */
const MAX_SCHEMA_BYTES = 120 * 1024;

function describeJsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Serialize a JSON Schema for `--json-schema`.
 *
 * The flag takes **inline JSON only** — passing a file path fails with
 * `--json-schema is not valid JSON` (verified against 2.1.220), so there is no
 * temp-file variant to fall back on. It also takes a JSON **object** only:
 * `null`, `false`, a string, or an array each make the CLI exit 1 before any
 * work, so those are rejected here with an attributed error rather than being
 * handed to spawn.
 */
export function serializeJsonSchema(schema: unknown): string {
  if (!isPlainObject(schema)) {
    throw new Error(
      `--json-schema: schema must be a JSON object, got ${describeJsonType(schema)} ` +
        `(the CLI rejects every other JSON value with "--json-schema must be a JSON object")`,
    );
  }
  let s: string | undefined;
  try {
    s = JSON.stringify(schema);
  } catch (err) {
    // Cyclic schemas (shared nodes reused by identity, `$ref` back-links built
    // as real references) throw here, not below — without this the caller sees a
    // bare "Converting circular structure to JSON" naming neither the flag nor
    // the argument.
    throw new Error(
      `--json-schema: schema is not JSON-serializable: ${(err as Error).message}`,
    );
  }
  if (typeof s !== "string") {
    // Reachable when a `toJSON()` on the schema returns undefined.
    throw new Error("--json-schema: schema is not JSON-serializable");
  }
  if (Buffer.byteLength(s, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(
      `--json-schema: serialized schema is ${Buffer.byteLength(s, "utf8")} bytes, ` +
        `over the ${MAX_SCHEMA_BYTES}-byte argv budget`,
    );
  }
  return s;
}

export function buildCommand(prompt: string, model?: string, ctx?: BuildContext): BuiltCommand {
  const m = model ?? CLAUDE_DEFAULT_MODEL;
  const args = [
    "-p", "-",
    "--output-format", "json",
    "--model", m,
    "--no-session-persistence",
  ];
  // Structured output: the CLI forces a conforming reply and retries the model
  // on mismatch, so the caller reads `structured_output` instead of scraping
  // JSON out of prose. See extractStructuredOutput below.
  if (ctx?.jsonSchema !== undefined) {
    args.push("--json-schema", serializeJsonSchema(ctx.jsonSchema));
  }
  return {
    cmd: "claude",
    args,
    stdin: prompt,
    env: buildEnv(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Unwrap claude `--output-format json` envelope. Claude wraps the assistant
 * response in `{"type":"result","result":"...","subtype":"success",...}`.
 * Returns the inner result text, or the input unchanged if no envelope.
 */
export function normalizeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return stdout;
  try {
    const obj = JSON.parse(trimmed);
    if (isPlainObject(obj) && typeof obj.result === "string") return obj.result;
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) {
        if (isPlainObject(item) && typeof item.result === "string") parts.push(item.result);
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch { /* fall through */ }
  return stdout;
}

/**
 * Outcome of reading a raw CLI envelope, keeping the three cases the caller
 * must tell apart distinct instead of collapsing them into one `null`:
 * absent field, failed run, present value.
 */
type EnvelopeRead =
  | { kind: "absent" }
  | { kind: "failed"; message: string }
  | { kind: "structured"; value: unknown };

function readStructuredEnvelope(rawStdout: string): EnvelopeRead {
  const trimmed = rawStdout.trim();
  if (!trimmed) return { kind: "absent" };
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return { kind: "absent" };
  }
  if (!isPlainObject(envelope)) return { kind: "absent" };
  if (envelope.is_error === true) {
    const detail = typeof envelope.result === "string" && envelope.result.length > 0
      ? envelope.result
      : typeof envelope.subtype === "string" ? envelope.subtype : "no detail in envelope";
    return { kind: "failed", message: detail };
  }
  const structured = envelope.structured_output;
  if (structured === undefined || structured === null) return { kind: "absent" };
  return { kind: "structured", value: structured };
}

/**
 * Read the pre-parsed structured reply from a `--json-schema` run.
 *
 * When the schema is supplied the CLI envelope carries a top-level
 * `structured_output` holding the reply **already parsed** — `.result` remains
 * a *string* of the same JSON, so reading `structured_output` skips a parse
 * rather than duplicating one.
 *
 * **Pass the RAW stdout**, never `normalizeOutput(stdout)`: normalizeOutput
 * unwraps the envelope down to `.result` and throws `structured_output` away, so
 * composing the two the other way round returns null on every single run.
 *
 * Returns null only when the field is genuinely absent (no schema was passed, an
 * older CLI, non-envelope stdout) — the caller's signal to fall back to tolerant
 * text extraction. Errors are reported, never swallowed: a run the CLI marked
 * `is_error` **throws**, carrying the envelope's own message, so an exhausted
 * account or a hard CLI failure cannot masquerade as "no schema was passed".
 */
export function extractStructuredOutput(rawStdout: string): unknown | null {
  const read = readStructuredEnvelope(rawStdout);
  if (read.kind === "failed") {
    throw new Error(`claude run failed: ${read.message}`);
  }
  return read.kind === "structured" ? read.value : null;
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Outcome of turning one JSON record into a Finding. */
type RecordOutcome =
  | { kind: "finding"; finding: Finding }
  | { kind: "no_findings" }
  | { kind: "skip" }
  | { kind: "error"; reason: string };

/**
 * Normalize one already-parsed JSON record into a Finding. Shared by the
 * line-oriented (prose/JSONL) path and the `--json-schema` structured path so
 * the two cannot drift in what they accept.
 */
function recordToFinding(parsed: Record<string, unknown>): RecordOutcome {
  // No-findings sentinel: explicit ack of a clean review. See agent_codex.ts.
  if (parsed.no_findings === true) return { kind: "no_findings" };
  // A finding MUST have severity and title. Records with neither are framing
  // chatter (status/reasoning/summary objects the model emits between
  // findings) — skip silently. See agent_codex.ts for the full rationale.
  if (
    !Object.prototype.hasOwnProperty.call(parsed, "severity") &&
    !Object.prototype.hasOwnProperty.call(parsed, "title")
  ) {
    return { kind: "skip" };
  }
  const severity = parsed.severity;
  if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity as Severity)) {
    return { kind: "error", reason: `invalid or missing severity (got ${JSON.stringify(severity)})` };
  }
  const title = parsed.title;
  if (typeof title !== "string" || title.length === 0) {
    return { kind: "error", reason: "missing or empty title" };
  }
  const domain = parsed.domain;
  if (typeof domain !== "string" || domain.length === 0) {
    return { kind: "error", reason: "missing or empty domain" };
  }
  const agentField = parsed.agent;
  const agent: AgentName =
    agentField === "claude" || agentField === "gemini" || agentField === "codex"
      ? (agentField as AgentName) : "claude";
  const declaredExtra = isPlainObject(parsed.extra) ? parsed.extra : {};
  const carriedExtra: Record<string, unknown> = { ...declaredExtra };
  for (const [k, v] of Object.entries(parsed)) {
    if (!KNOWN_FINDING_KEYS.has(k)) carriedExtra[k] = v;
  }
  const idField = parsed.id;
  const id = typeof idField === "string" && idField.length > 0
    ? idField : findingId(domain, agent, title);
  const finding: Finding = {
    id, domain, agent,
    severity: severity as Severity,
    file: asStringOrNull(parsed.file),
    line: asNumberOrNull(parsed.line),
    title,
    body: typeof parsed.body === "string" ? parsed.body : "",
  };
  if (typeof parsed.classification === "string") {
    finding.classification = parsed.classification as Finding["classification"];
  }
  if (typeof parsed.classification_reason === "string") {
    finding.classification_reason = parsed.classification_reason;
  }
  if (Object.keys(carriedExtra).length > 0) finding.extra = carriedExtra;
  return { kind: "finding", finding };
}

/**
 * Pull the finding records out of a schema-constrained reply. A schema forces a
 * *single* conforming value, so the JSONL one-finding-per-line protocol does not
 * apply — accept either a bare array of records or the `{ findings: [...] }`
 * wrapper a top-level-object schema must use. Returns null when the value is
 * neither, so the caller falls back to the line scanner.
 */
function structuredFindingRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    if (Array.isArray(value.findings)) return value.findings;
    if (value.no_findings === true) return [];
  }
  return null;
}

export function parseOutput(stdout: string): ParseResult {
  const findings: Finding[] = [];
  const parseErrors: ParseError[] = [];
  let noFindingsAck = false;

  // A `--json-schema` run returns one conforming object in `structured_output`,
  // never a stream of per-line findings — read it directly from the RAW stdout
  // (normalizeOutput would have thrown the field away) before falling back to
  // the line scanner. Without this branch a schema-forced reply parses to zero
  // findings and zero parse errors, which the dispatcher reports as a failed
  // domain rather than as the findings the model actually produced.
  const envelope = readStructuredEnvelope(stdout);
  if (envelope.kind === "failed") {
    return { findings, parseErrors: [{ line: "", reason: `claude run failed: ${envelope.message}` }] };
  }
  if (envelope.kind === "structured") {
    const records = structuredFindingRecords(envelope.value);
    if (records !== null) {
      if (isPlainObject(envelope.value) && envelope.value.no_findings === true) noFindingsAck = true;
      for (const record of records) {
        if (!isPlainObject(record)) {
          parseErrors.push({ line: JSON.stringify(record), reason: "record is not a JSON object" });
          continue;
        }
        const outcome = recordToFinding(record);
        if (outcome.kind === "finding") findings.push(outcome.finding);
        else if (outcome.kind === "no_findings") noFindingsAck = true;
        else if (outcome.kind === "error") {
          parseErrors.push({ line: JSON.stringify(record), reason: outcome.reason });
        }
      }
      if (findings.length === 0 && records.length === 0) noFindingsAck = true;
      return noFindingsAck
        ? { findings, parseErrors, noFindingsAck: true }
        : { findings, parseErrors };
    }
    // Structured reply in an unrecognized shape: report it rather than silently
    // falling through to a line scan that cannot read it either.
    parseErrors.push({
      line: JSON.stringify(envelope.value).slice(0, 500),
      reason: "structured_output is neither an array of findings nor a { findings: [...] } object",
    });
    return { findings, parseErrors };
  }

  const text = normalizeOutput(stdout);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (err) {
      parseErrors.push({ line, reason: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    if (!isPlainObject(parsed)) {
      parseErrors.push({ line, reason: "record is not a JSON object" });
      continue;
    }
    const outcome = recordToFinding(parsed);
    if (outcome.kind === "finding") findings.push(outcome.finding);
    else if (outcome.kind === "no_findings") noFindingsAck = true;
    else if (outcome.kind === "error") parseErrors.push({ line, reason: outcome.reason });
  }
  return noFindingsAck
    ? { findings, parseErrors, noFindingsAck: true }
    : { findings, parseErrors };
}
