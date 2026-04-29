import { execFileSync } from "node:child_process";
import type { ExecFn } from "./types.ts";
import type { DraftConfig } from "./config.ts";

export function buildCodexArgv(cfg: { model: string; reasoningEffort: string }): string[] {
  return [
    "exec",
    "-m",
    cfg.model,
    "-c",
    `model_reasoning_effort="${cfg.reasoningEffort}"`,
    "--ephemeral",
    "--json",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-",
  ];
}

export function parseCodexJsonl(raw: string): string {
  if (!raw.trimStart().startsWith("{")) return raw;
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev?.type === "item.completed") {
        const item = ev.item ?? {};
        if (item.type === "agent_message" && typeof item.text === "string") parts.push(item.text);
        else if (item.type === "message") {
          for (const c of item.content ?? []) {
            if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    } catch {
      // Skip non-JSON lines inside otherwise JSONL output.
    }
  }
  return parts.length > 0 ? parts.join("\n") : raw;
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });

export interface CodexCallInput {
  cfg: DraftConfig;
  prompt: string;
  exec?: ExecFn;
}

export function callCodex(input: CodexCallInput): string {
  const exec = input.exec ?? defaultExec;
  const argv = buildCodexArgv(input.cfg);
  // timeoutSeconds gates a hung Codex subprocess. execFileSync sends SIGTERM
  // and throws when the timer fires; the caller's retry loop handles it.
  const buf = exec("codex", argv, {
    input: input.prompt,
    timeout: input.cfg.timeoutSeconds * 1000,
  } as never);
  return parseCodexJsonl(buf.toString("utf8"));
}
