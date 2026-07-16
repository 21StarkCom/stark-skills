# Retro: `remember` registered as a bifrost plugin (2026-07-16)

The `skill/remember/` vault-writer skill existed here since its authoring but
was in **no bifrost bundle's membership manifest** — so the generator never
packaged it and it could not be installed or invoked as a plugin skill. Fixed
2026-07-16: it now ships as the sole member of the new **`stark-brain`**
bundle (bifrost v0.1.0) and surfaces as **`/stark-brain:remember`**.

## What changed in this repo

**PR [#680](https://github.com/21StarkCom/stark-skills/pull/680)** (merged
`e9b5db9`) — reworded the skill's anti-secret guidance: the literal
`.private/` path (in the §3 guardrail and the HubSpot example) became
"the private-credentials store".

Why: bifrost's `stark lint --strict` CI gate fail-closes on a
`[secret-file-read]` finding for any artifact body that literally contains
`.private`, `.env`, `.aws/credentials`, and friends — even when the mention
is *anti-secret teaching*. There is no suppression mechanism, so the skill
body itself had to become lint-clean before it could ship in a bundle.

**Lesson for skill authors:** a skill destined for a bifrost bundle must not
name real secret-file paths in its body, even to warn about them. Use
role phrasing ("the private-credentials store", "the secrets manager")
instead of literal paths.

## Where the rest happened

Bundle creation, the regen pipeline, publish, web-origin deploy, and the full
gotcha list (publish.sh first-skill limitation, fake sync-drift, GAR prune)
live in the bifrost retro:
[`bifrost/docs/retros/2026-07-16-stark-brain-remember-retro.md`](https://github.com/21StarkCom/bifrost/blob/main/docs/retros/2026-07-16-stark-brain-remember-retro.md).

## Disambiguation

`/stark-brain:remember` (this skill, writes to the second-brain vault via the
brain MCP) is **not** Claude Code's native `/remember` (the harness's built-in
per-project file memory). They coexist; the namespaced form targets the vault.
