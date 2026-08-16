# Design tokens — decision-grade reference

The detail behind `rules.md`. Compiled 2026-08 from three convergent
deep-research passes; volatile claims date-stamped. Sources: `bibliography.md`.

---

## 1. Canonical model & definitions

The term was coined by **Jina Anne and Jon Levine at Salesforce** (Lightning
Design System, ~2014); the DTCG repository credits them directly. A design token
is the **indivisible, named design decision** of a system — a color, a space
step, a type ramp — stored platform-agnostically so one source drives every
platform. It is a *methodology*, not merely a file format: the DTCG standardizes
**exchange** and deliberately leaves taxonomy, naming, and governance to the team.
That gap is what a token ruleset fills.

| Thing | What it is | Test |
|---|---|---|
| **Design token** | A named decision with meaning, `$type`, and lineage | Has a role-bearing name, a type, and lives in the token source of truth |
| **Variable** | A carrier (CSS custom property, Figma Variable, TS const) | A token is *carried by* variables; a variable with no semantic contract is not a token |
| **Literal** | `#3b82f6` in a component | Anti-pattern outside the primitive tier — undiscoverable, un-themeable, unauditable |

### The DTCG object model (v2025.10, stable since 2025-10-28)

First **stable** version, developed by 20+ editors from Adobe, Amazon, Google,
Microsoft, Figma, Salesforce, Tokens Studio. Guidance predating late 2025 that
calls it "a moving draft" is stale — it is safe to standardize on. It is a W3C
Community Group Final Report, not yet a Recommendation.

- A **token** is a JSON object with `$value` (required) and a `$type` (direct or
  inherited from an ancestor group). Tools MUST NOT guess type from the value.
- The **`$` prefix** separates spec keys from token/group names, so arbitrary
  names never collide with keywords.
- **Optional metadata:** `$description` (documentation/tooltips), `$deprecated`
  (boolean or explanatory string), `$extensions` (namespaced, reverse-domain
  keys, e.g. `"is.example.contrast"` — vendor data the spec won't standardize;
  never hide load-bearing behavior here).
- **Groups** nest and pass down `$type`; they are **organizational only** — the
  spec attaches no semantics to group names, so your *tiers are a methodology
  layered on top*, not something generic tooling can infer.
- **Aliases:** `"$value": "{color.primitive.blue.600}"` — curly-brace dot-path,
  whole-token. **JSON Pointer `$ref`** addresses document/property level; prefer
  whole-token aliases (easier to audit) and reserve pointers for composites.
  Tools MUST detect unresolved targets, cycles, and type mismatches.
- **Types:** `color`, `dimension`, `fontFamily`, `fontWeight`, `duration`,
  `cubicBezier`, `number`, plus **composites**: `typography`, `shadow`, `border`,
  `transition`, `gradient`, `strokeStyle` (structured `$value`, sub-values may be
  references).
- **2025.10 color model:** `$value` is an **object** — `colorSpace`, `components`,
  `alpha`, optional `hex` fallback — across 14 spaces incl. `oklch` and
  `display-p3`. The bare-hex string is legacy. This is what makes an OKLCH-first
  pipeline first-class.
- **2025.10 dimension model:** `{"value": 4, "unit": "px"}` object form.

**What it mandates vs leaves open:** mandates file shape, types, reference syntax,
error conditions. Silent on tiers, naming, theming strategy, and build tooling.

---

## 2. Architecture & tiers

Every major system converges on three tiers under different names:

| Tier | generic / Curtis | Material 3 | Primer | Contents |
|---|---|---|---|---|
| 1 | **primitive** (core/base) | `md.ref.*` | base/scale | Raw palette + scales, value-named, no usage opinion |
| 2 | **semantic** (alias/system) | `md.sys.*` | functional | Role decisions — **the theming seam + public API** |
| 3 | **component** | `md.comp.*` | component | Per-part roles; aliases into tier 2 |

**Leakage rules (MUST):** primitives referenced only by semantic tokens (and by
other primitives for derived scales); semantic references primitives or (once)
another semantic; component references semantic only; app code consumes semantic +
component, **never** primitives; no upward references.

### Component-token decision test

The field genuinely splits here. **Camp A** (Material, Spectrum, Atlassian at
scale): component tokens are the re-skin contract and document per-part intent.
**Camp B** (many smaller systems): they multiply token count 5–10× and mostly
restate the semantic layer. **Default:** create a component token only if **all
three** hold — *divergence*, *surface*, *multiplicity* (see R7). Otherwise consume
the semantic token directly. Keep tier 3 sparse; that is what Material does in
practice.

### Aliasing depth

≤ 3 hops SHOULD, ≤ 4 MUST, acyclic MUST. Long chains fail three ways, all seen in
the wild: **debuggability** ("why is this pink" walks N files); **tool round-trip
drift** (Figma flattens aliases differently than Style Dictionary
`outputReferences`); **mode explosion** (each hop is a place a mode *could* flip).

### Which tier flips per mode (the matrix)

| Mode axis | Flips at | Never flips | Why |
|---|---|---|---|
| Light / dark | primitive→semantic binding | component tokens, component code | Dark mode re-maps roles to the palette, not a palette per component |
| Brand (multi-brand) | the primitive set (+ small semantic overlay) | semantic names, components | Shared semantic vocabulary is the whole point |
| Density / size | dimension primitives→semantic spacing binding | color tokens | Orthogonal; must not entangle with color |
| High contrast | semantic fg/bg/border bindings (sometimes stroke width) | primitives, component APIs | Re-select which primitives satisfy the target |
| Reduced motion | semantic motion tokens → 0/short | easing primitives | Driven by `prefers-reduced-motion` |
| Component variant | component tier (only when justified) | global semantic system | A button variant is not a global theme axis |

Flip the wrong tier and the matrix goes multiplicative: dark mode forking
*component* tokens = N components × M themes authored values; flip at the semantic
seam and it is just M semantic sets.

---

## 3. Naming grammar

Based on Nathan Curtis's levels (namespace / object / base / modifier) collapsed
into one ordered pattern:

```
[namespace] -[category]-[concept?]-[property] -[variant?]-[state?] -[scale?]
 (system)      (base: what it is)               (modifiers: which one, when)
```

- **namespace** — system prefix (`dr`), MUST appear on emitted CSS vars (`--dr-*`)
  to survive host-page/extension collisions; MAY be implicit in DTCG paths.
- **category** — `color | space | size | font | radius | shadow | motion | z | border`.
- **concept** — optional role group: `text`, `surface`, `border`, `action`, `feedback`.
- **property** — the terminus: `bg`, `fg`, `ring`, `gap`, `weight`.
- **variant** — `primary`, `danger`, `subtle`, `inverse`.
- **state** — `hover`, `active`, `focus`, `disabled`, `selected`, `invalid`.
- **scale** — `100…1200`, `sm/md/lg`, `1…12`.

**Canonical form is the DTCG dot-path** (`color.text.danger`); CSS kebab with
`--dr-` prefix and TS camelCase/nested-object are **generated** from it.

### Worked names

| Token (CSS var `--dr-…`) | Tier | Note |
|---|---|---|
| `color-blue-600` | primitive | value-name correct **only here** |
| `color-neutral-1100` | primitive | ~Radix 12-step |
| `color-surface-default` | semantic | app background |
| `color-surface-raised` | semantic | cards/popovers |
| `color-text-primary` | semantic | foreground role |
| `color-text-danger` | semantic | status role, aliases a red step |
| `color-border-subtle` | semantic | Radix step 6 role |
| `color-action-bg-hover` | semantic | action + state |
| `color-focus-ring` | semantic | a11y-critical |
| `space-200` | primitive | 4px-base numeric |
| `space-inset-md` | semantic | padding role |
| `space-stack-sm` | semantic | vertical-rhythm role |
| `font-size-300` | primitive | type-scale step |
| `font-heading-lg` | semantic | typography composite |
| `radius-interactive` | semantic | buttons/inputs share |
| `shadow-overlay` | semantic | shadow composite |
| `motion-duration-fast` | semantic | flips under reduced motion |
| `z-overlay` | semantic | z-index band, not a raw int |
| `button-primary-bg` | component | passes the §2 test |
| `input-border-invalid` | component | independently themeable |

### Casing, delimiters, pluralization

Singular everywhere; one delimiter meaning per platform (never mix `-`/`_`
semantically); abbreviations only from a fixed whitelist (`bg`, `fg`, `sm/md/lg`,
`z`); numeric scales in 3-digit hundreds with room to insert.

### Anti-patterns (NEVER)

Value-named semantics (`--text-blue` that resolves white in dark mode — the single
most common flagged pattern; it breaks silently the moment a dark value is
assigned); platform in the name (`color-ios-primary`); ambiguous scales (mixing
`sm/md/lg` and `1/2/3` in one category); unscoped globals (`--primary` in a
package that runs inside arbitrary host pages — an outright hazard in an extension
context); state encoded as a primitive-value suffix (`blue-600-hover`).

---

## 4. Color deep-dive

**Consensus (2022→):** generate scales in a perceptually uniform space —
**OKLCH** (Ottosson's OKLab in polar form, standardized in CSS Color 4, all
evergreen browsers since 2023) or **HCT** (Google's hue/chroma/tone for Material's
tonal palettes) — then hand-tune. Pure hand-picking doesn't scale to N hues × 12
steps × modes; pure generation ships perceptual duds at gamut edges. Equal
lightness steps *look* equal across hues, so `blue-600` and `red-600` carry
equal visual weight — HSL's `L` famously does not. **HCT's tone even predicts
contrast** (tone Δ40 ≈ 3:1, Δ50 ≈ 4.5:1) — the strongest existing example of
*contrast by construction*.

**2026 note:** DTCG 2025.10 color objects support `oklch` natively and Style
Dictionary v5 ships a `color/oklch` transform with hex-fallback handling — an
OKLCH-first source with hex fallbacks is now a fully standard pipeline.

### Radix 12-step role model (adopt the semantics)

| Steps | Role |
|---|---|
| 1–2 | App background, subtle background |
| 3–5 | Component backgrounds: normal, hover, active/selected |
| 6–8 | Borders: subtle, interactive, strong/hover |
| 9–10 | Solid backgrounds (9 = highest-chroma brand solid), hover |
| 11–12 | Low-contrast text, high-contrast text |

Your semantic layer maps role → step (`color-border-subtle` → step 6 of a hue),
so a hue swap re-themes everything coherently.

### Semantic color vocabulary (minimum)

`surface` (default/raised/sunken/overlay), `text`
(primary/secondary/muted/inverse/on-accent), `border` (subtle/default/strong),
`ring` (focus), `accent` (bg/fg/hover/active), and **feedback**
`info | success | warning | danger` (each bg/fg/border). Every one aliases a
primitive; none contains a literal.

### Contrast baked in

WCAG 2.2 AA is the operative standard in 2026 (DOJ ADA, European Accessibility
Act). APCA — perceptual, accounts for size/weight/polarity, genuinely better at
dark-mode and thin-font failure detection — was **removed from the WCAG 3 working
draft in July 2023** and remains exploratory; WCAG 3 isn't expected to reach
Recommendation before ~2028–2030. **Default:** MUST pass WCAG 2.x per theme in CI;
SHOULD additionally report APCA Lc as advisory on top of (never instead of) WCAG
conformance. Encode which pairs are contracts as data.

### Dark mode & multi-theme as modes

Dark mode is a **mode of the semantic tier**: the same names re-bind to different
primitive steps (Radix's near-mirrored scales make `step 11` text work in both).
NEVER fork values per component; NEVER author `color-text-primary-dark`.

---

## 5. Format & references

### Source of truth

Recommended for a code-governed monorepo: **DTCG JSON in the repo is canonical;
design tools import it** (Figma Variables now imports/exports DTCG natively rolling
out from late Nov 2025; Tokens Studio has Git sync). The "single writer" rule
matters more than which side wins — Figma and JSON edited independently is
unresolvable drift no format fixes.

- **Authoring authority:** DTCG JSON in version control.
- **Design representation:** Figma Variables / Tokens Studio (synchronized view).
- **Published contract:** the names + mechanics package.
- **Concrete values:** consumer-generated CSS/theme artifact.

### Annotated DTCG snippet (v2025.10)

```jsonc
{
  "color": {
    "$type": "color",                       // inherited by descendants
    "primitive": {
      "blue": {
        "600": {
          "$value": {                        // 2025.10 color object, not a hex string
            "colorSpace": "oklch",
            "components": [0.62, 0.19, 250],
            "alpha": 1,
            "hex": "#3b6fe0"                 // sRGB fallback for out-of-gamut
          }
        }
      }
    },
    "text": {
      "danger": {
        "$value": "{color.primitive.red.1100}",   // whole-token alias
        "$description": "Error text on default surfaces.",
        "$extensions": {
          "is.example.contrast": { "onto": "color.surface.default", "min": 4.5 }
        }
      }
    }
  },
  "font": {
    "heading-lg": {
      "$type": "typography",                 // composite
      "$value": {
        "fontFamily": "{font.family.sans}",
        "fontSize":   { "value": 24, "unit": "px" },   // dimension object
        "fontWeight": 650,
        "lineHeight": 1.2
      }
    }
  },
  "legacy-token": {
    "$type": "color",
    "$deprecated": "Renamed to color.text.danger in v3.0.0.",
    "$value": "{color.text.danger}"          // deprecation-by-alias
  }
}
```

---

## 6. Tooling & the build pipeline

**Style Dictionary** (originated at Amazon; Tokens Studio-maintained since ~2023)
is the reference build tool. **v4 (2024)** brought first-class DTCG; **v5 (2025)**
adopts DTCG 2025.10 as its base — color objects across 14 spaces, `color/oklch`
transform, dimension objects, `.tokens.json`, Node ≥ 22, references restricted to
real tokens. Latest is **v5.5.1 (2026-08-07)**; the SD docs still flag full-2025.10
coverage as in-progress, so **pin a reviewed v5.x and regression-test the exact
token types/transforms you use** — "DTCG-compatible" is not "every feature
round-trips".

Pipeline: **parsers** → **preprocessors** → **transforms** (name / value /
attribute, grouped into transform groups like `css`) → **formats** → per-**platform**
config, with `outputReferences` preserving aliases as `var(--…)` in CSS output.

```js
// build/tokens.config.mjs — runs in CI/Node only; nothing here ships to the client
export default {
  source: ['tokens/**/*.tokens.json'],
  platforms: {
    css: {
      transformGroup: 'css',
      prefix: 'dr',                                   // --dr-* namespace
      buildPath: 'dist/css/',
      files: [
        { destination: 'theme-light.css', format: 'css/variables',
          options: { outputReferences: true, selector: ':root, [data-theme="light"]' } },
        { destination: 'theme-dark.css',  format: 'css/variables',
          options: { outputReferences: true, selector: '[data-theme="dark"]' } },
      ],
    },
    tsNames: {                                        // names-only artifact for the package
      transformGroup: 'js',
      buildPath: 'dist/ts/',
      files: [{ destination: 'token-names.ts',
                format: 'typescript/token-names' /* custom: emits the TokenName union +
                dot-path→CSS-var map, ZERO values */ }],
    },
    android: {
      transformGroup: 'android',
      buildPath: 'dist/android/',
      files: [{ destination: 'tokens.xml', format: 'android/resources' }],
    },
  },
};
```

Split the outputs: CSS + native **values** belong to a concrete theme build; the
names-only TS output belongs to the shared package. Style Dictionary is a compiler
in the build/theme pipeline, **not** imported by browser code.

### CI validation gates (every change — MUST)

1. **DTCG schema** conformance (an official JSON Schema is still being explored —
   implement the subset you rely on, don't bolt on a validator that introduces
   dynamic code).
2. **Reference integrity:** all aliases resolve; no cycles; depth ≤ 4.
3. **Naming lint** (grammar regex) + **tier-leak lint** (a component file may only
   reference `semantic.*`, etc.).
4. **Contrast assertions** from the pair contracts, per theme.
5. **Orphan detection** (core referenced nowhere; component with no owner);
   removed-name detection fails unless MAJOR.
6. **Emitted-CSS snapshot/visual diff** between base and PR.

Keep out of the **runtime** path: schema validators that compile, client color
computation, CSS-in-JS runtimes that use `new Function`. Style Dictionary,
culori/colorjs.io (build-time contrast math), and DTCG JSON have zero runtime
footprint.

---

## 7. Distribution into code (web-first)

### CSS custom properties as the carrier

```css
:root, [data-theme="light"] { /* consumer light values */ }
[data-theme="dark"]         { /* consumer dark values */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { /* system-dark fallback ONLY while no explicit theme wins */ }
}
```

Explicit `[data-theme]` always beats the media query — that precedence is the
contract. Set `color-scheme: light dark` on `:root` so form controls/scrollbars
follow.

**Boot / FOUC:** an inline `<head>`-blocking script reads the stored preference
and sets `document.documentElement.dataset.theme` before first paint, dispatching
`themechange` on switch (the next-themes pattern). Under strict CSP the inline
script is allowed via nonce/hash — it is static string code, not `eval`, so it is
CSP-compatible. **MV3 note:** extension pages forbid inline/remote-injected code —
ship the boot script as a packaged static file there.

**Precedence:** server-known explicit preference → persisted browser preference →
system preference → documented default.

### Tailwind reconciliation (the `dark:` vs `data-theme` answer)

Tailwind v4 keys `dark:` off `prefers-color-scheme` by default; redefine it so
explicit `[data-theme]` wins and system is fallback:

```css
@import "tailwindcss";
@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) { @slot; }              /* explicit wins */
  @media (prefers-color-scheme: dark) {
    &:where(:not([data-theme] *):not([data-theme])) { @slot; }                /* system fallback */
  }
}
```

Stronger rule: app code should **rarely need `dark:` at all** — components consume
semantic vars (register them in Tailwind `@theme` so `bg-surface` resolves to
`var(--dr-color-surface-default)`), and the vars flip themselves. `dark:` remains
for one-off per-mode layout tweaks. If a host toggles the theme by writing
`dataset.theme` alone, it must also **dispatch `themechange`** — any component that
*branches* on a theme hook (reading the DOM via `useSyncExternalStore`) holds the
old value otherwise.

### Typed names, zero values

Why a names-and-mechanics package is defensible: (1) consumers can't couple to
literals, so palette changes aren't breaking; (2) no palette bloat per bundle;
(3) values stay swappable per consumer (multi-brand at the package boundary);
(4) trivially RSC- and CSP-safe — the runtime is string lookup and static objects.
Emit: the `TokenName` union, `tokenVar(name) → var(--dr-…)`, `themeToCss(theme)`
building a static CSS string by **concatenation** (no evaluation), and
`resolveTheme()` reading DOM state client-side only. `resolveTheme()` /
`themeToCss()` MUST be pure — take all environmental inputs as arguments, never
touch `eval` / `new Function` / a dynamically compiled schema.

### RSC / server-safe split

| API | Server-safe? | Rule |
|---|---|---|
| Token-name constants/types | Yes | plain static data |
| `tokenVar()` | Yes | pure string construction |
| static alias/name tables | Yes | plain immutable data |
| `resolveTheme()` / `themeToCss()` | Yes if pure | all inputs as arguments |
| `getSystemTheme()` (`matchMedia`) | No | client-only |
| localStorage persistence | No | client-only |
| `themechange` listen/dispatch | No | client-only DOM |
| theme context/provider state | Client boundary | Next reserves context to Client Components |

Provide separate subpaths (`/names`, `/theme`, `/client`) so `/client` alone
touches browser APIs.

---

## 8. Governance, versioning & lifecycle

Tokens are a public API once components/apps reference their names. SemVer
classifies by public-API compatibility:

| Change | Level |
|---|---|
| Doc-only / bugfix matching documented behavior | PATCH |
| New optional token / new theme-mode with unchanged defaults | MINOR |
| Add replacement + deprecate old name | MINOR |
| Value change, visually minor | PATCH |
| Value change, visually drastic | MAJOR (or flagged MINOR w/ migration note) — semver can't see pixels |
| Rename / remove / tier restructure | MAJOR |
| Change a generated CSS-variable identity | MAJOR |
| Keep name, change semantic purpose | MAJOR |
| Make an optional palette/theme slot required | MAJOR |
| Change `themechange` payload incompatibly | MAJOR |

**Rename/retire flow (no hard breaks):** add new name → make old name an **alias**
of it → mark old `$deprecated` (emit `@deprecated` JSDoc in generated TS) → ship a
**codemod** (generate the rename map from the alias file) → remove the alias at the
**next** MAJOR only. Auto-generate the token reference (name, tier, description,
resolved value per theme, contrast report) from the same source — hand-written
token docs are stale by definition.

---

## 9. Anti-patterns (ranked by blast radius)

| # | Anti-pattern | Symptom | Fix |
|---|---|---|---|
| 1 | Value-named semantics (`--text-blue`) | names lie in dark mode; devtools show `--text-blue:#fff`; trust collapses | role names in tier 2; rename w/ deprecation window |
| 2 | No semantic layer (components alias primitives) | dark mode = touch every component | insert tier 2; lint tier leaks |
| 3 | Flipping the wrong tier | theme matrix explodes (N comps × M themes) | flip semantic bindings only |
| 4 | Palette values leaking into a shared package | every rebrand is a breaking release of everything | names-only package boundary |
| 5 | Too many tiers / component tokens for everything | 5–10× token count, all noise | the three-part component test |
| 6 | Uncontrolled reference depth | undebuggable values, round-trip drift | depth ≤ 3, CI-linted |
| 7 | Design/code drift (hand-synced values) | Figma and prod disagree within days | one canonical source + automated pipeline |
| 8 | One giant barrel export of values | tree-shaking dies; consumers couple to everything | per-category entrypoints; names-only types |
| 9 | Runtime theme computation (color fns in client) | CSP violations, hydration flicker, bundle weight | build-time only; CSS vars carry |
| 10 | `dark:` (media query) and `data-theme` disagreeing | Tailwind utilities and tokens flip at different times | single `@custom-variant` contract |
| 11 | Mode-specific names (`dark.text.primary`) | two consumer APIs for one role | name is `text.primary`; the mode selects the value |

---

## 10. Build-from-scratch checklist

1. Fix the naming grammar + regex; fix the namespace prefix.
2. Author primitive scales (OKLCH-generated, hand-tuned; 12-step roles for color).
3. Author the semantic tier (roles from §4 + space/size/type/radius/shadow/motion/z), every value an alias.
4. Declare mode axes and bindings (light/dark/hc; brand; density) at the semantic tier.
5. Add a contrast contract to every fg/bg semantic pair.
6. Add component tokens only where the three-part test passes.
7. Stand up the build (SD v5): CSS per theme-selector, names-only TS artifact.
8. Stand up CI validation (schema, refs, grammar, tier-leak, contrast, orphans, visual diff).
9. Wire the runtime: boot script, `[data-theme]` + system fallback, `themechange`, Tailwind `@custom-variant` + `@theme`.
10. Generate docs + contrast report from source.
11. Write semver/deprecation policy into CONTRIBUTING; add the rename codemod harness.
12. Import DTCG into the design tool; lock the sync direction.
