# stark-session TS Migration — Design

**Date:** 2026-05-18
**Branch:** `feat/stark-session-ts`
**Status:** Approved (autopilot)

## Goal

Kill the Python TUI subsystem (`scripts/session_tui*.py`) and replace the `/stark-session` skill's data-collection layer with a single TS CLI that returns structured JSON. Claude renders the briefing/summary itself — no ANSI, no box-drawing, no plain-text fallback.

## Scope

**In:**
- New `tools/stark_session_lib.ts` — pure collectors with injected `run` + `read` deps.
- New `tools/stark_session.ts` — CLI with `start` and `end` subcommands; JSON to stdout.
- Rewrite `skill/stark-session/SKILL.md` — single CLI call per mode + Claude-side rendering.
- Delete `scripts/session_tui_cli.py`, `scripts/session_tui.py`, `scripts/test_session_tui.py`.
- Doc updates (`CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`).

**Out (future slices):**
- Porting `session_state.py` / `session_id.py` — coupled to `context_compactor.py`.
- Porting `alert_delivery`, `healer_canary`, `stark_persona`, `skill_router`, `github_projects`.
- Touching `tui_core.py` / `triage_tui.py` — still in use.

## Architecture

```
tools/
  stark_session_lib.ts       collectors + types
  stark_session_lib.test.ts  unit tests with mocked deps
  stark_session.ts           CLI: start|end → JSON
```

**Subcommands:**

```
stark-session start [--session-id ID] [--start-head SHA] [--started-at ISO]
stark-session end   --session-id ID --start-head SHA [--started-at ISO] [--name NAME]
```

Both emit JSON. No `--plain`, no `--no-color` (Claude renders).

## JSON Shapes

### Start

```ts
{
  session: { id, branch, repo, started_at, name?, start_head?,
             tasks_completed: string[], last_checkpoint?: string },
  git:     { branch, ahead, behind, uncommitted: string[],
             stashes: number, recent_commits: [{sha, message, age}] } | null,
  prs:     { mine: [{number, title, head, review_decision, url}],
             current_branch: {number, title, state, review_decision,
                              checks: {pass, fail, pending}} | null } | null,
  board:   { in_flight: [...], needs_attention: [...], blocked: [...] } | null,
  alerts:  { unacknowledged: [{level, message, context}] } | null,
  health:  [{ name, passed, detail, duration }],
  queue:   { pending: number, dead_letter: number, max_created_at?: string } | null,
  healer:  { categories: [{name, count}],
             canary: { circuits_open: string[], near_promotion: string[] } } | null,
  skills:  { available: string[], suggestions: [{name, reason}] },
  persona: { name, source, catchphrase, ... } | null,
  errors:  [{ source, message }]
}
```

### End

```ts
{
  session: { id, branch, repo, started_at, name?, start_head?, ended_at },
  diff:    { added: number, removed: number, file_count: number,
             key_files: [{path, added, removed, status}],
             approximate: boolean } | null,
  branch:  { ahead, behind, upstream?: string, has_pr: boolean },
  errors:  [{ source, message }]
}
```

Receipt (tests, build, push, PRs, docs, telemetry) is **not** collected by the CLI — Claude tracks it through end-mode dialogue and renders it directly.

## Collector Behavior

Each collector returns its slot or `null` on failure, pushing `{source, message}` to `errors`. Per-subprocess timeout 15s, total wall-clock deadline 45s (enforced via `Promise.race` with a single aborter). Token redaction on any captured stderr written to `errors`.

The TS CLI **shells out** to existing Python helpers via subprocess (unchanged):

- `python3 scripts/session_state.py --json` → `session`
- `python3 scripts/alert_delivery.py --check --json` → `alerts`
- `python3 scripts/healer_canary.py --status --json` → `healer.canary`
- `python3 scripts/skill_router.py --context session --json` → `skills.suggestions`
- `python3 scripts/stark_persona.py select --auto` → `persona`
- `python3 scripts/github_projects.py list-items --status "In Progress,Blocked" --json` → `board`
- `node tools/emit_queue_cli.ts --health` + `pending-count` + `dead-letter-count` → `queue`

Inline `python3 -c` healer.jsonl block moves **into** the TS CLI as a native file read (no python3 needed).

Git/gh calls use `git`/`gh` directly via subprocess.

## SKILL.md Shape (after)

**Start mode:**
1. Preflight (unchanged)
2. Resolve `SESSION_ID`, `START_HEAD`, `STARTED_AT`
3. `STATE_JSON=$(node --experimental-strip-types --no-warnings ~/.claude/code-review/tools/stark_session.ts start --session-id "$SESSION_ID" --start-head "$START_HEAD" --started-at "$STARTED_AT" 2>/dev/null)`
4. Claude reads `$STATE_JSON`, renders briefing (omit empty sections, surface alerts/blockers prominently)
5. Survey prompt (1-in-5)
6. Task-list dialogue ("go" / "focus on X")

**End mode:**
1. Phase 0b — persona cleanup (subprocess to `stark_persona.py session-end`)
2. Phase 1-5 — tests, merge, commit, push (unchanged dialogue logic)
3. Phase 5.5 — telemetry sync nudge (unchanged)
4. Phase 5.6 — derive session name (Claude does it from accumulated facts)
5. `END_JSON=$(node --experimental-strip-types --no-warnings ~/.claude/code-review/tools/stark_session.ts end --session-id "$SESSION_ID" --start-head "$START_HEAD" --started-at "$STARTED_AT" --name "$SESSION_NAME" 2>/dev/null)`
6. Claude renders end summary using `$END_JSON` + the receipt it accumulated through phases 1–5.5

## Test Strategy

- **TDD on the lib:** each collector tested with mocked subprocess + filesystem.
- **CLI:** one smoke test that runs `stark-session start --session-id test` against the live worktree and validates JSON shape.
- **No snapshot tests** — JSON shape is the contract; field-level assertions only.
- **Live verify:** invoke `/stark-session start` + `/stark-session end` in the worktree end-to-end before merge.

## Deletions

- `scripts/session_tui_cli.py` (732 LOC)
- `scripts/session_tui.py` (408 LOC)
- `scripts/test_session_tui.py` (397 LOC)

Net: ~1,540 LOC Python deleted, ~800 LOC TS added.

## Doc Updates

- `CLAUDE.md` — add `tools/stark_session_lib.ts` + `tools/stark_session.ts` to TS-tools section; remove `session_tui*` references from "TUI & session" section.
- `AGENTS.md` — mirror.
- `CHANGELOG.md` — entry under unreleased.

## Risks

- **Subprocess fan-out cost:** start mode spawns 6–8 child processes. Today's Python CLI already does this — no regression, possibly faster (no Python startup per child of the orchestrator, just at each helper).
- **Python helpers still in the loop:** until follow-up slices port them, the new TS CLI is a thin shell. Acceptable per scope.
- **Claude-side rendering variance:** without a fixed renderer, briefing format may drift session-to-session. Mitigation: the SKILL.md instructs Claude on layout (sections + ordering); JSON is structured enough that variance is cosmetic.
