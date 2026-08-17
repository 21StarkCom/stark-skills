# Authoring checklist — the author's own QA

**This is the LLM's job, not the operator's.** Run this while writing tasks
(Phase 3) and again as a self-check before the gate (Phase 5). Every defect
this catches is one the operator should never have to hunt for. What survives
your honest pass here — the checks you are still unsure about — is what you
carry to the gate as a flagged risk, in your own words.

## 1. Wiring-seam check — does the task actually take effect?

The question for every task: **if this task's diff were applied and nothing
else, would its behavior criterion actually hold at runtime?** A done-when can
pass while the answer is no. Observed live: 5 of 8 tasks in the
hibob-profiles-cache run needed a file outside their declared set — every one a
seam without which the work was inert. Before locking a task's file set, scan:

- **Registration / dispatch** — does the task add a step, capability, route, or
  handler? The registry / step-list / route-table that *invokes* it must be in
  the set. A migration `.sql` is inert data until the step list runs it; a
  capability struct is dead code without its catalog entry.
- **Generated artifacts pinned by tests** — does it add or change a struct
  field, schema, or generated doc? Snapshot tests (`TestSchema_GoStructSync`,
  `TestCatalogUpToDate`, doc-conformance) compare against on-disk snapshots;
  adding a field makes the snapshot stale by construction. The snapshot file(s)
  and any catalog JSON must be in the set.
- **Call sites** — does it add a helper, function, or audit point? A helper with
  zero callers is dead code behind a green gate. Name the file where the call
  lives. If no call site exists yet, the task is incomplete — add the call site
  or add a task for it.
- **Doc / description generators** — does it produce user-visible text
  (descriptions, labels, help strings)? The file where the generator reads or
  writes that text (`dbdoc.go`, a `descriptions` map) must be in the set, not
  just the struct or table.

If the honest answer is "no — something else must also change", add that
something to the file set, or add a task for it.

## 2. Non-vacuous done-whens — would the check pass on an untouched repo?

**The general test: would this check still pass if the task were never done?**
If yes, it is not a done-when. These are machine-checkable AND prove nothing —
reject them at authoring time:

- a test-filter that may match **zero** tests (`go test ./... -run 'Docs'` with
  no `Docs*` test in this area — exits 0 on an untouched repo)
- a multi-file `grep`/`rg` whose exit code doesn't require **every** file to
  match (`rg -c a.md b.md c.md` exits 0 when only one matched)
- a build / lint / format command standing in for a behavior check
- any assertion on a mock the same task defines

Prefer a check that names the exact artifact and fails per-item.

## 3. Fails-on-success gates — the inverse defect

`cmd | grep -q X` under `set -o pipefail` can SIGPIPE a still-writing producer
when grep exits at first match. Small/buffered output may pass — which is what
makes it nondeterministic: the gate fails on SUCCESS. Proven live on the
2026-07-27 db-dwh-replan run (3/3 e2e runs false-negative). Use pipeline-safe
forms:

- `cmd | grep -e 'X' >/dev/null` — reads to EOF
- `output=$(cmd) && grep -e 'X' <<<"$output"` — capture-then-match, preserves
  producer failure

## 4. Verification fallback ladder — when no single command can prove it

Pick one explicitly per task that needs it, in this order of preference:

1. scripted probe (Playwright / CLI harness)
2. screenshot diff vs an accepted baseline
3. a named human checklist item at the gate — last resort

## Carrying residual doubt to the gate

After this pass, some checks will still make you uneasy — a done-when you had to
weaken, a seam you're not certain you covered, a fallback that leans on human
judgment. Do not hide it and do not pretend the pass was clean. Write it down as
a flagged risk for Phase 5, in one plain sentence each: *what* you're unsure
about and *why*. That honest list is the most useful thing you hand the
operator — it points their limited attention at exactly the spots that need a
human.
