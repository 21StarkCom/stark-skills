# TypeScript Type Safety & API Surface

Review the diff for type safety issues. This is your strongest domain — be thorough.

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
