# TypeScript Type Safety & API Surface

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Read each changed .tsx/.ts file in full
3. Read the barrel export file (index.ts) to check what's exported
4. Read sibling component types for consistency comparison

> **Scope:** Only report findings specific to TypeScript types and API surface. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, correctness, or test coverage, skip it — a dedicated reviewer covers that domain.

Then review for type safety issues:

**Type Correctness**
- Would this pass tsc --noEmit from a consuming package?
- Unsafe assertions: as unknown as T, as any, ! without justification
- any types in props, return types, or public API
- Generic constraints too loose or too tight

**Polymorphic Components**
- <Component as="a" href="..."> type-checks correctly?
- Element-specific attributes accepted when as changes element?
- Ref type correct for rendered element?
- ComponentPropsWithRef<T> or equivalent used?

**Public API**
- Props interface exported from barrel (index.ts)
- No internal types leaked
- Union literals for constrained props ("sm" | "md" | "lg", not string)
- Type names follow codebase conventions

**CSS Module Types**
- declare module '*.module.css' exists for downstream consumers
- CSS imports don't cause TS2307

**Consistency**
- Same type patterns as sibling components
- interface vs type consistent with codebase

Severities:
- critical: Compilation failure downstream, type allows invalid runtime values
- high: Polymorphic rejects valid attrs, missing export, any in API
- medium: Type could be tighter, inconsistency
- low: Aesthetic improvement

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
