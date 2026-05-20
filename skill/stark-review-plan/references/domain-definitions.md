# Domain Definitions & Classification

## Domains (4)

| # | Domain | Focus |
|---|--------|-------|
| 1 | completeness | Overall coherence, scope clarity, missing prerequisites, undocumented assumptions, gaps in coverage |
| 2 | security | Identity lifecycle, least-privilege, secrets handling, blast radius |
| 3 | sequencing | Dependency ordering, parallel vs. serial correctness, race conditions |
| 4 | viability | Command validity, idempotency, risk inventory, probability x impact, mitigations, residual risk |

## Finding Classification

For each finding in the JSON output, read the referenced section in the plan file. Classify:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= fix_threshold (default: medium) AND the issue actually exists in the plan |
| `recurring` | Same section + same domain as a finding from a previous round that was supposedly fixed |
| `false_positive` | The described problem doesn't exist in the plan or is already addressed |
| `noise` | Subjective, stylistic, or single-agent finding contradicted by the other 2 |
| `ignored` | Below fix_threshold (low severity when threshold is medium) |

Cross-reference: 2+ agents flagging the same section with the same concern = `high_confidence`.

## Coverage Matrix (Vectors A-J)

Maps deployment-plan failure vectors to the 4 adversarial domains. Populated from actual findings.

| Vector | Domain | Status | Evidence |
|--------|--------|--------|----------|
| A) Partial-Failure Trap | viability, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| B) Imperative Idempotency | viability | {found/clean/not-applicable} | {section or finding ref} |
| C) Blank-Slate IaC | completeness | {found/clean/not-applicable} | {section or finding ref} |
| D) Dependency Sequencing | sequencing | {found/clean/not-applicable} | {section or finding ref} |
| E) Reality Drift | completeness | {found/clean/not-applicable} | {section or finding ref} |
| F) Command Validation | viability | {found/clean/not-applicable} | {section or finding ref} |
| G) Cutover Gates | viability | {found/clean/not-applicable} | {section or finding ref} |
| H) API Prerequisites | completeness, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| I) Identity Lifecycle | security | {found/clean/not-applicable} | {section or finding ref} |
| J) Evidence Strictness | completeness | {found/clean/not-applicable} | {section or finding ref} |
