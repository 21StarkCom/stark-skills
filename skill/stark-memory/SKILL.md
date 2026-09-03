---
name: stark-memory
description: >-
  Audit and tidy Claude Code auto-memory so it stays under the load and recall
  caps. Use for memory tidy, memory audit, MEMORY.md too big, shrink the memory
  index, split over-cap memory files, move cross-repo facts.
argument-hint: "[--project <slug>|--all] [--dry-run] [--apply]"
disable-model-invocation: true
runtimes:
  - claude
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-memory

Keep Claude Code auto-memory readable to future sessions. Claude Code loads a
project's `MEMORY.md` index at session start, but only the **first 200 lines or
25,000 chars** (whichever comes first) — the tail is dropped silently. Each topic
file is shown to recall only its **first 200 lines / 4,096 bytes**. An index that
grows past the cap silently hides its newest entries; a topic file past 4 KB
loses its tail. This skill measures every memory dir against those caps and — on
`--apply` — rewrites to fit: shorter index lines, split over-cap files, and
facts about a *different* fleet repo moved into that repo's own memory dir (the
per-project silo has no cross-repo recall).

The measuring is a read-only tool (`tools/memory_tidy.ts`); the rewriting is
Claude's, gated behind `--apply`.

## Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `--project <slug>` | current + all | One project — an exact dir slug (leading `-`) or a bare repo name (`alfred`). Omit for every project. |
| `--all` | on | Every `~/.claude/projects/<slug>/memory` dir. |
| `--dry-run` | **on** | Measure and present only. This is the default. |
| `--apply` | off | Let Claude rewrite the memory files. **Inverted from every other stark skill** — memory rewrites are the payload, so nothing is written unless you ask. |

**Raw input:** `$ARGUMENTS`

Parse `$ARGUMENTS`: `--apply` turns on the write phase (Phase 3); otherwise this
is a dry run and you stop after Phase 2. Pass `--project`/`--all` straight
through to the tool.

## Constants

`macOS has no timeout(1)` — never wrap the tool in `timeout`. Shell state does
not persist between blocks, so define `TOOLS` and the `tidy` helper in every
fenced block that uses them.

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
# tools/memory_tidy.ts — read-only measurer; one JSON report on stdout.
tidy() { node --no-warnings "$TOOLS/memory_tidy.ts" "$@"; }
```

---

## Phase 1: Measure

Run the read-only measurer over the requested scope and capture the JSON.

```bash
TOOLS="${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools"
tidy() { node --no-warnings "$TOOLS/memory_tidy.ts" "$@"; }
tidy $ARGUMENTS   # --project/--all pass through; --dry-run/--apply are no-ops to the tool
```

The report shape:

```
{ generatedFor, projectsDir, capSourceVersion, corpusPresent, fleetSlugCount,
  projects: [ { slug, memoryDir, ownSlug, empty, hasIndex,
    index: { lines, chars, overLineCap, overCharCap, firstDroppedLine, entries,
             longLines:[{line,chars,text}], strayLines, hasFrontmatter,
             orphans, dangling },
    files: [{ name, bytes, lines, overByteCap, overLineCap, recallTruncated }],
    overCapFiles: [ ... ],
    crossRepo: [{ file, name, foreignSlugs, strength }] } ],
  summary: { projectsScanned, projectsEmpty, indexesOverCap, filesOverCap,
             crossRepoStrong, crossRepoWeak } }
```

If `corpusPresent` is false the fleet-slug list is the built-in fallback — say so,
since a niche repo slug may be missed.

## Phase 2: Present

Rank projects by how close their index is to the 25,000-char cap (then by
`filesOverCap`). For each project that needs work, show:

- **Index:** `chars / 25000` and `lines / 200`; if `firstDroppedLine` is not null,
  name it — every entry from that line down is invisible at session start.
- **Long index lines:** count over 150 chars, with the worst line numbers.
- **Over-cap files:** name + bytes for each (> 4,096 B or > 200 lines) — their
  tails are invisible to recall.
- **Cross-repo facts:** `strong` (foreign slug in the filename or description) and
  `weak` (body only), each with its foreign slugs. Strong are move candidates;
  weak are for your judgment.
- **Orphans / dangling / stray:** topic files with no index line, index lines with
  no file, non-entry prose in the index.

**If this is a dry run (no `--apply`): stop here.** Present the plan you *would*
apply and end.

## Phase 3: Apply (only with `--apply`)

Rewrite to fit the caps. Every write goes through the **Write/Edit tools, never a
Bash `mv`** — the fact-routing PostToolUse hook watches those paths and must fire.
Work one project at a time; on `--all`, say so and proceed project by project.

1. **Shorten index lines** over 150 chars to `- [Title](file.md) — one hook`
   (a title and a single-clause hook, ~150 chars max). The detail already lives in
   the topic file — the index is a pointer, not a summary. Preserve each line's
   link target; never drop an entry.
2. **Over-cap files — verify or flag, never blind-tighten.** A file over 4 KB has
   an invisible tail. You MAY tighten its prose to fit **only if** you can drop
   nothing load-bearing (every id, path, Mímir reference, STARK number, decision)
   **and** land under 4,096 bytes — check the rewrite against the original before
   writing it. If the note is too fact-dense to tighten losslessly (measured: dense
   recipe / credential notes usually are), do **not** rewrite it: either split it
   into separate one-fact files (new file via Write, new index line, retire the old
   line), or leave the original and flag it for a manual split. A lossy auto-rewrite
   over a real note is the failure mode here — keeping the over-cap original beats
   silently dropping a fact.
3. **Move a strong cross-repo fact** into the target repo's memory dir:
   `~/.claude/projects/<target-slug>/memory/`. Resolve `<target-slug>` by listing
   `~/.claude/projects` and matching the foreign slug (create `MEMORY.md` there if
   absent — no frontmatter, just `- [Title](file.md) — hook` lines). Write the
   file in the target, add its index line there, then remove the source file and
   its index line here. Confirm the target with the operator before moving.
4. **Retire stale entries** — a memory superseded by a newer one, or a done-and-
   merged ticket note with no lasting lesson. Present each before removing; when in
   doubt, keep it.

Re-run Phase 1 after applying and confirm the index is back under cap.

## Phase 4: Report

```
/stark-memory — {scope}  {'DRY RUN — nothing written' if no --apply}

Projects scanned: {N}   over-cap indexes: {n}   over-cap files: {n}
Cross-repo facts: {strong} strong, {weak} weak

Per project (worst first):
  {slug}: index {chars}/25000 ({'DROPS at line '+firstDropped if any}); files over 4KB: {n}; cross-repo: {n}
  {applied: index lines shortened {n}, files split {n}, facts moved {n} → {targets}, retired {n}}
```

## Failure Modes

| Failure | Recovery |
|---------|----------|
| `tidy` prints nothing / errors | The tool is read-only and never wraps in `timeout`; run `node "$TOOLS/memory_tidy.ts" --help` to confirm it resolves through `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}`. |
| `ambiguous project "<name>"` (exit 2) | Two dirs resolve to that repo. Re-run with the exact leading-dash slug the error listed. |
| `no project ... resolves to "<name>"` | That repo has no memory dir yet, or the slug is niche and the corpus is absent — pass the exact dir slug instead. |
| A move would overwrite a file in the target dir | Stop and ask the operator; never clobber an existing memory file. |
