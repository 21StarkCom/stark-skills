# Single Source of Truth

Review the diff (via --base) for **duplicated sources of truth**: a value, rule, calculation, parser, route, or policy this diff hardcodes or re-implements when an owner already exists, so the copies drift.

> **Scope:** Only the-same-answer-in-two-places findings. If it's really architecture/correctness/security/types/tests, skip it — another reviewer owns that.

Precision bar — a finding is valid ONLY if:
1. You can **name the owner** (existing config/registry/constant/module, or one the diff clearly should have created).
2. The two copies **must change together** — different contract/data-shape/lifecycle/product-context ⇒ NOT one source of truth, do not flag. Same *shape* ≠ same *responsibility* (`validateProductName` vs `validateChatMessage`, both 1–100 chars = coincidence).
3. The diff **introduces or extends** the duplication (pre-existing nearby duplication is out of scope unless made worse).

Flag:
- hardcoded literal (model id, project/env id, URL, timeout, cost, threshold, path root, credential/App id) that an existing config/registry/resolver owns → call the owner
- same calculation/business rule in two places (server + UI) → one owns, the other consumes
- parser/regex/serializer copied instead of importing the shared one
- fallback default at the call site (`x ?? 30000`) → belongs in the owner
- "just this one" local branch overriding a registry/router/provider decision
- new helper/constant duplicating an existing one under a new name
- UI re-deriving a business rule instead of formatting the owner's value

Do NOT flag: coincidental shape-only similarity; test fixtures/snapshots duplicating a literal for readability; presentation-only formatting; input validation or transport→domain adapters; greenfield single-use code with no existing owner (don't demand premature centralization).

Severities: critical = a policy/decision (auth, pricing, routing, safety limit) now sourced from two places that will silently disagree. high = meaningful constant/rule hardcoded past an existing owner, or a calc duplicated server/UI. medium = parser/helper/default duplicated, contained blast radius. low = minor duplicated literal / naming divergence.

## Output Format
JSON array only. No preamble, no fences. Each `description` names the owner (or says none exists + one should) and cites the second location.
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
