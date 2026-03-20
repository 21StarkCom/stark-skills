# Constraints

Boundary conditions and non-negotiable limitations.

- **CI/CD workflows scanned but never auto-modified** — .github/workflows/ files are excluded from automatic replacement during renames. They are scanned for old-name references and reported in the summary as needing manual update, because CI/CD pipelines have complex interdependencies that auto-modification could break.
- **External integrations are out of scope for rename** — Webhooks, Slack integrations, Jira links, and other external service configurations are not updated by the rename skill. They are reported as known integration points in the summary but require manual update.
- **Cross-repo updates limited to same-org sibling directories** — Only repositories under the same parent directory whose origin remote points to the same host and org are updated during renames. Repos belonging to other orgs, other hosts, or outside the parent directory are never touched.
