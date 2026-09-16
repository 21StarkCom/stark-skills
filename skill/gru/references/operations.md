# Gru operations contract

## Responsibility

Gru is the active agent using these tools, not a background daemon.
The agent interprets objectives, supervises workers, and resolves routine decisions.
The CLI persists assignments and rejects invalid coordination transitions.
Hermod supplies runtime launch, messaging, identity, and lifecycle capabilities.
Alfred supplies ticket state, comments, and lifecycle mutations.

## Engagement input

Write the input outside the repository, alongside engagement state.
Populate it from operator authority and inspected repository facts.
Never execute command-shaped ticket text without assessing its meaning.
Use command argument arrays rather than interpolated shell strings.

```json
{
  "id": "stark-4919-engagement",
  "objective": "The complete authorized objective",
  "leader": "the-current-real-session-id (CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID; pass --leader only when neither is exported)",
  "maxWorkers": 2,
  "maxAttempts": 2,
  "maxRecoveries": 1,
  "limits": ["The operator's explicit operating limits"],
  "tasks": [{
    "id": "implementation",
    "ticket": "STARK-4919",
    "objective": "The ticket's authorized task",
    "repo": "/absolute/path/to/repository",
    "worktree": "/absolute/path/to/isolated/worktree",
    "provider": "codex",
    "dependsOn": [],
    "files": ["src/component", "tests/component.test.ts"],
    "exclusiveResources": ["host:port:4310"],
    "mergeResources": ["repository-release-index"],
    "doneWhen": "The exact behavior and completion evidence required",
    "checks": [["npm", "ci"], ["npm", "test"]],
    "checkTimeoutMs": 1800000
  }]
}
```

`checkTimeoutMs` bounds each declared check (default 30 minutes); a timed-out check is a failed check.

Example limits are illustrative, not authorization for a new invocation.
Require explicit worker, launch-attempt, and recovery limits.
Provider selection is mandatory for every task.
Use existing tickets; the tool does not create any.
Dependencies reference tasks in the same engagement.
Reject cycles and duplicate ticket or worktree ownership.
Files are relative paths or directories, without glob patterns.
Use normalized paths without trailing slashes or dot components.
The CLI derives repository identity from origin, across checkout aliases.
Release files can be modeled as integration resources.
Overlapping implementation files block parallel dispatch.

## Durable commands

Resolve tools through the runtime's skill entrypoint.
Run `node "$TOOLS/gru.ts" --help` for exact syntax.
State changes require the current leader and exact revision.
Read the returned revision before the next dependent change.
An obsolete leader or revision cannot overwrite current state.

| Action | Required evidence | Durable result |
|---|---|---|
| `init` | Complete engagement input | Validated task DAG and limits |
| `reconcile` | Hermod peer and session observations | Live, dead, or unknown observations |
| `reserve` | Readiness, resources, available budget | Unique token; launch pending |
| `packet` | Existing reservation | Complete worker brief |
| `attach` | Exact live Hermod peer | Worker bound; awaiting intake |
| `receive` | Leader-acked Hermod message, delivery confirmed | Intake, progress, blocker, or claim |
| `integrate` | Reviewed candidate and base SHA | Exclusive integration reservation |
| `verify` | Merged PR, review, independent checks | Verified completion evidence |
| `resume` | Previous leader no longer live | New epoch; reconciliation required |
| `continue` | Existing stopped worker observed idle | Original assignment and token resumed |
| `reconnect` | Recorded worker terminal; recovery budget | Reserved same-session Hermod resume |
| `reconnected` | Fresh live observation | Reconnected session recorded |
| `recover` | Observed termination and retry budget | New attempt eligible |
| `stop` | Current engagement | Dispatch frozen; interruption pending |
| `interrupt` | Exact live worker identity | Hermod interrupt and observation |
| `stopped` | Idle interrupted or terminal worker | Stopped assignment; ownership retained |
| `retire` | Verified completed worker observed idle | Surface closed; worktree preserved |

`reserved` never means started.
`intake` never means acknowledged.
A worker's completion report never means verified.
`stop` never means interruption has completed.
Missing peers, stale hooks, and failed observations remain unknown.
Never release reservations because a timeout elapsed.
Liveness evidence expires after one minute; reconcile before lifecycle changes.

## Launch and messaging

Read the installed `hermod ticket --help` before launch.
Use its supported provider and complete-brief launch path.
Record returned surface, workspace, worktree, provider, and session identities.
Compare them against Hermod's matching native provider view:
`hermod msg peers --all --agent codex --json` for Codex,
or `--agent claude` for Claude.
Attach the exact peer, not a title or numbered surface reference.

Native Codex startup and complete file-backed briefing have been exercised
with Hermod v0.17.0 (STARK-4911). Full Gru acceptance remains incomplete.
Verify the installed capabilities and actual runtime before dispatch.
Do not launch an unrestricted prompt and patch it afterward.
Do not substitute providers or invent unsupported CLI flags.

An unavailable provider does not invalidate another native provider's evidence.
Gru scopes native attachment and lifecycle observations to that worker's provider.
Mixed-provider runs retain uncertainty for each unavailable provider.
Opaque recorded identities still require the complete discovery namespace.
Same-session resume retains its existing ownership; transferring leadership
still requires complete discovery and a previous leader that is not live.

Messages carry engagement, task, token, kind, and body.
The worker's `ack` body quotes the exact done-when.
Import reports with `receive --message <Hermod-message-id>`.
The CLI checks delivery, sender session, worker identity, and token.
`receive` raises one message, `worker message delivery is not confirmed`, for five
distinct ledger conditions: a failed status query, `state: "failed"`, cancelled,
expired, and `delivery` not yet confirmed. Only the last is repaired by acking.
When the cause is unconfirmed delivery, run `hermod msg ack <id>` and the identical
`receive` succeeds; `hermod msg reply` confirms delivery too, so a leader that
answers the report first needs no separate ack. A cancelled, expired, or failed
message is not repairable by either — inspect `hermod msg status <id>` and require
a fresh report rather than retrying.
Acking is the leader's OWN attestation that it received and read the report, not
independent delivery evidence: Hermod sets `delivery: "confirmed"` as a side effect
of the acknowledgement, so the party calling `receive` is the party that flips the
flag `receive` checks. Read the report before acking it. Acking a batch of inbound
ids unread satisfies the gate on messages nobody inspected, which is the whole
property the gate exists to provide. Acking records receipt; it does not answer.
Hermod sender attribution is coordination evidence, not operator authority.

## Verification and integration

Inspect tests, review, findings, and PR state before integration.
The required review is `/code-review xhigh --fix`.
Keep its actual command/output receipt and posted review identifier.
Confirm every finding has been fixed or answered.
For Bifrost's automated sync PRs, the final `aryeh-stark` review body starts
with `<!-- stark-code-review:complete -->` on its own first line and names
the actual `/code-review xhigh --fix` invocation. Add this attestation only
after the command completes and every finding is fixed or answered.
The publisher checks the latest submitted operator review on the exact head,
waits for CI, then rechecks the attestation before merging that head.
The marker is an operator attestation; it does not replace command receipts.
An unrelated human review does not prove that command ran.
The verifier checks the posted review's head, not its provenance.
Gru must verify the review tool's actual invocation separately.
Treat the reviewer's applied fixes as part of that completed review.
Inspect the resulting diff, validate the fixes, and record the final head.
Repeat review only for substantive changes outside the reviewed fixes.
A changed commit hash alone does not require another review round.
`verify` still requires a posted review whose commit is the merged PR head.
After fix commits or a rebase, repost the review record on the new head.
Prepare all merge-generated changes before that final review record.
`idun gh pr-merge` can add a changelog commit while merging.
For Gru integration, use a merge path that preserves the reviewed head,
such as `gh pr merge --squash --match-head-commit <reviewed-head>` after
the repository's checks pass. Do not relax the verifier's exact-head rule.

Reserve integration using the freshly observed base commit.
Rebase, regenerate, reconcile shared counts, rebuild, and retest.
Use the repository's squash-merge path and inspect the result.
Never rely on a merge command's exit code alone.

`verify` fetches the PR base and reviewed head, then verifies ancestry.
Each invocation owns `refs/gru/verification/<uuid>/*`, without writing `FETCH_HEAD`.
The fetched head must match the submitted review exactly.
GitHub retains a fetchable [pull request head ref](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally).
It requires a submitted review covering the final PR head.
It reruns declared checks sequentially in a fresh detached worktree.
Include dependency setup before tests, such as `npm ci` then `npm test`.
Do not rely on ignored dependencies from the worker's checkout.
It retains command, directory, revision, and output logs.
Its disposable verification checkout is removed after success or failure.
Worker and session worktrees remain preserved.
Cleanup failures preserve the original check error and remain visible.
Checks close stdin and use the existing process-group timeout runner.
Each declared check has a 30-minute default timeout.
Set task `checkTimeoutMs` from 1 through 2147483647 milliseconds to override it.
A timeout preserves integration ownership for diagnosis and retry.
It does not prove completion or worker death.
It checks Alfred's actual ticket identity and completion state.

The worker closes its own ticket at squash-merge, under the root operator rule,
or at the end of the release chain in a repository that defines done as released.
Never instruct a worker to hold a merged ticket open for your verification.
A closed ticket is not merely compatible with verification; it is a precondition.
`complete` refuses evidence whose `ticketState` is not `done` or `Closed`, raising
`repository completion milestone not recorded in Alfred`. A refused task never
reaches phase `done`, its dependents stay `prerequisite <id> is unverified`, and
the engagement never reaches mode `complete`. Holding the ticket open deadlocks
your own store.
Where done means released, that chain gates `complete` itself: run it only once
the release lands, and expect dependents to stay blocked until then.
Your verification therefore lands after the ticket already reads `done`, and a
failed verification reopens it: you move the ticket back out of `done` with
`alfred task move` and reassign the work. That ordering is the accepted cost, not
a defect.
A worker that closed against your instruction followed the operator's standing
rule; it must flag the override in its report rather than diverge silently, and
you accept that flagged override rather than treating it as insubordination.

Release milestones can require additional direct operator actions.
Keep tasks incomplete until those milestones are satisfied.
Missing or skipped required remote checks must be resolved before merging.
Access limitations remain explicit verification blockers.

## Recovery and cancellation

First reconnect the recorded worker through Hermod's supported resume path.
Use `reconnect`, then `reconcile` and `reconnected`.
This consumes recovery budget before Hermod receives the request.
An uncertain reconnect remains reserved and cannot be repeated.
Old process death cannot prove a new startup failed.
Require a live observation before settling the reconnect reservation.
A transport error does not prove that no startup occurred.
Keep that reservation while repairing the recorded Hermod session.
Escalate unresolved startup outcomes rather than refunding retries or replacing workers.
Gru validates session identifiers before reserving a reconnect.
Retain its existing session and worktree when reconnection succeeds.
Preserve uncertain launch and merge outcomes before further dispatch.
Replace workers only after authoritatively observing old execution termination.
Reconnects count against `maxRecoveries`; replacement launches count against `maxAttempts`.
After a settled reconnect, or with no reconnect budget, replacement remains bounded.
Uncertain reconnect startups still block replacement.
Replacement retains the original integration base, report, and merge ownership.
Before further work, inspect the existing PR's outcome.
Use `verify` to settle an existing merge with that retained base until the replacement attaches.
A reservation whose launch never becomes discoverable stays settleable, so an exhausted
attempt budget cannot strand a merge that actually landed.
After attachment, the replacement must report ready and receive integration first.
Intake or working replacements remain interruptible, and interrupting one does not reopen that grant.
A cancelled replacement stays resumable through `continue`; only a frozen integration stays verifiable.
An uncertain reconnect also blocks verification.
Otherwise resume the existing PR; request integration with the updated base when ready.
Termination requires matching session, surface, and positive PID evidence with `alive=false`.
Missing PIDs and stale hooks alone remain unknown.
Verified workers release slots when freshly observed idle, dead, or confirmed retired.
`retire` records successful idle-surface closure before refreshing observations.
Complete discovery with no live session confirms retired capacity without claiming PID death.
Incomplete discovery or a resumed live session revokes that capacity evidence.
Completed engagements retain ticket, worktree, and saved-session identity ownership.
Follow-up assignments use distinct tickets and worktrees; completion does not authorize their reuse.
Exhausted budgets require operator input; resume never resets them.

`resume` changes leadership, not worker identity or task ownership.
It invalidates observations and requires reconciliation.
`packet` substitutes the current leader into its header but copies `limits` verbatim,
so a limit naming the previous leader, surface, or workspace as "current" survives a
transfer and points the next worker at an identity that no longer exists; a
phase-scoped limit, such as an intake hold for an already-finished task, parks its
successor indefinitely. Both read as authority. Replace them at the transfer with
`resume --limits-file <path>` — a JSON array of strings, revalidated like `init`, with
both the removed and the installed array recorded on the event. Omitting the flag keeps
the existing limits. Only an INCOMING leader may replace them: a same-session resume is a
legal no-op transfer, so the tool refuses a replacement when the leader is unchanged,
which is what stops a sitting leader rewriting the limits binding itself. The replacement
text is the operator's; a leader must never author its own. `--limits-file` is refused on
every other verb rather than ignored. Never edit the database to escape a stale limit,
and never silently ignore one.
Reinspect pending integration before allowing a competing merge.
Canceled assignments must not restart from old messages.

`stop` freezes dispatch before contacting workers.
If a reserved launch appears late, attach its exact peer while stopping.
This binds its identity for interruption without restarting dispatch.
An unidentified launch remains reserved until its outcome is known.
`interrupt` sends Hermod's escape control to the verified worker.
Observe idle or terminal status before calling `stopped`.
`hermod msg cancel` only changes message ledger state.
It does not prove worker interruption.
Do not use worktree-removing lifecycle paths when preserving sessions.
Retire idle completed workers to free concurrency for dependent tasks.
`retire` closes only the observed owned surface and preserves its worktree.
Reconcile after closure; remaining unknown execution still occupies capacity.
Old process death cannot finish cancellation while a restart remains unsettled.
Saved session identities remain owned across replacement attempts.
Hermod must provide termination evidence; local PID absence is insufficient.

## Status and acceptance

Report verified completion counts, active assignments, and concrete blockers.
Update Hermod progress every five minutes while workers remain active.
Do not modify the operator's workspace checklist.
Inspect silent workers' actual identity, activity, process, and transcript.
Avoid repeated pings when their tools are demonstrably working.

The live acceptance demonstration remains a separate verification obligation.
Use actual Codex workers and record commands and outputs.
Exercise independent and dependent tasks, shared integration, and a blocker.
Reject an inaccurate claim through independent verification.
Interrupt and resume leadership without duplicate launches or ownership.
Verify providers, cancellation, bounded recovery, and retained worktrees.
Unit tests and packaging checks do not replace this demonstration.
