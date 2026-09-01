# Stage completion line — the channel contract

A chaining caller runs stage skills **in-session** and records what each one
produced. It invokes each stage through its plain slash command — **never with
`--json`** — so the completion channel must live on the stage's *normal* output
path.

> **No caller consumes this today, and no stage emits it.** `$stark-forge`
> chained the stages and was retired on 2026-07-26; nothing since parses the
> line. `$stark-copilot` was its last emitter and was retired on 2026-09-01
> (STARK-2100). The format below is preserved as the contract any future
> emitter/chainer should follow.

This file is the single owner of that channel's format. A stage that forge
orchestrates emits it; a stage run standalone emits it too (it is additive
prose, harmless to a human reader).

## The line

As the **last line** of its terminal output, on **every success path**, the
stage prints exactly one line:

```
STARK_STAGE_SUMMARY {"skill":"stark-author","outcome":"accepted","spec_path":"docs/specs/2026-07-19-auth-spec.md","plan_slug":"auth","pr":812}
```

Rules:

- **One physical line.** Compact JSON, no embedded newlines, no surrounding
  fence. A reader greps for the `STARK_STAGE_SUMMARY ` prefix and parses the
  remainder of the line as JSON.
- **Not gated behind `--json`.** It prints on the human path. Under `--json`
  the stage's existing machine payload is unchanged and this line is additive.
- **Additive only.** Existing human output stays exactly as it was; this line
  is appended after it. No existing consumer changes shape.
- **`skill`** is the emitting skill's frontmatter `name`.
- **`outcome`** is the stage's own terminal verdict string (free-form per
  stage; forge does not branch on it — the stage's halt/failure signalling is
  separate).
- Absent values are `null` (scalars) or `[]` (arrays) — never omitted.
- Every path/slug value MUST be a clean renderable token per spec §2
  (`^[A-Za-z0-9._:=/][A-Za-z0-9._:=/-]*$`). Forge refuses one that is not
  (`unsafe_threaded_arg`).

## Per-stage fields

| Skill | Fields beyond `skill` + `outcome` |
|---|---|
| _(none current)_ | — the last emitter, `stark-copilot`, carried `plan_slug: string\|null` + `prs: number[]` before it was retired |

`pr` is the artifact PR a stage opened **or adopted** — the number forge
seeds/validates against its `artifact_prs` registry. A continuation stage that
adopted an existing PR reports that same number (reporting a different one is
an `adoption_mismatch` in forge).

## Which fields forge reads

Forge maps the line straight onto `forge_state.ts record-output`:

| Stage | `record-output` flags |
|---|---|
| _(none current)_ | copilot mapped `--prs <prs csv>` before it was retired |

## Ownership

`spec_path` and `plan_slug` have exactly **one** producer: `stark-author` — the
spec IS the plan, so there is no separate plan doc and no `plan_path`.
Downstream stage `stark-build` **consumes** the recorded slug via `--plan-slug`
(threaded to `copilot_land.ts`) and never re-derives it from a filename.
