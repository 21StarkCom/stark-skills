# Learning Log

Qualitative observations distilled from review retrospectives.

| Date | Spec | Observation | Category |
|------|------|-------------|----------|
| 2026-03-20 | 2026-03-19-rename-project | Codex consistently times out during plan reviews (3/4 rounds), reducing coverage to 19-20/21 sub-agents | agent-reliability |
| 2026-03-20 | 2026-03-19-rename-project | Gemini scope domain returns parse_error in 3/4 rounds — prompt file likely needs structural changes | agent-reliability |
| 2026-03-20 | 2026-03-19-rename-project | All agents fixate on enterprise rollback patterns (runbooks, checkpoints, audit trails) even for simple interactive dev tools — operability prompts need context-awareness | prompt-improvement |
| 2026-03-20 | 2026-03-19-rename-project | Codex security domain overfocuses on secrets management and audit trails when reviewing dev tooling — needs context calibration | prompt-improvement |
| 2026-03-20 | 2026-03-19-rename-project | Codex feasibility domain flags Claude Code plugins (superpowers) as "not available" — doesn't understand runtime plugin architecture | agent-behavior |
