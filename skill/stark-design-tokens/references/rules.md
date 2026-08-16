# Design-token rules (R1–R23)

Lintable, testable MUST / SHOULD / NEVER phrasing. Lift into a rules file
verbatim. Each rule names its basis; **house** = prescriptive synthesis, not a
spec mandate. Volatile facts date-stamped. Normative keywords per RFC 2119.

## Format

- **R1.** Tokens MUST be authored as **DTCG v2025.10** JSON (`.tokens.json`).
  Every token MUST have a `$type` that resolves (direct or inherited from an
  ancestor group). *(DTCG, stable 2025-10-28.)*
- **R2.** Color `$value`s MUST use the 2025.10 **color-object** form
  (`colorSpace` / `components` / `alpha`, optional `hex` fallback), not a bare
  hex string. Primitives SHOULD author in `oklch` with a `hex` fallback for
  out-of-gamut handling. *(DTCG 2025.10; CSS Color 4.)*
- **R3.** A shared, published token package MUST NOT be a conforming DTCG file:
  DTCG requires `$value`, and a names-only package carries none. Keep DTCG
  source in a **build-only workspace**; publish generated names. *(House;
  follows from DTCG requiring `$value`.)*

## Architecture

- **R4.** Exactly **three tiers**: primitive → semantic → component. No fourth
  tier. *(Material 3 ref/sys/comp; Primer base/functional/component; Curtis.)*
- **R5.** Components MUST NOT reference primitives. App/product code MUST NOT
  reference primitives. Primitives MUST NOT reference upward (no primitive
  aliases a semantic token — that inverts the graph and invites cycles).
  *(Primer reserves base tokens for references only.)*
- **R6.** Reference chains MUST be acyclic, MUST be ≤ 4 hops, SHOULD be ≤ 3
  (`component → semantic → primitive`). CI MUST run cycle detection and
  max-depth linting. *(House depth cap over DTCG's mandatory cycle/type checks.)*
- **R7.** A component token MUST pass the **three-part test** or be rejected in
  review: (a) *divergence* — its value must be able to differ from the generic
  semantic token; (b) *surface* — it is part of the component's public
  customization contract; (c) *multiplicity* — ≥ 2 distinct parts need
  independent theming. If none hold, consume the semantic token directly.
  *(House, from Material/Spectrum practice + Primer restraint.)*

## Naming

- **R8.** Every name MUST match one grammar:
  `[namespace]-[category](-[concept])?-[property](-[variant])?(-[state])?(-[scale])?`
  — kebab-case with a namespace prefix in emitted CSS vars (`--dr-*`), dot-path
  canonical in DTCG. Ordering is general → specific, modifiers after base, state
  after variant, scale last. *(Curtis, "Naming Tokens in Design Systems", 2020.)*
- **R9.** Semantic and component names MUST NOT contain color-value words (hue
  names, `light`/`dark` used as value descriptors) or platform names
  (`ios`/`android`/`css`). Primitive names MUST be value-based. *(Curtis;
  Primer base-vs-functional.)*
- **R10.** Platform names MUST be **generated** from the canonical dot-path by
  the build. Hand-maintaining parallel platform names is forbidden — it is drift
  by construction. *(Style Dictionary name transforms.)*
- **R11.** Categories are singular (`color`, not `colors`); states come from a
  fixed vocabulary (`hover`, `active`, `focus`, `disabled`, `selected`,
  `invalid`); abstract scales (`sm/md/lg`) at the semantic tier, numeric steps
  only where they genuinely identify a primitive. *(House; DTCG name-character
  restrictions: no `.`/`{`/`}` in a segment, case-only collisions banned.)*

## Theming & modes

- **R12.** Modes MUST flip **semantic bindings only**. NEVER fork component
  tokens per mode. NEVER create `*-dark` / `*-light` token names — the mode
  lives in the binding, the name stays singular. *(Material 3; Figma Variables
  modes.)*
- **R13.** Brand, appearance (light/dark), contrast, density, and reduced-motion
  MUST be modeled as **independent axes**, resolved in a documented deterministic
  order — never materialized as `brand×scheme×density` duplicated theme sets.
  *(Figma Variables; Tokens Studio themes/sets.)*
- **R14.** Multi-brand MUST swap the **primitive set** under a **shared semantic
  layer**; zero semantic or component edits per brand. *(Material ref/sys split;
  Primer base/functional split.)*
- **R15.** Runtime theming MUST use `[data-theme]` with a `prefers-color-scheme`
  fallback scoped to `:root:not([data-theme])`. The explicit attribute always
  wins; a theme change dispatches a `themechange` event. Set
  `color-scheme: light dark` on `:root` so native controls follow. *(House;
  Primer attribute-based theming; MDN.)*
- **R16.** Tailwind's `dark` variant MUST be redefined to key off `[data-theme]`
  via `@custom-variant` (not left on `prefers-color-scheme`); design-system
  components SHOULD consume token vars via `@theme` rather than `dark:` value
  pairs. *(Tailwind v4 custom variants, 2025.)*

## Color & accessibility

- **R17.** Color scales SHOULD be generated in a perceptually uniform space
  (**OKLCH** or **HCT**) and hand-tuned; the semantic layer SHOULD map roles onto
  **Radix-style 12-step** purpose semantics even when shipping its own values.
  *(CSS Color 4; Ottosson OKLab 2020; Radix Colors; Material HCT.)*
- **R18.** Every semantic fg/bg pair MUST declare a **contrast contract** (e.g.
  in `$extensions`) and MUST pass **WCAG 2.2 AA** (4.5:1 body, 3:1 large text /
  UI) in CI for **every** theme. APCA MAY be reported as an advisory signal; it
  MUST NOT replace WCAG 2.x conformance (APCA removed from the WCAG 3 draft in
  2023, exploratory as of 2026). For a values-free package, the contract travels
  with the names and each concrete theme runs the check. *(WCAG 2.2; Roselli
  status review 2026.)*
- **R19.** Focus-ring and motion tokens MUST exist at the semantic tier
  (`color.focus.ring`, `focus.ring.width`/`offset`, `motion.duration.*`);
  components MUST consume them rather than restyling `outline` or hardcoding
  durations ad hoc. Focus rings MUST pass 3:1 non-text contrast; motion tokens
  MUST re-bind to `0`/minimal under `prefers-reduced-motion`. Under
  `forced-colors: active` (Windows High Contrast Mode), a high-contrast theme
  SHOULD map its semantic color/border tokens to the CSS system-color keywords
  (`Canvas`, `CanvasText`, `LinkText`, `ButtonText`, `Highlight`,
  `HighlightText`) and MUST NOT paint over the user's forced palette. *(WCAG 2.2
  focus / non-text contrast; reduced-motion technique; CSS Color 4 system colors
  / `forced-colors`.)*

## Distribution (shared / restricted / CSP-constrained package)

- **R20.** A shared token package MUST contain **zero literal design values and
  zero color functions** — it ships the `TokenName` type, the name→CSS-var
  mechanics, and pure serializers (`themeToCss()` / `resolveTheme()`). Consumers
  supply values. *(House; the multi-brand + CSP payoff.)*
- **R21.** No published package may depend on anything that uses `eval` /
  `new Function` at runtime (strict-CSP and MV3 contexts forbid it). All token
  transformation — Style Dictionary, contrast math, color generation, schema
  validation — is **build-time only** and MUST stay out of the runtime dependency
  graph. *(House CSP/MV3 constraint; Style Dictionary is a build transformer.)*
- **R22.** Theme/DOM APIs (`matchMedia`, `localStorage`, `themechange`,
  DOM mutation, React theme context) MUST live in **client-only** modules.
  Server-safe exports are limited to names, types, and pure CSS-string
  generation — which is exactly why a names-only package is RSC-clean. *(Next.js
  server/client boundary.)*

## Governance

- **R23.** Token changes land only via **PR with full CI validation** (schema,
  refs, grammar, tier-leak, contrast, orphans, emitted-CSS diff). New
  tokens/themes are **MINOR**; renames/removals/tier-restructures/grammar changes
  and any change to a generated CSS-variable identity are **MAJOR**; value-only
  changes are **PATCH** unless visually drastic (breaking by policy). A rename
  MUST follow **alias → `$deprecated` → codemod → removal at next MAJOR**, never
  a hard delete. Token reference docs + the contrast report MUST be generated from
  the same source. *(SemVer public-API model; DTCG `$deprecated`; Primer/Atlassian
  deprecation practice.)*
