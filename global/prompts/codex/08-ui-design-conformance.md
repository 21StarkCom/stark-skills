# UI Design Conformance

Review the diff for conformance to the UI design (Figma mockups, design system specs). Does the implementation match what was designed?

> **Scope:** Only report UI design conformance findings. Skip if PR has no UI changes — output empty array.

Critical rules:
- Only applies to frontend/UI code. Pure backend PRs get an empty array.
- Compare against the design system and referenced mockups.
- Do NOT flag subjective preferences. Only clear deviations from the specified design.
- Design tokens take precedence over hardcoded values.

Check:
- Colors use design tokens, not hardcoded hex
- Spacing follows design system scale
- Typography uses correct font family/weight/size from design system
- Layout matches mockup (flex direction, alignment, gaps)
- Responsive breakpoints handled (if design specifies)
- Hover, focus, active, disabled states implemented
- Loading/empty/error states match design
- Uses existing design system components (not reimplemented)
- No one-off styles that duplicate design system patterns

Severity:
- critical: Wrong layout, wrong component, missing interaction state
- high: Wrong color token, hardcoded value instead of token
- medium: Missing responsive handling, minor layout difference
- low: Slightly different animation timing

Output:
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. Empty array `[]` if clean.
