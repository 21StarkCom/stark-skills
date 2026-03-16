# Architecture & Design Patterns

Review the PR diff for architecture and design pattern issues. Think systemically — how do these changes affect the codebase as a whole?

## Checklist

**Component API Design**
- Props API consistent with sibling components? Same names for same concepts (`size`, `variant`, `disabled`, `as`)
- `forwardRef` used correctly? Ref type matches the actual rendered element?
- Polymorphic `as` prop narrows the type correctly for element-specific attributes?
- Compound component patterns where appropriate?
- No props accepted but silently ignored?

**Module Structure**
- Barrel exports clean — no internal implementation leaked
- No circular imports between packages or components
- Files in correct directories
- Separation of concerns — styling, logic, rendering not tangled
- Single responsibility — no god components

**Patterns**
- Composition over inheritance
- Abstraction level appropriate — not over-engineered, not under-abstracted
- Same problems solved the same way as elsewhere in the codebase
- No premature abstractions for hypothetical future needs
- CSS Modules — no global style leaks, proper class composition

**Dependencies**
- Components depend on `tokens/generated/`, never `tokens/src/`
- Minimal coupling — components usable independently
- No hidden global state or side effects

## Severity Guide
- **critical**: Wrong dependency direction, broken module boundary, cascading architectural violation
- **high**: API inconsistency confusing consumers, wrong abstraction level
- **medium**: Non-ideal pattern that works but should improve
- **low**: Better practice suggestion

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
