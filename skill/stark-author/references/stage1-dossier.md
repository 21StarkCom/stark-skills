# STAGE 1 DOSSIER — Human-Gated Spec+Plan Authoring for Coding Agents

**Prepared:** 2026-07-25 · **Brief:** `stage1.research.md` · **Method:** two-pass research harness — 8 search angles, 33 sources fetched, **61 claims put through 3-vote adversarial verification: 58 confirmed (57 unanimous, 1 split 2-1), 3 refuted, 0 unverified.** Citations marked **⊘uv** were extracted with verbatim quotes but did not go through the verification panel — they are corroborating color, never sole support. Axiom check: **no Tier A MEASURED evidence contradicting any axiom (A1–A5) surfaced in either pass** — the brief's axiom-override rule was never triggered.

---

## 1. EXECUTIVE VERDICT

1. **The client's Stage 1 shape survives contact with the evidence.** Interview-first, one doc, human-only gate, deterministic verification — all supported or unopposed.
2. **Structured interviews are the RE canon's measured best elicitation technique.** Card sorting, ranking, think-aloud measure *worse*. [RQ1]
3. **Voice ambiguities; never silently resolve.** Silent wrong disambiguation is the one failure mode that loses tacit knowledge. [RQ1]
4. **Question wording, coverage, and order go in the protocol,** not the interviewer's judgment — novices show zero unaided improvement on exactly those. [RQ1]
5. **One-doc topology stands** — Anthropic prescribes it verbatim; Kiro/spec-kit ship splits; **nobody has measured either side.** Multi-file ceremony has two documented inflation failures. [RQ2][RQ7]
6. **Task sizing is now MEASURED, not taste:** agent success decays exponentially with human-task length; 80%-reliability horizons are 4–6× shorter than headline 50% ones. Size tasks in tens of human-minutes. [RQ4]
7. **The human gate is a vigilance task and will rot** — sing-song ritual, 82%-surface vs 31%-conceptual catch rates, attitude-driven rubber-stamping. Design against decay: value-stating checklist items, <400 lines, <60 min, speed tripwires. [RQ5]
8. **Keep exactly one zero-shared-context advisory pass** — Anthropic's own contract: fresh context, artifact+criteria only, correctness/stated-requirements scope, findings to the human once. Never a loop. [RQ5]
9. **A1/A3 rest on Tier A MEASURED ground:** intrinsic self-correction degrades accuracy (GPT-4 GSM8K 95.5%→89.0%); prior gains needed oracle stop-labels. [Axioms]
10. **The ≤500-line bound has no evidence basis anywhere.** Nearest measured anchor: human review collapses past ~200–400 lines and ~60 minutes. Bound the gate read, not the doc. [RQ7]
11. **The handoff is real engineering:** fresh session = empty context by definition; curated ~300-token context beat full ~113k across 18 models; repo familiarity is worth 5–18× in completion time. Pin the non-derivable, let the rest be re-derived. [RQ8]
12. **Skip tier is verbatim vendor guidance:** "If you could describe the diff in one sentence, skip the plan." [RQ7][A5]
13. **Never trust felt speed:** devs measured 19% slower while feeling 20% faster. Measure first-pass acceptance and rework, not wall-clock or vibes. [RQ9]
14. **Nothing measures the core trade head-to-head** — human-only gate vs LLM-review loops on implementation outcomes. The case is assembled from adjacent evidence; A/B it locally. [Open Questions]

---

## 2. PER-RQ FINDINGS

### RQ1 — Elicitation

**Verdict: strongest-evidenced RQ. Interview-first is right; the levers are concrete. Confidence HIGH.**

- **Structured interviews beat everything else measured.** Systematic aggregation of controlled elicitation experiments: "interviews, preferentially structured, appear to be one of the most effective techniques"; "many techniques often cited in the literature, like card sorting, ranking or thinking aloud, tend to be less effective than interviews." (Davis/Dieste/Hickey/Juristo/Moreno, RE'06; re-confirmed in the 30-study/43-technique Dieste & Juristo TSE 2011 aggregation; aligned with Pacheco 2018 SLR. MEASURED-aggregated, 3-0×2.) **Transfer caveat:** all of it is human-analyst evidence; agent-led transfer is inference — no measured agent-interviewer study survived verification.
- **Voiced ambiguity is a tacit-knowledge picklock.** In 34 simulated customer-analyst interviews (232 ambiguous fragments), voicing a perceived ambiguity failed to disclose knowledge in only 9% (CS customers) / 4% (domain-expert customers) of cases. "The only cases in which tacit knowledge cannot be accessed, are those of undetected incorrect disambiguation" — silently assigning a wrong reading and never asking. (Ferrari/Spoletini/Gnesi, REJ 2016. OBSERVED — self-described vision paper, analyst = first author. MEDIUM, 3-0×3.)
- **Interview mistakes are catalogued and do not self-correct.** 34 unique mistakes in 7 themes; novices "struggled mostly in the areas of question formulation, question omission and interview order and did not manage to improve their skills throughout the three interviews." Targeted mistake-taxonomy training (SaPeer, REJ 2020) does reduce them — unguided practice yields nothing. (Bano et al., REJ 2019. MEASURED-observational on student proxies. HIGH, 3-0×2.) → **wording/coverage/order must be encoded in the skill, not left to the model's in-session judgment** (recommendation-strength inference, flagged).
- **Agent-era practice independently converged on interview-first.** Anthropic (Claude Code best practices, live 2026-07-25): "Don't ask obvious questions, dig into the hard parts I might not have considered… Keep interviewing until we've covered everything, then write a complete spec to SPEC.md." spec-kit ships `/speckit.clarify` — 9-category ambiguity taxonomy, **max 5 targeted questions**, answers written back into the spec, recommended before planning. (Tier A + A* format facts. HIGH, 3-0×2.)
- **Interview failure modes named by the brief map onto the evidence:** premature convergence = Ferrari's undetected incorrect disambiguation; question fatigue = spec-kit's 5-question and 3-marker caps (vendor precedent, not measured); sycophantic confirmation = the Anthropic "don't ask obvious questions" instruction plus RQ5's attitude-bias evidence. No direct measurement of LLM-interviewer sycophancy survived; **LLMREI (arXiv 2507.02564) is the thread to pull** — logged as gap.

### RQ2 — Spec Anatomy & Topology

**Verdict: one-doc default stands, on prescription + practitioner evidence. No measured comparison exists on either side. Confidence MEDIUM (topology), HIGH (format facts).**

- **Anthropic prescribes the client's exact anatomy, verbatim:** "The most useful specs are self-contained: they name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step that proves the feature works. Time spent making the spec precise pays off more than time spent watching the implementation." (OBSERVED internal-practice guidance, zero measured data. 3-0.)
- **The counter-model is real and shipping:** Kiro generates three files per spec (`requirements.md`/`bugfix.md` + `design.md` + `tasks.md`, EARS criteria); spec-kit produces constitution → `spec.md` → `plan.md` → `tasks.md` plus support files, with implementation detail explicitly pushed out of the main plan. (Tier A* format facts, live-verified. 3-0×3.)
- **Multi-file topology has a documented review-burden failure:** "spec-kit created a LOT of markdown files for me to review. They were repetitive, both with each other, and with the code that already existed… I'd rather review code than all these markdown files." (Böckeler, martinfowler.com. OBSERVED. 3-0.) A gate artifact the human prefers to skip is a gate failure — this is also RQ5 evidence.
- **Per-change beats monolithic** (adjacent question, practitioner): "specification per feature works better for medium-to-large projects — especially in existing projects (brownfield)… lighter for the context window, easier to maintain." (Allegro Tech 2026. OPINION. 3-0.) Silent on Kiro-style within-feature splits.
- **What implementing agents consume vs ignore: no telemetry exists.** Adjacent evidence: agents observed *not following* spec instructions despite full scaffolding (Böckeler, below); spec-kit's agent ignored existing-class notes and generated duplicates; Cognition's bar — a context-less subagent can only handle a fully well-defined task (⊘uv). Reported as a gap.

### RQ3 — Verifiability

**Verdict: EARS inline + a closing machine-checkable command. Confidence HIGH on the pattern, SPECULATIVE on the no-command fallback ladder.**

- **EARS is a closed, embeddable syntax:** five templates (ubiquitous, event-driven, state-driven, unwanted-behaviour, optional) targeting eight NL defect classes (ambiguity, vagueness, complexity, omission, duplication, wordiness, inappropriate implementation, untestability); "forces the requirement author to separate" precondition/trigger/response **at write time** — prevention at authoring, not detection at review. Adopted verbatim by Kiro for acceptance criteria. (Mavin et al., RE'09, Rolls-Royce; Kiro docs. HIGH for design-intent/closure/adoption. 3-0×2.) **Efficacy evidence is thin — cite EARS as canon-plus-adoption, never as measured effect** (the pass's own characterization of the EARS evidence base was refuted 0-3; do not repeat it).
- **The closing verification step is Anthropic's anatomy** (RQ2 quote — "end with an end-to-end verification step that proves the feature works"). The doc says "step," not "command"; the page's lead frames it as giving Claude a way to verify its work — runnable pass/fail. (OBSERVED. 3-0.)
- **Why machine-checkable, not prose:** identical Tessl specs generated different code on re-runs (Böckeler, OBSERVED, 3-0) — an NL spec is not a deterministic contract; and an implementing agent marked a "verify implementation" task complete **without writing any test**, substituting manual-testing instructions (marmelab, OBSERVED ⊘uv-adjacent — the inflation claim from the same source verified 3-0). Self-report of compliance is not verification. [A3]
- **Criterion in spec vs first failing test:** no direct evidence. Derived rule (MEDIUM): the spec carries the *criterion* (EARS sentence + the command that would prove it); the implementation session turns each criterion into the first failing test. Supported by direction: METR's messiness finding — agents measurably struggle "without clear feedback loops" (MEASURED, 3-0) — so the spec's job is to *name* the loop.
- **No-single-command features (UI/visual):** no source measured a fallback ladder. SPECULATIVE, evidence-adjacent ladder: (1) scripted probe (Playwright/CLI harness driving the surface — creates the feedback loop METR says agents need), (2) screenshot diff against an accepted baseline, (3) human checklist item at the gate as last resort. Ordering is judgment; the *requirement to pick one explicitly per task* is the evidenced part (feedback-loop necessity).

### RQ4 — Decomposition

**Verdict: task right-sizing is MEASURED. Size in human-minutes, not LOC. Confidence HIGH.**

- **Success decays exponentially with task length** (exponential fit R²≈0.80): ~100% on tasks humans do in <4 minutes, <10% beyond ~4 hours; best early-2025 model's 50%-reliability horizon ≈ 1 human-hour. (METR time-horizon study, NeurIPS 2025. MEASURED. 3-0×3.) Levels are stale (horizons double ~7 months); the curve shape is the durable part.
- **The 80%-reliability horizon is 4–6× shorter than the 50% one** (doubling times equal: 204 vs 207 days — the ratio is durable). Dependable single-session tasks ⇒ **tens of human-minutes** at early-2025 levels; the arithmetic is derived and marked. (MEASURED. 3-0.)
- **Decomposition is the high-value human+agent step:** "the most successful Copilot users were able to decompose the coding task into 'microtasks'… it is precisely the task decomposition process itself that is the more cognitively demanding task, and for which Copilot was not able to provide support." Un-decomposed medium/hard tasks raised failure rates. (Barke et al. via arXiv 2402.11364. OBSERVED, autocomplete-era — agent-era extrapolation flagged, direction corroborated by METR. 3-0.)
- **Practitioner sizing rule converges:** "each task must be possible to implement and TEST within a single context window." (Allegro. OPINION. 3-0.) Reinforced by MEASURED context evidence: input length alone degrades performance even on trivially simple tasks (Chroma; NoLiMa corroboration: GPT-4o 99.3%→69.7% by 32K tokens. 3-0).
- **DAG practice:** Kiro ships dependency-graph + wave execution (concurrent within wave, waves sequential) — but edges are **tool-inferred** (file-overlap/test-relationship, "you don't need to configure anything"), not author-declared, and early users report it buggy (#8402, #9405). (Tier A* + user issues. 3-0.) → Author-declared edges remain the right call for a human-gated artifact; over-serialization guard: default tasks to independent unless a named artifact (file/interface) forces an edge. (Derived, MEDIUM.)
- **Granularity failure directions:** too-big = the measured exponential decay + context-length degradation; too-small = no direct measurement of fixed-overhead domination (gap) — nearest anchor is chain-collapse practice and the observation that per-task fresh contexts are preferred over one long session (superpowers ⊘uv; Anthropic subagent 1,000–2,000-token summaries ⊘uv).

### RQ5 — The Human Gate

**Verdict: the gate works only if engineered against vigilance decay; keep one advisory pass under the Anthropic contract. Confidence HIGH (mechanisms), MEDIUM (advisory-pass keep).**

**Rubber-stamping — causes, measured:**
- **Confirmation review decays into ritual under life-safety stakes:** pilots "had seen a checklist item in the improper status, yet they perceived it as being in the correct status and replied accordingly"; execution becomes "an automatic routine ('sing-song')… done from memory, and not based on the actual state of the item." (Degani & Wiener, NASA CR-177549. OBSERVED + interviews. 3-0.)
- **It has a speed signature, measured in two domains:** Delta 1141 CVR — challenge-to-response gaps under one second, "little time to accomplish actions required to satisfy the proper response" (NTSB via NASA report, MEASURED); code reviewers faster than 450 LOC/hour found below-average defects in 87% of cases; slower than 400 LOC/hour, above-average. (SmartBear/Cisco, 2,500 reviews. MEASURED. 3-0×2.) → **review pace is an instrumentable gate-health tripwire** (application flagged as design inference).
- **Attitude drives acceptance:** reviewers with favorable AI attitudes undercorrect (accept more planted errors); skeptics correct more and score higher accuracy — attitudes stay significant after controls; the published version calls attitudes "the strongest predictor of performance." (Preregistered, n=2,784. MEASURED. 3-0.)
- **The gate is a monitoring task, not a checkpoint:** GenAI's first documented productivity-loss mechanism is the role shift from producing to evaluating — a task class with three decades of vigilance-failure literature (complacency, overload). (arXiv 2402.11364, peer-reviewed synthesis. 3-0.)

**What review catches, measured:**
- **Surface 82%, wrong-cell ~77%, conceptual 31%** — human reviewers of AI output miss exactly the errors requiring conceptual understanding of the rules. (Same preregistered experiment; domain is data annotation — spec transfer is inference. MEASURED. 3-0.)
- **Capacity bounds:** defect detection collapses past ~200–400 lines per review ("LOC under review should be under 200, not to exceed 400"; no review >250 lines exceeded 37 defects/kLOC) and past ~60 minutes per session ("Total review time should be less than 60 minutes, not to exceed 90"). (SmartBear/Cisco. MEASURED, vendor COI + density caveat flagged; measured on code, prose transfer is inference. 3-0×2.)

**Checklists work when designed right:**
- **WHO Surgical Safety Checklist halved mortality** (1.5%→0.8%, P=0.003, eight hospitals). (NEJM 2009. MEASURED, before-after.) **Implementation-dependent:** Urbach 2014 (Ontario, mandated adoption) found no significant mortality effect — a checklist imposed without buy-in does nothing; itself a gate-design datum. (3-0, caveat carried by verifiers.)
- **Design rules from the NASA canon (3-0 each):** responses must state the **actual observed value**, never "checked/set" (ASRS #76798: a wrong V-speed survived a "checked and set" reply); **most critical items first** (interruptions kill checklist tails — Appendix A ranks this above logical-flow ordering); **long lists induce short-cutting** — subdivide into small task-checklists.
- **Plan-stage vs code-stage:** direct comparative evidence absent (gap). Adjacent: error amplification is ordered research > plan > code — "a bad line of a **plan** could lead to hundreds of bad lines of code" — and ~200 lines of plan is claimed sustainably reviewable daily where 2,000 lines of generated code is not (HumanLayer, OPINION ⊘uv); the human's mental model is intact at the plan boundary, degraded on "foreign code" (2402.11364, extracted — the plan-boundary inference was deliberately NOT verified as stated; treat as MEDIUM direction, not fact).

**The advisory-pass question (RQ5 owns it): KEEP ONE — with this exact contract.**
- Anthropic both recommends an adversarial review step and warns what it does wrong: "A reviewer prompted to find gaps will usually report some, even when the work is sound… Chasing every finding leads to over-engineering… Tell the reviewer to flag only gaps that affect correctness or the stated requirements, and treat the rest as optional." Fresh-context framing is the same section's: the reviewer "sees only the diff and the criteria you give it, not the reasoning that produced the change." (Tier A OBSERVED. 3-0.) Corroborating inflation evidence: curl closed its bug bounty after LLM-report confirm-rate fell below 5%; an 80-agent panel unanimously endorsed a nonexistent OpenSSL vulnerability.
- Why it earns its keep despite A1: the A1 evidence condemns **loops and self-correction without oracles** (RQ-Axioms below), not a single one-way advisory read; humans miss conceptual errors at 69% (above) — a fresh reader that *surfaces candidates for the human* attacks precisely that hole; and the failure mode (inflation) is bounded by the contract's narrow scope + "treat the rest as optional."
- **Contract (all elements evidence-backed):** one pass, zero shared context with the authoring session [Anthropic]; input = the spec+plan artifact and its acceptance criteria only [Anthropic]; scope = correctness and stated-requirements gaps only, everything else explicitly optional [Anthropic verbatim]; output = findings list delivered to the human once [A2]; **no second round, no response to findings by the authoring agent, findings die at the human** [A1/A2]. Confidence MEDIUM (prescription + mechanism, no measured head-to-head).

### RQ6 — Context Engineering (brownfield)

**Verdict: the substrate ships the whole toolkit; the rule is "pin the non-derivable, reference the rest." Confidence HIGH (format facts + measurements), with vendor-surface drift caveat.**

- **Brownfield is the measured weak spot:** controlling for length, models do worse on "messier" tasks — "environments without clear feedback loops, or where the agent needs to proactively seek out relevant information." (METR. MEASURED. 3-0.) A spec that pre-loads the relevant repo context and names the feedback loop compensates a measured weakness — it is not ceremony.
- **Standing-context budget:** "target under 200 lines per CLAUDE.md… Longer files consume more context and reduce adherence"; `@path` imports still load at launch. **Stage 1 output must not ride persistent instructions.** (Claude Code memory docs, living. FORMAT-FACT. 3-0.)
- **Locality for free:** subdirectory CLAUDE.md files load only when files there are read; `.claude/rules` with `paths` frontmatter load only on matching files. Per-area conventions go in per-area files, not the handoff doc. (FORMAT-FACT. 3-0.)
- **The content rule is vendor-stated (/doctor trim):** cut what the agent "can derive from the codebase, such as directory layouts, dependency lists, and architecture overviews"; keep "pitfalls, rationale, and conventions that differ from tool defaults." (FORMAT-FACT; spec-application is analogical extension, flagged. 3-0.)
- **Exploration guard + interview cache discipline:** no measured guidance survived verification. Direction (⊘uv, Tier A extraction): just-in-time references over pre-inlined data ("maintain lightweight identifiers — file paths, stored queries — and load data just-in-time"); context rot "emerges across all models" as tokens grow; compaction contract = "preserves architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs." (Anthropic effective-context-engineering, 2025-09-29.) Practical guard (derived, MEDIUM): time-box recon before the interview to a fixed tool-call budget; everything else is looked up on demand during authoring. Cache-prefix note (derived from substrate mechanics, SPECULATIVE): stable system/context prefix + append-only interview turns preserves prompt-cache hits across a long interview; nothing measured this.

### RQ7 — Sizing & Tiering

**Verdict: three tiers, entry by uncertainty/blast-radius, not length. The ≤500-line bound is unevidenced — replace with gate-read bounds. Confidence HIGH (failures + skip rule), MEDIUM (tier boundaries).**

- **Skip rule is verbatim Tier A:** "Planning is most useful when you're uncertain about the approach, when the change modifies multiple files, or when you're unfamiliar with the code being modified. If you could describe the diff in one sentence, skip the plan." Plan mode "adds overhead." (Anthropic, fetched twice to rule out cache echo. 3-0.) — the source of A5.
- **The vendor itself tiers by clarity:** Kiro's standard specs gate every phase on explicit human approval; **Quick Spec** generates all three artifacts with **no approval gates** for well-understood features — but still asks clarifying questions up front. Elicitation survives in the lightest tier; gates don't. (Tier A*. 3-0×2.)
- **Fixed-weight ceremony misfires, twice documented:** Kiro turned a small bug fix into **4 user stories / 16 acceptance criteria** ("like using a sledgehammer to crack a nut"); Spec Kit turned "display the current date" into **8 files / 1,300 lines** (artifact PR independently verified as a real brownfield app). (Böckeler; marmelab. OBSERVED ×2 independent. 3-0×2.)
- **"False sense of control," verbatim:** "Even with all of these files and templates and prompts and workflows and checklists, I frequently saw the agent ultimately not follow all the instructions." Scaffolding volume ≠ compliance; enforcement must be machine-checked gates. (Böckeler. OBSERVED. 3-0.)
- **No length/size bound exists anywhere in the evidence** — negative finding, verified against the Anthropic guidance on-page (the only "concise" language targets CLAUDE.md, non-numeric). The client's ≤500-line default is unsupported **as a spec bound**; the measured neighbors are *review* bounds: ~200–400 lines and ~60 minutes per human review sitting [RQ5]. Recast the number as a **gate-read bound**, and let doc length follow from scope tier. (MEDIUM inference.)
- **What lightweight-SDD keepers do differently:** per-change specs, not system specs (Allegro, OPINION); clarify-then-write with capped questions (spec-kit format-fact); skip tier honored (Anthropic); ceremony proportional to uncertainty (Kiro Quick Spec). No measured team-outcome data — OBSERVED/OPINION tier throughout.

### RQ8 — Handoff Contract

**Verdict: explicit carrier, pinned ref, curated payload, append-only feedback. Confidence HIGH on mechanisms, MEDIUM on protocol details.**

- **The fresh session is empty by definition:** "Each Claude Code session begins with a fresh context window"; the only automatic carriers are CLAUDE.md and auto-memory (MEMORY.md first 200 lines/25KB) — a spec reaches the implementer only via those, a configured SessionStart hook, or **being explicitly read**. (FORMAT-FACT. 3-0.) The 200-line budget rules out the automatic carriers [RQ6] ⇒ **the implementer is explicitly pointed at the spec file; the spec is the only payload.**
- **Curated beats complete, measured:** all 18 tested models scored significantly higher on a focused ~300-token context than the full ~113k-token context containing the same information; input length alone degrades even trivial tasks. (Chroma context-rot; LongMemEval/NoLiMa corroboration. MEASURED, COI flagged. 3-0×2.)
- **What context is worth:** contractors (low repo context) took **5–18× longer** than maintainers on identical internal PR tasks; agent performance tracks contractor time. (METR App C.2. MEASURED; skill confound noted. 3-0.) The handoff artifact's job is to hand the implementer maintainer-level context: where things live, how they're verified, what the constraints are.
- **In-band vs re-derived = the /doctor rule** [RQ6]: in-band — pitfalls, rationale, divergent conventions, exact interface signatures, verification commands, the decisions made in the interview (⊘uv Cognition: "Actions carry implicit decisions, and conflicting decisions carry bad results" — decisions must be pinned explicitly because the implementer never sees the conversation); re-derived — anything greppable (layouts, dependency lists).
- **Pinning and immutability:** no measured study; strong practice convergence (⊘uv): plan-file-only handoff with the executor's step 1 = read the plan, critically review, raise concerns with the human *before* executing (obra/superpowers); progress/notes files as the cross-session memory pattern (Anthropic context-engineering: "note-taking excels for iterative development with clear milestones"). Derived protocol (MEDIUM): record the accepted spec's **git commit hash** in the doc header; implementer verifies repo state ≥ that commit; the accepted spec is **immutable during implementation** — defects and surprises go to an append-only `DEVIATIONS` block/file, never edits; a deviation that changes scope returns to the human gate (re-run Stage 1 diff-review on the re-authored spec). Immutability + append-only mirrors A4 (one writer) and keeps the gate's approval meaningful.

### RQ9 — Measurement

**Verdict: thin, as predicted — but the perception-bias warning is the best-measured fact in the dossier. Reported thin. Confidence HIGH on what not to do.**

- **Self-report inverts reality:** AI-allowed tasks took **19% longer** while the same developers estimated **20% faster** (~39-point gap; forecasts were +24%, economists +39%, ML experts +38% — all directionally wrong). (METR RCT, 16 devs / 246 real issues / mature repos. MEASURED. 3-0.)
- **The 19% is early-2025-specific:** METR's 2026 follow-up re-measures the original cohort at −18% (CI −38%…+9%) and new developers at −4% (CI −15%…+9%) — both CIs cross zero, unlike the original's (+2%…+39%). Cite as a dated measurement, not a constant. (MEASURED. **2-1 — the only split vote in 61 claims**; held at MEDIUM.)
- **Wall-clock is dying as a metric:** developers multitask while agents run; METR calls its own time-based central estimate "likely a bad proxy" and abandoned the task-level time-RCT design (30–50% of participants withheld tasks rather than work AI-less — the same selection bias will hit any local per-task A/B). (OBSERVED, METR's own methods post. 3-0.)
- **Stage-1 leading indicators (derived — the brief's own list survives the perception filter):** first-pass implementation acceptance (impl PR merges without re-plan), re-plan/rework rate, spec-defect escapes (count of `DEVIATIONS` entries per spec), tokens-per-merged-PR. All outcome-side, none perception-based. No source measures these for spec pipelines — gap, honestly. (MEDIUM.)

### Axioms — evidence status

- **A1/A3 (no LLM-review loops; deterministic termination): Tier A MEASURED.** Intrinsic self-correction degrades reasoning (GPT-4 GSM8K 95.5%→91.5%→89.0%; GPT-3.5 CommonSenseQA 75.8%→38.1%); "the model is more likely to modify a correct answer to an incorrect one than to revise an incorrect answer to a correct one"; reported gains depended on **oracle ground-truth stop labels** (75.9%→84.3% with oracle; degrades without) — an LLM loop without a deterministic check has no termination basis. (Huang et al., ICLR 2024, Google DeepMind + UIUC. 3-0×3.) Corroborated: Kamoi TACL 2024 critical survey; Tyen ACL 2024 (error *detection* is the bottleneck); Self-Correction Bench 2025 (64.5% average blind spot across 14 modern models). **Scope boundary:** holds for prompt-driven intrinsic self-correction; RL-trained correctors (SCoRe) and trained process verifiers are bounded counter-examples — irrelevant to Stage 1's untrained-verdict scope.
- **A2 (human-only gate):** Kiro's standard workflow gates every phase transition on explicit human approval (Tier A*, 3-0); Allegro — an org running its own reviewer subagent — still subordinates it: agent review "never replaces the human gate" (OPINION, extracted). No contrary MEASURED evidence.
- **A4 (one writer):** no direct evidence either way; consistent with Cognition's single-threaded-agent recommendation (⊘uv). Axiom stands by design, unopposed.
- **A5 (scope-conditional ceremony):** the Anthropic one-sentence rule is its verbatim source [RQ7]. Unopposed.

---

## 3. THE BLUEPRINT

Everything below lands on the stated substrate (skill + AskUserQuestion + plan mode + hooks + git). Elements with no [RQn] backref are labeled SPECULATIVE.

### 3.1 Interview protocol

1. **Recon before questions (time-boxed).** Read repo map, root CLAUDE.md, files/interfaces plausibly touched. Hard budget: ~10–15 tool calls; everything else is looked up on demand during authoring. [RQ6 exploration guard; budget number SPECULATIVE]
2. **Tier check first.** If the diff is describable in one sentence → say so, skip to a 5-line mini-spec or nothing (§3.3). [RQ7][A5]
3. **Question order is fixed in the skill** (novices never improve unaided on formulation/omission/order [RQ1]): ① scope boundary (what's in, what's explicitly out) → ② files/interfaces touched (named, verified to exist) → ③ behavior + edge cases, EARS-shaped (walk the *unwanted-behaviour* pattern explicitly: "what must NOT happen?") → ④ verification ("what command proves this works?") → ⑤ tradeoffs the human hasn't considered. [RQ1][RQ3]
4. **Budgets:** 2–4 questions per AskUserQuestion call (substrate cap 4); default ≤3 calls for full tier. Leftover ambiguities: **max 3**, marked inline `[NEEDS CLARIFICATION: …]` in the draft. [RQ1 spec-kit precedent — vendor-derived, not measured]
5. **Voice, never resolve silently.** On any ambiguity: state the agent's intended interpretation + ask. Options-format forces a real choice; "whatever you think" is re-asked once as a concrete A/B pair, then marked. [RQ1 Ferrari — the one knowledge-losing failure mode is silent wrong disambiguation]
6. **One adversarial probe per interview, minimum:** challenge the human's own stated assumption with a concrete failure scenario ("dig into the hard parts I might not have considered"). [RQ1 Anthropic]
7. **Stopping rule ("hard parts pinned"):** stop when (a) files+interfaces named and verified, (b) out-of-scope has ≥1 real entry, (c) every planned task has a machine-checkable done-when, (d) unresolved ambiguities ≤3 and marked, (e) the last question round produced zero new decisions. [RQ1/RQ3; operationalization derived — Anthropic's own rule is unoperationalized; (e) is the Ferrari-derived signal, untested → borderline SPECULATIVE]

### 3.2 Spec template (one doc, headings + 1-line contracts)

One self-contained markdown doc per change. [RQ2]

```
# <change-slug> — spec+plan          | header: date, author, accepted-commit (filled at gate)
## Intent                            | 1 short para: why + user-visible effect. No fluff.
## Scope boundary                    | IN: bullets. OUT: bullets — explicit out-of-scope is mandatory. [RQ2]
## Repo context (non-derivable only) | pitfalls, rationale, divergent conventions, exact interface
                                     | signatures + file paths. Nothing greppable. [RQ6][RQ8]
## Behavior contract                 | EARS-patterned criteria (5 templates inlined in the skill,
                                     | unwanted-behaviour mandatory). [RQ3]
## Tasks (DAG)                       | each: files · done-when (machine-checkable) · depends-on
                                     | (author-declared, default independent; edge only when a named
                                     | artifact forces it) · sized tens-of-human-minutes. [RQ4]
## Verification                      | closing command(s) that prove the change end-to-end; per-task
                                     | fallback declared where no command exists (§RQ3 ladder). [RQ3]
## Open questions                    | the ≤3 marked ambiguities, each with its default. [RQ1]
## Deviations (append-only)          | empty at acceptance; implementer-only section. [RQ8]
```

Target length falls out of tier, not a quota; the gate read is what's bounded (§3.4). [RQ7]

### 3.3 Sizing tiers

| Tier | Trigger (decision rule) | Artifact |
|---|---|---|
| **Skip** | Diff describable in one sentence [RQ7 verbatim] | none — just do it |
| **Short** | Single area, known shape, low uncertainty — but not one-sentence [RQ7 Kiro Quick-Spec analog] | Intent + boundary + verification command, ~10–30 lines; interview ≤1 question call |
| **Full** | Any of: uncertain approach · multiple files · unfamiliar code [RQ7 Anthropic's three triggers] | full §3.2 template; interview §3.1 |

Tier is chosen at step 2 of the interview and re-checked once after recon; inflation of a Short change into Full-tier ceremony is the documented failure to refuse. [RQ7]

### 3.4 Human-gate checklist (8 items — every response states a value, none accepts yes/no) [RQ5]

Gate budget: **one sitting, <60 min, <400 lines read**; bigger docs get chunked or the tier was wrong. Sub-minute acceptance of a Full-tier doc is auto-flagged by a hook (speed signature). [RQ5]

1. Restate the change in one sentence of your own words. *(forces conceptual processing — the 31% hole)*
2. Name the one thing most plausibly missing from OUT-of-scope. *(critical items first)*
3. Open two named files; confirm the stated interfaces exist as written. *(anti-hallucination, value-stating)*
4. Read the verification command; state what a false PASS would look like. *(names the feedback loop)*
5. Name the task you would cut first, and why it's safe or not. *(forces DAG engagement)*
6. For each unwanted-behaviour criterion: name a trigger it misses, or state "none". *(EARS adversarial read)*
7. Answer or explicitly accept each marked ambiguity. *(no silent defaults through the gate)*
8. Edit the doc in your editor (plan mode / Ctrl+G) — an accepted Full-tier doc with zero human edits is a tripwire, not a pass. *(ownership signal; SPECULATIVE as a metric, evidence-adjacent via rubber-stamp literature)*

**Advisory pass (kept, one-shot):** runs before the human sits down; zero shared context; input = artifact + criteria only; scope = correctness + stated-requirements gaps, all else optional; output = findings appended to the gate view for the human, once. No loop, no reply, findings die at the human. [RQ5][A1][A2]

### 3.5 Handoff contract

- **Carrier:** implementer session is started with an explicit instruction to read the spec file; nothing rides CLAUDE.md/MEMORY.md. [RQ6][RQ8]
- **Pin:** gate acceptance stamps the header with the accepted **commit hash**; implementer's first action verifies repo state contains it. [RQ8 — protocol derived, MEDIUM]
- **First-move contract (implementer):** read spec → critically review → raise blockers to the human **before** executing; then per task: turn the criterion into the first failing check, implement, verify, commit. [RQ8 superpowers pattern ⊘uv; RQ3]
- **Immutability:** the accepted spec text is never edited during implementation. Defects/surprises → append-only `## Deviations` entries. A deviation that moves the scope boundary stops work and returns to the gate; the re-authored spec is reviewed **as a diff** against the accepted version. [RQ8][A4; diff-review step derived]
- **Per-task context:** each task is executed to fit one clean context (right-sizing upstream guarantees it); no accumulating mega-session. [RQ4][RQ8]

### 3.6 Measurement (lightweight, perception-proof) [RQ9]

Track per merged change, from git/PR metadata only: **first-pass acceptance** (impl merged with zero re-plan), **re-plan count**, **deviation count** (spec-defect escapes), **tokens-per-merged-PR**. Never wall-clock, never self-rating. Review pacing (time-in-gate vs doc size) is recorded as a gate-health signal, not a productivity number. [RQ5][RQ9]

---

## 4. CALIBRATION WALKTHROUGHS

**C1 — credentials-settings surface, Electron menubar app (TS, existing IPC bridge, no UI test coverage).**
Recon names the IPC bridge modules, existing settings store, and preload surface (~10 calls). Tier: **Full** — multiple files + UI + storage decision. Interview: 2 AskUserQuestion calls / 7 questions — storage backend (safeStorage vs keytar vs plaintext-with-warning: options), cred lifecycle (edit/delete/migrate existing?), failure display (locked keychain?), OUT (no general settings redesign, no autofill), unwanted-behaviour probe ("must never log or IPC-broadcast the secret"), verification choice. Doc ≈ 180 lines, 6 tasks (schema → main-process store → IPC handlers → renderer form → wiring → probe), DAG mostly linear with the form parallel to store. Verification: `npm test` for store/IPC units + **scripted probe** (Playwright drives open→save→restart→read-back) since no single command covers UI; visual polish lands as a gate checklist item — the RQ3 ladder's last resort, used for the one slice that earns it. Gate read ≈ 15 min. Feels proportional — no revision needed.

**C2 — Jira-boards cache layer, Go CLI (SQLite localdb, existing sync framework, good coverage).**
Recon reads the sync framework interfaces and localdb schema conventions. Tier: **Full**, lean — approach known, but multi-file + a semantic decision (staleness). Interview: 1–2 calls / 5 questions — TTL vs explicit-sync staleness (options), invalidation on board mutation?, offline read behavior, OUT (no new Jira endpoints, no UI), verification. Doc ≈ 120 lines, 5 tasks (schema migration → store + tests → sync-framework integration → CLI read path → integration test), author-declared edges (store before integration; CLI parallel to nothing). Verification: `go test ./...` + one named integration test (`TestBoardsCacheSync`) as the closing command — the good-coverage case is the easy case. Gate read ≈ 10 min. The blueprint is near-invisible here — as it should be on a well-understood repo.

---

## 5. ANTIPATTERNS TABLE — do not build

| Antipattern | Documented failure | Source |
|---|---|---|
| LLM-reviews-LLM fix loop | Self-correction degrades accuracy (95.5→89.0 GSM8K); flips right→wrong more than it fixes; gains required oracle stop labels | Huang ICLR 2024 (MEASURED) |
| Model committee / multi-agent debate as QA | Debate drifts off-problem and harms performance; 80 agents unanimously endorsed a nonexistent OpenSSL vuln; curl bounty confirm-rate <5% | arXiv 2502.19559 ⊘uv; corroborations in verified RQ5 finding |
| Unscoped LLM reviewer | "A reviewer prompted to find gaps will usually report some, even when the work is sound" → over-engineering chase | Anthropic best practices (3-0) |
| LLM artifact-QA gate in the pipeline | The ecosystem's own answer (`/speckit.analyze`) is an LLM-executed cross-artifact pass — and even the vendor keeps it optional; rejected here per A1/A2 | spec-kit format-fact (3-0) |
| Fixed-weight ceremony on every change | Bug fix → 4 stories/16 criteria; "display the date" → 8 files/1,300 lines | Böckeler; marmelab (OBSERVED ×2) |
| Multi-file spec per change | Markdown proliferation, repetitive with each other and the code; reviewer preferred reviewing code | Böckeler (OBSERVED) |
| Spec volume as control | "False sense of control" — agent ignored instructions despite full scaffolding | Böckeler (OBSERVED) |
| Prose spec as contract | Identical Tessl spec → different code across runs | Böckeler (OBSERVED) |
| Trusting agent completion claims | "Verify implementation" marked done with no test written | marmelab (OBSERVED) |
| Yes/no confirmation gate | Sing-song ritual; items answered from memory; bare "checked/set" caused real failures | NASA CR-177549 (OBSERVED/MEASURED) |
| One long gate sitting / giant doc review | Detection collapses past ~400 lines and ~60 min | Cisco/SmartBear (MEASURED) |
| Spec in CLAUDE.md / standing context | 200-line target; longer reduces adherence; imports still load at launch | Claude Code memory docs (FORMAT-FACT) |
| Wall-clock + self-report metrics | 19% slower measured vs 20% faster felt; METR: time-spent "likely a bad proxy" | METR (MEASURED) |

---

## 6. OPEN QUESTIONS — and how to A/B locally

1. **Human-only gate vs LLM-review loop, head-to-head:** unmeasured anywhere. Local A/B: alternate per change (same repo, same tier) between Stage 1 as specified and Stage 1 + one bounded LLM fix round; score first-pass acceptance + deviation count over ~20 changes. Perception-proof by construction (git metadata only). [RQ5/RQ9]
2. **One-doc vs three-file split at the change level:** prescriptions conflict, zero measurements. Local A/B: same alternation, implementer session blind to authoring mode; measure re-plan rate and tokens-per-merged-PR. [RQ2]
3. **2026 task-size bound:** early-2025 levels (~1h @50%, tens of minutes @80%) are stale; the 4–6× reliability discount is the durable ratio. Local calibration: log per-task human-estimate vs agent success for a month; refit the curve. [RQ4]
4. **Prose review pacing tripwire:** sub-second/450-LOC-hr signals are cockpit/code numbers. Local: instrument gate time vs doc lines; flag the fastest decile for spot re-review; adjust threshold from observed misses. [RQ5]
5. **Stopping-rule validity:** "(e) zero new decisions in the last round" is Ferrari-derived and untested. Local: log rounds-to-stop and correlate with deviation count per spec. [RQ1]
6. **Agent-led interview transfer:** all elicitation canon is human-analyst. Watch LLMREI (arXiv 2507.02564) and successors; re-verify before treating protocol numbers as measured. [RQ1]

---

## 7. BIBLIOGRAPHY

**Tier A (load-bearing):**
- Davis, Dieste, Hickey, Juristo, Moreno — *Effectiveness of Requirements Elicitation Techniques* (RE'06). https://ieeexplore.ieee.org/document/1704061/
- Dieste & Juristo — *Systematic Review and Aggregation of Empirical Studies on Elicitation Techniques* (IEEE TSE 37(2), 2011). https://ieeexplore.ieee.org/document/5416730
- Ferrari, Spoletini, Gnesi — *Ambiguity and tacit knowledge in requirements elicitation interviews* (REJ 21, 2016). https://link.springer.com/article/10.1007/s00766-016-0249-3 (OA: https://openportal.isti.cnr.it/data/2016/353983/2016_353983.postprint.pdf)
- Bano, Zowghi, Ferrari, Spoletini, Donati — *Teaching requirements elicitation interviews* (REJ 24, 2019). https://link.springer.com/article/10.1007/s00766-019-00313-0
- Mavin, Wilkinson, Harwood, Novak — *EARS* (RE'09, Rolls-Royce). https://www.researchgate.net/publication/224079416_Easy_approach_to_requirements_syntax_EARS · https://alistairmavin.com/ears
- Huang et al. — *Large Language Models Cannot Self-Correct Reasoning Yet* (ICLR 2024). https://arxiv.org/abs/2310.01798
- Kamoi et al. — *When Can LLMs Actually Correct Their Own Mistakes?* (TACL 2024). https://aclanthology.org/2024.tacl-1.78/ ⊘uv-corroborating
- METR — *Measuring AI Ability to Complete Long Tasks* (blog 2025-03-19 + arXiv 2503.14499, NeurIPS 2025). https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/ · https://arxiv.org/abs/2503.14499
- METR — *Early-2025 AI on Experienced OSS Developer Productivity* (blog 2025-07-10 + arXiv 2507.09089). https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ · https://arxiv.org/abs/2507.09089
- METR — *Uplift update / experiment redesign* (2026-02-24). https://metr.org/blog/2026-02-24-uplift-update/
- Degani & Wiener — *Human Factors of Flight-Deck Checklists* (NASA CR-177549, 1990). https://ntrs.nasa.gov/api/citations/19910017830/downloads/19910017830.pdf
- Haynes et al. — *A Surgical Safety Checklist to Reduce Morbidity and Mortality* (NEJM 2009). https://www.nejm.org/doi/abs/10.1056/NEJMsa0810119
- *Who Reviews the AI?* — preregistered review-of-AI-output experiment, n=2,784 (arXiv 2509.08514; HDSR 8.2 2026). https://arxiv.org/html/2509.08514v1
- Simkute et al. — *Ironies of Generative AI* (arXiv 2402.11364; IJHCI 2024). https://arxiv.org/pdf/2402.11364
- Anthropic — *Claude Code best practices*. https://code.claude.com/docs/en/best-practices
- Anthropic — *Claude Code memory docs* (living, ~v2.1.217 era). https://code.claude.com/docs/en/memory
- Anthropic — *Effective context engineering for AI agents* (2025-09-29). https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ⊘uv
- arXiv 2502.19559 — *Problem Drift in Multi-Agent Debate* (EACL 2026). https://arxiv.org/abs/2502.19559 ⊘uv
- arXiv 2410.21819 / 2604.22891 — LLM-judge self-preference bias. ⊘uv · arXiv 2604.16790 — *Bias in the Loop* (judge prompt-sensitivity). ⊘uv

**Tier A\* (format facts only; efficacy claims excluded as vendor marketing):**
- AWS Kiro — *Specs* + *Quick Spec* docs; *Faster, smarter specs* blog (wave execution). https://kiro.dev/docs/specs/ · https://kiro.dev/docs/specs/quick-spec · https://kiro.dev/blog/faster-smarter-specs/
- GitHub spec-kit — repo, README command table, `spec-driven.md`, `templates/commands/{specify,clarify,analyze}.md` (live, pinned 2026-07-25). https://github.com/github/spec-kit

**Tier B (corroborating):**
- Böckeler (Thoughtworks) — *Understanding Spec-Driven Development: Kiro, spec-kit, Tessl* (martinfowler.com, 2025-10-15). https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html
- SmartBear/Cisco — *Code review case study* (2,500 reviews; vendor COI flagged). https://static1.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf
- Chroma Research — *Context Rot* (2025-07-14; vendor COI flagged; methods public). https://www.trychroma.com/research/context-rot
- marmelab — *SDD: Waterfall Strikes Back* (2025-11-12; artifact PR https://github.com/adguernier/frequentito/pull/42). https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html
- Allegro Tech — *SDD best practices* (2026-06). https://blog.allegro.tech/2026/06/spec-driven-development-best-practices.html
- Cognition — *Don't Build Multi-Agents* (2025-06-12). https://cognition.com/blog/dont-build-multi-agents ⊘uv
- HumanLayer — *Advanced Context Engineering for Coding Agents* (ace-fca.md, 2025). https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md ⊘uv
- obra/superpowers — *executing-plans* skill (2026-07-05). https://github.com/obra/superpowers/blob/main/skills/executing-plans/SKILL.md ⊘uv

**Refuted in verification (do not cite):** the pass-1 characterization of EARS's empirical basis as a single originator N=1 case study (0-3); "spec template forbids silent assumption-filling + checklist blocks completion" as originally phrased (0-3 — superseded by the narrower re-verified format-facts above); "/speckit.analyze as an A1-violating review gate" as originally framed (1-2 — superseded by the 3-0 re-verified format-fact, reported in §5 with the vendor-optional qualifier).
