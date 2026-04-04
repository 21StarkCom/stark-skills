# Glossary

**Sibling repos** — Directories under the same parent directory as the target project that contain a `.git/` subdirectory and whose origin remote points to the same host and organization. Used in cross-repo update operations to scope which repositories receive propagated changes.

<!-- needs review -->
**Custom lookarounds** — The regex pattern `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` used instead of `\b` word boundaries to correctly match project names containing hyphens and dots without false-matching inside longer identifiers.

**AI-DD Tracker** — The GitHub Projects V2 board (`GetEvinced/projects/8`) used as the canonical workflow state machine for the stark-skills pipeline. Tracks task lifecycle from backlog through done with 11 status states and 14 custom fields.

**LEGAL_TRANSITIONS** — The dict in `github_projects.py` encoding all allowed status transitions in the workflow state machine. Used by `transition_status()` to enforce that only valid state changes are applied.

**Release gate** — A composite quality check (PR approved + CI pass + docs complete + artifacts linked + release approval + rollout notes) enforced via a GitHub Actions status check named `release-gate`. Must pass before PR merge is allowed.

**Spec completeness gate** — Validation that blocks tasks from entering `ready for agent` unless Risk and AI Suitability fields are set, and Spec Approval is `approved` for high-risk items.

**Preflight** — Environment validation check (`scripts/preflight.py`) that runs before execution-heavy skills. Returns `ready`, `degraded`, or `blocked` based on CLI availability, auth status, and config state. Introduced in Workflow Improvement P0.

**PreFlightResult** — Structured JSON output from preflight containing `overall` status, `recommended_mode`, per-check details, and remediation messages. The contract between preflight.py and all consuming skills.

**Approach contract** — Pre-execution confirmation step (`scripts/approach_contract.py`) that displays the derived goal, approach, and constraints from a plan before long-running skills begin execution. Requires Y/n/edit in interactive mode.

**Validation gate** — Post-code-generation quality check (`scripts/validation_gate.py`) that runs lint, typecheck, and test commands. Returns structured results consumed by the failure classifier. Introduced in Workflow Improvement P1.

**Failure classifier** — Error categorization module (`scripts/failure_classifier.py`) that maps stderr output to one of 8 canonical error codes and pattern IDs used by the self-healer.

**Self-healer** — Auto-remediation system (`scripts/self_healer.py`) that applies pattern-based fixes for classified failures. Operates in `suggest` mode (display fix) or `auto` mode (apply fix). Per-pattern circuit breaker reverts individual patterns to suggest mode on failures.

**Context compaction** — Checkpoint generation (`scripts/context_compactor.py`) that summarizes session progress, diff stats, and key decisions into a compact markdown file. Called every 2 phases during phase execution to manage context window exhaustion.

**Learning capture** — Signal extraction (`scripts/learning_capture.py`) that reads structured metadata (not raw transcripts) to produce staged diffs for prompt and CLAUDE.md improvements. Signals include corrections, constraints, and wrong-approach events.

**Skill router** — Contextual suggestion engine (`scripts/skill_router.py`) with 13 trigger rules that surfaces underused skills at relevant moments. Tracks dismissals per skill with configurable cooldown. Max 2 suggestions per session start.

**Domain triage** — LLM-based pre-filter that classifies which review domains are relevant to a given input before dispatching to review agents. Reduces review cost by skipping irrelevant domains. Implemented in `scripts/domain_triage.py`.

**Triage mode** — One of three modes controlling domain triage behavior: `full` (skip triage, dispatch all domains), `conservative` (only skip domains the LLM is confidently sure are irrelevant, threshold 0.8), `aggressive` (only dispatch domains the LLM explicitly marks as relevant). Default starts as `conservative` and promotes to `aggressive` after shadow validation.

**Triage orchestrator** — Central script (`scripts/triage_orchestrator.py`) that owns the triage → dispatch → TUI → telemetry flow. Single entry point called by all four review skills (stark-review, stark-team-review, stark-review-design, stark-review-plan) with || fallback to direct dispatch.

**Shadow mode** — Triage validation mode (`--shadow`) that dispatches all domains regardless of triage verdict but annotates each finding with `triage_would_skip: bool`. Used during shadow validation to measure triage accuracy without affecting review quality.

**Domain manifest** — JSON file (`global/prompts/triage/domains.json`) mapping review types (pr-review, design-review, plan-review) to their domain catalogues with slugs, labels, filenames, and semantic descriptions. Used by the triage engine to construct LLM prompts.
