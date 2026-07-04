# Red-team refutation pass — design note

- **Date:** 2026-07-04
- **Status:** implemented
- **Scope:** `tools/red_team_lib.ts` (+ `stark_config_lib.ts`, `global/config.json`)
- **Task:** #2 of the red-team noise-reduction follow-ups (the structural cut).

## Problem

The TS red-team committee runs **one round, all five personas, no verification**.
The multi-round / stability / refutation loop was never ported from the old
Python. Evidence from a 201-run audit:

- **1/201 runs ever came back `clean`** (~100% halt rate).
- **87% of findings block** (`critical`/`high`); **zero `low` findings, ever**.
- A gate that never passes trains the reader to override it.

By contrast, a different fleet reviewer that runs a **per-finding refutation
pass** (the Claude "lens + refutation" reviewer) produces a healthy graduated
curve — ~71% non-blocking, with real `low`s — precisely *because* every finding
is adversarially tested before it is allowed to block.

The dead config keys `red_team.max_rounds` and
`red_team.stability_overlap_jaccard_min` imply a verification pass that does not
run — nothing in `tools/red_team_*.ts` reads them (confirmed by grep). They are
retired in this change.

## Design

Insert a **refutation pass** into the dispatch flow, *after*
`validateFindings` + `demoteAdvisoryInjectionFindings` and *before*
`countBlocking` / `deriveStatus`:

```
committee → validateFindings → demoteAdvisoryInjectionFindings
          → refuteFindings   ← NEW
          → countBlocking → deriveStatus
```

`refuteFindings(findings, artifact, sourceSpec, cfg)`:

- For each finding, dispatch a **refuter** that adversarially tries to refute it
  **from the artifact + source-spec text only**. The refuter returns one of:
  - `uphold` — cannot refute; finding keeps its **exact** severity.
  - `downgrade` — the concern is real but over-rated; recalibrate to an honest,
    **lower** severity (never higher). Requires a cited span.
  - `drop` — the concern is refuted by the text (already addressed, out of
    scope, or factually wrong). Requires a cited span.
- **Signal preservation is the invariant:** a finding is dropped or downgraded
  **only** when the refuter cites *why* from the artifact text. An
  un-refutable finding is untouched. A downgrade can only lower severity; a
  verdict that tries to *raise* severity is clamped to `uphold`. A `drop`/
  `downgrade` with no cited span is treated as `uphold` (fail-safe: keep the
  finding).
- **Distinct agent from the committee.** The committee is codex `gpt-5.5-pro`;
  the refuter runs as **Claude** (`claude-opus-4-8` by default) — a genuine
  second opinion, mirroring the fold decider. It reuses the fold decider's
  **token-less least-privilege posture** (`buildDeciderEnv` /
  `DECIDER_DISALLOWED_TOOLS`) because it reads the untrusted artifact.
- **Perspective-diverse lenses.** Each finding is refuted through the lens that
  matches how it could fail: `correctness`, `security`, `reproduces`,
  `already-addressed`. The lens is chosen from the finding's `failure_mode`;
  a single refuter call carries its assigned lens in the prompt (majority-vote
  across multiple refuters is available behind `verify.votes` but defaults to
  1 for cost).
- **Transparency.** The pass logs how many findings were dropped / downgraded /
  upheld, and the sidecar records per-finding refutation verdicts + cited
  spans so a human can audit every recalibration.

### Not doing

- **No Jaccard stability loop.** The old approach compared two independently
  sampled committee runs (N=1 Jaccard = 0 in the audit — brittle). Per-finding
  text-grounded refutation is cheaper and better.
- **No new blocking findings.** The refuter can only *reduce* severity or drop;
  it can never introduce a finding or raise severity. It is a pure
  noise-reducer, so it cannot make the gate stricter.

## Config

New `red_team.verify` section (locked fields: `enabled`, `model`):

```jsonc
"verify": {
  "enabled": true,              // default on
  "model": "claude-opus-4-8",   // distinct from the codex committee
  "timeout_s": 300,             // per-finding refuter budget
  "votes": 1,                   // refuters per finding (majority-vote when >1)
  "max_input_chars": 200000
}
```

Kill switch: `STARK_RED_TEAM_VERIFY_KILL` (mirrors
`STARK_RED_TEAM_FIX_PLAN_KILL`) skips the pass for a single run. Under replay
transcripts and mocked `codexFn` test paths the pass is skipped unless a
`refuteFn` is injected (mirrors how the fix-plan/fold tests inject their fns).

Retired in the same change: `red_team.max_rounds`,
`red_team.stability_overlap_jaccard_min`.

## Verification

- Unit: inject a fake `refuteFn`; assert a refuted finding is dropped, an
  over-rated one is downgraded (and only downward), an un-refutable one is
  untouched, and a span-less drop/downgrade fails safe to `uphold`.
- Live: real committee + real Claude refuter on 2–3 real design docs; compare
  the severity curve + halt outcome to the pre-change baseline. Expect the
  blocking share to fall toward the ~71%-non-blocking range without losing the
  sharp findings (spot-check that real bugs survive).
