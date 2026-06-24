# Research: Building `terraform-review` + `terragrunt-review`

**Date:** 2026-06-24
**Author:** Aryeh (via Claude Code)
**Status:** Research / pre-design
**Question:** Is there an off-the-shelf skill for Terraform/Terragrunt *code review*, and how should we build our own?

---

## TL;DR

- **No single skill** does Terraform **+** Terragrunt *review* well. The good ones are
  generation/guardrail skills that happen to review as a side effect.
- The best material to mine: **Anton Babenko's `terraform-skill`** (Apache-2.0) and
  **`terrashark`** (TerraShark) for the *mechanism*, **HashiCorp's official `agent-skills`**
  (MPL-2.0) for *authoritative style/test rules*, and **`jfr992/terragrunt-skill`** (Apache-2.0)
  for the Terragrunt-specific surface.
- **Build it as 2 new review DOMAINS** in our existing `multi_review` system
  (`07-terraform`, `08-terragrunt`), **not** as bolt-on third-party skills. That fits our
  PR-review-centric architecture and "every finding posts to the PR" rule. Optionally add thin
  standalone skills for ad-hoc pre-PR review.
- **Steal the anti-rationalization test harness** (RED/GREEN/REFACTOR + rationalization-table)
  from Anton Babenko's `tests/` to validate the domain prompts. This is the single most
  transferable idea for a *reviewer* (reviewers rationalize: "syntax looks correct" → skips the
  security scan).

---

## 1. What was downloaded

Shallow-cloned to scratchpad (`tf-skills-research/`):

| Repo | Author | License | What it is |
|------|--------|---------|------------|
| `terraform-skill` | Anton Babenko | Apache-2.0 | The deepest TF skill. Failure-mode framing + `tests/` anti-rationalization harness. **Primary source.** |
| `terrashark` | Lukas Niessen | (proprietary-ish header, OSS repo) | "Stop TF hallucinations." LLM-mistake checklists in every reference. **Primary source for mechanism.** |
| `terragrunt-skill` | Juan Reyes (jfr992) | Apache-2.0 | Best Terragrunt-specific surface. **Primary source for TG.** |
| `agent-skills` | **HashiCorp (official)** | MPL-2.0 | `terraform-style-guide`, `terraform-test`, `terraform-stacks`, AVM, provider-dev. **Authoritative rules.** |
| `claude-skill-hcp-terraform` | hashi-demo-lab | MIT | style-guide / test / stacks / mcp-as-code skills (clean SKILL.md examples). |
| `devops-claude-skills` | ahmedasmar | — | `iac-terraform` marketplace skill (good combined TF+TG description). |
| `cc-devops-skills` | akin-ozer | Apache-2.0 | generator **+ validator** skill-pair pattern. |

All permissive. We're lifting *rule catalogs* (public best practices), not verbatim prose — attribute and move on.

---

## 2. The convergent pattern (every good skill does these 6 things)

This is the real finding. Independent authors arrived at the same architecture:

1. **Diagnose-before-generate / failure-mode framing.** Don't enumerate "what good looks
   like" — frame around the *failure modes* the model gets wrong. TerraShark's PHILOSOPHY.md:
   *"telling an LLM what good Terraform looks like is less effective than telling it how to
   think about Terraform problems."* The 5 canonical failure modes (shared by Babenko +
   TerraShark): **identity churn, secret exposure, blast radius, CI drift, compliance-gate gaps.**

2. **LLM-mistake checklists in every reference.** Each topic file names the *specific*
   hallucination, e.g. *"defaults to `count` for every collection," "omits `moved` blocks in
   refactors," "assumes `sensitive` alone means not-in-state."* → **This is gold for a reviewer:
   human-written IaC fails the same way model-written IaC does. The checklists are pre-tuned
   review rules.**

3. **Progressive disclosure.** Thin `SKILL.md` (~140–300 lines) + `references/*.md` loaded
   *conditionally* on detected signal (backend type, provider, keyword). Keeps per-query tokens low.

4. **Version-aware feature guards.** A feature→min-version table (`moved` 1.1, `optional()` 1.3,
   mock providers 1.7, `write_only` 1.11, S3 `use_lockfile` 1.10 / OpenTofu 1.10). **Prevents the
   reviewer from flagging code for features that don't exist in that TF version** — i.e. kills a
   whole class of false positives.

5. **Anti-rationalization TDD harness** (Babenko's `tests/`, see §4).

6. **External tool integration, not reinvention.** Recommend `terraform fmt/validate`, `tflint`,
   `trivy config` (tfsec is in maintenance mode — folded into Trivy), `checkov`, `conftest`/OPA,
   `terraform test`, `terraform-ls`. The skill is *guidance*; the tools do detection.

---

## 3. Review-rule catalogs (distilled, citable)

### 3a. Terraform — the reviewer's checklist

**Security**
- S3: public-access-block (all 4 flags), encryption (SSE-S3 or KMS+rotation), versioning, MFA-delete on prod.
- Security groups: separate `aws_vpc_security_group_{ingress,egress}_rule` resources, **not** inline `ingress`/`egress` (inline → state churn); no `0.0.0.0/0` + `-1`.
- Secrets: never in variable defaults or `.tfvars`; use secret managers or `write_only` (1.11+).
  `sensitive = true` masks *display only* — value is still in state. Never `nonsensitive()` to launder into logs.
- Run `trivy config .` and `checkov -d .` — **a review that stops at "syntax correct" is incomplete** (Babenko rationalization R3).

**Correctness / identity churn**
- `for_each` over `count` for stable identities; `count` only for 0/1 conditional. `for_each` keys must be **known at plan time** and derived from *user input*, not computed attrs (`.id`/`.arn`).
- `moved` blocks on every rename/refactor (incl. count→for_each migration) — blind text-replace = destroy/recreate.
- No blanket `ignore_changes = all` (silences drift).
- Outputs expose stable subsets, never whole provider objects.

**Module contracts** (HashiCorp official style guide)
- File layout: `terraform.tf` (versions), `providers.tf`, `main.tf`, `variables.tf` (alpha), `outputs.tf` (alpha), `locals.tf`.
- Every **variable** has `type` + `description`; every **output** has `description`.
- `lowercase_with_underscores`, descriptive nouns excluding resource type (`aws_instance.web_api`), singular not plural, `main` for the singleton.
- `required_version` + `required_providers` pinned (min **and** max major per AVM TFNFR25).
- `optional()` with typed defaults over `map(any)`.

**State**
- Remote backend with encryption + locking + versioning; S3 `use_lockfile` (1.10+) over DynamoDB.
- State split per component/environment; never share prod/non-prod.
- `terraform plan -destroy` + explicit confirm before any destroy; never `-auto-approve` on destroy.

**CI/CD**
- Pipeline: validate → test → plan → **apply the reviewed plan artifact** (don't re-plan in apply).
- Commit `.terraform.lock.hcl`; pin runtime `~> 1.x`, providers `~> N.0`; provider upgrades in their own PR.
- Mock-provider tests (1.7+) on PRs (free), real-infra tests on merge.

**Testing blind spots** (high-value, rarely caught)
- Computed values (ARNs, generated names) must be asserted in `command = apply`, not `plan`.
- Set-type nested blocks (S3 encryption `rule`, lifecycle `transition`) can't be indexed `[0]` in `plan` mode — use `for` expressions / `apply`.
- `*_unit_test.tftest.hcl` = plan mode, `*_integration_test.tftest.hcl` = apply mode (HashiCorp `terraform-test`).

> Authoritative anchor: **HashiCorp Style Guide** ships an 11-item Code Review Checklist
> (`agent-skills/.../terraform-style-guide`) — lift it verbatim as the domain's baseline.

### 3b. Terragrunt — what's UNIQUE beyond Terraform

A TG reviewer checks the *orchestration layer*; defer resource/module quality to the TF reviewer.

- **`include` blocks:** `include "root" { path = find_in_parent_folders("root.hcl") }` at the top of every unit; `expose = true` when child needs parent vars. Flag hardcoded `../../../root.hcl`.
- **`dependency` blocks:** `mock_outputs` **mandatory** for plan/validate; mock schema must match real outputs; `skip_outputs` / `enabled` used to prune; no duplicate dependency names.
- **DAG:** no circular deps (`terragrunt find --dag --dependencies` / `dag graph`); declared deps match actual output usage. Fan-out / chain / multi-dep patterns.
- **State isolation:** `key = "${path_relative_to_include()}/terraform.tfstate"` (unique per unit); per-env bucket suffix; `use_lockfile = true`; **no Terraform workspaces** — separate dirs.
- **Values pattern (DRY):** all unit inputs flow through `values.*`, optionals wrapped in `try(values.x, default)`; reference resolution (`"../acm"` → `dependency.acm.outputs...`). Flag hardcoded inputs.
- **`generate` blocks:** `if_exists = "overwrite_terragrunt"`; heredoc-in-ternary needs parens: `cond ? (<<EOF…EOF\n) : ""`.
- **Module source git syntax:** refspec **after** `//path` — `repo.git//units/acm?ref=main` (the `?ref=...//path` ordering is a real, common bug). Version from `values`, never hardcoded; SSH over HTTP.
- **`terragrunt.stack.hcl`:** `unit` blocks only (not `terraform{}`), unique `path` per unit, values flow to units.
- **Explicit stacks vs classic `_envcommon`:** recognize which pattern the repo uses; check the right include chain.
- **Filtering:** modern `--filter` over deprecated `--queue-include-dir`.

---

## 4. The anti-rationalization harness (steal this)

Babenko's `tests/` is the most novel and the most relevant to a *reviewer*. Three files = a
RED/GREEN/REFACTOR loop for the prompt itself:

- **`baseline-scenarios.md`** (RED): run the task **without** the skill, record the model's
  *rationalization* (the excuse) and the target behavior. E.g. *"Tests later" / "Terratest is the
  standard" / "syntax looks correct."*
- **`compliance-verification.md`** (GREEN): run the same scenario **with** the skill; verify the
  rationalization no longer appears; log any *new* rationalization discovered.
- **`rationalization-table.md`** (REFACTOR): a coverage matrix mapping each hallucination surface →
  baseline scenario → the exact SKILL.md/reference anchor that guards it → status (❌/◐/✅). New
  excuses get a new row, not a stretched old one.

**Why it matters for review specifically:** reviewers don't fail by being wrong, they fail by
**stopping early** ("looks fine"). The rationalization-table is a structured way to enumerate and
close every "skip" excuse. We already own the machinery to operationalize this:
`/stark-review-improvement` + `docs/calibration/` + the triage-shadow validation. This harness is
the test suite those tools should run against.

---

## 5. How to build it in stark-skills (grounded in our code)

Two paths, verified against the actual repo. **Recommendation: Path A primary, Path B optional.**

### Path A — add 2 review DOMAINS (primary)

Our `multi_review` auto-discovers domains by scanning `global/prompts/<agent>/NN-*.md`
(`dispatcher_base_lib.ts::discoverDomains`, ~L256). Triage (`global/prompts/triage/pr-review.md`)
decides per-diff relevance, so a `terraform` domain only fires when `.tf`/`.hcl` files change.
Findings post to the PR automatically. Steps:

1. **Create prompt files** for the default agents (config `agents: ["claude","codex"]`; gemini enabled too — do all 3):
   ```
   global/prompts/{claude,codex,gemini}/07-terraform.md
   global/prompts/{claude,codex,gemini}/08-terragrunt.md
   ```
   Format = our existing domain anatomy (see `claude/04-security.md`): `# Title` → scope note →
   checklists → severity guide (critical/high/medium/low). The trailing JSON output block is
   stripped + replaced by `FINDING_SCHEMA_PROMPT` at render time — copy an existing file's shape.
   Body = the §3 catalogs above.

2. **Register agents** in `global/config.json` → `domain_agents` (confirmed present, L12):
   ```json
   "terraform": "codex",
   "terragrunt": "codex"
   ```
   (Codex/gpt-5.5 is the stronger reasoner for HCL; keep parity with the other domains.)

3. **Per-repo gating:** `disabled_domains` / `extra_domains` exist in config (L23–24) — a repo with
   no IaC can disable them; triage already suppresses them on non-`.tf` diffs so this is belt-and-suspenders.

4. **Validate** with the §4 harness + run `/stark-review <PR> --domains terraform,terragrunt`.

### Path B — standalone skills (optional, ad-hoc)

For pre-PR review of a module/stack on disk, add `skill/stark-terraform-review/` and
`skill/stark-terragrunt-review/` (SKILL.md + optional `references/`). Smoke test
(`tools/skill_smoke_test.test.ts`) requires: frontmatter parses, `name:` == dir name,
`description:` present (≤200 chars), any `tools/*.ts` reference resolves + exits clean on `--help`.
`install.sh` symlinks `skill/stark-*` automatically (marketplace-managed when the cache exists).
These would be thin wrappers that point the single-agent reviewer at a path + the new domain prompts.

### Why not just install the third-party skills?

They're generation-first, AWS-centric, and live outside our findings-post-to-PR pipeline. Lifting
their *rule catalogs* into our domains gives a TF/TG-aware reviewer **inside** the system we already
run on every PR — with dedup, severity override, fix-loop, and GitHub posting for free.

---

## 6. Tooling the prompts should invoke / recommend

`terraform fmt -check` · `terraform validate` · `tflint` · `trivy config .` (tfsec EOL → Trivy) ·
`checkov -d .` · `conftest`/OPA on plan JSON · `terraform test` (1.6+) · `infracost` (drift/cost) ·
`terraform-ls` (safe rename / references, with a degradation gate). For Terragrunt:
`terragrunt find --dag --dependencies`, `terragrunt validate`, `terragrunt hcl validate`.

---

## 7. Attribution / licensing

Lifting best-practice *rules* (facts) is clean. For any near-verbatim text blocks (e.g. HashiCorp's
11-item checklist), add a one-line attribution in the prompt header:
`# Adapted from HashiCorp Terraform Style Guide (MPL-2.0) + Anton Babenko terraform-skill (Apache-2.0).`
Keep a `NOTICE`-style note in the domain prompt or `docs/` if we mirror substantial structure.

---

## 8. Proposed next step

Spin up the §4 harness first (a dozen baseline scenarios of bad `.tf`/`.hcl` a reviewer must catch),
then write `07-terraform.md` + `08-terragrunt.md` to pass them. That's a `/stark-design-to-plan`
candidate. Say the word and I'll draft the two domain prompts + the scenario set on a branch.
