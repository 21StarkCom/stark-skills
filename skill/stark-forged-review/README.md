# stark-forged-review

Multi-agent PR review with **leader + second-opinion** per domain, **dynamic
triage**, and a **forge-style escalation** for PRs whose findings exceed a
threshold. Replaces `/stark-review` as the default thorough review command.

- **Design spec:** [`docs/specs/2026-04-12-stark-forged-review-design.md`](../../docs/specs/2026-04-12-stark-forged-review-design.md)
- **Implementation plan:** [`docs/specs/2026-04-12-stark-forged-review-plan.md`](../../docs/specs/2026-04-12-stark-forged-review-plan.md)

## How it compares

| | `/stark-review` | `/stark-team-review` | `/stark-forged-review` |
|---|---|---|---|
| Topology | 1 agent × 9 domains | 2–3 agents × 9 domains | leader + 2nd opinion × up to 9 domains |
| Triage | none (runs all) | none | LLM triage selects subset |
| Verdicts | single agent | per-agent | `confirmed`/`disputed`/`leader_only`/`second_only` |
| Escalation | fix in place | fix in place | forge path on threshold or critical |
| Cost | cheapest | most expensive | adaptive |
| Status | deprecated | unchanged | **default going forward** |

## Pipeline

```
Preflight → Setup (worktree, state, audit DB)
          → Triage (Claude classifies: which domains apply?)
          → Leader+Second-opinion review (parallel across domains)
          → Gate (critical? count ≥ threshold? → forge path : light path)
          → [First release stops here: print JSON, ask user to apply fixes]
          → (future) Apply fixes, delta re-review loop
          → Merge gate (Y/n, auto-yes when clean)
```

## Arguments

```
/stark-forged-review [PR_NUMBER] [--dry-run] [--repo ORG/REPO] \
                     [--resume] [--no-escalate] [--force-escalate]
```

| Argument | Meaning |
|---|---|
| `PR_NUMBER` | Optional; detected via `gh pr view` if omitted |
| `--dry-run` | Review and print results; do not commit, push, or merge |
| `--repo ORG/REPO` | Override repo detection |
| `--resume` | Resume from existing `.forged-review-state.json` under `.worktrees/` |
| `--no-escalate` | Forbid the forge path (always fix in place) |
| `--force-escalate` | Always take the forge path regardless of gate |

## Domain mapping (leader / second)

| # | Domain | Leader | Second | Why |
|---|---|---|---|---|
| 01 | architecture | claude | codex | Claude reasons about design; codex checks real code |
| 02 | accessibility | claude | gemini | Claude for WCAG nuance; gemini for pattern matching |
| 03 | correctness | codex | claude | Codex for bug hunting; claude for intent |
| 04 | type-safety | codex | gemini | Codex specializes; gemini catches broad slips |
| 05 | security | gemini | codex | Gemini for pattern scan; codex for exploit chains |
| 06 | test-coverage | codex | gemini | Codex for gap analysis; gemini for edge cases |
| 07 | spec-conformance | claude | codex | Claude for intent vs spec; codex for literal mismatches |
| 08 | ui-design-conformance | gemini | claude | Gemini for visual patterns; claude validates design language |
| 09 | regression-prevention | gemini | claude | Gemini for broad ripple context; claude for subtle call-site risks |

Each agent leads **3** domains and seconds **3** domains — balanced, no
single-agent single-point-of-failure.

## Triage

Phase 1 runs a Claude triage call on the diff, file list, and PR description.
It outputs `{selected_domains, rationale}`. Always-on domains (`correctness`,
`regression-prevention`) are added automatically. On any triage failure (agent
error, malformed output) the orchestrator falls back to running all 9 domains.

## Gate

After the review round, `forged_review_engine.compute_gate` decides:

- `force_escalate` / `no_escalate` flags override everything
- `critical_count >= 1` → **forge path**
- `actionable_count >= forge_threshold` (default 4) → **forge path**
- otherwise → **light path**

## Forge path (design spec)

When the gate escalates, the forge path generates a single coherent design doc
covering all actionable findings, runs it through design-review, plan
generation, plan-review, and implementation — all iteratively to
`cfg.max_rounds` (default 3). The design doc lives at
`.forged-review/pr-<num>-fix-design.md` inside the worktree (NOT the repo's
`docs/specs/` — that's reserved for canonical feature specs).

> **First-release scope:** the orchestrator stops after the gate and emits a
> JSON payload with findings. Apply fixes and re-run with `--resume`. The full
> forge path (auto-design → plan → implement → delta re-review) is the next
> rollout.

## Light path

Applies fixes in place using Claude with the actionable findings as input,
runs tests, commits `fix(pr-<num>): address review findings`, and pushes to
the PR branch. (First release: same as forge path — print and stop; user
applies fixes and re-runs with `--resume`.)

## Delta re-review

Round ≥ 2 runs only the domains that had actionable findings last round,
scoped to files touched by the fix commits. This is a significant cost
saving vs. full re-review and is enabled via `cfg.delta_rereview`.

## State file — `.forged-review-state.json`

Lives in the worktree. Full schema in the design spec §4. Key fields:

- `path`: `"light" | "forge" | "undecided"`
- `triage`: selected domains + rationale
- `rounds[]`: per-round findings, actionable count, gate decision, fix commits
- `forge_sub_state`: per-phase status for the forge path
- `status`: `"in_progress" | "clean" | "awaiting_fixes" | "halted" | "merged"`

## Config (`global/config.json` → `forged_review`)

```json
{
  "forged_review": {
    "forge_threshold": 4,
    "max_rounds": 3,
    "domain_pairs": { "...": "..." },
    "always_on_domains": ["correctness", "regression-prevention"],
    "triage_agent": "claude",
    "delta_rereview": true,
    "auto_merge_when_clean": true
  }
}
```

Repo and org configs override via the standard hierarchy.

## Scripts

| File | Purpose |
|---|---|
| `scripts/forged_review.py` | Top-level orchestrator (Python entry point) |
| `scripts/forged_review_dispatch.py` | Per-agent CLI dispatch + triage + leader/second coordination |
| `scripts/forged_review_engine.py` | Pure logic: merge, gate, delta scoping, triage filtering |
| `scripts/forged_review_audit.py` | SQLite + JSONL audit for runs, rounds, domain calls, finding verdicts |
| `scripts/audit_base.py` | Shared SQLite primitives (init, connect, append_jsonl) |

## Prompts

Located at `global/prompts/forged-review/`:

```
forged-review/
├── triage/triage.md                    (1 file)
├── claude/   01, 02, 03, 07, 08, 09    (6 files: 3 leader + 3 second)
├── codex/    01, 03, 04, 05, 06, 07    (6 files: 3 leader + 3 second)
├── gemini/   02, 04, 05, 06, 08, 09    (6 files: 3 leader + 3 second)
└── forge-design/  claude.md, codex.md, gemini.md  (3 files)
```

22 prompt files total. All emit structured JSON (leader: findings array with
stable `id`; second: `{decisions, second_only}`) so `merge_findings` can merge
them mechanically.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean / dry-run / user declined merge |
| 1 | Halted / awaiting fixes / findings remain |
| 2 | Dispatch failure (agent/infra/subprocess crash) |
| 3 | Invalid input (bad args, missing PR, config error) |

## Observability

Events emitted via `emit_queue.py`:

- `forged_review.round.start` `{run_id, round, mode, domains}`
- `forged_review.round.end` `{run_id, round, actionable, critical, mode}`
- `forged_review.gate` `{run_id, decision, reason}`
- `forged_review.forge_path.start` `{triggered_by}`
- `forged_review.complete` `{run_id, pr, status, duration_s}`

Metrics in `~/.claude/code-review/history/forged-review/forged_review_metrics.db`:

- `runs` — one row per full run
- `rounds` — one row per review round
- `domain_calls` — one row per agent invocation on a domain
- `finding_verdicts` — one row per leader finding × second verdict

## Failure modes

| Failure | Recovery |
|---|---|
| Triage agent fails | Fall back to running all 9 domains |
| Leader OK, second fails | All leader findings become `leader_only`; continue |
| Both fail on a domain | Log domain failed; halt run if ≥50% of domains fail |
| Forge design phase exceeds max_rounds | Halt with design doc preserved |
| Tests fail after fix | Count against round limit; next round sees failing tests |
| PR closed mid-run | Detect at round start via `gh pr view`; halt cleanly |
| `gh pr merge` fails (branch protection) | Print manual merge command; exit 0 |
| Worktree creation fails | Halt with exit code 2 (no cwd fallback — contamination risk) |

## Rollout

- **Week 0 (this PR):** ship alongside `/stark-review` (deprecated notice on the old skill)
- **Weeks 1–2:** run on real PRs, compare findings quality and cost vs `/stark-review`
- **Week 2+:** tune `forge_threshold` and `domain_pairs` from `forged_review_metrics.db`
- **Week 3+:** decide whether to replace triage LLM call with a rule-based classifier
- **Week 4+:** ship the auto-apply light/forge paths (currently deferred — first release stops at the gate and hands off to the user)
- **Week 6+:** if healthy, delete `/stark-review` and update docs
