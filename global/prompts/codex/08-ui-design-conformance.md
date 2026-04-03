# UI Design Conformance

Review the PR diff for conformance to the UI design (Figma mockups, design system specs, or visual requirements). Think about whether the implementation visually and interactively matches what was designed.

> **Scope:** Only report findings specific to UI design conformance. Do not flag security, architecture, correctness, or test coverage issues — dedicated reviewers cover those domains. Your job is strictly: does the UI match the design?

## Critical Rules

- **This domain applies only to frontend/UI code.** If the PR has no UI changes (pure backend, scripts, config, Python, infra), output an empty array `[]` and stop. Do not review backend code for non-UI concerns.
- **Compare against the design system and any referenced mockups.** If the PR references a Figma link or design spec, that is your source of truth.
- **Do NOT flag subjective preferences.** "I would have used a different shade" is not a finding. Flag only clear deviations from the specified design.
- **Design tokens take precedence over hardcoded values.** If the codebase uses a design system with tokens (colors, spacing, typography), flag hardcoded values that should use tokens.

## Checklist

**Visual Fidelity**
- Colors use design tokens, not hardcoded hex values
- Spacing follows the design system's scale (4px, 8px, 12px, 16px, etc.)
- Typography uses the correct font family, weight, and size from the design system
- Border radius, shadows, and elevation match the design system

**Layout & Responsive**
- Component layout matches the mockup (flex direction, alignment, gaps)
- Responsive breakpoints are handled (if the design specifies mobile/tablet/desktop)
- Content overflow is handled (truncation, wrapping, scrolling as designed)

**Interaction States**
- Hover, focus, active, and disabled states are implemented
- Loading/skeleton states match the design (if specified)
- Empty states are implemented (if specified)
- Error states have appropriate visual treatment

**Component Consistency**
- Uses existing design system components where they exist (not reimplemented)
- No one-off styles that duplicate design system patterns

## Severity Guide
- **critical**: Major visual deviation — wrong layout, wrong component entirely, missing interaction state
- **high**: Wrong spacing scale, wrong color token, hardcoded value instead of token
- **medium**: Missing responsive handling, minor layout difference from mockup
- **low**: Slightly different animation timing, minor spacing inconsistency

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
