# Replacement Patterns

## Deterministic patterns (auto-applied to all tracked text files)

Apply these in order, most specific first. Treat `OLD_NAME` as a literal
string, not a regex.

1. `$PARENT/$OLD_NAME` → `$PARENT/$NEW_NAME` (absolute path references)
2. `$ORG/$OLD_NAME` → `$ORG/$NEW_NAME` (org/repo references)
3. `$HOST:$ORG/$OLD_NAME` → `$HOST:$ORG/$NEW_NAME` (SSH clone URLs)
4. `$HOST/$ORG/$OLD_NAME` → `$HOST/$ORG/$NEW_NAME` (HTTPS URLs)

Use Perl `\Q...\E` for literal matching (not regex). This prevents `.`
in repo names from matching arbitrary characters.

## Heuristic pattern (restricted scope)

5. Bare `$OLD_NAME` with repo-name-aware boundaries — only in `*.md`,
   `*.json`, `*.sh` files. Use custom lookarounds:
   `(?<![A-Za-z0-9._-])OLD_NAME(?![A-Za-z0-9._-])`

   This prevents matching inside longer identifiers like
   `stark-review-improvement`.

   Exclude `.github/workflows/` — CI/CD files are only scanned and
   reported, not auto-modified.

## Exclusion rules

Do NOT replace:
- `/{old-name}` (slash-prefixed) — skill invocation name
- `name:\s*['"]?{old-name}['"]?` in frontmatter — skill identity
- Installed skill paths like `~/.claude/skills/stark-review/` — these are skill identity, not repo name
- Skill labels like `"Skill: stark-review"` in install.sh — stable identifiers
- GitHub App names (`stark-claude`, `stark-codex`, `stark-gemini`)
- Historical document filenames (e.g., `2026-03-16-stark-review-skill-design.md`) — only update content, not filenames
- `~/.claude/code-review/` path — does not contain project name, should never be modified
- Content inside `.git/` directory

## Post-update validation

```bash
bash -n install.sh || error "install.sh has syntax errors after modification"
```

Track every file modified for the summary.
