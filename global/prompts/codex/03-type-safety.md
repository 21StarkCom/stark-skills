# TypeScript Type Safety & API Surface

Review the diff for type safety issues. This is your strongest domain — be thorough.

> **Scope:** Only report findings specific to TypeScript types and API surface. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, correctness, or test coverage, skip it — a dedicated reviewer covers that domain.

**Do NOT flag:**
- Missing TypeScript declarations (`.d.ts`) for plain JavaScript packages that have no TypeScript consumers or no `types` field in package.json. Only flag missing declarations when the package is consumed by TypeScript code.
- Missing concrete types (enums, literal unions, typed payloads) in design documents or spec pseudo-code. Specs use illustrative types like `str` and `dict` to convey intent — concrete types are defined at implementation time. Only flag type contradictions between defined contracts (e.g., one section says `status: Literal["ok", "failed"]` and another uses `status: bool`).

Check:
- Would this pass tsc --noEmit from a consuming package?
- Unsafe assertions: as unknown as T, as any, ! without justification
- any types that should be specific, especially in props/return types
- Generic constraints too loose (accepts invalid) or too tight (rejects valid)
- Polymorphic as prop: does <Component as="a" href="..."> type-check?
- Element-specific attributes accepted when as changes element?
- Ref type correct for actual rendered element?
- ComponentPropsWithRef<T> or equivalent for polymorphic typing?
- Props interface exported from barrel file (index.ts)
- No internal types leaked through public API
- Union literals for constrained props ("sm" | "md" | "lg", not string)
- declare module '*.module.css' exists so consumers don't get TS2307
- Consistent interface vs type usage with codebase

Severities: critical = compilation failure downstream, type allows invalid runtime values. high = polymorphic rejects valid attrs, missing export, any in API. medium = type could be tighter. low = aesthetic.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
