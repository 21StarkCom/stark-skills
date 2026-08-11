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
argument-hint: "[path] [--agents claude,codex,gemini] [--changed] [--allow-agent-dispatch] [--include-tfvars] [--trust-source] [--no-tools] [--min-severity ...] [--pr N --repo O/R] [--dry-run] [--json]"
disable-model-invocation: true
model: opus
---

## Help

If the current request asks for help (a standalone `--help`, `-h`, or `help` token),
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

```text
Per invocation: --agents gemini,codex
Config: { "iac_review": { "agents": ["gemini", "codex"] } }
```

Each listed agent reviews independently as its own subagent; findings they agree
on are marked cross-validated.

## Arguments

Treat the text following the explicit skill mention as the arguments.

- `path` — file or directory. Default: current repo root / cwd.
- `--agents a,b` — LLMs to run (claude|codex|gemini). Overrides config.
- `--changed` — only HCL changed vs the git merge-base / working tree. Requires
  a usable git repository; omit it for a non-git directory.
- `--allow-agent-dispatch` — acknowledge sending the selected file contents to
  the named model CLIs. Pass it only after the explicit consent step below.
- `--include-tfvars` — include `.tfvars`, which are excluded by default because
  they commonly contain secrets. Pass it only when the user explicitly includes
  the previewed `.tfvars` after reviewing/redacting them.
- `--trust-source` — allow installed scanners/provider tools to inspect the
  source. Pass it only after separate execution consent.
- `--no-tools` — skip host scanners (review by reading only).
- `--min-severity S` — drop findings below S (`critical|high|medium|low`).
- `--pr N --repo O/R` — posting-only tool flags. Pass them only when the user
  explicitly asks to post the merged findings; a PR number/link alone is not
  posting consent.
- `--dry-run` — resolve agents + files, dispatch nothing.
- `--json` — print the receipt JSON instead of the markdown report.

## Run it

### Consent gate

The dispatcher embeds selected HCL contents in prompts sent to the configured
provider CLIs. `.tfvars` files may contain credentials or other sensitive
values, so they are excluded unless `--include-tfvars` is explicitly approved.
A normal “review this” request does **not** authorize sending files to additional
providers or executing repository/provider code.

1. First run a local metadata-only preview with `--dry-run --no-tools --json`.
   Show the exact file list and resolved providers. This performs static file
   discovery only; it sends no file contents to an LLM and runs no scanners.
2. Ask for explicit consent to send those files to those named providers. Only
   after consent add `--allow-agent-dispatch` to the real run.
3. If `.tfvars` are relevant, preview their exact names separately and ask the
   user to include/redact them. Add `--include-tfvars` only for that explicit
   choice; general dispatch consent is not enough.
4. Separately ask before running host scanners. `terraform`/`tofu validate` can
   load repository/provider code; absent explicit approval, keep `--no-tools`
   on the real review run. After approval, remove `--no-tools` and add
   `--trust-source`.
5. Pass `--pr/--repo` only with separate explicit posting consent.

If the user declines provider dispatch, stop after the preview or perform only
a local, host-native read-only analysis when they explicitly choose that path.

Construct the target and each option as a separate array element. The preview
block accepts only non-consent selectors (`--agents`, `--changed`,
`--min-severity`, `--timeout`); it adds its own safety flags:

```bash
set -euo pipefail
TARGET_PATH="."
REVIEW_ARGS=()
# Replace TARGET_PATH and append selectors parsed from the current request, e.g.:
# TARGET_PATH="infra/network"; REVIEW_ARGS+=(--agents "gemini,codex" --changed)
[ -e "$TARGET_PATH" ] || { echo "Review target not found: $TARGET_PATH" >&2; exit 1; }
if [ -f "tools/iac_review.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
IAC_REVIEW="${TOOLS:+$TOOLS/iac_review.ts}"
[ -f "$IAC_REVIEW" ] || { echo "iac_review.ts not found; set STARK_ASSET_ROOT or STARK_REVIEW_TOOLS" >&2; exit 1; }
PREVIEW_ARGS=(--kind terraform "$TARGET_PATH" "${REVIEW_ARGS[@]}" --dry-run --no-tools --json)
node --experimental-strip-types --no-warnings "$IAC_REVIEW" "${PREVIEW_ARGS[@]}"
```

Run this second block only after recording the user's decisions. Set the three
booleans from those decisions immediately before execution; their fail-closed
defaults make the block refuse unapproved dispatch, scanners, and `.tfvars`:

```bash
set -euo pipefail
TARGET_PATH="."
REVIEW_ARGS=()
DISPATCH_CONSENT=false
SCANNER_CONSENT=false
TFVARS_CONSENT=false
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
RUN_ARGS=(--kind terraform "$TARGET_PATH" "${REVIEW_ARGS[@]}" --allow-agent-dispatch)
if [ "$SCANNER_CONSENT" = true ]; then RUN_ARGS+=(--trust-source); else RUN_ARGS+=(--no-tools); fi
if [ "$TFVARS_CONSENT" = true ]; then RUN_ARGS+=(--include-tfvars); fi
node --experimental-strip-types --no-warnings "$IAC_REVIEW" "${RUN_ARGS[@]}"
```

The dispatcher:
1. Resolves the agent list (see above) and reports any skipped (disabled/unknown).
2. Collects the in-scope `.tf`/`.tftest.hcl` (capped; `--changed` narrows), plus
   `.tfvars` only when explicitly requested with `--include-tfvars`.
3. Runs installed scanners (`terraform fmt/validate`, `tflint`, `trivy config`,
   `checkov`) only with `--trust-source` after explicit scanner consent;
   otherwise pass `--no-tools`.
4. Dispatches every agent only with `--allow-agent-dispatch`, using the canonical
   rubric (`global/prompts/iac-review/terraform.md`) + line-numbered file context.
5. Parses each agent's JSON findings, dedups across agents (cross-validation), applies `--min-severity`.
6. Prints the report. `--pr` posts it only after explicit posting consent.
   Exits non-zero (2) if any critical/high remain — usable as a gate.

## Non-git directories

Codex may run this skill against an arbitrary directory that is not a git
checkout. Pass the explicit path, omit `--changed`, and skip git preflight; the
dispatcher can collect and review the full HCL tree directly. Do not treat the
absence of `.git` as an error or add `--pr` unless the user separately requests
posting to a named repository.

## What it checks

Review by **failure mode** — identity churn, secret exposure, blast radius,
state safety, module contracts, testing gaps — with a version-aware guard that
suppresses advice the detected TF/OpenTofu version can't use. Full rubric:
`global/prompts/iac-review/terraform.md`.

> Rules adapted from the HashiCorp Terraform Style Guide (MPL-2.0), Anton
> Babenko's terraform-skill (Apache-2.0), and TerraShark.
