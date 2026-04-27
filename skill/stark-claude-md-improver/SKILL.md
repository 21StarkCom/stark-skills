---
name: stark-claude-md-improver
description: >-
  Analyze and improve CLAUDE.md files for completeness and accuracy. Use for improve/review/audit claude.md.
argument-hint: [path to CLAUDE.md] (optional — auto-discovers all CLAUDE.md files in project hierarchy)
disable-model-invocation: true
model: opus
revision: ea827b2dd463a563417f2dd86c31248eb42b5cfb
revision_date: 2026-04-10T17:10:53+03:00
---

# CLAUDE.md Improver

Analyze CLAUDE.md files and suggest concrete improvements. CLAUDE.md files are instruction files that Claude Code reads at conversation start to understand projects, preferences, and conventions.

## Discovery

1. Identify all CLAUDE.md files in the hierarchy (home → org → project → subdirectories).
2. Read each one fully.
3. Also read the project's memory files if they exist (`.claude/projects/*/memory/`).

## Analysis Dimensions

For each CLAUDE.md file, evaluate:

### 1. Structure & Clarity
- Is information organized logically?
- Are sections scannable with appropriate headers?
- Is there redundancy across files in the hierarchy? (Each level should add specificity, not repeat parent info.)

### 2. Completeness
Check for missing sections that would help Claude Code work effectively:
- **Project overview** — what the project is, its current state
- **Tech stack** — framework, language, key libraries
- **Architecture** — how components connect, data flow
- **Key files** — important files and what they do
- **Development workflow** — how to build, test, deploy
- **Environment variables** — what's needed and why
- **Conventions** — code style, naming, patterns to follow
- **Gotchas** — things that trip up newcomers or AI assistants
- **Don'ts** — antipatterns to avoid

### 3. Accuracy & Freshness
- Cross-reference with actual project state (package.json, file structure, git log)
- Flag references to files that don't exist
- Flag outdated version numbers or URLs
- Check if build/deploy commands actually work
- Verify key file paths still exist

### 4. Effectiveness for AI
- Are instructions actionable? ("Use X" is better than "We typically use X")
- Are conventions specific enough? (Bad: "follow best practices". Good: "use snake_case for API routes")
- Do instructions conflict with each other or with parent CLAUDE.md files?
- Are there implicit assumptions that should be explicit?

### 5. Hierarchy Optimization
- Is information at the right level? (Personal prefs in ~/CLAUDE.md, org stuff in org/CLAUDE.md, project specifics in project/CLAUDE.md)
- Could any content be promoted to a parent level to reduce duplication?
- Could any content be demoted to a more specific level?

## Output

Present findings organized by file, with:

1. **Score** (1-5) per dimension
2. **Issues found** — concrete problems with file:line references
3. **Suggested additions** — missing content that would help, with draft text
4. **Suggested removals** — redundant or outdated content
5. **Suggested moves** — content that belongs in a different CLAUDE.md level

Then ask: "Want me to apply these improvements?" If yes, edit the files directly.

## Observability

Standard observability: record metrics block (CLAUDE.md files analyzed, per-file score across 5 dimensions, issues/suggestions/removals/moves, changes applied). See [../../standards/observability.md](../../standards/observability.md).

## Rules

- Don't add sections just for completeness — only add what genuinely helps.
- Prefer concise instructions over verbose documentation.
- Respect the user's existing style and tone.
- Don't add README-style content. CLAUDE.md is for AI instructions, not human documentation.
- When suggesting new content, write it in the same style as the existing file.
- If a CLAUDE.md references a spec or detailed doc, don't duplicate that content — just ensure the reference is correct.
