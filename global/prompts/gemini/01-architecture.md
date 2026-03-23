# Architecture & Design Patterns

First, run these commands to understand the changes:
1. Run `git diff <base>...HEAD` to see what changed
2. Read each changed file in full
3. Read sibling components in the same directory for pattern comparison

> **Scope:** Only report findings specific to architecture and design patterns. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about security, correctness, accessibility, types, or test coverage, skip it — a dedicated reviewer covers that domain.

Then review for architecture issues:

**Component API**
- Props API consistent with sibling components? Compare names: size, variant, disabled, as
- forwardRef used correctly? Ref type matches rendered element?
- Polymorphic as prop narrows types for element-specific attributes?
- No props silently ignored?

**Module Structure**
- Barrel exports clean — no internals leaked
- No circular imports
- Files in correct directories
- Components consume tokens/generated/, never tokens/src/

**Patterns**
- Same patterns as sibling components for same problems
- CSS Modules — no global style leaks
- No premature abstractions
- Composition over inheritance

**Dependencies**
- Minimal coupling between components
- No hidden global state or side effects

**Do NOT Flag:**
- Zero-dependency scripts that use regex parsing on controlled, known-format input — this is a deliberate trade-off, not a design flaw.
- Editor/IDE config files committed to the repo (`.vscode/`, `.claude/`, hooks) — these are DX conveniences, not build contracts. Only flag if they affect CI or build correctness.

Severities:
- critical: Broken module boundary, cascading architectural violation
- high: API inconsistency confusing consumers, wrong abstraction
- medium: Non-ideal pattern that works
- low: Suggestion

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
