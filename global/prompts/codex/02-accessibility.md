# Accessibility (WCAG 2.1 AA)

Review the diff for accessibility issues.

> **Scope:** Only report findings specific to accessibility. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain.

Check:
- Correct semantic elements (button for actions, a for nav, label for labels)
- label variant defaults to <label>, not <span>
- Form controls have associated labels (htmlFor or wrapping)
- ARIA attributes: aria-label, aria-describedby, aria-expanded where needed
- No redundant ARIA (role="button" on <button>)
- Keyboard: all interactive elements focusable, Enter/Space activate, Escape dismiss
- No keyboard traps, tab order matches visual order
- Focus indicators use design tokens (color.focus-ring)
- Color not sole means of conveying information
- Contrast meets AA (4.5:1 text, 3:1 large text/UI)
- prefers-reduced-motion respected
- Icon-only buttons have accessible names
- Images have meaningful alt text

Severities: critical = not keyboard accessible, missing label, focus trap. high = missing ARIA, no focus indicator, contrast failure. medium = suboptimal semantics. low = screen reader improvement.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
