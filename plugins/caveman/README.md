# caveman

Vendored copy of [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — an
ultra-compressed communication mode. Makes the agent answer in terse caveman-style prose:
~65–75% fewer output tokens, full technical accuracy kept.

Synced from `~/Code/Public/caveman` (skills, hooks, agents, commands). Claude Code and
Codex only — the upstream Gemini / Cursor / Windsurf / Cline distribution paths were
left behind on purpose.

## What's here

- `skills/` — all 7 caveman skills (`caveman`, `caveman-commit`, `caveman-review`,
  `caveman-compress`, `caveman-help`, `caveman-stats`, `cavecrew`)
- `hooks/` — Claude Code SessionStart + UserPromptSubmit hooks (auto-activation, mode
  tracking, `/caveman-stats`, statusline badge)
- `agents/` — `cavecrew-*` subagents (investigator / builder / reviewer)
- `commands/` — Codex/Gemini TOML command stubs (`/caveman`, `/caveman-commit`, `/caveman-review`)
- `.claude-plugin/plugin.json` — Claude Code manifest (wires the hooks)
- `.codex-plugin/plugin.json` — Codex manifest (points at `skills/`)

## Use

- **Claude Code** — installed via the stark-skills marketplace (`./install.sh` symlinks
  `plugins/caveman` → `~/.claude/plugins/caveman`). SessionStart hook injects the ruleset;
  type `/caveman` or say "talk like caveman", stop with "normal mode".
- **Codex** — the `.codex-plugin/` manifest and `commands/*.toml` stubs make caveman
  discoverable; trigger with `/caveman` per session.

## Levels

`/caveman lite` (drop filler) · `/caveman` / `/caveman full` (default) · `/caveman ultra`
(telegraphic) · `/caveman wenyan` (classical Chinese, shortest).

## Note on caveman-compress

Upstream ships `caveman-compress` as Python. This copy is **ported to TypeScript**
(`skills/caveman-compress/scripts/*.ts`) to satisfy the stark-skills no-Python rule.
The scripts run dependency-free via `node --experimental-strip-types` (Node ≥ 22.6) —
no `npm install`, no tokenizer library. Behavior matches the Python original.

## Updating

Re-copy from `~/Code/Public/caveman`: `skills/` (except `caveman-compress/scripts/`,
which is the local TS port — diff carefully before overwriting), `agents/cavecrew-*.md`,
`commands/caveman*.toml`, and the runtime files from `src/hooks/`. Do not edit the
copied skills/hooks here — upstream is the source of truth for everything except the
`caveman-compress` script port.
