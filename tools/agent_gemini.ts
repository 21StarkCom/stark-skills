import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { AgentName, Finding, Severity } from "./stark_review_lib.ts";
import { findingId } from "./stark_review_lib.ts";
import type { BuildContext, BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";
import { resolvedPath } from "./agent_env_lib.ts";

export const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro-preview";
const VERTEX_PROJECT = "infra-ai-platform";
const VERTEX_LOCATION = "global";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "critical", "high", "medium", "low",
]);
const KNOWN_FINDING_KEYS: ReadonlySet<string> = new Set([
  "id", "domain", "agent", "severity", "file", "line",
  "title", "body", "classification", "classification_reason", "extra",
]);

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

/** Mirror scripts/gemini_utils.py:setup_gemini_home. Creates a per-call temp
 * GEMINI_CLI_HOME with .gemini/{settings.json, projects.json} so that
 * (a) auth defaults to Vertex AI + global region (or API-key when forced)
 * and (b) the dispatch cwd is registered. Workspace trust is bypassed only
 * when this module or the dispatcher created the scratch dir, never for
 * arbitrary caller-supplied review worktrees.
 *
 * Caller passes the dispatcher cwd in projectDir; we register it. The home
 * lives under <projectDir>/.gemini-home so it is cleaned up when the
 * dispatcher rmSyncs the cwd. */
export function setupGeminiHome(projectDir: string, useApiKey: boolean): string {
  const home = path.join(projectDir, ".gemini-home");
  const dotGemini = path.join(home, ".gemini");
  fs.mkdirSync(dotGemini, { recursive: true });
  const settings = useApiKey
    ? { security: { auth: { selectedType: "gemini-api-key" } }, selectedAuthType: "gemini-api-key" }
    : {
        security: {
          auth: {
            selectedType: "vertex-ai",
            vertexAi: { projectId: VERTEX_PROJECT, region: VERTEX_LOCATION },
          },
        },
        selectedAuthType: "vertex-ai",
      };
  fs.writeFileSync(path.join(dotGemini, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(
    path.join(dotGemini, "projects.json"),
    JSON.stringify({ projects: { [projectDir]: "session" } }),
  );
  return home;
}

function shouldTrustWorkspace(projectDir: string, ctx?: BuildContext): boolean {
  const createdHere = ctx?.cwd === undefined;
  const createdByDispatcher = ctx?.trustedGeneratedCwd === true;
  if (!createdHere && !createdByDispatcher) return false;
  try {
    const st = fs.lstatSync(projectDir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function buildEnv(geminiHome: string, apiKey: string | null, trustWorkspace: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.PATH = resolvedPath(env.PATH);
  env.GEMINI_CLI_HOME = geminiHome;
  if (trustWorkspace) env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  if (apiKey) {
    // API-key mode: disable Vertex so the CLI does not retry against ADC.
    env.GEMINI_API_KEY = apiKey;
    env.GOOGLE_GENAI_USE_VERTEXAI = "false";
  } else {
    // Vertex AI + ADC. We force these defaults rather than forwarding host
    // values, because a host-set GOOGLE_CLOUD_LOCATION (e.g. us-east1) breaks
    // preview models that only exist on the global endpoint.
    env.GOOGLE_GENAI_USE_VERTEXAI = "true";
    env.GOOGLE_CLOUD_PROJECT = VERTEX_PROJECT;
    env.GOOGLE_CLOUD_LOCATION = VERTEX_LOCATION;
    const adc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (typeof adc === "string" && adc.length > 0) {
      env.GOOGLE_APPLICATION_CREDENTIALS = adc;
    } else {
      const defaultAdc = path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
      if (fs.existsSync(defaultAdc)) env.GOOGLE_APPLICATION_CREDENTIALS = defaultAdc;
    }
  }
  return env;
}

export function buildCommand(prompt: string, model?: string, ctx?: BuildContext): BuiltCommand {
  const m = model ?? GEMINI_DEFAULT_MODEL;
  const projectDir = ctx?.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "stark-gemini-"));
  const apiKey = process.env.GEMINI_API_KEY ?? null;
  const home = setupGeminiHome(projectDir, apiKey !== null);
  const trustWorkspace = shouldTrustWorkspace(projectDir, ctx);
  return {
    cmd: "gemini",
    args: ["-o", "json", "-m", m, "-p", "-"],
    stdin: prompt,
    env: buildEnv(home, apiKey, trustWorkspace),
    cwd: projectDir,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Unwrap Gemini `-o json` envelope. Single shape: `{"response":"..."}`,
 * or array of those. Returns input unchanged when no envelope detected. */
export function normalizeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return stdout;
  try {
    const obj = JSON.parse(trimmed);
    if (isPlainObject(obj) && typeof obj.response === "string") return obj.response;
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) {
        if (isPlainObject(item) && typeof item.response === "string") parts.push(item.response);
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
        ? (agentField as AgentName) : "gemini";
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
