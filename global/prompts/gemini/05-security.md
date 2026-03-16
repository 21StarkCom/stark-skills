# Security & Error Handling

First, run these commands:
1. Run `git diff main...HEAD` to see what changed
2. Read each changed file in full
3. Check package.json if dependencies changed

Then review for security issues:

**XSS & Injection**
- dangerouslySetInnerHTML — sanitized? necessary?
- User-controlled strings rendered as HTML without escaping
- eval(), new Function(), innerHTML with dynamic input
- URL construction from user input (javascript:, data: protocols)

**Input Validation**
- Props with user-controlled values rendered in DOM — constrained?
- string props where union literals would prevent injection
- Event handlers forwarding untrusted events

**Error Handling**
- Missing error boundaries around throwable components
- Unhandled promise rejections
- Error states leaking implementation details
- Graceful degradation on failure

**Dependencies**
- New deps maintained? Known vulnerabilities?
- Post-install scripts in new deps
- Unused deps (unnecessary attack surface)

**Data Safety**
- No secrets, API keys, tokens in code
- No console.log leaking sensitive data
- No PII in error messages

**Object Safety**
- Object spread with user-controlled keys
- Dynamic property access obj[userInput]

Severities:
- critical: XSS, secrets in code, eval with user input
- high: Missing validation, unsafe innerHTML, vulnerable dep
- medium: Missing error boundary
- low: Defensive hardening

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
