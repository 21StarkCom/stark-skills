# Failure Modes (baseline)

These apply across the run — orchestrator-level handling. For dispatcher-level
verdicts (`approved` / `blocked` / `aborted` / `max_rounds_unresolved` /
`unresolved`), see the table inlined in `SKILL.md §2d`.

| Failure | Recovery |
|---------|----------|
| No input | Ask: "What should I build?" |
| Worktree creation fails | Stop the run; do not silently fall back to the main checkout |
| Lead and wing resolve to the same agent | Refuse before dispatch (see §1.4); never invoke the dispatcher |
| Mid-run abort (user Ctrl+C) | Clean up the active worktree before exiting |
| `git apply --3way` fails on the approved diff | Fall back to copying changed files from `worktree_path` over to `$REPO_ROOT` |
| Step-verification import check fails (§2e) | Either burn one more dispatcher round with the failure as a wing finding, or stop the run |
| SDK method called by the diff doesn't exist | Install the SDK, run `inspect.signature()` to find the correct API, then either reroute through the dispatcher with the finding or stop |
| End-of-run verification fails (Phase 2.5) | Fix all failures before generating the summary — do not ship broken code |
