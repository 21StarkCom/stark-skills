---
name: stark-terragrunt-review
description: >-
  Multi-agent code review of Terragrunt orchestration — terragrunt.hcl, root.hcl,
  terragrunt.stack.hcl, units, includes, dependency/generate/remote_state blocks,
  the DRY values pattern, multi-account/multi-env live repos — for dependency
  correctness, state isolation, mock-output safety, and HCL pitfalls. Runs across
  one or more configurable LLMs (claude/codex/gemini), each as its own subagent,
  then merges + cross-validates findings. Use whenever the user wants to review,
  audit, or sanity-check a Terragrunt repo/catalog/live tree, or asks about
  dependency ordering / mock outputs / state keys / include hierarchy. Review-only;
  defers resource/module HCL to stark-terraform-review.
argument-hint: "[path] [--agents claude,codex,gemini] [--changed] [--no-tools] [--min-severity ...] [--pr N --repo O/R] [--dry-run] [--json]"
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-terragrunt-review

Multi-agent Terragrunt reviewer for the **orchestration layer**. Keep this skill
thin: resolve the target, then hand off to the TS dispatcher `tools/iac_review.ts`,
which runs the review across **one or more configured LLM agents** (each a
headless subagent), merges + cross-validates findings, and renders the report.
Resource/module HCL is deferred to `stark-terraform-review`.

## Configuring which LLMs run the review

Precedence: **`--agents` flag > config `iac_review.agents` > `["codex"]`**. To run
with Gemini **and** Codex:

```bash
… --agents gemini,codex
# or: { "iac_review": { "agents": ["gemini", "codex"] } } in config.json
```

(The `iac_review` config is shared with stark-terraform-review.) Each agent
reviews independently; agreed findings are marked cross-validated.

## Arguments

Raw input: `$ARGUMENTS`

- `path` — file or directory (catalog/ or live/ root). Default: repo root / cwd.
- `--agents a,b` — LLMs to run (claude|codex|gemini). Overrides config.
- `--changed` — only `.hcl` changed vs the git merge-base / working tree.
- `--no-tools` — skip host scanners.
- `--trust-source` — allow the HCL-**evaluating** Terragrunt scanners (`terragrunt hcl validate`, `find --dag`). These execute the reviewed config (Terragrunt can eval `run_cmd`), so they're **off by default** and should only be enabled for source you trust (e.g. your own repo). Untrusted/PR review: leave off.
- `--min-severity S` — `critical|high|medium|low` floor.
- `--pr N --repo O/R` — post merged findings to PR N (first agent's GitHub App).
- `--dry-run` — resolve only, dispatch nothing.
- `--json` — receipt JSON instead of the markdown report.

## Run it

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types --no-warnings "$TOOLS/iac_review.ts" \
  --kind terragrunt "${PATH_ARG:-.}" ${EXTRA_FLAGS}
```

The dispatcher:
1. Resolves the agent list (reports skipped ones).
2. Collects in-scope Terragrunt HCL (`terragrunt.hcl`, `root.hcl`, `*.stack.hcl`, `_envcommon/*.hcl`; `--changed` narrows).
3. Runs the HCL-evaluating Terragrunt scanners (`terragrunt hcl validate`, `terragrunt find --dag --dependencies`) as evidence **only with `--trust-source`** — they execute the config (Terragrunt can eval `run_cmd`), so they're off by default.
4. Dispatches every agent in parallel with the canonical rubric (`global/prompts/iac-review/terragrunt.md`) + line-numbered context.
5. Parses + dedups findings across agents, applies `--min-severity`.
6. Prints the report (and `--pr` posts it). Exits non-zero (2) on any critical/high.

## What it checks

Orchestration-layer **failure modes** — dependency/DAG (cycles, mock-output
schema), state isolation, include hierarchy, `generate`/`remote_state` blocks,
git source refspec, values/DRY pattern, stack composition. Resource/module HCL is
explicitly handed to `stark-terraform-review`. Full rubric:
`global/prompts/iac-review/terragrunt.md`.

> Rules adapted from jfr992/terragrunt-skill (Apache-2.0) and TerraShark.
> Research: `docs/specs/2026-06-24-terraform-terragrunt-review-research.md`.
