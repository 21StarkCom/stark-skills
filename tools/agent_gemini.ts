import type { BuiltCommand, ParseResult } from "./agent_codex.ts";

const NOT_SUPPORTED =
  "agent gemini not implemented in the TS path yet; use /stark-team-review for multi-agent review or wait for V1.1";

export function buildCommand(_prompt: string, _model?: string): BuiltCommand {
  throw new Error(NOT_SUPPORTED);
}

export function parseOutput(_stdout: string): ParseResult {
  throw new Error(NOT_SUPPORTED);
}
