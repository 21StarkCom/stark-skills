# 0004: Uninstall symlinks before modifying files

**Date:** 2026-03-20
**Status:** Accepted

## Context

The rename skill must both remove old symlinks and update file contents (including install.sh which manages symlinks). The order of these operations matters because install.sh --uninstall uses paths embedded in the script to locate symlinks to remove. If file modifications run first, install.sh would contain updated (new) paths and would look for symlinks at the new location, failing to clean up the stale symlinks at the old location.

## Decision

Run symlink uninstall (Step 4.5) before any file modifications (Step 5). This ensures install.sh --uninstall operates with the original paths and correctly finds and removes all old symlinks. A fallback mechanism using resolved absolute paths handles cases where install.sh doesn't support --uninstall.

## Alternatives Considered

- **Modify files first, then manually clean up symlinks** — Would require independently tracking all symlink locations rather than relying on install.sh's built-in knowledge.
- **Two-pass file modification** — Update everything except install.sh, run uninstall, then update install.sh. More complex ordering for minimal benefit.

## Consequences

- **Positive:** Clean symlink removal using install.sh's own knowledge of symlink locations. Simple, correct ordering.
- **Negative:** Requires careful sequencing documentation to prevent future reordering of steps.
