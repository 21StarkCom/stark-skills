---
name: stark-bury
# Claude-only: burials are deliberate operator ceremonies run in Claude Code;
# no Codex runtime override is authored (exempts the bifrost codex overlay gate).
runtimes:
  - claude
description: >-
  Use when retiring 21Stark code into the Náströnd graveyard — burying a
  subsystem of a living repo (partial burial) or putting down a whole repo
  (full retirement). Symptoms: "bury X", "retire the <feature>", "kill this
  service and keep the memory", "new corpse for nastrond", "dig a grave",
  "tombstone", "exhume". Runs the full ritual: footprint verification,
  interment PR, deletion PR, optional sealed data dump and table drop.
argument-hint: "[corpse — the subsystem or repo to bury]"
disable-model-invocation: true
model: opus[1m]
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-bury — the Náströnd burial ritual

The graveyard is **`21StarkCom/nastrond`**, local at `~/Code/21Stark/nastrond/`.
Its README is the constitution; `TOMBSTONE.template.md` is the death
certificate; `INDEX.md` is the registry of the dead. Read all three before the
first shovel of dirt.

**The laws (non-negotiable):**

1. **Bury before delete.** The nastrond interment PR merges BEFORE any code is
   deleted from the living repo. Nothing dies before it is safely in the ground.
2. **The dead stay dead.** Never import from nastrond. Exhumation is a
   deliberate copy back into a living repo.
3. **The living repo stays green.** The deletion PR passes build + vet + lint +
   tests before merge.
4. **Destructive steps are gated.** Dropping live tables, deleting live
   secrets, or any prod mutation needs the operator's explicit go — and a
   sealed dump must exist BEFORE a drop.
5. **Never commit** a raw `.bundle`, an unencrypted sensitive dump, or an age
   private identity. The private identity lives only in the Mímir vault.

## Phase 0 — preflight

- If the corpse is still running live (cron enabled, tokens active), **turn it
  off first** and park credentials; disabling is not burying, but nothing gets
  buried while it is still breathing.
- One alfred ticket per phase, in the repo that phase's PR lands in
  (`alfred task new …`); every PR title is `type(STARK-<n>): subject`.

## Phase 1 — verify the footprint (the step that has bitten before)

Never trust a name-based file list — not the operator's, not a brief's, not
grep's. A file called `*_nudge*` belonged to a DIFFERENT living subsystem the
one time this ritual ran unverified.

For every candidate file:

- **Classify by imports and symbols, not filenames.** What does it import?
  Who imports IT? A candidate that living code imports is NOT part of the
  corpse — leave it alive and say so in the tombstone.
- Sweep for the corpse's hidden limbs in shared files: the binary's `main.go`
  wiring, config structs + env loads, job/rule registries, **metrics
  registrations** (the classic miss), alert rules (all copies), deploy/startup
  env, provisioning scripts, docs, per-package CLAUDE.md files, CHANGELOG.
- Dispatch a read-only subagent for the import/entanglement map when the
  corpse is more than a few files; verify its claims against the code.

## Phase 2 — interment (nastrond PR #1)

1. Dig `graves/<repo>/{code,data,backups}/` if absent — lazily, first corpse
   only.
2. Copy the dedicated source **verbatim** into `code/`, preserving original
   paths so the snapshot reads coherently. Include tests, the feature's own
   docs (runbooks/specs/plans), and the schema DDL that defined its tables —
   carved into a self-contained `.sql` when the source migration is a shared
   baseline that must not be edited.
3. Write `TOMBSTONE.md` from the template. `cause_of_death` = why it was
   KILLED; "What it was" = why it EXISTED. Record footprint corrections.
4. Append one row to `INDEX.md`.
5. PR via `stark-gh:pr-open` → merge. The grave is filled.

## Phase 3 — deletion (living-repo PR #2)

1. `git rm` the verified dedicated files (code + tests + feature docs).
2. Unwire the shared files found in Phase 1. Remove the corpse's metrics,
   alerts, env defaults, config fields, registry entries, CLAUDE.md sections.
3. **Split by what each artifact follows:** code-docs follow the CODE (delete
   here); schema-docs, `layers.yml` entries, and migration history follow the
   SCHEMA (they leave only WITH a drop migration, never before).
4. Green gate: build + vet + lint + affected tests, then PR → merge. Add a
   CHANGELOG bullet when the repo keeps one.

## Phase 4 — the data (optional, gated)

- Rows worth remembering: `pg_dump` the corpse's tables, **age-seal** anything
  sensitive (`age -R ~/Code/21Stark/nastrond/.age-recipients -o
  graves/<repo>/data/<name>-YYYY-MM-DD.sql.age <dump>.sql`), commit only the
  `.age` file, shred the plaintext. Conversation transcripts and personal data
  are ALWAYS sensitive.
- Dropping the live tables is a separate, operator-gated decision: sealed dump
  first, then a forward DROP migration in the living repo (FK dependency
  order), taking the schema-docs + `layers.yml` entries with it.
- Before relying on the seal, verify the grave is openable: the private
  identity must be in Mímir and must decrypt the sealed artifact.

## Full retirement (whole repo dies)

`git bundle create /tmp/<repo>.bundle --all` in the dead repo → age-seal it to
`graves/<repo>/backups/<repo>.bundle.age` → delete the plaintext bundle →
tombstone + INDEX row → archive the GitHub repo. A full history resurrects
every secret ever committed — the bundle is NEVER committed raw.

## Exhume

Reverse deliberately: copy `code/` back, re-wire using the deletion PR's diff
as the map, replay the interred DDL or decrypt the sealed dump
(`age -d -i <mimir-identity> …sql.age | psql`), un-park credentials, re-enable.
