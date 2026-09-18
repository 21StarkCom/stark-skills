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
    "baseRef": "main",
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
Declare `worktree` where Hermod will place the task's provider; see [worktree placement](#worktree-placement).
`baseRef` is the branch that task's PR targets. Omit it and `init` records origin's default,
so every task carries a concrete branch either way; `init` refuses rather than leaving it
unset, and declaring it skips the lookup entirely (the only way to run `init` offline).
It is what the worker is briefed with in its FIRST packet, what `integrate` grants against
without any flag, and what `verify` requires the merged PR to have targeted.
Files are relative paths or directories, without glob patterns.
Use normalized paths without trailing slashes or dot components.
The CLI derives repository identity from origin, across checkout aliases.
Release files can be modeled as integration resources.
Declared files scope each worker's brief; overlapping files never block dispatch.
Each worker edits its own worktree, and tasks touching the same files reconcile at the
rebase before merge (a 3-way merge), one merge at a time under the repository's merge lock.
That holds only if you grant `integrate` at the base branch tip you fetch and read
immediately before the grant — never a tip observed earlier, and never a local ref you
have not just fetched, which reads exactly like a current one. You cannot hold the merge
lock first: `integrate` takes `merge:<repo>` in the same transaction that records the
base, and refuses a second call once the phase is `integrating`. Its refusal is the
fence — `resource already owned: merge:<repo> (<run>/<task>)` names the task that is
mid-merge, so wait for that task to complete, fetch again, and read the tip again.
Read the tip rather than naming the previous merge commit: the previous merge need not
be the tip (a base branch also takes direct publisher pushes), and `merge:<repo>` locks
are global, so that merge can belong to an engagement whose commits you never recorded.
The first grant in a repository has no prior merge to wait for; the tip you fetch is
simply the current one.

`integrate` enforces this rather than trusting it. Before the transaction it fetches the
base branch from origin in the task's own repository and refuses unless the SHA is a
commit that repository holds and is that branch's current tip. The refusal names the
current tip. That comparison is the whole guarantee: a base that IS `origin/<ref>` already
contains everything merged onto that branch, so nothing walks history. Without that check
the store validated the SHA's shape alone (40 to 64 hex
characters) while `verify` only requires that base in the merged head's ancestry, so a
foreign-repository SHA, a typo, or an hour-stale tip all passed and let a diff built
without the other task's changes squash cleanly whenever git sees no textual conflict.
The base branch is the task's declared `baseRef`. `--base-ref BRANCH` still overrides it for
a one-off, and with neither the name is asked of origin (`git ls-remote --symref`), never
read from the local `refs/remotes/origin/HEAD`. Declaring it at `init` is what removed the
terminal mismatch class: a flag typed at grant time is typed long AFTER the worker opened
its PR, so a forgotten one granted against origin's default and `verify` then refused the
merge with no way back. Git writes that pointer at clone and then only on an explicit
`git remote set-head`, so a checkout made before a default-branch rename still names the
old branch — which usually still exists and is frozen, so every supplied base passes as
"the current tip" while the refusal text and `baseEvidence.ref` report a branch the
engagement never merges into. Pass `--base-ref` whenever the task's PR does not target
origin's default branch; `verify` refuses a grant whose branch is not the PR's base.
The check is fail-closed: an unreachable origin, a branch origin does not have, and an
origin that reports no default branch each refuse and say which, rather than falling back
to a local ref. A shallow checkout refuses too, by name, on one local probe before any
network call — `git fetch --unshallow` there first. Nothing in the grant itself needs
history, but `verify` walks ancestry in that same checkout AFTER the PR merged, where a
commit outside the graft exits 128 rather than answering; a grant cannot be retaken once
the task is `integrating`, so depth discovered at verification time strands a merged PR
behind a check that can never pass. Catching it at the grant is the last actionable moment.
An earlier revision also required the base to contain every merge this engagement had
verified onto that branch. That floor is gone (STARK-5222). Whenever the tip check passes
the floor is already implied, so the two can only differ when the floor is wrong about what
to require — which it is in three reachable cases, each refusing with no in-band repair
because a grant cannot be retaken once the task is `integrating`: a reverted or force-pushed
merge is off the branch for good; a task verified before base evidence existed has no branch
to attribute its merge to, so counting it refuses every later grant in that repository
forever; and a shallow clone cannot answer ancestry at all. It also cost every grant one
`merge-base` per verified merge, discarded unread on the commonest refusal, a stale tip.
What that gives up, stated rather than argued away: an origin serving a tip its branch has
moved past — a lagging mirror, or a replica behind a rewrite — passes the tip check, and the
floor would have caught the missing merge. Accepted because this fleet fetches GitHub
directly; revisit if Gru ever grants against a replicated remote.
The depth probe outlived the floor for the reason above, one local call per grant.
Both network round trips are bounded by a git transport budget of their own — 30 seconds,
deliberately NOT derived from the evidence freshness window, which measures worker liveness
and would otherwise widen for reconcile, sweep and takeover the moment someone raised the
budget for a slow remote. A slow round trip fails as a fetch instead of returning evidence
the store then calls stale; an observation that outlives the freshness window less that
budget fails as the slow observation it was, with headroom so evidence squeaking under the
limit cannot trip the store's own check a millisecond later.
The stale-tip refusal names `--base-ref`, the one repair a leader on another branch needs.
Name the PR's own base branch: a grant cannot be retaken once the task is `integrating`, so
a grant taken on the wrong branch leaves a task only `recover` or operator takeover can
move. A packet regenerated while a grant is pending names that branch to the worker.
The observation fetches into an invocation-owned `refs/gru/integration/<uuid>` and removes
it. It also passes `--refmap= --no-tags`: with an explicit refspec git still applies the
remote's configured refmap opportunistically, so without those a grant — a REFUSED one
included — would advance `refs/remotes/origin/<branch>` and follow new tags in a ref store
every linked worktree shares, moving `origin/main` under a Minion mid-rebase. So it writes
no `FETCH_HEAD`, moves no checkout, and touches no shared ref. `verify` fetches the same way. A task
that is not in `review`, or an engagement that is not running and reconciled, refuses before
that fetch rather than after it. `verify` closes the other end: the branch the grant was
checked against must be the branch the PR actually merged into, so a grant taken at a quiet
branch's tip cannot discharge a merge into a branch it never read. That is the branch the
grant was ACTUALLY taken on — the declared `baseRef`, or the `--base-ref` that overrode it —
and the worker's packet names that same one value, so the brief and the gate cannot
disagree. Settling against the declaration instead would refuse every overridden grant:
a PR that matched its own grant exactly, refused terminally.

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
| `rebrief-check` | Message id, current accepted run/task/leader and optional current message id | DB-free worker verdict and accepted ledger body |
| `attach` | Exact live Hermod peer, present in the provider view even when it is incomplete; git evidence if outside the declared worktree | Worker bound, adopted worktree audited; awaiting intake |
| `receive` | Leader-acked Hermod message, delivery confirmed | Intake, progress, blocker, or claim |
| `integrate` | Reviewed candidate; a base SHA the repository confirms is its base branch's current tip | Exclusive integration reservation |
| `verify` | Merged PR, review, independent checks | Verified completion evidence |
| `resume` | Previous leader no longer live | New epoch; reconciliation required |
| `continue` | Existing stopped worker observed idle | Original assignment and token resumed |
| `reconnect` | Recorded worker terminal; recovery budget | Reserved same-session Hermod resume |
| `reconnected` | Fresh live observation | Reconnected session recorded |
| `recover` | Observed termination and retry budget | New attempt eligible |
| `takeover` | Explicit operator request and complete fresh Hermod absence checks | Old assignment fenced; authorized replacement eligible |
| `stop` | Current engagement | Dispatch frozen; interruption pending |
| `interrupt` | Exact live worker identity | Hermod interrupt and observation |
| `stopped` | Idle interrupted or terminal worker | Stopped assignment; ownership retained |
| `retire` | Verified completed worker observed idle | Surface closed; worktree preserved |
| `sweep` | Alfred ticket `done`/`Closed`; no live Hermod peer bound | Dry run, or with `--apply` ownership released and `swept` recorded |

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

`incomplete: true` answers one question only: does absence inside this view prove death?
**Presence binds; only absence is gated by completeness.**
A peer Hermod returned as `live` and addressable is self-evidencing, so `attach`,
`interrupt` and `retire` bind it inside an incomplete namespace — the identity bar
(`live` liveness, available messaging, and a complete id/surface/workspace/cwd/session
record for a supported provider) is what they check, not the namespace flag.
A peer that is *missing* from the view still refuses, in either view, and `attach`'s
refusal preserves the launch reservation. The refusal names *which* absence it saw:
inside an incomplete view it adds `the view was incomplete, so this absence is unproven`,
because neither repair an unqualified "missing" implies is available there — `reconcile`
can only answer `unknown`, and `takeover` refuses an incomplete view outright. Re-run
`attach` (a just-launched worker is briefly unregistered) before reaching for a takeover.
The flag is not stable, which is why gating presence on it produced an intermittent,
unexplainable refusal. On Hermod v0.18.1 the unscoped view reports `incomplete: true`
routinely, and a scoped Claude view reports it whenever an uninspectable Claude identity
is present — its `boundaries` explain that remote, desktop, other-user, container and
unregistered Claude identities establish no supported messaging destination, so Hermod
cannot enumerate them, and a just-launched worker is briefly unregistered. That is an
honest boundary, not a defect; do not ask Hermod to claim a completeness it does not have.
The paths that reason from absence keep the gate: `takeover`, leadership transfer,
the sweep verdict, and `reconcile`'s `dead`/`retired` derivation.
That last one has an unresolved cost: `retire` now closes the surface inside an incomplete
view and `store.retire` clears the observation, but `reconcile` cannot re-derive
`observation.retired` without a complete view — so the completed worker keeps occupying its
`maxWorkers` slot, and `readyReason` reports only `worker limit reached`, until a complete
view appears. Prefer retiring under a complete view; a retirement is not lost either way.

Messages carry engagement, task, token, kind, and body.
The worker's `ack` body quotes the exact done-when.
Import reports with `receive --message <Hermod-message-id>`.
The CLI checks delivery, sender session, worker identity, and token.
`receive` raises one message, `worker message delivery is not confirmed`, for six
distinct ledger conditions: a failed status query, `state: "failed"`, cancelled,
expired, superseded, and `delivery` not yet confirmed. Only the last is repaired by acking.
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

## Deterministic re-brief check

Minions use one command from the plugin's tools directory:

```sh
node tools/gru.ts rebrief-check --message ID --run RUN --task TASK --current-leader SESSION
```

The arguments describe the worker's currently accepted assignment, not the new packet.
Add `--current-message LAST_ACCEPTED_ID` after accepting a ledger packet. The worker
identity comes from its runtime environment. The command never opens Gru's database.
Exit 0 returns the accepted ledger `body`, `messageId`, token and leader. New packets
also return the exact decoded `doneWhen` for the acknowledgement: continuation-line
indentation in the display must not alter its bytes. Preserve that
id; after resumption check it again with the same id in both message flags and the
accepted leader. Message ids are case-insensitive. `ordering` reports which replay check
ran: `newer`, `reread`, or `unchecked` when no current message was supplied — an
`unchecked` accept is exit 0 over an arbitrarily old packet, so recover the id rather
than dropping the flag. Other exits retain the assignment and require a plain note to the
current leader, and to the packet's named leader when it differs.

If the retained baseline is unreadable (for example, Hermod pruned an old note), the
checker fails closed with a recovery message. Keep `--current-message`: first ask Gru
to restore access or locate the original record. If it is gone, escalate to the operator
to establish a fresh intake baseline; a peer's resent packet or dropping the flag does
not authorize abandoning the replay check. This is a recovery block, not a verdict
that the new packet is invalid.

The checker shares `receive`'s record reader and terminal-state checks. It requires a
`note` addressed to the worker, an unambiguous assignment matching run/task, attribution
to the packet's leader, and a newer creation time than the current packet (except when
rereading that same accepted id). When both packets carry metadata it also requires an
authority `epoch` that is not older, and strictly newer across a leader change: creation
time is send time, so a revived leader resending a pre-transfer packet would otherwise
win on it alone. It does not require confirmed delivery: reading the
addressed ledger record is the worker's intake. Failed, cancelled, expired and superseded
records are refused; there is no expiry exception. Packet headers and optional versioned
metadata must agree. Delivered envelope text is never the source of the accepted body.

Send packets with `hermod msg send --to <worker-peer> --kind note -- <packet>`.
Send the JSON `ack` as a fresh `hermod msg send --to <leader-peer> --kind progress -- <report>`.
Submitted notes and progress messages do not expire at the request's default 1800-second
reply deadline. `msg reply` inherits its parent's deadline even for a note, so it is not
the intake path. A leader still reads and acknowledges the report before `gru receive`.

For changed leadership, complete fresh worker discovery can establish old-leader absence.
If process inspection is denied or incomplete, the checker uses the packet's portable
`resume` receipt instead. `resume` records the complete discovery check transactionally
with the leadership change; the store refuses a changed leader without that evidence.
Packets carry the most recent 16 transfers of that chain,
including each displaced session's records, observation time, transfer time and epoch —
a bounded window, because Hermod refuses a message body over 32 KiB. The receipt omits
unrelated peers. A worker displaced further back than the window takes the same path as
a receipt-less legacy transfer below.
The checker applies the same absence predicate and verifies receipt ordering and that
the observation was fresh at transfer time. A receipt does not expire while a worker
sleeps. Any locally visible live old leader still refuses it, even with incomplete discovery.
This is attributed coordination evidence, not cryptographic proof; spoofing remains out
of scope and the store's token fence remains authoritative for reports.

If neither local discovery nor a receipt confirms the transfer, Gru escalates the worker's
plain note instead of resending the same packet. Old transfers without receipts require
complete worker discovery or operator resolution; never hand-author a receipt or edit state.
Claude missing attribution requires a fresh send from the leader's own cmux surface;
`resend` preserves the missing sender. Codex requires its real `CODEX_THREAD_ID` and refuses
the send outright when it cannot attribute it; restore that runtime environment or escalate.

## Worktree placement

`hermod ticket <ticket> --agent <provider> --cwd <repo>` creates the worker's worktree;
Gru does not choose it. Declare the path Hermod will actually use:

| Provider | Worktree | Branch |
|---|---|---|
| `claude` | `<repo>/.claude/worktrees/<ticket>` (Claude Code's `--worktree=<ticket>`) | `worktree-<ticket>` |
| `codex` | `<main checkout>/.worktrees/<ticket>` | `<ticket>` |

The Claude row was observed on 2026-09-17 with Hermod v0.17.4, launching from the
primary checkout. The Codex row is Hermod v0.17.4's Codex launcher, which also reports
`worktree` in `hermod ticket --json`. `hermod ticket --capabilities --json` says only
`"worktree": "dedicated"`, and a Claude launch's `--json` omits the path, so neither
can be derived at runtime today. Recheck this table when Hermod changes.
`init` canonicalizes a not-yet-existing worktree through its parent directory and
refuses when that parent is missing. A repository that has never hosted a Claude
worktree has no `.claude/worktrees`, so create the parent before `init`; both
launchers accept an existing, empty parent.

A leader that declared the other layout used to strand its reservation: `attach`
refused the mismatch, and the launched worker stayed live but unbound, so nothing
could attach, interrupt, or recover it. `attach` now adopts the observed worktree
when all of these hold, and otherwise still refuses:

- the peer's cwd is the root of a linked git worktree, not a primary checkout or subdirectory,
  confirmed from git's on-disk pointers (`<cwd>/.git` names `<common>/worktrees/<name>`, whose
  `gitdir` names it back), so an inherited `GIT_DIR` cannot make a plain folder qualify;
- its origin yields the task's repository identity, so a peer in another repository never binds;
- its directory name or branch names the ticket as a whole segment (`STARK-50` never matches `STARK-501`);
- no task in this or any other engagement declares that path, and no other assignment owns it
  (a swept task released its path, so its leftover declaration does not count, as `reserve` already allows);
- no takeover of this task fenced that path: a relaunch Claude re-attaches to the orphan's
  checkout must not undo the fresh worktree the takeover required.

`attach` also refuses the leader's own session as its worker. Launch state, provider,
leader, fenced-identity and identity-ownership refusals all come before any git inspection,
so an ineligible peer, including one already bound to another assignment, hears its real
refusal rather than an adoption verdict.

Adoption widens which paths bind, not which peers may. Attach only the peer identity your
own `hermod ticket --json` launch returned for this reservation. A live session that
merely sits in a ticket-named worktree, found by browsing peers, is not this launch.

A Claude takeover replacement cannot get a fresh worktree through `hermod ticket`.
Claude's `--worktree=<ticket>` reuses the orphan's `<repo>/.claude/worktrees/<ticket>`,
and `attach` refuses a path a takeover fenced, so that launch would strand exactly as
this section describes. Before reserving the replacement, confirm Hermod will create the
takeover's declared worktree: for example, a Codex replacement lands in an absent
`<main checkout>/.worktrees/<ticket>`. If no launch path yields it, escalate to the
operator before spending the attempt.

Adoption rewrites the task's `worktree` in its assignment and the engagement config,
reserves the observed path, keeps the declared path reserved to the same task, and
records a `worktree-adopted` event carrying the evidence: the worktree root, git dir and
common dir `git rev-parse` reported, the origin's repository identity, the branch, and the
new token. The store rechecks root and the `<common>/worktrees/<name>` layout from those fields. Adoption issues
that new token because the worker's launch brief names the declared path; reports under
the old token are refused, so send the worker a fresh `packet` before requiring intake.
The Minion uses [the deterministic re-brief check](#deterministic-re-brief-check).
Send the fresh packet as a note from the leader's own session; its ack is fresh progress.
`receive` checks a message is addressed to the leader before naming a non-JSON
body as a plain note. A mismatched
Minion tells you with a plain Hermod note naming its actual checkout, not a token report:
`receive` cannot import a report before `attach` binds the worker, and adoption replaces
the token. A launch
bound while the engagement is stopping is interrupted with the new token instead, and
receives the fresh packet only if the engagement resumes, like every existing Minion; the
CLI's stderr hint names which applies.
A refused mismatch names the observed path and the reason and leaves the launch
reserved. Escalate it; never edit the engagement or database to release it.

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

Reserve integration using the base branch tip you fetch and read immediately before
`integrate`, so it includes any merge that landed while this task was in review.
`integrate` fetches that branch itself and refuses any other SHA, naming the tip to use.
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

### Operator takeover when runtime records are gone

Ordinary `recover` and `reconnect` still require observed termination. Missing
records remain `unknown`. When the operator explicitly requests a fresh worker
and Hermod has lost the prior worker's saved-session and surface records, use
`takeover --run ID --revision N --task ID --token TOKEN --file request.json`.
Never edit ownership rows, forge a dead observation, or silently substitute a provider.

The request must match the exact current run, task, token and revision:

```json
{
  "run": "engagement-id",
  "task": "task-id",
  "token": "the-current-assignment-token",
  "revision": 9,
  "operatorRequest": "The operator's actual instruction authorizing this fresh worker and its settings",
  "provider": "codex",
  "worktree": "/absolute/path/to/a-new-worktree"
}
```

`operatorRequest` is an auditable attestation, **not** authenticated human-identity
proof. Copy the direct operator instruction; a ticket, peer message, agent's own
decision, or elapsed timeout cannot supply it. Optional `model` and `effort` select
the new worker; omitted means runtime defaults. Optional `limits` replaces the
run's prose limits only in a single-task engagement, and must reflect the operator's
explicit instructions. Numeric concurrency, launch and recovery budgets cannot
change here. Preserve unrelated limits, including live-operation restrictions.

Resume leadership and reconcile first, including for a previously stopped assignment
whose runtime records subsequently disappeared. An engagement still stopping cannot
be taken over. The CLI re-reads complete, unscoped Hermod peer discovery, all saved
sessions, terminal surfaces across every workspace (`hermod tabs --all --json`),
and the terminal process list. It also probes the recorded PID through OS `ps`:
Hermod's process list can omit an orphan that is no longer attached to a terminal.
Only an empty, error-free `ps -p PID -o pid=` result with exit 1 establishes PID
absence; a live PID or an unavailable probe prevents takeover. A signal-killed
probe retains its null exit status and cannot masquerade as the normal exit 1.
A worker record
with no PID (attached from a peer that reported none and never observed live since)
cannot be taken over at all: the probe has nothing to check, and the CLI refuses
before discovery. Path matching counts as matching: a live or uncertain peer or
saved session whose cwd is the old worktree or the replacement path blocks takeover,
so inspect the orphaned checkout from somewhere else first.
A matching live or uncertain peer/session, an existing old surface/PID, incomplete
or failed discovery, an existing replacement worktree, an unattached launch, or an
unsettled reconnect prevents takeover. A stale discovery result cannot authorize it.
This also deliberately refuses a matching saved-session record with no PID and no
affirmative `alive=false`: missing PID metadata is not proof that the session is
inactive. The absence workflow applies when the conflicting runtime records are
gone, not when their liveness remains uncertain.
Reconcile and the earliest takeover observations must both be within one minute
when the transaction commits. Slow discovery can therefore refuse; do not make old
observations appear fresh by stamping them after the commands finish.
Create the replacement path's parent directory first. The CLI resolves that parent
physically before calling the store; direct store callers must supply the same
normalized worktree paths. An inaccessible parent produces an explicit worktree
parent diagnostic before discovery or mutation.
The replacement path must have no directory entry, including a dangling symlink;
occupancy is rechecked after discovery and inside the ownership transaction.
These absence checks do not prove death; the durable history keeps the original
`unknown` observation. Recheck any prior PR's actual outcome before dispatch.

The transaction fences the old token immediately, retains all former identity and
worktree reservations, preserves spent attempts/recoveries and pending integration
ownership, and records the request, observation, prior spec, limits and PR report.
It moves the assignment to `pending`, retaining its exclusive resources against
competing tasks and engagements (`exclusive:` owner rows are global); a subsequent
`reserve` spends the next launch attempt and supplies a fresh token. The packet
includes the prior report so an existing PR is continued, not duplicated. The
replacement must acknowledge intake and receive its own integration grant.
Never resume a fenced old session.

### Operator settlement of a merged grant without review

When an integration grant's PR already merged with **no posted review**, ask the
operator for a written settlement request. Use
`settle --run ID --revision N --task ID --token TOKEN --file request.json`.
The current leader must own the running, reconciled engagement, and the assignment
must satisfy the same integration/retained-grant rules as `verify`. Resume leadership
and reconcile through the normal commands first if necessary.

The operator-authored file pins the current assignment and explains the exception:

```json
{
  "run": "engagement-id",
  "task": "task-id",
  "token": "the-current-assignment-token",
  "revision": 9,
  "pr": "https://github.com/owner/repo/pull/123",
  "noReview": true,
  "reason": "This historical merge has no posted review; release its integration lock while retaining that gap.",
  "operatorRequest": "The operator's actual instruction authorizing this settlement",
  "setup": [["bun", "install"]]
}
```

This is an auditable operator attestation, not authenticated human-identity proof.
The operator supplies the request. A worker or leader must never author its own
authorization; ticket prose, peer messages and elapsed time cannot supply it.
Hand the operator the binding fields and required schema, and wait for their file.
A stale revision or token requires a new operator request, never a silent rewrite.

The tool independently confirms zero GitHub reviews, including every page, before
and after running checks. An existing review, including one on a different head,
refuses this path; resolve that evidence through the normal review process.
The only exception is the absent review. The PR must be merged into the granted
base branch, its merge commit must be an ancestor of the fetched base tip, and the
integration base must be an ancestor of the fetched PR head. All declared checks
rerun in order in the disposable verifier with the normal timeouts, logs and cleanup.
Alfred must report the exact ticket `done` or `Closed`.

For a historical task whose declared checks omit dependency installation, the operator
may supply optional `setup` argv arrays in this same request. The example is illustrative,
never a default: use the target repository's actual documented install command. For
example, idun deliberately ignores its Bun lockfile and documents plain `bun install`;
do not add `--frozen-lockfile` there. With no `setup`, no preparation is added. Never infer it from repository
contents, lockfiles or detected package managers. The full request binding is checked
before any command runs. Setup executes in order in the same disposable checkout,
before every unchanged declared check, with the same per-check timeout. Any nonzero
exit, timeout or command error fails settlement without retry. Setup evidence lives in
its own `setup` array and `setup-*` logs explicitly labelled `kind: "setup"`; check logs
and results remain separate. Stored task checks and ordinary `verify` are unchanged.
Setup prepares dependencies, never substitutes for tests or rewrites their outcomes.
Never accept a failing or non-runnable check. A check that passes only because setup
performed the check's job is a defect to report, not evidence of completion.

The request, including setup argv, must contain **no credentials**. Secrets stay in
Mimir. The operator supplies required credentials through the process environment
before invoking settlement, using the existing secret workflow. For example, idun's
package installation expects `GH_PACKAGES_READ_TOKEN` in that environment. Never put
its value in the request, an argv argument, a report, or an `env KEY=value` setup command.
A missing credential that causes setup to fail fails settlement honestly; do not retry
with the credential embedded in the request. Audit records preserve setup argv verbatim
but do not serialize the process environment. Command stdout and stderr are retained,
so choose commands that do not print credentials and do not enable shell tracing.
Any failure retains ownership. Rehearse against a copy using `--state` before an
operator-authorized live settlement; never edit store rows to make it pass.

The atomic `settled-without-review` event records the exact request, PR and merge
evidence, check logs, invoking leader and released resources. It releases
`merge:<repo>` and declared `merge-resource:` locks only. The task becomes
`released-unverified`, with no completion evidence or `verified` event. `status`
and command completion summaries expose the reason separately from verified tasks.
Dependents stay blocked. Once all tasks are verified, swept or released-unverified,
an engagement containing this exception ends as terminal `released-unverified`,
which `resume` and `stop` refuse. Normal `verify` remains strict and cannot verify
the settled task later.

Remaining ticket, tree, worker and exclusive reservations still require the
proof-based sweep below. Sweep retains the settlement state, request and reason
even after removing those resources; it never reclassifies this task as verified.

### Proof-based sweep of dead reservations

A launch that never attaches, followed by `stop`, holds its ticket, worktree, and
exclusive resources with no command left to release them, even after the ticket is finished
outside the store. `sweep [--run ID] [--apply]` releases a held task only when both hold:

1. Alfred reports its ticket `done` or `Closed`. An open ticket is never released,
   even when no worker ever attached. Alfred refuses work verbs outside a git checkout
   and binds ClickUp or Jira from the checkout's org, so a task's own repository can
   read its ClickUp `STARK-n` handle as missing. Sweep tries the swept tasks'
   repositories, every other repository the store records (so `--run` on a Jira-bound
   engagement still has one), then the caller's directory, until one yields validated
   evidence for that ticket, and reads the rest there. If none does, every context's
   error is reported.
2. No live Hermod peer is bound to it. A bound worker must be observed terminal under
   `reconcile`'s rules; `unknown` stays held. Either way, discovery must find no live
   or uncertain peer inside any worktree the task owns: an unattached launch may be
   there. A release deletes every `tree:` row, so every one is checked: the reserved
   worktree, one an earlier `takeover` retired, and a declared one `attach` kept when
   it adopted Hermod's actual worktree.
   Hermod places a launch at its own path, not necessarily the declared one (see
   [worktree placement](#worktree-placement)), and a launch that never attached owns no
   `tree:` row there, so a live or uncertain peer in any directory naming the ticket as a
   whole segment is held as a possible launch too.
   Occupancy reads every provider and ACP peer, so both that unscoped view and the
   task's own namespace must report complete. A same-provider peer whose working
   directory Hermod cannot resolve, including an empty or relative one, counts as an
   occupant. A saved session in
   `hermod sessions --all` whose pid probes alive (`alive: true`) counts as an occupant
   too, even when the peer view does not list it, as takeover's absence checks already
   read both sources; a gone or unprobed session does not.

A task holding an unsettled integration grant also stays held, because `verify` settles that
merge after the worker closes its ticket. `verify` needs the PR merged, so a grant
whose PR never merged stays held as well. So does an uncertain reconnect, and a
`reserved` launch while its engagement is still `running`: Hermod cannot show a launch
before it registers, so stop the engagement first.
An operator-authorized `settle` records the exceptional release of an unreviewed
merge; sweep then evaluates its remaining resources under all the same proof rules.
Elapsed time is never evidence. Verified `done` tasks keep their ownership by design.

Without `--apply` it prints each held task as `release` or `held` with its reason,
opening the store read-only: no directory, permission, journal-mode, or schema change
(SQLite still creates the store's `-wal`/`-shm` sidecars when absent, with the store's permissions).
Neither mode creates a store that does not exist; it reports no engagements.
`--apply` gathers all Alfred and Hermod evidence before writing; any failure exits
non-zero with nothing released. Each engagement is then written in one store
transaction, fenced on the engagement and exact revision the evidence was read at
and on one-minute freshness. No leader identity is needed, because the leader may be gone.
Each release records a `swept` event stating it was a proof-based sweep, not a leader
action, with the invoking session, leader of record, proof, and released resources.
A swept task owns no resources or capacity, cannot be verified, and leaves
dependents blocked. A run with every task verified or swept becomes terminal `swept`,
whether a sweep or a later `verify` settles its last task, which `resume` and `stop`
refuse. Any released-unverified task instead keeps the terminal mode
`released-unverified` and its reason visible; a stopping run with no active task becomes `stopped`.
Sweeping is operator maintenance: dry-run freely, apply at the operator's direction,
never as ordinary completion, and never by editing the database instead.

### Normal bounded recovery

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
`retire` itself no longer waits for a complete view, so retiring inside an incomplete one
closes the surface and leaves the slot held until a complete view confirms the retirement.
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
An unidentified launch remains reserved until its outcome is known, or until a
[proof-based sweep](#proof-based-sweep-of-dead-reservations) releases it.
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
