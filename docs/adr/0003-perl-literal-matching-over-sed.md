# 0003: Perl literal matching over sed for string replacement

**Date:** 2026-03-20
**Status:** Accepted

## Context

The rename skill needs to perform text replacements across many files, substituting old project names with new ones. The standard Unix tool for this is sed, but sed interprets replacement patterns as regular expressions. A project name containing `.` (e.g., `foo.bar`) would be treated as "foo followed by any character followed by bar", matching unintended strings like `fooXbar`.

## Decision

Use Perl's `\Q..\E` literal quoting for all string replacements instead of sed. `\Q` turns off regex interpretation until `\E`, treating the entire old-name as a literal string regardless of what characters it contains.

## Alternatives Considered

- **sed with escaped patterns** — Requires manually escaping every regex-special character in the project name. Error-prone and fragile.
- **Fixed-string tools (fgrep + awk)** — Would work for detection but awkward for in-place replacement across files.

## Consequences

- **Positive:** Correct replacement regardless of special characters in project names. Single consistent approach for all patterns.
- **Negative:** Requires Perl to be installed (available by default on macOS and most Linux distributions).
