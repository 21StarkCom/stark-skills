#!/usr/bin/env node
/**
 * statusline-setup CLI — configure Claude Code statusline segments.
 * TypeScript port of `config/statusline-setup.py`.
 *
 * Usage:
 *   statusline-setup --list                 # show segment states
 *   statusline-setup --enable model,cost
 *   statusline-setup --disable vim_mode,effort
 *   statusline-setup --install              # install to ~/.claude/
 *   statusline-setup --reset                # reset all to enabled
 */

import {
  applyToggle,
  installStatusline,
  loadConfig,
  renderList,
  saveConfig,
  SEGMENTS,
} from "./statusline_setup_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

const HELP = `Configure Claude Code statusline segments.

Usage: statusline-setup [--list | --enable IDS | --disable IDS | --install | --reset]

Options:
  --list          List segments and their on/off states
  --enable IDS    Enable segments (comma-separated ids)
  --disable IDS   Disable segments (comma-separated ids)
  --install       Install the statusline to ~/.claude/
  --reset         Reset all segments to enabled
  --help          Show this help

Run --list to see segment ids, then --enable / --disable to toggle them.
`;

function main(argv: string[]): number {
  let mode: "list" | "enable" | "disable" | "install" | "reset" | null = null;
  let ids = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "--list") {
      mode = "list";
    } else if (arg === "--install") {
      mode = "install";
    } else if (arg === "--reset") {
      mode = "reset";
    } else if (arg === "--enable") {
      mode = "enable";
      ids = argv[++i] ?? "";
    } else if (arg.startsWith("--enable=")) {
      mode = "enable";
      ids = arg.slice("--enable=".length);
    } else if (arg === "--disable") {
      mode = "disable";
      ids = argv[++i] ?? "";
    } else if (arg.startsWith("--disable=")) {
      mode = "disable";
      ids = arg.slice("--disable=".length);
    } else {
      process.stderr.write(`Error: unknown argument: ${arg}\n`);
      return 2;
    }
  }

  const states = loadConfig();

  if (mode === "list") {
    process.stdout.write(`${renderList(states)}\n`);
    return 0;
  }
  if (mode === "reset") {
    const all: Record<string, boolean> = {};
    for (const s of SEGMENTS) all[s.id] = true;
    saveConfig(all);
    process.stdout.write("All segments reset to enabled.\n");
    return 0;
  }
  if (mode === "enable" || mode === "disable") {
    const result = applyToggle(states, ids, mode === "enable");
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      return 1;
    }
    process.stdout.write(`${mode === "enable" ? "Enabled" : "Disabled"}: ${ids}\n`);
    return 0;
  }
  if (mode === "install") {
    for (const action of installStatusline()) {
      process.stdout.write(`  ${action}\n`);
    }
    return 0;
  }

  // No arguments — the Python original opened a curses TUI here; the TS
  // port has no TUI, so print usage instead.
  process.stdout.write(HELP);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
