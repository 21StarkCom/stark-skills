# Skip-draft guard — keep CI off WIP pull requests

**Policy:** PRs open as **drafts** by default (the stark-gh / review / red-team /
phase-execute / spec-to-plan skills all do this). Work is verified locally while
the PR is a draft; when it's ready, it's marked ready-for-review — which is the
moment CI should run. A draft PR should **not** burn CI minutes or trigger any
`pull_request`-driven automation.

**The catch:** a draft PR still fires `pull_request` events (`opened`,
`synchronize`) by default. Opening drafts alone does **not** stop Actions — each
`pull_request`-triggered workflow must be guarded. This is a two-part change per
workflow.

## The pattern

1. **Add `ready_for_review` to the trigger types** so the workflow fires the
   moment a draft is un-drafted (that's when CI should finally run):

   ```yaml
   on:
     pull_request:
       types: [opened, synchronize, reopened, ready_for_review]
   ```

2. **Gate the job on the PR not being a draft:**

   ```yaml
   jobs:
     build:
       runs-on: ubuntu-latest
       if: github.event.pull_request.draft == false
       steps: ...
   ```

Net effect: while the PR is a draft, `opened`/`synchronize` events fire but the
job is skipped; when it's marked ready, `ready_for_review` fires and the job
runs on the current head. Marking ready is the single CI-triggering moment.

## `== false` vs `!= true` — pick by event set

- **`if: github.event.pull_request.draft == false`** — use when **every** trigger
  is a `pull_request` / `pull_request_review` event. Those payloads always carry
  `pull_request.draft`, so the comparison is well-defined.
- **`if: github.event.pull_request.draft != true`** — use when the workflow also
  triggers on events **without** a `pull_request` object (e.g. `check_run`,
  `workflow_run`, `schedule`, `push`). There `draft` is `undefined`, and
  `undefined == false` is **false** — a `== false` guard would wrongly skip those
  runs. `!= true` runs unless the PR is *explicitly* a draft, so non-PR events
  keep working and only explicit-draft `pull_request` events are skipped.

## What is NOT guarded

- **`push`-triggered workflows** (e.g. deploy-on-merge, `marketplace-sync`) — a
  merge to the default branch is never "draft", so leave them alone. A workflow
  that itself *opens* a downstream PR which must run its own CI and auto-merge
  (again `marketplace-sync`) should open that PR **ready**, not draft.
- **Merge gates that read PR status** — a draft never reaches "Ready to Merge",
  so a status-driven gate is already a no-op on drafts; the guard is just
  belt-and-suspenders (and, for `check_run`-triggered gates, must use `!= true`).

## Reference implementations in this repo

- `.github/workflows/project-pr-sync.yml` — `== false` (pull_request +
  pull_request_review only), plus a `ready_for_review → Human Review` mapping.
- `.github/workflows/project-gate-check.yml` — `!= true` (also `check_run`).
- `standards/workflows/doc-staleness.yml` — `== false`, the adoptable template.

## Downstream, per target repo

The skills open drafts in whatever repo you run them against, but each **target
repo owns its own workflows** — apply this guard to every `pull_request`-triggered
workflow there for the "no CI on WIP" guarantee to actually hold. Without the
guard, the target repo's CI still runs on the draft; the draft only suppresses
*your* intent, not GitHub's default event delivery.
