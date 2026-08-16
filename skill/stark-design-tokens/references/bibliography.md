# Annotated bibliography

Sources grouped by authority tier. Cite from here when a rule is challenged.
Prefer the primary source (spec, the people who coined the term, official docs)
over blog aggregations. Volatile items are date-stamped.

## Spec & standards authority (highest)

- **W3C Design Tokens Community Group — Design Tokens Format Module, v2025.10.**
  First **stable** version (2025-10-28). Authoritative for `$value`, `$type`,
  groups, aliases/references, composites, `$extensions`, `$deprecated`, resolution
  and error conditions. Use this, not pre-2025 community drafts. A Community Group
  Final Report, not yet a W3C Recommendation.
- **W3C CSS Working Group — CSS Color Module Level 4.** Standards basis for
  `oklch()`/`oklab()` and the perceptual-lightness case over HSL-like spaces.
- **W3C WAI — WCAG 2.2, Understanding Contrast (Minimum / Non-text Contrast /
  Focus Appearance).** The operative, enforceable contrast target in 2026
  (4.5:1 body, 3:1 large text / UI / focus).
- **W3C WAI — WCAG 3 Working Draft.** Read to avoid premature claims: APCA was
  removed from it in July 2023; WCAG 3 is not expected to reach Recommendation
  before ~2028–2030.

## Origin & taxonomy canon (high)

- **Jina Anne & Jon Levine (Salesforce, ~2014–2016).** Coined "design tokens"
  (credited by the DTCG repo itself); Lightning Design System is the origin
  articulation of "design decisions as data" + the cross-platform pipeline (Theo).
- **Nathan Curtis / EightShapes — "Naming Tokens in Design Systems" (2020)** and
  "Tokens in Design Systems". The most-cited naming/taxonomy framework
  (namespace / object / base / modifier ordering; promote local decisions after
  ~3-component reuse). Basis of the naming grammar.
- **Brad Frost — Atomic Design (2013→).** The tiering mental model tokens inherit
  (atoms ≈ primitives; the semantic tier is the system's reusable vocabulary).
  Conceptual, not the interchange authority.

## Reference tooling & design-side models (high)

- **Style Dictionary — docs + releases (styledictionary.com; GitHub).** Canonical
  build tool (Amazon origin; Tokens Studio-maintained since ~2023). v4 (2024)
  first-class DTCG; v5 (2025) DTCG 2025.10 base, `color/oklch`, Node ≥ 22; latest
  v5.5.1 (2026-08-07), full-2025.10 coverage still in-progress — verify per feature.
- **Figma — Variables / Modes docs + Schema 2025 announcements.** Collections ≈
  tiers, modes ≈ mode axes; native DTCG import/export rolling out from late
  Nov 2025.
- **Tokens Studio — Themes / token-sets / remote Git-sync docs.** Multidimensional
  token sets/themes; first-party pipeline guidance (main SD contributor).
- **next-themes (GitHub).** Reference implementation of the boot-script /
  no-FOUC / `[data-theme]` pattern for React/Next.

## Vendor-system precedent

- **Google Material Design 3 (m3.material.io).** Clearest large-scale three-tier
  precedent (`ref`/`sys`/`comp`); **HCT** dynamic-color model; tone-difference
  predicts contrast — the strongest "contrast by construction" example.
- **GitHub Primer.** Strong authority for base→functional→limited-component
  tokens, naming discipline, and theme-aware functional roles via data attributes.
- **Adobe Spectrum.** Precedent for status/semantic color naming (informative /
  accent / negative / notice / positive) — meaning, not raw hue.
- **Radix Colors / Themes.** The 12-step *role* model (backgrounds / borders /
  solids / text); APCA-informed scale design. Best compact step-purpose precedent.
- **IBM Carbon, Atlassian Design System, Shopify Polaris.** Convergent evidence
  for role-named semantic layers, component-token restraint, typed CSS-var access,
  and deprecation-by-alias + codemod release practice. (Older `polaris-tokens`
  material is legacy — don't drive new architecture from it.)
- **Tailwind CSS v4 docs (2025).** `@custom-variant dark`, `@theme` — the official
  reconciliation hooks for a `[data-theme]` protocol. A consumer/integration
  layer, not the token ontology.

## Color science & contrast

- **Björn Ottosson — "OKLab" (2020).** The perceptual space underlying OKLCH.
- **Sitnik & Turner — "OKLCH in CSS" (Evil Martians, 2022→).** The widely-cited
  practitioner case for OKLCH palettes.
- **Google — HCT color space / Material Color Utilities.** Implementation
  authority for HCT and Material dynamic color; tone↔contrast linkage.
- **Adrian Roselli — "WCAG 3 Contrast as of April 2026" (adrianroselli.com).**
  The definitive running status of APCA/WCAG 3 and the dual-conformance risk
  guidance (use APCA only *on top of* WCAG 2 conformance).
- **Myndex / APCA documentation (Andrew Somers).** The algorithm itself — read as
  a proposal, not a standard.

## Adoption context (secondary)

- **zeroheight design-systems surveys (2025–2026).** Token-adoption trend data;
  useful context, not architecture guidance.
