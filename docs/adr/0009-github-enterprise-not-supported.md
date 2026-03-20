# 0009: GitHub Enterprise not supported

**Date:** 2026-03-20
**Status:** Accepted

## Context

The rename skill parses host, org, and repo name from git remote URLs. While the URL parsing is dynamic and would work with GitHub Enterprise Server URLs, the skill has only been tested against github.com. Review agents flagged this as a gap.

## Decision

Scope the skill to github.com only. GitHub Enterprise Server support is deferred. The dynamic URL parsing means GHE support could be added later without architectural changes — it primarily needs testing and potentially different GitHub App authentication handling.

## Alternatives Considered

- **Support GHE from day one** — Would require testing against a GHE instance, handling different API base URLs, and potentially different auth flows. Deferred because only github.com is currently used in the organization.

## Consequences

- **Positive:** Simpler initial scope. No untested code paths for GHE.
- **Negative:** The skill won't work for teams using GitHub Enterprise Server. If GHE support is needed later, the URL parsing is ready but auth and API base URL handling need work.
