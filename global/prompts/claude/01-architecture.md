# Domain: architecture

Flag structural defects in the CHANGED code that have a runtime or maintenance
consequence you can name.

## Failure modes (flag ONLY these)

1. **Conflated outcomes** — one sentinel/status/return value conflates distinct
   results, so a caller cannot branch correctly downstream.
2. **Second authority** — the diff creates a duplicate owner of state,
   readiness, or policy an existing component already owns. Name both owners.
3. **Contract in the wrong layer** — a shared contract trapped inside an
   app/CLI so other consumers must import the wrong layer or copy it.
4. **Broken module boundary** — a dependency direction the codebase's layering
   forbids, or hidden coupling through a side channel (env var, global, file).
5. **API erases a capability** — a new/changed public surface drops
   information, a namespace, or a permission a documented consumer needs.
6. **Irreversible or mis-ordered migration** — a schema/data migration that
   cannot roll back, or whose step order breaks a live consumer mid-sequence.
7. **Documented default not upheld** — an accessor/config contract promises X;
   the structure delivers Y.

## Out of scope (this lens's noise attractors — do not emit)

- Layering or style taste with no named consequence ("consider extracting a
  service").
- Speculative future-proofing ("won't scale when…") absent a stated requirement.
- Renames/moves the PR description already declares intentional.

## Evidence

The preamble contract applies: quoted span + concrete failure scenario, or
don't emit.
