# Skill Help Protocol

Standard `--help` handling every skill honors before doing any work. Skills
point at this doc instead of re-describing the behavior.

## Trigger

Treat the invocation as a help request when the current user request consists
of, or includes as a standalone token, `--help`, `-h`, or `help`
(case-insensitive). Do not depend on a host-side argument placeholder: some
runtimes provide one for commands, while Codex passes the user's request as
ordinary conversation context.

## Behavior

When triggered, **do not** run preflight, provision tokens, touch git/GitHub, or
execute any phase. Instead print a concise help summary and stop:

1. **Name + one-line purpose** — the skill name and the first sentence of its
   frontmatter `description`.
2. **Usage** — the frontmatter `argument-hint`, rendered with the active host's
   explicit skill syntax: `/<skill-name>` on Claude Code or `$<skill-name>` on
   Codex. If the host has no dedicated syntax, show the skill name plus the
   argument hint without inventing one.
3. **Arguments** — the skill's `## Arguments` list verbatim if it has one;
   otherwise a one-line "No arguments." note.
4. **Examples** — 1–2 example invocations when the skill documents them; skip
   otherwise.

Keep it to what the skill's own frontmatter and `## Arguments` already state —
do not invent flags. Then stop; the help request is fully satisfied.

## Notes

- This is the **explicit skill invocation** help surface. Skills that delegate
  to a TS CLI (which has its own `--help`) still print the skill-level summary
  here rather than shelling out — the two are complementary.
- Help output is read-only and side-effect-free: no network, no filesystem
  writes, no subprocess dispatch.
