---
name: stark-design-tokens
description: >-
  Build, name, theme, and govern design tokens the way the field's canonical
  sources converge on. Use when creating or restructuring a design-token system,
  a tokens package, or a theming layer — the three-tier model
  (primitive/semantic/component), the naming grammar, OKLCH color scales, DTCG
  authoring, Style Dictionary pipelines, dark-mode / multi-brand / density
  theming, CSS-variable distribution, WCAG contrast gates, and token
  semver/deprecation. Triggers: "design tokens", "token architecture", "semantic
  tokens", "theme tokens", "dark mode tokens", "DTCG", "Style Dictionary", "token
  naming", "multi-brand theming", "unified tokens".
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose and
the three reference files below, then stop. This skill takes no arguments — it is
guidance loaded into the turn, not a CLI wrapper.

# stark-design-tokens

How to build a **unified, multi-theme, multi-brand design-token system** —
taxonomy, naming, color, format, tooling, distribution, and governance — distilled
into rules you can enforce. It is the common denominator of the **W3C Design
Tokens Community Group spec**, Style Dictionary, Figma Variables / Tokens Studio,
and the vendor systems that converged independently (Material 3, Primer, Spectrum,
Radix, Carbon, Atlassian), cross-checked against Nathan Curtis's naming taxonomy
and the CSS Color 4 / WCAG accessibility baselines. Compiled 2026-08; volatile
claims are date-stamped in the references.

## When to use

Reach for this before writing the first token, the first `--var`, or the first
`tokens/*.json` — and before answering a "how should we name / tier / theme this"
question. It applies whether you are standing up a token package from scratch,
adding a semantic layer to a pile of hardcoded values, wiring dark mode, splitting
a palette across brands, or deciding what a token release may break.

## The model in one screen

**Three tiers, and only three.** More is architecture theater; fewer removes the
theming seam.

| Tier | Holds | May reference | Consumed by |
|---|---|---|---|
| **primitive** (core/base) | Raw palette + scales: `blue.600`, `space.4`. **Value-named — legal only here.** | other primitives | semantic tier only |
| **semantic** (system/alias) | Role decisions: `color.text.danger`, `surface.raised`, `focus.ring`. **The theming seam and the public API.** | primitives, once another semantic | app + component code |
| **component** | `button.primary.bg`, `input.border.invalid`. | semantic only | the owning component |

**The load-bearing rules** (full, lintable form in `references/rules.md`):

1. Author in **DTCG JSON v2025.10** (stable since 2025-10-28). Don't hand-roll a format.
2. **Exactly three tiers.** Components consume **semantic only** — a component touching a primitive is a lint error.
3. **Modes flip the semantic binding, never component code.** Dark, brand, density, contrast are orthogonal axes resolved at the semantic tier. Flip the wrong tier and the theme matrix goes multiplicative.
4. **Name by role, never by value, in the semantic tier.** `color.text.danger`, not `color.red.600`. Value-names live only in primitives.
5. **One naming grammar, mechanically enforced,** generated from one canonical dot-path. Never hand-maintain parallel platform names.
6. **Reference depth ≤ 3 (SHOULD), ≤ 4 (MUST), acyclic (MUST).** `component → semantic → primitive`.
7. **Generate color scales in OKLCH** (or HCT), hand-tune, and adopt **Radix's 12-step role** semantics even with your own values.
8. **Contrast is a build-time invariant, not a review-time check.** Every semantic fg/bg pair asserted ≥ **WCAG 2.2 AA** in CI, per theme. APCA advisory-only — never the sole gate (removed from the WCAG 3 draft in 2023, still exploratory).
9. **The runtime carrier is plain CSS custom properties.** All transformation is build-time; nothing that evaluates code ships to the client. CSP-safe by construction.
10. **`[data-theme]` is authoritative over `prefers-color-scheme`.** Explicit attribute wins; system preference is fallback, scoped to `:root:not([data-theme])`.
11. **Reconcile Tailwind** by redefining its `dark` variant against `[data-theme]` via `@custom-variant`, and register token vars in `@theme` so Tailwind consumes the token layer instead of competing with it.
12. **Ship token names, not values, when the package is shared.** A names-and-mechanics package (zero literals) is RSC- and CSP-clean, keeps palette out of every consumer bundle, and makes multi-brand a swap at the package boundary.
13. **Version token names as public API.** Additions MINOR, renames/removals MAJOR, value-only nudges PATCH — but a visually drastic value change is breaking by policy regardless.
14. **Deprecate by alias, never by deletion.** A renamed token emits both names for one MAJOR cycle, carries `$deprecated`, and ships a codemod.
15. **Validate every change in CI:** DTCG schema, reference integrity (no orphans, no cycles, depth cap), naming-grammar lint, tier-leak lint, contrast assertions, and an emitted-CSS visual diff.

## How to use this skill

1. **Read `references/rules.md`** — the MUST/SHOULD/NEVER ruleset (R1–R23), lintable and testable. This is what a reviewer checks a token PR against, and what a `rules` file lifts verbatim.
2. **Read `references/reference.md`** for the decision-grade detail behind each rule: the DTCG object model, the tier-flip matrix, the naming grammar with worked names, the color deep-dive, an annotated DTCG snippet, a Style Dictionary pipeline, the CSS-variable + Tailwind + RSC distribution model, the semver/deprecation flow, the ranked anti-patterns, and a build-from-scratch checklist.
3. **Cite from `references/bibliography.md`** when a recommendation is challenged — sources are tiered by authority (spec / origin canon / reference tooling / vendor precedent / color science).

## Non-negotiables

If you take nothing else: **a semantic layer exists and components never skip it**;
**names describe roles, not values**; **modes re-bind the semantic tier, they do
not fork components**; and **color/contrast math is build-time, the runtime is CSS
variables**. Every catastrophic token-system failure in the wild is one of those
four rules broken.

## Provenance

This skill is the synthesis of **three independent deep-research passes** (Claude,
ChatGPT, Qwen; 2026-08) over the same brief, which converged almost completely.
The two genuine divergences are resolved in the rules: reference depth is **≤ 3
SHOULD / ≤ 4 MUST**, and a shared **names-only package is deliberately NOT a
conforming DTCG file** (DTCG requires `$value`) — its DTCG source lives in a
build-only workspace and it publishes generated names. Do not re-litigate these.
