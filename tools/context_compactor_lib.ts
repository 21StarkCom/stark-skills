/**
 * Session checkpoint generator — TypeScript port of
 * `scripts/context_compactor.py`. Writes markdown checkpoints under
 *   ~/.claude/code-review/sessions/{sanitized-id}/checkpoint-{ts}.md
 * and updates the session_state's `last_checkpoint` pointer.
 *
 * The Python `scripts/context_compactor.py` is deleted in the same
 * change — `scripts/session_state.py` + `scripts/session_id.py` go with
 * it (they had no other consumers).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { assetConfigPath } from "./asset_root_lib.ts";
import { resolveSessionId } from "./session_id_lib.ts";
import {
  defaultSessionsDir,
  loadState,
  sanitizeId,
  saveState,
  type SessionState,
} from "./session_state_lib.ts";

// ---------------------------------------------------------------------------
// Config (inline — the broader `config_loader.py` port is its own slice)
// ---------------------------------------------------------------------------

export interface ContextCompactionConfig {
  enabled: boolean;
  checkpoint_interval_minutes: number;
  max_checkpoint_size_kb: number;
  include_file_summaries: boolean;
}

export const DEFAULT_CONTEXT_COMPACTION: ContextCompactionConfig = {
  enabled: true,
  checkpoint_interval_minutes: 15,
  max_checkpoint_size_kb: 50,
  include_file_summaries: true,
};

export function defaultConfigPath(): string {
  return assetConfigPath();
}

export function loadContextCompactionConfig(
  configPath?: string,
): ContextCompactionConfig {
  const file = configPath ?? defaultConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ...DEFAULT_CONTEXT_COMPACTION };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...DEFAULT_CONTEXT_COMPACTION };
  }
  if (typeof data !== "object" || data === null) {
    return { ...DEFAULT_CONTEXT_COMPACTION };
  }
  const section = (data as Record<string, unknown>).context_compaction;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    return { ...DEFAULT_CONTEXT_COMPACTION };
  }
  const cfg = { ...DEFAULT_CONTEXT_COMPACTION };
  const overrides = section as Record<string, unknown>;
  if (typeof overrides.enabled === "boolean") cfg.enabled = overrides.enabled;
  if (typeof overrides.checkpoint_interval_minutes === "number") {
    cfg.checkpoint_interval_minutes = overrides.checkpoint_interval_minutes;
  }
  if (typeof overrides.max_checkpoint_size_kb === "number") {
    cfg.max_checkpoint_size_kb = overrides.max_checkpoint_size_kb;
  }
  if (typeof overrides.include_file_summaries === "boolean") {
    cfg.include_file_summaries = overrides.include_file_summaries;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Git helpers (injectable for tests)
// ---------------------------------------------------------------------------

export function gitLogOnelineDefault(n = 10): string {
  const result = spawnSync("git", ["log", "--oneline", `-${n}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "(git log unavailable)";
  return (result.stdout ?? "").trim() || "(git log unavailable)";
}

export function gitModifiedFilesDefault(depth = 5): string[] {
  const head = spawnSync("git", ["diff", "--name-only", `HEAD~${depth}..HEAD`], {
    encoding: "utf8",
  });
  if (head.status === 0 && (head.stdout ?? "").trim()) {
    return (head.stdout ?? "").trim().split("\n");
  }
  const fallback = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf8",
  });
  if (fallback.status === 0) {
    const out = (fallback.stdout ?? "").trim();
    return out ? out.split("\n") : [];
  }
  return [];
}

export function fileHeadDefault(filePath: string, n = 3): string {
  let text: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "(file not found)";
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return "(file not found)";
  }
  const lines = text.split("\n");
  if (lines.length === 0) return "(empty)";
  return lines.slice(0, n).join("\n");
}

// ---------------------------------------------------------------------------
// Content assembly
// ---------------------------------------------------------------------------

export interface BuildCheckpointOpts {
  state: SessionState;
  cfg: ContextCompactionConfig;
  gitLogOneline: (n?: number) => string;
  gitModifiedFiles: (depth?: number) => string[];
  fileHead: (filePath: string, n?: number) => string;
  now: () => Date;
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildCheckpointContent(opts: BuildCheckpointOpts): string {
  const { state, cfg, gitLogOneline, gitModifiedFiles, fileHead, now } = opts;
  const lines: string[] = [];
  const ts = isoZ(now());

  lines.push("# Session Checkpoint");
  lines.push("");
  lines.push(`**Generated:** ${ts}`);
  lines.push("");

  lines.push("## Session Summary");
  lines.push("");
  lines.push(`- **Session ID:** ${state.session_id}`);
  lines.push(`- **Started:** ${state.started_at}`);
  lines.push(`- **Branch:** ${state.branch}`);
  lines.push(`- **Repo:** ${state.repo}`);
  lines.push("");

  lines.push("## Recent Commits");
  lines.push("");
  lines.push("```");
  lines.push(gitLogOneline(10));
  lines.push("```");
  lines.push("");

  const modified = gitModifiedFiles(5);
  lines.push("## Modified Files");
  lines.push("");
  if (modified.length > 0) {
    for (const f of modified) lines.push(`- \`${f}\``);
    lines.push("");
    if (cfg.include_file_summaries) {
      lines.push("### File Summaries (first 3 lines)");
      lines.push("");
      for (const f of modified) {
        lines.push(`**${f}**`);
        lines.push("```");
        lines.push(fileHead(f, 3));
        lines.push("```");
        lines.push("");
      }
    }
  } else {
    lines.push("_(no modified files detected)_");
    lines.push("");
  }

  lines.push("## Tasks Completed");
  lines.push("");
  if (state.tasks_completed.length > 0) {
    for (const t of state.tasks_completed) lines.push(`- ${t}`);
  } else {
    lines.push("_(none)_");
  }
  lines.push("");

  const ctxKeys = Object.keys(state.context);
  if (ctxKeys.length > 0) {
    lines.push("## Key Decisions");
    lines.push("");
    for (const k of ctxKeys) lines.push(`- **${k}:** ${String(state.context[k])}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// generateCheckpoint — full roundtrip
// ---------------------------------------------------------------------------

export interface GenerateCheckpointOpts {
  sessionId?: string;
  sessionsDir?: string;
  cfg?: ContextCompactionConfig;
  configPath?: string;
  gitLogOneline?: (n?: number) => string;
  gitModifiedFiles?: (depth?: number) => string[];
  fileHead?: (filePath: string, n?: number) => string;
  now?: () => Date;
}

export function generateCheckpoint(opts: GenerateCheckpointOpts = {}): string {
  const cfg =
    opts.cfg ?? loadContextCompactionConfig(opts.configPath);
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const sid = opts.sessionId ?? resolveSessionId();

  const now = opts.now ?? (() => new Date());
  const gitLog = opts.gitLogOneline ?? gitLogOnelineDefault;
  const gitMod = opts.gitModifiedFiles ?? gitModifiedFilesDefault;
  const head = opts.fileHead ?? fileHeadDefault;

  const existing = loadState(sid, dir);
  const state: SessionState =
    existing ??
    {
      session_id: sid,
      started_at: isoZ(now()),
      branch: "",
      repo: "",
      tasks_completed: [],
      last_checkpoint: null,
      context: {},
      name: null,
      start_head: null,
    };

  let content = buildCheckpointContent({
    state,
    cfg,
    gitLogOneline: gitLog,
    gitModifiedFiles: gitMod,
    fileHead: head,
    now,
  });

  const maxBytes = cfg.max_checkpoint_size_kb * 1024;
  const truncationNote = "\n\n_(checkpoint truncated due to size limit)_\n";
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    // Reserve room for the truncation note so the final file still fits
    // under the cap (with a small tolerance for the marker itself, like
    // the Python which appends after the byte-slice).
    const sliceTo = Math.max(0, maxBytes - Buffer.byteLength(truncationNote, "utf8"));
    const buf = Buffer.from(content, "utf8").subarray(0, sliceTo);
    content = buf.toString("utf8") + truncationNote;
  }

  const tsStr = isoZ(now()).replace(/[-:]/g, "");
  const ckptDir = path.join(dir, sanitizeId(sid));
  fs.mkdirSync(ckptDir, { recursive: true });
  const ckptPath = path.join(ckptDir, `checkpoint-${tsStr}.md`);
  fs.writeFileSync(ckptPath, content);

  state.last_checkpoint = ckptPath;
  saveState(state, dir);

  return ckptPath;
}

// ---------------------------------------------------------------------------
// getLatestCheckpoint
// ---------------------------------------------------------------------------

export interface GetLatestCheckpointOpts {
  sessionId?: string;
  sessionsDir?: string;
}

export function getLatestCheckpoint(opts: GetLatestCheckpointOpts = {}): string | null {
  const sid = opts.sessionId ?? resolveSessionId();
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const ckptDir = path.join(dir, sanitizeId(sid));
  let entries: string[];
  try {
    entries = fs.readdirSync(ckptDir);
  } catch {
    return null;
  }
  const checkpoints = entries
    .filter((n) => n.startsWith("checkpoint-") && n.endsWith(".md"))
    .sort();
  if (checkpoints.length === 0) return null;
  return path.join(ckptDir, checkpoints[checkpoints.length - 1]);
}
