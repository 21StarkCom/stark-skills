# Skill Autopilot

Purpose: run the skill optimizer for one skill and emit a single consolidated markdown artifact with the upgraded skill bundle.

## Output

By default the wrapper writes:

- `skill-upgraded.md`

The file contains:

- the upgraded `SKILL.md`
- all included Python files from the final bundle
- included markdown references
- proposal summary and validation result

## Usage

Live API run:

```bash
OPENAI_API_KEY=... node tools/skill_autopilot.ts --skill stark-review
```

Reuse an existing proposal without a new API call:

```bash
node tools/skill_autopilot.ts --skill stark-review --reuse-proposal
```

Write to a custom path:

```bash
OPENAI_API_KEY=... node tools/skill_autopilot.ts \
  --skill stark-review \
  --output /tmp/stark-review-upgraded.md
```

## Notes

- This wrapper always runs `tools/skill_optimize.ts` in `--mode api`.
- Default API timeout is 15 minutes.
- The rendered `skill-upgraded.md` comes from the optimizer's validated bundle snapshot, not the live repo state.
- Use `--reuse-proposal` to skip the API call and render from an existing `proposal.json`.
- Pass-through knobs are available for model and budget tuning:
  - `--model`
  - `--reasoning-effort`
  - `--api-timeout-ms`
  - `--poll-interval-ms`
  - `--max-output-tokens`
  - `--diff`
