# `/stark-design-arena` — Design Spec

> 3-LLM competitive pipeline: collaborative brainstorm → design tournament → plan tournament. Each phase produces an HTML visualization with cross-evaluated scores. Human picks the winner at each gate.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-03-26-stark-design-arena-design.md`

---

## Problem

Current flow: one LLM writes the spec, then 3 LLMs review it. The quality ceiling is limited by the single author — reviewers catch bugs but can't inject fundamentally different architectural ideas. The design space is explored narrowly.

A competitive approach produces 3 independent designs for the same problem. Each is cross-evaluated by the other 2 LLMs (no self-scoring). The human sees all 3 with scores and reasoning, picks the best, and moves to planning — where the same competition repeats.

## Goals

1. **Collaborative brainstorm** — 3 LLMs contribute questions, deduplicated, human answers once
2. **Design tournament** — 3 independent designs, cross-evaluated, HTML visualization, human picks
3. **Plan tournament** — 3 independent plans for the chosen design, cross-evaluated, HTML visualization, human picks
4. **Full artifact trail** — every question, design, plan, score, and reasoning stored for learning
5. **Prompt improvement flags** — systematic detection of where the process can improve

## Non-Goals

- Replacing `/stark-review-design` or `/stark-review-plan` — this skill produces artifacts, those skills validate them
- Autonomous execution — the human picks the winner at every gate
- Real-time collaboration between LLMs — they work independently, consolidation is algorithmic
- Code generation — this skill produces designs and plans, not implementations

---

## Architecture

```
User idea
    │
    ▼
┌─────────────────────────────────────────────┐
│  Phase 1: Brainstorm (collaborative)        │
│                                             │
│  3 LLMs → questions → deduplicate →         │
│  present to human → human answers →         │
│  all LLMs get Q&A → follow-up round(s) →    │
│  consolidated requirements brief            │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│  Phase 2: Design Tournament (competitive)   │
│                                             │
│  3 LLMs → 3 designs (parallel) →            │
│  cross-evaluation (6 pairs) →               │
│  HTML visualization (side-by-side) →        │
│  human picks winner                         │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│  Phase 3: Plan Tournament (competitive)     │
│                                             │
│  3 LLMs → 3 plans for chosen design →       │
│  cross-evaluation (6 pairs) →               │
│  HTML visualization (side-by-side) →        │
│  human picks winner                         │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
    Approved plan → ready for execution
```

---

## Agents

The 3 competing agents:

| Agent | CLI | Strengths |
|-------|-----|-----------|
| Claude | `claude -p - --output-format text --model claude-opus-4-6` | Nuanced reasoning, architectural depth, trade-off analysis |
| Codex | `codex exec -c ... --ephemeral --json --full-auto -` | Code-centric thinking, practical implementation focus |
| Gemini | `gemini -p <prompt> -o json` | Breadth scanning, alternative pattern recognition |

All 3 participate in every phase — both as producers and cross-evaluators.

---

## Phase 1: Brainstorm

### Goal

Transform a vague idea into a clear, complete requirements brief through structured questioning. All 3 LLMs contribute questions — the human answers once, all LLMs see everything.

### Flow

```
Round 1:
  User provides: idea description (free text)
  ──────────────────────────────────────────
  → Dispatch to all 3 LLMs: "Given this idea, what clarifying
    questions would you ask before designing a solution?
    Return exactly 5-10 questions as a JSON array."
  → Collect 3 question sets (15-30 questions total)
  → Deduplicate: cluster semantically similar questions,
    keep the best-worded version of each
  → Present deduplicated questions to human (multiple-choice
    + free text answers)
  → Human answers all questions

Round 2 (optional, if LLMs request follow-ups):
  → Send idea + Round 1 Q&A to all 3 LLMs:
    "Based on the answers, do you need any follow-up
    clarifications? Return 0-3 follow-up questions as JSON.
    Return empty array if you have enough."
  → Deduplicate follow-ups
  → If total follow-ups > 0: present to human, collect answers
  → If all LLMs returned empty: brainstorm is complete

Round 3 (max — hard stop):
  → If Round 2 produced follow-ups, one more round
  → After Round 3, brainstorm ends regardless
```

### Question Deduplication

Questions from 3 LLMs will overlap. Deduplication strategy:

1. Send all collected questions to Claude (as the coordinator) with this prompt:
   ```
   Here are N questions from 3 different reviewers about the same project idea.
   Many are semantically similar or overlapping.

   Deduplicate: group similar questions, keep the best-worded version of each.
   Merge complementary questions into a single clearer question.
   Preserve any unique angle that only one reviewer asked about.

   Return a JSON array of deduplicated questions, ordered from most
   fundamental (requirements, constraints) to most specific (implementation
   preferences). Target 8-12 final questions.
   ```

2. Each deduplicated question notes which LLMs originally asked it (for attribution and learning).

### Question Presentation

Questions are presented **one at a time** in conversational style, ordered from most fundamental (requirements, constraints) to most specific (implementation preferences). Each question supports:

- **Multiple-choice** — if the question has clear option categories, present them as a/b/c/d
- **Free text** — if the question is open-ended
- **Skip** — human can skip a question ("don't care" / "decide for me")

Format per question:
```
Question 3/11:
What consistency model does the system need?

  a) Strong consistency — every read sees the latest write
  b) Eventual consistency — reads may lag by seconds, that's fine
  c) Mixed — strong for some data, eventual for others
  d) Don't care — decide for me

Your answer:
```

Skipped questions are noted in the brief as "author deferred — LLMs should make a reasonable choice and state their assumption."

### Requirements Brief

After all Q&A rounds, the skill generates a consolidated requirements brief:

```markdown
# Requirements Brief: {project name}

## Idea
{original description}

## Clarified Requirements
{for each answered question: question + answer, grouped by topic}

## Constraints
{extracted from answers: tech stack, timeline, team, budget, etc.}

## Open / Deferred
{skipped questions and assumptions LLMs should make}

## Scope
{in-scope vs explicitly out-of-scope, derived from answers}
```

This brief is the input to Phase 2. All 3 LLMs receive the identical brief.

---

## Phase 2: Design Tournament

### Goal

3 LLMs independently design a solution for the requirements brief. Each design is cross-evaluated by the other 2 LLMs. Results are visualized in an HTML comparison page. Human picks the winner.

### Design Prompt

Each LLM receives:

```
You are competing in a design tournament. 3 LLMs are independently
designing a solution for the same requirements. Your design will be
scored by the other 2 LLMs.

## Requirements Brief
{full brief from Phase 1}

## Your Task
Produce a complete design document with these sections:

1. **Architecture** — system decomposition, component boundaries,
   communication patterns, data flow
2. **API Design** — endpoints/interfaces, contracts, versioning approach
3. **Data Model** — schema, storage choices, migration strategy
4. **Security** — auth model, trust boundaries, data classification
5. **Failure Modes** — what breaks, blast radius, recovery strategy
6. **Trade-offs** — what you chose, what you rejected, why
7. **Scalability** — load estimates, growth plan, bottleneck analysis
8. **Operational Model** — deployment, monitoring, on-call impact

Each section should be concrete (file paths, technology choices, specific
numbers) not hand-wavy. Defend your choices — the judges will challenge
vague reasoning.

Output as a single markdown document.
```

### Cross-Evaluation

After collecting 3 designs, each LLM evaluates the other 2 (not its own). 6 evaluation pairs total:

```
Claude evaluates: Codex's design, Gemini's design
Codex evaluates:  Claude's design, Gemini's design
Gemini evaluates: Claude's design, Codex's design
```

Each evaluation scores on these factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| `architecture_fitness` | 2.0 | Does the architecture fit the problem? Is it the simplest approach that works? |
| `completeness` | 1.5 | Are all requirements addressed? Any gaps? |
| `trade_off_quality` | 1.5 | Are trade-offs explicit, well-reasoned, and appropriate? |
| `feasibility` | 1.5 | Can this actually be built with the stated constraints? |
| `security` | 1.0 | Is the security model appropriate for the data/exposure level? |
| `operational_readiness` | 1.0 | Can this be deployed, monitored, and maintained? |
| `innovation` | 0.5 | Does this bring a creative or non-obvious approach? |

Evaluation prompt:

```
You are judging a design competition. Score the following design on
each factor (1-10). You are NOT scoring your own design.

## Requirements Brief
{brief}

## Design to Evaluate
{design content}

## Scoring Factors
{factor table with descriptions}

For each factor, provide:
- Score (1-10)
- One-sentence reasoning

Return as JSON:
{
  "scores": {
    "architecture_fitness": {"score": N, "reason": "..."},
    "completeness": {"score": N, "reason": "..."},
    ...
  },
  "overall_impression": "2-3 sentence summary of strengths and weaknesses",
  "strongest_aspect": "what this design does best",
  "weakest_aspect": "what this design does worst"
}
```

### Score Aggregation

Each design gets 2 evaluations (from the other 2 LLMs). Final score per factor is the average of the 2 evaluations. Weighted average across factors produces the final score.

```python
for design in designs:
    for factor in factors:
        # Average the 2 evaluator scores
        evaluator_scores = [eval[factor]["score"] for eval in design.evaluations]
        design.factor_scores[factor] = sum(evaluator_scores) / len(evaluator_scores)

    # Weighted average
    design.final_score = weighted_average(design.factor_scores, factor_weights)
```

### HTML Visualization — Design Comparison

Single HTML page with 3 designs side-by-side. Layout:

```
┌──────────────────────────────────────────────────────────────┐
│                    Design Arena — Phase 2                     │
│              {project name} · Design Tournament               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Scores ──────────────────────────────────────────────┐   │
│  │                                                       │   │
│  │   Factor          Claude  Codex   Gemini              │   │
│  │   ──────────────  ──────  ──────  ──────              │   │
│  │   Architecture     8.5     7.0     8.0               │   │
│  │   Completeness     9.0     8.5     7.5               │   │
│  │   Trade-offs       8.0     7.5     8.5               │   │
│  │   Feasibility      8.5     9.0     7.0               │   │
│  │   Security         7.5     8.0     7.0               │   │
│  │   Operations       8.0     8.5     7.5               │   │
│  │   Innovation       7.0     6.5     9.0               │   │
│  │   ──────────────  ──────  ──────  ──────              │   │
│  │   WEIGHTED AVG     8.3     7.9     7.7               │   │
│  │                   ★ 1st   2nd     3rd                │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Per-Evaluator Reasoning ─────────────────────────────┐   │
│  │                                                       │   │
│  │  Claude's design evaluated by:                        │   │
│  │    Codex:  "Strong architecture but..."  (8.1 avg)    │   │
│  │    Gemini: "Comprehensive trade-offs..." (8.5 avg)    │   │
│  │                                                       │   │
│  │  Codex's design evaluated by:                         │   │
│  │    Claude: "Practical approach but..."   (7.8 avg)    │   │
│  │    Gemini: "Good feasibility but..."     (8.0 avg)    │   │
│  │                                                       │   │
│  │  Gemini's design evaluated by:                        │   │
│  │    Claude: "Creative approach but..."    (7.5 avg)    │   │
│  │    Codex:  "Innovative but risky..."     (7.9 avg)    │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Design Details (expandable) ─────────────────────────┐   │
│  │                                                       │   │
│  │  ┌─ Claude ──┐  ┌─ Codex ───┐  ┌─ Gemini ──┐        │   │
│  │  │           │  │           │  │           │        │   │
│  │  │ Full      │  │ Full      │  │ Full      │        │   │
│  │  │ design    │  │ design    │  │ design    │        │   │
│  │  │ markdown  │  │ markdown  │  │ markdown  │        │   │
│  │  │ rendered  │  │ rendered  │  │ rendered  │        │   │
│  │  │           │  │           │  │           │        │   │
│  │  └───────────┘  └───────────┘  └───────────┘        │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Strongest / Weakest ─────────────────────────────────┐   │
│  │                                                       │   │
│  │  Claude:  Best at architecture. Weakest at innovation │   │
│  │  Codex:   Best at feasibility. Weakest at innovation  │   │
│  │  Gemini:  Best at innovation. Weakest at feasibility  │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Footer: Generated by /stark-design-arena · {timestamp}      │
└──────────────────────────────────────────────────────────────┘
```

The HTML uses the shared design-system CSS from `docs/skills/_css/design-system.css` plus arena-specific styles.

### Human Decision

After the visualization opens in the browser, the skill asks:

```
Design tournament complete. Results:

  1. Claude  — 8.3/10 (strongest: architecture, weakest: innovation)
  2. Codex   — 7.9/10 (strongest: feasibility, weakest: innovation)
  3. Gemini  — 7.7/10 (strongest: innovation, weakest: feasibility)

Choose:
  a) Accept #1 (Claude's design) → proceed to plan tournament
  b) Accept #2 (Codex's design)
  c) Accept #3 (Gemini's design)
  d) Edit — pick a design and modify specific sections
  e) Merge — combine sections from different designs
  f) Redo — run the design tournament again with additional guidance
```

If the human picks (d) edit, the skill asks which design and what to change. Claude modifies the design per instructions, human confirms the result.

If the human picks (e) merge, the skill asks which sections from which design. Claude produces a coherent merged document — not a mechanical splice. Terminology is aligned, contradictions resolved, the output reads as a single authored document. Human confirms before proceeding.

If the human picks (f), they can provide additional guidance that gets appended to the requirements brief.

---

## Phase 3: Plan Tournament

### Goal

3 LLMs independently create an implementation plan for the chosen design. Same cross-evaluation and visualization pattern as Phase 2.

### Plan Prompt

Each LLM receives:

```
You are competing in a plan tournament. 3 LLMs are independently
creating implementation plans for the same approved design. Your plan
will be scored by the other 2 LLMs.

## Requirements Brief
{brief from Phase 1}

## Approved Design
{chosen design from Phase 2}

## Your Task
Produce a complete implementation plan with these sections:

1. **Phasing** — group work into phases that deliver incremental value.
   Highest-risk work first. Each phase is independently deployable.
2. **Tasks** — per phase, list every task with:
   - Title and description
   - Files to create/modify
   - Dependencies (which tasks must complete first)
   - Acceptance criteria (testable, specific)
   - Story points (Fibonacci: 1, 2, 3, 5, 8)
   - Risk level (low/medium/high)
3. **Dependency Graph** — which tasks block which. Identify the critical path.
4. **Test Strategy** — what gets tested when, at what level (unit/integration/E2E)
5. **Rollback Plan** — per phase, how to undo if something goes wrong
6. **Non-Functional Tasks** — performance testing, security hardening,
   monitoring setup, documentation — these are NOT optional
7. **Risk Register** — what could go wrong, probability, impact, mitigation

Output as a single markdown document.
```

### Cross-Evaluation Factors

| Factor | Weight | Description |
|--------|--------|-------------|
| `design_fidelity` | 2.0 | Does the plan faithfully implement the chosen design? Nothing dropped, nothing added? |
| `task_quality` | 1.5 | Are tasks right-sized, independently testable, with clear acceptance criteria? |
| `dependency_correctness` | 1.5 | Are dependencies right? Is parallel work genuinely independent? Critical path identified? |
| `phasing` | 1.5 | Does each phase deliver value? Highest risk first? Natural integration points? |
| `risk_mitigation` | 1.0 | Are risks identified with real mitigations, not just listed? |
| `rollback_feasibility` | 1.0 | Can each phase actually be rolled back? Are schema migrations reversible? |
| `completeness` | 1.0 | Are non-functional tasks present? Testing strategy? Documentation? |

### HTML Visualization — Plan Comparison

Same layout as Phase 2 but with plan-specific content. The full design of each plan is rendered in the side-by-side columns. The scoring table uses plan factors instead of design factors.

### Human Decision

Same pattern as Phase 2:

```
Plan tournament complete. Results:

  1. Codex   — 8.6/10 (strongest: task_quality, weakest: innovation)
  2. Claude  — 8.4/10 (strongest: design_fidelity, weakest: rollback)
  3. Gemini  — 7.8/10 (strongest: phasing, weakest: dependency_correctness)

Choose:
  a) Accept #1 (Codex's plan) → save and finish
  b) Accept #2 (Claude's plan)
  c) Accept #3 (Gemini's plan)
  d) Edit — pick a plan and modify specific parts
  e) Merge — combine elements from different plans
  f) Redo — additional guidance
```

Same edit/merge mechanics as Phase 2. Merged plans are coherent single documents with aligned task numbering, consistent dependencies, and no contradictions.

---

## Artifact Storage

Every phase produces artifacts stored for learning and traceability.

### Directory Structure

```
{output_dir}/arena-{timestamp}/
├── meta.json                    # arena metadata (idea, agents, timestamps)
├── phase-1-brainstorm/
│   ├── idea.md                  # original idea text
│   ├── questions-raw/
│   │   ├── claude.json          # Claude's raw questions
│   │   ├── codex.json           # Codex's raw questions
│   │   └── gemini.json          # Gemini's raw questions
│   ├── questions-deduped.json   # deduplicated question set
│   ├── answers.json             # human's answers
│   ├── follow-ups/              # round 2+ Q&A if any
│   └── brief.md                 # consolidated requirements brief
├── phase-2-design/
│   ├── designs/
│   │   ├── claude.md            # Claude's full design
│   │   ├── codex.md             # Codex's full design
│   │   └── gemini.md            # Gemini's full design
│   ├── evaluations/
│   │   ├── claude-scores-codex.json
│   │   ├── claude-scores-gemini.json
│   │   ├── codex-scores-claude.json
│   │   ├── codex-scores-gemini.json
│   │   ├── gemini-scores-claude.json
│   │   └── gemini-scores-codex.json
│   ├── results.json             # aggregated scores, rankings
│   ├── comparison.html          # side-by-side visualization
│   ├── comparison.png           # screenshot of HTML
│   └── chosen.md                # the design the human picked (or merged)
├── phase-3-plan/
│   ├── plans/
│   │   ├── claude.md
│   │   ├── codex.md
│   │   └── gemini.md
│   ├── evaluations/
│   │   ├── claude-scores-codex.json
│   │   ├── ... (same pattern)
│   │   └── gemini-scores-codex.json
│   ├── results.json
│   ├── comparison.html
│   ├── comparison.png
│   └── chosen.md
└── audit.jsonl                  # full audit trail (all events, timings)
```

### Audit Trail

Every significant event is appended to `audit.jsonl`:

```json
{"event": "arena_start", "idea": "...", "timestamp": "..."}
{"event": "brainstorm_questions_collected", "agent": "claude", "count": 8, "duration_s": 12}
{"event": "brainstorm_questions_collected", "agent": "codex", "count": 6, "duration_s": 18}
{"event": "brainstorm_questions_collected", "agent": "gemini", "count": 7, "duration_s": 15}
{"event": "brainstorm_dedup", "raw_count": 21, "deduped_count": 11}
{"event": "brainstorm_answers", "answered": 9, "skipped": 2}
{"event": "brainstorm_complete", "brief_length": 1523}
{"event": "design_generated", "agent": "claude", "length": 4521, "duration_s": 85}
{"event": "design_generated", "agent": "codex", "length": 3892, "duration_s": 120}
{"event": "design_generated", "agent": "gemini", "length": 4103, "duration_s": 95}
{"event": "design_evaluated", "evaluator": "claude", "target": "codex", "avg_score": 7.8}
{"event": "design_evaluated", "evaluator": "claude", "target": "gemini", "avg_score": 7.2}
{"event": "design_results", "rankings": [{"agent": "claude", "score": 8.3}, ...]}
{"event": "design_chosen", "agent": "claude", "human_override": false}
{"event": "plan_generated", "agent": "claude", "length": 6234, "duration_s": 140}
...
{"event": "plan_chosen", "agent": "codex", "human_override": true}
{"event": "arena_complete", "total_duration_s": 1842, "llm_calls": 21}
```

---

## Prompt Improvement Detection

After each arena run, analyze patterns and flag improvement opportunities:

| Signal | Detection | Action |
|--------|-----------|--------|
| An evaluator consistently scores higher than the other evaluator for the same design | `abs(evaluator_A_avg - evaluator_B_avg) > 1.5` across factors | Flag: evaluator calibration issue. The lenient evaluator's prompt may need stricter criteria. |
| One agent consistently loses across multiple arena runs | Track agent win rate across last 10 arenas | Flag: agent's design/plan prompt may need strengthening. Show which factors it scores lowest on. |
| Human frequently overrides the top-ranked result | `human_override: true` in >30% of arenas | Flag: scoring factors may not align with human preferences. Review factor weights. |
| Brainstorm produces too many questions (>15 after dedup) | `deduped_count > 15` | Flag: question generation prompt needs tighter constraints. |
| Brainstorm produces too few questions (<5 after dedup) | `deduped_count < 5` | Flag: question generation prompt needs encouragement to be more thorough. |
| Evaluation reasoning is generic ("good design", "well structured") | Short reason strings or repeated phrases across evaluations | Flag: evaluation prompt needs more specific criteria. |
| One factor dominates the final ranking (others don't differentiate) | Standard deviation of a factor's scores < 0.5 across all designs | Flag: factor may be too broad. Consider splitting into sub-factors. |
| Designs are too similar (agents converging on the same approach) | Text similarity >70% between 2+ designs | Flag: design prompt may be too prescriptive. Encourage different approaches. |

Flags are:
1. Printed in the terminal summary after the arena completes
2. Stored in `audit.jsonl` with `event: "improvement_flag"`
3. Suggest specific prompt files to modify

---

## CLI

```
/stark-design-arena "Build a real-time notification system for our mobile app"
/stark-design-arena --idea-file docs/ideas/notification-system.md
/stark-design-arena --resume arena-20260326-143000  # resume from Phase 2/3
```

### Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `<idea>` | required | Idea description (inline text or --idea-file) |
| `--idea-file` | — | Read idea from a markdown file |
| `--output-dir` | `docs/arena/` | Where to store arena artifacts |
| `--skip-brainstorm` | off | Skip to Phase 2 with a pre-written brief (--brief) |
| `--brief` | — | Pre-written requirements brief (skips Phase 1) |
| `--skip-plan` | off | Stop after Phase 2 (design only, no plan tournament) |
| `--resume` | — | Resume an interrupted arena from the last completed phase |
| `--agents` | `claude,codex,gemini` | Which agents compete |
| `--max-questions` | 12 | Max deduplicated questions in brainstorm |
| `--design-factors` | (defaults) | Override design scoring factor weights |
| `--plan-factors` | (defaults) | Override plan scoring factor weights |

---

## Observability

### Task-Based Progress

```
TaskCreate: "Phase 1: Brainstorm"
            activeForm: "Brainstorming with 3 LLMs"
TaskCreate: "Phase 2: Design Tournament"
            activeForm: "Running design tournament"
TaskCreate: "Phase 3: Plan Tournament"
            activeForm: "Running plan tournament"
```

### Timestamped Logs

```
[HH:MM:SS] === stark-design-arena started ===
[HH:MM:SS] Phase 1: Brainstorm
[HH:MM:SS]   ▸ Collecting questions from 3 LLMs...
[HH:MM:SS]   ▸ 21 raw → 11 deduplicated questions
[HH:MM:SS]   ▸ Waiting for human answers...
[HH:MM:SS]   ▸ 9 answered, 2 skipped
[HH:MM:SS]   ▸ Follow-up round: 3 new questions
[HH:MM:SS]   ▸ Brief generated (1523 chars)
[HH:MM:SS] Phase 1: done (5m 30s — includes human wait time)
[HH:MM:SS] Phase 2: Design Tournament
[HH:MM:SS]   ▸ Dispatching 3 designs in parallel...
[HH:MM:SS]   ▸ Claude: done (85s, 4521 chars)
[HH:MM:SS]   ▸ Codex: done (120s, 3892 chars)
[HH:MM:SS]   ▸ Gemini: done (95s, 4103 chars)
[HH:MM:SS]   ▸ Cross-evaluation: 6 pairs dispatching...
[HH:MM:SS]   ▸ Evaluations complete (avg 25s each)
[HH:MM:SS]   ▸ Visualization: comparison.html generated
[HH:MM:SS]   ▸ Waiting for human choice...
[HH:MM:SS]   ▸ Human chose: Claude's design (8.3/10)
[HH:MM:SS] Phase 2: done (8m 15s)
[HH:MM:SS] Phase 3: Plan Tournament
[HH:MM:SS]   ▸ Dispatching 3 plans in parallel...
...
[HH:MM:SS] === stark-design-arena complete ===
```

### Metrics Block

```
Metrics
───────
Total duration:     22m 45s (including human wait time)
LLM calls:          21 (3 question + 3 design + 6 design-eval + 3 plan + 6 plan-eval)
LLM time:           ~15m (parallel dispatch reduces wall time)
Human wait time:    ~7m

Phase 1 (Brainstorm):    5m 30s (2 rounds)
Phase 2 (Design):        8m 15s
  Generation:            2m 00s (parallel)
  Evaluation:            2m 30s (parallel)
  Visualization:         15s
  Human decision:        3m 30s
Phase 3 (Plan):          9m 00s
  Generation:            3m 00s (parallel)
  Evaluation:            2m 30s (parallel)
  Visualization:         15s
  Human decision:        3m 15s

Improvement flags:       1 (Gemini consistently lowest — check prompt)
```

---

## Error Handling

| Failure | Recovery |
|---------|----------|
| One agent fails during brainstorm questions | Continue with 2 agents' questions. Note the failure. |
| One agent fails during design generation | 2 designs compete. Cross-evaluation adapts (4 pairs not 6). Visualization shows 2 columns. |
| All agents fail | Abort with error. Suggest checking CLI availability and auth. |
| One evaluation fails | Use the surviving evaluation's scores (1 score per factor instead of averaged 2). Flag the gap. |
| All evaluations fail | Skip cross-evaluation. Present designs without scores. Human picks based on reading them. |
| Visualization generation fails (Playwright) | Skip PNG screenshot. HTML file still generated. Terminal fallback shows text comparison. |
| Human interrupts mid-phase | Save all artifacts collected so far. `--resume` can pick up from the last completed phase. |
| Question deduplication fails | Fall back: present all raw questions (with duplicates). Less elegant but functional. |
| LLM returns malformed JSON (questions/evaluations) | Retry once with stricter prompt. If still malformed, use text extraction fallback. |

---

## Relationship to Existing Skills

| Skill | Relationship |
|-------|-------------|
| `/stark-review-design` | Arena produces the design. Review validates it. They're complementary — run review on the arena winner for additional scrutiny. |
| `/stark-review-plan` | Arena produces the plan. Review validates it. Same complementary pattern. |
| `/stark-tournament` | Arena uses tournament mechanics internally but adds the brainstorm phase, cross-evaluation (not single-judge), and HTML comparison visualization. Arena could import tournament's dispatch and scoring utilities. |
| `/stark-plan-to-tasks` | Takes the arena's approved plan and decomposes it into GitHub issues. |
| `/stark-phase-execute` | Executes the issues created from the arena's plan. |

Full pipeline: `/stark-design-arena` → `/stark-review-design` → `/stark-review-plan` → `/stark-plan-to-tasks` → `/stark-phase-execute`

---

## Resolved Questions

1. **Question presentation: one at a time after consolidation.** After deduplication, present questions one by one in conversational style. Order from most fundamental to most specific. This is slower but produces better-quality answers — the human thinks about each question individually instead of rushing through a list.

2. **Human can edit a design before proceeding — yes, in v1.** After choosing a design, the human can say "change the data model section to use X instead." The skill sends Claude the full design + edit instruction, gets back a modified design, human confirms. Same mechanism as merge but simpler. The human decision options become: pick, edit, merge, or redo.

3. **Merge produces a pixel-perfect final output.** LLM-assisted merge — not mechanical section splicing. Claude receives the merge instructions + all relevant sections and produces a coherent merged document. The merge must resolve contradictions, align terminology, and ensure the output reads as a single authored document — not a Frankenstein. The human reviews and confirms the merged result before it becomes the approved design. Same standard applies to plan merges.

4. **Flag only in v1, automatic prompt tuning in v2.** Automatic tuning needs 20+ arena runs for statistical significance. In v1, the improvement flags (evaluator calibration, agent win rates, human override patterns) are surfaced to the user. In v2, the system can propose specific prompt edits based on accumulated data — but the human still approves before changes are applied.
