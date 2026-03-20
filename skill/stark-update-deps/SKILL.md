---
name: stark-update-deps
description: Audit and update all dependency versions across a project to their latest stable releases. Scans pyproject.toml, package.json, requirements.txt, Dockerfile, docker-compose.yml, go.mod, Cargo.toml, and any other dependency manifest. Looks up each dependency on official sources (PyPI, npm, Docker Hub, GitHub releases) via WebSearch, checks for compatibility blockers and breaking changes, updates versions in-place, then re-verifies every updated version to ensure accuracy. Use when the user says "update dependencies", "check for outdated packages", "upgrade versions", "are my deps current", "stark-update-deps", or any variation of wanting to bring project dependencies up to date. Also use proactively when you notice stale or outdated versions during other work.
---

# Dependency Version Updater

Systematically audit every versioned dependency in a project, look up current stable releases on official sources, identify breaking changes, update in-place, and verify the result.

Two things make this skill valuable over just "updating versions":
1. **Verification** — LLMs hallucinate version numbers confidently. Every version must be confirmed by a real web search. In testing, a baseline run without this skill incorrectly validated a fabricated CUDA Docker tag (`nvidia/cuda:13.2.0`) as existing. With the skill's verification phase, it was caught and flagged.
2. **Docker tag awareness** — a software version existing (e.g., PostgreSQL 18) doesn't mean a Docker Hub tag exists for it (e.g., `postgres:18` may not be published yet). Always verify Docker tags specifically on Docker Hub, not just the software version.

## Phase 1: Discovery

Find all dependency manifests in the project. Search for:

| Ecosystem | Files |
|-----------|-------|
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `Pipfile`, `poetry.lock`, `constraints.txt` |
| Node | `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` |
| Docker | `Dockerfile*`, `docker-compose*.yml`, `.dockerignore` |
| Go | `go.mod`, `go.sum` |
| Rust | `Cargo.toml`, `Cargo.lock` |
| Java/Kotlin | `build.gradle*`, `pom.xml` |
| Ruby | `Gemfile`, `Gemfile.lock` |
| .NET | `*.csproj`, `Directory.Packages.props` |

Also check for version references in:
- CI/CD configs (`.github/workflows/*.yml`, `cloudbuild.yaml`, `.gitlab-ci.yml`)
- Infrastructure files (Terraform `*.tf`, Helm `Chart.yaml`)
- Documentation and plan files (`*.md`) that embed version-pinned code blocks

Use `Glob` to find these files. Read each one and extract every versioned dependency into a structured inventory.

### Inventory format

Build an internal table like:

```
| Dependency | Current Version | File | Line | Ecosystem |
```

Group dependencies by ecosystem (Python, Node, Docker, etc.) for efficient batch lookups.

## Phase 2: Research (batch by ecosystem)

For each ecosystem, batch web searches to minimize round trips. The goal is to find the **latest stable release** of each dependency — not pre-releases, betas, or release candidates unless the project is already using one.

### LTS and stability preference

For runtime base images and language versions, prefer **LTS or Active LTS** over the absolute latest:
- **Node.js**: Use the current Active LTS version (even-numbered: 18, 20, 22), not the "Current" release (odd-numbered or too-new even). Search for "Node.js release schedule" to confirm which version is Active LTS right now.
- **Python**: Use the latest stable release that has broad library support. If the project's deps don't all support the newest Python yet, use the previous stable.
- **PostgreSQL/Redis/Mongo**: Use the latest major version that has an official Docker Hub image tag — this sometimes lags behind the software release.

The reasoning: bleeding-edge versions cause subtle breakage when libraries haven't caught up. LTS versions are battle-tested.

### Search strategy by ecosystem

**Python (PyPI):**
- Search: `"<package-name> latest version pypi {current_year}"` on pypi.org
- Allowed domains: `pypi.org`, `github.com`, `readthedocs.io`
- Extract: version number, release date, Python version support, changelog highlights
- For major version jumps: also search `"<package> migration guide"` or `"<package> breaking changes <new_major>"`

**Node (npm):**
- Search: `"<package-name> latest version npm {current_year}"`
- Allowed domains: `npmjs.com`, `github.com`
- Extract: version, release date, Node version support, peer dependencies

**Docker images (requires special care):**

Docker image tags are NOT the same as software versions. A software version can be released before a Docker Hub image is published for it. Always verify the actual tag exists on Docker Hub.

- Search: `"<image-name> tags" site:hub.docker.com {current_year}"`
- Allowed domains: `hub.docker.com`, `github.com`, `nvidia.com`, `docs.docker.com`
- For language base images (python, node, golang): first determine the correct language version (LTS preference above), then verify the Docker tag exists
- For GPU images (nvidia/cuda): these have complex tag formats (`<cuda-version>-cudnn-runtime-<os>`). Search specifically for the tag string, not just the CUDA version number. CUDA tags are frequently hallucinated — verify extra carefully.

**Go modules:**
- Search: `"<module-path> latest version {current_year}"`
- Allowed domains: `pkg.go.dev`, `github.com`

**System tools in Dockerfiles** (ffmpeg, curl, etc.):
- These come from the OS package manager — just confirm the base image version is current.

### Parallelization

Launch multiple WebSearch calls in the same turn whenever possible. Group searches so that independent lookups happen in parallel. A project with 30 Python deps should NOT require 30 sequential turns.

Aim for 4-6 WebSearch calls per turn, grouping related packages:
- Turn 1: core framework deps (fastapi, sqlalchemy, etc.)
- Turn 2: cloud/API SDKs (anthropic, openai, google-cloud-*, etc.)
- Turn 3: dev tools (pytest, ruff, mypy, etc.)
- Turn 4: Docker base images and infrastructure

### What to capture per dependency

For each dependency, record:
1. **Latest stable version** — the version number
2. **Release date** — to confirm it's recent (sanity check)
3. **Major version jump?** — if current is 1.x and latest is 2.x, flag it
4. **Python/Node version constraints** — does the latest version drop support for the project's target runtime?
5. **Known blockers** — deprecations, breaking API changes, incompatible peer deps
6. **For Docker images**: does the exact tag string exist on Docker Hub?

## Phase 3: Compatibility Analysis

Before updating anything, check for conflicts:

### Cross-dependency compatibility

- If package A requires `foo>=2.0` but package B requires `foo<2.0`, that's a conflict.
- For Python: check if the latest versions all support the project's `requires-python`.
- For Node: check `engines` field and peer dependency requirements.
- For Docker: check that the CUDA version is compatible with PyTorch/TensorFlow if applicable.

### Major version jump risk assessment

For every dependency with a major version jump, search for migration guides, breaking changes, **and specific codemod tools**. Include actionable migration commands when available.

```
| Dependency | Current | Latest | Breaking Changes | Migration |
|------------|---------|--------|-----------------|-----------|
| openai     | 1.57.0  | 2.29.0 | New client API  | Check changelog |
| tailwindcss| 3.3.0   | 4.2.0  | CSS-first config| `npx @tailwindcss/upgrade` |
| next       | 14.0.0  | 16.1.0 | Async APIs      | `npx @next/codemod@canary upgrade` |
| eslint     | 8.50.0  | 10.0.0 | Flat config only| `npx @eslint/migrate-config` |
```

Providing specific codemod commands makes the report actionable rather than just informational.

### Decision matrix

Categorize each update:
- **Safe** — minor/patch bump, no breaking changes
- **Review** — major bump with migration path, code changes likely needed
- **Blocked** — incompatible with other deps or project constraints, OR Docker tag doesn't exist
- **Skip** — already at latest

Present this summary to the user before making changes. For "Review" items, note what code changes the implementing agent will need to make.

## Phase 4: Update

Apply all "Safe" updates immediately. For "Review" updates, apply the version bump but add a comment noting the breaking change if the file format supports comments.

### Update rules by file type

**pyproject.toml / setup.cfg:**
- Update minimum version in `>=X.Y.Z` constraints
- Keep the `>=` format — don't pin exact versions unless the original did
- Update `target-version` and `python_version` in tool configs if Python version changed

**requirements.txt:**
- Update pinned versions (`package==X.Y.Z`) or minimum versions (`package>=X.Y.Z`)
- Preserve the original constraint style

**package.json:**
- Update version ranges, preserving the range style (`^`, `~`, or exact)
- Don't touch lock files — tell the user to run `npm install` / `yarn` after

**Dockerfile:**
- Update `FROM` image tags — but only to tags confirmed to exist on Docker Hub
- Update language version references in `RUN` commands (e.g., `python3.12` → `python3.13`)
- Update `apt-get install` package names if the base OS changed (e.g., ubuntu22.04 → ubuntu24.04)

**docker-compose.yml:**
- Update `image:` tags — only to tags confirmed to exist on Docker Hub

**Markdown files with code blocks:**
- Update version references in embedded code (pyproject.toml blocks, Dockerfile blocks, etc.)
- These are documentation/plans — they should match the real files

### Consistency

After updating, verify that the same dependency doesn't have conflicting versions across different files. For example, if `fastapi>=0.135.0` appears in both `pyproject.toml` and a `requirements.txt`, both must match.

## Phase 5: Verification (CRITICAL)

This phase exists because LLMs confidently produce plausible-looking but wrong version numbers. In testing, a run without structured verification incorrectly validated a fabricated Docker image tag as existing — the kind of error that silently breaks builds. Every version that was updated must be re-verified against a real web source.

### Re-scan all modified files

1. Read every file that was modified
2. Extract all version numbers that changed
3. For EACH updated version, run a fresh WebSearch to confirm it exists:
   - **Python packages**: Search `"<package> <exact-version>" site:pypi.org` — the result must show that exact version
   - **npm packages**: Search `"<package> <exact-version>" site:npmjs.com`
   - **Docker images**: Search `"<image>:<exact-tag>" site:hub.docker.com` — Docker tags are the #1 source of hallucinated versions. A software release does NOT guarantee a Docker tag exists.
   - **CUDA images specifically**: These have complex multi-part tags. Search for the full tag string. If the search doesn't return an exact match on Docker Hub, the tag is fabricated.
4. Check release dates — a version from the future is hallucinated
5. For runtime versions (Node, Python): verify LTS/Active LTS status, not just existence

### Verification output

For each verified dependency, list it explicitly with evidence:

```
Verified:
- [x] fastapi 0.135.1 — confirmed on PyPI (released 2026-03-01)
- [x] node:22-alpine — confirmed on Docker Hub, Node 22 is Active LTS through 2027-04
- [x] postgres:18 — confirmed on Docker Hub
- [ ] nvidia/cuda:13.2.0-cudnn-runtime-ubuntu24.04 — NOT FOUND on Docker Hub, tag does not exist
```

This explicit per-item listing is what makes verification trustworthy. A generic "all versions verified" claim has no value.

### If verification fails

If a version cannot be confirmed:
1. Search more broadly for the package's actual latest version
2. Fix the version to the confirmed latest
3. Re-verify the fix
4. If it's a Docker tag: search Docker Hub for available tags of that image and pick the closest valid one

Never leave an unverified version in place. If you cannot confirm a version after two search attempts, revert to the original version and flag it for the user.

## Phase 6: Report

Present the final summary:

```
Dependency Update Report
════════════════════════

Updated: N packages
Skipped: N (already current)
Blocked: N (compatibility issues)
Major bumps: N (may need code changes)

| Dependency | Old | New | Status | Notes |
|------------|-----|-----|--------|-------|
| fastapi    | 0.115.0 | 0.135.1 | Updated | |
| openai     | 1.57.0  | 2.29.0  | Updated (major) | New client API |
| redis      | 5.2.0   | 7.1.0   | Updated (major) | Requires Python 3.10+ |

Files modified:
- pyproject.toml
- Dockerfile
- docker-compose.yml

Action items for major bumps:
1. openai 1.x → 2.x: Check migration guide, API client changes
2. tailwindcss 3.x → 4.x: Run `npx @tailwindcss/upgrade`
3. eslint 8.x → 10.x: Run `npx @eslint/migrate-config .eslintrc.json`

Verification: All N updated versions confirmed on official registries.
[explicit per-item listing here]
```

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Dependencies: total scanned, updated (safe/review/blocked/skip)
- WebSearch calls: count, per-ecosystem breakdown
- Verification: confirmed, failed, reverted
- Major version bumps: count with migration flags

## Edge Cases

- **Monorepos**: Scan all subdirectories, not just the root
- **Lock files**: Don't edit lock files directly — note that the user needs to regenerate them
- **Private packages**: If a package isn't found on public registries, skip it and note it
- **Pre-release pins**: If the project pins a pre-release (`1.0.0b3`), look for the latest pre-release in that series OR the GA release if one exists
- **Version ranges**: For ranges like `>=1.0,<2.0`, update the lower bound but respect the upper bound constraint unless the user explicitly asks to break it
- **Multiple ecosystems**: A project can have both Python and Node deps (e.g., a full-stack app) — handle all of them in one pass
- **Docker tag lag**: When a software version is released (e.g., PostgreSQL 18), the official Docker image may take days or weeks to publish. Always verify the tag exists on Docker Hub before using it.
