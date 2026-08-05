---
name: stark-terraform-review
description: >-
  Multi-agent code review of Terraform / OpenTofu (HCL) — modules, root configs,
  .tf/.tfvars/.tftest.hcl — for security, correctness, state safety,
  module-contract quality, and testing gaps. Runs the review across one or more
  configurable LLMs (claude/codex/gemini), each as its own subagent, then merges
  + cross-validates findings. Use whenever the user wants to review, audit, or
  sanity-check Terraform/OpenTofu code, asks "is this .tf safe/correct/idiomatic",
  or points at a module/directory and wants findings. Review-only. For Terragrunt
  orchestration use stark-terragrunt-review.
argument-hint: "[path] [--agents claude,codex,gemini] [--changed] [--no-tools] [--min-severity ...] [--pr N --repo O/R] [--dry-run] [--json]"
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-terraform-review

Multi-agent Terraform/OpenTofu reviewer. Keep this skill thin: resolve the
target, then hand off to the TS dispatcher `tools/iac_review.ts`, which runs the
review across **one or more configured LLM agents** (each a headless subagent),
merges + cross-validates the findings, and renders the report. All logic — agent
resolution, file collection, host scanners, dispatch, dedup, PR posting — lives
in the tool. Read its output and surface failures.

## Configuring which LLMs run the review

The reviewers are configurable. Precedence: **`--agents` flag > config
`iac_review.agents` > `["codex"]`**. To run with Gemini **and** Codex:

```bash
# per-invocation
… --agents gemini,codex

# or persist in ~/.claude/code-review/config.json (or a repo .code-review/config.json)
{ "iac_review": { "agents": ["gemini", "codex"] } }
```

Each listed agent reviews independently as its own subagent; findings they agree
on are marked cross-validated.

## Arguments

Raw input: `$ARGUMENTS`

- `path` — file or directory. Default: current repo root / cwd.
- `--agents a,b` — LLMs to run (claude|codex|gemini). Overrides config.
- `--changed` — only HCL changed vs the git merge-base / working tree.
- `--no-tools` — skip host scanners (review by reading only).
- `--min-severity S` — drop findings below S (`critical|high|medium|low`).
- `--pr N --repo O/R` — post the merged findings to PR N (authored by the first agent's GitHub App).
- `--dry-run` — resolve agents + files, dispatch nothing.
- `--json` — print the receipt JSON instead of the markdown report.

## Run it

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types --no-warnings "$TOOLS/iac_review.ts" \
  --kind terraform "${PATH_ARG:-.}" ${EXTRA_FLAGS}
```

The dispatcher:
1. Resolves the agent list (see above) and reports any skipped (disabled/unknown).
2. Collects the in-scope `.tf`/`.tfvars`/`.tftest.hcl` (capped; `--changed` narrows).
3. Runs whatever read-only scanners are installed (`terraform fmt/validate`, `tflint`, `trivy config`, `checkov`) as evidence — unless `--no-tools`.
4. Dispatches every agent in parallel with the canonical rubric (`global/prompts/iac-review/terraform.md`) + the line-numbered file context.
5. Parses each agent's JSON findings, dedups across agents (cross-validation), applies `--min-severity`.
6. Prints the report (and `--pr` posts it). Exits non-zero (2) if any critical/high remain — usable as a gate.

## What it checks

Review by **failure mode** — identity churn, secret exposure, blast radius,
state safety, module contracts, testing gaps — with a version-aware guard that
suppresses advice the detected TF/OpenTofu version can't use. Full rubric:
`global/prompts/iac-review/terraform.md`.

> Rules adapted from the HashiCorp Terraform Style Guide (MPL-2.0), Anton
> Babenko's terraform-skill (Apache-2.0), and TerraShark. Research:
> `docs/specs/2026-06-24-terraform-terragrunt-review-research.md`.
