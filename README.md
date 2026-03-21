# stark-skills

Multi-agent PR code review system. Dispatches 3 AI agents (Claude, Codex, Gemini) across N domain specializations as parallel sub-agent reviews. Configuration and prompts merge from 3 levels (global → org → repo) following the CLAUDE.md pattern.

## Quick Start

```bash
# Clone and install
git clone git@github.com:GetEvinced/stark-skills.git ~/git/Evinced/stark-skills
cd ~/git/Evinced/stark-skills
./install.sh

# Review a PR (from any repo with GitHub App access)
cd ~/git/Evinced/some-repo
~/.claude/code-review/scripts/multi_review.py --pr 10

# Review all open PRs across repos
~/.claude/code-review/scripts/multi_review.py \
  --all-repos ~/git/Evinced/repo1 ~/git/Evinced/repo2
```

## Architecture

```
3 agents × 6 domains = 18 parallel sub-agent reviews

├── claude × {architecture, accessibility, correctness, type-safety, security, test-coverage}
├── codex  × {same 6 domains}
└── gemini × {same 6 domains}
```

Each agent posts a consolidated review via its own GitHub App bot:
- **stark-claude** — architecture, accessibility, token integrity focus
- **stark-codex** — correctness, type safety, test coverage focus
- **stark-gemini** — security, error handling, consistency focus

## Repo Structure

```
stark-skills/
├── install.sh                    ← symlinks repo contents to install locations
├── global/                       ← → ~/.claude/code-review/
│   ├── config.json               ← global defaults
│   ├── orchestrator.md           ← Claude Code fix-review loop instructions
│   └── prompts/
│       ├── claude/               ← Claude-specific prompts (narrative, contextual)
│       │   ├── agent.md
│       │   └── 01-architecture.md ... 06-test-coverage.md
│       ├── codex/                ← Codex-specific prompts (terse, direct)
│       │   └── ...
│       └── gemini/               ← Gemini-specific prompts (explicit, strict JSON)
│           └── ...
├── scripts/                      ← → ~/.claude/code-review/scripts/
│   ├── multi_review.py           ← orchestrator (ThreadPoolExecutor, 3×N workers)
│   └── github_app.py             ← multi-app GitHub auth (stark-claude/codex/gemini)
├── org/
│   └── evinced/                  ← → ~/git/Evinced/.code-review/
│       └── config.json           ← Evinced org overrides
└── docs/
    └── specs/
        └── 2026-03-16-*.md       ← design spec
```

## Install Locations

The installer creates symlinks — files stay in this repo. `git pull` updates everything.

| Repo path | Installed at | Purpose |
|-----------|-------------|---------|
| `global/config.json` | `~/.claude/code-review/config.json` | Global defaults |
| `global/orchestrator.md` | `~/.claude/code-review/orchestrator.md` | Fix-review loop |
| `global/prompts/` | `~/.claude/code-review/prompts/` | Agent × domain prompts |
| `scripts/` | `~/.claude/code-review/scripts/` | Python scripts |
| `org/evinced/` | `~/git/Evinced/.code-review/` | Org config |

```bash
./install.sh              # install (symlink)
./install.sh --status     # check what's linked
./install.sh --uninstall  # remove symlinks
```

## Config Hierarchy

Same merge pattern as CLAUDE.md — most specific wins:

```
~/.claude/code-review/config.json          ← global (from this repo)
~/git/Evinced/.code-review/config.json     ← org override (from this repo)
~/git/Evinced/some-repo/.code-review/      ← repo override (in each repo)
  ├── config.json
  ├── prompts/                             ← per-agent prompt overrides
  └── domains/                             ← repo-specific domains (shared)
```

Repos can override: agents, domains, severity calibration, test/build commands, and individual prompts.

## Adding a Domain

Add a numbered markdown file to each agent's prompts directory:

```bash
# Global domain (all repos)
touch global/prompts/claude/07-performance.md
touch global/prompts/codex/07-performance.md
touch global/prompts/gemini/07-performance.md

# Repo-specific domain (shared across agents)
mkdir -p ~/git/Evinced/some-repo/.code-review/domains
touch ~/git/Evinced/some-repo/.code-review/domains/07-db-migrations.md
```

Domains are auto-discovered at startup.

## Prerequisites

- macOS (keychain-based auth)
- `claude`, `codex`, `gemini` CLI tools in PATH
- Python 3.10+ with `PyJWT` and `requests`
- GitHub App private keys in macOS Keychain

Run `./install.sh` to check all dependencies.

## Design Spec

See `docs/specs/2026-03-16-multi-agent-code-review-system-design.md` for the full design including config merge rules, finding format, history schema, audit metrics, and the prompt improvement skill.
