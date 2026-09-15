# Gru coordination research

## Recommendation

Gru should be an active leader with durable coordination tools.
The leader interprets objectives and resolves routine decisions.
Tools enforce ownership, concurrency, recovery, and evidence gates.
Alfred remains the ticket authority.
Hermod remains the worker transport and lifecycle authority.

This separates judgment from facts that must survive interruption.
It also preserves existing Claude and Codex implementations.
The implementation should extend the existing team skills.
It should not create another agent transport or ticket system.

## Evidence and applicability

### Orchestration architecture

OpenAI's Symphony separates workflow policy, scheduling, execution, and tracking.
It assigns isolated workspaces and bounds concurrent work.
Its specification explicitly separates tracker reading from agent-owned writes.
These boundaries fit Alfred and Hermod's existing responsibilities.[^1]

Symphony's restart model has an important mismatch with Gru.
Its specification does not preserve exact in-memory scheduler state.
It does not assume running sessions can be recovered.
Gru explicitly requires reconnecting workers before considering replacement dispatch.
Copying Symphony's restart behavior would therefore violate this ticket.[^1]

**Decision:** reuse the architecture's separation of responsibilities.
Persist Gru's assignments, identities, pending operations, and budgets.
Reconcile those records against Hermod before further dispatch.
An unavailable observation must not become a dead-worker verdict.

### When parallel work helps

Anthropic reports benefits for independent, broad research tasks.
It also reports substantial additional token consumption.
The article cautions that tightly coupled coding work parallelizes poorly.
Its delegation guidance emphasizes objectives, boundaries, tools, and output contracts.[^2]

Controlled experiments also show task-dependent outcomes.
Kim and colleagues compared 260 configurations across six benchmarks.
Their revised paper reports gains for decomposable reasoning.
It reports regressions for sequential planning and tool-heavy coordination.
Architectures without centralized verification propagated more errors.[^3]

**Decision:** dependencies determine readiness; spare capacity does not.
File ownership and exclusive resources constrain implementation concurrency.
Shared release files require serialized integration, even across independent tasks.
Gru independently verifies results before releasing dependent work.
These studies do not establish Gru's optimal worker count.
The invocation must carry an explicit concurrency limit.

### Reliable recovery

AWS describes duplicate effects caused by retrying uncertain operations.
A caller-provided request identifier distinguishes retries from new intent.
Reusing that identifier enables safe idempotent handling.[^4]

LangGraph persists thread state through checkpoints.
Its interrupt documentation warns that resumed nodes execute again.
Side effects before an interrupt may therefore repeat.
It recommends idempotence or separating those effects from interruptible logic.[^5][^6]

**Decision:** persist a dispatch reservation before contacting Hermod.
Record the operation identity and full intended assignment.
Keep uncertain operations reserved after process interruption or timeout.
Reconcile the existing worker before retrying any launch.
A transport submission acknowledgment is not an intake acknowledgment.
Blindly retrying an uncertain launch is forbidden.

SQLite transactions provide the local coordination primitive.
The repository already uses Node's SQLite implementation.
Gru does not need a new database service or workflow framework.
This choice is an implementation judgment, not an experimental finding.

### Completion evidence

Anthropic observed agents declaring work complete without adequate testing.
Its long-running harness retained requirements and structured progress.
End-to-end checks exposed failures missed by narrower checks.[^7]

**Decision:** worker reports remain claims until independently checked.
Record the exact tested revision and command output.
Verify PR state and merge ancestry from authoritative sources.
Bind review evidence to the reviewed revision.
Rebase invalidates earlier integration approval when the base changes.
Missing, skipped, stale, or unrelated checks cannot establish completion.

Do not treat unit tests as evidence of live coordination.
The acceptance demonstration must exercise actual Codex Minions.
It must include dependencies, blocking, inaccurate claims, cancellation, and resume.
Recorded commands and outputs must distinguish observed facts from claims.

### Runtime differences

Codex's App Server exposes durable threads and individual turns.
Resumption uses a thread identity; interruption targets an active turn.
An interrupt response precedes the final interrupted turn status.[^8]

**Decision:** persist provider, worker, session, surface, and worktree separately.
Treat cancellation requests separately from observed termination.
Use Hermod's provider-aware lifecycle and messaging capabilities.
Do not send Claude slash commands to Codex.
Do not implement a second App Server client inside Gru.

## Existing local contracts

Local inspection on September 14, 2026 established these boundaries:

| Surface | Observed behavior | Consequence |
|---|---|---|
| `hermod ticket --help` | Codex ticket launch remains unsupported | STARK-4911 is a live dependency |
| `hermod msg peers --agent codex --json` | Stable native Codex thread identities and activity | Reuse discovery for reconciliation |
| `hermod msg status` | Submission, delivery, and acknowledgment are separate | Require explicit worker intake |
| `hermod msg cancel` | Cancels a message ledger entry | This alone does not stop execution |
| `hermod close-session --help` | May remove the worker worktree | Do not use for preservation-only stopping |
| Existing team skills | Claude-only manual coordination | Replace manual invocation contracts and add Codex overrides |
| Bifrost source layout | Separate canonical and Codex override surfaces | Validate both compiled packages |

These observations are version-specific, not permanent capability claims.
Recheck Hermod before live dispatch and after dependency updates.
Do not claim Codex parity from a declared union type.
Actual launch, delivery, acknowledgment, and lifecycle behavior must work.

## Alternatives considered

| Approach | Benefit | Reason against adopting wholesale |
|---|---|---|
| Prompt-only coordinator | Small initial change | Ownership and recovery depend on conversation memory |
| Symphony service | Mature orchestration specification | Restart and tracker assumptions differ from Gru |
| LangGraph application | Checkpointing and interrupt support | Adds a framework around existing agent runtimes |
| New direct Codex client | Full protocol access | Duplicates Hermod's transport responsibility |
| Skills plus transactional coordination tools | Existing runtimes remain authoritative | Requires explicit integration and behavioral verification |

The selected approach is the final row.
Tools should enforce concrete invariants, not prescribe every engineering decision.
The leader should keep working within the approved objective.
It should escalate only decisions outside existing authority.

## Acceptance evidence required

| Requirement | Evidence |
|---|---|
| Bounded dispatch | Concurrent reservation attempt exceeds cap and is refused |
| Unique ownership | Competing assignment cannot claim an owned task or worktree |
| Complete intake | Worker acknowledges the exact assignment and done-when |
| Dependency gating | Dependent task remains pending until prerequisite verification |
| Shared seam | Second integration waits until the first completes |
| False completion | Deliberately inaccurate claim fails independent verification |
| Resume | Existing identities reconnect without another launch |
| Recovery limits | Exhausted attempt budget refuses further recovery |
| Stop | Hermod reports worker interruption; worktrees remain present |
| Runtime selection | Codex launches remain Codex; unsupported choices fail visibly |
| Distribution | Claude and Codex packages include their proper skill variants |

No cited study proves these acceptance criteria for this implementation.
They require repository checks and the live demonstration.

## Sources

[^1]: OpenAI. [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md), sections 2, 3, 8, 14, and 17. Living specification, accessed September 14, 2026. Context: [An open-source spec for Codex orchestration: Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), April 27, 2026.
[^2]: Anthropic. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), June 13, 2025. Research-system results, not a coding benchmark.
[^3]: Yubin Kim et al. [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296v3), revision 3, April 8, 2026. Preprint; experimental outcomes depend on task and architecture.
[^4]: Malcolm Featonby, AWS Builders' Library. [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/), announced January 15, 2021.
[^5]: LangChain. [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence). Living JavaScript documentation, accessed September 14, 2026.
[^6]: LangChain. [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), especially side-effect idempotence. Living JavaScript documentation, accessed September 14, 2026.
[^7]: Anthropic. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), November 26, 2025.
[^8]: OpenAI. [Codex App Server](https://learn.chatgpt.com/docs/app-server), thread lifecycle and turn interruption. Living documentation, accessed September 14, 2026.
