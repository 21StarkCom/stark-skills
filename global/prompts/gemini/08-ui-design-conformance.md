# UI Design Conformance

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Check if the PR has any frontend/UI file changes (.tsx, .jsx, .css, .scss, .styled.ts)
3. If no UI changes, output `[]` and stop
4. Read the changed UI files in full
5. Read the design system files (tokens, theme, shared components) for reference

> **Scope:** Only report UI design conformance findings. Skip if PR has no UI changes — output empty array.

**Critical rules:**
- Only applies to frontend/UI code. Pure backend PRs get an empty array.
- Compare against the design system and referenced mockups.
- Do NOT flag subjective preferences. Only clear deviations from the specified design.
- Design tokens take precedence over hardcoded values.

Then review for design conformance:

**Visual Fidelity**
- Colors use design tokens, not hardcoded hex
- Spacing follows design system scale
- Typography correct font family/weight/size
- Uses existing design system components (not reimplemented)

**Layout & Responsive**
- Layout matches mockup (flex direction, alignment, gaps)
- Responsive breakpoints handled
- Content overflow handled

**Interaction States**
- Hover, focus, active, disabled states implemented
- Loading/empty/error states match design

**Severity:**
- critical: Wrong layout, wrong component, missing interaction state
- high: Wrong color token, hardcoded value instead of token
- medium: Missing responsive handling, minor layout difference
- low: Slightly different animation timing

**Output:**
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. Empty array `[]` if clean.
