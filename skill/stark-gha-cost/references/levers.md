# GHA + GHAS cost levers, billing model, and gotchas

## The two separate bills (do not conflate)

GitHub bills **compute** and **security seats** on completely different meters.
This trips people up constantly ("should I self-host runners to cut my GHAS
bill?" — no, different meter).

| Meter | What | Unit | Self-hosting helps? |
|---|---|---|---|
| **Actions minutes** | CI compute | per-minute, per runner OS | Yes — this is the only thing it touches |
| **GHAS: Secret Protection** (~$19) | secret scanning + push protection | per **active committer**/mo | No |
| **GHAS: Code Security** (~$30) | CodeQL code scanning + dependency review | per **active committer**/mo | No |
| **Dependabot alerts + security updates + dependency graph** | supply-chain alerts | **FREE** on all repos | n/a |

Key consequences:
- A committer is counted **once across all enabled repos**, so a solo fleet = ~1
  seat regardless of repo count.
- You almost never need **Code Security ($30)** unless you actually run CodeQL /
  dependency review. Turning it off is pure savings.
- Secret scanning enables **without** `advanced_security` (that's Code Security).

## Visibility first — public repos are free

**Public repos get unlimited free GitHub-hosted Actions minutes AND storage.**
Check `gh api repos/O/R --jq .visibility` before treating any Actions usage as a
cost. A public repo won't even appear as an Actions charge in the billing
breakdown — so if its bill looks high, the cost is a **downstream resource**, not
the run (next section).

## The cost is the resource, not the trigger

A build/deploy workflow can bill ~$0 in Actions yet be genuinely expensive
because of what it *touches*: a Docker image pushed to a registry (**GCP
Artifact Registry** storage), a large stored artifact, or a **Cloud Run** service
it deploys. That spend lands on the **cloud** bill, attributed to the project,
not GitHub. Trace the workflow (build → push → deploy) and check the resource's
cloud billing. On GCP: `gcp_artifact_registry` (`idle_repositories`, repo
storage) + Cloud Run. Editing triggers/concurrency won't move this — cleaning or
right-sizing the resource will.

## Runner cost math (why per-job rounding matters)

- **Every job is billed rounded UP to a full minute.** A 9-second job bills 1
  minute. So a matrix of 100 short jobs bills ~100 minutes even at ~0 wall-clock.
- **macOS ≈ 10× Linux; Windows ≈ 2×.** A test matrix that re-runs the whole
  suite on macOS for platform-agnostic code is the classic overspend.
- A **detector job** (a cheap job that decides whether to run an expensive one)
  still bills 1 minute every run. Prefer workflow-level `paths:` filtering (skips
  the whole workflow → bills **0**) over a detector job.

## Levers, ranked by value ÷ friction

1. **`default_workflow_permissions: read`** (org + enterprise). Biggest lever.
   Caps what a compromised action can do — read vs push-code/cut-releases/
   self-approve. Terraform: `github_actions_organization_workflow_permissions`.
   Breakage risk: workflows that write via the implicit token break unless they
   declare `permissions:` explicitly — scan first (release-please, deploy jobs).
2. **`can_approve_pull_request_reviews: false`** — free, near-zero breakage.
   Only matters once you require PR approvals, but future-proofs cheaply.
3. **Disable CodeQL default setup if you don't use Code Security.** It burns
   Actions minutes (one analysis job per language) for a feature you turned off.
   `gh api -X PATCH repos/OWNER/REPO/code-scanning/default-setup -f state=not-configured`.
   Also prune redundant languages (`javascript` + `javascript-typescript` +
   `typescript` overlap).
4. **Reduce over-frequent crons.** An hourly stale/heartbeat cron is 720 runs/mo;
   daily is 30. Staleness rarely needs 24×/day.
5. **`concurrency: cancel-in-progress`** on PR/check_run-triggered workflows.
   `check_run: completed` fires once per sibling check — a storm per commit.
   Group by commit/PR and cancel superseded runs. Key on a SHA/PR-number, used
   only as the group string (never shell-interpolated):
   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.event.check_run.head_sha || github.event.pull_request.number || github.ref }}
     cancel-in-progress: true
   ```
6. **Path-filter expensive-runner jobs into their own workflow.** e.g. macOS
   only when Mac-only code (`**/*_darwin.go`) changes. Separate workflow +
   `on.push/pull_request.paths:` → skipped-and-free when untouched. Scope the job
   to just the affected package, and drop `-race` if Linux already ran it.
7. **Self-hosted runners** — only worth it for **sustained** Linux minutes after
   the above. Never for a runaway (you'd pay GCP for the same runaway). **macOS
   can't be self-hosted on GCP** (no Mac instances). Never on **public** repos
   (untrusted PR code on your infra).

## Enabling / backfilling security features

- New-repo defaults cascade **enterprise → org**. Manage secret scanning at the
  enterprise tier (`github_enterprise_security_analysis_settings`); the org
  singleton (`github_organization_settings`) then reads the cascaded value —
  pin it to match or the two tiers fight.
- Existing repos are **not** retroactively enabled. Backfill per-repo:
  - Dependabot (free): `PUT /repos/O/R/vulnerability-alerts` (also enables the
    dependency graph) + `PUT /repos/O/R/automated-security-fixes`.
  - Secret scanning (paid seat): `PATCH /repos/O/R` with
    `security_and_analysis.secret_scanning{,_push_protection}.status=enabled`.
  - **Skip archived repos** (read-only → the write 404s/422s).

## Gotchas that cost real time

- **`orgs/{org}/settings/billing/actions` is gone (HTTP 410).** Use the enhanced
  endpoint `.../settings/billing/usage` and parse `usageItems`.
- **`enterprises/{slug}` top-level REST 404s** (enterprise metadata is
  GraphQL-only), but sub-endpoints (`.../actions/permissions`,
  `.../settings/billing/*`) work with the slug.
- **`security_and_analysis.advanced_security` is a 422** under the split billing
  model ("not available, nor a pre-requisite") — secret scanning enables
  directly; don't send `advanced_security`.
- **Enterprise `advanced_security_enabled_for_new_repositories` won't toggle
  off** — it reflects product availability. The **org-tier** default is the real
  cost switch. Same for `secret_scanning_validity_checks_enabled` (won't persist
  at enterprise scope → perpetual diff; leave false).
- **`gh issue/pr list` defaults to 30 items** — pass `--limit 200` before
  trusting a completeness/count check.
- **Disabling a workflow tied to a REQUIRED status check freezes the repo.** The
  required check never reports → no PR can merge; `enforce_admins: true` blocks
  admins too. Always read `repos/O/R/branches/BRANCH/protection` and drop the
  check from `required_status_checks` in the same change as disabling the
  workflow/CodeQL-setup that produced it.
- **Billing report vs timing API disagreeing by ~100×+** is the anomaly signal:
  all runs short, no matrix, `runs/{id}/timing` reports `billable ~0`, yet the
  bill shows tens of thousands of minutes. Workflow edits can't fix mis-billing —
  escalate. See `support-ticket.md`.
