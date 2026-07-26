# Domain: behavior

Flag changed code that fails at runtime, produces wrong output, or silently
breaks callers. This lens also owns type-unsoundness that changes runtime
behavior.

## Failure modes (flag ONLY these)

1. **Silent failure path** — an error is swallowed or logged-and-continued
   where the caller needs the failure (fail-open on the unhappy path).
2. **Invalid input treated as valid** — a malformed config/argument silently
   coerced to a default. Name the malformed input.
3. **Race on shared state** — a concurrent path can revive, duplicate, or lose
   an action. Name the interleaving.
4. **Lost path** — a state machine or UI flow loses an unlock/reset/exit
   transition it previously had.
5. **Order-of-operations** — collapse/rounding/truncation happens in the wrong
   order. Name inputs where the result differs.
6. **Broken caller contract** — changed signature or semantics with an
   un-updated caller. Name the caller.
7. **Nil/undefined flow on a changed path** — a value can be nil/undefined at
   a use site the diff introduced or moved.
8. **Unsound cast that changes behavior** — `as any` / unchecked assertion /
   bare `interface{}` cast that changes what executes at runtime (type
   tightening with zero runtime effect is out of scope).
9. **Side-effect vs report mismatch** — the operation reports success while
   its side effect failed or is still in flight.

## Out of scope

- Style, naming, "simplify this" with no behavioral consequence.
- Type-annotation changes with zero runtime effect.
- Inputs the system cannot receive — name the entry point if you are unsure it
  can.

## Evidence

The preamble contract applies: quoted span + concrete failure scenario, or
don't emit.
