# Accessibility (WCAG 2.1 AA)

First, run these commands:
1. Run `git diff main...HEAD` to see what changed
2. Read each changed file in full
3. Check if components render correct semantic HTML elements

Then review for accessibility issues:

**Semantic HTML**
- Correct element for role: button for actions, a for nav, label for labels
- label variant defaults to <label>, not <span>
- Form controls have associated labels (htmlFor or wrapping)
- Heading hierarchy logical, no skipped levels

**ARIA**
- aria-label/aria-labelledby on elements without visible text
- aria-describedby for error states and help text
- aria-expanded, aria-haspopup for disclosure widgets
- No redundant ARIA (role="button" on <button>)

**Keyboard**
- All interactive elements focusable
- Enter/Space activate, Escape dismiss, Arrows navigate
- No keyboard traps
- Tab order follows visual order

**Visual**
- Focus indicators visible, using design tokens (color.focus-ring)
- Color not sole means of conveying info
- Contrast meets AA (4.5:1 text, 3:1 large/UI)
- prefers-reduced-motion respected

**Screen Readers**
- Icon-only buttons have accessible names
- Images have meaningful alt text
- Visually hidden text where context is only visual

Severities:
- critical: Not keyboard accessible, missing label, focus trap
- high: Missing ARIA, no focus indicator, contrast failure
- medium: Suboptimal semantics, missing aria-describedby
- low: Screen reader improvement

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
