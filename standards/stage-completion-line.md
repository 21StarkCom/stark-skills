# Stage completion line — the `/stark-forge` §4 channel contract

`/stark-forge` chains stage skills **in-session** and records what each one
produced (spec §4, "Stage completion output sources"). Forge invokes each stage
through its plain slash command — **never with `--json`** (spec §2 command
table) — so the completion channel must live on the stage's *normal* output
path.

This file is the single owner of that channel's format. A stage that forge
orchestrates emits it; a stage run standalone emits it too (it is additive
prose, harmless to a human reader).

## The line

As the **last line** of its terminal output, on **every success path**, the
stage prints exactly one line:

```
STARK_STAGE_SUMMARY {"skill":"stark-spec-to-plan","outcome":"approved","plan_path":"docs/plans/2026-07-19-auth-plan.md","plan_slug":"auth","pr":812}
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
| `stark-copilot` | `plan_slug: string\|null`, `prs: number[]` |

`pr` is the artifact PR the stage opened **or adopted** — the number forge
seeds/validates against its `artifact_prs` registry. A continuation stage that
adopted an existing PR reports that same number (reporting a different one is
an `adoption_mismatch` in forge).

## Which fields forge reads

Forge maps the line straight onto `forge_state.ts record-output`:

| Stage | `record-output` flags |
|---|---|
| copilot | `--prs <prs csv>` |

## Ownership

`plan_path` and `plan_slug` have exactly **one** producer: `stark-spec-to-plan`
(spec §4 / `ssot`). `stark-plan-to-tasks` and `stark-copilot` **consume** the
recorded slug via `--plan-slug` and never re-derive it from a filename.
