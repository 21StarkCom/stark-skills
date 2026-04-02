# Domain Definitions & Classification

## Domains (10)

| # | Domain | Focus |
|---|--------|-------|
| 1 | general | Overall coherence, scope clarity, stated goals vs. actual steps |
| 2 | completeness | Missing prerequisites, undocumented assumptions, gaps in coverage |
| 3 | security | Identity lifecycle, least-privilege, secrets handling, blast radius |
| 4 | feasibility | Command validity, idempotency, human-executable steps, tooling availability |
| 5 | operability | Observability, alerting, runbooks, on-call impact, operator UX |
| 6 | sequencing | Dependency ordering, parallel vs. serial correctness, race conditions |
| 7 | rollback | Rollback completeness, partial-failure traps, state recovery |
| 8 | risk | Risk inventory, probability x impact, mitigations, residual risk |
| 9 | gates | Cutover criteria, go/no-go checks, validation evidence, sign-off |
| 10 | timeline | Duration estimates, critical path, buffer, deadline realism |

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

Maps deployment-plan failure vectors to the 10 adversarial domains. Populated from actual findings.

| Vector | Domain | Status | Evidence |
|--------|--------|--------|----------|
| A) Partial-Failure Trap | rollback, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| B) Imperative Idempotency | feasibility | {found/clean/not-applicable} | {section or finding ref} |
| C) Blank-Slate IaC | completeness | {found/clean/not-applicable} | {section or finding ref} |
| D) Dependency Sequencing | sequencing | {found/clean/not-applicable} | {section or finding ref} |
| E) Reality Drift | operability | {found/clean/not-applicable} | {section or finding ref} |
| F) Command Validation | feasibility | {found/clean/not-applicable} | {section or finding ref} |
| G) Cutover Gates | gates, rollback | {found/clean/not-applicable} | {section or finding ref} |
| H) API Prerequisites | completeness, sequencing | {found/clean/not-applicable} | {section or finding ref} |
| I) Identity Lifecycle | security | {found/clean/not-applicable} | {section or finding ref} |
| J) Evidence Strictness | general | {found/clean/not-applicable} | {section or finding ref} |

## Tournament Evaluation Criteria

The judge runs twice with swapped order (position bias control). Numeric scores are averaged across both passes.

- **Coverage** — what fraction of real issues did the agent find?
- **Severity accuracy** — were critical issues called critical, not just "medium"?
- **False positive rate** — how many findings were noise or not real?
- **Actionability** — can an engineer act on each finding without guessing?
- **Specificity** — does each finding cite exact sections, commands, or line numbers?

If the judge detects position bias (winner changes when review order is swapped), the result is a tie. In tie mode, no winner is declared — only the synthesized findings are used. The summary reports "Tournament result: tie (position bias detected)" and lists the synthesized findings.
