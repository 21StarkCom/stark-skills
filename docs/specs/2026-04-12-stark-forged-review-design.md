# stark-forged-review — Design

**Status:** Draft
**Author:** Aryeh Kiovetsky (brainstorm w/ Claude)
**Date:** 2026-04-12
**Supersedes:** `stark-review` (decomissioned at launch)

## 1. Purpose

`/stark-forged-review` replaces `/stark-review` with a thorough, multi-agent PR code review that escalates non-trivial findings into a full forge-style design→plan→implement loop. Single entry point for "review this PR and ship it."

**Pipeline shape:**

```
triage → leader+2nd-opinion review → gate → [light path | forge path] → delta re-review loop → auto-merge (if clean)
```

Design principles, in order:
1. **Lean SKILL.md.** The skill is a thin dispatcher; all logic lives in Python. Prompts are loaded by scripts, not inlined into the skill.
2. **Thin prompts.** Each prompt is tightly scoped with a fixed JSON output contract so merge logic is mechanical.
3. **Reuse existing primitives.** Triage, dispatch, worktree, audit, emit — all reuse existing modules where possible.
4. **Minimal friction when clean.** Auto-merge with single keystroke when the PR passes all rounds.
5. **Durable state.** `.forged-review-state.json` enables resume.

## 2. Arguments

```
/stark-forged-review [PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]
```

| Argument | Meaning |
|----------|---------|
| `PR_NUMBER` | Optional; detected from current branch via `gh pr view --json number` if omitted |
| `--dry-run` | Review and generate artifacts; no commits, pushes, or merge |
| `--repo ORG/REPO` | Override repo detection |
| `--resume` | Resume from `.forged-review-state.json` in the worktree |
| `--no-escalate` | Forbid the forge path; always fix in place |
| `--force-escalate` | Always take the forge path regardless of gate |

## 3. Phases

### Phase 0 — Preflight & setup

- Run `preflight.py --workflow stark-forged-review --json`; halt on "blocked", warn on "degraded".
- Verify `gh auth status`.
- Resolve `PR_NUM`, `REPO`, `BRANCH`, `BASE` (from `gh pr view`).
- Create an isolated git worktree at `.worktrees/forged-review-pr<num>-<ts>` checked out to the PR branch.
- Initialize `.forged-review-state.json` (or load it on `--resume`).
- Initialize `forged_review_metrics.db` via `forged_review_audit.py`.

### Phase 1 — Triage

Single Claude call on the diff + file list + PR description, using `global/prompts/forged-review/triage/triage.md`.

**Output (fixed JSON contract):**
```json
{
  "selected_domains": ["correctness", "security", "regression-prevention"],
  "rationale": {
    "correctness": "always-on",
    "security": "modifies auth middleware",
    "regression-prevention": "always-on"
  }
}
```

**Always-on domains** (from config `forged_review.always_on_domains`): `correctness`, `regression-prevention`. Triage cannot drop these.

Triage result is logged to state and to the audit DB. If triage fails, fall back to running all 9 domains.

### Phase 2 — Leader/2nd-opinion review

For each selected domain, run in parallel across domains but serial within a domain:

1. **Leader** runs with `forged-review/{leader_agent}/{NN-domain}-leader.md`. Produces a JSON array of findings:
   ```json
   [
     {"id": "f1", "severity": "high", "file": "src/foo.py", "line": 42,
      "title": "...", "detail": "...", "suggestion": "..."}
   ]
   ```
2. **Second opinion** runs with `forged-review/{second_agent}/{NN-domain}-second.md`, receiving the diff plus the leader's JSON. Returns a per-finding classification plus any additions:
   ```json
   {
     "decisions": [{"id": "f1", "verdict": "confirmed|disputed|leader_only", "reason": "..."}],
     "second_only": [{"severity": "medium", "file": "...", "line": ..., "title": "...", "detail": "...", "suggestion": "..."}]
   }
   ```
3. Merge results into `domain_findings[domain]` in state.

**Actionable** = `confirmed` ∪ `second_only`. Posted to the PR as one grouped review comment per domain, attributed to the leader bot (for confirmed findings) or second bot (for `second_only`). `leader_only` and `disputed` are logged for metrics only, never acted on.

### Phase 3 — Gate

Compute `actionable_count` and `critical_count` from actionable findings. Decision:

| Condition | Path |
|-----------|------|
| `critical_count >= 1` OR `actionable_count >= forge_threshold` | **forge path** |
| else | **light path** |
| `--no-escalate` set | **light path** (override) |
| `--force-escalate` set | **forge path** (override) |

Decision logged with reason. Emit `forged_review.gate` event.

### Phase 4a — Light path (fix in place)

1. Dispatch Claude in the worktree with actionable findings as input; let it apply fixes.
2. Run project test command from config/CLAUDE.md `## Commands`.
3. Commit: `fix(pr-<num>): address review findings`. Push to PR branch.
4. Jump to Phase 5.

### Phase 4b — Forge path

1. **Design generation.** Generate `.forged-review/pr-<num>-fix-design.md` in the worktree (not in the repo's main `docs/specs/` — that's reserved for canonical feature specs), using `global/prompts/forged-review/forge-design/{agent}.md`. Design doc covers all actionable findings as a coherent change.
2. **Design review.** Dispatch `forge-design-review` domains against the design doc. Iterate up to `max_rounds` until findings drop below `fix_threshold` or `max_rounds` reached.
3. **Plan generation.** Dispatch `design_to_plan_dispatch.py` with the reviewed design doc.
4. **Plan review.** Dispatch `plan_review_dispatch.py`. Iterate up to `max_rounds`.
5. **Implement.** Execute the plan in the worktree. Commit logical chunks as `fix(pr-<num>): <step>`. Push to PR branch.
6. Jump to Phase 5.

Sub-states (`design`, `design_review`, `plan`, `plan_review`, `implement`) are tracked in state for resume.

### Phase 5 — Delta re-review loop

Re-run only the domains that had actionable findings in the previous round, scoped to files touched by fix commits in that round. Same leader+2nd-opinion protocol; `mode = "delta"` in state.

- Post updated review comments to the PR (one per domain re-reviewed).
- Loop until `actionable_count == 0` or `current_round >= max_rounds`.
- On clean: advance to Phase 6.
- On max_rounds exceeded: emit `forged_review.halt`, print remaining findings, exit 1.

### Phase 6 — Merge gate

- **If clean AND tests pass AND not `--dry-run`:**
  - Print: `Clean. Merge PR #<num>? [Y/n]` (default Y)
  - On yes: run with `unset GH_TOKEN` so native `gh` auth is used: `gh pr merge <num> --squash --delete-branch`
  - On no: exit 0 with message "PR left open at user request"
- **If not clean:** print findings summary, exit 1.
- **If `--dry-run`:** print summary, exit 0 without merging.

### Phase 7 — Cleanup

- Save final summary to `~/.claude/code-review/history/forged-review/{org}/{repo}/{pr}/run-<ts>.json`.
- Record run via `forged_review_audit.record_run()`.
- Emit `forged_review.complete` event via `emit_queue.py`.
- `git worktree remove --force` unless `--dry-run` asked to keep artifacts.

## 4. State file: `.forged-review-state.json`

```json
{
  "version": 1,
  "pr_number": 123,
  "repo": "GetEvinced/foo",
  "branch": "feature/bar",
  "base": "main",
  "worktree": "/Users/aryeh/git/Evinced/foo/.worktrees/forged-review-pr123-1712900000",
  "path": "light|forge|undecided",
  "triage": {
    "selected_domains": ["correctness", "security", "regression-prevention"],
    "rationale": {"correctness": "always-on", "security": "modifies auth middleware", "regression-prevention": "always-on"}
  },
  "rounds": [
    {
      "n": 1,
      "mode": "full|delta",
      "domain_findings": {
        "correctness": {
          "leader": "codex",
          "second": "claude",
          "confirmed": [],
          "second_only": [],
          "leader_only": [],
          "disputed": []
        }
      },
      "actionable_count": 5,
      "critical_count": 1,
      "gate_decision": "forge",
      "gate_reason": "1 critical finding",
      "fix_commits": []
    }
  ],
  "forge_sub_state": {
    "design": "pending|running|ok|failed",
    "design_review": "pending|running|ok|failed",
    "plan": "pending|running|ok|failed",
    "plan_review": "pending|running|ok|failed",
    "implement": "pending|running|ok|failed"
  },
  "current_round": 1,
  "max_rounds": 3,
  "forge_threshold": 4,
  "status": "in_progress|halted|clean|merged|aborted",
  "started_at": "2026-04-12T10:00:00Z",
  "updated_at": "2026-04-12T10:15:00Z"
}
```

## 5. Config additions (`global/config.json`)

```json
{
  "forged_review": {
    "forge_threshold": 4,
    "max_rounds": 3,
    "domain_pairs": {
      "architecture":          {"leader": "claude", "second": "codex"},
      "correctness":           {"leader": "codex",  "second": "claude"},
      "type-safety":           {"leader": "codex",  "second": "gemini"},
      "security":              {"leader": "gemini", "second": "codex"},
      "test-coverage":         {"leader": "codex",  "second": "gemini"},
      "accessibility":         {"leader": "claude", "second": "gemini"},
      "spec-conformance":      {"leader": "claude", "second": "codex"},
      "ui-design-conformance": {"leader": "gemini", "second": "claude"},
      "regression-prevention": {"leader": "gemini", "second": "claude"}
    },
    "always_on_domains": ["correctness", "regression-prevention"],
    "triage_agent": "claude",
    "delta_rereview": true,
    "auto_merge_when_clean": true
  }
}
```

Repo and org configs override via the standard hierarchy.

**Balance check:** Each of claude, codex, gemini leads exactly 3 domains and seconds exactly 3 domains. No single-agent single-point-of-failure.

## 6. Prompts layout

```
global/prompts/forged-review/
├── triage/
│   └── triage.md                            # diff → {selected_domains, rationale}
├── claude/
│   ├── 01-architecture-leader.md
│   ├── 02-correctness-second.md
│   ├── 06-accessibility-leader.md
│   ├── 07-spec-conformance-leader.md
│   ├── 08-ui-design-conformance-second.md
│   └── 09-regression-prevention-second.md
├── codex/
│   ├── 01-architecture-second.md
│   ├── 02-correctness-leader.md
│   ├── 03-type-safety-leader.md
│   ├── 04-security-second.md
│   ├── 05-test-coverage-leader.md
│   └── 07-spec-conformance-second.md
├── gemini/
│   ├── 03-type-safety-second.md
│   ├── 04-security-leader.md
│   ├── 05-test-coverage-second.md
│   ├── 06-accessibility-second.md
│   ├── 08-ui-design-conformance-leader.md
│   └── 09-regression-prevention-leader.md
└── forge-design/
    ├── claude.md
    ├── codex.md
    └── gemini.md
```

**Each agent owns exactly 6 prompt files: 3 leader + 3 second-opinion. 18 domain prompts + 1 triage + 3 forge-design = 22 prompt files total.**

**Thin prompts target:**
- Triage prompt: ~30 lines (schema + 1-2 shot example)
- Leader prompt per domain: ~40 lines (domain focus + JSON output schema)
- Second-opinion prompt per domain: ~30 lines ("classify the leader's findings")
- Forge-design prompt per agent: ~50 lines (findings → design doc structure)

Prompts are loaded by Python at dispatch time, not inlined anywhere.

## 7. Scripts

### New files

| File | Purpose | Est. lines |
|------|---------|------------|
| `scripts/forged_review.py` | Top-level orchestrator (main entry point) | ~200 |
| `scripts/forged_review_engine.py` | Leader/second merge, gate decision, delta scoping, pure logic | ~250 |
| `scripts/forged_review_audit.py` | Audit DB + history writer specific to forged-review | ~120 |
| `scripts/audit_base.py` | Shared audit primitives (init_db, record_call, record_run) | ~100 |

### Modified files

| File | Change |
|------|--------|
| `scripts/forge_audit.py` | Refactor to use `audit_base.py`; no behavior change; existing DB schema unchanged |
| `skill/stark-review/SKILL.md` | Add deprecation notice pointing at `/stark-forged-review`; keep functional for rollout period |
| `scripts/multi_review.py` | Add `--topology leader-second` mode dispatching leader then second-opinion |
| `scripts/triage_orchestrator.py` | Add `--mode forged-review` routing to triage prompt |
| `scripts/config_loader.py` | Add `get_forged_review_config()` typed accessor |
| `global/config.json` | Add `forged_review` section |
| `install.sh` | Symlink `skill/stark-forged-review/` and new prompts dir |
| `CLAUDE.md` (both root and stark-skills) | Add `/stark-forged-review` to skills table; mark `/stark-review` as deprecated |

### Unchanged (reused as-is)

- `design_to_plan_dispatch.py`
- `plan_review_dispatch.py`
- `github_app.py`
- `runtime_env.py`
- `emit_queue.py`
- `preflight.py` (just add workflow mapping)

## 8. SKILL.md shape

**Target: ~60 lines.** The skill is a dispatcher.

```markdown
---
name: stark-forged-review
description: >-
  Multi-agent PR review with leader + second-opinion per domain, dynamic triage,
  and forge-pipeline escalation for non-trivial findings. Ends with auto-merge.
argument-hint: "[PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]"
disable-model-invocation: true
model: opus[1m]
---

## Preflight
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json
(halt on blocked, warn on degraded)

## Arguments
See skill/stark-forged-review/README.md for details.
Raw input: $ARGUMENTS

## Run
$PYTHON $SCRIPTS/forged_review.py $ARGUMENTS

## Merge confirmation
Parse orchestrator final JSON. Expected shape: {status, needs_merge_confirmation, pr_number}.
If status == "clean" and needs_merge_confirmation == true:
  Prompt: "Clean. Merge PR #<num>? [Y/n]" (default Y)
  On yes: unset GH_TOKEN && gh pr merge <num> --squash --delete-branch
  On no: exit 0 with message "PR left open at user request"

## Failure reporting
Parse exit code from orchestrator. Map to user-facing message. Exit with same code.
```

**`skill/stark-forged-review/README.md`** holds the full architecture reference (phases, state schema, config, failure modes, observability). Maintainers and users read it; Claude loads SKILL.md only.

## 9. Observability & exit codes

**Exit codes** (adopted from `stark-forge`):
- `0` — clean (merged, user declined merge, or dry-run completed)
- `1` — halted (findings remain after `max_rounds` or PR left open due to unresolved findings)
- `2` — dispatch failure (agent crash, timeout, infra error)
- `3` — invalid input (missing PR, bad args, config error)

**Events** (via `emit_queue.py`):
- `forged_review.round.start` `{round, mode}`
- `forged_review.round.end` `{round, actionable, critical, mode}`
- `forged_review.gate` `{decision, reason}`
- `forged_review.forge_path.start` `{triggered_by: "critical"|"threshold"|"flag"}`
- `forged_review.merge` `{pr, outcome: "merged"|"declined"|"failed"}`
- `forged_review.halt` `{round, remaining_findings}`
- `forged_review.complete` `{pr, status, duration_s}`

**Metrics collected** (`forged_review_metrics.db`):
- Per-run: pr, repo, total rounds, total actionable, total critical, path taken, merge outcome, duration
- Per-round: round number, mode (full/delta), domains run, actionable count
- Per-domain-call: agent, role (leader/second), domain, findings produced, duration, exit status
- Per-finding-verdict: leader, second, severity, verdict (confirmed/disputed/leader_only/second_only)

## 10. Failure modes

| Failure | Recovery |
|---------|----------|
| Triage agent fails | Fall back to all 9 domains (safe default) |
| Leader succeeds, second fails | Treat all leader findings as `leader_only`; warn; continue |
| Both leader+second fail on a domain | Mark domain failed; if ≥50% of domains fail, halt the run |
| Forge design phase exceeds max_rounds | Halt with design doc preserved for manual fix |
| Tests fail after fix | Count against round limit; next round starts with failing-test context |
| PR closed mid-run | Detected at round start via `gh pr view`; halt cleanly |
| `gh pr merge` fails (e.g., branch protection) | Print manual merge command; exit 0 |
| Worktree creation fails | Halt with exit code 2 — the forge path requires isolation and running in cwd risks dirty-state cross-contamination with the user's workspace |

## 11. Rollout

1. Ship `/stark-forged-review` alongside `/stark-review` in the first PR (both available, for comparison and rollback safety).
2. Run `/stark-forged-review` on 5–10 real PRs. Compare findings vs. `/stark-review`.
3. After 2 weeks of live use, audit:
   - Triage accuracy (LLM vs. a rule-based classifier — revisit decision).
   - Forge-gate precision (did the threshold match intuition?).
   - Leader/second disagreement rate (is the second-opinion layer earning its cost?).
4. If healthy: delete `/stark-review`, update docs, commit as breaking change in a release.
5. If issues: tune config, iterate.

## 12. Open questions (for iteration, not blocking)

- Should `forge_threshold` be severity-weighted (e.g., 1 high = 2 medium = 4 low)?
- Should the second-opinion also run when the leader finds zero issues (to catch leader false-negatives)?
- Should `--dry-run` still push the design doc to a PR comment for human review?

These are deliberately left for post-launch iteration based on real data.

## 13. Acceptance criteria

- [ ] `/stark-forged-review <pr>` runs end-to-end on a real PR in a stark-skills-managed repo.
- [ ] Triage correctly scopes domains on a backend-only PR (no accessibility/ui runs).
- [ ] Leader+second protocol produces merged findings with all four verdict types logged.
- [ ] Gate correctly routes to light path for a 1-finding PR and to forge path for a PR with 1 critical finding.
- [ ] Forge path generates a design doc, reviews it, plans it, implements it, and re-reviews cleanly.
- [ ] Delta re-review only re-runs domains that had findings, only on touched files.
- [ ] Auto-merge gate prompts `[Y/n]`, defaults Yes, uses native `gh` auth.
- [ ] State file enables resume from any mid-run phase.
- [ ] Exit codes match the `0/1/2/3` contract.
- [ ] Audit DB populated with per-call and per-run records.
- [ ] SKILL.md is ≤80 lines; full reference lives in `README.md`.
- [ ] `/stark-review` still functional at launch (deprecation notice added; deletion deferred to post-validation per Section 11).
- [ ] `skill-creator:skill-creator` eval passes on the new skill.
