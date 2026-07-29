import type { AgentName, Finding, Severity } from "./stark_review_lib.ts";
import { findingId } from "./stark_review_lib.ts";
import type { BuildContext, BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";
import { resolvedPath } from "./agent_env_lib.ts";
import { applyClaudeAuth } from "./claude_auth_lib.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5[1m]";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "critical", "high", "medium", "low",
]);

const KNOWN_FINDING_KEYS: ReadonlySet<string> = new Set([
  "id", "domain", "agent", "severity", "file", "line",
  "title", "body", "classification", "classification_reason", "extra",
]);

// Strict allowlist: PATH/HOME for the binary + model auth (see
// claude_auth_lib.ts — subscription-only, so the CLI rides HOME's OAuth
// credentials and no Anthropic API key is ever forwarded).
// GH_TOKEN/GITHUB_TOKEN/STARK_PUSH_TOKEN are
// intentionally excluded so the reviewer subprocess cannot exfiltrate
// posting credentials.
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.PATH = resolvedPath(env.PATH);
  applyClaudeAuth(env);
  return env;
}

/**
 * argv ceiling for the serialized schema. macOS ARG_MAX is ~1 MiB for the whole
 * argument vector; 256 KiB leaves generous room for the rest of the command and
 * fails loudly here instead of as an opaque E2BIG from spawn.
 */
const MAX_SCHEMA_BYTES = 256 * 1024;

/**
 * Serialize a JSON Schema for `--json-schema`.
 *
 * The flag takes **inline JSON only** — passing a file path fails with
 * `--json-schema is not valid JSON` (verified against 2.1.220), so there is no
 * temp-file variant to fall back on.
 */
export function serializeJsonSchema(schema: unknown): string {
  const s = JSON.stringify(schema);
  if (typeof s !== "string") {
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
 * Read the pre-parsed structured reply from a `--json-schema` run.
 *
 * When the schema is supplied the CLI envelope carries a top-level
 * `structured_output` holding the reply **already parsed** — `.result` remains
 * a *string* of the same JSON, so reading `structured_output` skips a parse
 * rather than duplicating one.
 *
 * Returns null when the field is absent (no schema was passed, an older CLI, or
 * a failed run), which is the caller's signal to fall back to tolerant text
 * extraction. Errors are reported, never swallowed: an errored envelope returns
 * null so a partial object is not mistaken for a complete reply.
 */
export function extractStructuredOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(envelope)) return null;
  if (envelope.is_error === true) return null;
  const structured = envelope.structured_output;
  return structured === undefined || structured === null ? null : structured;
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseOutput(stdout: string): ParseResult {
  const findings: Finding[] = [];
  const parseErrors: ParseError[] = [];
  let noFindingsAck = false;
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
    // No-findings sentinel: explicit ack of a clean review. See agent_codex.ts.
    if (parsed.no_findings === true) {
      noFindingsAck = true;
      continue;
    }
    // A finding MUST have severity and title. Lines with neither are framing
    // chatter (status/reasoning/summary objects the model emits between
    // findings) — skip silently. See agent_codex.ts for the full rationale.
    if (
      !Object.prototype.hasOwnProperty.call(parsed, "severity") &&
      !Object.prototype.hasOwnProperty.call(parsed, "title")
    ) {
      continue;
    }
    const severity = parsed.severity;
    if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity as Severity)) {
      parseErrors.push({ line, reason: `invalid or missing severity (got ${JSON.stringify(severity)})` });
      continue;
    }
    const title = parsed.title;
    if (typeof title !== "string" || title.length === 0) {
      parseErrors.push({ line, reason: "missing or empty title" });
      continue;
    }
    const domain = parsed.domain;
    if (typeof domain !== "string" || domain.length === 0) {
      parseErrors.push({ line, reason: "missing or empty domain" });
      continue;
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
    findings.push(finding);
  }
  return noFindingsAck
    ? { findings, parseErrors, noFindingsAck: true }
    : { findings, parseErrors };
}
