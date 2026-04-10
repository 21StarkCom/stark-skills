---
name: stark-onboard-project
description: >-
  Bootstrap new project: git init, GitHub repo, 3 GitHub Apps, CLAUDE.md, memory. Use for onboard, new project, create repo.
argument-hint: <optional: path to the project directory, defaults to cwd>
disable-model-invocation: true
model: opus
---

# Onboard Project

Full project bootstrap: git init → GitHub repo → connect GitHub Apps → Claude Code setup.
Handles the entire journey from empty directory to a fully-wired project.

Each phase is idempotent — if git is already initialized, skip to GitHub. If the repo already exists, skip to app connection. If apps are connected, skip to Claude Code setup.

## Prerequisites

```bash
PROJECT_DIR="${ARGUMENTS:-$(pwd)}"
cd "$PROJECT_DIR"

# These are needed for GitHub operations
SCRIPTS_DIR="$HOME/git/Evinced/scripts"
PYTHON="$SCRIPTS_DIR/.venv/bin/python3"
GITHUB_APP="$SCRIPTS_DIR/github_app.py"
```

---

## Phase 1: Git Initialization

### 1a. Check if already a git repo

```bash
git rev-parse --git-dir 2>/dev/null
```

**If already a git repo:** Log "Git already initialized" and skip to Phase 2.

### 1b. Initialize git

```bash
git init
```

### 1c. Create .gitignore if missing

If no `.gitignore` exists, create one appropriate to the detected project type:

- **Python:** `.env`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`, `*.egg-info/`, `dist/`, `build/`, `credentials/`
- **Node:** `node_modules/`, `.env`, `dist/`, `.next/`, `coverage/`
- **Go:** Binary name, `vendor/` (if not vendoring)
- **Generic:** `.env`, `.DS_Store`, `*.log`

If a `.gitignore` already exists, don't overwrite it.

### 1d. Initial commit

If there are files to commit and no commits exist yet:

```bash
git add -A
git commit -m "chore: initial commit"
```

If the repo already has commits, skip this.

---

## Phase 2: GitHub Repository

### 2a. Check if remote exists

```bash
git remote get-url origin 2>/dev/null
```

**If remote already exists:** Extract repo name, log "GitHub repo already connected: {repo}", skip to Phase 3.

### 2b. Determine repo details

Ask the user:

```
GitHub repo setup:
  Org:         GetEvinced (default) or aryeh-evinced?
  Name:        [default: directory name]
  Visibility:  private (default) or public?
  Description: [optional]
```

Wait for response. Use defaults if user just hits enter.

### 2c. Create the repo

```bash
# Use user's PAT for repo creation (repos should show as created by the user, not a bot)
unset GH_TOKEN

gh repo create {ORG}/{NAME} \
  --{VISIBILITY} \
  --source . \
  --push \
  --description "{DESCRIPTION}"
```

If `gh repo create` fails because the repo already exists, just add the remote:
```bash
git remote add origin git@github.com:{ORG}/{NAME}.git
git push -u origin main
```

### 2d. Set repo topics

All GetEvinced repos get these topics for compliance/inventory purposes:

```bash
gh api --method PUT /repos/{ORG}/{NAME}/topics \
  --input - <<< '{"names":["non-production","not-production"]}'
```

### 2e. Create CODEOWNERS

If `.github/CODEOWNERS` does not already exist, create it.

Detect the repo creator's GitHub username:

```bash
# Get the authenticated user's GitHub username
GH_USER=$(gh api /user --jq '.login' 2>/dev/null)
```

Create `.github/CODEOWNERS`:

```bash
mkdir -p .github
cat > .github/CODEOWNERS << EOF
# Default owner for everything in this repo
* @${GH_USER}
EOF
```

Stage it for the next commit (or commit immediately if Phase 1 already committed):

```bash
git add .github/CODEOWNERS
git commit -m "chore: add CODEOWNERS"
git push origin main 2>/dev/null  # push if remote exists
```

**If CODEOWNERS already exists:** Log "CODEOWNERS already exists — skipping" and move on.

### 2f. Verify

```bash
gh repo view {ORG}/{NAME} --json nameWithOwner -q .nameWithOwner
gh api /repos/{ORG}/{NAME}/topics --jq '.names | join(", ")'
```

---

## Phase 3: Connect GitHub Apps

The 3 GitHub Apps need access to the new repo. Each app has a fixed installation ID on the GetEvinced org. Adding a repo to an installation requires a JWT-authenticated API call.

### 3a. Add repo to each app installation

Run this Python snippet to add the repo to all 3 apps:

```python
import sys
sys.path.insert(0, "$SCRIPTS_DIR")
from github_app import APPS, _get_private_key, _make_jwt, select_app, API
import requests

# Get the repo ID
repo = "{ORG}/{NAME}"
select_app("stark-claude")
token_resp = requests.post(
    f"{API}/app/installations/{APPS['stark-claude']['installation_id']}/access_tokens",
    headers={
        "Authorization": f"Bearer {_make_jwt(_get_private_key())}",
        "Accept": "application/vnd.github+json",
    },
    json={"repositories": [repo.split("/")[1]]},
    timeout=10,
)
```

Actually, the simpler approach — GitHub App installations on orgs are managed through the org settings. Use the installation token to check access, and if the repo isn't accessible, use `gh api` with the user's token to add it:

```bash
# For each app, check if the repo is accessible, if not add it
for APP in stark-claude stark-codex stark-gemini; do
  TOKEN=$($PYTHON $GITHUB_APP --app $APP token)

  # Check if repo is already accessible to this app
  ACCESSIBLE=$(GH_TOKEN=$TOKEN gh api /installation/repositories \
    --jq ".repositories[] | select(.full_name == \"$ORG/$NAME\") | .id" 2>/dev/null)

  if [ -n "$ACCESSIBLE" ]; then
    echo "$APP: already has access to $ORG/$NAME"
  else
    echo "$APP: needs access — adding..."

    # Get repo ID
    REPO_ID=$(gh api /repos/$ORG/$NAME --jq '.id')
    INSTALL_ID=$(python3 -c "
import sys; sys.path.insert(0, '$SCRIPTS_DIR')
from github_app import APPS
print(APPS['$APP']['installation_id'])
")

    # Add repo to installation (requires user token with right scope)
    gh api --method PUT /user/installations/$INSTALL_ID/repositories/$REPO_ID 2>/dev/null

    if [ $? -ne 0 ]; then
      echo "$APP: could not add automatically. Add manually at:"
      echo "  https://github.com/organizations/GetEvinced/settings/installations"
    fi
  fi
done
```

### 3b. Handle missing scope

If the `gh api` call fails with a 403/scope error, tell the user:

```
Your gh token needs the 'read:user' scope to manage app installations.
Run: gh auth refresh -h github.com -s read:user
Then re-run /stark-onboard-project
```

Or provide the manual fallback:
```
Add the repo manually at:
  https://github.com/organizations/GetEvinced/settings/installations

Click each app (stark-claude, stark-codex, stark-gemini) → Repository access → Add {NAME}
```

### 3c. Verify all 3 apps

```bash
echo "Verifying app access..."
for APP in stark-claude stark-codex stark-gemini; do
  TOKEN=$($PYTHON $GITHUB_APP --app $APP token)
  FOUND=$(GH_TOKEN=$TOKEN gh api /installation/repositories \
    --jq ".repositories[] | select(.full_name == \"$ORG/$NAME\") | .full_name" 2>/dev/null)
  if [ -n "$FOUND" ]; then
    echo "  ✓ $APP"
  else
    echo "  ✗ $APP — not connected"
  fi
done
```

---

## Phase 4: Claude Code Setup

### 4a. Check for existing CLAUDE.md

If CLAUDE.md already exists: log "CLAUDE.md already exists — skipping. Use /stark-claude-md-improver to enhance it." and skip to 4c.

### 4b. Auto-detect and generate CLAUDE.md

Scan the project directory for indicators:

**Language:** `package.json` (JS/TS), `pyproject.toml`/`requirements.txt` (Python), `go.mod` (Go), `Cargo.toml` (Rust), `build.gradle`/`pom.xml` (Java/Kotlin)

**Framework:** `next.config.*` (Next.js), `fastapi`/`flask`/`django` in deps, `react`/`vue` in deps

**Test/Build:** `Makefile`, `Dockerfile`, `docker-compose.yml`, CI configs

Present findings and ask for confirmation before writing:

```
Project Scan Results
────────────────────
Directory:   $PROJECT_DIR
Repo:        $ORG/$NAME
Language:    $LANGUAGE
Framework:   $FRAMEWORK
Test runner: $TEST_RUNNER

Generate CLAUDE.md? Anything to add or change?
```

**Wait for confirmation.** Then generate CLAUDE.md with the standard header:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview
...
```

### 4c. Create .claude/ directory

```bash
mkdir -p "$PROJECT_DIR/.claude"
```

### 4d. .gitignore for .claude/

If `.claude/` is not already in `.gitignore`, ask:

```
Add .claude/ to .gitignore? (keeps Claude context private to your machine)
Recommendation: Yes, unless the team is standardizing on Claude Code.
```

---

## Phase 5: Summary

```
Onboarding Complete
───────────────────
Project:     $ORG/$NAME
Directory:   $PROJECT_DIR
GitHub:      https://github.com/$ORG/$NAME

Git:         ✓ initialized
GitHub repo: ✓ created ($VISIBILITY)
CODEOWNERS:  ✓ created (@$GH_USER)
stark-claude: ✓ connected
stark-codex:  ✓ connected
stark-gemini: ✓ connected
CLAUDE.md:   ✓ generated
.claude/:    ✓ created

Next steps:
- Review CLAUDE.md and adjust
- If this service uses shared GCP infra: run /onboard-service {name} in infra-ai-platform
- Start a session with /stark-session start
- Use /stark-init-docs to scaffold documentation
```

---

## Failure Modes

| Failure | Recovery |
|---------|----------|
| CODEOWNERS already exists | Skip — don't overwrite |
| CLAUDE.md already exists | Skip — suggest `/stark-claude-md-improver` |
| Git already initialized | Skip Phase 1 |
| GitHub repo already exists | Add remote and push |
| `gh` not authenticated | Run `gh auth login` |
| App installation scope missing | `gh auth refresh -s read:user` or manual add via org settings URL |
| Template file missing | Generate CLAUDE.md from scratch |
| Not GetEvinced org | Skip GitHub App connection (apps are GetEvinced-only) |
| No language detected | Ask user to specify |

## Observability

Standard observability: create task, emit timestamped progress logs, record metrics block (phases skipped vs executed, GitHub Apps connected count, CLAUDE.md generated/existing, total time), emit completion event via `emit_queue.py`. See [../../standards/observability.md](../../standards/observability.md).
