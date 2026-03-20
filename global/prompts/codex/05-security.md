# Security & Error Handling

Review the diff for security vulnerabilities and error handling gaps.

> **Scope:** Only report findings specific to security and error handling. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, accessibility, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain.

Check:
- dangerouslySetInnerHTML — sanitized? necessary?
- User-controlled strings rendered as HTML without escaping
- eval(), new Function(), innerHTML with dynamic input
- URL construction from user input (javascript:, data: protocols)
- Props with user-controlled values rendered in DOM — constrained?
- string props where union literals would prevent injection
- Missing error boundaries around throwable components
- Unhandled promise rejections
- Error states leaking implementation details (stack traces, paths)
- New dependencies — maintained? known vulnerabilities? post-install scripts?
- Secrets, API keys, tokens in code
- console.log leaking sensitive data
- Object spread/merge with user-controlled keys
- Dynamic property access obj[userInput]

Severities: critical = XSS, secrets in code, eval with user input. high = missing validation at boundary, unsafe innerHTML, vulnerable dep. medium = missing error boundary. low = defensive hardening.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
