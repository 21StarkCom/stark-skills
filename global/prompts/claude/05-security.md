# Security & Error Handling

Review the PR diff for security vulnerabilities and error handling gaps.

> **Scope:** Only report findings specific to security and error handling. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, accessibility, correctness, types, or test coverage, skip it — a dedicated reviewer covers that domain.

## API Surface Calibration

Only flag input validation issues at **public API boundaries** (HTTP endpoints, gRPC handlers, MCP tools, CLI argument parsers). Internal classes receiving already-validated inputs from other internal code do not need redundant validation — flag those as noise, not findings.

## Checklist — Frontend

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

**Cryptography**
- Weak hash algorithms (MD5, SHA-1) offered alongside or instead of strong ones (SHA-256+)
- Hash algorithm negotiation allowing downgrade to weak option

**Data Safety**
- No secrets, API keys, tokens in code or plaintext config files
- Credentials persisted without encryption (plaintext JSON, plaintext DB fields)
- No console.log leaking sensitive data
- No PII exposure in error messages

**Object Safety**
- Object spread with user-controlled keys
- Dynamic property access (`obj[userInput]`)

## Checklist — Backend & Server

**Command Injection**
- `subprocess` / `create_subprocess_shell` with untrusted input — use `create_subprocess_exec` + `shlex.split()`
- Template strings interpolating user input into shell commands
- `shlex.quote()` missing on interpolated values

**Credential Exposure**
- Tokens/secrets embedded in CLI args or URLs (visible in `ps` / `/proc`)
- Credentials logged to stdout/stderr
- Secrets in environment variables leaking through child processes

**SSRF & Network**
- Unvalidated URLs passed to HTTP clients or `git clone`
- Missing URL scheme allowlist (reject `file://`, `ssh://`, etc.)
- Internal network access from user-controlled URLs
- **Vendor webhooks:** Fields such as `download_url` or redirect targets inside signed webhook JSON are still **server-fetchable URLs**. If the PR persists them and a worker fetches them later, treat as SSRF unless constrained: require HTTPS, allowlist hosts to expected vendor domains, and reject chains that escape to internal or metadata endpoints.

**IAM & Permissions**
- Overly broad IAM roles (project-level when per-resource suffices)
- Service accounts with more permissions than needed
- Missing audience checks on OIDC/JWT token verification

**ASGI / Framework Integration**
- Do NOT flag: accessing raw ASGI callables (`scope`, `receive`, `send`) or `request._send` when integrating with MCP SDK or similar ASGI frameworks — these are standard integration patterns

## Plan/Spec Files
When reviewing changes to plan or spec documents (`.md` files containing code blocks), distinguish between:
- **Actual source code** being shipped → apply full security scrutiny
- **Planned/proposed code** inside markdown documents → flag only design-level security concerns (e.g., "the planned auth model has a gap"), not implementation details that will be caught during actual code review
- **Known unresolved items** explicitly documented in the plan (e.g., "Unresolved" sections, TODOs) → do NOT re-flag these as new findings; the author is already aware

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
