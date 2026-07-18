# The Spec Contract

This is the **canonical prose contract** for a written spec. The lead drafts against it; the wing checks against it. It is prepended in-band to every dispatch — agents have **no file tools**, so everything they need is here.

A conforming spec has exactly **nine sections**, in this order, each under a header of the exact form `## <id> — <Title>`:

`intent`, `scope`, `interfaces`, `behavior`, `ssot`, `security`, `test-plan`, `accessibility`, `open-questions`.

Each section below states its **Done-when bar** (the objective bar the section must clear) and a **Review lens** (a *bounded checklist* distilled from the matching spec-review domain — check these items, do **not** open an unbounded hunt for more).

## The n/a-with-reason rule

A section may be marked not-applicable — the canonical status token the wing emits is **`n_a`** (the wing verdict enum has no `n/a`; always use `n_a`) — but only *with a one-line reason* stating why it does not apply to this spec (e.g. `accessibility: n_a — headless CLI, no user-facing surface`). A section left empty, or marked `n_a` with no reason, is **incomplete**, not exempt. The reason is the artifact that makes the omission reviewable.

## Scope-declaration anti-inflation anchor

Match every section's bar to what the spec declares it **is**. Every spec sits in one of three tiers — identify the tier before applying any bar:

1. **Playground** — single-user / local / personal tooling. Absence of platform hardening (HA, migration, audit trails, rotation, adversarial-input defense, 10x-scale capacity) is **correct restraint**, not a gap. Flag additions, not absences.
2. **Production system, intentionally-minimal / deferred slice** — the surrounding system is production-grade, but the reviewed feature is an explicitly bounded V1 (a "What this is NOT", "Out of scope for V1", "deferred to Phase 2", or "dark by default" statement draws the line). **The declared boundary is binding.** The absence of an explicitly-deferred concern is correct; a finding that would add it back is noise. The only legitimate objection to a deferral is that the deferral itself is unsafe even dark — target the boundary statement, never smuggle in the deferred machinery.
3. **Platform** — platform-grade responsibility with no declared boundary. Full production standards apply.

When the spec declares its scope, that declaration answers the concern. A concrete behavior the spec actually needs to work is a gap; a production subsystem it does not need is not.

---

## intent — Intent & Soundness

**Done-when:** The spec states the problem it solves and demonstrates that the proposed design actually solves it; success criteria are objective enough that an engineer could determine whether the spec was implemented correctly.

**Review lens** (from `spec-review/domains/01-completeness.md`, Soundness):
- Does the document clearly state the problem being solved, and does the proposed design actually solve it?
- Are the architectural trade-offs acknowledged? Does the document explain why this approach was chosen over alternatives?
- Are assumptions stated explicitly, and are they consistent across sections?
- Are there unstated dependencies — things the spec silently assumes will exist, be available, or behave a certain way?
- Are success criteria defined? Could an engineer objectively determine whether the spec was implemented correctly?
- Is there a clear distinction between decisions that are finalized and items that are still open or deferred?

## scope — Scope & Boundaries

**Done-when:** The spec bounds V1 explicitly, distinguishing what is in scope from what is deferred, and includes no component or abstraction not required by a stated use case.

**Review lens** (from `spec-review/domains/03-scope.md`):
- Does the spec include components or abstractions that are not required by any stated use case?
- Are there "we might need this later" features or extension points that add complexity without near-term justification?
- Is the abstraction level appropriate? Are there layers of indirection that solve no current problem?
- Are generic frameworks or platforms proposed where a simpler, purpose-built solution would suffice?
- Is the scope of the first version clearly bounded? Is there a distinction between V1 and future iterations?
- Are there requirements stated as hard constraints that are actually preferences or low-priority nice-to-haves?
- Does the spec solve a problem at a scale significantly larger than current or near-term projected load?
- Would a simpler design serve the immediate goal just as well, with lower implementation risk?

## interfaces — Interfaces & Contracts

**Done-when:** Every interface the spec introduces — API surface, CLI command/flag surface, file format, and local-store / data model — has a fully specified contract: request/response and data schemas with field names, types, required-vs-optional, relationships and cardinality, error semantics, and idempotency for mutations — sufficient for a consumer to implement against.

**Review lens** (from `spec-review/domains/04-api-design.md` and `spec-review/domains/05-data-modeling.md`):
- Are API contracts fully specified? Are request/response schemas defined with field names, types, required vs. optional, and constraints?
- Are error responses consistent and actionable? Is there a standard error envelope with error code, human-readable message, and remediation hint?
- Are HTTP status codes (or equivalent RPC codes) used correctly and consistently across all endpoints?
- Are mutating operations idempotent by design? Is there a defined mechanism for safe retries (idempotency keys, conditional writes)?
- Are list/collection endpoints paginated? Is the pagination model specified — cursor vs. offset, max page size, sort order guarantees?
- Are naming conventions consistent across endpoints, field names, and enum values? Do they follow a documented standard?
- Can all stated use cases be accomplished with the defined API surface, or are there missing endpoints?
- Are entities and their attributes defined with types, constraints, and cardinality?
- Are relationships between entities explicit — foreign keys, ownership hierarchies, many-to-many join semantics?
- Are nullable fields justified? Does the model distinguish between "unknown" and "not applicable"?
- Is ownership of each entity clear — which service is the system of record?

## behavior — Behavior & Correctness

**Done-when:** The spec specifies the behavior for the stated inputs — happy path, error paths, and edge cases (empty input, zero-state, concurrent mutations, duplicate events) — rather than describing only the happy path, and its flows, states, and termination conditions are internally consistent with the rest of the spec.

**Review lens** (from `spec-review/domains/01-completeness.md`, Completeness, plus `spec-review/domains/06-consistency.md`):
- Are error paths and failure behaviors specified, or does the spec only describe the happy path?
- Are edge cases addressed? (empty input, zero-state, concurrent mutations, duplicate events)
- **Prefer fail-fast over silent fallbacks, retries, or compatibility shims.** A design that masks errors with defaults, retries forever on flaky deps, or carries v1/v2 shims for hypothetical migrations is adding complexity without value. Flag those patterns.
- Is logging / observability covered at the level needed for self-debugging? (Don't demand SRE-grade dashboards — just "where do logs go, what's traceable.")
- Are terms defined in one section used with a different meaning in another?
- Does a section introduce a constraint that another section silently violates?
- Are component responsibilities stated in multiple places with conflicting scope?
- Are numeric values (limits, timeouts, sizes) stated inconsistently across sections?
- Are architectural decisions stated in one section contradicted by the approach taken in another?
- Are assumptions stated in one section contradicted by facts given in another?

## ssot — Single Source of Truth

**Done-when:** Every value, rule, calculation, or piece of state has exactly one authoritative owner; consumers consume from that owner rather than re-deriving or duplicating it.

**Review lens** (from `spec-review/domains/07-ssot.md`):
- Does the design have **two components computing the same business rule** (e.g. server and client both deriving a price, a limit, an eligibility check) instead of one owner + consumers?
- Does it **duplicate a constant/threshold/config value** into multiple components' descriptions instead of naming one authoritative source?
- Does it introduce a **new store/table/cache that holds data an existing system already owns**, without a stated sync authority (a dual-write with no single source)?
- Does it define a **model/route/policy locally** in one component when the design (or the existing platform) already has a registry/config that should own it?
- Does a component **re-derive** a value it could receive from the owner (recompute vs. consume)?
- When the design *does* keep a cache/replica, does it name the **authoritative source and the reconciliation direction**, or leave two peers free to disagree?

## security — Security & Trust

**Done-when:** The spec's trust model, authentication, authorization, secret handling, and data-protection requirements are specified proportionally to the declared threat model — no gaps an attacker could bake into implementation.

**Review lens** (from `spec-review/domains/02-security.md`):
- Is the trust model defined? Are trust boundaries between components, users, and external systems clearly identified?
- Are authentication mechanisms specified for every entry point — user-facing, service-to-service, and administrative?
- Is the authorization model defined? Are roles, permissions, and access control enforcement points specified?
- Is data classified by sensitivity? Are handling requirements defined for PII, credentials, and proprietary data?
- Are secrets (API keys, tokens, passwords, certificates) managed explicitly — stored, rotated, and accessed how?
- Is data encrypted in transit at every trust boundary? Is data encrypted at rest where required?
- Are input validation and output encoding specified at every trust boundary to prevent injection, XSS, or SSRF?
- Is the principle of least privilege applied to service accounts, IAM roles, database users, and network access?
- Are audit logs planned for security-relevant actions? Is log content sanitized — no credentials, tokens, or raw PII?

## test-plan — Test Plan

**Done-when:** The spec names, for each behavior-changing claim, a concrete test that would prove it — with a described break scenario, not a generic "add tests." Every gap flagged names a specific input whose breakage would go silently uncaught.

**Review lens** (from `spec-review/codex/08-test-plan.md`):
- Test strategy present — names required types (unit, integration, contract, E2E, load, regression)
- Acceptance criteria defined per feature; engineer can determine when "done"
- Error paths and failure scenarios covered, not just happy path
- Regression strategy with automated tests on critical paths
- Edge cases addressed (empty input, zero-state, max concurrency, rate limits, malformed payloads, expired tokens)
- Security-relevant behaviors in test plan (auth bypass, injection, privilege escalation)
- Test environment strategy specified (local, staging, production-mirror); parity gaps called out
- External dependencies tested via real services, test doubles, or contract tests — tradeoff justified
- Performance/load tests specified where throughput, latency SLAs, or scaling claims exist
- Migration/rollout test plan present (data migrations, feature flags, canary rollouts)
- Observability signals (logs, metrics, traces) validated in tests, not assumed working

## accessibility — Accessibility

**Done-when:** Every user-facing surface the spec introduces states its accessibility requirements — semantic roles, keyboard operability, ARIA/labels, and contrast — or the section is marked `n_a` with a reason (e.g. headless/CLI, no user-facing surface).

**Review lens** (from `spec-review/codex/07-accessibility.md`):
- Semantic HTML structure specified (heading hierarchy, landmarks, form labels)
- Keyboard interaction patterns defined for all interactive elements
- ARIA roles/states/properties specified where semantic HTML isn't enough
- Screen reader announcements for dynamic content (live regions, toasts)
- Color contrast requirements specified; no color-only information
- Focus indicators defined and visible
- Reduced motion preferences addressed (`prefers-reduced-motion`)
- Touch targets ≥ 44×44px
- Text scaling survives 200% zoom
- Error messages programmatically associated with form fields
- Alt text strategy for images/icons
- Loading/progress states announced to screen readers
- Data viz has alternative representations (tables, summaries)
- **Scope note:** a headless, CLI, or service-only surface has no accessibility bar — mark this section `n_a` with that reason rather than manufacturing one.

## open-questions — Open Questions

**Done-when:** Every unresolved decision, deferral, and TODO that must be settled before implementation is listed, with an owner where one exists — nothing punted silently to "future work."

**Review lens** (from `spec-review/domains/01-completeness.md`, open-items):
- Are there open questions or TODOs that must be resolved before implementation?
- Is there a clear distinction between decisions that are finalized and items that are still open or deferred?
- Are there gaps where the document punts to "future work" without tracking what that means or who owns it?
- Are all referenced external systems, services, or libraries described with enough detail to evaluate their suitability, or is that an open question?
- Is each open question actionable — stated concretely enough that resolving it produces a decision, not more questions?
