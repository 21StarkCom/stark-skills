# Stark-Skills Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce skill context-window cost, eliminate prompt duplication, unify dispatcher scripts, fix script performance issues, and clean up stale code — making the entire stark-skills system lighter, faster, and easier to maintain.

**Architecture:** Six independent phases, each producing a working system. Phases can be executed in any order, but the recommended sequence optimizes for highest-ROI-first. Every phase ends with a commit. Tests must pass after every task.

**Tech Stack:** Python 3.13, pytest, bash, Claude Code skills (SKILL.md), markdown prompts

---

## File Structure

### Phase 1 — Prompt Consolidation
- Move: `global/prompts/design-review/{claude,codex,gemini}/00-general.md` → `global/prompts/design-review/domains/00-general.md` (and all 11 other domain files)
- Move: `global/prompts/plan-review/{claude,codex,gemini}/00-general.md` → `global/prompts/plan-review/domains/00-general.md` (and all 9 other domain files)
- Keep: `global/prompts/design-review/{claude,codex,gemini}/agent.md` (these differ per agent)
- Keep: `global/prompts/plan-review/{claude,codex,gemini}/agent.md` (these differ per agent)
- Delete: 40 duplicate domain files (20 design-review + 20 plan-review)
- Modify: `scripts/plan_review_dispatch.py:93-118` — update `resolve_plan_prompt` to check `domains/` dir
- Modify: `scripts/design_to_plan_dispatch.py:115-135` — same pattern (uses `_load_prompt`)

### Phase 2 — Skill Compression
- Modify: `skill/stark-phase-execute/SKILL.md` — compress from 665 → ~350 lines
- Modify: `skill/stark-extract-docs/SKILL.md` — compress from 576 → ~350 lines
- Modify: `skill/stark-plan-to-tasks/SKILL.md` — compress from 563 → ~350 lines
- Modify: `skill/stark-housekeeping/SKILL.md` — compress from 555 → ~350 lines
- Modify: `skill/stark-session/SKILL.md` — compress from 553 → ~350 lines
- Modify: remaining 24 skills — strip "Mistakes to Avoid" sections, decorative formatting

### Phase 3 — Dispatcher Unification
- Create: `scripts/dispatcher_base.py` — shared base with config loading, agent dispatch, prompt resolution, finding parsing
- Modify: `scripts/multi_review.py` — import and use shared base
- Modify: `scripts/plan_review_dispatch.py` — import and use shared base
- Modify: `scripts/design_to_plan_dispatch.py` — import and use shared base
- Modify: `scripts/autopilot_dispatch.py` — import and use shared base
- Test: `scripts/test_multi_review.py`, `scripts/test_plan_review_dispatch.py`

### Phase 4 — Script Performance Fixes
- Modify: `scripts/multi_review.py:1001-1082` — cache config and spec context at `run_review_round` entry, pass to workers
- Modify: `scripts/multi_review.py:1418-1424` — replace silent `except Exception: pass` with logging
- Modify: `scripts/emit_queue.py:107-142` — use context manager for DB connections
- Modify: `scripts/multi_review.py:1042` — add queue depth guard to ThreadPoolExecutor

### Phase 5 — Config Cleanup
- Modify: `global/config.json` — remove null values, document feature flag interactions
- Modify: `automation/registry.json` — remove disabled triggers or mark them clearly

### Phase 6 — Codebase Hygiene
- Create: `scripts/archive/` — destination for stale modules
- Move: stale scripts to `scripts/archive/`
- Modify: `install.sh` — skip `archive/` during symlink setup

---

## Phase 1: Prompt Consolidation

Design-review and plan-review domain files are byte-identical across all 3 agents. 40 files are pure copies. This phase collapses them into shared `domains/` directories.

### Task 1.1: Verify Duplication and Create Shared Domain Directories

**Files:**
- Create: `global/prompts/design-review/domains/` (directory)
- Create: `global/prompts/plan-review/domains/` (directory)

- [ ] **Step 1: Verify all design-review domains are identical across agents**

```bash
cd /Users/aryeh/git/Evinced/stark-skills
for f in global/prompts/design-review/claude/[0-9]*.md; do
  base=$(basename "$f")
  diff -q "$f" "global/prompts/design-review/codex/$base" && \
  diff -q "$f" "global/prompts/design-review/gemini/$base"
done
```

Expected: All files identical (no diff output).

- [ ] **Step 2: Verify all plan-review domains are identical across agents**

```bash
for f in global/prompts/plan-review/claude/[0-9]*.md; do
  base=$(basename "$f")
  diff -q "$f" "global/prompts/plan-review/codex/$base" && \
  diff -q "$f" "global/prompts/plan-review/gemini/$base"
done
```

Expected: All files identical.

- [ ] **Step 3: Verify agent.md files DO differ**

```bash
diff global/prompts/design-review/claude/agent.md global/prompts/design-review/codex/agent.md
diff global/prompts/plan-review/claude/agent.md global/prompts/plan-review/codex/agent.md
```

Expected: Meaningful differences (agent name, strengths, severity calibration).

- [ ] **Step 4: Create shared domain directories**

```bash
mkdir -p global/prompts/design-review/domains
mkdir -p global/prompts/plan-review/domains
```

- [ ] **Step 5: Commit verification results**

```bash
git add -A && git commit -m "chore: create shared domain directories for prompt consolidation"
```

### Task 1.2: Move Design-Review Domains to Shared Directory

**Files:**
- Move: `global/prompts/design-review/claude/[0-9]*.md` → `global/prompts/design-review/domains/`
- Delete: `global/prompts/design-review/codex/[0-9]*.md`
- Delete: `global/prompts/design-review/gemini/[0-9]*.md`

- [ ] **Step 1: Copy claude's domain files to shared directory (they're the canonical copy)**

```bash
for f in global/prompts/design-review/claude/[0-9]*.md; do
  cp "$f" "global/prompts/design-review/domains/$(basename "$f")"
done
```

- [ ] **Step 2: Delete all per-agent domain copies**

```bash
rm global/prompts/design-review/claude/[0-9]*.md
rm global/prompts/design-review/codex/[0-9]*.md
rm global/prompts/design-review/gemini/[0-9]*.md
```

- [ ] **Step 3: Verify only agent.md remains in each agent directory**

```bash
ls global/prompts/design-review/claude/
ls global/prompts/design-review/codex/
ls global/prompts/design-review/gemini/
ls global/prompts/design-review/domains/
```

Expected: Each agent dir has only `agent.md`. Domains dir has 12 files (00-general through 11-test-plan).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: consolidate design-review domain prompts into shared domains/ directory

Eliminates 24 byte-identical duplicate files. Agent-specific preambles (agent.md) remain separate."
```

### Task 1.3: Move Plan-Review Domains to Shared Directory

**Files:**
- Move: `global/prompts/plan-review/claude/[0-9]*.md` → `global/prompts/plan-review/domains/`
- Delete: `global/prompts/plan-review/codex/[0-9]*.md`
- Delete: `global/prompts/plan-review/gemini/[0-9]*.md`

- [ ] **Step 1: Copy claude's domain files to shared directory**

```bash
for f in global/prompts/plan-review/claude/[0-9]*.md; do
  cp "$f" "global/prompts/plan-review/domains/$(basename "$f")"
done
```

- [ ] **Step 2: Delete all per-agent domain copies**

```bash
rm global/prompts/plan-review/claude/[0-9]*.md
rm global/prompts/plan-review/codex/[0-9]*.md
rm global/prompts/plan-review/gemini/[0-9]*.md
```

- [ ] **Step 3: Verify structure**

```bash
ls global/prompts/plan-review/claude/
ls global/prompts/plan-review/codex/
ls global/prompts/plan-review/gemini/
ls global/prompts/plan-review/domains/
```

Expected: Each agent dir has only `agent.md`. Domains dir has 10 files (00-general through 09-timeline).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: consolidate plan-review domain prompts into shared domains/ directory

Eliminates 20 byte-identical duplicate files."
```

### Task 1.4: Update plan_review_dispatch.py to Load from Shared Domains

**Files:**
- Modify: `scripts/plan_review_dispatch.py:93-118` (`resolve_plan_prompt`)
- Modify: `scripts/plan_review_dispatch.py:124-153` (`_discover_plan_domains`)
- Test: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Write failing test for shared-domain prompt loading**

Add a test to `scripts/test_plan_review_dispatch.py` that verifies prompts are loaded from `domains/` when no per-agent file exists:

```python
def test_resolve_plan_prompt_shared_domain(tmp_path):
    """Prompt resolution falls back to domains/ when no per-agent file exists."""
    # Set up: domains/01-completeness.md exists, but claude/01-completeness.md does not
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "01-completeness.md").write_text("shared completeness prompt")

    agent_dir = tmp_path / "claude"
    agent_dir.mkdir()
    (agent_dir / "agent.md").write_text("claude preamble")

    result = resolve_plan_prompt("claude", "01-completeness.md", global_prompts_dir=str(tmp_path))
    assert result == "shared completeness prompt"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_plan_review_dispatch.py::test_resolve_plan_prompt_shared_domain -v
```

Expected: FAIL — current code only checks `{agent}/{filename}`, not `domains/{filename}`.

- [ ] **Step 3: Update resolve_plan_prompt to check domains/ as fallback**

In `scripts/plan_review_dispatch.py`, modify `resolve_plan_prompt` (line 93):

```python
def resolve_plan_prompt(
    agent: str,
    filename: str,
    repo_dir: str | None = None,
    global_prompts_dir: str | None = None,
) -> str:
    """Resolve a plan review prompt file: repo → agent-specific → shared domains → empty.

    Resolution order:
        1. {repo_dir}/.code-review/plan-prompts/{agent}/{filename}
        2. {global_prompts_dir}/{agent}/{filename}
        3. {global_prompts_dir}/domains/{filename}
    """
    # Check repo-level override
    if repo_dir:
        repo_path = Path(repo_dir) / ".code-review" / "plan-prompts" / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()

    # Fall back to global agent-specific
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)
    agent_path = Path(global_prompts_dir) / agent / filename
    if agent_path.exists():
        return agent_path.read_text().strip()

    # Fall back to shared domains
    shared_path = Path(global_prompts_dir) / "domains" / filename
    if shared_path.exists():
        return shared_path.read_text().strip()

    return ""
```

- [ ] **Step 4: Update _discover_plan_domains to also scan domains/ directory**

In `scripts/plan_review_dispatch.py`, modify `_discover_plan_domains` (line 124):

```python
def _discover_plan_domains(
    global_prompts_dir: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover plan review domains from prompt files.

    Scans agent directories first, then falls back to shared domains/ directory.
    """
    if global_prompts_dir is None:
        global_prompts_dir = str(GLOBAL_PROMPTS_DIR)

    prompts_path = Path(global_prompts_dir)
    domains: dict[str, dict[str, Any]] = {}

    # Check agent directories first (for backward compat with per-agent prompts)
    for agent in AGENTS:
        agent_dir = prompts_path / agent
        if not agent_dir.exists():
            continue
        for f in sorted(agent_dir.glob("[0-9]*.md")):
            key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
            if key not in domains:
                domains[key] = {
                    "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                    "label": key.replace("-", " ").title(),
                    "filename": f.name,
                }
        if domains:
            break

    # Fall back to shared domains/ directory
    if not domains:
        shared_dir = prompts_path / "domains"
        if shared_dir.exists():
            for f in sorted(shared_dir.glob("[0-9]*.md")):
                key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
                if key not in domains:
                    domains[key] = {
                        "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                        "label": key.replace("-", " ").title(),
                        "filename": f.name,
                    }

    return domains
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_plan_review_dispatch.py -v
```

Expected: All tests pass, including the new shared-domain test.

- [ ] **Step 6: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: plan_review_dispatch loads prompts from shared domains/ directory

Falls back to domains/{filename} when no per-agent file exists.
Backward compatible — per-agent files still take priority."
```

### Task 1.5: Update design_to_plan_dispatch.py for Shared Domains

The design-to-plan dispatcher also loads from per-agent directories for design-review prompts when used in cross-review mode. It uses `_load_prompt` (line 115) and `_get_prompts_dir` (line 75).

**Files:**
- Modify: `scripts/design_to_plan_dispatch.py:115-135` (`_load_prompt`)

- [ ] **Step 1: Read the current _load_prompt function**

Read `scripts/design_to_plan_dispatch.py:115-135` to understand the current loading pattern.

- [ ] **Step 2: Add shared domains/ fallback to _load_prompt**

The `_load_prompt` function should check `{prompts_dir}/domains/{filename}` as a fallback after checking `{prompts_dir}/{agent}/{filename}`:

```python
def _load_prompt(
    agent: str,
    filename: str,
    prompts_dir: str | None = None,
) -> str:
    """Load a prompt file: agent-specific → shared domains → empty."""
    base = _get_prompts_dir(prompts_dir)

    # Agent-specific prompt
    agent_path = base / agent / filename
    if agent_path.exists():
        return agent_path.read_text().strip()

    # Shared domain prompt
    shared_path = base / "domains" / filename
    if shared_path.exists():
        return shared_path.read_text().strip()

    return ""
```

- [ ] **Step 3: Run existing tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_plan_review_dispatch.py test_multi_review.py -v
```

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/design_to_plan_dispatch.py
git commit -m "feat: design_to_plan_dispatch loads from shared domains/ directory"
```

### Task 1.6: Update multi_review.py Domain Discovery for Consistency

The PR review prompts (global/prompts/claude/, codex/, gemini/) intentionally differ per agent and should NOT be consolidated. But `_discover_domains` (line 200) and `_load_domain_prompt` (line 516) should be updated to also support a `domains/` fallback for future consistency.

**Files:**
- Modify: `scripts/multi_review.py:516-533` (`_load_domain_prompt`)

- [ ] **Step 1: Add domains/ fallback to _load_domain_prompt**

The function already has a cross-agent fallback (lines 524-532). Insert a `domains/` check before that fallback:

```python
def _load_domain_prompt(agent: str, domain_key: str, cwd: str | None = None) -> str:
    """Load the domain-specific review prompt for a given agent."""
    domain = DOMAINS.get(domain_key)
    if not domain:
        return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"

    # 1. Agent-specific prompt (with repo override chain)
    content = resolve_prompt(agent, domain["filename"], cwd=cwd)
    if content:
        return content

    # 2. Shared domains/ directory
    shared_path = GLOBAL_PROMPTS_DIR / "domains" / domain["filename"]
    if shared_path.exists():
        content = shared_path.read_text().strip()
        if content:
            return content

    # 3. Cross-agent fallback
    for fallback_agent in AGENTS:
        if fallback_agent == agent:
            continue
        content = resolve_prompt(fallback_agent, domain["filename"], cwd=cwd)
        if content:
            print(
                f"  [!] Using {fallback_agent}'s prompt for {agent}/{domain_key}", file=sys.stderr
            )
            return content

    return f"Review this code for {domain_key} issues. {FINDINGS_FORMAT}"
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_multi_review.py -v
```

- [ ] **Step 3: Commit**

```bash
git add scripts/multi_review.py
git commit -m "feat: multi_review supports shared domains/ prompt directory

PR review prompts remain per-agent by design. This adds domains/ as a
fallback before cross-agent fallback, for consistency with other dispatchers."
```

### Task 1.7: End-to-End Verification

- [ ] **Step 1: Verify prompt counts**

```bash
echo "=== Design review structure ==="
find global/prompts/design-review -name "*.md" | sort
echo "=== Plan review structure ==="
find global/prompts/plan-review -name "*.md" | sort
echo "=== PR review (unchanged) ==="
find global/prompts/claude global/prompts/codex global/prompts/gemini -name "*.md" 2>/dev/null | wc -l
```

Expected:
- Design review: 3 agent.md + 12 domain files = 15 (was 39)
- Plan review: 3 agent.md + 10 domain files = 13 (was 33)
- PR review: unchanged (30 files)

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -x -v
```

- [ ] **Step 3: Commit any remaining changes**

---

## Phase 2: Skill Compression

The top 5 skills average 38-42% instruction, 58-62% boilerplate. This phase compresses each by removing embedded bash blocks, "Mistakes to Avoid" sections, redundant tables, decorative formatting, and excessive examples. Target: ~50% reduction for top 5, ~10-15% reduction for the rest.

### Task 2.1: Compress stark-phase-execute (665 → ~350 lines)

This is the worst offender: 42% instruction, 58% boilerplate, 28 inline bash blocks.

**Files:**
- Modify: `skill/stark-phase-execute/SKILL.md`

- [ ] **Step 1: Read the full skill**

Read `skill/stark-phase-execute/SKILL.md` in its entirety.

- [ ] **Step 2: Apply compression rules**

Apply these specific cuts:

1. **Remove "Mistakes to Avoid" section** (lines ~646-661, 16 lines). These warnings are already implicit in the phase instructions. Delete the entire section.

2. **Compress repeated git state checks** (lines ~17-24, ~43-50, ~104-111, ~228-235). The same `git status` / `git diff` / `git log` pattern appears 4 times. Keep the first occurrence and replace the other 3 with a one-liner: "Run the standard git state check (status, diff, log)."

3. **Compress bash blocks into pseudocode**. For each inline bash block longer than 5 lines, replace with a concise description of what the command does and the expected output. Keep exact script paths and arguments — only remove the multi-line shell quoting and pipe chains the LLM can construct on its own.

4. **Merge the 3 separate "update project board" sections** (~§2.2, ~§3.5, ~§5.2) into a single "Project Board Updates" reference at the end, listing which phases trigger board updates.

5. **Remove decorative ASCII formatting** — replace ASCII table headers with plain markdown headers.

6. **Compress Phase 2 (Regression Testing, lines ~509-533) and Phase 4 (Dashboard, lines ~579-582)**. Phase 4 is only 4 lines — fold it into the Phase 5 housekeeping section.

- [ ] **Step 3: Verify the compressed skill is coherent**

Read through the compressed result. Every phase must still have: clear entry condition, action steps with script paths, exit condition. No instruction should have been lost — only verbosity.

- [ ] **Step 4: Commit**

```bash
git add skill/stark-phase-execute/SKILL.md
git commit -m "refactor: compress stark-phase-execute from 665 to ~350 lines

Remove Mistakes to Avoid, deduplicate git state checks, compress bash to
pseudocode, merge project board update sections, remove decorative formatting."
```

### Task 2.2: Compress stark-extract-docs (576 → ~350 lines)

38% instruction, 62% boilerplate. 16 inline bash blocks.

**Files:**
- Modify: `skill/stark-extract-docs/SKILL.md`

- [ ] **Step 1: Read the full skill**

Read `skill/stark-extract-docs/SKILL.md`.

- [ ] **Step 2: Apply compression rules**

1. **Remove "Mistakes to Avoid" section** (lines ~566-576, 11 lines).

2. **Compress the 3 generation template blocks** (lines ~273-309 architecture docs, ~312-341 risk docs, ~344-372 decision docs). These follow an identical pattern. Define the template pattern once, then list the 3 variants as a table:

```markdown
| Type | Template | Key Sections |
|------|----------|-------------|
| Architecture | API ref, data model, system diagram | Components, interfaces, constraints |
| Risk | Runbook, incident handling | Failure modes, mitigations, escalation |
| Decision | ADR format | Context, decision, consequences |
```

3. **Compress artifact loading** (lines ~71-85, ~456-470). Same pattern repeated. Define once, reference.

4. **Compress example outputs** from multiple full examples to one annotated short example.

5. **Remove observability boilerplate** that is identical to other skills — keep only the skill-specific metric fields.

- [ ] **Step 3: Verify and commit**

```bash
git add skill/stark-extract-docs/SKILL.md
git commit -m "refactor: compress stark-extract-docs from 576 to ~350 lines"
```

### Task 2.3: Compress stark-plan-to-tasks (563 → ~350 lines)

37% instruction, 63% boilerplate, 12.4% internal redundancy.

**Files:**
- Modify: `skill/stark-plan-to-tasks/SKILL.md`

- [ ] **Step 1: Read the full skill**

Read `skill/stark-plan-to-tasks/SKILL.md`.

- [ ] **Step 2: Apply compression rules**

1. **Remove "Mistakes to Avoid" section** (lines ~528-540, 13 lines).

2. **Deduplicate the LLM dispatch pattern** (lines ~104-165, ~202-230). Two places call the dispatch script with near-identical invocation. Extract the common pattern into a "Dispatch Convention" box at the top, then reference it.

3. **Deduplicate issue creation loops** (lines ~375-410, ~429-450). Same `gh issue create` pattern with minor variations. Define the template once.

4. **Compress file validation pattern** (lines ~35-67). Standard across skills — replace with a concise one-liner referencing the preflight.

5. **Compress the Failure Modes table** (lines ~542-563) — keep only non-obvious modes.

- [ ] **Step 3: Verify and commit**

```bash
git add skill/stark-plan-to-tasks/SKILL.md
git commit -m "refactor: compress stark-plan-to-tasks from 563 to ~350 lines"
```

### Task 2.4: Compress stark-housekeeping (555 → ~350 lines)

50% instruction, 50% boilerplate, 19.8% internal redundancy (highest).

**Files:**
- Modify: `skill/stark-housekeeping/SKILL.md`

- [ ] **Step 1: Read the full skill**

Read `skill/stark-housekeeping/SKILL.md`.

- [ ] **Step 2: Apply compression rules**

1. **Remove "Mistakes to Avoid" section** (lines ~545-556, 12 lines).

2. **Extract the repeated query+confirmation pattern** (lines ~42-85, ~140-175, ~241-270). Three phases all follow: query GitHub → display table → ask confirmation → batch operate. Define this pattern once as a "Cleanup Phase Template" and reference it from each phase with only the phase-specific parameters (query, action, confirmation message).

3. **Compress batch operation patterns** (lines ~88-137, ~178-238, ~273-303). Same report pattern. Define once.

4. **Compress bash blocks** — 22 inline bash blocks. Most are simple `gh` commands that the LLM can construct from a description. Replace multi-line blocks with one-liner descriptions keeping the key arguments.

- [ ] **Step 3: Verify and commit**

```bash
git add skill/stark-housekeeping/SKILL.md
git commit -m "refactor: compress stark-housekeeping from 555 to ~350 lines"
```

### Task 2.5: Compress stark-session (553 → ~350 lines)

38% instruction, 62% boilerplate, 11.7% internal redundancy.

**Files:**
- Modify: `skill/stark-session/SKILL.md`

- [ ] **Step 1: Read the full skill**

Read `skill/stark-session/SKILL.md`.

- [ ] **Step 2: Apply compression rules**

1. **Remove "Mistakes to Avoid" section** (lines ~545-553, 9 lines).

2. **Compress repeated git state checks** (lines ~31-45, ~73-84, ~97-111). Three occurrences of the same pattern. Keep the first, replace others with references.

3. **Compress the parallel start/end mode structure**. Start mode (317 lines) and end mode (154 lines) share similar patterns for test execution, merge decisions, and cleanup. Extract shared patterns into a "Session Phase Template" and have start/end modes reference it with their specific parameters.

4. **Compress bash blocks** — 24 inline blocks. Replace multi-line blocks with concise descriptions.

5. **Remove observability boilerplate** that duplicates other skills.

- [ ] **Step 3: Verify and commit**

```bash
git add skill/stark-session/SKILL.md
git commit -m "refactor: compress stark-session from 553 to ~350 lines"
```

### Task 2.6: Strip Boilerplate from Remaining 24 Skills

**Files:**
- Modify: All remaining `skill/stark-*/SKILL.md` files

- [ ] **Step 1: For each skill that has a "Mistakes to Avoid" section, remove it**

Search all skills:
```bash
grep -l "Mistakes to Avoid\|Common Mistakes\|Pitfalls" skill/stark-*/SKILL.md
```

For each match, delete the section. Fold any genuinely non-obvious warning into the relevant phase as a single-line "Warning:" note.

- [ ] **Step 2: Remove decorative formatting across all skills**

Search for and remove:
- ASCII art dividers (`═══`, `───`, `╔══`, etc.)
- Emoji headers used purely for decoration (keep functional emoji like status indicators)
- Excessive blank lines (more than 1 consecutive)

- [ ] **Step 3: Compress observability boilerplate**

Many skills have a near-identical "Observability" section at the end (task creation, timestamped logs, metrics block, event emission). For skills where this section is >15 lines and identical to the standard pattern, replace with:

```markdown
## Observability
Follow the standard observability pattern: create tasks, emit timestamped logs, record metrics block, emit completion event.
```

- [ ] **Step 4: Run a line count comparison**

```bash
wc -l skill/stark-*/SKILL.md | sort -rn
```

Target: Total should be ~5,500-6,000 lines (down from 8,249).

- [ ] **Step 5: Commit**

```bash
git add skill/
git commit -m "refactor: strip boilerplate from 24 skills

Remove Mistakes to Avoid sections, decorative formatting, and redundant
observability boilerplate. Total SKILL.md lines reduced from ~8,249 to ~5,800."
```

---

## Phase 3: Dispatcher Unification

Four dispatcher scripts share ~70% code: config loading, agent iteration, prompt resolution, ThreadPoolExecutor dispatch, finding/output parsing, and GitHub API integration. This phase extracts the shared patterns into a base module.

### Task 3.1: Map Shared Patterns Across Dispatchers

- [ ] **Step 1: Identify the shared function signatures**

Read the function lists of all 4 dispatchers and identify functions that appear in 2+ scripts with near-identical signatures:

| Pattern | multi_review.py | plan_review_dispatch.py | design_to_plan_dispatch.py | autopilot_dispatch.py |
|---------|----------------|------------------------|---------------------------|---------------------|
| Config loading | `discover_config` (173) | `_load_plan_review_config` (159) | uses `config_loader` import | uses `config_loader` import |
| Prompt resolution | `resolve_prompt` (489) | `resolve_plan_prompt` (93) | `_load_prompt` (115) | inline |
| Domain discovery | `_discover_domains` (200) | `_discover_plan_domains` (124) | N/A | N/A |
| Model resolution | `_resolve_model` (125) | N/A | `_resolve_model` (65) | similar |
| Agent env/cmd build | `_run_subagent_inner` (777) | `_run_plan_subagent` (264) | `_build_cmd_and_kwargs` (165) | similar |
| Finding parsing | `_parse_findings` (668) | `_parse_plan_findings` (207) | `_parse_cross_review` (405) | N/A |

- [ ] **Step 2: Document the extraction plan**

The shared base should contain:
1. `resolve_model(agent)` — shared model resolution
2. `discover_config(cwd, global_dir)` — hierarchical config (already in multi_review.py, most complete)
3. `discover_domains(prompts_dir)` — scan for `[0-9]*.md` files, return domain dict
4. `resolve_prompt(agent, filename, prompts_dir)` — agent → domains/ → empty fallback
5. `build_agent_command(agent, prompt, ...)` — construct CLI command for claude/codex/gemini
6. `run_agent_subprocess(cmd, timeout, env, ...)` — execute with timeout and error capture
7. `parse_json_findings(raw_output, agent)` — extract JSON array from LLM output

### Task 3.2: Create dispatcher_base.py with Config and Prompt Loading

**Files:**
- Create: `scripts/dispatcher_base.py`
- Test: `scripts/test_dispatcher_base.py`

- [ ] **Step 1: Write failing tests for shared config and prompt loading**

Create `scripts/test_dispatcher_base.py`:

```python
"""Tests for shared dispatcher base module."""
import json
from pathlib import Path

from dispatcher_base import discover_config, resolve_prompt, discover_domains, resolve_model


def test_discover_config_defaults(tmp_path):
    """Returns defaults when no config files exist."""
    cfg = discover_config(cwd=str(tmp_path), global_dir=str(tmp_path))
    assert cfg["agents"] == ["claude", "codex", "gemini"]
    assert cfg["fix_threshold"] == "medium"


def test_discover_config_merges_layers(tmp_path):
    """Repo config overrides global config."""
    global_dir = tmp_path / "global"
    global_dir.mkdir()
    (global_dir / "config.json").write_text(json.dumps({"fix_threshold": "low"}))

    repo_dir = tmp_path / "repo"
    cr_dir = repo_dir / ".code-review"
    cr_dir.mkdir(parents=True)
    (cr_dir / "config.json").write_text(json.dumps({"fix_threshold": "high"}))

    cfg = discover_config(cwd=str(repo_dir), global_dir=str(global_dir))
    assert cfg["fix_threshold"] == "high"


def test_resolve_prompt_shared_domains(tmp_path):
    """Falls back to domains/ when no per-agent file exists."""
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "01-arch.md").write_text("shared arch prompt")

    result = resolve_prompt("claude", "01-arch.md", prompts_dir=str(tmp_path))
    assert result == "shared arch prompt"


def test_resolve_prompt_agent_takes_priority(tmp_path):
    """Agent-specific prompt wins over shared domain."""
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "01-arch.md").write_text("shared")

    agent_dir = tmp_path / "claude"
    agent_dir.mkdir()
    (agent_dir / "01-arch.md").write_text("claude-specific")

    result = resolve_prompt("claude", "01-arch.md", prompts_dir=str(tmp_path))
    assert result == "claude-specific"


def test_discover_domains_from_shared(tmp_path):
    """Discovers domains from shared domains/ directory."""
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "01-architecture.md").write_text("arch")
    (domains_dir / "02-security.md").write_text("sec")

    domains = discover_domains(str(tmp_path))
    assert "architecture" in domains
    assert "security" in domains
    assert domains["architecture"]["filename"] == "01-architecture.md"


def test_resolve_model_defaults():
    """Returns default model IDs when no config override."""
    assert "claude" in resolve_model("claude")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_dispatcher_base.py -v
```

Expected: ImportError — `dispatcher_base` doesn't exist yet.

- [ ] **Step 3: Extract shared code into dispatcher_base.py**

Create `scripts/dispatcher_base.py`. Extract from `multi_review.py`:
- `DEFAULT_CONFIG` dict (line 104)
- `REPLACE_FIELDS`, `ADDITIVE_FIELDS`, `DEEP_MERGE_FIELDS` (lines 134-144)
- `_deep_merge` (line 147)
- `_find_config_chain` (line 157)
- `discover_config` (line 173)
- `_resolve_model` (line 125)

Add new shared functions:
- `resolve_prompt(agent, filename, prompts_dir)` — with domains/ fallback
- `discover_domains(prompts_dir)` — scan agent dirs then domains/

```python
"""Shared dispatcher base — config, prompt, and domain resolution.

Used by multi_review.py, plan_review_dispatch.py, design_to_plan_dispatch.py,
and autopilot_dispatch.py to avoid duplicating config loading, prompt
resolution, and domain discovery logic.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from claude_utils import build_claude_cmd, make_clean_env
from codex_utils import CODEX_MODEL, CODEX_REASONING_EFFORT_HIGH, parse_jsonl_output
from gemini_utils import GEMINI_MODEL, setup_gemini_home, make_gemini_env

try:
    from config_loader import get_model_id as _config_get_model_id, is_agent_enabled
except ImportError:
    def _config_get_model_id(agent: str) -> str | None:
        return None
    def is_agent_enabled(agent: str) -> bool:
        return True


# ── Config defaults ───────────────────────────────────────────────────

DEFAULT_CONFIG: dict[str, Any] = {
    "agents": ["claude", "codex", "gemini"],
    "fix_threshold": "medium",
    "test_command": None,
    "build_command": None,
    "verify_before_clean": True,
    "disabled_domains": [],
    "extra_domains": [],
    "context_files": [],
    "domain_agents": {},
    "severity_overrides": {},
    "github_apps": {
        "claude": "stark-claude",
        "codex": "stark-codex",
        "gemini": "stark-gemini",
    },
}

REPLACE_FIELDS = {
    "agents", "fix_threshold", "test_command", "build_command",
    "verify_before_clean", "disabled_domains", "context_files",
}
ADDITIVE_FIELDS = {"extra_domains"}
DEEP_MERGE_FIELDS = {"severity_overrides", "github_apps", "domain_agents", "triage"}


def _deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def _find_config_chain(cwd: str, global_dir: str) -> list[Path]:
    """Walk from cwd up to ~ looking for .code-review/config.json, then global."""
    chain: list[Path] = []
    home = Path.home()
    current = Path(cwd).resolve()
    while current != home and current != current.parent:
        cfg = current / ".code-review" / "config.json"
        if cfg.exists():
            chain.append(cfg)
        current = current.parent
    global_cfg = Path(global_dir) / "config.json"
    if global_cfg.exists():
        chain.append(global_cfg)
    return chain


def discover_config(cwd: str | None = None, global_dir: str | None = None) -> dict:
    """Discover and merge config: repo -> org -> global."""
    if cwd is None:
        cwd = os.getcwd()
    if global_dir is None:
        global_dir = str(Path.home() / ".claude" / "code-review")
    chain = _find_config_chain(cwd, global_dir)
    merged = dict(DEFAULT_CONFIG)
    for cfg_path in reversed(chain):
        try:
            layer = json.loads(cfg_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for key, val in layer.items():
            if key in REPLACE_FIELDS:
                merged[key] = val
            elif key in ADDITIVE_FIELDS:
                existing = merged.get(key, [])
                merged[key] = list(set(existing) | set(val))
            elif key in DEEP_MERGE_FIELDS:
                merged[key] = _deep_merge(merged.get(key, {}), val)
            else:
                merged[key] = val
    return merged


# ── Model resolution ──────────────────────────────────────────────────

def resolve_model(agent: str) -> str:
    """Return the model ID for an agent, checking config then defaults."""
    if agent == "claude":
        return _config_get_model_id(agent) or "claude"
    if agent == "codex":
        return _config_get_model_id(agent) or CODEX_MODEL
    if agent == "gemini":
        return _config_get_model_id(agent) or GEMINI_MODEL
    raise ValueError(f"Unknown agent: {agent}")


# ── Prompt resolution ─────────────────────────────────────────────────

def resolve_prompt(
    agent: str,
    filename: str,
    prompts_dir: str | None = None,
    repo_dir: str | None = None,
    repo_subdir: str | None = None,
) -> str:
    """Resolve a prompt file: repo → agent-specific → shared domains → empty.

    Resolution order:
        1. {repo_dir}/.code-review/{repo_subdir}/{agent}/{filename}
        2. {prompts_dir}/{agent}/{filename}
        3. {prompts_dir}/domains/{filename}
    """
    if repo_dir and repo_subdir:
        repo_path = Path(repo_dir) / ".code-review" / repo_subdir / agent / filename
        if repo_path.exists():
            return repo_path.read_text().strip()

    if prompts_dir:
        agent_path = Path(prompts_dir) / agent / filename
        if agent_path.exists():
            return agent_path.read_text().strip()

        shared_path = Path(prompts_dir) / "domains" / filename
        if shared_path.exists():
            return shared_path.read_text().strip()

    return ""


# ── Domain discovery ──────────────────────────────────────────────────

def discover_domains(
    prompts_dir: str,
    agents: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover review domains from prompt files.

    Scans agent directories first, then shared domains/ directory.
    """
    if agents is None:
        agents = ["claude", "codex", "gemini"]

    prompts_path = Path(prompts_dir)
    domains: dict[str, dict[str, Any]] = {}

    # Check agent directories first
    for agent in agents:
        agent_dir = prompts_path / agent
        if not agent_dir.exists():
            continue
        for f in sorted(agent_dir.glob("[0-9]*.md")):
            key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
            if key not in domains:
                domains[key] = {
                    "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                    "label": key.replace("-", " ").title(),
                    "filename": f.name,
                }
        if domains:
            break

    # Fall back to shared domains/
    if not domains:
        shared_dir = prompts_path / "domains"
        if shared_dir.exists():
            for f in sorted(shared_dir.glob("[0-9]*.md")):
                key = f.stem.split("-", 1)[1] if "-" in f.stem else f.stem
                if key not in domains:
                    domains[key] = {
                        "order": f.stem.split("-")[0] if "-" in f.stem else "99",
                        "label": key.replace("-", " ").title(),
                        "filename": f.name,
                    }

    return domains
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_dispatcher_base.py -v
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/dispatcher_base.py scripts/test_dispatcher_base.py
git commit -m "feat: create dispatcher_base.py with shared config, prompt, and domain logic

Extracts config loading (discover_config), prompt resolution (resolve_prompt
with domains/ fallback), domain discovery (discover_domains), and model
resolution (resolve_model) from multi_review.py into a shared module."
```

### Task 3.3: Migrate multi_review.py to Use dispatcher_base

**Files:**
- Modify: `scripts/multi_review.py`
- Test: `scripts/test_multi_review.py`

- [ ] **Step 1: Replace duplicated code with imports from dispatcher_base**

In `scripts/multi_review.py`:

1. Add import: `from dispatcher_base import discover_config, resolve_model, resolve_prompt as _base_resolve_prompt, discover_domains as _base_discover_domains`

2. Delete the local copies of: `DEFAULT_CONFIG` (line 104), `REPLACE_FIELDS`/`ADDITIVE_FIELDS`/`DEEP_MERGE_FIELDS` (lines 134-144), `_deep_merge` (line 147), `_find_config_chain` (line 157), `discover_config` (line 173), `_resolve_model` (line 125).

3. Keep `resolve_prompt` (line 489) as a thin wrapper that adds the cwd-based directory walk (repo → org → global) on top of `_base_resolve_prompt`. This is the only PR-review-specific behavior.

4. Keep `_discover_domains` (line 200) but delegate to `_base_discover_domains` internally.

- [ ] **Step 2: Run existing tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_multi_review.py -v
```

Expected: All pass — behavior is identical.

- [ ] **Step 3: Commit**

```bash
git add scripts/multi_review.py
git commit -m "refactor: multi_review.py delegates config and model resolution to dispatcher_base

Removes ~80 lines of duplicated config loading logic."
```

### Task 3.4: Migrate plan_review_dispatch.py to Use dispatcher_base

**Files:**
- Modify: `scripts/plan_review_dispatch.py`
- Test: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Replace local config/prompt/domain code with dispatcher_base imports**

1. Replace `resolve_plan_prompt` (line 93) with a thin wrapper around `dispatcher_base.resolve_prompt`.
2. Replace `_discover_plan_domains` (line 124) with `dispatcher_base.discover_domains`.
3. Replace `_load_plan_review_config` (line 159) with `dispatcher_base.discover_config` + section extraction.

- [ ] **Step 2: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_plan_review_dispatch.py -v
```

- [ ] **Step 3: Commit**

```bash
git add scripts/plan_review_dispatch.py
git commit -m "refactor: plan_review_dispatch delegates to dispatcher_base

Removes ~60 lines of duplicated config/prompt/domain loading."
```

### Task 3.5: Migrate design_to_plan_dispatch.py to Use dispatcher_base

**Files:**
- Modify: `scripts/design_to_plan_dispatch.py`

- [ ] **Step 1: Replace local code with dispatcher_base imports**

1. Replace `_resolve_model` (line 65) with `dispatcher_base.resolve_model`.
2. Replace `_load_prompt` (line 115) with a thin wrapper around `dispatcher_base.resolve_prompt`.
3. Import `is_agent_enabled` from `dispatcher_base` instead of local fallback.

- [ ] **Step 2: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -v
```

- [ ] **Step 3: Commit**

```bash
git add scripts/design_to_plan_dispatch.py
git commit -m "refactor: design_to_plan_dispatch delegates to dispatcher_base"
```

### Task 3.6: Migrate autopilot_dispatch.py to Use dispatcher_base

**Files:**
- Modify: `scripts/autopilot_dispatch.py`

- [ ] **Step 1: Read autopilot_dispatch.py and identify shared patterns**

Read `scripts/autopilot_dispatch.py` in full. Identify which local functions duplicate dispatcher_base.

- [ ] **Step 2: Replace duplicated code with dispatcher_base imports**

Same pattern as previous migrations: replace model resolution, config loading, agent enablement checks.

- [ ] **Step 3: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -v
```

- [ ] **Step 4: Commit**

```bash
git add scripts/autopilot_dispatch.py
git commit -m "refactor: autopilot_dispatch delegates to dispatcher_base"
```

---

## Phase 4: Script Performance Fixes

Critical performance and reliability issues in the orchestrator scripts.

### Task 4.1: Cache Config and Spec Context in run_review_round

Currently, `discover_config` is called inside `run_review_round` (line 1015) and each sub-agent independently re-reads prompt files. The spec context is passed to all 27 workers as the same string.

**Files:**
- Modify: `scripts/multi_review.py:1001-1082`

- [ ] **Step 1: Write a test verifying config is loaded once**

Add to `scripts/test_multi_review.py`:

```python
def test_config_loaded_once_per_round(monkeypatch, tmp_path):
    """discover_config is called exactly once per review round, not per sub-agent."""
    call_count = 0
    original = discover_config

    def counting_discover(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    monkeypatch.setattr("multi_review.discover_config", counting_discover)
    # ... invoke run_review_round with mocked agents ...
    assert call_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Current code calls `discover_config` once in `run_review_round`, but prompt loading inside each worker triggers additional config-dependent file I/O. Verify baseline.

- [ ] **Step 3: Pre-load prompts and pass to workers**

Modify `run_review_round` to pre-load all prompts before entering the ThreadPoolExecutor:

```python
def run_review_round(...) -> ReviewRound:
    config = discover_config(cwd=cwd)
    # ... agent/domain setup ...

    # Pre-load all prompts (avoids per-worker file I/O)
    prompt_cache: dict[tuple[str, str], str] = {}
    for agent in agents:
        preamble = _load_agent_preamble(agent, cwd=cwd)
        prompt_cache[(agent, "__preamble__")] = preamble
        for domain_key in domains:
            prompt_cache[(agent, domain_key)] = _load_domain_prompt(agent, domain_key, cwd=cwd)

    # Pass prompt_cache to _run_subagent via a new parameter
    with ThreadPoolExecutor(max_workers=min(total, _max_worker_budget())) as pool:
        ...
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_multi_review.py -v
```

- [ ] **Step 5: Commit**

```bash
git add scripts/multi_review.py scripts/test_multi_review.py
git commit -m "perf: pre-load prompts before worker dispatch in run_review_round

Eliminates per-worker file I/O. Prompts are loaded once and passed to all
sub-agents via a cache dict."
```

### Task 4.2: Fix Silent Exception Swallowing

**Files:**
- Modify: `scripts/multi_review.py:1418-1424`

- [ ] **Step 1: Find all bare `except Exception: pass` patterns**

```bash
grep -n "except.*:.*pass\|except Exception" scripts/multi_review.py
```

- [ ] **Step 2: Replace each with logged exceptions**

For `_emit_event` (line 1418):

```python
def _emit_event(event: dict) -> None:
    """Best-effort enqueue to the durable insights queue."""
    try:
        from emit_queue import enqueue
        enqueue(event)
    except Exception as exc:
        print(f"  [!] Failed to emit event: {exc}", file=sys.stderr)
```

For any other bare `except: pass` in worker threads, add `sys.stderr` logging so failures are visible in the review output.

- [ ] **Step 3: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_multi_review.py -v
```

- [ ] **Step 4: Commit**

```bash
git add scripts/multi_review.py
git commit -m "fix: replace silent exception swallowing with stderr logging

Bare 'except Exception: pass' patterns now log the error to stderr.
Failures in event emission and worker threads are visible in review output."
```

### Task 4.3: Fix emit_queue.py Connection Management

**Files:**
- Modify: `scripts/emit_queue.py:107-142`
- Test: `scripts/test_emit_queue.py`

- [ ] **Step 1: Read the current connection pattern**

`_get_db()` (line 107) creates a new connection every call. Some callers (like `drain`, line 165) use try/finally to close, but `enqueue` (line 145) also uses try/finally. The issue is that `_get_db()` runs the full schema creation every time.

- [ ] **Step 2: Add connection reuse with schema-init guard**

```python
_db_initialized: set[str] = set()

def _get_db() -> sqlite3.Connection:
    """Open (and initialize if needed) the queue database."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    db_path = str(QUEUE_DB)
    db = sqlite3.connect(db_path, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    if db_path not in _db_initialized:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS pending ( ... );
            CREATE TABLE IF NOT EXISTS dead_letter ( ... );
            CREATE INDEX IF NOT EXISTS idx_pending_created ON pending(created_at);
            CREATE TABLE IF NOT EXISTS inflight ( ... );
            CREATE TABLE IF NOT EXISTS session_stats ( ... );
        """)
        _db_initialized.add(db_path)
    return db
```

This avoids re-running DDL on every connection while keeping the connection-per-call pattern (which is fine for SQLite).

- [ ] **Step 3: Run tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest test_emit_queue.py -v
```

- [ ] **Step 4: Commit**

```bash
git add scripts/emit_queue.py
git commit -m "perf: skip redundant DDL on repeated emit_queue connections

Track which DB paths have been initialized. Schema creation runs once per
process lifetime, not on every _get_db() call."
```

### Task 4.4: Add Queue Depth Guard to ThreadPoolExecutor

**Files:**
- Modify: `scripts/multi_review.py:1042`

- [ ] **Step 1: Read the current _max_worker_budget function**

Read `scripts/multi_review.py:441-448`.

- [ ] **Step 2: Enforce a hard cap**

The `runtime.max_concurrent_agents` config value (default 3) should be respected as a hard ceiling. Currently `_max_worker_budget` returns this value, but `min(total, _max_worker_budget())` can still be up to 27 if total=27 and budget=27.

Verify `_max_worker_budget` actually reads from config:

```python
def _max_worker_budget() -> int:
    """Max concurrent sub-agent workers."""
    try:
        cfg = discover_config()
        return cfg.get("runtime", {}).get("max_concurrent_agents", 3)
    except Exception:
        return 3
```

If it already caps at 3 from config, this is fine. If not, enforce it. The config says `max_concurrent_agents: 3`, so at most 3 workers run at once, and the other 24 queue up. This is correct behavior.

- [ ] **Step 3: Commit if changes made, skip if already correct**

### Task 4.5: Run Full Test Suite

- [ ] **Step 1: Run all tests**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -x -v 2>&1 | tail -30
```

- [ ] **Step 2: Fix any failures**

- [ ] **Step 3: Final commit for Phase 4**

```bash
git add -A && git commit -m "test: verify all performance fixes pass full test suite"
```

---

## Phase 5: Config Cleanup

Clean up `global/config.json` — remove null values, dead config, and document interactions.

### Task 5.1: Remove Null and Unused Config Values

**Files:**
- Modify: `global/config.json`

- [ ] **Step 1: Remove null values that are never consumed**

Remove these keys from `global/config.json`:

```json
"test_command": null,     // line 15 — never consumed by any script
"build_command": null,    // line 16 — never consumed
```

Also remove the duplicates inside the `session` block:

```json
"session": {
    "build_command": null,   // line 29 — duplicate of top-level
    "test_command": null,    // line 30 — duplicate of top-level
    "devlog_path": null,     // line 32 — never consumed
}
```

- [ ] **Step 2: Verify no script reads these keys**

```bash
grep -rn "test_command\|build_command\|devlog_path" scripts/*.py | grep -v test_ | grep -v __pycache__
```

Expected: No hits (or only default-dict accesses that handle missing keys).

- [ ] **Step 3: Commit**

```bash
git add global/config.json
git commit -m "chore: remove null/unused config values from config.json

test_command, build_command, devlog_path were defined but never consumed."
```

### Task 5.2: Clean Up Automation Triggers

**Files:**
- Modify: `global/config.json` (automation.triggers section)

- [ ] **Step 1: Verify which triggers are actually registered**

```bash
cat automation/registry.json 2>/dev/null | python3 -m json.tool | head -40
```

- [ ] **Step 2: Add comments/documentation for trigger tiers**

The config has 12 triggers across 4 tiers but no documentation of what the tiers mean or what happens when triggers overlap. Add a `_tier_docs` field (ignored by parsers) or create a companion doc.

Since JSON doesn't support comments, create `global/config-reference.md` documenting the trigger tiers, budget interactions, and feature flag dependency matrix. This is reference documentation that lives alongside the config.

- [ ] **Step 3: Commit**

```bash
git add global/config.json global/config-reference.md
git commit -m "docs: add config reference documenting trigger tiers and feature flag interactions"
```

---

## Phase 6: Codebase Hygiene

Archive stale scripts, clean up dead code.

### Task 6.1: Identify Actually-Stale Modules

Not all "unreferenced by SKILL.md" modules are stale. Utility modules (claude_utils.py, codex_utils.py, etc.) are imported by dispatchers. Test files are expected to be unreferenced. The truly stale modules are those that are neither imported by any active script nor have active test coverage.

**Files:**
- Create: `scripts/archive/` (directory)

- [ ] **Step 1: Find modules not imported by any active script**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts

# For each non-test Python file, check if it's imported anywhere
for f in *.py; do
  [[ "$f" == test_* ]] && continue
  [[ "$f" == conftest* ]] && continue
  module="${f%.py}"
  count=$(grep -rl "import $module\|from $module" *.py 2>/dev/null | grep -v "test_" | grep -v "$f" | wc -l)
  if [ "$count" -eq 0 ]; then
    echo "ORPHAN: $f ($(wc -l < "$f") lines) — not imported by any non-test script"
  fi
done
```

- [ ] **Step 2: Cross-reference with SKILL.md references**

```bash
for f in *.py; do
  [[ "$f" == test_* ]] && continue
  base="${f%.py}"
  skill_refs=$(grep -rl "$base\|$f" ../skill/stark-*/SKILL.md 2>/dev/null | wc -l)
  script_refs=$(grep -rl "import $base\|from $base" *.py 2>/dev/null | grep -v test_ | grep -v "$f" | wc -l)
  if [ "$skill_refs" -eq 0 ] && [ "$script_refs" -eq 0 ]; then
    echo "ARCHIVE CANDIDATE: $f ($( wc -l < "$f") lines)"
  fi
done
```

- [ ] **Step 3: Move confirmed stale modules to archive/**

```bash
mkdir -p scripts/archive
# Move each confirmed stale module (adjust list based on step 2 output)
# Likely candidates: analyze_shadow.py, backfill_history.py, dashboard.py,
# generate_persona_pages.py, learning_capture.py, setup_project.py,
# healer_canary.py, skill_router.py
```

- [ ] **Step 4: Move corresponding test files**

```bash
# For each archived module, move its test file too
# e.g., mv scripts/test_analyze_shadow.py scripts/archive/
```

- [ ] **Step 5: Verify nothing breaks**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -x -v 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: archive stale scripts to scripts/archive/

Modules that are neither imported by active scripts nor referenced by skills.
Kept in repo history. Can be restored if needed."
```

### Task 6.2: Update install.sh to Skip archive/

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Read the relevant section of install.sh**

Read `install.sh` to find where it symlinks the scripts/ directory.

- [ ] **Step 2: Verify the symlink approach**

The installer symlinks the entire `scripts/` directory (line 14-15: `~/.claude/code-review/scripts/ ← symlink to repo's scripts/`). Since it's a directory symlink, the archive/ subdirectory will be accessible but won't interfere — Python won't import from it unless explicitly told to.

No changes needed if the install is a directory symlink. If it symlinks individual files, add an exclusion for `archive/`.

- [ ] **Step 3: Commit if changes needed**

### Task 6.3: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/aryeh/git/Evinced/stark-skills/scripts
../.venv/bin/python3 -m pytest -v 2>&1 | tail -30
```

- [ ] **Step 2: Verify install still works**

```bash
./install.sh --status
```

- [ ] **Step 3: Count final metrics**

```bash
echo "=== SKILL.md lines ==="
wc -l skill/stark-*/SKILL.md | tail -1
echo "=== Prompt files ==="
find global/prompts -name "*.md" | wc -l
echo "=== Script lines (excluding archive and tests) ==="
wc -l scripts/*.py | tail -1
echo "=== Archived scripts ==="
ls scripts/archive/*.py 2>/dev/null | wc -l
```

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "chore: stark-skills optimization complete

Phase 1: Prompt consolidation — 40 duplicate files eliminated
Phase 2: Skill compression — top 5 skills cut ~45%, 24 others trimmed
Phase 3: Dispatcher unification — shared base extracts ~70% common code
Phase 4: Script performance — config caching, error logging, DB init guard
Phase 5: Config cleanup — null values removed, feature flags documented
Phase 6: Codebase hygiene — stale modules archived"
```

---

## Summary of Expected Outcomes

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| SKILL.md total lines | 8,249 | ~5,800 | -30% |
| Prompt files | 120 | ~80 | -33% |
| Duplicate prompt content | ~13,000 words | 0 | -100% |
| Dispatcher duplicated code | ~70% overlap | ~10% overlap | -86% |
| Silent exception handlers | 3+ | 0 | -100% |
| Config null values | 5 | 0 | -100% |
| Stale archived modules | 0 | ~8-12 | cleaner active codebase |
