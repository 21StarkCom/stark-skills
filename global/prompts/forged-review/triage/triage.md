# Forged-Review Triage

Classify which review domains the provided PR needs.

You are shown a unified diff, a list of changed files, and the PR description.
Decide which of the 9 review domains are worth running. Be strict — unused domains
cost money and noise. Always-on domains (`correctness`, `regression-prevention`)
will be added by the orchestrator regardless of your output.

## Domains

| Slug | Run when |
|------|----------|
| `architecture` | New modules, new files, significant cross-cutting changes, refactors |
| `accessibility` | UI files (jsx/tsx/html/css/svelte/vue), ARIA-related code |
| `correctness` | *always-on* |
| `type-safety` | Typed files touched (.ts/.tsx/.py with annotations/.go/.rs/.kt) |
| `security` | Auth, crypto, input handling, SQL, network, subprocess, secrets, redirects |
| `test-coverage` | Any non-test change (skip for test-only or docs-only PRs) |
| `spec-conformance` | PR description references a spec/ADR or the diff modifies a spec file |
| `ui-design-conformance` | UI files + design tokens/components/style rules |
| `regression-prevention` | *always-on* |

## Rules

1. Err on the side of exclusion when signals are weak — the orchestrator will add back `correctness` and `regression-prevention` automatically.
2. For test-only PRs, drop `test-coverage`.
3. For docs-only PRs, drop everything except `correctness` (the orchestrator will still add `regression-prevention`).
4. Provide a short rationale per domain you select (one line, under 15 words).

## Output

JSON object only. No other text.

```json
{
  "selected_domains": ["correctness", "security", "regression-prevention"],
  "rationale": {
    "correctness": "always-on",
    "security": "modifies auth middleware",
    "regression-prevention": "always-on"
  }
}
```
