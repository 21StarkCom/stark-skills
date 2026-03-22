# Glossary

**Sibling repos** — Directories under the same parent directory as the target project that contain a `.git/` subdirectory and whose origin remote points to the same host and organization. Used in cross-repo update operations to scope which repositories receive propagated changes.

<!-- needs review -->
**Custom lookarounds** — The regex pattern `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` used instead of `\b` word boundaries to correctly match project names containing hyphens and dots without false-matching inside longer identifiers.

**AI-DD Tracker** — The GitHub Projects V2 board (`GetEvinced/projects/8`) used as the canonical workflow state machine for the stark-skills pipeline. Tracks task lifecycle from backlog through done with 11 status states and 14 custom fields.

**LEGAL_TRANSITIONS** — The dict in `github_projects.py` encoding all allowed status transitions in the workflow state machine. Used by `transition_status()` to enforce that only valid state changes are applied.

**Release gate** — A composite quality check (PR approved + CI pass + docs complete + artifacts linked + release approval + rollout notes) enforced via a GitHub Actions status check named `release-gate`. Must pass before PR merge is allowed.

**Spec completeness gate** — Validation that blocks tasks from entering `ready for agent` unless Risk and AI Suitability fields are set, and Spec Approval is `approved` for high-risk items.
