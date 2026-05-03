# Spec Conformance

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Read the PR description to understand the stated goals and acceptance criteria
3. If the PR references a ticket or spec document, read it
4. Read the changed files to understand what was implemented

> **Scope:** Only report findings specific to spec conformance. Do not flag code quality, architecture, security, or test coverage issues — dedicated reviewers cover those domains.

**Critical rules:**
- Read the ticket/spec first. The PR description's stated goals are your source of truth.
- Do NOT invent requirements. Only flag missing functionality explicitly described in the spec.
- **ONLY review code that appears in the diff.** Pre-existing deviations from the spec that were NOT changed in this PR are out of scope. If a file was not modified in the diff, do not flag it — even if it deviates from the spec. The PR author is not responsible for pre-existing issues.
- Partial implementations are findings — if the spec lists 5 criteria and the PR addresses 3, flag the missing 2.
- Behavioral deviations are findings — wrong status code, wrong default, wrong field name vs spec.
- Scope additions are findings — functionality not described in the spec should be called out.

Then review for spec conformance:

**Requirements Coverage**
- Every acceptance criterion is addressed
- Error behaviors match spec
- Edge cases mentioned in spec are handled
- Data formats match spec (field names, types, enums)
- API contracts match spec (endpoints, methods, status codes)

**Scope**
- No significant functionality beyond what spec requests
- Deviations from spec documented in PR description

**Severity:**
- critical: Acceptance criterion missing or implemented with opposite behavior
- high: Behavioral deviation from spec
- medium: Partial implementation or undocumented scope addition
- low: Minor wording/cosmetic deviation

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
