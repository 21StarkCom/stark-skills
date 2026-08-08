# The shared spine — every handoff type

Fill every section. A skipped section is something the executor re-discovers
the hard way, without your context.

## 0. Header comment (first line of the file)

```
<!-- stark-handoff repo=<org/name or /abs/path> type=<type> date=<YYYY-MM-DD> -->
```

## 1. Envelope / payload split

One or two lines addressed to **Aryeh**, above a `---` rule: where to paste
this, which repo/dir to start the session in. Everything **below** the rule is
the payload — all the executor ever sees. Nothing above the rule may carry
mission-critical fact.

```
<!-- stark-handoff … -->
Paste the payload below into a fresh session started in `<dir>`.

---

<payload starts here>
```

## 2. Read-first pointers

Each entry: path **with line numbers**, and a one-line *why they must read it*.
No bare file lists — a path with no reason gets skipped.

- `path/to/doc.md:120-190` — the contract this task must not break.

## 3. Established vs NOT established

Two labelled lists. Verified facts carry their **measurement** (numbers, run
ids, exit codes, quoted output); suspected mechanisms are labelled as suspected
and never phrased as fact. Where re-derivation is cheap, say
"verify this yourself rather than trusting me" and give the command.

- **Established:** `npm test` = 130/130 pass at `<sha>` (measured 2026-08-08).
- **NOT established:** why the wrapper flakes — mechanism unproven.

## 4. Binding constraints

Prefixed with **"these are not preferences"**. Branch + PR rule, ticket rule,
and the per-repo gotchas learned this session: lint traps, CI shape, merge-tool
exit codes, protected paths, commands that must not be run.

## 5. Anti-goals

The failure modes the executor must **refuse**, named concretely. Not "be
careful" — "do not X, even if Y looks like a reason to".

## 6. Evidence bar

What the deliverable must **show**: real numbers, RED→GREEN proof, run ids,
quoted command output. Never "it works", never "should be fine".
