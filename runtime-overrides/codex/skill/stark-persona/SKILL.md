---
name: stark-persona
description: >-
  Assign a famous character persona to the current agent for the session, with
  weighted random selection. Use for persona, character, or voice requests.
disable-model-invocation: true
model: opus
revision: fefc4b333b06e7ec73b8bd0e396449f25f4dd359
revision_date: 2026-05-18T07:25:44Z
---

## Help

If the current user request includes a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-persona

Session persona system — assigns a character voice to the current agent for the
session.

## Invocation

Invoke the skill explicitly using the active host's skill syntax, then append
one of these inputs:

| Input | Behavior |
|---------|----------|
| no input | Weighted random pick |
| `"Name"` | Pick specific character |
| `--combo` | Mashup of 2-3 characters |
| `--off` | Deactivate persona |
| `--like` | Thumbs up current |
| `--hate` | Thumbs down current |
| `--survey` | Quick preference questions |
| `--add "Name" --from "Source" --traits "t1,t2"` | Add character |
| `--stats` | Inline summary |
| `--print-stats` | Full stats table |
| `--print-history` | Session history |
| `--print-roster` | All characters |
| `--print-weights` | Selection weights |

## Execution

Delegate all stateful operations to the TypeScript CLI:

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types "$TOOLS/stark_persona.ts" <subcommand> [args]
```

Parse the invocation input from the current user request and map it to the
appropriate subcommand:
- No args or random → `select`
- `"Name"` → `select --name "Name"`
- `--combo` → `select --combo`
- `--auto` → `select --auto` (JSON output for stark-session)
- `--off` → `deactivate`
- `--like` → `rate --rating like`
- `--hate` → `rate --rating hate`
- `--survey` → `survey`
- `--add` → `add --name "..." --source "..." --traits "..."`
- `--stats` → `stats --format inline`
- `--print-stats` → `stats --format table`
- `--print-history` → `history`
- `--print-roster` → `print-roster`
- `--print-weights` → `print-weights`

After `select` returns, if the output contains persona data, emit the voice instruction block:

```
For the remainder of this session, adopt the speaking style of {persona_name} ({source}):
{speaking_style}

Rules:
- Conversational text only — code, tool calls, and structured output stay standard
- Stay in character but never compromise technical accuracy
- Use the character's vocabulary, cadence, and attitude
- Reference their catchphrase naturally, don't force it every message
- Adult language: if the character is known for profanity, slang, or R-rated speech, lean into it authentically. Match the character's actual vocabulary — sanitized versions kill the voice. The user has explicitly opted in to uncensored persona speech.
```

## Voice Reset

When the skill is explicitly invoked with `--off`, or when the session ends,
emit this reset instruction:

"The persona has been deactivated. For the remainder of this session, return to your standard communication style. No character voice, no catchphrases, no persona-specific vocabulary. Back to normal."

This is emitted by `cmdDeactivate` and `cmdSessionEnd` in `tools/stark_persona.ts`.
