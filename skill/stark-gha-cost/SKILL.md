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
  that looks wrong. Diagnoses where the money goes (product → repo → workflow →
  run), applies the highest-value levers via PR, and escalates genuine
  mis-billing to Support. Reach for it even when the user only says "GitHub is
  expensive this month" without naming Actions.
disable-model-invocation: false
model: opus
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

### 2. Decide — is it real spend or a billing anomaly?

- **Real spend** (volume / fan-out / long runs explain the minutes) → go to
  step 3, apply levers.
- **Anomaly** — runs are short, no matrix, and `runs/{id}/timing` reports
  `billable ~0`, yet the bill shows huge minutes. Workflow edits **cannot** fix
  mis-billing. Draft a Support ticket from `references/support-ticket.md` and
  tell the user plainly this is the lever that might claw money back. Still do
  step 3 for the legit portion, but don't oversell it as the fix.

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
6. Path-filter expensive-runner jobs (macOS) into their own workflow — skipped
   and free when untouched. A detector job is worse: it still bills 1 rounded
   minute every run.
7. Self-hosted runners: only for sustained Linux minutes, never a runaway, never
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

## Guardrails

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
