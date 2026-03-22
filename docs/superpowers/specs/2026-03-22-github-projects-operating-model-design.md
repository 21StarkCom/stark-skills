# GitHub Projects Operating Model — Design Spec

## Summary

This spec defines an operating model for AI-assisted development at Evinced using GitHub Issues, GitHub Projects V2, automation, and LLM agents. It replaces the current label-based workflow tracking with a structured system where Issues define intent, Projects define workflow state, automation enforces deterministic rules, and LLMs reason within explicit bounds.

The first implementation target is integrating GitHub Projects V2 into the stark-skills pipeline (`stark-plan-to-tasks`, `stark-phase-execute`, `stark-pr-flow`, `stark-review`, `stark-session`).

## Governing Principles

1. **Issues define intent** — the work contract.
2. **Projects define workflow state** — the single source of truth for lifecycle.
3. **LLMs reason within explicit bounds** — decomposition, interpretation, drafting, risk identification. Not control flow.
4. **Automation executes and enforces deterministic rules** — state transitions, gate checks, field validation, routing.
5. **Humans approve ambiguity, risk, and exceptions.**
6. **Documentation and verification are release gates.**
7. **Any rule that can be enforced mechanically must be implemented in code, not prompts.**

## Entity Model

### Issue = Work Contract

Every issue defines:

- **Objective** — what this work achieves
- **Context** — why this work matters now
- **Scope** — what is included
- **Non-goals** — what is explicitly excluded
- **Constraints** — technical, timeline, or policy constraints
- **Dependencies** — links to blocking issues or external requirements
- **Acceptance criteria** — testable, observable, reviewable conditions
- **Rollout and rollback notes** — how to deploy and undo (medium/high risk)
- **Required artifacts** — what must be produced (docs, tests, configs)
- **Risk class** — low, medium, high

Requirements within issues must be:

- Testable
- Observable
- Reviewable

Specs should prefer structured fields, explicit rules, examples, and edge cases over prose.

Large efforts decompose into parent issues + sub-issues with explicit dependencies.

Forbidden actions and decision boundaries must be stated explicitly.

### Project = Workflow State Machine

One durable project per team, product area, or program. Multiple views on the same project — not overlapping projects.

The project owns workflow state. Labels classify work type but do not control workflow. Approval state is separate from execution state.

### PR = Change Artifact

Implements the issue's intent. Links back to issue (`Closes #N`). Carries CI results, review comments, generated documentation. Never exists without an issue.

### Linking Contract

```
Issue (intent) ←→ Project (lifecycle)
                ←→ PR (change)
                ←→ Design docs
                ←→ CI results
                ←→ Verification artifacts
                ←→ Rollout checklist
```

Every work item links to: design docs, PRs, CI results, generated docs, rollout checklists, post-deploy verification.

## State Machine

### Status Values

Agent path:
```
backlog → needs spec → ready for agent → agent working → human review → ready to merge → ready to release → done
```

Human path (AI Suitability = `human-led`):
```
backlog → needs spec → human working → human review → ready to merge → ready to release → done
```

Additional states:
- `needs clarification` — entered from `agent working` when agent detects ambiguity. Returns to `ready for agent` after human resolves.
- `blocked` — entered from any active state. Requires reason + unblock criteria. Exit: human sets Blocked Reason to empty and transitions back to the previous state (or to `backlog` if the original state is no longer valid).

### Transition Rules

| Transition | Trigger | Actor |
|-----------|---------|-------|
| backlog → needs spec | Triage | Human or automation (priority/risk rules) |
| needs spec → ready for agent | Spec completeness gate passed | Automation (field check) + human approval for high-risk (Approval State = `approved`) |
| needs spec → human working | Human claims work | Human — for `human-led` AI suitability. Spec completeness gate still applies. |
| ready for agent → agent working | Assignment | Automation (routes by AI suitability) |
| agent working → needs clarification | Ambiguity detected | LLM raises flag; does NOT resolve |
| needs clarification → ready for agent | Clarification provided | Human |
| agent working → human review | PR created | Automation (PR event triggers transition) |
| human working → human review | PR created | Automation (same PR event trigger) |
| human review → agent working / human working | Changes requested | Automation (branches on AI Suitability field) |
| human review → ready to merge | Approved | Human |
| ready to merge → ready to release | All gates pass | Automation (composite gate: CI, docs, artifacts, rollout notes, Approval State for non-low-risk) |
| ready to release → done | PR merged | Automation (PR merge event). PR merge blocked via required status check until Status = `ready to release`. |
| blocked → previous state | Unblocked | Human (clears Blocked Reason, sets target state) |
| any → blocked | Blocker identified | Human or LLM (with reason + unblock criteria) |

**State regression on new commits:** If new commits are pushed to a PR after approval (`ready to merge` or `ready to release`), the GitHub Action on `pull_request.synchronize` resets Status to `human review` and clears Approval State to `pending`. This prevents stale approvals from gating merge.

**Rejected Approval State:** When a human sets Approval State to `rejected`, the item transitions to `needs spec` (requires rework) or `blocked` (if the rejection is a hard stop). The human must set the target state explicitly — automation does not auto-route rejections.

### Spec Completeness Gate

Applies to BOTH `ready for agent` AND `human working` transitions. Work does not enter either state unless:

- Objective, scope, and acceptance criteria are populated
- Risk class is set
- AI suitability is classified: `autonomous`, `assisted`, or `human-led`
- Dependencies are resolved or explicitly deferred
- For medium/high risk: verification plan is linked
- For high-risk: Approval State = `approved`

`human-led` work uses a different path through the state machine:
`backlog → needs spec → human working → human review → ready to merge → ready to release → done`
This skips `ready for agent` and `agent working` entirely. The `human working` state is functionally equivalent to `agent working` but signals that a human is implementing.

## Project Custom Fields

| Field | Type | Values / Notes |
|-------|------|---------------|
| Status | Single select | backlog, needs spec, ready for agent, agent working, human working, needs clarification, human review, ready to merge, ready to release, done, blocked |
| Priority | Single select | critical, high, medium, low |
| Owner | Text | Person or team responsible |
| Iteration | Iteration | Sprint/cycle (GitHub native) |
| Risk | Single select | high, medium, low |
| AI Suitability | Single select | autonomous, assisted, human-led |
| Spec Approval | Single select | not required, pending, approved, rejected. Gates `ready for agent` / `human working` for high-risk items. Reset is not needed — once spec is approved, it stays approved. |
| Release Approval | Single select | not required, pending, approved, rejected. Gates `ready to release` for non-low-risk items. Set to `pending` when Status reaches `ready to merge`. Reset to `pending` on PR state regression (new commits after approval). |
| Documentation State | Single select | not started, drafted, reviewed, complete |
| Agent | Single select | claude, codex, gemini, none |
| Story Points | Number | 1, 2, 3, 5, 8, 13 |
| Phase | Text | Plan phase name for traceability |
| Review Rounds | Number | Incremented by automation on each review cycle |
| Blocked Reason | Text | Why blocked + unblock criteria |

## Project Views

| View | Type | Grouped By | Filtered By | Purpose |
|------|------|-----------|------------|---------|
| Board | Board | Status | — | Daily operational kanban |
| By Agent | Table | Agent | Status ≠ done | Agent workload |
| By Phase | Table | Phase | — | Plan execution progress |
| Risk View | Table | Risk | Status ≠ done, Risk ≠ low | Attention queue |
| Needs Attention | Board | Status | needs clarification, blocked, human review | Human action queue |
| Sprint | Board | Status | Current iteration | Sprint planning |
| Roadmap | Roadmap | — | — | Leadership timeline |

## Label Migration

| Current Label | Migration | Keep Label? |
|--------------|-----------|------------|
| `type:feature`, `type:task`, `type:bug` | GitHub Issue Type (native) | Yes — classifies, doesn't control |
| `sp:*` | Story Points field | No — field is source of truth |
| `risk:*` | Risk field | No |
| `confidence:*` | Replaced by AI Suitability | No |
| `plan:{slug}` | Phase field | Yes — cross-project query fallback |
| `stark-plan-to-tasks` | Provenance marker | Yes |

## Automation Layer

**Constraint:** `projects_v2_item` is a webhook event but NOT a valid GitHub Actions trigger. Actions cannot fire on Project field changes. All Project V2 mutations happen in bot scripts. Actions handle only: `issues`, `pull_request`, `pull_request_review`, and `schedule` events.

### Automation Responsibility Matrix

Each transition has exactly one owner. No shared ownership.

| Transition | Owner | Mechanism |
|-----------|-------|-----------|
| → backlog (defaults on add) | Bot script | `stark-plan-to-tasks` or utility module sets defaults when adding to project |
| backlog → needs spec | Human | Manual triage or bot script (priority/risk heuristic) |
| needs spec → ready for agent | Bot script | `transition_status()` with gate validation. Human approval required for high-risk. |
| needs spec → human working | Human | Manual — for `human-led` AI suitability |
| ready for agent → agent working | Bot script | `stark-phase-execute` picks task, sets Agent + Status |
| agent working → needs clarification | Bot script | `stark-phase-execute` detects ambiguity, sets Status, posts comment |
| needs clarification → ready for agent | Human | Manual — after providing clarification |
| agent working → human review | GitHub Action | `pull_request.opened` event — extracts issue number from `Closes #N`, updates Status via utility module |
| human working → human review | GitHub Action | Same as above — PR opened triggers transition |
| human review → agent working / human working | GitHub Action | `pull_request_review.submitted` (changes_requested) — reads AI Suitability field. If `human-led` → `human working`. Otherwise → `agent working`. |
| human review → ready to merge | GitHub Action | `pull_request_review.submitted` (approved) — updates Status via utility module |
| ready to merge → ready to release | GitHub Action | Composite gate: triggered by `check_run.completed` / `pull_request.synchronize` / `pull_request_review.submitted`. Re-evaluates all gates (CI, docs, artifacts, rollout notes, Approval State for non-low-risk). Transitions only when all pass. |
| ready to release → done | GitHub Action | `pull_request.closed` (merged) — updates Status, closes issue. **Note:** For repos with deploy pipelines, `done` should be triggered by deploy success, not merge. This is configurable per-repo. Default: merge = done (appropriate for libraries and tools). Override: deploy webhook = done (appropriate for services). |

**PR merge blocking mechanism:** Branch protection requires a status check named `release-gate`. A GitHub Action sets this check to `success` when it transitions an issue to `ready to release`, and resets to `pending` on `pull_request.synchronize` (new commits). This bridges Project field state into branch protection's status check model.
| any → blocked | Human or Bot script | Manual or stale detection. Blocked Reason required. |

### GitHub Actions (PR and schedule events only)

| Trigger | Action |
|---------|--------|
| `pull_request.opened` | Extract `Closes #N` from body. Call utility module: Status → `human review` |
| `pull_request_review.submitted` (changes_requested) | Read AI Suitability from Project. Status → `agent working` (autonomous/assisted) or `human working` (human-led) |
| `pull_request_review.submitted` (approved) | Call utility module: Status → `ready to merge` |
| `pull_request.synchronize` / `check_run.completed` / `pull_request_review.submitted` | On any of these events for a PR whose issue Status = `ready to merge`: re-evaluate all gates (CI pass, docs, artifacts, rollout notes). If all pass → Status → `ready to release`. Uses a composite gate check, not `check_suite.completed` (which is unreliable for compound conditions). |
| `pull_request.closed` (merged) | Call utility module: Status → `done`. Close linked issue. |
| `schedule` (hourly) | Stale detection: `agent working` > N hours → warning → blocked. `needs clarification` > 48h → notify. |

### Bot Scripts (stark-skills integration)

| Trigger | Action |
|---------|--------|
| `stark-plan-to-tasks` creates issues | Add to team Project. Set Phase, Story Points, Risk, AI Suitability, defaults (Status, Documentation State, Approval State) |
| `stark-phase-execute` picks task | Claim sequence: (1) read Status, verify = `ready for agent`. (2) Set Status → `agent working`. (3) Set Agent field. These are two separate GraphQL mutations — true atomicity is not possible with the Projects V2 API. **Accepted risk:** in the rare case of two agents racing, both may claim the same task. Mitigation: (a) the second agent's PR will fail to create a branch if the first already has one, catching the conflict at implementation time; (b) stale detection flags duplicate `agent working` items; (c) in practice, `stark-phase-execute` runs sequentially per session, not in parallel across multiple sessions on the same project. |
| `stark-phase-execute` detects ambiguity | Status → `needs clarification`. Post comment with specific question. Do NOT resolve. |
| `stark-review` posts findings | Increment Review Rounds. Initial value: 0. First review sets to 1. No-findings runs do NOT increment. |
| `stark-session end` | Update Documentation State for touched issues. Verify artifact links. |
| Gate validation (called by Actions or scripts) | Check spec completeness, doc completeness, artifact links, rollout notes. Return pass/fail + reasons. |

### Gate Validations

| Check | When | Enforcement |
|-------|------|-------------|
| Spec completeness | Before `ready for agent` | Required: objective, scope, acceptance criteria, risk class, AI suitability |
| Documentation completeness | Before `ready to release` | Required: summary, intent, scope, behavior changes, verification. Documentation State must = `complete` |
| Verification plan exists | Before `ready for agent` (medium/high risk) | Linked artifact required |
| Test coverage | Before `ready to merge` | CI must pass |
| Required artifact links | Before `ready to release` | Issue must link to: PR, CI results, docs |
| Rollout/rollback notes | Before `ready to release` (medium/high risk) | Field must be non-empty |

## LLM Boundaries

### LLM Does

- Decompose plans into issues with structured fields
- Draft spec content (objective, scope, acceptance criteria)
- Detect ambiguity and flag for human clarification
- Generate implementation from spec
- Draft documentation (delta-oriented: what changed, why, what didn't, what was verified, what was inferred)
- Identify risks and suggest risk classification
- Summarize review findings
- Plan verification approach
- Interpret and reason about requirements

### LLM Does Not

- Control state transitions (can recommend, cannot execute)
- Enforce or waive policy gates
- Approve its own spec
- Assign itself work
- Maintain process memory across sessions (Project fields and automation are the state store)
- Make sensitive action decisions without human approval

## Documentation Requirements

Documentation is required by the issue, not left to agent discretion.

### Standard Structure

- Summary
- Intent
- Scope
- Assumptions
- Interfaces
- Behavior changes
- Risks
- Rollout
- Rollback
- Verification
- Open questions

### Delta Orientation

Documentation must describe:
- What changed
- Why it changed
- What did not change
- What was verified
- What was inferred

## Verification Requirements

- Every important requirement maps to: implementation, tests, documentation
- Medium/high-complexity work requires a verification plan before execution
- Automation runs all deterministic checks: schema validation, linting, unit tests, integration tests, dependency checks, required file checks, documentation checks, policy checks

## Implementation Mapping: stark-skills Changes

### `stark-plan-to-tasks`

Current: Creates issues with labels. No Project integration.

Changes:
1. Accept `--project` flag or auto-detect team project from repo config
2. After issue creation, add to Project via GraphQL `addProjectV2ItemById`
3. Set custom fields: Phase, Story Points, Risk, AI Suitability, Status (→ `backlog` or `needs spec`)
4. Issue body template expanded: add non-goals, constraints, rollout/rollback, required artifacts sections
5. Stop creating `sp:*`, `risk:*`, `confidence:*` labels (keep `type:*` and `plan:*`)
6. Classify each task for AI suitability during decomposition (LLM judges: autonomous/assisted/human-led based on risk, ambiguity, spec completeness)

### `stark-phase-execute`

Current: Fetches issues by label, picks all, drives full workflow via LLM.

Changes:
1. Fetch tasks from Project (filter: Status = `ready for agent`, AI Suitability ∈ {autonomous, assisted})
2. On task pickup: update Project fields (Agent, Status → `agent working`) via GraphQL
3. On ambiguity detected: set Status → `needs clarification`, post comment, skip task — do NOT attempt resolution
4. On PR creation: automation handles Status → `human review` (not the skill)
5. On review feedback with changes requested: automation sets Status → `agent working` (not the skill)
6. Respect the gate: do not pick up issues that don't meet spec completeness threshold
7. For `assisted` tasks: agent works but flags decision points for human review inline

### `stark-pr-flow`

Current: Push, create PR, review, merge. No project awareness.

Changes:
1. PR body includes structured link to issue
2. On merge: automation handles Status → `done` and issue close
3. Verify Documentation State before allowing merge (or flag if incomplete)

### `stark-review`

Current: Multi-agent review posts findings as PR comments.

Changes:
1. After posting findings: increment Review Rounds field on Project via GraphQL
2. Structure findings with severity classification (for future analytics)

### `stark-session`

Current: Start loads context, end does cleanup.

Changes:
1. Session start: query Project for items assigned to current agent/user, Status = `agent working`
2. Session end: update Documentation State for all touched issues. Verify artifact links present.

### New: `github-projects` utility module

A shared Python module (in `scripts/`) for Project operations:
- `find_project(org, name)` — find project by name
- `add_issue_to_project(project_id, issue_id)` — add item
- `set_field(item_id, field_name, value)` — update custom field
- `get_field(item_id, field_name)` — read custom field
- `transition_status(item_id, new_status, validate=True)` — transition with gate validation
- `get_items(project_id, filters)` — query items with field filters

This module encapsulates all GraphQL complexity and is used by all skills.

**API constraints:**
- `get_items()` filters are applied client-side. GitHub Projects V2 GraphQL does not support server-side filtering by custom field values. For projects under ~200 items this is acceptable. For larger projects, consider caching or pagination optimization.
- Owner is a Text field, not Assignees. GitHub's `updateProjectV2ItemFieldValue` cannot set native Assignees. If we later want to use Assignees, a separate `addAssigneesToAssignable` mutation is needed.
- Story Points is a Number field (not Single Select) to enable summation in views. The utility module should soft-validate against allowed values (1, 2, 3, 5, 8, 13) but not hard-reject.
- Review Rounds initial value is 0. First review sets it to 1. No-findings runs do not increment.

**Error handling:**
- GraphQL call failure on **status transitions**: retry once with backoff. On second failure, **fail closed** — abort the operation, log error, post comment on issue. If Projects is the source of truth for state, silently continuing with stale state violates the model.
- GraphQL call failure on **read-only queries** (e.g., get_items, get_field): retry once, then log warning and continue with cached/default values where safe.
- Field not found on project: log warning. Likely means project is misconfigured. Raise to human.
- Project not found: abort with clear error message including expected project name and org.
- Rate limiting: `stark-plan-to-tasks` creating 20+ issues will make 100+ mutations. Batch with 100ms delay between calls. Monitor for 429 responses.
- Idempotency: `transition_status()` checks current status before mutating. If already in target status, no-op. If agent crashes mid-task, stale detection picks it up.
- Concurrency: `transition_status()` implements optimistic locking — reads current status, validates transition is legal, mutates. If status changed between read and write (race), the mutation succeeds but may be logically invalid. Mitigation: the stale detection scheduled job reconciles state hourly. For `ready for agent → agent working`, the atomic claim pattern (read + set Agent + Status in rapid succession) reduces the race window.
- Rollback: if a multi-step operation fails partway (e.g., issue added to project but fields not set), the utility module logs the partial state. The scheduled reconciliation job detects items with missing required fields and flags them for manual attention.

**Gate input locations (machine-validatable):**
- **Artifact links:** Issue body must contain URLs in a `## Artifacts` section (regex-parseable). Automation validates URLs are non-empty and match expected patterns (GitHub PR URL, docs URL, CI URL).
- **Rollout/rollback notes:** Issue body `## Rollout` and `## Rollback` sections. Non-empty check.
- **Verification plan:** Issue body `## Verification` section with linked test plan, or a separate linked issue with `type:test-plan` label.
- **Documentation State:** Project field — set by bot scripts, not parsed from issue body.

**Actions → Project item lookup:**
GitHub Actions triggered by PR events need to find the correct Project item. Mechanism:
1. Extract issue number from PR body (`Closes #N`)
2. Query `node(id: <issue_node_id>) { projectItems { nodes { id, project { title } } } }` to find the project item
3. Cache project field IDs per project (field IDs are stable within a project). Store in `.github/project-config.json` or as Action environment variables.

**LLM access to utility module:**
The LLM (via stark-skills) calls `transition_status()` only for transitions it owns per the Responsibility Matrix. The utility module validates that the requested transition is legal from the current state. The module does NOT check whether the caller is authorized — that enforcement lives in the skill logic (e.g., `stark-phase-execute` only calls `agent working`, never `done`).

### New: GitHub Actions workflows

Repository-level workflows (`.github/workflows/`) that enforce:
- Issue field completeness on issue events
- Status transitions on PR events (opened, reviewed, merged)
- Stale detection on schedule
- Gate validation before release-state transitions

These live in a shared workflow repo or as reusable workflows.

## Migration Plan

### Pre-requisites (Day 1 checklist)
- [ ] Create org-level Project with all 13 custom fields defined
- [ ] Configure Project auto-add rules for target repo(s)
- [ ] Enable GitHub Projects V2 built-in automations: auto-archive done items (30 days). Do NOT enable auto-set-status-on-close — we own the `done` transition via our Action on PR merge to avoid dual ownership.
- [ ] Verify GitHub App permissions: stark-claude, stark-codex, stark-gemini need `read:project` and `write:project` scopes. Update app installations if needed.
- [ ] Notify team: new workflow, what changes, what stays the same

### Phase 1: Foundation (week 1-2)
- Create `github-projects` utility module
- Create one test Project with all custom fields
- Modify `stark-plan-to-tasks` to add issues to Project and set fields
- Verify: issues appear in Project with correct field values

### Phase 2: Workflow Integration (week 3-4)
- Modify `stark-phase-execute` to query Project for `ready for agent` tasks
- Add field updates on task pickup, ambiguity detection, PR creation
- Create GitHub Actions for PR-triggered status transitions
- Verify: status transitions fire correctly through a full task lifecycle

### Phase 3: Gates and Validation (week 5-6)
- Implement spec completeness gate (blocks `ready for agent` if fields missing)
- Implement documentation completeness gate (blocks `ready to release`)
- Add stale detection workflows
- Add Review Rounds tracking to `stark-review`

### Phase 4: View Setup and Label Migration (week 7)
- Create all 7 views on the Project
- Migrate existing open issues: backfill Project fields from labels
- Stop emitting deprecated labels (`sp:*`, `risk:*`, `confidence:*`) in new issues
- Keep deprecated labels on existing issues for backward compat (no bulk delete)

## Migration Rollback Plan

If the migration causes issues at any phase:
- **Phase 1-2:** Skills still write labels alongside Project fields. Revert by switching skills back to label-only mode. No data loss — labels are the fallback.
- **Phase 3:** Gates can be disabled by setting required status checks to optional in branch protection. Does not require code changes.
- **Phase 4:** Label emission continues for `type:*` and `plan:*`. Old label-based queries still work. Stop-the-world rollback: revert skill changes, keep Project as read-only view.

The migration is designed to be additive through Phase 2 — Project fields are written IN ADDITION to labels, not instead of. Label removal (Phase 4) only happens after Project-based workflow is validated.

## Open Questions

1. **Project naming convention** — `{team}-board` or `{product-area}-board`? Needs org input.
2. **Stale thresholds** — how long in `agent working` before flagging? Suggest 4 hours for autonomous, 24 hours for assisted. Needs calibration.
3. **`human-led` routing** — resolved: same Project, uses `human working` status instead of `agent working`. Skips `ready for agent`. Human manually transitions `needs spec → human working`.
4. **Cross-org projects** — GetEvinced has multiple repos. One project spanning all repos, or one per team with cross-repo issues? Recommend per-team.
5. **Iteration cadence** — align with existing sprint cadence or define independently?
6. **Event emission** — this spec covers the Project integration. The event stream (Layer A from the original brainstorm) is a separate spec. Should they be designed together or sequentially?
