import type { AgentName, Finding, Severity } from "./stark_review_lib.ts";
import { findingId } from "./stark_review_lib.ts";
import { resolvedPath } from "./agent_env_lib.ts";

export interface BuiltCommand {
  cmd: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
  /** When set, the dispatcher uses this cwd instead of creating its own.
   * Used by agents that need to register the cwd in pre-spawn config files
   * (e.g. Gemini's projects.json). */
  cwd?: string;
}

/** Optional context passed to buildCommand. The dispatcher creates the
 * temp working directory before calling buildCommand and passes it in
 * as cwd, so per-agent setup (e.g. Gemini projects.json) can register it. */
export interface BuildContext {
  cwd?: string;
  /** True only when the dispatcher just created cwd as an isolated scratch dir. */
  trustedGeneratedCwd?: boolean;
}

export interface ParseError {
  line: string;
  reason: string;
}

export interface ParseResult {
  findings: Finding[];
  parseErrors: ParseError[];
  /** True when the agent emitted at least one explicit no-findings sentinel
   * (`{"no_findings": true, ...}`). Distinguishes "agent reviewed and found
   * nothing" from "agent emitted unparseable prose". */
  noFindingsAck?: boolean;
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "critical",
  "high",
  "medium",
  "low",
]);

const KNOWN_FINDING_KEYS: ReadonlySet<string> = new Set([
  "id",
  "domain",
  "agent",
  "severity",
  "file",
  "line",
  "title",
  "body",
  "classification",
  "classification_reason",
  "extra",
]);

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

function buildMinimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.PATH = resolvedPath(env.PATH);
  return env;
}

/**
 * Build the argv/stdin/env for invoking the Codex CLI with the rendered review
 * prompt. The caller is responsible for actually spawning the process.
 *
 * Mirrors the Python `multi_review.py` codex branch: `codex exec --json` with
 * high reasoning effort, prompt delivered on stdin. Model flag is included only
 * when the caller supplies one — otherwise the CLI's pinned default is used.
 */
export function buildCommand(prompt: string, model?: string, _ctx?: BuildContext): BuiltCommand {
  const modelFlags = model ? ["-m", model] : [];
  // codex-cli 0.128.0+ removed the `--reasoning-effort` argument; reasoning
  // effort is now a config override applied via `-c key=value`. The dispatcher
  // spawns codex in a fresh temp cwd outside the user's trusted-directory list,
  // so we also need `--skip-git-repo-check` or codex refuses to start.
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    `model_reasoning_effort="high"`,
    ...modelFlags,
  ];
  return {
    cmd: "codex",
    args,
    stdin: prompt,
    env: buildMinimalEnv(),
  };
}

/**
 * Extract the assistant text from Codex `--json` JSONL framing.
 *
 * Codex emits one event per line on stdout. We collect text from
 * `item.completed` events covering both the current `agent_message` shape and
 * the legacy `message` / `content[].output_text` shape. Non-JSON status lines
 * are skipped silently — they are framing chatter, not findings.
 *
 * Returns the concatenated agent text, or the raw input unchanged if no JSONL
 * framing is detected (matches the Python `parse_jsonl_output` semantics).
 */
function extractAgentText(raw: string): string {
  const parts: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(ev)) continue;
    if (ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!isPlainObject(item)) continue;
    const itype = item.type;
    if (itype === "agent_message") {
      const text = item.text;
      if (typeof text === "string" && text) parts.push(text);
    } else if (itype === "message") {
      const content = item.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!isPlainObject(c)) continue;
          if (c.type === "output_text" && typeof c.text === "string") {
            parts.push(c.text);
          }
        }
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : raw;
}

/** Normalize raw stdout to the unwrapped agent text. Exposed so callers
 * (e.g. classifyOne) can extract structured data without re-parsing the
 * agent's framing. */
export function normalizeOutput(stdout: string): string {
  return extractAgentText(stdout);
}

/** Return only the LAST assistant message's text. Use this when a caller needs
 * the final answer alone (e.g. the fixer's single-JSON-object contract) and
 * cannot tolerate codex's intermediate reasoning preambles concatenated in. */
export function extractLastAgentText(raw: string): string {
  let last: string | null = null;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(ev)) continue;
    if (ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!isPlainObject(item)) continue;
    const itype = item.type;
    if (itype === "agent_message") {
      const text = item.text;
      if (typeof text === "string" && text) last = text;
    } else if (itype === "message") {
      const content = item.content;
      if (Array.isArray(content)) {
        const buf: string[] = [];
        for (const c of content) {
          if (!isPlainObject(c)) continue;
          if (c.type === "output_text" && typeof c.text === "string") {
            buf.push(c.text);
          }
        }
        if (buf.length) last = buf.join("\n");
      }
    }
  }
  return last !== null ? last : raw;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse Codex stdout into `Finding[]`. Malformed records are dropped and
 * recorded in `parseErrors[]` — never thrown.
 *
 * The narrow validation contract per the phase spec: a record MUST have a
 * non-empty string `severity` (one of the four enum values), `title`, and
 * `domain`. Missing optional fields fall back to defaults (`agent='codex'`,
 * `file=null`, `line=null`, `body=''`, derived `id`). Any keys beyond the
 * canonical Finding shape are preserved under `finding.extra`.
 */
export function parseOutput(stdout: string): ParseResult {
  const findings: Finding[] = [];
  const parseErrors: ParseError[] = [];
  let noFindingsAck = false;

  const agentText = extractAgentText(stdout);

  for (const rawLine of agentText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("{")) continue; // skip prose/framing chatter

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      parseErrors.push({
        line,
        reason: `invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }

    if (!isPlainObject(parsed)) {
      parseErrors.push({ line, reason: "record is not a JSON object" });
      continue;
    }

    // No-findings sentinel: explicit ack that the agent reviewed and found
    // nothing. Distinguishes a clean review from prose noise so the dispatcher
    // doesn't trip the "unparseable stdout" tier-1 check.
    if (parsed.no_findings === true) {
      noFindingsAck = true;
      continue;
    }

    // A finding MUST have severity and title. If the line has neither, it's not
    // an attempted finding — treat as framing chatter (status updates, reasoning
    // objects, summaries the model emits between findings) and skip silently.
    // Otherwise validate strictly so genuinely malformed findings are flagged.
    if (
      !Object.prototype.hasOwnProperty.call(parsed, "severity") &&
      !Object.prototype.hasOwnProperty.call(parsed, "title")
    ) {
      continue;
    }

    const severity = parsed.severity;
    if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity as Severity)) {
      parseErrors.push({
        line,
        reason: `invalid or missing severity (got ${JSON.stringify(severity)})`,
      });
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
        ? (agentField as AgentName)
        : "codex";

    const declaredExtra = isPlainObject(parsed.extra) ? parsed.extra : {};
    const carriedExtra: Record<string, unknown> = { ...declaredExtra };
    for (const [k, v] of Object.entries(parsed)) {
      if (!KNOWN_FINDING_KEYS.has(k)) carriedExtra[k] = v;
    }

    const idField = parsed.id;
    const id =
      typeof idField === "string" && idField.length > 0
        ? idField
        : findingId(domain, agent, title);

    const finding: Finding = {
      id,
      domain,
      agent,
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
    if (Object.keys(carriedExtra).length > 0) {
      finding.extra = carriedExtra;
    }

    findings.push(finding);
  }

  return noFindingsAck
    ? { findings, parseErrors, noFindingsAck: true }
    : { findings, parseErrors };
}
