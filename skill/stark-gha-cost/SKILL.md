---
name: stark-gha-cost
description: >-
  Diagnose and cut GitHub Actions + GHAS (Advanced Security) billing costs for an
  org or enterprise. Use whenever the user is surprised by or wants to reduce a
  GitHub bill, mentions Actions minutes / runner cost / CI spend, asks "why is my
  GitHub bill so high", "are we paying for GHAS/secret scanning/code scanning",
  "should I self-host runners", "which repo is burning Actions minutes", or wants
  to right-size GitHub security seats (Secret Protection vs Code Security). Also
  triggers on a mystery Actions charge, a runaway workflow, or a billing number
  that looks wrong. Also use for making CI cheaper/faster the right way — slow or
  expensive pipelines, build/dependency caching that isn't hitting, wide test
  matrices, merge queues, flaky-test cost, artifact/registry storage, or measuring
  CI spend (cost-per-PR, budgets, usage APIs). Diagnoses where the money goes
  (product → repo → workflow → run), applies the highest-value levers via PR, and
  escalates genuine mis-billing to Support. Reach for it even when the user only
  says "GitHub is expensive this month" or "our CI is too slow" without naming
  Actions.
disable-model-invocation: truemodel: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-gha-cost — GHA + GHAS cost optimizer

Cut GitHub Actions + GHAS spend without breaking CI. The trap is optimizing the
wrong thing (self-hosting runners to fix a GHAS-license bill, or rewriting
workflows to fix a billing bug). So **measure first, then aim** — most of a bill
is usually one repo, one workflow, or one wrong seat.

## The mental model (read `references/levers.md` for the full version)

GitHub bills two unrelated meters: **Actions minutes** (compute) and **GHAS
seats** (per-committer: Secret Protection ~$19, Code Security ~$30). Dependabot +
dependency graph are **free**. Self-hosting runners touches *only* Actions
minutes — never the seat bill. Don't conflate them; the user often will.

## Workflow

### 0. Check repo visibility FIRST — public Actions are free

Before calling any Actions usage "expensive," check whether the repo is public.
**Public repos get unlimited free GitHub-hosted Actions minutes AND storage** —
a busy public repo costs $0 no matter how many runs. `gh api repos/OWNER/REPO
--jq .visibility`. If it's public and a bill still looks high, the runs aren't
the cost — jump to "chase the resource" below. Skipping this step is how you end
up optimizing a $0 line item.

### 1. Diagnose — find where the money actually goes

Never guess. Run the breakdown before proposing anything:

```bash
GH_TOKEN=<admin:enterprise or admin:org PAT> \
  scripts/gha-cost-breakdown.sh --enterprise <slug>
```

Read the PAT into the env; never print it. This ranks spend by product → SKU →
repo, and shows GHAS seat usage. Almost always one or two repos dominate.

Then drill the top repo:

```bash
GH_TOKEN=<pat> scripts/gha-repo-actions-drill.sh <owner/repo> [since=YYYY-MM-DD]
```

This classifies the driver: high run **volume**, matrix **fan-out** (jobs ≫ 1),
a few **long** runs, or **none of the above**. The script prints how to read it.

**Expect one thing to dominate (Pareto).** Usually a single workflow/matrix is
80–98% of the bill and everything else is rounding error — don't spread effort
evenly. Pull **real per-job timings** with `gh run view <run-id>` (not vibes) to
find it. If the driver is a **test matrix**, the cost is almost always per-job
*setup* (token mint, dep download, cold compilation, no cache sharing) × job
count — not test logic. Read `references/matrix-runners.md` before optimizing it.

**Measure the right number** (`references/advanced-practices.md §1`):
- **billed ≠ runtime ≠ cost** — every job rounds UP to a whole minute; included
  minutes carry OS multipliers (Linux 1× / Windows 2× / **macOS 10×**). Summing
  durations understates spend; a `billed-minutes ÷ actual-runtime` ratio per
  workflow is the rounding-waste detector.
- **The dominant CI cost is often developer WAIT time, not runner minutes**
  (measured wait-to-compute ratios of 25–100×). For a team, the true unit is
  **cost-per-merged-PR including loaded wait** — so queue-time and pipeline
  duration are usually the real levers, not $/minute. Free org-wide **Actions
  Insights** (queue time + failure rate, UI-only) and `self-actuated/actions-usage`
  (sees free-tier + self-hosted minutes billing hides) are the fast lenses.

### 2. Decide — Actions minutes, a downstream resource, or a billing anomaly?

The trigger/workflow is rarely the cost itself — **chase the resource the
workflow touches.**

- **Actions minutes** (private repo, volume / fan-out / long runs explain it) →
  step 3, apply the runner levers.
- **A downstream cloud resource.** A "deploy" or "build" workflow may bill almost
  nothing in Actions but push a Docker image to a **registry** (GCP Artifact
  Registry storage), stash a large **artifact**, or spin up **Cloud Run** — the
  real charge lands on the *cloud* bill, attributed to the project, not GitHub.
  Trace what the workflow does (build → push → deploy) and check the cloud
  billing for those resources. On GCP this is `gcp_artifact_registry`
  (`idle_repositories` / repo storage) + Cloud Run. Editing the workflow's
  triggers won't touch this; right-sizing/cleaning the resource will.
- **A billing anomaly** — runs are short, no matrix, `runs/{id}/timing` reports
  `billable ~0`, yet the bill shows huge minutes. Workflow edits **cannot** fix
  mis-billing. Draft a Support ticket from `references/support-ticket.md` and say
  plainly this is the lever that might claw money back. Still do step 3 for any
  legit portion, but don't oversell it as the fix.

### 3. Apply levers — highest value ÷ friction first

Full ranked list + exact Terraform/API/YAML in `references/levers.md`. The short
version, in order:

1. `default_workflow_permissions: read` (the real supply-chain lever).
2. `can_approve_pull_request_reviews: false` (free).
3. Disable CodeQL default setup if Code Security is off / unused; prune redundant
   languages.
4. Cut over-frequent crons (hourly → daily).
5. `concurrency: cancel-in-progress` on PR / `check_run` workflows (collapses the
   per-commit check storm).
6. Path-filter expensive-runner jobs (macOS) / heavy matrices into their own
   workflow — skipped and free when untouched. A detector job is worse: it still
   bills 1 rounded minute every run. A `.github/**` trigger-all that runs the
   whole test matrix on infra-only PRs is a classic quiet overspend.
7. **When the driver is a test matrix**, attack `job_count × per-job_overhead`:
   bucket/shard jobs down (drop isolation the code already enforces), share/warm
   the build cache, template-clone DBs instead of replaying migrations. See
   `references/matrix-runners.md`.
8. Self-hosted runners: marginal if you'd stand up new compute, but **the biggest
   lever if you already own a cluster** — ARC ephemeral runners on an existing
   GKE (esp. Autopilot) take GitHub-billed minutes to ~0. Never a runaway, never
   macOS (no GCP Macs), never public repos.

Right-size seats too: if `code_security` committers = 0, you don't need the $30
product — turn its new-repo default off at the **org** tier (the enterprise flag
is availability-only and won't toggle off).

### 4. Ship it — every change via branch + PR

These are workflow/config/Terraform edits; land them on a branch and open a PR
per the workspace rules (`/branch → /pr → /merge-to-main`). Test live where you
can — check that the path filter actually skips (the PR touching only workflow
files should NOT trigger the macOS/expensive job), and confirm 0 drift after a
Terraform apply. Config actions that aren't files (disabling CodeQL default
setup, backfilling secret scanning) are API calls — note them in the PR body.

**Then keep it cut.** A cut regresses the moment attention moves on. Set a GitHub
**budget** (with a %-alert, or a hard-stop) and/or the org **spending limit** so
the next regression stops *before* the invoice, and re-check the `billed÷actual`
ratio after the change to confirm the drop landed. Governance (budgets, cost
centers, org allowed-actions + SHA-pin policy) is in `references/advanced-practices.md §2`.

## Level up — the "done right" playbook

The steps above stop the bleeding. For the durable craft — quality practices that
cut cost *and* improve speed/reliability/security — read
**`references/advanced-practices.md`** (themed, with a table of contents):
measurement & FinOps discipline (§1–2), caching architecture (§3), pipeline
architecture that skips work without breaking merges (the **gate job**, merge
queues, test-impact analysis) (§4), storage/registry lifecycle + the downstream-
resource trap (§5), and the security⇒cost levers (OIDC, `harden-runner`,
SHA-pin policy, flaky-test economics) (§6). Runner selection lives in
`references/matrix-runners.md`.

## Guardrails

- **Validating a CI cost-fix can itself cost a full run (chicken-and-egg).** An
  infra/CI PR often trigger-alls the very matrix you're trimming, so you pay one
  expensive run to prove the reduction. Sequence deliberately: land the **trigger
  narrowing first** so later cost PRs don't re-run the matrix; accept one costly
  validation when unavoidable. You pay once to stop paying forever.
- **local-green ≠ CI-green.** A warm local module/build cache hides problems CI
  hits cold (e.g. a dependency that stopped resolving after a module move). A
  broken CI blocks *both* cost work and correctness work — fix the correctness
  break first, or they mask each other.
- **Disabling / path-filtering a workflow that feeds a REQUIRED status check
  freezes the repo.** A *skipped workflow* leaves its required check **Pending
  forever** → nothing merges (worse with `enforce_admins: true`). Note the
  asymmetry: a skipped **job** reports *Success*, but a skipped **workflow** stays
  Pending. Two fixes: (a) before disabling, inspect branch protection (`gh api
  repos/O/R/branches/BRANCH/protection`) and **remove the check from
  `required_status_checks` in the same change**; (b) the durable pattern — make the
  *only* required check a **gate job** that `needs: [all real jobs]`, `if: always()`,
  aggregating via `re-actors/alls-green`, and un-require the individual jobs. The
  gate job also closes a **security gap**: GitHub counts a *skipped job as passing*,
  so a required scan skipped by a path filter / upstream failure / `[skip ci]`
  merges as if it passed — `if: always()` converts skips to an explicit fail.
  (`references/advanced-practices.md §4`.)
- **`default_workflow_permissions: read` can break writers.** Scan for workflows
  that push/release/comment via the implicit token and lack an explicit
  `permissions:` block *before* flipping — fix those first.
- **Never hardcode a token.** Read the PAT into the process; keep it out of chat,
  commits, and PR bodies.
- **Don't retro-enable paid scanning blindly.** Secret-scanning backfill consumes
  a committer seat and can dump an alert backlog — confirm the seat math first.
- **Concurrency keys and workflow inputs** go in the `group:` string or `env:`,
  never interpolated into a `run:` shell line (injection).

## Gotchas

The API has sharp edges (deprecated endpoints, GraphQL-only enterprise metadata,
422s on `advanced_security`, 30-item list defaults). They're catalogued at the
bottom of `references/levers.md` — check there before assuming an API call is
"just failing."
