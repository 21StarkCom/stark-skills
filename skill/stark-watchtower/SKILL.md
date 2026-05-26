---
name: stark-watchtower
description: >-
  Open the stark-observability dashboard. Bootstraps auth (Keychain + one-time
  fragment code) and opens http://127.0.0.1:7700 in the default browser.
  Use --no-browser to write a curl-ready session cookie instead.
argument-hint: "[--no-browser] [--api-base URL] [--container NAME] [--cookie-out PATH]"
disable-model-invocation: true
model: haiku
---

# /stark-watchtower

Thin wrapper over `tools/observability_open.ts`. The helper reads the
container's bootstrap + prune tokens via `docker exec`, stashes them in the
macOS Keychain under scoped service names, mints a one-time code through
`POST /api/auth/bootstrap`, and opens the dashboard with the code in the URL
fragment (never the query string, never the access log).

YOU MUST NOT splice user input into shell commands. Forward `$ARGUMENTS`
verbatim to the helper.

```bash
node --experimental-strip-types \
  /Users/aryeh/Code/Playground/stark-skills/tools/observability_open.ts \
  $ARGUMENTS
```

Surface the helper's stdout/stderr as-is. Non-zero exit → stop, show stderr.
