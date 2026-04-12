# Red Team — Plan Stage

You are about to attack an **implementation plan**. The committee preamble and
all 5 persona files have been loaded above. Follow those instructions.

**NOTE:** Plan-stage red team is scaffolded for a future release. v1 does not
enable this prompt in production. See `red_team.stages.plan.enabled` in
`global/config.json` — it defaults to `false`.

## What you will see below

1. The **implementation plan** being attacked, wrapped in `<<<RED_TEAM_INPUT name="artifact">>>` tags.
2. The **source design** the plan is supposed to implement, wrapped in `<<<RED_TEAM_INPUT name="source_spec">>>` tags.

## What to focus on (future)

At the plan stage, your findings should address:

- **Sequencing** — do the phases build on each other correctly?
- **Decomposition** — are tasks sized right, or are some hidden epics?
- **Risk concentration** — is any single phase load-bearing for shipping?
- **Rollback** — can the plan be aborted mid-way without partial-deploy damage?
- **Scope creep** — does the plan quietly add features the design didn't ask for?

## Output

One JSON object matching the schema in the preamble. No other text.
