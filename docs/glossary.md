# Glossary

**Sibling repos** — Directories under the same parent directory as the target project that contain a `.git/` subdirectory and whose origin remote points to the same host and organization. Used in cross-repo update operations to scope which repositories receive propagated changes.

<!-- needs review -->
**Custom lookarounds** — The regex pattern `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` used instead of `\b` word boundaries to correctly match project names containing hyphens and dots without false-matching inside longer identifiers.
