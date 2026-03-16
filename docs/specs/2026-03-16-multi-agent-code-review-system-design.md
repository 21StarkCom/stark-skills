# Multi-Agent Code Review System — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Author:** Aryeh Stark + Claude

## Overview

A portable, hierarchical multi-agent code review system that dispatches 3 AI agents (Claude, Codex, Gemini) across N domain specializations as parallel sub-agent reviews against any GitHub PR. Configuration and prompts merge from 3 levels — global, org, repo — following the same pattern as CLAUDE.md. Includes automated review outcome tracking, PR audit metrics, and a manual prompt improvement skill.

### Goals

1. **Portable across repos** — works out of the box on any repo with GitHub App access, zero config required
2. **Customizable per repo** — repos override only what's different (severity, domains, agents, commands)
3. **Self-improving** — accumulated review history feeds a skill that proposes prompt improvements at the right scope level

### Design Principles

- CLAUDE.md merge pattern — same mental model developers already use
- Zero config for new repos — works immediately with global defaults
- Override only what's different — repos don't copy the full config, just their deltas
- Prompts are the product — the improvement skill tunes prompts, not orchestrator code
- Human decides scope — the improvement skill proposes, you approve where changes land
- Audit trail on GitHub — PR comments are the permanent record, no external systems

---

## Architecture

```
multi_review.py (orchestrator — ThreadPoolExecutor, 3N workers)
│
├── claude × N domains  → stark-claude bot posts consolidated review
├── codex  × N domains  → stark-codex bot posts consolidated review
└── gemini × N domains  → stark-gemini bot posts consolidated review
```

Every agent reviews every domain independently. 3 perspectives per domain — findings flagged by 2+ agents are high confidence.

### GitHub Apps

| Bot | GitHub App | App ID | Keychain Service |
|-----|-----------|--------|-----------------|
| stark-claude | Stark Claude | 3066738 | `STARK_CLAUDE_PRIVATE_KEY` |
| stark-codex | Stark Codex | 3066834 | `STARK_CODEX_PRIVATE_KEY` |
| stark-gemini | Stark Gemini | 3066689 | `STARK_GEMINI_PRIVATE_KEY` |

Auth via `github_app.py --app <name> token`. Per-app token caching at `~/.cache/github-app-tokens/` with 1hr TTL. Private keys stored in macOS Keychain as base64-encoded PEM.

---

## Directory Layout

### Global (source of truth)

```
~/.claude/code-review/
├── config.json                            ← global defaults
├── orchestrator.md                        ← instructions for Claude Code fix-review loop
├── scripts/
│   ├── multi_review.py                    ← orchestrator engine
│   └── github_app.py                      ← multi-app GitHub auth
├── prompts/
│   ├── claude/
│   │   ├── agent.md                       ← agent preamble (identity, invocation, strengths)
│   │   ├── 01-architecture.md
│   │   ├── 02-accessibility.md
│   │   ├── 03-correctness.md
│   │   ├── 04-type-safety.md
│   │   ├── 05-security.md
│   │   └── 06-test-coverage.md
│   ├── codex/
│   │   └── (same structure, terse prompts)
│   └── gemini/
│       └── (same structure, explicit tool-use instructions)
├── history/                               ← local review outcome data (ephemeral)
│   └── 2026-03-16-design-system-core-pr10.json
└── improvement-log.json                   ← log of prompt changes made by improvement skill
```

### Org level (optional)

```
~/git/Evinced/
└── .code-review/
    ├── config.json                        ← org overrides
    └── prompts/                           ← org prompt overrides (optional)
        └── claude/
            └── 02-accessibility.md        ← stricter a11y for Evinced
```

### Repo level (optional)

```
~/git/Evinced/design-system-core/
└── .code-review/
    ├── config.json                        ← repo overrides
    ├── prompts/                           ← per-agent prompt overrides
    │   └── codex/
    │       └── 04-type-safety.md          ← repo-specific type concerns
    └── domains/                           ← shared extra domains (all agents use)
        └── 07-token-integrity.md
```

### Per-agent prompt differences

Each LLM responds differently to the same instructions:

| Agent | Prompt Style | Key Differences |
|-------|-------------|-----------------|
| Claude | Narrative, contextual | "Think systemically", reads files via tool use, long-context comprehension |
| Codex | Terse, list-based | Gets diff via `--base` flag, prompt is a CLI argument, shorter = better |
| Gemini | Explicit, instructional | Must be told to "run `git diff`", needs firm "NO markdown fences" for JSON output |

---

## Config System

### Global config (all fields, all defaults)

```jsonc
// ~/.claude/code-review/config.json
{
  "agents": ["claude", "codex", "gemini"],
  "fix_threshold": "medium",
  "test_command": null,
  "build_command": null,
  "verify_before_clean": true,
  "disabled_domains": [],
  "extra_domains": [],
  "severity_overrides": {},
  "github_apps": {
    "claude": "stark-claude",
    "codex": "stark-codex",
    "gemini": "stark-gemini"
  }
}
```

### Org config (overrides only)

```jsonc
// ~/git/Evinced/.code-review/config.json
{
  "severity_overrides": {
    "accessibility": { "min_severity": "critical" }
  },
  "test_command": "pnpm test"
}
```

### Repo config (overrides only)

```jsonc
// ~/git/Evinced/design-system-core/.code-review/config.json
{
  "extra_domains": ["token-integrity"],
  "test_command": "pnpm test",
  "build_command": "pnpm tokens:build && pnpm build"
}
```

### Merge rules

| Field | Merge behavior | Notes |
|-------|---------------|-------|
| `agents` | Replace (most specific wins) | Repo sets `["claude", "codex"]` → gemini skipped |
| `disabled_domains` | Replace | Repo sets `["test-coverage"]` → skipped |
| `extra_domains` | Additive across all levels | Org adds `db-safety`, repo adds `token-integrity` |
| `severity_overrides` | Deep merge (repo > org > global) | Repo can override org can override global |
| `test_command` | Replace (most specific wins) | Org sets `pnpm test`, repo can override |
| `build_command` | Replace | Same pattern |
| `fix_threshold` | Replace | Global=medium, repo could set to high |
| `verify_before_clean` | Replace | Default true — see Verification Gate section |
| `github_apps` | Deep merge | Repo could remap agents to different bots |

### Prompt resolution order

For `codex × 03-correctness`:

```
1. repo:   .code-review/prompts/codex/03-correctness.md
2. org:    .code-review/prompts/codex/03-correctness.md
3. global: ~/.claude/code-review/prompts/codex/03-correctness.md
```

First match wins. Same for `agent.md` preambles.

For extra domains (e.g., `07-token-integrity`):

```
1. repo:   .code-review/prompts/codex/07-token-integrity.md   ← agent-specific
2. repo:   .code-review/domains/07-token-integrity.md          ← shared fallback
3. org:    (same pattern)
4. global: (same pattern)
```

### Onboarding a new repo

**Zero config (review-only):** Repo has GitHub App access → `multi_review.py --pr N` runs reviews and posts findings. The fix loop does **not** run without at least `test_command` configured — the orchestrator posts findings but does not edit code. This is review-only mode.

**With customization:**
```bash
mkdir .code-review
echo '{"test_command": "npm test", "disabled_domains": ["accessibility"]}' > .code-review/config.json
```

Everything else inherits.

---

## Domains

### Default domains (global)

| # | Domain | What it covers |
|---|--------|---------------|
| 01 | Architecture | Component API, module structure, patterns, dependencies |
| 02 | Accessibility | WCAG 2.1 AA, semantic HTML, ARIA, keyboard, contrast |
| 03 | Correctness | Runtime errors, logic bugs, CSS inheritance, DOM issues |
| 04 | Type Safety | TypeScript types, polymorphic components, API surface |
| 05 | Security | XSS, input validation, error handling, dependency safety |
| 06 | Test Coverage | Missing tests, edge cases, a11y assertions, test quality |

### Adding a domain

Add a numbered markdown file to each agent's prompts directory (e.g., `07-performance.md`). The script auto-discovers `[0-9]*.md` files at startup.

For repo-specific domains, use `extra_domains` in config + place the prompt file in `.code-review/domains/` (shared across agents) or `.code-review/prompts/{agent}/` (per-agent version).

---

## Finding Format

All sub-agents output structured JSON:

```json
[
  {
    "severity": "critical|high|medium|low",
    "file": "path/to/file",
    "line": 42,
    "title": "Short descriptive title",
    "description": "What is wrong and why it matters",
    "suggestion": "Specific fix or approach"
  }
]
```

### Fix threshold

The orchestrator fixes findings at or above the `fix_threshold` severity. Default: `medium` (fixes critical + high + medium, skips low).

---

## Review History & Audit Metrics

### History storage (dual-write)

Review history is written to two locations **after every round** (not just the final round):

1. **Local working copy** (`~/.claude/code-review/history/`) — fast reads for the improvement skill. Can be cleared without data loss.
2. **PR audit comment with embedded JSON** — the permanent machine-readable record. The orchestrator **creates** the comment after round 1, then **updates the same comment in-place** (PATCH, not new comment) after each subsequent round. This ensures intermediate round data survives even if the operator's machine dies mid-review.

The audit comment contains both a human-readable summary table (updated each round) and a `<details>` block with the full history JSON.

The improvement skill reads local history first. If local history is missing or stale, it reconstructs from PR comments via GitHub API:

```bash
# Extract machine-readable history from PR audit comments
gh api repos/{repo}/issues/{pr}/comments \
  --jq '.[] | select(.body | contains("<!-- review-history-json")) | .body' \
  | sed -n '/<!-- review-history-json/,/-->/p' | sed '1d;$d' | jq .
```

This means switching machines, clearing caches, or onboarding a new operator does not lose history. Even interrupted multi-round reviews are recoverable — the PR comment always has the latest completed round.

Written automatically after each review round to `~/.claude/code-review/history/`.

```jsonc
{
  "schema_version": 1,
  "repo": "GetEvinced/design-system-core",
  "pr": 10,
  "branch": "feat/task-09-typography-component",
  "date": "2026-03-16",
  "total_rounds": 2,
  "duration_s": 272,
  "config_sources": [
    "~/.claude/code-review/config.json",
    "~/git/Evinced/.code-review/config.json",
    "~/git/Evinced/design-system-core/.code-review/config.json"
  ],
  "rounds": [
    {
      "round": 1,
      "coverage": { "success": 16, "failed": 2, "total": 18 },
      "raw_results": [
        {
          "agent": "claude",
          "domain": "accessibility",
          "status": "success",
          "findings": [
            {
              "id": "r1-claude-a11y-1",
              "severity": "high",
              "title": "label variant defaults to span",
              "file": "Typography.tsx",
              "line": 16,
              "description": "...",
              "suggestion": "..."
            }
          ],
          "duration_s": 45
        }
      ]
    },
    {
      "round": 2,
      "coverage": { "success": 18, "failed": 0, "total": 18 },
      "raw_results": [/* same structure as round 1 */]
    }
  ],
  "canonical_findings": [
    {
      "canonical_id": "c1",
      "canonical_key": "label variant defaults to span|typography.tsx|1|a3f8b2c1",
      "severity": "high",
      "agents": ["claude", "gemini"],
      "domains": ["accessibility", "correctness"],
      "raw_finding_ids": ["r1-claude-a11y-1", "r1-gemini-corr-2"],
      "outcome": "fixed"
    }
  ],
  "outcomes": {
    "c1": "fixed",
    "c2": "fixed",
    "c3": "disappeared_no_fix"
  }
}
```

### Outcome classification (automatic)

| Outcome | Detection | Meaning |
|---------|----------|---------|
| `fixed` | Gone in next round, orchestrator edited that file | Real issue, prompt worked |
| `persisted` | Still present after fix attempt | Hard to fix, vague prompt, or wrong fix |
| `disappeared_no_fix` | Gone in next round, file wasn't touched | Noise — agent hallucinated |
| `downgraded` | Survived but below fix threshold | Severity doesn't match practical priority |
| `skipped_low` | Low severity, never acted on | Expected behavior |

### PR audit comment (permanent record)

**Upserted after every round, not just at the end.** The orchestrator creates the audit comment after round 1 and updates the same comment in-place (PATCH, not new comment) after each subsequent round. This ensures intermediate round data is durable even if the operator's machine dies mid-review.

The comment is posted by stark-claude.

**Audit comment discovery (for upsert):** Before creating a new comment, the orchestrator scans existing PR comments for the marker `<!-- review-history-json` posted by the stark-claude app. If found, it PATCHes that comment. If not found, it creates a new one. The local comment ID is cached as an optimization but is not required — discovery always works from the API. This prevents duplicate audit comments when switching machines or resuming a crashed session.

The embedded JSON in the `<details>` block contains the full history up to the current round.

```markdown
## 📊 Code Review Audit — PR #10

| Metric | Value |
|--------|-------|
| Rounds to clean | 2 |
| Total findings (round 1) | 14 |
| Fixed | 12 (3 critical, 4 high, 5 medium) |
| Skipped (low) | 1 |
| False positives | 1 |
| Cross-agent agreement | 8/14 (57%) |
| Total duration | 4m 32s |

### Agent Performance
| Agent | Findings | Real Issues | Noise | Unique Finds |
|-------|----------|-------------|-------|--------------|
| claude | 6 | 5 | 1 | 2 |
| codex | 5 | 5 | 0 | 1 |
| gemini | 3 | 2 | 1 | 0 |

### Domain Coverage
| Domain | Findings | Fixed | Noise |
|--------|----------|-------|-------|
| architecture | 2 | 2 | 0 |
| accessibility | 3 | 3 | 0 |
| correctness | 4 | 3 | 1 |
| type-safety | 3 | 3 | 0 |
| security | 1 | 0 | 1 |
| test-coverage | 1 | 1 | 0 |
```

**"Unique Finds"** = findings only one agent caught that turned out real. Key metric for justifying the multi-agent approach.

**Embedded machine-readable history** (appended to audit comment, hidden by default):

```markdown
<details>
<summary>Machine-readable review data</summary>

<!-- review-history-json
{ full history JSON object — same schema as local history files }
-->

</details>
```

This makes the PR comment both human-readable (tables) and machine-readable (JSON). The improvement skill can reconstruct local history from any machine by scraping these comments.

### KPI querying

Data is queryable from PR comments via GitHub API. No separate dashboard needed initially:

```bash
gh api repos/GetEvinced/design-system-core/pulls --paginate \
  --jq '.[].number' | xargs -I{} \
  gh api repos/GetEvinced/design-system-core/issues/{}/comments \
  --jq '.[] | select(.body | startswith("## 📊 Code Review Audit"))'
```

---

## Prompt Improvement Skill

### Invocation

```
/improve-review-prompts                    ← analyze all history
/improve-review-prompts --repo             ← scope to current repo
/improve-review-prompts --agent gemini     ← focus on one agent
/improve-review-prompts --domain security  ← focus on one domain
```

Trigger: Manual. Run when reviews feel noisy, miss things, or enough history has accumulated.

### Data aggregation

Reads `~/.claude/code-review/history/`, computes per-agent and per-domain statistics:

- **Noise rate** per agent × domain (% of `disappeared_no_fix` findings)
- **Unique real finds** per agent (things only that agent caught, confirmed real)
- **Severity drift** per domain (how often findings are treated at a different severity than labeled)
- **Cross-agent agreement rate** per domain
- **Average rounds to clean** per repo
- **Common noise patterns** (recurring false positive descriptions)

### Pattern detection thresholds

| Signal | Threshold | Proposal type |
|--------|-----------|--------------|
| Agent × domain noise rate > 25% | 5+ reviews | Tighten that agent's domain prompt |
| Domain has 0 findings across 10+ reviews | Consistent zero | Suggest disabling or flag for review |
| Severity drift > 30% for a domain | Consistent mismatch | Recalibrate severity guide in prompt |
| Single agent consistently finds real unique issues | 5+ unique confirmed | Highlight as valuable — don't weaken |
| Round count > 3 for a repo | 3+ occurrences | Severity too aggressive or prompts too vague |
| Cross-agent agreement < 30% for a domain | Low consensus | Domain prompt is ambiguous |
| `persisted` findings > 20% for a domain | Fix attempts fail | Prompt describes issues but not clearly enough |

### Proposal format

Each proposal includes:
- **Evidence** — specific numbers and patterns from history
- **Proposed edit** — exact diff to the prompt or config file
- **Recommended scope** — global, org, or repo (with reasoning)
- **Alternatives** — you can change the scope or skip

Example:

```
### 1. 🔴 Tighten gemini × correctness (noise rate: 33%)

Evidence: 6 of 18 Gemini correctness findings were noise across 12 reviews.
Common false pattern: flags CSS inheritance as broken when the component
doesn't explicitly set a color property.

Proposed edit to: gemini/03-correctness.md
  Add: "Only flag CSS inheritance as broken if the component explicitly
  sets a color, font, or spacing property that overrides the parent."

Recommended scope: Global
Alternatives: Org | Repo | Skip
```

You approve each individually, change scope, or skip. Nothing writes without explicit approval.

### Validation (optional)

After applying a change, the skill offers to dry-run the updated prompt against recent PRs:

```
PR #10 — gemini × correctness
  Old prompt: 4 findings (2 real, 2 noise)
  New prompt: 2 findings (2 real, 0 noise)
  ✅ Noise eliminated, no real findings lost
```

### Safety rails

- **Never auto-applies.** Every change needs explicit approval + scope decision.
- **Tracks changes.** Applied proposals logged to `~/.claude/code-review/improvement-log.json` with date, evidence, what changed, what scope.
- **Scope recommendation is a suggestion.** You can always promote or demote.
- **Staleness warning.** History data older than 30 days triggers a warning.

---

## Fix-Review Loop (Orchestrator Workflow)

```
Every round:
  1. Run 3×N sub-agents (in worktree)
  2. Write local history + upsert PR audit comment (after EVERY round)
  3. Check coverage gates (aggregate + per-domain)
  4. If actionable findings: fix → verify → commit → next round
  5. If 0 critical + 0 high + 0 medium + verification passes:
     → mark audit comment as final/clean
     → push fixes to PR branch (same-repo only)
     → cleanup worktree
```

**Persistence is per-round, not end-of-run.** Local history and the PR audit comment are updated after every completed round. The final round only changes the audit comment status to `clean`. This ensures crash recovery — any completed round's data is durable.

Only the orchestrating agent (Claude Code) fixes code. The sub-agents only review.

---

## Migration from Current System

### What moves

| Current location | New location |
|-----------------|-------------|
| `~/git/Personal/Prompts/CodeReviews/scripts/multi_review.py` | `~/.claude/code-review/scripts/multi_review.py` |
| `~/git/Personal/Prompts/CodeReviews/scripts/github_app.py` | `~/.claude/code-review/scripts/github_app.py` |
| `~/git/Personal/Prompts/CodeReviews/{claude,codex,gemini}/` | `~/.claude/code-review/prompts/{claude,codex,gemini}/` |
| `~/git/Personal/Prompts/CodeReviews/orchestrator.md` | `~/.claude/code-review/orchestrator.md` |
| `~/git/Evinced/scripts/multi_review.py` | Deleted (was a deployed copy) |
| `~/git/Evinced/scripts/github_app.py` | Remains (used by other tools), but code-review uses its own copy |

**Single runtime location:** `~/.claude/code-review/scripts/` is the only location `multi_review.py` runs from. It bundles its own `github_app.py` so it works on a fresh machine without any repo cloned. The copy at `~/git/Evinced/scripts/github_app.py` continues to exist for other tools (stark_claude.py, etc.) but is not imported by the review system.

### What's new

- `~/.claude/code-review/config.json` — global config (doesn't exist yet)
- `~/git/Evinced/.code-review/config.json` — org config (doesn't exist yet)
- Config merge logic in `multi_review.py`
- Prompt hierarchy resolution in `multi_review.py`
- History file writing after each review round
- PR audit comment upserted after each round
- `/improve-review-prompts` skill

### Hardcoded paths removed

- `PROMPTS_DIR` — now resolved from `~/.claude/code-review/` + hierarchy walk
- `SCRIPTS_DIR` — now `~/.claude/code-review/scripts/`
- `PYTHON` — uses `github_app.py` bundled in the same scripts directory

---

## Sub-Agent Invocation

Each agent has a different CLI interface. The orchestrator builds a prompt from `agent.md` preamble + domain prompt, then invokes the agent's CLI tool.

### Diff base resolution (critical)

The orchestrator resolves the exact diff scope **once** before dispatching any sub-agents, using GitHub PR metadata — not branch name heuristics. All review work happens in an isolated temporary worktree to avoid disturbing the operator's checkout.

```
1. Fetch PR metadata: gh api repos/{repo}/pulls/{number}
2. Extract base.ref, head.sha, head.ref, and head.repo.full_name
3. Determine if writable:
   - Same-repo PR (head.repo.full_name == repo): writable = true
   - Fork PR: writable = false → review-only mode (no fix loop)
4. Fetch the PR head ref:
   git fetch origin refs/pull/{number}/head
5. Create a named worktree branch for the session:
   git worktree add /tmp/review-{repo}-pr{number} -b review/pr-{number} FETCH_HEAD
6. Inside the worktree:
   git fetch origin {base.ref}
   merge_base=$(git merge-base origin/{base.ref} HEAD)
7. All agents run inside the worktree, reviewing: {merge_base}..HEAD
8. Fix loop runs inside the worktree (commits go to the review/pr-{number} branch)
9. On fix completion: push review/pr-{number} to origin/{head.ref} (same-repo only)
10. Cleanup (after entire session, not after each round):
    git worktree remove /tmp/review-{repo}-pr{number}
    git branch -D review/pr-{number}
```

**Why named branch, not detached HEAD:**
- Fix commits need a pushable ref — detached HEAD commits would be orphaned on worktree removal
- The branch name `review/pr-{number}` is deterministic, so a crashed session can be resumed by re-attaching to the existing worktree

**Fork PRs:** Forks are review-only. The orchestrator posts findings but does not enter the fix loop (can't push to a fork remote without explicit write access). The audit comment notes "Fork PR — review only, no auto-fix."

**Worktree lifecycle:** The worktree persists for the entire review session (all rounds). It is cleaned up only after the last round completes (or on explicit abort). This means fix commits, re-reviews, and verification all happen in the same worktree.

**Non-PR mode:** If `--pr` is not specified, no worktree is created. The orchestrator uses the current working directory. For uncommitted changes, agents use `--uncommitted` (Codex) or `git diff HEAD` (Claude/Gemini). `base_branch` auto-detection (`main`/`master`) applies only in this mode. Non-PR mode does not support the fix loop — it is review-only.

This ensures stacked PRs, PRs targeting `develop`/`release` branches, fork PRs, and PRs with force-pushes all review the correct change set without side effects.

### Command templates

All commands run inside the worktree (cwd = worktree path) where `HEAD` is the PR head. Agents use `{merge_base}..HEAD` — this is correct because the worktree is checked out at the PR head commit.

**Claude:**
```bash
claude -p "Run 'git diff {merge_base}..HEAD' and read all changed files. <preamble + domain prompt>" --output-format text
```
Context: Claude runs inside the worktree. `HEAD` = PR head. The merge-base SHA is injected into the prompt.

**Codex:**
```bash
codex review --base {merge_base} "<preamble + domain prompt>"
```
Context: Codex's `--base` flag takes a branch or commit to diff against. Running inside the worktree means `HEAD` = PR head, so `--base {merge_base}` produces the correct diff range. (Note: verify that `--base` accepts a raw SHA — if not, create a temporary tag/ref.)

**Gemini:**
```bash
gemini -p "Run 'git diff {merge_base}..HEAD' and read all changed files. <preamble + domain prompt>"
```
Context: Gemini runs inside the worktree. `HEAD` = PR head. The merge-base SHA is injected. Output parsing must strip markdown fences.

### JSON extraction

All agents are instructed to output only a JSON array. The orchestrator:
1. Strips markdown code fences (```` ```json ... ``` ````)
2. Finds the first `[...]` block via regex
3. Parses as JSON
4. Falls back to empty findings list on parse failure

### Timeout and error handling

| Scenario | Behavior |
|----------|----------|
| Sub-agent timeout (600s default) | Record error in `SubAgentResult`, mark as `failed`, continue |
| Sub-agent crashes | Catch exception, record error, mark as `failed`, continue |
| JSON parse failure | Mark as `failed` with warning, continue |
| GitHub App auth failure | Log warning, skip posting for that agent, continue |
| All sub-agents fail | Round completes with all errors, orchestrator reports and breaks |

Sub-agents run independently — one failure never blocks others. Partial results are valid. The audit comment notes any agent errors.

No retries. If an agent fails, its domain goes unreviewed for that round.

### Coverage threshold (prevents false clean)

A round cannot be declared clean unless it meets a minimum coverage threshold. Failed sub-agents count as **unreviewed**, not as "zero findings."

**Coverage tracking:** Each `SubAgentResult` has a `status` field: `success` or `failed`. The orchestrator computes:

```
coverage = successful_sub_agents / total_enabled_sub_agents
```

**Two coverage gates (both must pass):**

1. **Aggregate threshold:** `coverage >= 0.75` (75%) across all sub-agents
2. **Per-domain minimum:** every enabled domain must have at least 1 successful sub-agent

If either gate fails, the round is `incomplete` — the orchestrator reports failures and does not enter the fix loop or declare clean.

**Example 1 (passes both):** 18 sub-agents, 3 fail (spread across 3 domains) → aggregate 15/18 = 83% ✓, every domain has ≥ 1 success ✓ → eligible.

**Example 2 (fails per-domain):** 18 sub-agents, 3 fail — all 3 are the `security` domain reviewers → aggregate 15/18 = 83% ✓, but security has 0/3 success ✗ → incomplete. The security domain is completely unreviewed.

**Example 3 (fails aggregate):** 18 sub-agents, 6 fail → aggregate 12/18 = 67% ✗ → incomplete regardless of per-domain distribution.

The thresholds are not configurable in v1. This prevents both silent aggregate degradation and per-domain blind spots.

---

## Finding Matching Across Rounds

When comparing round N findings to round N+1 to classify outcomes, exact `file:line` matching breaks because fixes shift line numbers. The matching algorithm:

### Match strategy (ordered by priority)

1. **Title + file match** — same `title` and same `file` (ignoring line number). This catches findings that shift lines after a fix.
2. **Title fuzzy match** — same `title` in any file (handles renames/moves). Only used if no file match.
3. **Unmatched** — a round N finding with no match in round N+1.

### Outcome derivation

```
For each round N finding:
  1. Search round N+1 findings for a match (title + file, then title only)
  2. If matched → finding persisted
  3. If not matched:
     a. Check if orchestrator edited the finding's file between rounds
        (via git diff of committed changes)
     b. If file was edited → "fixed" (finding gone because fix addressed it)
     c. If file was NOT edited → "disappeared_no_fix" (noise)
```

This is a heuristic, not perfect. Edge cases (fix in file A resolves finding in file B) will occasionally misclassify. Acceptable for aggregate statistics — the improvement skill uses trends across many reviews, not individual outcomes.

---

## Fix Step

The orchestrator (Claude Code) is the only agent that fixes code. Sub-agents only review.

### Finding canonicalization (before fixing)

Before grouping findings for fixes, the orchestrator normalizes raw findings into canonical issues to prevent duplicate/conflicting fixes and inflated KPIs.

**Canonicalization algorithm:**

1. Compute a canonical key for each finding using a multi-signal fingerprint:
   ```
   canonical_key = lowercase(title) + "|" + file_path + "|" + line_bucket + "|" + desc_hash
   ```
   - `line_bucket` = `line // 10` (groups lines 1-9, 10-19, etc.)
   - `desc_hash` = first 8 chars of SHA-256 of `lowercase(description)` — distinguishes findings with the same title but different descriptions in the same file region

2. Group findings with the same canonical key across agents and domains
3. Deduplicate — keep the highest-severity instance, record which agents reported it
4. The canonical finding carries: `canonical_id`, `agents: ["claude", "gemini"]`, `domains: ["accessibility", "correctness"]`, `severity: "high"` (highest among reporters), `raw_finding_ids: [...]` (links back to raw findings)

**Why multi-signal:** `title + file` alone collapses distinct findings with generic titles ("Missing test coverage" in the same file). Adding `line_bucket + desc_hash` separates them. The `desc_hash` is a weak signal (agents describe the same issue differently) but combined with the other signals it's sufficient for dedup without over-collapsing.

Raw findings are preserved in `raw_results` in the history schema. The canonical set links to raw findings via IDs. All metrics (agreement, unique finds, noise rate) are computed from the canonical set. Fixes are applied per canonical finding.

This collapsed set is what the orchestrator fixes, what gets written to history, and what feeds the audit metrics.

### Fix flow

1. Orchestrator receives all findings from the round as structured JSON
2. Canonicalizes findings (dedup across agents/domains)
3. Groups canonical findings by file (reduces context switching)
4. For each file, reads the file and applies fixes for all actionable findings (severity >= `fix_threshold`)
5. Runs verification gate (see below)
6. Commits: `git add <files> && git commit -m "fix: address review findings (round N)"`

### Verification gate

The orchestrator must verify fixes before declaring a round clean. Controlled by `verify_before_clean` config (default: `true`).

**Verification sequence:**
1. If `build_command` is set → run it. Fix build failures before proceeding.
2. If `test_command` is set → run it. Fix test failures before proceeding.
3. If neither is set and `verify_before_clean` is `true` → **do not fix code at all**. The orchestrator runs reviews, posts findings, but operates in review-only mode. No code edits, no commits, no fix loop. It warns: "No verification commands configured. Review-only mode. Set `test_command` in .code-review/config.json to enable auto-fix."
4. If `verify_before_clean` is `false` → fix code without verification (opt-in unsafe mode).

**Zero-config repos are review-only.** The system never edits code it cannot verify. To enable the fix loop, configure at least `test_command`.

### Fix prompt (internal to orchestrator)

The orchestrator doesn't use an external prompt file for fixing — it's the main Claude Code agent in the conversation. It sees the findings JSON and the code, and applies fixes directly using its standard Edit/Write tools. The findings' `suggestion` field guides the fix approach.

### What the orchestrator does NOT do

- Does not fix `low` severity findings (unless `fix_threshold` is set to `low`)
- Does not refactor surrounding code — fixes only what was flagged
- Does not add features — corrective changes only

---

## Prompt Merge Semantics (Clarifications)

### `agent.md` preamble merge

`agent.md` follows the same "first match wins" rule as domain prompts. A repo-level `agent.md` **completely replaces** the global one. Repo overrides must be self-contained — they must include agent identity, invocation instructions, and output rules.

Rationale: composing preambles (prepend/append) creates fragile, hard-to-debug prompts. Full replacement is explicit and predictable. In practice, repos rarely override `agent.md` — they override domain prompts.

### Shared domain prompts (`domains/` directory)

Shared domain files in `.code-review/domains/` are a **lowest-common-denominator fallback**. They should be written in a neutral instruction style — not Claude-narrative and not Codex-terse. The agent preamble provides the agent-specific context.

If a domain needs agent-specific tuning, create per-agent versions in `.code-review/prompts/{agent}/`. Per-agent versions always take priority over shared versions.

Recommendation: use shared domains for repo-specific concerns (like `07-token-integrity`) where the content is domain knowledge, not prompt engineering. Use per-agent versions when prompt style matters.

### Severity override execution semantics

Severity overrides transform finding severity **after agent output, before fix eligibility**. They do not modify prompts or agent behavior — they post-process results.

**Transformation point:** After JSON parsing, before canonicalization.

**Supported override fields:**
- `min_severity` — promotes all findings in a domain to at least this level
- `promote_medium_to` — promotes only medium findings to the specified level

**Worked example:**

Config: `"severity_overrides": { "accessibility": { "min_severity": "high" } }`

Agent outputs: `[{"severity": "medium", "domain": "accessibility", ...}]`

After override: `[{"severity": "high", "domain": "accessibility", "original_severity": "medium", ...}]`

The `original_severity` is preserved for history/audit — the improvement skill needs to see the drift between what agents report and what policy enforces.

**Precedence:** overrides deep-merge (repo > org > global). A repo can set `"accessibility": { "min_severity": "medium" }` to relax an org-level `"critical"` override.

**Interaction with `fix_threshold`:** overrides are applied first, then `fix_threshold` filters. So `min_severity: "high"` + `fix_threshold: "medium"` means all a11y findings get fixed (high >= medium).

### Domain ID format

All config surfaces use the same canonical domain ID: the **slug** derived from the filename by stripping the numeric prefix and extension. For `01-architecture.md`, the domain ID is `architecture`. For `07-token-integrity.md`, it's `token-integrity`.

This slug is used consistently in:
- `disabled_domains`: `["test-coverage", "architecture"]`
- `severity_overrides`: `{ "accessibility": { ... } }`
- `extra_domains`: `["token-integrity"]`
- History/audit data: `"domain": "correctness"`

The orchestrator validates all domain IDs at startup — any ID in config that doesn't match a discovered domain file produces a warning: "Unknown domain 'foobar' in disabled_domains. Known domains: architecture, accessibility, ..."

### Config field cleanup

The `domains` config field is removed — domain discovery is always automatic from the prompts directory. Not a config concern.

The `disabled_agents` field is removed. Use `agents` to specify the active set: `"agents": ["claude", "codex"]` means gemini is skipped. One mechanism, not two.

---

## Constraints

- **macOS only** — keychain-based auth requires macOS `security` CLI. Not portable to Linux/CI without an alternative credential store.
- **Local execution** — sub-agents run as local CLI processes. Not designed for CI pipeline execution (no containerization, no credential forwarding).
- **Rate limits** — 18 parallel API calls may hit provider rate limits. The system tolerates failures (no retries, partial results valid) but high-volume usage may need staggered execution in a future iteration.
