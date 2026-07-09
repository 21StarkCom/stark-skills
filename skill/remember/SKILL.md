---
name: remember
description: >-
  Persist a durable fact or note into Aryeh's second-brain vault via the brain
  MCP (or the brain CLI as fallback). Use whenever the user EXPLICITLY asks to
  remember, save, persist, capture, or "write back" something to the second
  brain / memory / vault — phrasings like "remember that…", "save this to my
  brain", "add this to memory", "/remember …", "note this down for later". Routes
  one-line facts to append_to_memory and structured knowledge (a project, repo,
  tool, person, cloud resource) to upsert_note, validates + secret-scans, then
  commits and merges the capture to main. Companion to the brain MCP. (Triggers
  on explicit save intent only for now — not yet on passively-observed facts.)
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# remember — write back to the second brain

Capture durable knowledge into the Markdown vault at
`/Users/aryeh/Code/Playground/2nd-brain/second-brain` so it survives the session.
The vault is the source of truth; this skill is a thin, safe wrapper over the
brain write tools. Markdown on disk *is* the memory — and once written, validated,
and secret-scanned, the skill lands it on `main` via a branch + PR (see step 5).

## 1. Decide the shape: fact vs. structured note

Two write paths. Pick by what's being saved:

- **A one-line durable fact** (a preference, a location, a gotcha, a workflow
  constraint, a reusable decision) → **`append_to_memory`**. It appends to a
  per-category note under `50_Memory/`.
- **Knowledge about a named entity** (a project, repo, tool, person, cloud
  resource, meeting) → **`upsert_note`**. It surgically creates-or-updates that
  entity's structured note (frontmatter fields + body sections), preserving
  everything else.

When unsure, prefer `append_to_memory` — it's lower-stakes and the fact can be
promoted to a structured note later.

## 2. Pick the category (for append_to_memory)

Map to an existing `50_Memory/` category so facts cluster, don't sprawl. Current
categories (slugify the name → the tool's `category` arg):

| category | holds |
|----------|-------|
| `preferences` | output-format, tooling, workflow preferences |
| `locations` | where things live — dashboards, doc paths, project IDs |
| `writing` | voice / drafting preferences |
| `agent-context` | how agents should behave for Aryeh |
| `gotchas` | sharp edges, traps, "watch out for X" |
| `profile` | stable facts about Aryeh |
| `people-conventions` | how to handle named people |

A genuinely new category is fine — the note is created from the memory template.
Don't invent near-duplicates of an existing one.

## 3. Guardrail: never persist a secret

Mirror `00_System/Memory Policy.md`. **Never** write passwords, API tokens,
private keys, session cookies, recovery codes, or unredacted secret-bearing
config. The write path secret-scans and fails closed, but don't rely on it —
redact at the source. If the thing worth remembering is *that a secret exists*,
record the pointer ("the X token lives in `.private/…`"), never the value.

## 4. Write it

**Prefer the MCP tools when the brain server is connected** (this session has it):

- `mcp__brain__append_to_memory` — args: `category`, `content`, optional `source`
  (attribution, e.g. a Slack channel + date, or "Aryeh, 2026-06-30").
- `mcp__brain__upsert_note` — args: `type`, `slug`, `fields` (frontmatter map),
  `sections` (heading → body map).

**Fallback — brain CLI** (works in any session, even without the MCP). Always
pass the vault explicitly:

```bash
VAULT=/Users/aryeh/Code/Playground/2nd-brain/second-brain
brain --vault "$VAULT" memory add <category> "<fact>" [--source "<attribution>"]
brain --vault "$VAULT" upsert <type> <slug> --set key=value --section "Heading=content"
```

Respect Aryeh's standing rule: **never full-rewrite a co-edited vault note.** Use
the surgical upsert/append paths above — never overwrite a note's whole body.

## 5. Verify, then commit and merge to main

After the write, both checks must pass (secret scan fails closed — treat any
error as a finding, never "clean"):

```bash
brain --vault "$VAULT" validate && brain --vault "$VAULT" secrets scan
```

Then land the capture on `main` **via a branch + PR** — never commit to `main`
directly (workspace HARD RULE: branch + PR for everything). The vault repo is
`21-Stark-AI/stark-2nd-brain`; it has no CI, so "green" is immediate. Batch every
capture from one session into a single branch/PR — don't open one PR per fact.

```bash
cd "$VAULT"
git checkout -b memory/<short-slug>                       # e.g. memory/2026-07-07-notarization
git add -A
git commit -m "docs(brain): <one-line summary of what was captured>"
git push -u origin HEAD
gh pr create --fill
gh pr merge --squash --delete-branch                      # merges to main (immediate — no CI)
git checkout main && git pull --ff-only
```

`brain --vault "$VAULT" git summary` shows the staged changes + a suggested
message if you want to sanity-check the diff before committing.

Then **report what changed** — the note path(s), a one-line summary, and the
merged PR — and stop.

## Examples

**Explicit fact:**
Input: "remember that I prefer Go for backend and never new Python"
→ `append_to_memory(category="preferences", content="Backend default is Go; no new Python — migrate existing Python repos to Go/TS.", source="Aryeh, 2026-06-30")`

**Structured note:**
Input: "save that stark-visual is now 14 binaries plus the in-repo cmd/stark-mcp"
→ `upsert_note(type="repo", slug="stark-visual", sections={"Status": "14 binaries + in-repo cmd/stark-mcp (14 MCP tools)."})`

**Pointer, not secret:**
Input: "remember the HubSpot token"
→ Do NOT store the value. `append_to_memory(category="locations", content="HubSpot API token lives in .private/ (see .private/INDEX.md); read into the consuming process, never paste.")`
