# AGENTS.md Migration Recipes

Concrete shell sequences for Phase 0b of `stark-agents-md`. Read this only when actually executing a migration; the parent `SKILL.md` references it from Phase 0b.

Every recipe is **fail-closed**: on any sub-step failure (or `INT`), the trap restores the pre-migration state of both files. Recipes refuse to start if any reserved temp/backup path (`AGENTS.md.tmp`, `CLAUDE.md.tmp`, `CLAUDE.md.bak`) is already taken so a stray file in the repo root can't be clobbered.

## State (A): Neither file exists

Offer to create `AGENTS.md` from the user's answers in Phase 1, then symlink:

```bash
ln -s AGENTS.md CLAUDE.md
```

## State (B): Only `AGENTS.md` exists

Single symlink, no rollback needed:

```bash
ln -s AGENTS.md CLAUDE.md
```

## State (C): Only `CLAUDE.md` exists

Phase 0 already established that `AGENTS.md` does not exist in this state, so any `AGENTS.md` present at trap time was created by this run and is safe to delete:

```bash
set -e
for f in AGENTS.md AGENTS.md.tmp CLAUDE.md.tmp CLAUDE.md.bak; do
  if [ -e "$f" ] || [ -L "$f" ]; then
    echo "Refusing to migrate: $f already exists" >&2
    exit 1
  fi
done
cp -p CLAUDE.md CLAUDE.md.bak
trap '
  rm -f AGENTS.md.tmp CLAUDE.md.tmp
  [ -e AGENTS.md ] && rm -f AGENTS.md
  [ -e CLAUDE.md.bak ] && mv -f CLAUDE.md.bak CLAUDE.md
  exit 1
' ERR INT
cp CLAUDE.md AGENTS.md.tmp
ln -s AGENTS.md CLAUDE.md.tmp
mv AGENTS.md.tmp AGENTS.md
mv -f CLAUDE.md.tmp CLAUDE.md      # overwrites the regular file with the symlink
trap - ERR INT
rm -f CLAUDE.md.bak
```

## State (E) equivalent: both exist, `CLAUDE.md` is a regular file with the same content

Backup-and-restore swap. `mv -f` atomically replaces `CLAUDE.md`; the backup is the rollback path:

```bash
set -e
for f in CLAUDE.md.tmp CLAUDE.md.bak; do
  if [ -e "$f" ] || [ -L "$f" ]; then
    echo "Refusing to migrate: $f already exists" >&2
    exit 1
  fi
done
cp -p CLAUDE.md CLAUDE.md.bak
trap 'rm -f CLAUDE.md.tmp; [ -e CLAUDE.md.bak ] && mv -f CLAUDE.md.bak CLAUDE.md; exit 1' ERR INT
ln -s AGENTS.md CLAUDE.md.tmp
mv -f CLAUDE.md.tmp CLAUDE.md      # atomic replace; original still in CLAUDE.md.bak
trap - ERR INT
rm -f CLAUDE.md.bak
```

## State (E) divergent: both exist, content meaningfully differs

**Do not migrate.** Surface the diff and stop. Divergence is intentional in some repos (Claude-specific tooling reads `CLAUDE.md` directly, host-specific install paths, audience-specific framing). Merging would collapse working host-specific content. See `SKILL.md` → Cross-Tool Compatibility for when divergent mode is the right call.
