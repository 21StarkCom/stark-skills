/**
 * Statusline segment configurator — TypeScript port of
 * `config/statusline-setup.py`.
 *
 * The Python original also shipped a curses TUI for the no-args case;
 * Node has no curses, so the TS port keeps the five flag modes
 * (--list / --enable / --disable / --install / --reset) and prints
 * usage when invoked with no arguments.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo `config/statusline-command.sh` — resolved relative to this file.
 *  This file lives in `tools/`; the shell script lives in `config/`. */
export function statuslineShPath(): string {
  return path.resolve(import.meta.dirname, "..", "config", "statusline-command.sh");
}

function claudeDir(): string {
  return path.join(os.homedir(), ".claude");
}
function installedShPath(): string {
  return path.join(claudeDir(), "statusline-command.sh");
}
function installedSettingsPath(): string {
  return path.join(claudeDir(), "settings.json");
}
export function segmentsJsonPath(): string {
  return path.join(claudeDir(), "statusline-segments.json");
}

// ---------------------------------------------------------------------------
// Segment registry — (id, label, line, description)
// ---------------------------------------------------------------------------

export interface Segment {
  id: string;
  label: string;
  line: 1 | 2 | 3;
  description: string;
}

// Every id here is a toggle the shipped `config/statusline-command.sh` actually
// gates on via `_on <id>` — no phantoms. The CTX / 5H / 7D gauges are deliberately
// absent: the script always renders them (no `_on` guard), so they are not
// toggleable. `line` is the physical line the segment writes to (1 repo/branch/PR,
// 2 account/gauges, 3 session clocks + model/effort).
export const SEGMENTS: Segment[] = [
  { id: "repo_name", label: "Repo Name", line: 1, description: "Git remote repository (or cwd) name" },
  { id: "wt_name", label: "Worktree", line: 1, description: "Linked-worktree directory name" },
  { id: "git_branch", label: "Git Branch", line: 1, description: "Current branch name" },
  { id: "git_dirty", label: "Dirty State", line: 1, description: "Changed/untracked counts + diff (needs git_branch on)" },
  { id: "pr", label: "Open PR", line: 1, description: "PR number + review-state glyph for this branch" },
  { id: "agent", label: "Active Agent", line: 1, description: "Subagent name (--agent or settings)" },
  { id: "session_name", label: "Session / Ticket", line: 1, description: "Bound ticket (id · title) or session name" },
  { id: "vim_mode", label: "Vim Mode", line: 1, description: "Vim N/I mode indicator" },
  { id: "account", label: "Account", line: 2, description: "Logged-in account label + per-account gradient" },
  { id: "tier_warn", label: "1M-tier Warning", line: 2, description: "Flag when exceeds_200k_tokens (Opus 2x pricing)" },
  { id: "code_churn", label: "Code Churn", line: 2, description: "Lines added/removed this session" },
  { id: "session_times", label: "Session Clocks", line: 3, description: "Now + age · since-enter (👤) · since-reply (🤖)" },
  { id: "model", label: "Model", line: 3, description: "Claude model display name" },
  { id: "effort", label: "Reasoning Effort", line: 3, description: "Lo / Me / Hi / Xh / Mx — affects output volume + cost" },
];

export const VALID_IDS: ReadonlySet<string> = new Set(SEGMENTS.map((s) => s.id));

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

export type SegmentStates = Record<string, boolean>;

export function loadConfig(): SegmentStates {
  const states: SegmentStates = {};
  for (const s of SEGMENTS) states[s.id] = true;

  const file = segmentsJsonPath();
  if (fs.existsSync(file)) {
    try {
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
      Object.assign(states, onDisk);
    } catch {
      // malformed config — fall back to all-enabled defaults
    }
  }
  return states;
}

export function saveConfig(states: SegmentStates): void {
  fs.mkdirSync(claudeDir(), { recursive: true });
  fs.writeFileSync(segmentsJsonPath(), `${JSON.stringify(states, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Ensure the statusline is installed. Returns the actions taken. */
export function installStatusline(): string[] {
  const actions: string[] = [];
  fs.mkdirSync(claudeDir(), { recursive: true });

  const statuslineSh = statuslineShPath();
  const installedSh = installedShPath();

  // 1. Script symlink
  let symlinkOk = false;
  try {
    if (fs.lstatSync(installedSh).isSymbolicLink()) {
      symlinkOk = fs.realpathSync(installedSh) === fs.realpathSync(statuslineSh);
    }
  } catch {
    symlinkOk = false;
  }
  if (symlinkOk) {
    actions.push("Script symlink OK");
  } else {
    try {
      fs.lstatSync(installedSh);
      fs.unlinkSync(installedSh);
    } catch {
      // nothing to remove
    }
    fs.symlinkSync(statuslineSh, installedSh);
    actions.push(`Linked ${path.basename(installedSh)} -> ${statuslineSh}`);
  }

  // 2. Patch settings.json
  const entry = { type: "command", command: `bash ${installedSh}` };
  const settingsPath = installedSettingsPath();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }

  const current = settings.statusLine as Record<string, unknown> | undefined;
  const matches =
    current !== undefined &&
    current !== null &&
    typeof current === "object" &&
    Object.keys(current).length === 2 &&
    current.type === entry.type &&
    current.command === entry.command;

  if (matches) {
    actions.push("settings.json OK");
  } else {
    settings.statusLine = entry;
    const tmp = `${settingsPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(tmp, settingsPath);
    actions.push("Patched settings.json");
  }

  return actions;
}

// ---------------------------------------------------------------------------
// CLI command bodies
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Render the segment list (mirrors the Python `cmd_list`). */
export function renderList(states: SegmentStates): string {
  const lines: string[] = [];
  let curLine = 0;
  for (const s of SEGMENTS) {
    if (s.line !== curLine) {
      curLine = s.line;
      lines.push("");
      lines.push(`  Line ${s.line}`);
      lines.push(`  ${pad("ID", 16)} ${pad("Label", 18)} ${"State".padStart(5)}  Description`);
      lines.push(`  ${"─".repeat(16)} ${"─".repeat(18)} ${"─".repeat(5)}  ${"─".repeat(30)}`);
    }
    const on = states[s.id] ?? true;
    const mark = on ? `${GREEN}  on${RESET}` : `${RED} off${RESET}`;
    lines.push(`  ${pad(s.id, 16)} ${pad(s.label, 18)} ${mark}  ${s.description}`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface ToggleResult {
  ok: boolean;
  error?: string;
}

/** Enable/disable a comma-separated set of segment ids, then persist. */
export function applyToggle(
  states: SegmentStates,
  idsStr: string,
  enable: boolean,
): ToggleResult {
  const ids = idsStr.split(",").map((s) => s.trim());
  for (const sid of ids) {
    if (!VALID_IDS.has(sid)) {
      const valid = [...VALID_IDS].sort().join(", ");
      return { ok: false, error: `Unknown segment: ${sid}\nValid IDs: ${valid}` };
    }
  }
  for (const sid of ids) states[sid] = enable;
  saveConfig(states);
  return { ok: true };
}
