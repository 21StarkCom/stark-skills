import type { AgentName, Finding, Severity } from "./stark_review_lib.ts";
import { findingId } from "./stark_review_lib.ts";
import type { BuildContext, BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";
import { resolvedPath } from "./agent_env_lib.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "critical", "high", "medium", "low",
]);

const KNOWN_FINDING_KEYS: ReadonlySet<string> = new Set([
  "id", "domain", "agent", "severity", "file", "line",
  "title", "body", "classification", "classification_reason", "extra",
]);

// Strict allowlist: PATH/HOME for the binary, plus ANTHROPIC_API_KEY for auth.
// GH_TOKEN/GITHUB_TOKEN/STARK_PUSH_TOKEN are intentionally excluded so the
// reviewer subprocess cannot exfiltrate posting credentials. ANTHROPIC_AGENTS
// (the source var in claude_utils.py) is read here and surfaced as
// ANTHROPIC_API_KEY only — the source name is never forwarded.
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.PATH = resolvedPath(env.PATH);
  const apiKey = process.env.ANTHROPIC_AGENTS ?? process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}

export function buildCommand(prompt: string, model?: string, _ctx?: BuildContext): BuiltCommand {
  const m = model ?? CLAUDE_DEFAULT_MODEL;
  return {
    cmd: "claude",
    args: [
      "-p", "-",
      "--output-format", "json",
      "--model", m,
      "--no-session-persistence",
    ],
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
