# Security & Error Handling

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Read each changed file in full
3. Check package.json if dependencies changed

> **Scope:** Only report findings specific to security and error handling. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, accessibility, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain. Only flag issues **introduced or materially worsened by this PR**. Pre-existing security patterns that the PR does not change are out of scope, even if insecure.

**API Surface Calibration:** Only flag input validation at **public API boundaries** (HTTP endpoints, gRPC handlers, MCP tools, CLI argument parsers). Internal classes receiving already-validated inputs from internal callers do not need redundant validation.

Then review for security issues:

**XSS & Injection (Frontend)**
- dangerouslySetInnerHTML — sanitized? necessary?
- User-controlled strings rendered as HTML without escaping
- eval(), new Function(), innerHTML with dynamic input
- URL construction from user input (javascript:, data: protocols)

**Input Validation (Frontend)**
- Props with user-controlled values rendered in DOM — constrained?
- string props where union literals would prevent injection
- Event handlers forwarding untrusted events

**Command & Network (Backend)**
- subprocess / create_subprocess_shell with untrusted input — use exec + shlex
- Tokens/secrets embedded in CLI args or URLs (visible in ps / /proc)
- Credentials logged or passed to child processes
- Unvalidated URLs passed to HTTP clients or git clone (SSRF)
- Missing URL scheme allowlist (reject file://, ssh://)
- Vendor webhook payloads: URL fields later fetched by backend workers — enforce HTTPS + vendor host allowlist (SSRF if stored and fetched blindly)
- Overly broad IAM roles (project-level when per-resource suffices)
- Missing audience checks on OIDC/JWT token verification
- Fail-open error handling (auth failures returning empty/success instead of raising)

**Error Handling**
- Missing error boundaries around throwable components
- Unhandled promise rejections
- Error states leaking implementation details
- Graceful degradation on failure

**Dependencies**
- New deps maintained? Known vulnerabilities?
- Post-install scripts in new deps
- Unused deps (unnecessary attack surface)

**Cryptography**
- Weak hash algorithms (MD5, SHA-1) offered alongside or instead of strong ones (SHA-256+)
- Hash algorithm negotiation allowing downgrade to weak option
- Secrets, tokens, or credentials written to plaintext files (JSON, YAML, .env committed to repo)

**Data Safety**
- No secrets, API keys, tokens in code or plaintext config files
- No console.log leaking sensitive data
- No PII in error messages
- Credentials persisted without encryption (plaintext JSON, plaintext DB fields)

**Object Safety**
- Object spread with user-controlled keys
- Dynamic property access obj[userInput]

**Plan/Spec Files:** When reviewing changes to `.md` plan or spec documents containing code blocks, only flag design-level security gaps (e.g., missing auth model). Do not flag implementation details in planned code — those will be caught during actual code review. Do not re-flag items already documented as "Unresolved" or TODO in the plan.

Severities:
- critical: XSS, secrets in code, eval with user input
- high: Missing validation, unsafe innerHTML, vulnerable dep
- medium: Missing error boundary
- low: Defensive hardening

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
