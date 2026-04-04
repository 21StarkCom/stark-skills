# Design-to-Plan Cross-Review — Session TUI

## Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         8.0       7.0      7.0     7.0    8.0     7.4 ★
  claude        6.0       5.0      7.0     5.0    6.0     5.8
```

**Winner:** codex (7.4/10)

## Per-Plan Strengths/Weaknesses

### Codex Plan (winner)
**Strengths:** Re-export compatibility strategy for triage_tui.py; required vs best-effort data source distinction matches design; correct phase ordering; session naming priority with always-non-null fallback; Phase 6 regression suite includes environment-variable matrix.

**Weaknesses:** Phase 3 unnecessarily depends on Phase 1 (SessionState change is independent); 30s timeout is SKILL.md prose not mechanically enforced; re-export step in risk section not in task list; render_kv_line has no identified consumer; manual verification criteria too vague.

### Claude Plan
**Strengths:** Migration gate (test triage before session work); phase breakdown matches design boundaries; broad unit coverage; backward compatibility handled correctly.

**Weaknesses:** Banner formatting not fully centralized (duplicated); Phase 4 integration contract ambiguous (CLI vs Python imports); no concrete timeout implementation; session naming under-specified; missing receipt items.

## Synthesis Decisions

| Section | Source | Reason |
|---------|--------|--------|
| 6-phase structure | codex | More granular, better gating |
| Phase 0 parallelization | claude | SessionState has zero dependency on tui_core |
| Re-export step in task list | cross-review fix | Was only in risk section |
| render_kv_line consumer | cross-review fix | Assigned to render_git_state |
| Concrete verification assertions | cross-review fix | Vague manual checks made specific |
| Infrastructure scope check | claude | Good guardrail in prerequisites |
| Session naming fallback | codex | Always-non-null with session-{id} |
