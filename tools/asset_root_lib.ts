/**
 * Asset- vs. state-root resolution — the seam that lets a skill/tool resolve
 * its shipped assets whether it runs inside a self-contained Claude Code plugin
 * (marketplace distribution) or via a direct, non-plugin invocation.
 *
 * Two distinct roots:
 *
 *   - `assetRoot()` — IMMUTABLE shipped assets: `tools/`, `prompts/`,
 *     `standards/`, `config.json`, `forge_heuristics.json`, `orchestrator.md`.
 *     In an installed plugin Claude Code sets `CLAUDE_PLUGIN_ROOT` to the
 *     plugin's cache dir, which the stark-marketplace engine populates with
 *     these assets (vendored per bundle). For direct (non-plugin) invocations
 *     `CLAUDE_PLUGIN_ROOT` is unset and we fall back to the canonical
 *     `~/.claude/code-review` tree. `STARK_ASSET_ROOT` overrides both
 *     (tests / unusual layouts).
 *
 *   - `stateRoot()` — MUTABLE runtime state: `history/`, `sessions/`,
 *     `staged/`, `dashboard/`, `locks/`, `logs/`, alerts, healer + cost ledgers.
 *     This ALWAYS lives under the user's real home (`~/.claude/code-review`),
 *     never inside a plugin dir — plugin caches are replaced wholesale on
 *     update, so state kept there would be lost and would not be shared across
 *     bundles. `STARK_STATE_ROOT` overrides (tests).
 *
 * Both default to the same `~/.claude/code-review` path, so behaviour is
 * identical to the pre-plugin world whenever `CLAUDE_PLUGIN_ROOT` is unset —
 * the live symlink dev loop is unaffected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v : undefined;
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Pick the first candidate that exists (as a directory), else the last
 * candidate as a back-compat fallback. The fallback preserves the historical
 * behaviour for callers (and tests) that expect a concrete path even when no
 * layout is present on disk yet.
 */
function firstExistingDir(candidates: readonly string[], fallback: string): string {
  for (const c of candidates) {
    if (existsDir(c)) return c;
  }
  return fallback;
}

function firstExistingFile(candidates: readonly string[], fallback: string): string {
  for (const c of candidates) {
    if (existsFile(c)) return c;
  }
  return fallback;
}

/** Canonical home tree: `~/.claude/code-review`. */
function homeCodeReview(): string {
  return path.join(os.homedir(), ".claude", "code-review");
}

/**
 * Root for immutable, shipped assets (tools, prompts, standards, config.json).
 * Precedence: `STARK_ASSET_ROOT` > `CLAUDE_PLUGIN_ROOT` > `~/.claude/code-review`.
 */
export function assetRoot(): string {
  return (
    nonEmpty(process.env.STARK_ASSET_ROOT) ??
    nonEmpty(process.env.CLAUDE_PLUGIN_ROOT) ??
    homeCodeReview()
  );
}

/**
 * Like `assetRoot()` but for call sites that already resolve their own `home`
 * (typically for test injection via an explicit `opts.home`). Honours the
 * plugin/asset overrides first, then falls back to `<home>/.claude/code-review`
 * rather than `os.homedir()` — so existing tests that pass a temp `home` keep
 * working unchanged when no plugin env is set.
 */
export function assetRootForHome(home: string): string {
  return (
    nonEmpty(process.env.STARK_ASSET_ROOT) ??
    nonEmpty(process.env.CLAUDE_PLUGIN_ROOT) ??
    path.join(home, ".claude", "code-review")
  );
}

/**
 * Root for mutable runtime state (history, sessions, locks, logs, ledgers).
 * Precedence: `STARK_STATE_ROOT` > `~/.claude/code-review`. Deliberately does
 * NOT consult `CLAUDE_PLUGIN_ROOT` — state must outlive plugin-cache churn.
 */
export function stateRoot(): string {
  return nonEmpty(process.env.STARK_STATE_ROOT) ?? homeCodeReview();
}

/**
 * The shipped global config file. Layout-robust: the install.sh symlink tree
 * and the vendored marketplace plugin keep it FLAT at `<assetRoot>/config.json`
 * (the marketplace engine drops the `global/` layer when bundling — see
 * `stark-marketplace/engine/internal/importer/vendor.go`), but a raw source
 * checkout keeps it under `<assetRoot>/global/config.json`. Try the flat layout
 * first, then the source layout, then fall back to the flat path for
 * back-compat when neither exists on disk yet.
 */
export function assetConfigPath(): string {
  const root = assetRoot();
  const flat = path.join(root, "config.json");
  return firstExistingFile([flat, path.join(root, "global", "config.json")], flat);
}

/**
 * The per-agent prompt tree. Layout-robust for the same reason as
 * `assetConfigPath()`: flat `<assetRoot>/prompts` in the symlink tree and the
 * vendored plugin, `<assetRoot>/global/prompts` in a raw source checkout. Try
 * flat first, then source, then fall back to flat.
 */
export function assetPromptsDir(): string {
  const root = assetRoot();
  const flat = path.join(root, "prompts");
  return firstExistingDir([flat, path.join(root, "global", "prompts")], flat);
}

/** `assetRoot()/tools` — the bundled TypeScript tool scripts. */
export function assetToolsDir(): string {
  return path.join(assetRoot(), "tools");
}
