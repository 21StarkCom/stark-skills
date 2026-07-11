/**
 * Codex CLI integration helpers — TypeScript port of `scripts/codex_utils.py`.
 *
 * Constants and helpers shared by the dispatch orchestrators that invoke
 * the Codex CLI. The Python imported `config_loader`; this port reads
 * config via `stark_config_lib.ts`.
 */

import { AgentDisabledError } from "./agent_disabled_error.ts";
import { getModelId, isAgentEnabled } from "./stark_config_lib.ts";

export { AgentDisabledError };

/** Default model — pinned to avoid silent changes from CLI updates. */
export const CODEX_MODEL = "gpt-5.6-sol";

/** Reasoning-effort config for the `-c` flag (TOML key=value format). */
export const CODEX_REASONING_EFFORT_XHIGH = 'model_reasoning_effort="xhigh"';
export const CODEX_REASONING_EFFORT_HIGH = 'model_reasoning_effort="high"';
export const CODEX_REASONING_EFFORT_MEDIUM = 'model_reasoning_effort="medium"';

/** Resolve the configured Codex model. Throws if the agent is disabled. */
export function getCodexModel(): string {
  if (!isAgentEnabled("codex")) {
    throw new AgentDisabledError("codex agent is disabled in config");
  }
  return getModelId("codex") || CODEX_MODEL;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extract assistant text from Codex `--json` JSONL output.
 *
 * Codex `--json` emits newline-delimited JSON events. Text comes from
 * `item.completed` events — the current `agent_message` shape and the
 * legacy `message` / `content[].output_text` shape. Returns the
 * concatenated text, or the original `raw` unchanged if no JSONL framing
 * is detected.
 */
export function parseJsonlOutput(raw: string): string {
  if (!raw.trim().startsWith("{")) return raw;

  const parts: string[] = [];
  for (const lineRaw of raw.split(/\r\n|\r|\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const evObj = asRecord(ev);
    if (!evObj || evObj.type !== "item.completed") continue;
    const item = asRecord(evObj.item) ?? {};
    const itype = item.type ?? "";
    if (itype === "agent_message") {
      const text = item.text;
      if (typeof text === "string" && text) parts.push(text);
    } else if (itype === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        const cObj = asRecord(c);
        if (cObj && cObj.type === "output_text") {
          parts.push(typeof cObj.text === "string" ? cObj.text : "");
        }
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : raw;
}
