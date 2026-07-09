# Skill Help Protocol

Standard `--help` handling every skill honors before doing any work. Skills
point at this doc instead of re-describing the behavior.

## Trigger

The skill was invoked for help when `$ARGUMENTS`, after trimming, is exactly one
of: `--help`, `-h`, or `help` (case-insensitive). A help token mixed with real
arguments (e.g. `foo.md --help`) also counts — treat the presence of a
standalone `--help`/`-h`/`help` token anywhere in `$ARGUMENTS` as a help request.

## Behavior

When triggered, **do not** run preflight, provision tokens, touch git/GitHub, or
execute any phase. Instead print a concise help summary and stop:

1. **Name + one-line purpose** — the skill name and the first sentence of its
   frontmatter `description`.
2. **Usage** — the frontmatter `argument-hint` (rendered as
   `/<skill-name> <argument-hint>`).
3. **Arguments** — the skill's `## Arguments` list verbatim if it has one;
   otherwise a one-line "No arguments." note.
4. **Examples** — 1–2 example invocations when the skill documents them; skip
   otherwise.

Keep it to what the skill's own frontmatter and `## Arguments` already state —
do not invent flags. Then stop; the help request is fully satisfied.

## Notes

- This is the **slash-command** help surface. Skills that delegate to a TS CLI
  (which has its own `--help`) still print the skill-level summary here rather
  than shelling out — the two are complementary.
- Help output is read-only and side-effect-free: no network, no filesystem
  writes, no subprocess dispatch.
