#!/usr/bin/env -S node --experimental-strip-types
/**
 * fact-routing PostToolUse hook (STARK-1785).
 *
 * Wire in ~/.claude/settings.json:
 *   "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [
 *     { "type": "command",
 *       "command": "node --experimental-strip-types /Users/aryeh/Code/21Stark/stark-skills/tools/fact_routing_hook.ts" }]}]
 *
 * Reads the PostToolUse payload on stdin. When the written file is a
 * `<project>/memory/<name>.md` auto-memory that smells corpus- or repo-CLAUDE-worthy, it
 * appends a candidate to ~/.claude/.fact-routing-queue.jsonl and prints a
 * one-line advisory. It is ADVISORY: it never blocks the tool and always exits 0.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyMemory,
  bodyOf,
  makeEntry,
  appendToQueue,
  defaultQueuePath,
  resolveFleetSlugs,
} from "./fact_routing_hook_lib.ts";

// Fallback slug list if the corpus checkout is absent (CI, fresh machine).
const FALLBACK_SLUGS = [
  "tyr", "frigg", "alfred", "meridian", "bifrost", "lumiere", "plume", "sleipnir",
  "hermod", "heimdall", "idun", "draupnir", "kotodama", "mimir", "atlas",
  "stark-skills", "stark-tui", "stark-showcase", "ev-infra-group", "homebrew-tap",
  "apple-developer", "stark-invoices-collector",
];

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  const raw = readStdin();
  if (!raw.trim()) return;

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const tool = data?.tool_name;
  const fp = data?.tool_input?.file_path;
  if (typeof fp !== "string") return;
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return;
  // Only Claude auto-memory under ~/.claude/projects/<proj>/memory/ — not an
  // ordinary repo that happens to have a memory/ dir.
  if (!/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(fp)) return;

  let content: string;
  try {
    content = fs.readFileSync(fp, "utf8");
  } catch {
    return; // file gone / unreadable — nothing to classify
  }

  const corpusPath =
    process.env.ATLAS_ECOSYSTEM_PATH ||
    path.join(os.homedir(), "Code", "Vaults", "vault-ecosystem");
  let slugs = resolveFleetSlugs(corpusPath);
  if (slugs.length === 0) slugs = FALLBACK_SLUGS;

  const flag = classifyMemory(content, fp, slugs);
  if (!flag) return;

  const entry = makeEntry(flag, fp, bodyOf(content), new Date().toISOString());
  const queue = defaultQueuePath();
  appendToQueue(entry, queue);

  const target = flag.route === "corpus" ? "the vault-ecosystem corpus" : "the repo's own CLAUDE.md";
  process.stderr.write(
    `↳ fact-routing: ${path.basename(fp)} looks like it belongs in ${target} (${flag.reason}). ` +
      `Queued in ~/.claude/.fact-routing-queue.jsonl — fold it, don't sweep later.\n`,
  );
}

try {
  main();
} catch {
  /* advisory hook — never block a tool write */
}
process.exit(0);
