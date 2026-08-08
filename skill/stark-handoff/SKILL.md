---
name: stark-handoff
disable-model-invocation: true
description: >-
  Use when the next move belongs to someone else — a fresh session after
  /compact, a fix dispatched into another repo, a parallel fork, a brainstorm
  or deep-research brief. Triggers: "handoff", "write me a prompt", "prompt
  file", "continuation prompt", "fix prompt", "brief for another session",
  "fork this work", "research prompt". Writes ONE self-contained prompt file a
  fresh executor starts from; can also load or launch one.
argument-hint: "[write|list|use|launch] [name] [--type continuation|fork|fix|brainstorm|research] [--fresh-eyes]"
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run any phase.

# stark-handoff — a prompt file a fresh executor starts from

**Handover vs handoff.** `/stark-handover` = disk state, **same task, same
repo, resume in place**. `/stark-handoff` = a **prompt file** someone else
starts from: another session, another repo, another agent, or this session
after `/compact`. If the ask is "save context so I can resume this same task
here" → say so, route to `/stark-handover`, stop.

The file **is** the product. Everything the executor needs must be in it —
they get no conversation, no scrollback, no you.

**Raw input:** `$ARGUMENTS`

## Constants

```bash
# Storage root: env > config > default. A dedicated root, so every *.md
# directly under it IS a handoff (non-recursive — that is the whole
# selection rule for `list` and `use`).
handoff_root() {
  local r="${STARK_HANDOFF_ROOT:-}" cfg="$HOME/.claude/code-review/config.json"
  [ -n "$r" ] || { [ -f "$cfg" ] && r=$(jq -r '.handoff.root // empty' "$cfg" 2>/dev/null); }
  r="${r:-$HOME/Code/Handoffs}"
  printf '%s\n' "${r/#\~/$HOME}"
}

# Remote URL -> `org/name`, exact-compare form. Never substring-match repos.
norm_repo() { sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#/*$##; s#\.git$##'; }
cur_repo() { git remote get-url origin 2>/dev/null | norm_repo; }

# Header comment of a handoff file, or empty when it has none.
hdr() { sed -n '1s/^<!-- *stark-handoff \(.*[^ ]\) *-->.*/\1/p' "$1"; }
# Split on ` key=` boundaries, not on spaces — repo values may be absolute
# paths containing spaces (`/Users/aryeh/Code/My Project`).
hdr_field() { hdr "$1" | sed -E 's/ ([a-z_]+=)/\
\1/g' | sed -n "s/^$2=//p"; }
```

Functions, not string vars — zsh does not word-split `$VAR`, so define these
in the **same** Bash call that uses them (shells do not persist between calls).

## Arguments

- `/stark-handoff` or `/stark-handoff write` — write a handoff file (default)
  - `--type continuation|fork|fix|brainstorm|research` — skip type inference
  - `--fresh-eyes` — ONE `/stark-fresh-eyes` pass on the written file
- `/stark-handoff list` — table every handoff under the root, newest first
- `/stark-handoff use [name]` — load a handoff and start executing it. Bare
  `use` picks the newest whose header repo is **this** repo.
- `/stark-handoff launch <name>` — dispatch a headless `claude -p` on it in
  the target repo, backgrounded. Execution/investigation types only.
  - `--permission-mode <mode>` — passthrough; default `acceptEdits`

## Guards

- **Same-task-same-repo resume ask → `/stark-handover`.** Say so, stop.
- **Never launch an inquiry type** (`brainstorm`, `research`) — refuse with
  the reason. Never auto-launch anything: `use` and `launch` fire on explicit
  invocation only.
- **Never launch a headerless file**, and never on an ambiguous repo match.
- **Bare `use` never crosses repos.**
- **Max ONE fresh-eyes pass per file revision**, findings dispositioned once —
  never a round 2 (LLM-review loops do not converge).
- **Never `--dangerously-skip-permissions`.**
- Not in plan mode — this skill writes files.

## Types → skeletons

| `--type` | Skeleton | Executor |
|----------|----------|----------|
| `continuation` | [references/skeleton-execution.md](references/skeleton-execution.md) | fresh session, same repo, next slice |
| `fork` | [references/skeleton-execution.md](references/skeleton-execution.md) | a peer session working a parallel slice |
| `fix` | [references/skeleton-investigation.md](references/skeleton-investigation.md) | a session in another repo, bounded bug |
| `brainstorm` | [references/skeleton-inquiry.md](references/skeleton-inquiry.md) | Aryeh, interactive |
| `research` | [references/skeleton-inquiry.md](references/skeleton-inquiry.md) | a web deep-research tool |

## The header comment

First line of every file written here — paste-safe (invisible when rendered),
greppable by `list` and `use`:

```
<!-- stark-handoff repo=21StarkCom/draupnir type=continuation date=2026-08-08 -->
```

`repo` is the **target** repo: normalized `org/name`, or an absolute path when
the checkout has no remote.

---

## Write Mode (default)

### Phase 1 — Route + type

1. Resume-in-place ask? → `/stark-handover`, stop (Guards).
2. Type: `--type` if given, else infer from the ask. **State the choice in one
   line and move on** — do not interrogate. Wrong guess is cheap; an interview
   is not.

### Phase 2 — Mine the conversation

The conversation is ground truth; git fills gaps.

```bash
git log --oneline -15 && git status -s && git diff --stat
```

Every bullet you skip is something the executor re-discovers the hard way:

- [ ] Mission + why, and where it sits in the larger arc
- [ ] Read-first pointers with **line numbers** and a per-doc *why*
- [ ] Established facts **with measurements** vs suspected mechanisms
- [ ] Approaches tried, including the failures and why they failed
- [ ] Binding constraints + per-repo gotchas learned this session
- [ ] Anti-goals — what the executor must refuse
- [ ] Evidence bar — what the deliverable must show, never "it works"
- [ ] Commands that verify state before starting

### Phase 3 — Draft

Every type gets the shared spine: [references/spine.md](references/spine.md)
(envelope/payload split, read-first pointers, established-vs-NOT, binding
constraints, anti-goals, evidence bar). Then fill the type's skeleton from the
table above. Quote specs and failure text **verbatim** — paraphrase is where
missions rot.

### Phase 4 — Rubric self-check

Check the draft against all 9 checks in
[references/rubric-checklist.md](references/rubric-checklist.md) (substrate ·
axioms-vs-testables · contradiction logging · calibration cases · source tiers
· MEASURED > OBSERVED > OPINION · traceability · bounded deliverable ·
anti-goals). Fix what fails **before** writing the file. `research` prompts
must satisfy checks 4–8 explicitly, in the text.

### Phase 5 — Write

```bash
ROOT=$(handoff_root); mkdir -p "$ROOT"
FILE="$ROOT/<slug>-prompt.md"
N=2
while [ -e "$FILE" ]; do                 # collision -> -2, -3, ... until free
  FILE="$ROOT/<slug>-$N-prompt.md"; N=$((N+1))
done
```

Slug: 2–4 kebab words naming the mission. First line is the header comment
(`repo=` the **target** repo, normalized; `date=$(date +%F)`), then the
envelope, then `---`, then the payload.

### Phase 6 — Fresh eyes (only with `--fresh-eyes`)

One `/stark-fresh-eyes <file>` pass. Disposition every finding once (fix /
reject with a reason / accept as known) and stop. No second pass on the same
text — ever.

### Phase 7 — Report

Path, type, and the delivery instruction for that type:

| Type | Delivery |
|------|----------|
| `continuation` | `/clear` (or a fresh session) in the repo, paste the payload |
| `fork` | second session in its own worktree, paste the payload |
| `fix` | a session in the target repo — or `/stark-handoff launch <name>` |
| `brainstorm` | paste into an interactive session; it asks one question at a time |
| `research` | paste into a web deep-research tool |

---

## List Mode

```bash
ROOT=$(handoff_root)
for f in "$ROOT"/*.md; do
  [ -e "$f" ] || continue
  t=$(hdr_field "$f" type); r=$(hdr_field "$f" repo); d=$(hdr_field "$f" date)
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -r "$f" +%s)" "$(basename "$f")" \
    "${t:-—}" "${r:-—}" "${d:-$(date -r "$f" +%F)}"
done | sort -rn | cut -f2-   # mtime is the sort key only; newest first
```

Table it: name · type · repo · date — **newest first**. Hand-added files with
no header still list, `type`/`repo` shown as `—`, dated by mtime.

---

## Use Mode

### Phase 1 — Resolve the file

Explicit `use <name>` may target **any** `*.md` in the root (header optional).

Bare `use` considers only **header-bearing** files and filters to this repo,
newest wins; zero matches → refuse and `list` (never cross repos):

- header `repo=org/name` → equals `cur_repo` exactly (normalized both sides).
- header `repo=/abs/path` → same repo iff
  `git -C "<path>" rev-parse --path-format=absolute --git-common-dir` equals
  this checkout's, so a linked worktree equals its main checkout. Let **git**
  absolutize it — a normal checkout answers a bare relative `.git`, and
  `realpath` would resolve that against the *caller's* cwd, so an unrelated
  checkout would compare equal to wherever you happen to be standing.

### Phase 2 — Ingest + brief

Read the file **fully** — it is your context now. Do not dump it back at
Aryeh: render a 5–8 line brief (mission, where things stand, what's done vs
left, the first action, any blocking open question).

### Phase 3 — Rebuild + start

Recreate the payload's task list as session tasks (TaskCreate, in order), run
whatever verify-state commands the prompt names, then start the first item.
Zero recap friction is the point. Pause only for an open question that blocks
step one.

---

## Launch Mode

### Phase 1 — Refuse early

```bash
ROOT=$(handoff_root); FILE="$ROOT/<name>"
[ -n "$(hdr "$FILE")" ] || { echo "no header comment — refusing"; exit 2; }
TYPE=$(hdr_field "$FILE" type)
# Allow-list, not a deny-list: a missing or unknown `type` is unclassifiable.
case "$TYPE" in
  continuation|fork|fix) ;;
  brainstorm|research) echo "inquiry type — refusing"; exit 2;;
  *) echo "missing/unknown type '${TYPE:-—}' — refusing"; exit 2;;
esac
```

- **No header** → refuse: without `type` the inquiry gate cannot classify it,
  without `repo` there is no target dir. A partial header with no `type`, or a
  `type` outside the five, is refused for the same reason.
- **`brainstorm` / `research`** → refuse, naming the reason: brainstorms need
  Aryeh interactive (their own text says "ask questions one at a time"),
  research prompts run in web deep-research tools.
- **Spec-tier work → refuse.** `launch` is for *bounded* missions: a fix, a
  next slice, one review round. If the payload is a full accepted spec (a task
  DAG, per-task done-whens, a closing verification command — the
  `/stark-author` shape), say so and route it to `/stark-author` →
  `/stark-build`, which gates it with checks the agent cannot edit. A
  `continuation` label does not make a spec bounded.

### Phase 2 — Resolve the target dir

Header `repo`:

- absolute path → use it.
- `org/name` → this repo if `cur_repo` matches exactly; else the **unique**
  checkout under `~/Code` (maxdepth 4) whose normalized origin matches:

```bash
WANT=$(hdr_field "$FILE" repo)
# -print0 / read -d '': checkout paths may contain spaces.
find "$HOME/Code" -maxdepth 4 -name .git -print0 2>/dev/null |
while IFS= read -r -d '' g; do
  d=$(dirname "$g")
  [ "$(git -C "$d" remote get-url origin 2>/dev/null | norm_repo)" = "$WANT" ] && printf '%s\n' "$d"
done
```

Zero or several matches → **refuse**, listing the candidates. Never guess.

### Phase 3 — Dispatch

```bash
SLUG=$(basename "$FILE" .md); SLUG="${SLUG%-prompt}"
LOG="$ROOT/$SLUG-launch-$(date +%Y%m%d-%H%M%S).log"
K=2                                      # same-second relaunch: never truncate
while [ -e "$LOG" ]; do LOG="${LOG%.log}-$K.log"; K=$((K+1)); done
PAYLOAD=$(awk 'f{print} /^---$/{f=1}' "$FILE")   # below the envelope rule
[ -n "$PAYLOAD" ] || PAYLOAD=$(tail -n +2 "$FILE")
( cd "$TARGET_DIR" && nohup claude -p "$PAYLOAD" \
    --permission-mode "${MODE:-acceptEdits}" </dev/null >"$LOG" 2>&1 & echo "$!" )
```

Non-negotiables in that command:

- **`</dev/null`** — `claude -p` reads stdin *in addition to* the prompt arg;
  an orchestrating shell's stdin is a pipe that never EOFs, and the dispatch
  hangs forever (the stark-build lesson: 5h14m for 39 bytes).
- **Backgrounded**, log **timestamped** — a relaunch never clobbers a running
  run's log, and `-2` collision-suffixed prompts never share one.
- **`--permission-mode acceptEdits`** by default, flag passthrough allowed;
  `--dangerously-skip-permissions` is never permitted.

### Phase 4 — Report

PID, log path, and how to monitor (`tail -f "$LOG"`). The run is detached: it
survives this session, and nothing here polls it.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Ask is really "resume this task here" | `/stark-handover`, stop |
| Bare `use`, zero header matches for this repo | Refuse + `list`; never cross repos |
| `launch` on a headerless file | Refuse — copy the header format in, or `use` it manually |
| `launch` repo matches 0 or 2+ checkouts | Refuse, list candidates, let Aryeh name the dir |
| Fresh-eyes findings feel incomplete | Disposition once and ship — no round 2 |
| Root missing | `mkdir -p` it; a first run is not an error |
