/**
 * Asset- vs. state-root resolution — the seam that lets one source tree run
 * both as install.sh symlinks (local dev) and as a self-contained Claude Code
 * plugin (marketplace distribution).
 *
 * Two distinct roots:
 *
 *   - `assetRoot()` — IMMUTABLE shipped assets: `tools/`, `prompts/`,
 *     `standards/`, `config.json`, `forge_heuristics.json`, `orchestrator.md`.
 *     In an installed plugin Claude Code sets `CLAUDE_PLUGIN_ROOT` to the
 *     plugin's cache dir, which the stark-marketplace engine populates with
 *     these assets (vendored per bundle). In local dev `CLAUDE_PLUGIN_ROOT` is
 *     unset and we fall back to the canonical `~/.claude/code-review` tree that
 *     `install.sh` symlinks into place. `STARK_ASSET_ROOT` overrides both
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

import os from "node:os";
import path from "node:path";

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v : undefined;
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

/** `assetRoot()/config.json` — the global config file. */
export function assetConfigPath(): string {
  return path.join(assetRoot(), "config.json");
}

/** `assetRoot()/prompts` — the per-agent prompt tree. */
export function assetPromptsDir(): string {
  return path.join(assetRoot(), "prompts");
}

/** `assetRoot()/tools` — the bundled TypeScript tool scripts. */
export function assetToolsDir(): string {
  return path.join(assetRoot(), "tools");
}
