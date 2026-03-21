# Spec: `/stark-review-plan` Claude Code Skill

**Date:** 2026-03-17
**Status:** Draft (rev 2 — addresses spec review findings)
**Author:** Aryeh + Claude

## Problem

The stark-skills system reviews PR code diffs but has no way to review design documents, specs, or implementation plans. Design quality issues caught late (during code review or after implementation) are expensive. We need the same multi-agent, multi-domain parallel review approach applied to plan documents before implementation begins.

## Solution

A Claude Code skill at `~/.claude/skills/stark-review-plan/SKILL.md` that:

1. Reads a design spec/plan document
2. Dispatches 3 LLMs × 7 prompts (6 domains + 1 general) = 21 parallel sub-agent reviews
3. The main Claude instance fixes the plan based on findings
4. Repeats for 3 review-fix cycles, then runs a 4th review-only round
5. Saves a `.review.md` sibling file alongside the plan
6. Posts to PR if on a branch with an open PR
7. Produces a prompt improvement assessment with hierarchy-aware recommendations
8. Merges learnings into a living knowledge log (global and/or repo level)

## Invocation

```
/stark-review-plan <path> [--rounds N] [--dry-run]
```

- `<path>` — path to the spec/plan document (required, must be a markdown file)
- `--rounds N` — number of fix cycles (default: 3, from config `plan_review.max_rounds`). Total rounds = N fix + 1 final review.
- `--dry-run` — no fixes to the plan, no PR posting, no review file written. History files are still persisted (for crash recovery and learnings). Terminal output only.
- PR detection: auto-detect via `gh pr view` if on a feature branch. If found, post review to PR after final round.

## Domains

Each agent gets 7 prompts — 6 specialized domains + 1 general holistic review:

| # | Domain ID | Label | Focus |
|---|-----------|-------|-------|
| 00 | general | General | Holistic review — overall coherence, contradictions between sections, anything domain prompts might miss |
| 01 | feasibility | Feasibility | Can this be built as described? Unrealistic assumptions, missing constraints, technical impossibilities, timeline vs. complexity mismatch |
| 02 | completeness | Completeness | Gaps: unhandled edge cases, missing error paths, undefined behavior, ambiguous requirements, missing acceptance criteria |
| 03 | security | Security & Compliance | Threat model gaps, auth assumptions, data flow issues, regulatory gaps, PII handling, supply chain risks |
| 04 | operability | Operability | Deployment strategy, monitoring, rollback, failure modes, observability, capacity planning, on-call burden |
| 05 | scope | Scope & Complexity | YAGNI violations, over-engineering, unnecessary abstraction, scope creep, features that don't serve stated goals |
| 06 | api-design | API & Interface Design | Contract clarity, versioning, backwards compatibility, integration points, error contracts, naming consistency |

### Prompt Structure

Each domain prompt follows the same structure as code review prompts:

```markdown
# {Domain} Review — Design Documents

You are reviewing a design document / spec / implementation plan.

## Checklist
- [ ] Item 1
- [ ] Item 2
...

## Severity Guide
- critical: Fundamental flaw that would cause project failure
- high: Significant gap that would cause major rework
- medium: Issue that should be addressed but won't block
- low: Minor improvement or style suggestion

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

Key differences from code review:
- Findings reference `section` (heading text) instead of `file` + `line`.
- Domain numbering starts at `00` (general), not `01`. The slug extraction must handle `00-general` → `general` correctly.

### Agent Preambles

Each agent gets a preamble (`agent.md`) that defines:
- Identity (which GitHub App bot it posts as)
- How it receives the document (full content in prompt)
- Output rules (JSON array only, empty `[]` if clean)
- Agent-specific strengths for plan review

## Workflow

### Phase 1: Setup

**1.1 Validate input**
- Confirm file exists and is readable
- Check if file has uncommitted changes (`git diff --name-only`). If so, warn: "Plan file has uncommitted changes that will be modified. Commit or stash first." Require `--force` to proceed, or abort.
- Read file content
- Store original content for diff at the end

**1.2 Detect PR context**

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

If on a feature branch with an open PR, store PR number for Phase 5. Not having a PR is fine — the skill still runs.

**1.3 Authenticate** (only if PR detected)

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Auth failure when PR exists → warn, continue without PR posting.

### Phase 2: Review-Fix Loop (Rounds 1-3)

For round = 1 to 3:

**2a. Dispatch sub-agents**

Send the current document content to all 21 sub-agents (3 agents × 7 domains) in parallel using a Python dispatch script.

**Parallelism mechanism:** A new script `scripts/plan_review_dispatch.py` handles parallel dispatch using `concurrent.futures.ThreadPoolExecutor(max_workers=21)`. Same pattern as `multi_review.py`'s `run_review_round()`. The script:
1. Reads the plan file
2. Resolves all 21 prompts (agent preamble + domain prompt + document content)
3. Dispatches all 21 CLI calls in parallel
4. Collects results with a per-call timeout of 5 minutes
5. Returns structured JSON to stdout (same contract as `multi_review.py --json-only`)

The skill invokes this script once per round:

```bash
$PYTHON $SCRIPTS/plan_review_dispatch.py --file <path> --round N [--timeout 300]
```

For each agent × domain combination, the script:
1. Loads agent preamble from `global/prompts/plan-review/{agent}/agent.md`
2. Loads domain prompt from `global/prompts/plan-review/{agent}/{NN-domain}.md`
3. Constructs full prompt: preamble + domain prompt + document content
4. Dispatches via CLI:

```
Claude: claude -p - --output-format text --model claude-opus-4-6  (prompt via stdin)
Codex:  codex exec -c 'model_reasoning_effort="xhigh"' --ephemeral --json -o <file> -  (prompt via stdin)
Gemini: GEMINI_CLI_HOME=$(mktemp -d) gemini --model gemini-2.5-pro -p "$instruction" -o json  (plan content via stdin)
```

Prompt resolution: repo → global (2 levels, most specific wins):

```
1. {repo}/.code-review/plan-prompts/{agent}/{NN-domain}.md  (repo override)
2. ~/.claude/code-review/prompts/plan-review/{agent}/{NN-domain}.md  (global)
```

Additional hierarchy levels (folder, org) can be added later if real usage shows a need.

**Sub-agent failure handling:**
- Timeout (>5 min): kill the process, record `{"error": "timeout", "duration_s": 300}` for that agent×domain
- Malformed JSON output: record `{"error": "parse_error", "raw_output": "..."}`, skip findings from that call
- CLI not found / crash: record `{"error": "agent_unavailable", ...}`, continue with remaining agents
- Minimum coverage: if fewer than 50% of sub-agents return valid results, warn but continue. The round is still usable with partial data.
- Total failure (0 valid results): skip fixing, report error, move to next round

**2b. Parse and classify findings**

Parse JSON output from each sub-agent. For each finding:

| Status | Criteria |
|--------|----------|
| `fix` | Severity >= fix_threshold (default: medium). Claude reads the referenced section and confirms the issue exists. |
| `recurring` | Same section + same domain as a finding from a previous round that was supposedly fixed. |
| `false_positive` | Claude reads the section and determines the described problem doesn't exist or is already addressed. |
| `noise` | Subjective, stylistic, or single-agent finding contradicted by the other 2. |
| `ignored` | Below fix_threshold. |

Cross-reference: 2+ agents flagging the same section with the same concern = `high_confidence`.

**2c. Fix the plan**

The main Claude instance edits the plan file directly to address all `fix` and `recurring` findings. This means:
- Adding missing sections or details
- Clarifying ambiguous requirements
- Adding error handling, edge cases, rollback strategies
- Removing over-engineered or out-of-scope content
- Fixing contradictions

Skipped in `--dry-run` mode.

**2d. Persist round**

Write round data to `~/.claude/code-review/history/plan-reviews/{plan-filename}/round-{N}.json`:

```json
{
  "round": 1,
  "plan_file": "/path/to/plan.md",
  "results": [
    {
      "agent": "claude",
      "domain": "feasibility",
      "findings": [...],
      "error": null,
      "duration_s": 32.1
    }
  ],
  "classifications": {
    "fix": 5,
    "recurring": 0,
    "false_positive": 2,
    "noise": 1,
    "ignored": 3
  }
}
```

**2e. Early termination** — if a fix round produces zero findings at or above fix_threshold, skip remaining fix rounds and go directly to the final review-only round. No point dispatching 21 sub-agents again if nothing was found.

### Phase 3: Final Review

Run one more dispatch of all 21 sub-agents against the (possibly fixed) plan. This round is review-only — no fixes applied. The findings from this round represent the final state of the plan.

If the final round produces zero findings at or above fix_threshold → plan is clean.
If findings remain → they're reported in the summary as unresolved.

### Phase 4: Summary

Generate a consolidated markdown summary:

**4a. All Findings Table**

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|
| 1 | 1 | claude, gemini | security | critical | Auth Flow | No token rotation | fixed (round 1) |
| 2 | 1,2 | codex | completeness | high | Error Handling | Missing retry logic | recurring → fixed (round 2) |
| 3 | 4 | gemini | operability | medium | Deployment | No canary strategy | unresolved |

**4b. Fixed** — findings addressed, grouped by round.

**4c. Recurring** — findings that appeared in 2+ rounds. Which round resolved them.

**4d. Unresolved** — findings from round 4 that remain. These are the review's final concerns.

**4e. False Positives & Noise** — one-line reasoning per finding.

**4f. Changes Made** — diff summary of what was changed in the plan across rounds 1-3.

**4g. Prompt Improvement Assessment** — analysis of prompt quality (see below).

#### Prompt Improvement Assessment (section 4g)

Analyze patterns across all rounds:

| Signal | Diagnosis | Recommended Level | File |
|--------|-----------|-------------------|------|
| Agent X consistently produces false positives in domain Y across multiple plans | Prompt too aggressive | **Global** | `global/prompts/plan-review/{agent}/{NN-domain}.md` |
| Agent X false positives only for this repo's plans | Prompt doesn't fit repo conventions | **Repo** | `{repo}/.code-review/plan-prompts/{agent}/{NN-domain}.md` |
| Agent X false positives only for plans in this folder | Prompt doesn't fit this plan type | **Folder** | `{folder}/.code-review/plan-prompts/{agent}/{NN-domain}.md` |
| All agents miss a real issue found during fixing | Domain prompt gap | **Global** (all agents) | `global/prompts/plan-review/*/{NN-domain}.md` |
| Findings irrelevant to plan type (e.g., API review on infra plan) | Wrong domain enabled | **Repo/folder config** | `disabled_domains` in config |
| Agent produces unparseable output | Agent preamble broken | **Global** agent preamble | `global/prompts/plan-review/{agent}/agent.md` |

**Decision rule:** most specific level that would fix the problem. Only promote to global when the pattern repeats across repos. If it's a single repo → repo level. Single folder → folder level.

Recommend only — do NOT auto-modify prompts. Recommendations feed into `/stark-review-improvement`.

### Phase 5: Output & Persist

**5a. Terminal** — print the consolidated summary.

**5b. Review file** (skipped in `--dry-run`): write `{plan-name}.review.md` alongside the original plan file. If the plan is `docs/specs/2026-03-13-forms-platform-design.md`, the review goes to `docs/specs/2026-03-13-forms-platform-design.review.md`.

**5c. Post to PR** (if PR detected and not `--dry-run`):

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review {number} --comment --body "$summary"
```

Or via Python API:

```python
import sys
sys.path.insert(0, "SCRIPTS_DIR")
from github_app import pr_review
pr_review("org/repo", PR_NUMBER, event="COMMENT", body=summary_body)
```

If posting fails, warn but don't fail.

**5d. Save history** — write to `~/.claude/code-review/history/plan-reviews/{plan-filename}/`:

| File | Content | When Written |
|------|---------|-------------|
| `rounds.json` | All rounds: findings, classifications, outcomes | After all rounds (single file, not per-round) |
| `summary.md` | Human-readable final summary (includes prompt assessment and changes diff) | After all rounds |

Two files total. If crash recovery is needed, write a temporary `in-progress.json` during the review that is replaced by `rounds.json` at the end.

History files are always written, even in `--dry-run` mode.

### Phase 6: Learning Log (V2 — deferred)

The `summary.md` history files capture per-review learnings including the prompt improvement assessment. A consolidated learning log that merges patterns across reviews will be added in V2 once enough review history exists to make aggregation meaningful. For V1, the `/stark-review-improvement` skill can analyze accumulated `summary.md` files from `~/.claude/code-review/history/plan-reviews/` to identify patterns manually.

## Files to Create/Modify

| Action | File | Description |
|--------|------|-------------|
| Create | `skill/stark-review-plan/SKILL.md` | Skill definition |
| Create | `scripts/plan_review_dispatch.py` | Parallel dispatch script (ThreadPoolExecutor) |
| Create | `scripts/test_plan_review_dispatch.py` | Tests for dispatch script |
| Create | `global/prompts/plan-review/claude/agent.md` | Claude agent preamble for plan review |
| Create | `global/prompts/plan-review/claude/00-general.md` | General/holistic review prompt |
| Create | `global/prompts/plan-review/claude/01-feasibility.md` | Feasibility domain prompt |
| Create | `global/prompts/plan-review/claude/02-completeness.md` | Completeness domain prompt |
| Create | `global/prompts/plan-review/claude/03-security.md` | Security & compliance domain prompt |
| Create | `global/prompts/plan-review/claude/04-operability.md` | Operability domain prompt |
| Create | `global/prompts/plan-review/claude/05-scope.md` | Scope & complexity domain prompt |
| Create | `global/prompts/plan-review/claude/06-api-design.md` | API & interface design domain prompt |
| Create | `global/prompts/plan-review/codex/agent.md` | Codex agent preamble |
| Create | `global/prompts/plan-review/codex/00-general.md` | Codex general review prompt |
| Create | `global/prompts/plan-review/codex/01-feasibility.md` | Codex feasibility prompt |
| Create | `global/prompts/plan-review/codex/02-completeness.md` | Codex completeness prompt |
| Create | `global/prompts/plan-review/codex/03-security.md` | Codex security prompt |
| Create | `global/prompts/plan-review/codex/04-operability.md` | Codex operability prompt |
| Create | `global/prompts/plan-review/codex/05-scope.md` | Codex scope prompt |
| Create | `global/prompts/plan-review/codex/06-api-design.md` | Codex API design prompt |
| Create | `global/prompts/plan-review/gemini/agent.md` | Gemini agent preamble |
| Create | `global/prompts/plan-review/gemini/00-general.md` | Gemini general review prompt |
| Create | `global/prompts/plan-review/gemini/01-feasibility.md` | Gemini feasibility prompt |
| Create | `global/prompts/plan-review/gemini/02-completeness.md` | Gemini completeness prompt |
| Create | `global/prompts/plan-review/gemini/03-security.md` | Gemini security prompt |
| Create | `global/prompts/plan-review/gemini/04-operability.md` | Gemini operability prompt |
| Create | `global/prompts/plan-review/gemini/05-scope.md` | Gemini scope prompt |
| Create | `global/prompts/plan-review/gemini/06-api-design.md` | Gemini API design prompt |
| Modify | `install.sh` | Add skill symlink for stark-review-plan |
| Modify | `CLAUDE.md` | Document `/stark-review-plan` skill |

Total: 24 prompt files (3 agents × 8 files) + 1 dispatch script + 1 test file + 1 SKILL.md + 2 modifications = 29 files.

## Config Integration

Same hierarchical config as code review. Plan review uses its own config keys:

```json
{
  "plan_review": {
    "agents": ["claude", "codex", "gemini"],
    "fix_threshold": "medium",
    "disabled_domains": [],
    "max_rounds": 3
  }
}
```

Nested under `plan_review` to coexist with code review config in the same `config.json`. Repo config overrides global (full replacement per key).

| Key | Type | Description |
|-----|------|-------------|
| `agents` | `string[]` | Which LLM agents to use |
| `fix_threshold` | `string` | Minimum severity to fix: `critical`, `high`, `medium`, `low` |
| `disabled_domains` | `string[]` | Domain IDs to skip (e.g., `["api-design"]` for infra-only plans) |
| `max_rounds` | `number` | Replace | Number of fix cycles before the final review-only round. Total rounds = max_rounds + 1. CLI `--rounds` overrides this. |

## What the Skill Does NOT Do

- Does not create worktrees (edits the plan file in place)
- Does not run tests or builds (no code to test)
- Does not auto-modify prompts (recommends only)
- Does not merge the PR
- Does not work on non-markdown files
- Does not pause between rounds (fully autonomous)

## Differences from `/stark-review`

| Aspect | `/stark-review` (code) | `/stark-review-plan` (plans) |
|--------|----------------------|----------------------------|
| Input | PR diff | Markdown file |
| Domains | 6 code-focused | 6 plan-focused + 1 general |
| Fix loop | Edit code in worktree | Edit plan file in place |
| Verification | Build + test after fixes | No verification (review-only round 4) |
| Rounds | Up to N, stop when clean | max_rounds fix + 1 final review (default 3+1) |
| Orchestrator | `multi_review.py` | `plan_review_dispatch.py` (parallel dispatch, JSON output) |
| Worktree | Yes (isolated) | No (edits in place) |
| Learning log | No | Yes (global + repo) |
| Finding ref | file + line | section (heading text) |
