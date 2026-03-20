# Five-Tier Replacement Pattern Hierarchy

The rename skill applies 5 replacement patterns in order from most specific to least specific. Each pattern operates on the result of the previous in a single pass. All patterns treat the old name as a literal string (Perl `\Q..\E`), not a regex.

## Patterns (applied in order)

| Tier | Pattern | Scope | Example |
|------|---------|-------|---------|
| 1 | `{parent-path}/{old-name}` | All tracked text files | `/Users/aryeh/git/Evinced/stark-review` |
| 2 | `{org}/{old-name}` | All tracked text files | `GetEvinced/stark-review` |
| 3 | `{host}:{org}/{old-name}` | All tracked text files | `github.com:GetEvinced/stark-review` |
| 4 | `{host}/{org}/{old-name}` | All tracked text files | `github.com/GetEvinced/stark-review` |
| 5 | Bare `{old-name}` with custom lookarounds | `*.md`, `*.json`, `*.sh` only | `stark-review` (standalone) |

Tier 5 uses `(?<![A-Za-z0-9._-]){old-name}(?![A-Za-z0-9._-])` to avoid matching inside longer identifiers.

## Exclusion Rules

| Pattern | Excluded? | Reason |
|---------|-----------|--------|
| `/{old-name}` (slash-prefixed invocations) | Yes | Skill invocation name preserved |
| `name:` frontmatter fields | Yes | Skill identity preserved |
| Installed skill paths (`~/.claude/skills/...`) | Yes | Skill identity, not repo name |
| Skill labels in install.sh | Yes | Stable identifiers |
| GitHub App names (`stark-claude`, etc.) | Yes | Independent of project name |
| Historical document filenames | Yes | Historical record preserved |
| `~/.claude/code-review/` path | Yes | Does not contain project name |
| `.git/` directory content | Yes | Git internal data |
| `.github/workflows/*.yml` | Yes | CI/CD reported, not auto-modified |
