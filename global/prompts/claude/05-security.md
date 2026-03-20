# Security & Error Handling

Review the PR diff for security vulnerabilities and error handling gaps.

> **Scope:** Only report findings specific to security and error handling. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, accessibility, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain.

## Checklist

**XSS & Injection**
- `dangerouslySetInnerHTML` — is input sanitized? Is it necessary?
- User-controlled strings rendered as HTML without escaping
- `eval()`, `new Function()`, `innerHTML` with dynamic input
- URL construction from user input (javascript: protocol, data: URIs)

**Input Validation**
- Props accepting user-controlled values rendered in DOM — constrained?
- `string` props where union literals would prevent injection
- Event handlers forwarding untrusted events

**Error Handling**
- Missing error boundaries around throwable components
- Unhandled promise rejections
- Error states leaking implementation details
- Graceful degradation on failure

**Dependencies**
- New deps actively maintained? Known vulnerabilities?
- Post-install scripts in new deps
- Unused dependencies (unnecessary attack surface)

**Data Safety**
- No secrets, API keys, tokens in code
- No console.log leaking sensitive data
- No PII exposure in error messages

**Object Safety**
- Object spread with user-controlled keys
- Dynamic property access (`obj[userInput]`)

## Severity Guide
- **critical**: XSS vulnerability, secrets in code, eval with user input
- **high**: Missing input validation at boundary, unsafe innerHTML, vulnerable dependency
- **medium**: Missing error boundary, minor validation gap
- **low**: Defensive hardening

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
