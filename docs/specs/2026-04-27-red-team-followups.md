# Red-team follow-ups (deferred from 2026-04-27 calibration review)

The 2026-04-27 calibration switched the default red-team model to `gpt-5.5-pro`. Acting on its own findings, the same PR (a) expanded `_RED_TEAM_LOCKED_FIELDS` (rt2) and (b) made parse-error surface as `error` instead of silent clean (rt3). The findings below were deferred to keep that PR focused; each should be filed as its own GitHub issue.

Each item below lists the original finding ID, the failure mode, the proposed counter-measure, and the rough size of the change.

## High priority

### FU-rt7 — Round-local IDs are unstable across reruns

Source: `gpt-5.5-pro` finding rt7 (data architect, high).

**Failure:** Human-review acceptance is keyed by round-local IDs like `rt3`. On resume, a fresh LLM call can renumber or rephrase findings, so `--accept-red-team-human-review rt3` may acknowledge a different concern than the human read. This is an accidental distributed-identity bug between PR comments, state, audit, and CLI input.

**Counter-proposal:** Use stable finding keys of the form `{run_id}:{stage}:{round_num}:{persona}:{finding_id}:{concern_hash}` and have the CLI display the matched concern text before accepting it.

**Size:** Medium. Affects: schema (add `concern_hash` to `RedTeamFinding` or compute on the fly), `validate_findings`, the CLI accept path, the audit table schema, the PR comment template.

### FU-rt5 — Bag-of-words Jaccard is too weak for a blocking gate

Source: `gpt-5.5-pro` rt5 (reliability-distsys, high).

**Failure:** The same architectural risk can be phrased differently and fail Jaccard overlap (false flicker classification); unrelated generic concerns can match by vocabulary (false stable). Halt behavior is therefore sensitive to wording noise, not stable risk identity.

**Counter-proposal:** Extend the output schema with structured fields like `risk_key`, `affected_component`, `failure_mode`. Compute overlap from persona + structured fields, with embedding similarity as a secondary check.

**Size:** Large. Touches: prompt schemas (preamble, design.md, plan.md), `RedTeamFinding`, `_overlap`, possibly a new embedding service dependency.

### FU-rt1 — No hermetic execution boundary for codex dispatch

Source: `gpt-5.5-pro` rt1 (security-trust, critical).

**Failure:** Delimiter wrapping protects the prompt instruction hierarchy but does not constrain what the Codex process can read or do if tool execution is available. A prompt injection in attacker-controlled artifact/diff text could turn a bad review verdict into workspace mutation, secret exposure, or lateral movement through inherited environment.

**Counter-proposal:** Run red-team calls in a locked sandbox: temporary directory containing only rendered prompt inputs, read-only filesystem, no shell/tools or explicit no-tools mode, no inherited repo or host secrets, network access only to the model endpoint. Fail preflight if the boundary cannot be enforced.

**Size:** Large. Probably blocked on a shared sandboxing primitive that the rest of the agent fleet would also benefit from. Currently mitigated by the Responses-API transport for the locked default models (no local tool execution surface), but the codex-CLI fallback path for other models retains this risk.

### FU-rt6 — Raw finding text retention has no sensitivity classification

Source: `gpt-5.5-pro` rt6 (data architect, high).

**Failure:** Audit design stores raw finding text for 180 days without a sensitivity classification or redaction boundary. Findings can quote requirements, PR diffs, customer data, secrets, or security architecture details. Reusing `forged_review_metrics.db` turns a metrics database into a sensitive document store with a larger retention and access-control burden.

**Counter-proposal:** Classify red-team finding text as sensitive audit data. Redact known secrets and PII before insert. Encrypt or restrict the database. Store hashes/excerpts by default; require an explicit org/repo policy to retain full raw text.

**Size:** Medium. Affects: audit insert path, retention policy doc, key management.

## Medium priority

### FU-rt8 — v1 human-review halt isn't recoverable

Source: `gpt-5.5-pro` rt8 (product-dx, high).

**Failure:** The spec says human-review findings halt unconditionally, but `--accept-red-team-human-review` is "not yet implemented in v1". A user can be stopped by a finding with no supported way to acknowledge it short of disabling the feature or editing state manually.

**Counter-proposal:** Make `--accept-red-team-human-review` plus a `red-team status` display a v1 release blocker; if that slips, ship v1 with `allow_human_review_halt: false` and advisory comments until resume support lands.

**Size:** Small (CLI plumbing) — but coupled to the broader CLI/state-resume work.

### FU-rt11 — Run-level telemetry hides per-call attribution

Source: `gpt-5.5-pro` rt11 (cost-ops, high).

**Failure:** Proposed events are run-level: an operator can't quickly tell which phase caused a budget halt, timeout, or latency spike. No per-call input/output tokens, cost, actual model, prompt size, truncation status, or call type (primary vs. verification vs. regeneration vs. review).

**Counter-proposal:** Emit `red_team.call.start` / `red_team.call.end` events for every primary, verification, regeneration, and review call with token counts, cost, cumulative cost, budget remaining, actual model, prompt chars, truncation flag, and call type.

**Size:** Small. Mostly plumbing in the orchestrator caller; the dispatcher already tracks the relevant fields per call.

### FU-rt9 — Per-persona PR comments fragment the discussion

Source: `gpt-5.5-pro` rt9 (product-dx, medium).

**Failure:** Five per-persona comments per round duplicate the same synthesis. Two rounds = ten bot comments before flicker/halt/resume messages add more. Reviewers may stop engaging.

**Counter-proposal:** Post one updatable summary comment per run with collapsible persona sections and deterministic anchors. Create separate persona threads only for critical/high findings that need discussion.

**Size:** Small (output formatting). Trades off the persona-thread filtering affordance.

### FU-rt4 — Flicker path has contradictory state semantics

Source: `gpt-5.5-pro` rt4 (reliability-distsys, high).

**Failure:** Flicker rounds consume `max_rounds` without producing a remediation attempt; the design gives conflicting accounts of whether the result becomes advisory, `clean_after_flicker`, or unresolved halt. Users can see nondeterministic exits even when no stable blocking finding was ever confirmed.

**Counter-proposal:** Model the loop as an explicit state machine: record primary and verification outputs before branching; assign each round an outcome of `clean | confirmed_blocking | flicker | degraded`; do not count flicker as a remediation round; terminate only through named transitions.

**Size:** Medium. Largely a refactor of the existing iterative loop with named states and explicit transition logging.

## Notes

- **Sample size:** All findings come from N=1 calibration runs. Before any of these is acted on, a 5–10 run pair would let us check that the same concerns reappear stably. The pairwise Jaccard between our two existing runs was 0, which means the model is sampling very different concern sets — single-run reliance for follow-up prioritization is suspect.
- **rt10 (default budget) is fixed in this PR** by raising `per_run_budget_usd` from $10 → $15.
- **rt2 and rt3 are fixed in this PR.**
