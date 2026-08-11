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
argument-hint: "[path] [--agents claude,codex,gemini] [--changed] [--allow-agent-dispatch] [--trust-source] [--no-tools] [--min-severity ...] [--pr N --repo O/R] [--dry-run] [--json]"
disable-model-invocation: true
model: opus
---

## Help

If the current request asks for help (a standalone `--help`, `-h`, or `help` token),
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

```text
Per invocation: --agents gemini,codex
Config: { "iac_review": { "agents": ["gemini", "codex"] } }
```

(The `iac_review` config is shared with stark-terraform-review.) Each agent
reviews independently; agreed findings are marked cross-validated.

## Arguments

Treat the text following the explicit skill mention as the arguments.

- `path` — file or directory (catalog/ or live/ root). Default: repo root / cwd.
- `--agents a,b` — LLMs to run (claude|codex|gemini). Overrides config.
- `--changed` — only `.hcl` changed vs the git merge-base / working tree.
  Requires a usable git repository; omit it for a non-git directory.
- `--allow-agent-dispatch` — acknowledge sending the selected file contents to
  the named model CLIs. Pass it only after the explicit consent step below.
- `--no-tools` — skip host scanners.
- `--trust-source` — allow installed scanners/provider tools, including the
  HCL-**evaluating** Terragrunt scanners (`terragrunt hcl validate`,
  `find --dag`). The flag is valid only after the user explicitly consents to
  executing the reviewed configuration; “this is my repo” is not consent by
  itself. Untrusted/PR review: leave it off.
- `--min-severity S` — `critical|high|medium|low` floor.
- `--pr N --repo O/R` — posting-only tool flags. Pass them only when the user
  explicitly asks to post; a PR number/link alone is context, not consent.
- `--dry-run` — resolve only, dispatch nothing.
- `--json` — receipt JSON instead of the markdown report.

## Run it

### Consent gate

The dispatcher embeds selected HCL contents in prompts sent to configured
provider CLIs. Terragrunt trees can also contain secrets and executable
`run_cmd` expressions. A normal review request does not authorize either
external provider dispatch or execution of repository-controlled HCL.

1. First run `--dry-run --no-tools --json` and show the exact files and resolved
   providers. It performs local static discovery only.
2. Ask for explicit consent before sending those files to the named providers.
   Exclude/redact credential-bearing content unless explicitly included. Only
   after consent add `--allow-agent-dispatch` to the real run.
3. Keep `--no-tools` unless the user separately approves local scanner
   execution. If approved, remove `--no-tools` and add `--trust-source`; that
   approval must cover evaluating Terragrunt configuration and possible
   `run_cmd` calls.
4. Pass `--pr/--repo` only with separate explicit posting consent.

Construct the target and each option as a separate array element. The preview
block accepts only non-consent selectors (`--agents`, `--changed`,
`--min-severity`, `--timeout`); it adds its own safety flags:

```bash
set -euo pipefail
TARGET_PATH="."
REVIEW_ARGS=()
# Replace TARGET_PATH and append selectors parsed from the current request, e.g.:
# TARGET_PATH="live/prod"; REVIEW_ARGS+=(--agents "gemini,codex" --changed)
[ -e "$TARGET_PATH" ] || { echo "Review target not found: $TARGET_PATH" >&2; exit 1; }
if [ -f "tools/iac_review.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
IAC_REVIEW="${TOOLS:+$TOOLS/iac_review.ts}"
[ -f "$IAC_REVIEW" ] || { echo "iac_review.ts not found; set STARK_ASSET_ROOT or STARK_REVIEW_TOOLS" >&2; exit 1; }
PREVIEW_ARGS=(--kind terragrunt "$TARGET_PATH" "${REVIEW_ARGS[@]}" --dry-run --no-tools --json)
node --experimental-strip-types --no-warnings "$IAC_REVIEW" "${PREVIEW_ARGS[@]}"
```

Run this second block only after recording the user's decisions. Set the two
booleans from those decisions immediately before execution; their fail-closed
defaults refuse unapproved dispatch and scanner execution:

```bash
set -euo pipefail
TARGET_PATH="."
REVIEW_ARGS=()
DISPATCH_CONSENT=false
SCANNER_CONSENT=false
# Replace TARGET_PATH/REVIEW_ARGS from the request and set a consent boolean to
# true only for the corresponding explicit approval.
[ -e "$TARGET_PATH" ] || { echo "Review target not found: $TARGET_PATH" >&2; exit 1; }
[ "$DISPATCH_CONSENT" = true ] || { echo "Model dispatch was not approved" >&2; exit 1; }
if [ -f "tools/iac_review.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
IAC_REVIEW="${TOOLS:+$TOOLS/iac_review.ts}"
[ -f "$IAC_REVIEW" ] || { echo "iac_review.ts not found; set STARK_ASSET_ROOT or STARK_REVIEW_TOOLS" >&2; exit 1; }
RUN_ARGS=(--kind terragrunt "$TARGET_PATH" "${REVIEW_ARGS[@]}" --allow-agent-dispatch)
if [ "$SCANNER_CONSENT" = true ]; then RUN_ARGS+=(--trust-source); else RUN_ARGS+=(--no-tools); fi
node --experimental-strip-types --no-warnings "$IAC_REVIEW" "${RUN_ARGS[@]}"
```

The dispatcher:
1. Resolves the agent list (reports skipped ones).
2. Collects in-scope Terragrunt HCL (`terragrunt.hcl`, `root.hcl`, `*.stack.hcl`, `_envcommon/*.hcl`; `--changed` narrows).
3. Runs HCL-evaluating Terragrunt scanners only with both explicit consent and
   `--trust-source`; otherwise scanner execution remains disabled.
4. Dispatches every agent only with `--allow-agent-dispatch`, using the
   canonical rubric (`global/prompts/iac-review/terragrunt.md`) + line-numbered
   context.
5. Parses + dedups findings across agents, applies `--min-severity`.
6. Prints the report. `--pr` posts only after explicit consent. Exits non-zero
   (2) on any critical/high.

## Non-git directories

This skill supports a plain Terragrunt directory in Codex without a git
checkout. Pass the explicit path, omit `--changed`, and skip git preflight; the
dispatcher scans the full matching HCL tree. Do not add `--pr` unless the user
separately requests posting to a named repository.

## What it checks

Orchestration-layer **failure modes** — dependency/DAG (cycles, mock-output
schema), state isolation, include hierarchy, `generate`/`remote_state` blocks,
git source refspec, values/DRY pattern, stack composition. Resource/module HCL is
explicitly handed to `stark-terraform-review`. Full rubric:
`global/prompts/iac-review/terragrunt.md`.

> Rules adapted from jfr992/terragrunt-skill (Apache-2.0) and TerraShark.
