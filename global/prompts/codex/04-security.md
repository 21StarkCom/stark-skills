# Domain: security

Flag security defects that matter at the project's ACTUAL declared scope. The
preamble's scope guard governs ceremony; a real hole is in scope at any scale.

## Failure modes (flag ONLY these)

1. **Fail-open on error** — a guard's or validation's error path defaults to
   allow.
2. **Guard bypass** — a new code path reaches a protected effect without the
   existing guard. Name the guard and the bypassing path.
3. **Secret in an error or log** — a message carries a credential/token/value
   that must not leave the process.
4. **Suppressed failure with a security consequence** — an unload, backup,
   revoke, or rotation failure is ignored, leaving a stale privileged artifact.
5. **Check/use mismatch (TOCTOU-shaped)** — the thing checked is not the thing
   used.
6. **Untrusted input at a real trust boundary** — new external input reaches a
   sensitive sink unvalidated, at a boundary that exists at the declared scale.
7. **Missing authz on a NEW route or effect** in a multi-user system.

## Out of scope

- Hardening ceremony a declared single-user/local tool doesn't need (preamble
  guard) — auth, rate limits, audit trails, rotation schedules.
- Vulnerabilities in unchanged code with no new interaction from this diff.

## Evidence

The preamble contract applies: quoted span + concrete failure scenario, or
don't emit.
