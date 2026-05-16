# Red-team data-classification contract

**Date:** 2026-05-16
**Phase:** 1b of the red-team TS migration plan (`docs/superpowers/plans/2026-05-16-red-team-ts-migration.md`).
**Status:** Frozen for Phase 1+.

The TS lib's `classificationGate()` reads this contract. Operators annotate target docs in YAML frontmatter; the gate refuses dispatch when the doc's declared posture and the model provider don't agree, or when an operator hasn't explicitly acknowledged a restricted-level run.

---

## 1. Frontmatter schema

```yaml
---
classification:
  level: public | internal | confidential | restricted
  dpa_required: true | false                       # default: false
  retention_days: 30                               # int ≥ 0
  provider_allowlist:                              # ordered list of model providers
    - openai-gpt-5.5
    - anthropic-claude-opus-4-7
  notes: free-text rationale                       # optional
---
```

All five fields are optional. Missing fields fall back to the legacy default below.

### Fields

| Field | Semantics |
|---|---|
| `level` | Sensitivity tier. `restricted` requires `--classification-override` to proceed. |
| `dpa_required` | When `true`, the gate refuses unless the configured provider has a DPA on file. Operator supplies the `dpaOnFile` set in code. |
| `retention_days` | Advisory — surfaced in the sidecar and audit row. Future enforcement layer will prune older rows. |
| `provider_allowlist` | When non-empty, the active provider MUST appear in the list. Empty list = no provider restriction (matches "any approved provider"). |
| `notes` | Free-text. Surfaced in the sidecar so reviewers see operator rationale. |

---

## 2. Legacy default (when `classification:` is absent)

```yaml
classification:
  level: internal
  dpa_required: false
  retention_days: 30
  provider_allowlist:
    - openai-gpt-5.5
    - anthropic-claude-opus-4-7
  notes: legacy default — operator did not annotate classification:
```

Documented so existing un-annotated design/plan docs Just Work. The default is logged at INFO so operators can audit when it kicks in.

---

## 3. Override flow

Operators acknowledge a `restricted`-level run via `--classification-override LEVEL` on the dispatcher:

```bash
node --experimental-strip-types tools/red_team_design.ts \
    --design path/to/design.md \
    --classification-override restricted \
    --model gpt-5.5-pro
```

When supplied, the override:

- Bypasses the `level=restricted` refusal.
- Does **not** bypass `dpa_required` or `provider_allowlist` mismatches — those are still hard refusals.
- Is recorded in the audit row's `caller` field (e.g. `stark-red-team-ts:classification_restricted_acknowledged`) so the run is auditable.

---

## 4. Gate refusal codes

| `reason_code` | Trigger | Operator fix |
|---|---|---|
| `classification_restricted_requires_override` | `level: restricted` without `--classification-override` | Pass `--classification-override restricted` (acknowledges sensitivity). |
| `classification_dpa_missing` | `dpa_required: true` and the active provider isn't in `dpaOnFile` | Add the provider to the operator's DPA-on-file set, or switch providers. |
| `classification_provider_not_allowed` | Active provider not in `provider_allowlist` | Add the provider to the doc's allowlist, or switch providers. |

Refusal writes a sanitized `halted` audit row (no captured doc content) and exits non-zero. The structured error envelope on stdout includes `status: "halted"` + `error: "<reason_code>: <reason>"`.

---

## 5. Fixture annotation (test matrix)

The Phase 1b TS test suite (`tools/red_team_lib.test.ts`) covers:

| Fixture | Frontmatter | Expected gate |
|---|---|---|
| _(unannotated)_ | none | `allowed: true` (legacy default) |
| `level: confidential` | full | `allowed: true` |
| `level: restricted`, no override | full | `allowed: false`, `reason_code: classification_restricted_requires_override` |
| `level: restricted`, override=`restricted` | full | `allowed: true` |
| `dpa_required: true`, provider not on DPA list | full | `allowed: false`, `reason_code: classification_dpa_missing` |
| `provider_allowlist` missing the active provider | full | `allowed: false`, `reason_code: classification_provider_not_allowed` |

Phase 2 and Phase 3 smoke fixtures gain explicit `classification:` frontmatter so the gate is exercised end-to-end in real dispatches.

---

## 6. What the contract does NOT cover (deferred)

- **PII redaction enforcement.** The `redact()` sanitizer runs unconditionally; it doesn't gate on classification level.
- **Encryption-at-rest tiering.** SQLite audit rows are stored unencrypted at every level; ops policy determines disk-level encryption.
- **Provider-side retention sync.** `retention_days` is operator-facing only; the gate doesn't currently call provider APIs to set retention.

Those land in a follow-up contract once the Phase 1 dispatcher is in production use.
