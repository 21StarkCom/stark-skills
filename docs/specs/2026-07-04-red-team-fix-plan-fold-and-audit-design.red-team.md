# Red-team review — 2026-07-04-red-team-fix-plan-fold-and-audit-design.md

- **Date:** 2026-07-04T12:07:05Z
- **Run ID:** `manual-53691c0c0837`
- **Model:** `gpt-5.5-pro`
- **Stage:** design
- **Status:** **halted**
- **Findings:** 5 total — 4 blocking (≥ high), 0 human-review
- **Cost:** $0.0000 | **Duration:** 101.3s

## Synthesis

The main tension is usefulness versus containment: fold needs rich artifact/source/finding context to make good author judgments, but that same context is untrusted prompt input driving a privileged patch-producing agent. A second tension is playground simplicity versus truthful telemetry: the design wants a light one-pass flow, but G5 depends on durable, normalized, idempotent audit state or it repeats the current measurement failure.

## Findings

### 🟣 `rt1` — security-trust (critical)

**Concern.** The fold decider ingests untrusted artifact, sidecar, findings, and fix-plan text without a stated prompt-injection boundary or reduced-privilege execution model.

**Consequence.** A malicious or corrupted artifact can steer the authoring agent to accept unsafe moves or emit poisoned patches under the fold workflow. Reusing author-agent dispatch primitives may also expose repository credentials or GitHub App publishing power to a prompt context the design treats as normal content. Human PR review reduces merge risk but does not contain credential or trust-boundary risk.

**Counter-proposal.** Split fold into a restricted decider and host publisher: wrap every artifact/source/fix-plan/finding block in explicit untrusted-input delimiters, run the decider with no GitHub token and no shell/network tool access, validate JSON and patch target host-side, then let only the host-owned publisher open the PR after validation.

**Trade-off.** Less direct reuse of copilot dispatch and more plumbing around environment construction and prompt assembly.

### 🔴 `rt3` — data (high)

**Concern.** The disposition schema stores addressed finding IDs as comma-separated text and does not snapshot the move or artifact/fix-plan identity it evaluated.

**Consequence.** The promised persona/failure_mode joins become fragile once findings are pruned, IDs are reused per run, or sidecar parsing changes. Historical adoption stats can no longer prove which exact move and artifact version drove a decision.

**Counter-proposal.** Normalize finding linkage into red_team_fix_plan_disposition_findings(fold_run_id, move_id, finding_id), add fix_plan_hash and artifact_hash to fold_runs, and persist a sanitized move_snapshot_json for each disposition.

**Trade-off.** More rows, more indexes, and a slightly heavier migration path.

### 🔴 `rt4` — product-dx (high)

**Concern.** The default fix-plan resolution can silently fold the wrong plan by falling back to the latest audit DB row for an artifact without requiring source_run_id or artifact-version confirmation.

**Consequence.** A user rerunning red-team across branches or after editing the artifact may get a PR based on stale findings. The same command can choose sidecar, DB, or error depending on local state, which makes first-contact behavior hard to predict.

**Counter-proposal.** Make run selection explicit: prefer an adjacent sidecar only when its embedded run_id and artifact_hash match, print or emit the selected run before dispatch, require --source-run-id for DB fallback, and fail stale hash matches unless --force-stale is passed.

**Trade-off.** Adds one more flag and makes the convenient fallback less automatic.

### 🔴 `rt2` — reliability-distsys (high)

**Concern.** The fold flow crosses model dispatch, patch application, branch/commit/PR creation, and audit writes without a durable state machine or idempotency key.

**Consequence.** A timeout or crash after commit but before audit can leave an orphan branch or PR with no disposition record. A rerun can double-apply patches, create duplicate logs, or count dispositions twice, undermining the audit truth this design is meant to restore.

**Counter-proposal.** Create a pending red_team_fold_runs row keyed by source_run_id + artifact_hash + fix_plan_hash before dispatch, store phase status after each boundary, upsert per-move dispositions, and make PR creation reuse a deterministic marker for that key.

**Trade-off.** Adds partial-run rows and resume logic to a workflow the design currently keeps simple.

### 🟡 `rt5` — cost-ops (medium)

**Concern.** The fold path adds a second high-end model call after red-team but defines no fold-specific budget, token preflight, or circuit breaker.

**Consequence.** The --fold convenience can double or exceed per-run cost, especially with 200k-character context packs and retry attempts. If automation starts using the flag, spend can scale with trigger frequency before the local SQLite audit makes the pattern obvious.

**Counter-proposal.** Add red_team.fold.max_cost_usd and max_output_tokens, estimate tokens before dispatch, persist skipped_budget_exhausted_fold when exceeded, and default non-interactive fold to a lower budget unless explicitly overridden.

**Trade-off.** Some useful folds will be skipped and the config surface grows.


## Proposed Fix Plan

**Status:** success
**Generated by:** `gpt-5.5-pro` at reasoning effort `xhigh`
**Cost / duration:** $0.0000 / 61.5s | **Tokens:** in=34048 out=1433
**Coverage:** 4 of 4 blocking findings addressed
**Warnings:** `ids_invented`

**Summary.** Keep the fold feature, but tighten it around explicit trust boundaries, deterministic provenance, durable audit state, and fold-specific cost controls. The proposed direction preserves the design’s author-judgment model while preventing untrusted review content from directly driving privileged publishing, and it makes every fold decision attributable to a specific artifact, source run, fix plan, and execution phase.

### 1. Isolate the decider

**Addresses:** `rt1`
**Sections touched:** `§5.2`, `§5.3`, `§6`, `§10`, `§11`

**Rationale.** The fold agent needs rich artifact and finding context, but that context is untrusted. Treat the decider as a restricted JSON-producing evaluator: delimit all artifact, source, sidecar, finding, and move content as untrusted input; remove publishing privileges from the decider path; and let a host-owned publisher validate decisions and patches before branch or PR effects occur.

**New trade-off.** The fold dispatcher becomes less direct to reuse because environment construction, prompt assembly, and publishing are split into separate trust zones.

### 2. Make fold runs resumable

**Addresses:** `rt2`
**Sections touched:** `§5.3`, `§5.5`, `§7`, `§9`, `§11`

**Rationale.** The current flow crosses dispatch, patching, branch creation, PR creation, and audit writes as one long operation. Introduce a durable fold-run lifecycle keyed by the source run, artifact identity, and fix-plan identity, with phase status recorded before and after each external effect. Reruns should resume or reuse the existing branch, log, PR marker, and per-move records instead of duplicating them.

**New trade-off.** The audit will contain partial-run states and the implementation must handle resume paths instead of treating failed folds as disposable one-shot attempts.

### 3. Snapshot fold provenance

**Addresses:** `rt3`
**Sections touched:** `§7`, `§9`, `§10`, `§12`

**Rationale.** Disposition data should remain meaningful even after findings are pruned, sidecars change, or finding IDs repeat in later runs. Store artifact and fix-plan identity on each fold run, normalize move-to-finding links, and persist a sanitized snapshot of the evaluated move so adoption statistics can be traced back to the exact recommendation and artifact version that the author judged.

**New trade-off.** Audit storage and queries become heavier, with more rows and indexes than the simple comma-separated disposition table.

### 4. Require explicit run selection

**Addresses:** `rt4`
**Sections touched:** `§5.1`, `§5.3`, `§11`

**Rationale.** The fold command should not silently choose a stale or branch-mismatched fix plan. Prefer an adjacent sidecar only when its recorded run and artifact identity match the current artifact, require an explicit source run for audit-DB fallback, and surface the selected run before dispatch. Stale matches should stop unless the caller explicitly accepts that risk.

**New trade-off.** The command becomes less convenient for first-time or ad hoc use because some cases now require a run identifier or an explicit stale override.

### 5. Cap fold spend

**Addresses:** _None_
**Sections touched:** `§5.1`, `§8`, `§11`, `§12`, `§13`

**Rationale.** Fold adds another high-end model call after red-team, and the context pack can be large. Add fold-specific budget and output limits, estimate input size before dispatch, record fold budget skips distinctly, and make non-interactive fold conservative unless the caller opts into higher spend.

**New trade-off.** Some useful folds will be skipped or require an override, and the red-team configuration surface grows.

### Unaddressed findings
_None_

### Orphan findings
_None_

### Notes

The central tradeoff is that the fold feature remains useful only if the author sees enough context to judge the move, but that context must not be allowed to steer privileged publishing directly. The audit changes also intentionally add statefulness to a design that favored simplicity, because truthful disposition telemetry depends on durable identity and idempotency.
