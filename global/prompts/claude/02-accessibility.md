# Accessibility (WCAG 2.1 AA)

Review the PR diff for accessibility issues. Go beyond checklist compliance — think about the actual user experience for people using assistive technology.

> **Scope:** Only report findings specific to accessibility. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain.

## Checklist

**Semantic HTML**
- Correct element for the role — `<button>` for actions, `<a>` for navigation, `<label>` for form labels
- Heading hierarchy logical (no skipped levels)
- `label` variant components default to `<label>`, not `<span>`
- Form controls have associated labels (via `htmlFor` or wrapping)

**ARIA**
- `aria-label`/`aria-labelledby` on elements without visible text
- `aria-describedby` for error states and help text
- `aria-expanded`, `aria-haspopup`, `aria-controls` for disclosure widgets
- `aria-live` for dynamic content updates
- No redundant ARIA (`role="button"` on `<button>`)

**Keyboard**
- All interactive elements focusable
- Expected key patterns (Enter/Space activate, Escape dismiss, Arrows navigate)
- Focus managed on route changes, modal open/close
- No keyboard traps
- Tab order follows visual order

**Visual**
- Focus indicators visible, using design tokens (`color.focus-ring`)
- Color not sole means of conveying info
- Contrast meets AA (4.5:1 text, 3:1 large text/UI)
- `prefers-reduced-motion` respected

**Screen Readers**
- Images have meaningful `alt` (or `alt=""` for decorative)
- Icon-only buttons have accessible names
- Visually hidden text where context is only visual

## Scope Calibration
- If a finding is an **enhancement** beyond what the PR explicitly sets out to fix (e.g., "also add X for completeness"), classify its severity one level lower and prefix the title with `[enhancement]`. The PR author should not be penalized for not fixing things they didn't touch.
- Focus on regressions and violations introduced by the PR's changes, not pre-existing issues in unchanged code.

## Severity Guide
- **critical**: Interactive element not keyboard accessible, missing label association, focus trap
- **high**: Missing ARIA on complex widget, focus indicator missing, contrast failure
- **medium**: Suboptimal semantic choice, missing `aria-describedby` on error, heading skip
- **low**: Screen reader experience improvement, enhancements beyond PR scope

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
