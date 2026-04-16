# Skill Optimizer

Purpose: inventory a skill bundle, generate a rewrite brief or API-backed rewrite proposal, review the result, then optionally apply it.

## What it uses

- `tools/skill_audit.ts` inventories skills and validates direct local markdown links.
- `tools/skill_optimize.ts` rewrites one or more skill bundles.
- `gpt-5.4-pro` is used only in `--mode api`.

## Modes

- `--mode plan`
  - No API calls.
  - Writes bundle inventory plus `rewrite-request.md`.
  - Use this to inspect scope or craft a manual rewrite.
- `--mode api`
  - Requires `OPENAI_API_KEY`.
  - Submits a background Responses API job, polls until completion, and writes a structured proposal.

## Targeting skills

- Single skill by slug:
  ```bash
  node tools/skill_optimize.ts --mode api --skill stark-forged-review
  ```
- Single skill by path:
  ```bash
  node tools/skill_optimize.ts --mode api --skill skill/stark-forged-review/SKILL.md
  ```
- Multiple skills with repeated flags:
  ```bash
  node tools/skill_optimize.ts --mode api --skill stark-forged-review --skill stark-review-plan
  ```
- Multiple skills with one comma-separated flag:
  ```bash
  node tools/skill_optimize.ts --mode api --skills stark-forged-review,stark-review-plan,stark-team-review
  ```
- All skills:
  ```bash
  node tools/skill_optimize.ts --mode api
  ```

If no `--skill` or `--skills` flag is provided, the optimizer processes every discovered skill.

## Recommended workflow

1. Validate current links:
   ```bash
   node tools/skill_audit.ts --validate
   ```
2. Run a dry-run proposal:
   ```bash
   node tools/skill_optimize.ts --mode api --skill stark-forged-review --diff
   ```
3. Review artifacts in `artifacts/skill-optimizer/<skill-slug>/`.
4. Apply the saved proposal without paying for a second model call:
   ```bash
   node tools/skill_optimize.ts --mode api --skill stark-forged-review --reuse-proposal --apply
   ```
5. Re-run link validation.

## Diff mode

Use `--diff` to print the proposal diff to stderr during the run.

The optimizer also always writes a persistent diff artifact:

- `artifacts/skill-optimizer/<skill-slug>/proposal.diff`

This diff compares the current repo file against the proposed rewrite for every changed file in the bundle.

## Summary artifacts

Per skill bundle:

- `bundle.json` — discovered files, word counts, and line counts
- `rewrite-request.md` — generated only in `--mode plan`
- `proposal.json` — structured proposal from the API
- `proposal-summary.md` — human summary of changes, contradictions resolved, and warnings
- `proposal.diff` — unified diff for changed files
- `proposed/...` — proposed file contents for inspection

Per run:

- `artifacts/skill-optimizer/run-summary.json`
- `artifacts/skill-optimizer/run-summary.md`
- `artifacts/skill-optimizer/runs/<timestamp>.json`
- `artifacts/skill-optimizer/runs/<timestamp>.md`

These aggregate all bundles processed by the invocation, including proposal paths, diff paths, changed-file counts, and warnings.

If a proposal has already been applied, `proposal.diff` may be empty because the current file already matches the proposed file.

## Important flags

- `--apply`
  - Apply the proposal to repo files.
  - Default is dry-run.
- `--reuse-proposal`
  - Skip the API call and apply or inspect the existing `proposal.json`.
  - Use this after reviewing a dry-run proposal.
- `--diff`
  - Print diffs during the run.
- `--api-timeout-ms <ms>`
  - Total time budget for a background rewrite job.
- `--poll-interval-ms <ms>`
  - Poll interval for background job status.
- `--max-output-tokens <n>`
  - Output budget for the structured rewrite proposal.
- `--reasoning-effort medium|high|xhigh`
  - `gpt-5.4-pro` does not support `low`.

## Notes on `gpt-5.4-pro`

- Large bundles can take several minutes.
- For multi-file bundles, use a larger timeout, for example:
  ```bash
  node tools/skill_optimize.ts --mode api --skill stark-review-plan --api-timeout-ms 900000
  ```
- The optimizer uses Responses API background mode so long rewrites can complete without a single blocking request.
