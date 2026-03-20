# 0002: Custom regex lookarounds for hyphenated project names

**Date:** 2026-03-20
**Status:** Accepted

## Context

When replacing bare project names in text files, standard `\b` word boundaries treat hyphens and dots as word boundary characters. This means searching for `stark-review` with `\b` boundaries would also match inside `stark-review-improvement`, causing incorrect replacements that break longer identifiers.

## Decision

Use custom lookarounds `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` instead of `\b` word boundaries. The character class covers the full set of valid GitHub repository name characters (alphanumerics, dots, underscores, hyphens), ensuring that a match only occurs when the project name appears as a standalone identifier, not as a prefix or substring of a longer name.

## Alternatives Considered

- **Standard `\b` word boundaries** — Simpler regex but incorrect for names containing hyphens or dots, which are common in project naming conventions.
- **Exact file-by-file manual replacement** — Correct but prohibitively slow for cross-repo operations.

## Consequences

- **Positive:** Correctly handles hyphenated and dotted project names without false matches inside longer identifiers.
- **Negative:** More complex regex that may be less immediately readable. Requires understanding of lookaround syntax.
