# Design & Plan Review Split + Tournament Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `stark-review-plan` into two specialized skills (`stark-review-design` for architecture/spec docs, `stark-review-plan` for execution plans), fold `stark-review-deployment-plan` into the new plan review with adversarial improvements, and add `--tournament` mode to both skills.

**Architecture:** Each skill gets its own prompt directory (`global/prompts/design-review/`, `global/prompts/plan-review/`) with 10 domains × 3 agents = 30 prompts per skill. The existing `plan_review_dispatch.py` is parameterized to accept a prompt directory, so both skills reuse the same orchestrator. Tournament mode reuses the existing `tournament.py` evaluation engine but adds a new `evaluate_review` strategy for judging competing reviews. The `stark-review-deployment-plan` skill is deleted after its adversarial techniques are absorbed into plan-review domain prompts.

**Tech Stack:** Python (dispatch scripts), Markdown (SKILL.md, domain prompts), Bash (install.sh)

---

## File Structure

### New files

```
skill/stark-review-design/SKILL.md                    — New design review skill
global/prompts/design-review/claude/agent.md           — Claude agent preamble (design focus)
global/prompts/design-review/claude/00-general.md      — General design review
global/prompts/design-review/claude/01-completeness.md — Completeness
global/prompts/design-review/claude/02-security.md     — Security
global/prompts/design-review/claude/03-scope.md        — Scope / YAGNI
global/prompts/design-review/claude/04-api-design.md   — API contracts
global/prompts/design-review/claude/05-data-modeling.md — Data model / flow
global/prompts/design-review/claude/06-consistency.md  — Cross-section contradictions
global/prompts/design-review/claude/07-scalability.md  — Performance / scaling
global/prompts/design-review/claude/08-extensibility.md — Evolvability
global/prompts/design-review/claude/09-resilience.md   — Failure modes / blast radius
global/prompts/design-review/codex/agent.md            — Codex preamble
global/prompts/design-review/codex/00-general.md
global/prompts/design-review/codex/01-completeness.md
global/prompts/design-review/codex/02-security.md
global/prompts/design-review/codex/03-scope.md
global/prompts/design-review/codex/04-api-design.md
global/prompts/design-review/codex/05-data-modeling.md
global/prompts/design-review/codex/06-consistency.md
global/prompts/design-review/codex/07-scalability.md
global/prompts/design-review/codex/08-extensibility.md
global/prompts/design-review/codex/09-resilience.md
global/prompts/design-review/gemini/agent.md           — Gemini preamble
global/prompts/design-review/gemini/00-general.md
global/prompts/design-review/gemini/01-completeness.md
global/prompts/design-review/gemini/02-security.md
global/prompts/design-review/gemini/03-scope.md
global/prompts/design-review/gemini/04-api-design.md
global/prompts/design-review/gemini/05-data-modeling.md
global/prompts/design-review/gemini/06-consistency.md
global/prompts/design-review/gemini/07-scalability.md
global/prompts/design-review/gemini/08-extensibility.md
global/prompts/design-review/gemini/09-resilience.md
```

### Modified files

```
scripts/plan_review_dispatch.py          — Add --prompts-dir flag, parameterize prompt directory
scripts/tournament.py                    — Add evaluate_review() strategy for judging competing reviews
global/prompts/plan-review/claude/*.md   — Rewrite all domain prompts (new domains, adversarial depth)
global/prompts/plan-review/codex/*.md    — Same
global/prompts/plan-review/gemini/*.md   — Same
global/prompts/plan-review/*/agent.md    — Update preambles for plan-specific focus
skill/stark-review-plan/SKILL.md         — Rewrite: plan-only focus, --tournament flag, new domains
global/config.json                       — Add design_review section
CLAUDE.md                                — Update skill tables
install.sh                               — Handle new skill directory
```

### Deleted files

```
skill/stark-review-deployment-plan/SKILL.md                    — Absorbed into stark-review-plan
global/prompts/plan-review/claude/06-api-design.md             — Moved to design-review only
global/prompts/plan-review/codex/06-api-design.md
global/prompts/plan-review/gemini/06-api-design.md
```

---

## Task 1: Parameterize `plan_review_dispatch.py` to accept a prompt directory

The dispatch script currently hardcodes `prompts/plan-review/`. We need it to accept any prompt directory so both `design-review` and `plan-review` skills can reuse it.

**Files:**
- Modify: `scripts/plan_review_dispatch.py:78` (GLOBAL_PROMPTS_DIR constant)
- Modify: `scripts/plan_review_dispatch.py:649-678` (CLI args)
- Test: `scripts/test_plan_review_dispatch.py`

- [ ] **Step 1: Write failing test for --prompts-dir flag**

```python
# In scripts/test_plan_review_dispatch.py, add:

def test_prompts_dir_flag_accepted(tmp_path):
    """--prompts-dir flag is accepted and overrides default prompt directory."""
    import plan_review_dispatch as prd

    # Create a minimal prompt structure
    agent_dir = tmp_path / "claude"
    agent_dir.mkdir()
    (agent_dir / "agent.md").write_text("You are a test agent.")
    (agent_dir / "00-general.md").write_text("# General\nReview this.")

    domains = prd._discover_plan_domains(global_prompts_dir=str(tmp_path))
    assert "general" in domains


def test_dispatch_uses_custom_prompts_dir(tmp_path):
    """dispatch_plan_review uses custom prompts_dir when provided."""
    import plan_review_dispatch as prd

    # Create minimal prompt dirs for one agent, one domain
    for agent in ("claude",):
        agent_dir = tmp_path / agent
        agent_dir.mkdir()
        (agent_dir / "agent.md").write_text("You are a test agent.")
        (agent_dir / "00-test.md").write_text("# Test Domain\nReview this.")

    # dispatch_plan_review should discover domains from custom dir
    # We can't run actual agents, but we can verify the work items are built
    # by checking that the function accepts the parameter
    result = prd.dispatch_plan_review(
        plan_content="Test plan content",
        round_num=1,
        global_prompts_dir=str(tmp_path),
        agents=["claude"],
        timeout=1,  # Will fail fast, that's fine
    )
    # Should have attempted 1 domain
    assert result["summary"]["total_sub_agents"] == 1
    assert "test" in result["domains"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_plan_review_dispatch.py::test_prompts_dir_flag_accepted scripts/test_plan_review_dispatch.py::test_dispatch_uses_custom_prompts_dir -v`
Expected: Tests should pass for the first one (the function already accepts `global_prompts_dir`), but we need to verify the CLI flag exists.

- [ ] **Step 3: Add --prompts-dir CLI flag**

In `scripts/plan_review_dispatch.py`, modify the `main()` function:

```python
def main():
    parser = argparse.ArgumentParser(description="Plan review dispatch")
    parser.add_argument("--file", required=True, help="Path to plan/spec file")
    parser.add_argument("--round", type=int, default=1, help="Review round number")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-agent timeout (s)")
    parser.add_argument("--repo-dir", help="Repository root for config/prompt overrides")
    parser.add_argument("--agents", help="Comma-separated list of agents")
    parser.add_argument("--disabled-domains", help="Comma-separated domains to skip")
    parser.add_argument(
        "--prompts-dir",
        help="Prompt directory name under ~/.claude/code-review/prompts/ (default: plan-review)",
        default="plan-review",
    )
    args = parser.parse_args()

    # Resolve prompts dir
    global_prompts_dir = str(
        Path.home() / ".claude" / "code-review" / "prompts" / args.prompts_dir
    )

    # Load config, merge with CLI overrides
    config = _load_plan_review_config(args.repo_dir)
    agents = args.agents.split(",") if args.agents else config.get("agents")
    disabled = (
        args.disabled_domains.split(",")
        if args.disabled_domains
        else config.get("disabled_domains")
    )
    timeout = args.timeout if args.timeout != DEFAULT_TIMEOUT else config.get("timeout", DEFAULT_TIMEOUT)

    plan_content = Path(args.file).read_text()
    result = dispatch_plan_review(
        plan_content=plan_content,
        round_num=args.round,
        repo_dir=args.repo_dir,
        global_prompts_dir=global_prompts_dir,
        agents=agents,
        disabled_domains=disabled,
        timeout=timeout,
    )
    print(json.dumps(result, indent=2))
```

- [ ] **Step 4: Add CLI flag smoke test**

```python
# In scripts/test_plan_review_dispatch.py, add:

def test_cli_accepts_prompts_dir_flag():
    """CLI accepts --prompts-dir flag without error."""
    import subprocess
    result = subprocess.run(
        ["python", "-c", "import plan_review_dispatch; plan_review_dispatch.main()",
         "--file", "/dev/null", "--prompts-dir", "design-review", "--agents", "claude"],
        capture_output=True, text=True, cwd=str(Path(__file__).parent),
    )
    # Will fail reading /dev/null or dispatching, but should not fail on arg parsing
    # (argparse errors exit with code 2)
    assert result.returncode != 2, f"Arg parse error: {result.stderr}"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_plan_review_dispatch.py -v -k "prompts_dir or cli_accepts"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/plan_review_dispatch.py scripts/test_plan_review_dispatch.py
git commit -m "feat: add --prompts-dir flag to plan_review_dispatch.py"
```

---

## Task 2: Create design-review domain prompts (Claude)

Write the 10 domain prompts + agent preamble for Claude's design review. These are the reference prompts — Codex and Gemini will be adapted from these in Tasks 3 and 4.

**Files:**
- Create: `global/prompts/design-review/claude/agent.md`
- Create: `global/prompts/design-review/claude/00-general.md`
- Create: `global/prompts/design-review/claude/01-completeness.md`
- Create: `global/prompts/design-review/claude/02-security.md`
- Create: `global/prompts/design-review/claude/03-scope.md`
- Create: `global/prompts/design-review/claude/04-api-design.md`
- Create: `global/prompts/design-review/claude/05-data-modeling.md`
- Create: `global/prompts/design-review/claude/06-consistency.md`
- Create: `global/prompts/design-review/claude/07-scalability.md`
- Create: `global/prompts/design-review/claude/08-extensibility.md`
- Create: `global/prompts/design-review/claude/09-resilience.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p global/prompts/design-review/claude
```

- [ ] **Step 2: Write agent preamble**

Write `global/prompts/design-review/claude/agent.md`:

```markdown
# Claude — Design Review Agent

## Identity
You are reviewing an architecture document / design spec as the **stark-claude** GitHub App bot.

## Strengths to Lean Into
- Nuanced architectural reasoning — you see systemic implications across components
- Long-context comprehension — you can hold the full document in mind and cross-reference sections
- Experience identifying gaps between stated goals and proposed designs

## How You Receive Context
The full document content is provided inline in this prompt. Read it completely before producing findings.

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}

## Self-Verification
Before surfacing a finding, re-read the relevant section of the document. Confirm the issue actually exists — do not flag problems that the document already addresses. This single step is the most effective way to reduce false positives.

## Deduplication
You will be called multiple times on the same document with different domain prompts. **Do NOT repeat findings across domains.** Each finding should appear exactly once, in the most relevant domain. When in doubt, assign it to the domain where the fix belongs.

**Cross-domain amplification:** When a single architectural issue has implications across multiple domains, report it ONCE in the most relevant domain. Other domains may reference it briefly ("see finding in X domain") but should NOT produce a separate finding for the same root cause.
```

- [ ] **Step 3: Write 00-general.md**

```markdown
# General Design Review

**Persona: Senior Staff Engineer**

You are reviewing an architecture / design document for overall soundness. This is the catch-all domain — flag issues that don't fit neatly into other specialized domains.

## Checklist
- Does the document clearly state the problem it solves and why the proposed design is the right approach?
- Are the stated goals measurable and verifiable?
- Does the design make trade-offs explicit, or does it pretend there are none?
- Is the document internally coherent — do all sections point in the same direction?
- Are there unstated assumptions that should be made explicit?
- Does the design reference relevant prior art, existing systems, or alternatives considered?
- Is the level of detail appropriate — neither hand-wavy nor drowning in minutiae?

## Severity Guide
- critical: Document is fundamentally flawed — wrong problem, contradictory goals, missing rationale
- high: Major gap that undermines confidence in the design — unstated critical assumption, missing trade-off analysis
- medium: Issue worth addressing — vague requirement, implicit assumption that should be explicit
- low: Minor improvement — could be clearer, better structured

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 4: Write 01-completeness.md**

```markdown
# Completeness Review — Design Documents

**Persona: Platform Architect**

You are reviewing a design document for completeness. Your job is to find what's missing — sections, edge cases, error scenarios, and behaviors that aren't defined.

## Checklist
- Are all user-facing behaviors fully specified, including error states and edge cases?
- Are all system boundaries defined — what's in scope and what's explicitly out of scope?
- Are failure modes described for every component and integration point?
- Is the data lifecycle complete — creation, reading, updating, deletion, archival, and purging?
- Are all configuration options and their defaults documented?
- Are non-functional requirements stated — performance targets, availability, latency budgets?
- Are all external dependencies listed with their failure characteristics?
- Is there a migration path from the current state to the proposed design?
- Are rollback and recovery procedures defined?
- Are monitoring and alerting requirements specified?

## Severity Guide
- critical: Core behavior undefined — would require guessing during implementation
- high: Important scenario missing — error handling, edge case, or integration point not covered
- medium: Gap that should be filled — missing default, unspecified config option
- low: Nice to have — additional example, clarification of an already-clear point

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 5: Write 02-security.md**

```markdown
# Security Review — Design Documents

**Persona: Security Architect**

You are reviewing a design document for security properties. Focus on authentication, authorization, data protection, and threat surface — not compliance checklists.

## Checklist
- Is the authentication model clearly defined? Who authenticates, how, and with what credentials?
- Is the authorization model defined? Who can do what, and how are permissions enforced?
- Is data classified by sensitivity? Are appropriate protections applied per classification?
- Is data encrypted at rest and in transit? Are key management procedures defined?
- Are API endpoints protected against injection, CSRF, and other OWASP Top 10 attacks?
- Are secrets managed properly — no hardcoded credentials, rotation policy defined?
- Is the trust boundary clear — what's trusted, what's untrusted, where validation happens?
- Are audit logs generated for security-relevant operations?
- Is there a threat model or at least an enumeration of the attack surface?
- Are third-party dependencies assessed for security risk?

## Severity Guide
- critical: Security-breaking flaw — missing authN/authZ, unencrypted sensitive data, injection vector
- high: Significant security gap — overly broad permissions, missing audit logging, no key rotation
- medium: Security improvement — could tighten permissions, add rate limiting, improve validation
- low: Minor hardening — additional logging, defense-in-depth suggestion

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 6: Write 03-scope.md**

```markdown
# Scope Review — Design Documents

**Persona: Product-Minded Engineer**

You are reviewing a design document for scope appropriateness. Your job is to catch over-engineering, gold-plating, YAGNI violations, and scope creep — but also to flag when the scope is too narrow to solve the stated problem.

## Checklist
- Does every component in the design serve a stated requirement? Remove anything that exists "just in case."
- Are there features or capabilities that aren't needed for the stated goals?
- Is the design solving the current problem or a hypothetical future problem?
- Are there simpler alternatives that achieve the same goals with less complexity?
- Is the abstraction level appropriate — not too abstract (framework for a one-off) or too concrete (hardcoded for a reusable component)?
- Conversely: is the scope sufficient to actually solve the stated problem end-to-end?
- Are there obvious follow-up needs that the design should acknowledge even if they're out of scope?
- Is the migration/rollout plan proportional to the change, or over-engineered?

## Severity Guide
- critical: Scope fundamentally wrong — solving the wrong problem, or scope too narrow to achieve stated goals
- high: Significant over-engineering — unnecessary abstraction, premature optimization, feature nobody asked for
- medium: Could be simpler — extra configurability, unnecessary indirection, gold-plating
- low: Minor suggestion — slightly simpler approach available

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 7: Write 04-api-design.md**

```markdown
# API Design Review — Design Documents

**Persona: API Platform Lead**

You are reviewing a design document for API contract quality. This covers REST, gRPC, GraphQL, event schemas, CLI interfaces, library APIs, and any other contract between components.

## Checklist
- Are API contracts versioned? Is the versioning strategy explicit (URL path, header, content negotiation)?
- Are error responses well-defined with machine-readable error codes and human-readable messages?
- Is backward compatibility addressed — what happens to existing consumers when the API evolves?
- Are all request/response schemas fully defined, including optional fields and their defaults?
- Are pagination, filtering, and sorting patterns consistent with the rest of the system?
- Are rate limiting and quota policies defined?
- Are idempotency guarantees stated for mutating operations?
- Are authentication and authorization requirements clear per endpoint/operation?
- Is the naming convention consistent and follows established patterns (REST: nouns, gRPC: verbs)?
- Are there examples for common operations?

## Severity Guide
- critical: Contract-breaking flaw — ambiguous semantics, missing error handling, no versioning strategy
- high: Significant API issue — inconsistent naming, missing pagination, unclear idempotency
- medium: API improvement — could add better examples, clearer error codes, more consistent patterns
- low: Polish — naming convention nit, additional documentation

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 8: Write 05-data-modeling.md**

```markdown
# Data Modeling Review — Design Documents

**Persona: Data Architect**

You are reviewing a design document for data model quality. This covers schema design, data flow, storage decisions, consistency guarantees, and data lifecycle.

## Checklist
- Is the data model normalized appropriately — not over-normalized (excessive joins) or under-normalized (update anomalies)?
- Are entity relationships clearly defined with cardinality (1:1, 1:N, M:N)?
- Are consistency guarantees stated — eventual vs. strong, and where each applies?
- Is the data flow between components clear — who produces, who consumes, what format, what latency?
- Are storage technology choices justified — why this database/queue/cache for this data?
- Is the schema migration strategy defined — how do you evolve the schema without downtime?
- Is data ownership clear — which service is the source of truth for each entity?
- Are retention policies defined — how long is data kept, when is it archived or purged?
- Are indexes and access patterns documented — does the schema support the read patterns efficiently?
- Is there a data validation strategy — where is data validated, what happens to invalid data?

## Severity Guide
- critical: Data integrity risk — missing source of truth, conflicting ownership, no consistency guarantee
- high: Significant data issue — schema won't support stated access patterns, missing migration strategy
- medium: Data improvement — could clarify ownership, add retention policy, document indexes
- low: Minor data suggestion — naming convention, additional documentation

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 9: Write 06-consistency.md**

```markdown
# Consistency & Contradiction Review — Design Documents

**Persona: Technical Writer / Logic Analyst**

You are reviewing a design document for internal consistency. Your job is to find contradictions between sections, undefined terms used as if defined, and logical inconsistencies. This is the domain where LLMs add the most unique value — you can hold the entire document in context and cross-reference.

## Technique
Read the document in two passes:
1. **Forward pass:** Build a mental model of every claim, constraint, number, and decision.
2. **Cross-reference pass:** For each claim, check whether any other section contradicts, narrows, or conflicts with it.

## Checklist
- Do different sections state contradictory requirements? (e.g., "zero downtime" in goals but "maintenance window" in rollout)
- Are terms used consistently — does the same concept have different names in different sections?
- Are numbers consistent — do capacity estimates match the load assumptions?
- Do architecture diagrams match the prose descriptions?
- Are stated constraints honored throughout — if "no external dependencies" is a constraint, does every section respect it?
- Are decisions made in one section undermined by assumptions in another?
- Are there forward references to concepts not yet defined?
- Do examples match the described behavior?

## Severity Guide
- critical: Direct contradiction between sections that would cause implementation confusion
- high: Significant inconsistency — numbers don't add up, diagram contradicts prose
- medium: Terminology inconsistency — same concept has different names, causing ambiguity
- low: Minor inconsistency — example doesn't perfectly match described behavior

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 10: Write 07-scalability.md**

```markdown
# Scalability & Performance Review — Design Documents

**Persona: Performance Engineer**

You are reviewing a design document for scalability and performance properties. Focus on whether the design can handle growth without fundamental rework.

## Checklist
- Are load characteristics stated — expected QPS, data volume, growth rate?
- Are bottlenecks identified — what's the first thing that breaks under 10x load?
- Is the scaling strategy clear — horizontal, vertical, or both? What triggers scaling?
- Are caching strategies defined — what's cached, TTL, invalidation strategy, cache stampede prevention?
- Are back-pressure mechanisms in place — what happens when a component can't keep up?
- Are latency budgets defined — per-component and end-to-end?
- Are batch vs. real-time processing decisions explicit and justified?
- Is connection pooling addressed — database connections, HTTP connections, thread pools?
- Are hot spots identified — uneven data distribution, popular keys, write contention?
- Is there a capacity planning model — how do you predict when you need more resources?

## Severity Guide
- critical: Design fundamentally won't scale — single-threaded bottleneck, unbounded growth, no back-pressure
- high: Significant scaling gap — missing caching strategy, no connection pooling, write contention on hot path
- medium: Scaling improvement — should define growth rate, add latency budget, plan capacity
- low: Minor performance suggestion — could optimize a path that isn't on the hot path

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 11: Write 08-extensibility.md**

```markdown
# Extensibility & Evolvability Review — Design Documents

**Persona: Framework Architect**

You are reviewing a design document for how well the design accommodates future change. Focus on whether the design can evolve without rewrites — not hypothetical features, but whether the extension points exist where change is likely.

## Checklist
- Are the likely axes of change identified — what's most likely to evolve?
- Are extension points provided where change is likely (not everywhere — that's over-engineering)?
- Is the dependency direction correct — stable modules don't depend on volatile modules?
- Are interfaces well-defined — can implementations be swapped without changing consumers?
- Is the plugin/extension model clear if one exists?
- Are configuration and behavior separated — can behavior change without code changes where appropriate?
- Is the design closed for modification but open for extension where it matters?
- Are there hard-coded assumptions that will become wrong — magic numbers, fixed lists, embedded business rules?
- Is the migration path clear when the design needs to evolve?

## Severity Guide
- critical: Design locks in decisions that are likely to change — no way to evolve without rewrite
- high: Important extension point missing — hardcoded where flexibility is clearly needed
- medium: Could be more extensible — interface could be extracted, configuration could be externalized
- low: Minor extensibility suggestion — not urgent, but would help long-term

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 12: Write 09-resilience.md**

```markdown
# Resilience & Failure Modes Review — Design Documents

**Persona: Reliability Engineer**

You are reviewing a design document for how the system behaves when things break. This is distinct from operability (monitoring/alerting) — this is about the design-level decisions that determine whether failures are graceful or catastrophic.

## Checklist
- Are failure modes enumerated for each component — what happens when it crashes, hangs, or returns errors?
- Is the blast radius bounded — can a failure in one component take down the entire system?
- Are circuit breakers defined for cross-service calls?
- Is graceful degradation designed — what reduced functionality is acceptable during partial outages?
- Are retry policies defined with backoff and jitter — not just "retry 3 times"?
- Are timeouts defined for every cross-service call and external dependency?
- Is idempotency guaranteed for operations that may be retried?
- Are partial failure scenarios addressed — what happens when 2 of 3 writes succeed?
- Is there a health check / readiness probe design for each component?
- Are data durability guarantees stated — what happens to in-flight requests during a crash?

## Severity Guide
- critical: No failure handling for a critical path — crash cascades, no circuit breaker, unbounded retry
- high: Significant resilience gap — missing timeout on external call, no graceful degradation
- medium: Resilience improvement — could add circuit breaker, define retry policy, bound blast radius
- low: Minor hardening — additional health check, defensive coding suggestion

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 13: Commit**

```bash
git add global/prompts/design-review/claude/
git commit -m "feat: add Claude design-review domain prompts (10 domains)"
```

---

## Task 3: Create design-review domain prompts (Codex)

Adapt Claude's design-review prompts for Codex's strengths: deep reasoning, implementation focus, systematic analysis.

**Files:**
- Create: `global/prompts/design-review/codex/agent.md`
- Create: `global/prompts/design-review/codex/00-general.md` through `09-resilience.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p global/prompts/design-review/codex
```

- [ ] **Step 2: Write agent preamble**

Write `global/prompts/design-review/codex/agent.md`:

```markdown
# Codex — Design Review Agent

## Identity
You are reviewing an architecture document / design spec as the **stark-codex** GitHub App bot.

## Strengths to Lean Into
- Deep reasoning with high effort — you think through implications systematically
- Implementation-focused analysis — you catch designs that look good on paper but fail in code
- Systematic checklist execution — you don't skip items

## How You Receive Context
The full document content is provided inline in this prompt. Read it completely before producing findings.

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}

## Self-Verification
Before surfacing a finding, re-read the relevant section of the document. Confirm the issue actually exists — do not flag problems that the document already addresses.

## Deduplication
You will be called multiple times on the same document with different domain prompts. **Do NOT repeat findings across domains.** Each finding should appear exactly once, in the most relevant domain.

**Cross-domain amplification:** Report each root cause ONCE in the most relevant domain. Other domains may reference it but should NOT produce a separate finding.
```

- [ ] **Step 3: Write all 10 domain prompts**

Copy each of Claude's domain prompts, adjusting the persona framing to emphasize Codex's strengths. The checklist items and severity guides remain identical — only the preamble line changes.

For each file (`00-general.md` through `09-resilience.md`), use the same content as Claude's version. The agent preamble already differentiates Codex's approach.

- [ ] **Step 4: Commit**

```bash
git add global/prompts/design-review/codex/
git commit -m "feat: add Codex design-review domain prompts (10 domains)"
```

---

## Task 4: Create design-review domain prompts (Gemini)

Adapt Claude's design-review prompts for Gemini's strengths: data contract analysis, integration point detection, production operations perspective.

**Files:**
- Create: `global/prompts/design-review/gemini/agent.md`
- Create: `global/prompts/design-review/gemini/00-general.md` through `09-resilience.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p global/prompts/design-review/gemini
```

- [ ] **Step 2: Write agent preamble**

Write `global/prompts/design-review/gemini/agent.md`:

```markdown
# Gemini — Design Review Agent

## Identity
You are reviewing an architecture document / design spec as the **stark-gemini** GitHub App bot.

## Strengths to Lean Into
- Data contract and API design inconsistency detection
- Missing integration points and interface gaps
- Production operations perspective — you think about what breaks at 3 AM

## How You Receive Context
The full document content is provided inline in this prompt. Read it completely before producing findings.

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}

## Self-Verification
Before surfacing a finding, re-read the relevant section of the document. Confirm the issue actually exists — do not flag problems that the document already addresses.

## Deduplication
You will be called multiple times on the same document with different domain prompts. **Do NOT repeat findings across domains.** Each finding should appear exactly once, in the most relevant domain.

**Cross-domain amplification:** Report each root cause ONCE in the most relevant domain. Other domains may reference it but should NOT produce a separate finding.
```

- [ ] **Step 3: Write all 10 domain prompts**

Same content as Claude's domain prompts. The agent preamble differentiates Gemini's perspective.

- [ ] **Step 4: Commit**

```bash
git add global/prompts/design-review/gemini/
git commit -m "feat: add Gemini design-review domain prompts (10 domains)"
```

---

## Task 5: Rewrite plan-review domain prompts (all 3 agents)

Replace the existing 7 plan-review domains with 10 new domains incorporating adversarial depth from `stark-review-deployment-plan`. Delete the old `06-api-design.md` files (moved to design-review only).

**Files:**
- Delete: `global/prompts/plan-review/claude/06-api-design.md`
- Delete: `global/prompts/plan-review/codex/06-api-design.md`
- Delete: `global/prompts/plan-review/gemini/06-api-design.md`
- Rewrite: `global/prompts/plan-review/claude/00-general.md` — add COE-forward thinking, evidence strictness
- Rewrite: `global/prompts/plan-review/claude/01-completeness.md` — add IaC completeness, blank-slate test, API prerequisites
- Rewrite: `global/prompts/plan-review/claude/02-security.md` — absorbed: identity lifecycle (vector I)
- Rewrite: `global/prompts/plan-review/claude/03-feasibility.md` — absorbed: command validation (F), idempotency (B)
- Rewrite: `global/prompts/plan-review/claude/04-operability.md` — absorbed: drift detection (E), observability readiness
- Rewrite: `global/prompts/plan-review/claude/05-scope.md` — rename to `05-sequencing.md`
- Create: `global/prompts/plan-review/claude/05-sequencing.md` — absorbed: dependency sequencing (D), API prerequisites (H)
- Create: `global/prompts/plan-review/claude/06-rollback.md` — absorbed: partial-failure traps (A), cutover gates (G), rollback maturity L0-L4
- Create: `global/prompts/plan-review/claude/07-risk.md` — pre-mortem framing, blast radius quantification
- Create: `global/prompts/plan-review/claude/08-gates.md` — go/no-go criteria, cutover gates (G), data reconciliation
- Create: `global/prompts/plan-review/claude/09-timeline.md` — realism, buffer, staffing, communication/escalation
- Same for codex/ and gemini/
- Update: `global/prompts/plan-review/*/agent.md` — update preambles for plan-specific focus

- [ ] **Step 1: Delete old api-design prompts from plan-review**

```bash
rm global/prompts/plan-review/claude/06-api-design.md
rm global/prompts/plan-review/codex/06-api-design.md
rm global/prompts/plan-review/gemini/06-api-design.md
```

- [ ] **Step 2: Delete old scope prompts (being replaced by sequencing)**

```bash
rm global/prompts/plan-review/claude/05-scope.md
rm global/prompts/plan-review/codex/05-scope.md
rm global/prompts/plan-review/gemini/05-scope.md
```

- [ ] **Step 3: Rewrite 00-general.md (Claude)**

```markdown
# General Plan Review

**Persona: Senior Staff Engineer**

You are reviewing an implementation / deployment / migration plan for overall soundness. This is the catch-all domain — flag issues that don't fit into specialized domains.

## Adversarial Framing
Apply COE-forward thinking: "If this plan fails in production, what Correction of Error document will we write? What action items will it produce? Those action items should already be in this plan."

## Checklist
- Does the plan clearly state what it changes and why?
- Are success criteria measurable and verifiable?
- Does every claim have evidence, or does the plan assert without proving? (evidence strictness)
- Are assumptions stated explicitly, not buried in prose?
- Is the plan self-contained — can someone execute it without tribal knowledge?
- Are there references to runbooks, scripts, or tools that don't exist or are out of date?
- Is the level of detail appropriate for the risk level?
- Does the plan account for the team actually executing it — timezone, availability, skill level?

## Evidence Strictness
If a plan claims "zero downtime" or "no data loss," require concrete evidence: how is this guaranteed? What mechanism enforces it? If evidence is missing, flag it.

## Severity Guide
- critical: Plan is fundamentally unsound — wrong approach, contradictory goals, missing rationale
- high: Major gap — unstated critical assumption, unverifiable claim, missing prerequisite
- medium: Should be addressed — vague requirement, implicit assumption
- low: Minor improvement — clearer wording, better structure

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 4: Rewrite 01-completeness.md (Claude)**

```markdown
# Completeness Review — Execution Plans

**Persona: Platform Architect**

You are reviewing an execution plan for completeness. Find what's missing — steps, prerequisites, error handling, and behaviors that aren't defined.

## Blank-Slate Test
Assume a brand-new empty project/account/environment. Would this plan work from scratch? Flag every hidden assumption about pre-existing:
- Service accounts, IAM roles, or permissions
- APIs/services that need to be enabled
- Network configuration (VPCs, firewall rules, DNS)
- Secrets, certificates, or credentials
- Database schemas or seed data

## API Prerequisite Matrix
For each phase or capability in the plan, verify:
- Which APIs/services must be enabled?
- Are they explicitly declared in IaC or as plan steps?
- What happens if they're not enabled when the step runs?

## Checklist
- Are all steps enumerated — no gaps between "do A" and "verify A worked"?
- Are pre-flight checks defined — what must be true before execution starts?
- Are post-flight checks defined — how do you verify each step succeeded?
- Are all resources explicitly created — nothing assumed to exist?
- Is IaC complete — are there manual steps that should be codified?
- Are monitoring and alerting steps included — not just the deployment?
- Is there a communication plan — who gets notified, when, about what?
- Are cleanup steps defined — temporary resources, feature flags, dual-write teardown?

## Severity Guide
- critical: Core step missing — plan will fail on a clean environment
- high: Important prerequisite undeclared — API not enabled, IAM not granted
- medium: Gap that should be filled — missing verification step, no cleanup
- low: Nice to have — additional pre-flight check

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 5: Rewrite 02-security.md (Claude)**

```markdown
# Security Review — Execution Plans

**Persona: Security Architect**

You are reviewing an execution plan for security properties. Focus on identity lifecycle, credential management, and permission boundaries during execution.

## Runtime Identity Lifecycle (absorbed from deployment-plan vector I)
For each service account, IAM role, or identity referenced in the plan:
- **Creation:** Where and how is it created?
- **Binding:** What permissions are granted? Are they least-privilege?
- **Attachment:** Is `--service-account` (or equivalent) explicitly used at deploy time?
- **Rotation:** Are credentials rotated? What's the rotation schedule?
- **Cleanup:** Are temporary identities removed after migration/deployment?

Flag FAIL if any identity is referenced but its lifecycle is incomplete.

## Checklist
- Are all credentials (API keys, tokens, certificates) managed via a secrets manager, not hardcoded?
- Are permissions scoped to minimum required — no `*` permissions, no admin roles for service accounts?
- Are security-relevant operations logged for audit?
- Is network access restricted during deployment — no public endpoints for internal services?
- Are there escalation paths if a security issue is discovered during execution?
- Is the plan reviewed for supply chain risks — third-party scripts, container images, dependencies?

## Severity Guide
- critical: Security-breaking flaw — credentials in plan text, missing authN, overly broad permissions
- high: Significant security gap — identity lifecycle incomplete, no audit logging
- medium: Security improvement — could tighten permissions, add rotation policy
- low: Minor hardening — additional logging

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 6: Rewrite 03-feasibility.md (Claude)**

```markdown
# Feasibility Review — Execution Plans

**Persona: Principal SRE**

You are reviewing an execution plan for whether it can actually be carried out as described. Focus on command correctness, idempotency, and practical executability.

## Command Contract Validation (absorbed from deployment-plan vector F)
For every CLI command, API call, or script invocation in the plan:
- Is the command syntax correct? Are flags valid?
- If you are uncertain about a command's behavior, write **UNCERTAIN** — do not guess.
- Do not fabricate documentation URLs.

## Imperative Idempotency (absorbed from deployment-plan vector B)
For every imperative command (`create`, `deploy`, `execute`, `insert`):
- Is it idempotent or upsert-safe? What happens if it runs twice?
- If not idempotent, is there a guard (`--if-not-exists`, check-then-act)?
- Flag every `create` that should be `create-or-update`.

## Checklist
- Can this be executed with the stated tools, access, and permissions?
- Are there unrealistic assumptions about timing — steps that take hours scheduled in minutes?
- Are there blocking dependencies not called out?
- Are external dependencies (vendor APIs, third-party services) available and stable?
- Is the execution environment specified — where does this run, with what access?
- Are there manual steps that could fail silently?
- Is each script/command safe to `ctrl-C` and restart?

## Severity Guide
- critical: Plan cannot be executed — wrong command syntax, missing permissions, impossible ordering
- high: Significant feasibility issue — non-idempotent command in a retry-likely path, unrealistic timing
- medium: Feasibility concern — optimistic assumption, unvalidated command flag
- low: Minor improvement — could be more explicit about prerequisites

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 7: Rewrite 04-operability.md (Claude)**

```markdown
# Operability Review — Execution Plans

**Persona: SRE Lead**

You are reviewing an execution plan for operational readiness. Can the team observe, troubleshoot, and maintain the system during and after execution?

## Drift Detection (absorbed from deployment-plan vector E)
For each resource that is NOT managed by IaC:
- Who is the authoritative owner?
- How is configuration drift detected?
- If no automatic drift correction exists, what is the manual detection and remediation procedure?
- Flag any resource with no drift strategy as FAIL.

## Observability Readiness Checklist
For each new component or changed system:
- [ ] Golden signals instrumented (latency, traffic, errors, saturation)?
- [ ] Dashboards created and bookmarked by on-call?
- [ ] Alerts configured with linked runbooks?
- [ ] Alert routing verified (correct team/channel)?
- [ ] Structured logging with correlation/trace IDs?
- [ ] Log retention policy configured?

## Checklist
- Are monitoring and alerting changes included in the plan, not deferred to "later"?
- Is there a comparison view — old system vs. new system side-by-side?
- Are runbooks created or updated for new operational procedures?
- Is the on-call rotation staffed for the deployment window + 48h bake period?
- Are escalation contacts confirmed and reachable?
- Is there a war room / dedicated channel for the execution?

## Severity Guide
- critical: No observability for a critical path — blind spots during deployment
- high: Significant operational gap — no alerting, no runbook, no drift detection
- medium: Operational improvement — missing dashboard, incomplete logging
- low: Minor suggestion — additional metric, better alert threshold

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 8: Write 05-sequencing.md (Claude) — NEW**

```markdown
# Sequencing & Dependencies Review — Execution Plans

**Persona: Systems Engineer**

You are reviewing an execution plan for correct ordering and dependency management. Find steps that are in the wrong order, have missing prerequisites, or create circular dependencies.

## Dependency Sequencing (absorbed from deployment-plan vector D)
- Validate both infrastructure dependencies AND deployment/runtime dependencies.
- Call out phase-order breakages (e.g., secret/runtime changes required before deploy steps).
- Build the implicit dependency graph from the plan prose and check for cycles.

## Bilateral Failure Simulation
For every step that involves two systems (dual-write, migration, sync):
- Simulate: System A succeeds, System B fails. What is the state? How do you recover?
- Simulate: System B succeeds, System A fails. What is the state? How do you recover?
- Identify the source of truth at each step.

## Checklist
- Is every step's prerequisite explicitly stated — what must be true before it runs?
- Are there implicit ordering assumptions — steps that depend on each other but don't say so?
- Are there circular dependencies — step A needs B, but B needs A?
- Can steps be parallelized? If the plan shows them as sequential, is that intentional?
- Are there race conditions — two steps that modify the same resource concurrently?
- For each dual-write or migration step, who is the source of truth? Is this stated explicitly?

## Output Table
In addition to findings, produce a dependency violations table:

| Prerequisite | Dependent Step | What Breaks If Missing | Fix |
|---|---|---|---|

## Severity Guide
- critical: Step ordering will cause data loss or system failure
- high: Dependency missing — step will fail because prerequisite isn't met
- medium: Ordering improvement — could parallelize, or explicit dependency should be stated
- low: Minor sequencing suggestion

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 9: Write 06-rollback.md (Claude) — NEW**

```markdown
# Rollback & Recovery Review — Execution Plans

**Persona: Incident Commander**

You are reviewing an execution plan for rollback and recovery procedures. Every step that changes state must have a way back. "We'll figure it out" is not a rollback plan.

## Rollback Maturity Rubric
Score the plan's rollback readiness:

| Level | Name | Criteria |
|-------|------|----------|
| L0 | Documented | Rollback steps are written down but not tested |
| L1 | Rehearsed | Team walked through rollback in staging |
| L2 | Tested | Rollback executed in pre-prod with production-like data |
| L3 | Automated + Tested | Single command/button rollback, tested in pre-prod |
| L4 | Continuously Validated | Rollback tested as part of every deployment pipeline |

Plans should target at least L2 for data-touching changes and L1 for config-only changes. Flag anything at L0 for data migrations.

## Partial-Failure Traps (absorbed from deployment-plan vector A)
For dual-write and migration cutovers:
- Simulate both directions: A succeeds / B fails, AND B succeeds / A fails
- Identify source of truth at each migration step
- Require explicit anti-split-brain cutover gate (final delta sync or write freeze + reconciliation)

## Checklist
- Does every step have a defined rollback procedure?
- Is schema rollback compatibility verified — can old code read data written by new code?
- Is state rollback addressed — queues, in-flight requests, cached data?
- Is rollback time measured and within SLO?
- Can you roll back service A without rolling back service B (partial rollback)?
- Is rollback of configuration changes covered, not just code?
- Are there steps that are irreversible? Are they called out explicitly with mitigation?

## Severity Guide
- critical: No rollback for a data-touching change — potential data loss with no recovery
- high: Rollback exists but untested (L0) for a high-risk change
- medium: Rollback improvement — should be automated, should cover config, partial rollback needed
- low: Minor rollback suggestion — additional verification step

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 10: Write 07-risk.md (Claude) — NEW**

```markdown
# Risk & Blast Radius Review — Execution Plans

**Persona: Principal Cloud Architect**

You are reviewing an execution plan for risk assessment. Your primary tool is the pre-mortem: assume this plan has already failed catastrophically. What caused the failure?

## Pre-Mortem Framing
Before checking the checklist, perform a pre-mortem analysis:
1. Imagine this plan executed and failed. What is the most likely cause of failure?
2. What is the worst-case scenario — maximum data loss, maximum downtime, maximum blast radius?
3. What single point of failure, if it goes down, takes everything with it?

Research shows pre-mortems generate 30% more potential threats than prospective analysis because they exploit "prospective hindsight."

## Blast Radius Quantification
For each risk identified:
1. **Failure domain:** Single host → single AZ → single region → global
2. **Impact:** % of users affected, % of revenue at risk, data loss potential
3. **Containment:** Feature flags, traffic shifting, circuit breakers, cell-based architecture
4. **Propagation path:** How does a failure in component X cascade to Y and Z?

## Checklist
- Is there a risk register — likelihood × impact for each identified risk?
- Are single points of failure identified and mitigated?
- Are cascading failure paths mapped — if A fails, does B fail, then C?
- Is the blast radius bounded — can a failure in the new system take down existing systems?
- Are there kill switches — can you immediately stop the deployment and contain damage?
- Is the maximum duration of impact estimated — how long until recovery?
- Are there canary or phased rollout gates that limit initial blast radius?

## Severity Guide
- critical: Unbounded blast radius — failure can cascade to unrelated systems, no kill switch
- high: Single point of failure on critical path with no mitigation
- medium: Risk identified but not quantified — blast radius unknown, no containment strategy
- low: Minor risk suggestion — additional monitoring, extra circuit breaker

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 11: Write 08-gates.md (Claude) — NEW**

```markdown
# Gates & Cutover Review — Execution Plans

**Persona: Release Manager**

You are reviewing an execution plan for go/no-go gates, cutover procedures, and approval requirements. Every phase transition needs explicit criteria.

## Cutover Gates (absorbed from deployment-plan vector G)
For dual-write migrations and system cutovers:
- Require explicit final delta sync or write freeze immediately before read cutover
- Require data reconciliation step — counts match, checksums match
- Flag FAIL if the plan transitions reads to a new system without verifying data completeness

## Checklist
- Is there a go/no-go gate between every major phase?
- Are gate criteria specific and measurable — not "everything looks good" but "error rate < 0.1% for 30 minutes"?
- Are health checks defined — what metrics prove the system is ready for the next phase?
- Who has authority to proceed, pause, or abort? Is this a person, a metric, or both?
- Is there a data reconciliation step before cutover — row counts, checksums, sample validation?
- Are approval requirements documented — who signs off, what evidence do they review?
- Is there a bake period defined after each phase — how long do you wait before proceeding?
- Are there automated gates that block progression if metrics degrade?

## Severity Guide
- critical: No gate before a destructive or irreversible step — cutover without data validation
- high: Gate exists but criteria are vague — "check that it's working" with no metrics
- medium: Gate improvement — should be automated, should include specific thresholds
- low: Minor gate suggestion — longer bake period, additional health check

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 12: Write 09-timeline.md (Claude) — NEW**

```markdown
# Timeline & Coordination Review — Execution Plans

**Persona: Engineering Manager**

You are reviewing an execution plan for timeline realism, staffing, and coordination. The most common failure mode is not technical — it's a plan that assumes everything goes right on the first try.

## Timeline Realism Assessment
Red flags that a timeline is unrealistic:
- No buffer between milestones (zero slack = guaranteed slip)
- Critical path depends on a single person
- "Testing" compressed into final 10% of timeline
- No time allocated for rollback testing
- Migration and feature work scheduled concurrently for the same team
- Weekend/off-hours work assumed as baseline, not exception

## Checklist
- Is there buffer time — at least 20% buffer for well-understood work, 30%+ for novel work?
- Are there key-person risks — does the plan depend on one person with no backup?
- Are backup staff identified and trained?
- Is the maintenance window realistic — enough time for execution + verification + potential rollback?
- Is the communication plan defined — who gets notified, when, through what channel?
- Is there an escalation ladder — L1 (on-call, 0-5min) → L2 (team lead, 5-15min) → L3 (manager + SRE, 15-30min) → L4 (VP + IC, 30min+)?
- Are timezone constraints accounted for — is the team spread across timezones?
- Is the deployment window chosen to minimize blast radius — low-traffic period, business hours for support?
- Are dependencies on external teams confirmed with dates, not assumed?

## Severity Guide
- critical: Timeline is impossible — schedule violates physics, key dependency unconfirmed
- high: Significant timeline risk — no buffer, key-person dependency, no communication plan
- medium: Timeline improvement — should add buffer, confirm external dependencies
- low: Minor suggestion — better communication cadence, timezone consideration

## Output Format
JSON array only. No preamble, no summary, no markdown fences.
[{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "..."}]
```

- [ ] **Step 13: Update agent preambles for plan-specific focus**

Update `global/prompts/plan-review/claude/agent.md`:

```markdown
# Claude — Plan Review Agent

## Identity
You are reviewing an implementation / deployment / migration plan as the **stark-claude** GitHub App bot.

## Strengths to Lean Into
- Nuanced reasoning about execution sequences and failure modes
- Long-context comprehension — you can hold the full plan in mind and cross-reference steps
- Experience identifying gaps between stated intentions and actual execution plans

## Adversarial Stance
You are not here to confirm the plan is good. You are here to find where it will break. Apply pre-mortem thinking: assume this plan has already failed — now find why.

## How You Receive Context
The full plan content is provided inline in this prompt. Read it completely before producing findings.

## Output Rules
- Output ONLY a JSON array of findings
- No preamble, no summary, no markdown — just `[...]`
- If no issues: `[]`
- Each finding: {"severity": "critical|high|medium|low", "section": "heading text", "title": "short title", "description": "what is wrong", "suggestion": "how to fix it"}
- Every High/Critical finding MUST include a concrete failure sequence in the description — not just "this could be a problem" but "step 3 will fail because X, causing Y"

## Self-Verification
Before surfacing a finding, re-read the relevant section. Confirm the issue actually exists — do not flag problems the plan already addresses. Do not report stylistic preferences or purely theoretical edge cases.

## Deduplication
You will be called multiple times with different domain prompts. **Do NOT repeat findings across domains.** Report each issue once in the most relevant domain.
```

Apply the same adversarial framing to codex and gemini agent preambles, adjusting for their respective strengths.

- [ ] **Step 14: Create Codex and Gemini plan-review prompts**

Copy Claude's rewritten prompts to `codex/` and `gemini/` directories. The domain content is identical — agents are differentiated by their preambles.

- [ ] **Step 15: Commit**

```bash
git add global/prompts/plan-review/
git commit -m "feat: rewrite plan-review prompts — 10 adversarial domains, absorb deployment-plan vectors"
```

---

## Task 6: Write `stark-review-design` SKILL.md

Create the new design review skill, modeled on the existing plan review skill but focused on architecture/spec documents.

**Files:**
- Create: `skill/stark-review-design/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

Write `skill/stark-review-design/SKILL.md`. Structure mirrors `stark-review-plan` but:
- Uses `--prompts-dir design-review` when calling dispatch
- Has 10 design-focused domains (general, completeness, security, scope, api-design, data-modeling, consistency, scalability, extensibility, resilience)
- History goes to `~/.claude/code-review/history/design-reviews/`
- Review file is `{name}.design-review.md` alongside the original
- Includes `--tournament` flag (Phase 2a variant, see Task 8)
- Trigger words: "review this design", "review this spec", "review design doc", "review architecture"
- Description emphasizes: "Is this the right system? Reviews quality of what's being designed."

Key differences from plan-review SKILL.md:
- No adversarial framing in the skill itself (the domain prompts handle their own perspective)
- Sub-agents: 3 × 10 = 30 (normal mode) or 3 full reviews (tournament mode)
- Classification uses same statuses: `fix`, `recurring`, `false_positive`, `noise`, `ignored`

- [ ] **Step 2: Commit**

```bash
git add skill/stark-review-design/
git commit -m "feat: add stark-review-design skill (architecture/spec review)"
```

---

## Task 7: Rewrite `stark-review-plan` SKILL.md

Rewrite the plan review skill to reflect the new plan-only focus, 10 adversarial domains, and `--tournament` flag.

**Files:**
- Modify: `skill/stark-review-plan/SKILL.md`

- [ ] **Step 1: Rewrite SKILL.md**

Key changes from current version:
- Description: "Reviews quality of how it'll be executed. Can this plan actually be carried out safely?"
- Trigger words: add "review deployment plan", "review infra plan", "review migration plan", "audit deployment" (absorbed from deployment-plan)
- 10 domains: general, completeness, security, feasibility, operability, sequencing, rollback, risk, gates, timeline
- Sub-agents: 3 × 10 = 30 (normal mode) or 3 full reviews (tournament mode)
- Adversarial framing in the skill preamble: pre-mortem stance, evidence strictness
- Uses `--prompts-dir plan-review` when calling dispatch
- History goes to `~/.claude/code-review/history/plan-reviews/` (unchanged)
- Add `--tournament` flag (Phase 2a variant, see Task 8)
- Add coverage matrix output (vectors A-J from deployment-plan, mapped to domains)
- Keep the output format sections: findings table, fixed, recurring, unresolved, noise, misalignment, changes made, prompt improvement

- [ ] **Step 2: Commit**

```bash
git add skill/stark-review-plan/SKILL.md
git commit -m "feat: rewrite stark-review-plan — 10 adversarial domains, absorb deployment-plan"
```

---

## Task 8: Add tournament mode to `tournament.py`

Add an `evaluate_review` strategy to the tournament engine for judging competing document reviews.

**Files:**
- Modify: `scripts/tournament.py`
- Modify: `scripts/test_tournament.py`

- [ ] **Step 1: Write failing test for evaluate_review**

```python
# In scripts/test_tournament.py, add:

def test_evaluate_review_returns_scores():
    """evaluate_review returns per-criterion scores for each competitor."""
    from tournament import evaluate_review

    document = "# Test Plan\n\nDeploy service X to production.\n\n## Steps\n1. Build\n2. Deploy\n3. Verify"
    reviews = {
        "claude": '[{"severity": "high", "title": "No rollback", "description": "No rollback plan defined", "suggestion": "Add rollback steps"}]',
        "codex": '[{"severity": "medium", "title": "Missing monitoring", "description": "No alerting defined", "suggestion": "Add alerts"}]',
        "gemini": '[]',
    }

    # This will fail because evaluate_review doesn't exist yet
    result = evaluate_review(
        document=document,
        reviews=reviews,
        judge="claude-sonnet-4-6",
        timeout=60,
    )
    assert "scores" in result
    assert "synthesized_findings" in result
    assert "winner" in result
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_tournament.py::test_evaluate_review_returns_scores -v`
Expected: FAIL with ImportError

- [ ] **Step 3: Implement evaluate_review**

Add to `scripts/tournament.py`:

```python
# ── Review evaluation (tournament mode for review skills) ──────────────

REVIEW_EVAL_CRITERIA = {
    "coverage": {"weight": 2.0, "scale": "good/acceptable/poor"},
    "severity_accuracy": {"weight": 2.0, "scale": "good/acceptable/poor"},
    "false_positive_rate": {"weight": 1.5, "scale": "low/medium/high"},
    "actionability": {"weight": 1.5, "scale": "good/acceptable/poor"},
    "specificity": {"weight": 1.0, "scale": "good/acceptable/poor"},
}

REVIEW_SCALE_MAP = {
    "good": 9, "acceptable": 6, "poor": 3,
    "low": 9, "medium": 6, "high": 3,  # For false_positive_rate (low is good)
}


def _build_review_judge_prompt(
    document: str,
    reviews: dict[str, str],
    competitor_order: list[str],
) -> str:
    """Build the judge prompt for evaluating competing reviews.

    Includes the original document so the judge can assess accuracy.
    Competitor order is parameterized for position-bias control.
    """
    criteria_desc = "\n".join(
        f"- **{name}**: Score as {info['scale']} (weight: {info['weight']}x)"
        for name, info in REVIEW_EVAL_CRITERIA.items()
    )

    reviews_text = "\n\n".join(
        f"### Review by {comp}\n\n{reviews[comp]}"
        for comp in competitor_order
    )

    return f"""You are a Principal Engineer judging the quality of competing document reviews.

## The Document Being Reviewed

{document}

## Competing Reviews

{reviews_text}

## Evaluation Criteria

Score each review on these criteria:

{criteria_desc}

## Instructions

1. For each criterion, reason about which review performs best BEFORE scoring.
2. Score each review on each criterion using the specified scale.
3. Identify the winner — the review with the best overall quality.
4. Synthesize the best findings from ALL reviews into a combined output — extract every genuine finding regardless of which review it came from, deduplicate, and rank by severity.
5. If reviews are too close to call on quality, say "tie" and still synthesize.

## Response Format

Return ONLY valid JSON:

```json
{{
  "reasoning": "Brief explanation of your evaluation",
  "scores": [
    {{"competitor": "<name>", "coverage": "good|acceptable|poor", "severity_accuracy": "good|acceptable|poor", "false_positive_rate": "low|medium|high", "actionability": "good|acceptable|poor", "specificity": "good|acceptable|poor"}},
    ...
  ],
  "winner": "<name or tie>",
  "synthesized_findings": [
    {{"severity": "...", "section": "...", "title": "...", "description": "...", "suggestion": "...", "source_competitors": ["..."]}}
  ]
}}
```"""


def evaluate_review(
    document: str,
    reviews: dict[str, str],
    judge: str = "claude-sonnet-4-6",
    timeout: int = 300,
) -> dict[str, Any]:
    """Evaluate competing reviews using a judge model.

    Runs the judge twice with swapped competitor order for position-bias control.
    If the judge disagrees with itself, flags the result.

    Args:
        document: The original document that was reviewed
        reviews: Dict mapping competitor ID to their review output (raw text)
        judge: Model name for the judge
        timeout: Timeout for judge calls

    Returns:
        Dict with scores, winner, synthesized_findings, and position_bias flag
    """
    competitors = list(reviews.keys())

    # Run 1: original order
    prompt_1 = _build_review_judge_prompt(document, reviews, competitors)
    # Run 2: reversed order (position bias control)
    prompt_2 = _build_review_judge_prompt(document, reviews, list(reversed(competitors)))

    results = []
    for prompt in [prompt_1, prompt_2]:
        try:
            proc = subprocess.run(
                ["claude", "-p", "-", "--output-format", "text", "--model", judge],
                input=prompt, capture_output=True, text=True, timeout=timeout,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                parsed = _parse_review_judge_output(proc.stdout)
                if parsed:
                    results.append(parsed)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    if not results:
        return {"scores": {}, "winner": None, "synthesized_findings": [], "error": "judge_failed"}

    # Use first result as primary
    primary = results[0]

    # Check for position bias if we got both results
    if len(results) == 2:
        winner_1 = results[0].get("winner")
        winner_2 = results[1].get("winner")
        primary["position_bias_detected"] = winner_1 != winner_2
        if primary["position_bias_detected"]:
            primary["winner"] = "tie"
            primary["position_bias_note"] = (
                f"Judge picked {winner_1} in run 1 but {winner_2} in run 2 — marking as tie"
            )

    # Convert text scores to numeric for weighted average
    numeric_scores = {}
    for score_entry in primary.get("scores", []):
        comp = score_entry.get("competitor", "")
        comp_scores = {}
        for criterion in REVIEW_EVAL_CRITERIA:
            text_score = score_entry.get(criterion, "acceptable")
            comp_scores[criterion] = REVIEW_SCALE_MAP.get(text_score, 6)
        weights = {k: v["weight"] for k, v in REVIEW_EVAL_CRITERIA.items()}
        numeric_scores[comp] = compute_weighted_average(comp_scores, weights)

    primary["numeric_scores"] = numeric_scores
    return primary


def _parse_review_judge_output(raw: str) -> dict[str, Any] | None:
    """Parse JSON output from the review judge."""
    text = raw.strip()
    # Try extracting from code block
    fence_match = re.search(r"```(?:json)?\s*\n([\s\S]*?)```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()
    # Find outermost { ... }
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/aryeh/Code/Playground/stark-skills && python -m pytest scripts/test_tournament.py -v -k "evaluate_review"`
Expected: PASS (may fail if no `claude` CLI available — test should mock or skip)

- [ ] **Step 5: Commit**

```bash
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: add evaluate_review strategy to tournament engine"
```

---

## Task 9: Delete `stark-review-deployment-plan`

Remove the skill now that its content is absorbed into `stark-review-plan`.

**Files:**
- Delete: `skill/stark-review-deployment-plan/SKILL.md`

- [ ] **Step 1: Delete the skill directory**

```bash
rm -rf skill/stark-review-deployment-plan
```

- [ ] **Step 2: Remove the installed symlink**

```bash
rm -f ~/.claude/skills/stark-review-deployment-plan/SKILL.md
rmdir ~/.claude/skills/stark-review-deployment-plan 2>/dev/null || true
```

- [ ] **Step 3: Commit**

```bash
git add -A skill/stark-review-deployment-plan/
git commit -m "feat: delete stark-review-deployment-plan (absorbed into stark-review-plan)"
```

---

## Task 10: Update CLAUDE.md, config, and install.sh

Update all references to reflect the skill split.

**Files:**
- Modify: `CLAUDE.md` — update skill tables, remove deployment-plan, add design-review
- Modify: `global/config.json` — add `design_review` section
- Modify: `install.sh` — verify auto-discovery handles new skill directory (should work already since it globs `skill/stark-*/`)

- [ ] **Step 1: Update CLAUDE.md**

In the Skills section, replace:
```markdown
- `/stark-review-plan <path>` — multi-agent plan/spec review (3 LLMs × 7 domains)
- `/stark-review-deployment-plan` — adversarial infra/deployment plan review
```
with:
```markdown
- `/stark-review-design <path>` — multi-agent design/spec review (3 LLMs × 10 domains)
- `/stark-review-plan <path>` — multi-agent execution plan review (3 LLMs × 10 domains, adversarial)
```

Also update the description line:
```markdown
Multi-agent PR code review system. 3 AI CLI tools (Claude, Codex, Gemini) × N domain specializations...
```

- [ ] **Step 2: Update global/config.json**

Add a `design_review` section with the same schema as `plan_review`:
```json
{
  "design_review": {
    "agents": ["claude", "codex"],
    "fix_threshold": "medium",
    "disabled_domains": [],
    "max_rounds": 3
  }
}
```

- [ ] **Step 3: Verify install.sh auto-discovers the new skill**

```bash
./install.sh --status
```

The script globs `skill/stark-*/` so `stark-review-design` should be picked up automatically. If not, fix the glob.

- [ ] **Step 4: Run install to create symlinks**

```bash
./install.sh
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md global/config.json install.sh
git commit -m "docs: update CLAUDE.md, config for design/plan review split"
```

---

## Task 11: Update Evinced org CLAUDE.md references

Update the parent Evinced CLAUDE.md to reflect the new skill names.

**Files:**
- Modify: `/Users/aryeh/Code/CLAUDE.md` — update skill table

- [ ] **Step 1: Update skill table**

Replace deployment-plan and old plan-review entries with:
```markdown
| `/stark-review-design <path>` | Multi-agent design/spec review (3 LLMs × 10 domains) |
| `/stark-review-plan <path>` | Multi-agent execution plan review (3 LLMs × 10 domains, adversarial) |
```

Remove the `stark-review-deployment-plan` row.

- [ ] **Step 2: Commit**

```bash
cd /Users/aryeh/Code/Evinced && git add CLAUDE.md && git commit -m "docs: update skill table for design/plan review split"
```

---

## Task 12: Integration test — dry run both skills

Verify the full pipeline works end-to-end in dry-run mode.

**Files:**
- Test only, no files modified

- [ ] **Step 1: Test design-review dispatch**

```bash
# Create a test design doc
cat > /tmp/test-design.md << 'EOF'
# Widget Service Design

## Goal
Build a widget service that stores and retrieves widgets.

## Architecture
REST API backed by PostgreSQL. Deployed on Kubernetes.

## API
- GET /widgets — list all widgets
- POST /widgets — create a widget
- GET /widgets/:id — get a widget
EOF

# Test dispatch with design-review prompts
cd /Users/aryeh/Code/Playground/stark-skills
$PYTHON $SCRIPTS/plan_review_dispatch.py --file /tmp/test-design.md --prompts-dir design-review --agents claude --timeout 60
```

Verify: JSON output with domains from design-review (general, completeness, security, scope, api-design, data-modeling, consistency, scalability, extensibility, resilience).

- [ ] **Step 2: Test plan-review dispatch**

```bash
cat > /tmp/test-plan.md << 'EOF'
# Widget Service Deployment Plan

## Phase 1: Infrastructure
1. Create Kubernetes namespace
2. Deploy PostgreSQL via Helm chart
3. Create service account

## Phase 2: Application
1. Build Docker image
2. Deploy to staging
3. Run smoke tests
4. Deploy to production
EOF

cd /Users/aryeh/Code/Playground/stark-skills
$PYTHON $SCRIPTS/plan_review_dispatch.py --file /tmp/test-plan.md --prompts-dir plan-review --agents claude --timeout 60
```

Verify: JSON output with domains from plan-review (general, completeness, security, feasibility, operability, sequencing, rollback, risk, gates, timeline).

- [ ] **Step 3: Run existing tests**

```bash
cd /Users/aryeh/Code/Playground/stark-skills
python -m pytest scripts/test_plan_review_dispatch.py scripts/test_tournament.py -v
```

Expected: All tests PASS.

- [ ] **Step 4: Commit (no changes — test-only)**

No commit needed. Clean up temp files:
```bash
rm /tmp/test-design.md /tmp/test-plan.md
```
