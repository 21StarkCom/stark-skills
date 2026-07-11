---
name: stark-ssot
description: >-
  Use when consolidating or reviewing a single source of truth — duplicated
  logic, a constant/model-id/URL/timeout copied into a second place, a parser or
  regex reimplemented, a local policy branch that belongs in a registry, a
  fallback default wired at a call site, or a value re-derived in the UI. Also on
  requests to centralize, deduplicate, unify, or "why is this implemented
  manually / in two places". Symptoms in a diff: a hardcoded model id or GCP
  project, `~/.claude/code-review/...` typed out, a hand-rolled token→USD cost, a
  re-pasted dispatch/env helper, a duplicated `>=`/threshold check. Do NOT use
  for code that only looks similar but answers a different question.
argument-hint: "[file-or-area to consolidate or review]"
disable-model-invocation: false
model: opus[1m]
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-ssot — one owner per responsibility

> **Skill vs. review domain.** SSOT is *also* an automated detection lens: the
> `ssot` domain fires on every `/stark-review` (code), `/stark-review-spec`, and
> `/stark-review-plan` run and posts findings to the PR. That domain *detects*
> duplicate sources of truth; **this skill is the consolidation workflow** — the
> actual "give it one owner and route the copies through it" refactor. Use the
> skill to fix what review (or you) found.

## Overview

Duplication doesn't hurt the day you write it. It hurts the day one copy
changes and the other doesn't. A model id hardcoded in a tool works until the
config bumps the model and this one call still talks to the old one. A `>= 50`
copied into the UI works until marketing moves it to 75 and the banner now
promises free shipping checkout won't honor. Two sources of truth is not a
style problem — it's a **latent production bug with a delay fuse**.

**Core principle: one responsibility has exactly one owner.** If a value,
decision, calculation, route, permission, timeout, cost, model choice, parser
rule, or state transition already has an owner, **call the owner**. Don't copy
the rule, don't re-derive it, don't wrap it in a local default.

**Honoring the letter but not the spirit still fails:** importing the owner and
then adding a "just this once" local branch that overrides it is the same drift,
one indirection later.

## The one test that catches most duplication

Point at the value or decision and ask: **if this rule changed tomorrow, how
many files would I have to edit — and would a reviewer catch it if I missed
one?**

- More than one file → you have parallel sources of truth. Give it an owner and
  import it.
- Exactly one, and it's a shared module → correct; leave it.
- More than one **but the two answer different questions** (different contract,
  data shape, lifecycle, or product context) → *not* duplication. Same shape ≠
  same responsibility. Keep them separate and say why (below).

## Find THIS repo's owners first

The owner is a repo-local fact — don't assume it, discover it. Before you copy a
value or a rule, spend two minutes learning where the target repo already keeps
its single sources of truth, then route through those. Look for:

- **Config / constants:** a config package or loader, a `constants`/`const`
  block, `locals`/`variables` in Terraform, an env-var schema, a settings module.
- **Registries / routing:** a provider map, a model/agent/tool registry, a
  handler or route table, a plugin/connector index.
- **Domain / calculation modules:** the package that owns a business rule
  (pricing, quotas, permissions, state machines) rather than each caller.
- **Type definitions:** a shared enum / union / `const` object the value should
  come from instead of a magic string.

Quick discovery moves: grep the exact literal you're about to write (a model id,
project id, threshold, URL) — if it already appears in a `config`/`registry`/
`locals`/`const` file, that file is the owner, import from it. Grep the codebase
for the *concept name* (`timeout`, `model`, `project`, `threshold`) to find the
canonical key. Read the repo's `CLAUDE.md`/`AGENTS.md` — fleets often name their
owners and their "never hardcode X" rules there. Only if no owner exists do you
create the smallest one at the natural module boundary (workflow step 2).

**Worked example — what that discovery yields in `stark-skills`.** This repo has
already centralized the things people reflexively hardcode; in another repo the
*shape* is the same but the names differ — find the local equivalents.

| You're about to hardcode… | The owner this repo exposes | The general pattern |
|---|---|---|
| a **model id** (`claude-opus-4-8`, `gpt-5.6-sol`…) | `stark_config_lib.getModelId()` / `isAgentEnabled()` | model choice → a config/registry, never a literal in a tool |
| a **GCP project / region / location** | `vertex_config_lib.resolveVertexProject()` / `resolveVertexLocation()` | environment identity → runtime resolver, never committed in source |
| a machine-specific **path** (`~/.claude/code-review/{tools,prompts}`) | `asset_root_lib.assetRoot()/assetPromptsDir()/stateRoot()` | path roots → one resolver seam, so relocation/packaging doesn't break |
| a **credential/App id / key location** | the `APPS` map in `github_app_lib.ts` | auth identity → one map; callers mint through it |
| a **cost / unit-conversion** calc | `cost_lib.computeDispatchCost()` | shared math → one function so every caller agrees |
| a **resource path with precedence** (DB, cache) | `red_team_db_resolver` (`--db > env > config > default`) | resolution order → one resolver, not re-implemented per caller |
| a **dispatch/env helper** (`run`, `buildAgentEnv`, gemini-home, parsers) | import from `copilot_dispatch.ts` (`plan_dispatch`/`iac_review` already do) | shared plumbing → export once, import; don't re-paste |
| a **policy/config field** that must stay authoritative | `stark_config_lib.getRedTeamConfig()` locked fields | protected policy → owner rejects overrides by design |

The right-hand *pattern* is what travels; the middle column is just this repo's
instance of it. In a Terraform repo the "owner" is a `locals` block or a shared
module output; in a Go service it's a `config` struct or a registry package —
same principle, find the local name.

## When NOT to unify

Reaching for a shared owner where there isn't one shared responsibility is its
own harm — it couples code that must be free to diverge, and the next
requirement forces an ugly split. Do **not** unify:

- Code that only *looks* similar but serves different contracts, data shapes,
  lifecycle boundaries, or product contexts. `validateProductName` (catalog:
  1–100 chars) and `validateChatMessage` (chat: 1–100 chars) share a *shape*,
  not an owner — product names may grow to 200, chat may add emoji rules.
  Merging them couples two unrelated rules.
- Presentation-only copy, one-off test fixtures, generated snapshots, examples —
  anywhere drift **cannot** reach production behavior. A fixture that duplicates
  a literal for readability is fine.
- Greenfield code before a repeated responsibility or a natural owner exists.
  Don't pre-abstract a single use.

If you decide *not* to unify, **say so and say how drift is prevented** — that
sentence is the deliverable, not silence.

## Relationship to debugging

If you hit this duplication while chasing a concrete failure, prove the
mechanism first with `superpowers:systematic-debugging` — don't consolidate on a
hunch. Once the proven cause **is** scattered truth, use this skill to give it
one owner, then go back and verify the fix against the original symptom. Keep
that failing case as a regression test at the call site.

## Workflow

1. **Scan for duplicate responsibility before editing.** Grep for the same
   constant, enum, route, model id, timeout, regex, calculation, parser, state
   transition, or decision phrase. Read both the producer and the consumer path.
   Classify the match: exact / semantic / only superficial.
2. **Find the owner — existing before new** (see "Find THIS repo's owners
   first"). Prefer a registry, config, shared service, domain util, provider
   interface, `locals`/module output, or type that already exists in *this*
   repo. Only if none fits, create the **smallest** owner at the natural module
   boundary — not a new abstraction layer.
3. **Decide whether to unify** using the one test above. Unify when both places
   answer the same question or must change together. Otherwise record why the
   duplication is intentional and drift-safe.
4. **Move the behavior to the owner.** Export a named function, typed constant,
   registry entry, or domain helper; replace the local copies with calls to it.
   Keep adapters thin — translate inputs/outputs, make **no** policy decisions.
5. **Protect the contract.** Add/extend a test at the owner level; add one
   call-site regression test if the duplication had caused a bug. Prefer typed
   unions / `const` objects over magic strings.
6. **Check for drift after the patch.** Grep again for the old literal and the
   duplicated logic; delete dead exports the consolidation orphaned; confirm the
   behavior is now driven only from the owner.

## Before → after

The first example is a `stark-skills` instance (model id + GCP project → their
resolvers); the second is domain-agnostic (a pricing threshold → one owner). The
*move* is identical — replace the literal with a call to the owner.

```ts
// ❌ Two sources of truth: the model id and the GCP project are hardcoded here,
//    so a config bump or a project change silently skips this call site.
const MODEL = "claude-opus-4-8";
const env = { GOOGLE_CLOUD_PROJECT: "infra-ai-platform", ...base };
const res = await run(claudeCmd(MODEL), env);

// ✅ Both routed through their owners — one place decides, every call follows.
const model = getModelId("claude");                 // stark_config_lib owns it
const project = resolveVertexProject();             // vertex_config_lib owns it (runtime-resolved)
const env = buildAgentEnv({ project, ...base });    // copilot_dispatch owns the env shape
const res = await run(claudeCmd(model), env);
```

```js
// ❌ One policy, two owners. Move the threshold and the banner lies.
if (cart.total >= 50) order.shipping = 0;            // checkout.js
const remaining = 50 - cartTotal;                    // CartBanner.jsx

// ✅ Policy has one owner; the UI adapts the value but does not re-decide it.
export const FREE_SHIPPING_THRESHOLD = 75;                                   // pricing.js
export const qualifiesForFreeShipping = (t) => t >= FREE_SHIPPING_THRESHOLD;
if (qualifiesForFreeShipping(cart.total)) order.shipping = 0;                 // checkout.js
const remaining = Math.max(0, FREE_SHIPPING_THRESHOLD - cartTotal);          // CartBanner.jsx
```

## Anti-pattern quick reference

| Smell in the diff | Why it's bad | Fix (owner in this repo) |
|---|---|---|
| hardcoded model id / GCP project / API URL / timeout in a tool | drifts from config the day it changes | call the repo's config/env resolver (`stark_config_lib` / `vertex_config_lib`) |
| a machine-specific path typed out (`~/.claude/code-review/{tools,prompts}`) | breaks when relocated/packaged | route through the path resolver (`asset_root_lib`) |
| a credential / App id / key literal | second source vs the auth map | mint through the auth owner (the `APPS` map / `github_app_lib`) |
| a hand-rolled cost / unit conversion | callers disagree as rates change | one shared function (`cost_lib.computeDispatchCost`) |
| re-pasted plumbing helper (`run`/`buildAgentEnv`/env setup) | copies drift silently | import the shared helper (`copilot_dispatch`) |
| the same calculation in UI and server | one moves, the other lies | one owner; UI formats, doesn't re-derive |
| "just this one" local branch for behavior owned elsewhere | how a registry rots | put the decision in the provider/router |
| a parser/regex copied into a second component | two copies diverge silently | export one shared parser |
| a fallback default wired at the call site | a second source of truth for that default | centralize the default in the owner |
| a new helper duplicating an existing one under a different name | two owners for one job | reuse the existing helper |

## Acceptable local logic

Local code is allowed to: validate its own inputs before calling the owner;
adapt transport/view shapes to domain shapes; do presentation-only formatting;
and hold test fixtures that intentionally duplicate a value for readability
**when drift cannot reach production**. None of these make a policy decision.

## Reviewing someone else's diff

Flag the change if **any** is true:

- a value with an owner (model id, project, cost, route, threshold, App id) is
  hardcoded instead of imported
- the same calculation or policy appears in two files that must change together
- a "just this one" local branch overrides a registry/provider decision
- a parser/regex/helper is copied rather than shared
- a fallback default sits at a call site instead of the owner
- a UI re-derives a business rule instead of formatting the owner's value

Post the finding on the PR (inline where anchored) — don't fold it into a vague
recap. If a duplication is deliberate, the diff should already say why and how
drift is prevented; if it doesn't, that's the finding.

## Final answer shape

When this skill shaped the work, close with:

- **`SSOT:`** what became or stayed the single source of truth (name the owner).
- **`Consolidated:`** which duplicate paths were removed or routed through it.
- **`Verification:`** the grep/tests proving no obvious duplicate source remains.

## Red flags — stop and fix

- "I'll just hardcode the timeout / URL / model id here too" → it has an owner; import it.
- "I'll copy this regex/parser into the new component" → export it from one place.
- "These two blocks look the same, I'll merge them" → same *shape* isn't same *responsibility*; merge only if they must change together.
- "I'll add one local branch just for this case" → that's how a registry rots; put it in the owner.
- "Quicker to recompute it in the UI" → the UI may format the value, never re-derive the rule.
- "I'll wrap the call site with a fallback default" → that's a second source of truth for the default; centralize it.
