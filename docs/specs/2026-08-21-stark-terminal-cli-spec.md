---
title: stark terminal CLI — standalone, Homebrew-installable binary
ticket: STARK-1042
date: 2026-08-21
status: proposed
accepted-base: <pinned at human gate — commit hash of the accepted spec>
---

# stark terminal CLI — Stage-1 spec

## Intent

Ship a **second distribution channel** for the stark tooling: a single standalone
binary named `stark`, run by a human from a terminal **outside Claude Code**, that
exposes three existing tool surfaces as subcommands. Installable via Homebrew, no
runtime dependency on the user's machine.

This **coexists** with the marketplace (Bifrost plugin) channel — it does not
replace it. The marketplace path stays exactly as-is; this adds a parallel way to
run a bounded subset of the tooling without Claude Code in the loop.

v1 wraps exactly three commands, chosen because their backing tools are already
self-contained and useful standalone:

| Subcommand         | Backing tool                              | Existing skill surface |
|--------------------|-------------------------------------------|------------------------|
| `stark cc-user`    | `tools/cc_account.ts`                     | `/stark-cc-user`       |
| `stark cleanup`    | `plugins/stark-gh/tools/gh_cleanup.ts`    | `/stark-gh:cleanup`    |
| `stark housekeeping`| `tools/housekeeping_infra.ts`            | `/stark-housekeeping`  |

## IN / OUT boundary

### IN scope
- A single umbrella dispatcher binary `stark` with subcommands (**not** many
  separate binaries).
- Routing `stark <cmd> <args…>` to each backing tool's existing `main()`, with
  each command's own argv slice, output, and **exit code** propagated unchanged.
- A non-interactive `stark --list` that enumerates the subcommand registry (one id
  per line) — the deterministic source the launcher menu is built from.
- **Minimal seam refactors** to the two backing tools that today neither export
  `main()` nor accept an argv parameter (`gh_cleanup.ts`, `housekeeping_infra.ts`),
  so the dispatcher can invoke them. This is wiring, not behavior change — see the
  OUT line below.
- A **zero-dependency** TUI: a launcher menu listing the three commands (select →
  run → render output) **and** a per-command rich TUI for each:
  - `cc-user`: account list + per-seat headroom + switch.
  - `cleanup`: preview what will be swept + confirm.
  - `housekeeping`: preview + confirm.
- A `bun build --compile` configuration producing an executable `dist/stark`.
- A GitHub Release workflow that, on a tag, bun-compiles per target (darwin-arm64
  at minimum) and attaches the binary as a Release asset. **STOP-LIST.**
- A Homebrew tap repo + formula pointing at that Release asset. **STOP-LIST.**
- Docs: a terminal-usage section in `README.md` (incl. `brew install`), and a
  `CLAUDE.md` update naming the new channel.
- `.gitignore` entry for the build output so the binary is never committed and the
  `cleanup` clean-tree preflight passes during verification.

### OUT of scope (anti-goals)
- **Any fourth subcommand.** v1 is exactly three, no more, no fewer.
- **Changing any backing command's flags, output text, or exit codes.** The seam
  refactor makes `main()` callable; it must not alter observable behavior.
- Wrapping any interactive skill (persona, author, build, fresh-eyes, session,
  handover, handoff, review, copilot, …) — none of these become subcommands.
- **Any new external dependency**, including a TUI/readline/coloring library. The
  TUI is hand-rolled ANSI + `node:` builtins only. A library is a STOP-LIST item,
  not a default — if the implementer believes one is unavoidable, that is an
  operator escalation.
- Any change to marketplace / Bifrost packaging, or the Codex plugin surface.
- Production ceremony: code signing, notarization, auto-update, telemetry,
  crash reporting, retry/HA, multi-arch bottles beyond the pinned darwin-arm64
  minimum (the workflow may add more targets trivially; none are required for v1).
- Publishing an actual Release or creating the tap repo as part of *authoring* or
  *building* — those are the two STOP-LIST live effects, gated on operator go.

## Non-derivable repo context

Facts an implementer cannot infer from a first read, verified against the repo on
2026-08-21:

1. **Runtime.** bun 1.4.0 is installed; the TS tools run under it; `node:sqlite`
   works; the `node:test` suite passes via `bun test`. The tools are ESM, use
   explicit `.ts`-extension imports, and have **zero external runtime deps** (only
   `node:` builtins).

2. **No root manifest.** There is no root `package.json`, `tsconfig.json`, or
   `bunfig.toml`. The only manifest is `tools/package.json` (`name:
   stark-skills-tools`, `type: module`, `engines.node >=24`, `test =
   ./check-rest-only.sh && node --test *.test.ts`; devDeps `@types/node`,
   `typescript`; **no `dependencies` block**). No build tooling exists yet.

3. **The three entrypoints have INCONSISTENT invocation seams — this is the core
   thing Task A reconciles:**
   - `tools/cc_account.ts` — `export function main(argv = process.argv.slice(2))`.
     **Exported and argv-parameterized.** Guard: `isMainModule(import.meta.url)`
     (`lib/main_module.ts`). Bare invocation prints USAGE to stderr and
     `process.exit(1)`. Subcommands: `show list add use remove prune reset limits
     next order refresh --help`.
   - `plugins/stark-gh/tools/gh_cleanup.ts` — `function main(): void`, **not
     exported**; reads `process.argv` directly (via `--raw-args <str>` or
     `argv.slice(2).join(" ")`). Exits via `process.exit(CleanupExit.*)`.
     Preflight **requires a clean working tree** (`die(DIRTY_WORKTREE)` otherwise).
     Flags: `--dry-run --json --pr N …`.
   - `tools/housekeeping_infra.ts` — `function main(): void`, **not exported**;
     reads `process.argv.slice(2)`. Deliberately sets `process.exitCode` and
     RETURNS — never `process.exit()` — to avoid truncating buffered stdout on a
     pipe. Flags: `--dry-run --json`.

   Implication: the umbrella cannot uniformly `import { main }` and pass argv — two
   of three neither export `main` nor take an argv param, and one calls
   `process.exit()` (which, called in-process, terminates the whole binary). The
   dispatcher must (a) feed each command its own argv slice, and (b) propagate each
   command's exit code. The reconciliation approach (export + argv-param the two,
   vs. an argv shim / re-exec) is the implementer's call.

4. **Entrypoint guards are argv-sensitive.** `isMainModule` / `isInvokedAsScript`
   compare `import.meta.url` to `argv[1]`. Under `bun build --compile` those may
   not self-fire the way a directly-invoked `.ts` does, so the dispatcher must
   route **explicitly** and must not depend on a backing module's guard triggering
   inside the compiled bundle. Confirm the guards' behavior in the compiled binary
   as a build-time check.

5. **The two source trees are self-contained.** `plugins/stark-gh/tools/` imports
   nothing from root `tools/` (grep-verified). Both bundle into one binary with no
   cross-coupling; the umbrella dispatcher is the **only** file importing from both
   trees.

6. **Asset resolution.** Tools resolve immutable assets via `CLAUDE_PLUGIN_ROOT`
   else `~/.claude/code-review` (`asset_root_lib`); mutable state always under
   `$HOME`. Run standalone (outside Claude Code), `CLAUDE_PLUGIN_ROOT` is unset, so
   the `~/.claude/code-review` fallback applies. **None of the three v1 commands
   needs plugin-vendored assets to function** — cc-user → Keychain + `~/.claude`;
   cleanup → the cwd git repo; housekeeping → `~/.claude`. housekeeping's
   asset-symlink self-heal may no-op when the canonical stark-skills clone is
   absent; that is documented existing behavior and acceptable standalone.

7. **The TUIs add no business logic** — they are interactive shells over existing
   library surfaces: cc-user has ranked-account data (`cc_account_lib.ts`
   `rankProfiles` + per-seat usage snapshots); cleanup has `buildPlan*` /
   `renderPlan` (preview) + `executePlan` (mutate); housekeeping has
   `cleanInfra({dryRun})` (preview) + live run.

8. **Ticket gate.** `.stark-gh.json` sets `requireTicketScope: true, ticketKey:
   STARK`, so PR titles for this repo must carry a `type(STARK-<n>):` scope.

9. **Docs conventions.** Specs live at `docs/specs/YYYY-MM-DD-<slug>-spec.md`. This
   repo currently carries no `docs/` tree; this spec creates `docs/specs/`.
   `CLAUDE.md` presently states distribution is **marketplace-only** — Task E
   updates that framing to name the standalone binary channel.

## Acceptance criteria (EARS)

**Dispatcher & routing**
1. The `stark` binary shall expose exactly the three subcommands `cc-user`,
   `cleanup`, and `housekeeping`.
2. When the user runs `stark <cmd> <args…>`, the binary shall route `<args…>` to
   `<cmd>`'s backing tool and produce output identical to invoking that tool
   directly with the same args.
3. When a subcommand exits with code N, the binary shall exit with the same
   code N.
4. When the user runs `stark --list`, the binary shall print the three subcommand
   ids, one per line, and exit 0.
5. If the user gives an unknown subcommand, then the binary shall exit non-zero
   and print the valid subcommand list to stderr.

**TUI**
6. While no subcommand is given and stdout is a TTY, the binary shall launch the
   interactive launcher menu listing all three commands, run the selected one, and
   render its output.
7. When the user selects a command in the launcher, the binary shall route to that
   command's per-command TUI.
8. While in the `cleanup` or `housekeeping` TUI, the binary shall perform no
   destructive action until the user gives an explicit confirmation input; a
   decline/abort input shall exit without mutating anything.
9. While in the `cc-user` TUI, the binary shall render the ranked account list with
   per-seat headroom and offer a switch action.
10. The binary shall depend on no external runtime package — the TUI shall use
    `node:` builtins and hand-rolled ANSI only.

**Build & distribution**
11. When `bun build --compile` is run against the dispatcher entry, it shall
    produce a single executable `dist/stark` requiring no runtime install on the
    target machine.
12. When a version tag is pushed, the Release workflow shall bun-compile the binary
    for darwin-arm64 (at minimum) and attach it as a GitHub Release asset. *(Live
    effect — STOP-LIST; runs only after operator approval.)*
13. The Homebrew formula shall install the `stark` binary from the Task-B Release
    asset such that `brew install <tap>/stark` yields a working `stark` on PATH.
    *(Tap-repo creation — STOP-LIST; operator approval required.)*

**Docs**
14. `README.md` shall document terminal usage of `stark` and its `brew install`
    instructions, and `CLAUDE.md` shall name the standalone-binary channel
    alongside the marketplace channel.

## Task DAG

```
A ──┬──> B ──> C ──┐
    │              ├──> E
    └──> D ────────┘
```
- **A** gates **B** and **D**.
- **B** gates **C**.
- **A, B, C, D** all gate **E**.

Sizes are rough human-minutes for a focused implementer.

---

### Task A — Umbrella dispatcher + bun build config  ·  ~60–90 min  ·  FOUNDATION

Create the `stark` dispatcher that routes `stark <cmd>` to the three existing
`main()` entrypoints, plus the `bun build --compile` config that produces the
binary. Reconcile the three inconsistent invocation seams (see repo-context §3):
minimally export + argv-parameterize `gh_cleanup.ts`'s and `housekeeping_infra.ts`'s
`main()` (or an equivalent argv shim) **without changing their observable
behavior**, and propagate each command's exit code.

**Declared file set:**
- `bin/stark.ts` *(new — the dispatcher; the sole file importing from both trees;
  owns the `--list` registry)*
- `scripts/build-stark.sh` *(new — wraps `bun build --compile bin/stark.ts
  --outfile dist/stark`)*
- `plugins/stark-gh/tools/gh_cleanup.ts` *(seam: export/argv-param `main`; no
  behavior change)*
- `tools/housekeeping_infra.ts` *(seam: export/argv-param `main`; no behavior
  change)*
- `tools/cc_account.ts` *(already exports `main(argv)`; touch only if the shim
  requires it)*
- `.gitignore` *(add `dist/`)*
- `tools/package.json` *(optional: add a `build:stark` script)*

**Done-when (machine-checkable):**
1. `bash scripts/build-stark.sh` exits 0 and `test -x dist/stark` passes.
2. `./dist/stark --list` exits 0 and each of `cc-user`, `cleanup`, `housekeeping`
   appears as its own line (`./dist/stark --list | grep -qx cc-user` etc.).
3. `./dist/stark cc-user show` exits 0; `./dist/stark cleanup --dry-run` exits 0;
   `./dist/stark housekeeping --dry-run` exits 0 (clean tree).
4. `./dist/stark bogus 2>&1 >/dev/null | grep -qi cc-user` and `./dist/stark bogus`
   exits non-zero (unknown subcommand names the valid set on stderr).
5. Exit-code propagation: `./dist/stark cc-user; echo $?` prints `1` (bare cc-user
   is cc_account's usage/exit-1 path, surfaced through the dispatcher).
6. `git check-ignore dist/stark` succeeds (`dist/` is ignored).

**Wiring-seam note:** the two `main()` refactors ARE the seam that makes routing
function — inert-but-green code (a dispatcher that compiles but can't reach two of
three mains) is the failure this task exists to prevent.

---

### Task B — GitHub Release workflow  ·  ~45–60 min  ·  STOP-LIST  ·  depends on A

On a version tag, bun-compile the binary per target platform (darwin-arm64
minimum) and attach the binaries as GitHub Release assets.

**STOP-LIST:** the workflow's live effect creates a public GitHub Release.
Authoring the workflow file is safe; **pushing a tag that triggers it requires
explicit operator approval before it runs.**

**Declared file set:**
- `.github/workflows/stark-release-binary.yml` *(new)*

**Done-when (machine-checkable, WITHOUT publishing):**
1. The workflow file exists and parses (`actionlint .github/workflows/stark-release-binary.yml`,
   or a YAML-parse fallback if actionlint is unavailable — stated).
2. It triggers on `push:` `tags:`, invokes the Task-A build for a darwin-arm64
   target, and has a Release-upload step (grep for `bun build --compile`,
   `darwin-arm64`, and the upload/`gh release upload` action).
3. Local proof the compile target is real, no tag pushed:
   `bun build --compile --target=bun-darwin-arm64 bin/stark.ts --outfile
   dist/stark-darwin-arm64` exits 0 and yields an executable.

---

### Task D — TUI (launcher + three per-command TUIs)  ·  ~90–120 min  ·  depends on A

Zero-dependency ANSI/readline. A launcher menu built from the `--list` registry
(select → run → render), plus a rich TUI per command: cc-user (list + headroom +
switch), cleanup (preview + confirm), housekeeping (preview + confirm). Thin shells
over the existing libs (repo-context §7) — no new business logic.

**Declared file set:**
- `tools/stark_tui.ts` *(new — launcher + shared ANSI/readline primitives + the
  three per-command flows; may split into `tools/tui/*.ts` at the implementer's
  discretion, staying within `tools/`)*
- `bin/stark.ts` *(wire the no-subcommand / TTY path to the launcher)*

**Done-when:**
1. Registry intact: `./dist/stark --list` still enumerates all three (the launcher
   is built from this).
2. Piped selection routes: driving the launcher's selection input reaches the
   chosen command — e.g. `printf '<select-cleanup>\n' | ./dist/stark 2>&1 | grep -qi
   <cleanup-preview-signature>` (exact key protocol is the implementer's; the
   assertion is that a piped selection reaches that command).
3. **No mutation without confirm:** in a scratch git repo, driving the `cleanup`
   TUI to its preview and sending the decline/abort input exits 0 and leaves the
   branch/ref count unchanged (never calls `executePlan`); likewise the
   `housekeeping` TUI never runs a live `cleanInfra` on abort.
4. **Zero new dependency:** `tools/package.json` has no `dependencies` block, and
   an import audit of `bin/stark.ts` + the TUI files finds only `node:*` builtins
   and in-repo relative imports (no bare package specifier).
5. cc-user TUI renders the ranked list: piping a quit input to the cc-user TUI and
   capturing output shows the headroom columns / known account labels.

*Testability note:* the interactive rendering is only partially machine-checkable.
The checkable invariants (registry enumeration, piped-selection routing,
no-mutation-without-confirm, zero-dep) carry the gate; the full visual TUI is
verified manually by launching on a TTY.

---

### Task C — Homebrew tap + formula  ·  ~45 min  ·  STOP-LIST  ·  depends on B

A formula that installs the Task-B Release binary, and the tap repo that serves it.
The formula **source** is authored and validated in THIS repo; the external tap
repo is the STOP-LIST live step.

**STOP-LIST:** creating the external `homebrew-<tap>` repo and pushing the formula
to it is a new external repo + an outward publish. **Operator approval required
before it runs.**

**Declared file set:**
- `packaging/homebrew/stark.rb` *(new — the formula source, validated locally)*

**Done-when (machine-checkable, WITHOUT creating the tap repo):**
1. `ruby -c packaging/homebrew/stark.rb` reports `Syntax OK`.
2. The formula declares `class Stark < Formula`, a `url` pointing at the Task-B
   Release asset naming pattern, a `sha256`, and `def install; bin.install "stark";
   end` (grep assertions).
3. `brew audit --formula packaging/homebrew/stark.rb` passes the syntactic/style
   checks that don't require the live asset — with `ruby -c` + grep as the stated
   fallback when `brew` is unavailable in the runner.

---

### Task E — Docs  ·  ~30 min  ·  depends on A, B, C, D

Document the new channel and its install path.

**Declared file set:**
- `README.md` *(new "Standalone terminal CLI" section: `stark <cmd>` usage +
  `brew tap` / `brew install` instructions)*
- `CLAUDE.md` *(Distribution section: name the standalone-binary channel alongside
  the marketplace channel so it no longer reads as marketplace-only)*

**Done-when (machine-checkable):**
1. `README.md` contains the new section header, a `stark ` usage example, and a
   `brew install` line (grep).
2. `CLAUDE.md`'s Distribution block mentions the standalone binary / Homebrew /
   terminal channel (grep).
3. The closing verification command below passes end-to-end.

---

## Closing verification command

From the repo root on a clean tree:

```bash
bash scripts/build-stark.sh                          # -> dist/stark (bun build --compile)
test -x dist/stark
./dist/stark --list | grep -qx 'cc-user'
./dist/stark --list | grep -qx 'cleanup'
./dist/stark --list | grep -qx 'housekeeping'
./dist/stark cc-user show           >/dev/null       # read-only, exit 0
./dist/stark cleanup --dry-run      >/dev/null       # preview only, no mutation, exit 0
./dist/stark housekeeping --dry-run >/dev/null       # preview only, no mutation, exit 0
```

All commands must exit 0. The interactive launcher menu (Task D) renders the same
`--list` registry; it is verified manually by launching `./dist/stark` on a TTY and
confirming all three commands appear.

*(Note on `cc-user`: the brief's `stark cc-user` is realized here as `stark cc-user
show` — the read-only account listing that exits 0. A bare `stark cc-user` routes to
cc_account's usage/exit-1 path, which is the intended exit-code-passthrough proof in
Task A done-when #5, not a success path; and on a TTY it opens the interactive
cc-user TUI, which is not scriptable. `show` is the deterministic success surface.)*

## STOP-LIST summary

Two tasks carry live effects that require **explicit operator approval before the
step runs** — authoring their artifacts is safe, executing them is not:

| Task | Safe to author | Gated live effect |
|------|----------------|-------------------|
| B    | write the workflow YAML | pushing a tag → creates a public GitHub Release |
| C    | write + validate the formula | creating the external `homebrew-<tap>` repo and publishing the formula |

A new external dependency (e.g. a TUI library, if the implementer concludes the
zero-dep constraint is unworkable) is a **third** STOP-LIST item — an operator
escalation, never a default.

## Deviations

*Append-only. Each entry: `YYYY-MM-DD — <task> — <what changed and why>`. Empty at
authoring time.*
