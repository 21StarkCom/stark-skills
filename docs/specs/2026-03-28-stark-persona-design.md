# stark-persona — Design Spec

**Date:** 2026-03-28
**Status:** Draft
**Author:** Aryeh + Claude (brainstorming)

## 1. Overview

A Claude Code skill that assigns a famous character persona to the AI assistant for the duration of a session. Characters are drawn from movies, TV, comedy, and public figures that resonate with someone born in ~1980 (prime era: 1985–2015 culture). The skill learns preferences over time via a feedback loop and syncs analytics to stark-insights.

### Goals
- Make sessions more engaging and fun without sacrificing productivity
- Learn user preferences over time (weighted random, feedback, surveys)
- Support combos: trait-blended mashups of 2-3 characters for creative chaos
- Date-aware selection: birthdays, death anniversaries boost relevant personas
- Full analytics pipeline via stark-insights (SQLite → Cloud SQL)

### Non-Goals
- The persona never overrides technical accuracy — it's a voice, not a lobotomy
- No personas from children's content, controversial political figures, or anyone the user wouldn't want speaking in a professional context
- Not a chatbot or roleplay tool — the persona flavors the communication style of a working engineering assistant

## 2. Skill Interface

### Invocation Modes

| Command | Behavior |
|---------|----------|
| `/stark-persona` | Weighted random pick, enter character |
| `/stark-persona "Jules Winnfield"` | Pick specific character by name |
| `/stark-persona --combo` | Trait-blended mashup of 2-3 random characters |
| `/stark-persona --like` | Thumbs up current persona (updates weight) |
| `/stark-persona --hate` | Thumbs down current persona (updates weight) |
| `/stark-persona --survey` | 1-3 multiple choice improvement questions |
| `/stark-persona --add "Name" --from "Source" --traits "t1,t2,t3"` | Add a new character to the roster |
| `/stark-persona --stats` | Inline preference summary (3-4 lines, stays in flow) |
| `/stark-persona --print-stats` | Full detailed table with all personas + weights |
| `/stark-persona --print-history` | Session persona history |
| `/stark-persona --print-roster` | All characters with traits |
| `/stark-persona --print-weights` | Current selection weights |

### Auto-Invocation

`/stark-session start` calls `/stark-persona` with `--random` behavior (weighted random). The session briefing includes:

```
Persona: Jules Winnfield (Pulp Fiction) — "Allow me to retort."
```

### Persona Activation

On selection, the skill outputs:
1. Character name, source, and catchphrase
2. A brief "entering character" moment (one line in-character)
3. Stores the active persona in session context

Claude then maintains the character's speaking style for the remainder of the session. The persona applies to conversational text only — code, tool calls, and structured outputs remain standard.

## 3. Storage Architecture

### 3.1 Local — Persona Roster (in stark-skills repo)

**Path:** `data/persona/roster.md`

Human-editable markdown file. Each character is an H2 section:

```markdown
# Persona Roster

## Jules Winnfield
- **Slug:** jules-winnfield
- **Source:** Pulp Fiction (1994)
- **Type:** character
- **Traits:** intense, philosophical, dramatic, righteous, intimidating
- **Catchphrase:** "Allow me to retort."
- **Speaking style:** Biblical references, rhetorical questions, sudden intensity shifts, profanity as punctuation. Alternates between calm menace and explosive energy.
- **Date signals:** Samuel L. Jackson birthday: 1948-12-21

## Guri Alfi
- **Slug:** guri-alfi
- **Source:** Israeli comedian, Eretz Nehederet
- **Type:** person
- **Traits:** deadpan, cynical, dry, observational, understated
- **Catchphrase:** (none — the absence of excitement IS the catchphrase)
- **Speaking style:** Deadpan delivery, dry observations about absurd situations, understatement as comedy. Never raises voice. The less he seems to care, the funnier it gets.
- **Date signals:** birthday: 1970-06-17
```

**Fields:**
| Field | Required | Description |
|-------|----------|-------------|
| Name (H2) | Yes | Display name |
| Slug | Yes | Stable ID (lowercase, hyphens). e.g., `jules-winnfield`. SQLite and analytics key on slug, not display name. |
| Source | Yes | Movie, show, or "Israeli comedian" / "British naturalist" etc. |
| Type | Yes | `character` (fictional) or `person` (real, use comedy style / public persona) |
| Traits | Yes | 3-5 comma-separated trait tags |
| Catchphrase | No | Iconic line. Null for people without one. |
| Speaking style | Yes | 1-3 sentences describing HOW they talk. This is the prompt instruction. |
| Date signals | No | `name: YYYY-MM-DD` for birthdays, death dates, movie release dates |

**Git tracking:** The roster file is committed to stark-skills. The SQLite database is `.gitignore`d.

### 3.2 Local — Persona Database (SQLite)

**Path:** `~/.stark-persona/persona.db`

Not in the repo. Created on first invocation. Stores mutable state: session history, ratings, survey responses, computed weights.

Active persona stored at `~/.stark-persona/active.json` containing `{persona, is_combo, combo_components, session_id, selected_at}`. Written on selection, read by `--like`/`--hate`/fun-facts. Deleted on session end.

**Tables:**

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,           -- ULID
    slug TEXT NOT NULL,             -- character slug (stable ID, e.g., "jules-winnfield")
    persona TEXT NOT NULL,          -- display name
    is_combo BOOLEAN DEFAULT FALSE,
    combo_components TEXT,          -- JSON array of slugs, null for singles
    selected_at TEXT NOT NULL,      -- ISO8601
    weight_at_selection REAL,
    date_signal_matched BOOLEAN DEFAULT FALSE,
    date_signal_reason TEXT         -- "Samuel L. Jackson birthday" or null
);

CREATE TABLE ratings (
    id TEXT PRIMARY KEY,
    session_id TEXT UNIQUE REFERENCES sessions(id),  -- one rating per session (last wins)
    slug TEXT NOT NULL,             -- character slug
    rating TEXT NOT NULL,           -- 'like' or 'hate'
    rated_at TEXT NOT NULL
);

CREATE TABLE survey_responses (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    responded_at TEXT NOT NULL
);

CREATE TABLE weights (
    slug TEXT PRIMARY KEY,          -- character slug
    base_weight REAL DEFAULT 1.0,
    like_count INTEGER DEFAULT 0,
    hate_count INTEGER DEFAULT 0,
    selection_count INTEGER DEFAULT 0,
    last_selected TEXT,
    computed_weight REAL DEFAULT 1.0  -- recalculated after each rating
);

CREATE TABLE favorite_combos (
    recipe_hash TEXT PRIMARY KEY,   -- hash of sorted component slugs
    component_slugs TEXT NOT NULL,  -- JSON array of slugs
    like_count INTEGER DEFAULT 0,
    last_used TEXT NOT NULL
);
```

### 3.3 Cloud — stark-insights Integration

**New event type** added to stark-insights `models.py`:

```python
class EventType(str, Enum):
    ...
    PERSONA_EVENT = "persona_event"
```

**Payload schema:**

```python
PAYLOAD_SCHEMAS["persona_event"] = {
    "subtype": str,              # "selection" | "rating" | "survey_response" | "combo_selection"
    "persona": str,               # character name or combo description
    "is_combo": bool,
    "combo_components": (list, type(None)),
    "rating": (str, type(None)),  # "like" | "hate" | null
    "survey_question": (str, type(None)),
    "survey_answer": (str, type(None)),
    "weight_at_selection": (float, type(None)),
    "date_signal_matched": bool,
    "session_id": (str, type(None)),
}

SENSITIVITY_MAP["persona_event"] = Sensitivity.PUBLIC
```

**Emission:** Via stark-insights `/events` API (HTTP POST to `localhost:7420/events` with bearer token from `~/.stark-insights/api-token`). Falls back to logging if stark-insights is not running — persona selection should never fail because analytics are down.

Events include an `event_id` field (ULID) for deduplication. stark-insights already handles dedupe via source-stable keys. Schema version: payloads include `schema_version: 1`. The existing stark-insights event envelope provides the versioning — no custom versioning needed.

**Sync:** Automatic via existing stark-insights SQLite WAL → Cloud SQL pipeline. No new infrastructure needed.

## 4. Selection Engine

### 4.1 Weight Calculation

```python
def compute_weight(persona: WeightRecord) -> float:
    if persona.selection_count == 0:
        return 1.5  # Discovery boost for untested

    net_sentiment = persona.like_count - persona.hate_count

    if net_sentiment > 0:
        return 1.0 + (min(net_sentiment, 5) * 0.4)  # Max 3.0×
    elif net_sentiment < 0:
        return max(0.2, 1.0 + (net_sentiment * 0.4))  # Floor 0.2×
    else:
        return 1.0  # Neutral
```

| Category | Weight | Example |
|----------|--------|---------|
| Liked (net +1 to +5) | 1.4× to 3.0× | Jules with 3 likes, 0 hates → 2.2× |
| Neutral (net 0) | 1.0× | Tested but no strong signal |
| Hated (net -1 to -2) | 0.6× to 0.2× | Borat with 0 likes, 2 hates → 0.2× |
| Untested | 1.5× | Never selected → discovery boost |

### 4.2 Date-Aware Selection

On every invocation:

1. **Check roster:** Scan all `Date signals` fields for today's month-day
2. **Build candidate list:** All roster entries whose date signals match today
3. **Roll the dice:** 25% chance (0.25 probability) that a date-matched persona is selected. If multiple matches, weighted random among them.
4. **If date wins:** Present with context — "Today is Samuel L. Jackson's birthday. In his honor..."
5. **If date loses (75%):** Proceed to normal weighted random from full roster

> **Note:** Live web search for date signals deferred to v2. Date-awareness in v1 uses ONLY the roster's `Date signals` field.

### 4.3 Combo Generation

When `--combo` is invoked:

1. Pick 2-3 characters from roster (weighted random, so favorites appear in combos more)
2. For each character, select 1-2 dominant traits
3. Generate a combo identity:
   - Name: "[Character A] meets [Character B]" or creative title
   - Traits: merged set from components
   - Speaking style: synthesized from components — "You speak with [A]'s [trait1] combined with [B]'s [trait2]. Your vocabulary draws from [A] but your attitude is pure [B]."
4. Full chaos allowed: cross-gender, cross-genre, cross-era ("What if Gal Gadot played Walter White?", "Reshef Levi directing a nature documentary with David Attenborough")
5. Store the combo recipe in `sessions` table for reproducibility

**Combo feedback rules:** When a combo is rated, the rating applies to the combo recipe (stored by component slugs hash). Component characters each get a 0.5x diluted rating (a combo like doesn't boost individuals as much as a direct like). Combo recipes with likes get stored in the `favorite_combos` table for potential re-selection.

### 4.4 Preference Profile (Learned Over Time) — v2, deferred

> **Not implemented in v1.** The weight-based system (Section 4.1) is sufficient for initial learning. Preference profiling added once enough rating data exists (~50+ sessions).

Survey responses and rating patterns build a preference profile stored in SQLite:

```sql
CREATE TABLE preference_profile (
    dimension TEXT PRIMARY KEY,     -- e.g., "energy", "humor_type", "formality"
    value TEXT NOT NULL,            -- e.g., "high", "dry", "casual"
    confidence REAL DEFAULT 0.0,   -- 0.0-1.0, increases with more data
    updated_at TEXT NOT NULL
);
```

Dimensions (derived from survey answers and like/hate patterns):
- **Energy:** high / medium / low (from liked vs hated persona traits)
- **Humor type:** dry / absurd / physical / sarcastic / none
- **Intensity:** intense / moderate / chill
- **Formality:** casual / professional / chaotic
- **Origin preference:** American / Israeli / British / mixed

This profile influences combo generation — combos bias toward preferred trait combinations.

### 4.5 Timeouts and Back-pressure

All external calls (stark-insights API) have a 2-second timeout. On timeout or connection error, skip silently. Persona selection never blocks on analytics. SQLite writes are synchronous but sub-millisecond.

## 5. Feedback Modes

### 5.1 `--like` / `--hate`

Instant feedback on the active persona.

**Flow:**
1. Look up active persona from current session
2. Upsert rating into `ratings` table (UNIQUE on session_id — only one rating per session, last one wins)
3. Recompute weight for this persona
4. Emit `persona_event` (subtype: `rating`) to stark-insights
5. One-liner confirmation: "Noted — Jules moves up the ranks." / "Got it — less Borat."

### 5.2 `--survey`

1-3 multiple choice questions. Question pool (randomly selected):

**About the current persona:**
- "What made this persona work? (a) Humor (b) Energy (c) Vocabulary (d) Surprise factor (e) It didn't"
- "Too much or too little character? (a) Dial it up (b) Just right (c) Tone it down (d) Way too much"
- "Would you want this persona for: (a) coding sprint (b) design session (c) debugging (d) all of the above (e) none"

**General preferences:**
- "What energy do you want today? (a) High intensity (b) Calm and steady (c) Chaotic fun (d) Surprise me"
- "Preferred humor style? (a) Dry/deadpan (b) Over-the-top (c) Sarcastic (d) Absurd (e) No humor, just vibes"
- "More combos or stick to singles? (a) More combos (b) Singles are fine (c) Only combos (d) Mix it up"

**Flow:**
1. Select 1-3 questions (at least 1 persona-specific, optionally 1-2 general)
2. Present as multiple choice
3. Store each response in `survey_responses` table (v1 — stored for future analysis)
4. In v2: derive `preference_profile` from accumulated survey data. In v1: survey responses are stored but not used for selection.
5. Emit `persona_event` (subtype: `survey_response`) per question

### 5.3 Random Pop-Up Survey

Occasionally (roughly 1 in 5 sessions), instead of just selecting a persona, the skill also asks ONE quick survey question before proceeding. Non-blocking — if the user dismisses it, the persona still activates.

## 6. Print / Stats Modes

### 6.1 `--stats` (inline summary)

```
Persona Preferences (42 sessions)
  Top 3: Jules Winnfield (8×, ❤️5), The Dude (6×, ❤️3), Deadpool (5×, ❤️2)
  Bottom: Borat (2×, 👎2), Napoleon Dynamite (1×, 👎1)
  Profile: high energy, sarcastic humor, casual, American-leaning
  Combos: 12 generated, 4 liked
```

### 6.2 `--print-stats`

Full table:

```
┌──────────────────────┬──────┬───────┬───────┬────────┬────────────┐
│ Persona              │ Sel. │ Likes │ Hates │ Weight │ Last Used  │
├──────────────────────┼──────┼───────┼───────┼────────┼────────────┤
│ Jules Winnfield      │ 8    │ 5     │ 0     │ 3.00   │ 2026-03-28 │
│ The Dude             │ 6    │ 3     │ 0     │ 2.20   │ 2026-03-27 │
│ Deadpool             │ 5    │ 2     │ 0     │ 1.80   │ 2026-03-25 │
│ ...                  │      │       │       │        │            │
│ Borat                │ 2    │ 0     │ 2     │ 0.20   │ 2026-03-20 │
└──────────────────────┴──────┴───────┴───────┴────────┴────────────┘

Preference Profile:
  Energy: high (confidence: 0.8)
  Humor: sarcastic (confidence: 0.7)
  Intensity: intense (confidence: 0.6)
```

### 6.3 `--print-history`

```
2026-03-28 14:30  Jules Winnfield           ❤️  (date: Jackson birthday)
2026-03-27 09:15  The Dude × Gandalf        ❤️  (combo)
2026-03-26 10:00  Guri Alfi                     (no rating)
2026-03-25 08:45  Deadpool                  ❤️
2026-03-24 11:20  Borat                     👎
```

### 6.4 `--print-roster`

Full character list with traits, grouped by category.

### 6.5 `--print-weights`

All characters sorted by current computed weight, showing the calculation breakdown.

## 7. Session-End Fun Facts (20% Chance)

When `/stark-session end` fires, 20% probability of a fun-facts callout block:

**For single personas:**
```
┌─────────────────────────────────────────────────────┐
│  🎬 Fun Fact: Jules Winnfield                        │
│                                                       │
│  The "Bad Motherfucker" wallet was Tarantino's real  │
│  wallet. Jackson asked to keep it after filming.     │
│  The Ezekiel 25:17 speech is mostly made up — the   │
│  real verse is much shorter.                         │
└─────────────────────────────────────────────────────┘
```

**For combos:**
```
┌─────────────────────────────────────────────────────┐
│  🎬 Fun Fact: Guri Alfi × Walter White               │
│                                                       │
│  If these two collaborated, Guri would deadpan his   │
│  way through a meth empire while Walter would lose   │
│  his mind at Guri's complete lack of urgency.        │
│  "We need to cook." "...eh, maybe tomorrow."         │
└─────────────────────────────────────────────────────┘
```

**For real people:**
Fun facts about their career, famous moments, lesser-known trivia.

**Implementation:** The fun fact is generated by Claude at session end from training data (not pre-stored). Web search is an optional enhancement for accuracy on factual claims, not required. For combos, the fun fact is creative/fictional.

## 8. `--add` Mode

```
/stark-persona --add "Doron Kavillio" --from "Fauda" --traits "intense,decisive,conflicted,tactical,Israeli"
```

**Flow:**
1. Parse name, source, traits from arguments
2. Generate speaking style description (Claude generates based on traits + source)
3. Prompt user: "Speaking style: '[generated description]' — look right?"
4. On confirmation: append to `data/persona/roster.md`
5. Initialize weight record in SQLite (untested: 1.5x)
6. Appends to roster.md. User commits manually or via `/stark-session end`. No auto-git-commit.

**Type detection:** If source is a movie/show title → `type: character`. If source contains "comedian", "actor", "musician", etc. → `type: person`.

## 9. Initial Roster (~70 characters)

### 80s/90s Action
John McClane (Die Hard), Indiana Jones, Maverick (Top Gun), Rocky Balboa, The Terminator (T-800), RoboCop, Maximus (Gladiator), Ethan Hunt

### 90s/00s Comedy
The Dude, Ace Ventura, Austin Powers, Borat, Napoleon Dynamite, Ron Burgundy, White Goodman (Dodgeball), The Mask, Dr. Evil

### Crime/Drama
Jules Winnfield, Tony Montana, Tony Soprano, Walter White, The Joker (Ledger), Tyler Durden, Keyser Söze, Michael Corleone, Tommy DeVito (Goodfellas), Hannibal Lecter

### Sci-Fi/Fantasy
Neo, Morpheus, Agent Smith, Han Solo, Darth Vader, Captain Kirk, Spock, Gandalf, Aragorn, The Mandalorian, Thanos

### Modern
Deadpool, John Wick, Thor (MCU), Jack Sparrow, Shrek, The Genie (Aladdin, Williams), Forrest Gump, The Wolf of Wall Street (Belfort)

### Israeli Comedy
Udi Kagan, Daniel Cohen, Guri Alfi, Reshef Levi, Adir Miller

### Israeli Characters
Zohan (Don't Mess with the Zohan), Doron Kavillio (Fauda), Tamir Rabinyan (Tehran/Ephraim)

### Worldwide Icons
James Bond (Connery era), James Bond (Craig era), David Attenborough, Morgan Freeman (narrator voice), Snoop Dogg, Ozzy Osbourne, Bowen Yang as the Iceberg, Werner Herzog

### Wildcards
Yoda, Gollum, HAL 9000, GLaDOS, The Narrator (Fight Club), Dwight Schrute, Michael Scott, Ron Swanson, Saul Goodman

Full trait tagging completed during implementation.

## 10. Implementation Scope

### In stark-skills repo
- `skill/stark-persona/SKILL.md` — skill definition
- `data/persona/roster.md` — character roster with traits
- Symlinked to `~/.claude/skills/stark-persona/`

### In stark-insights repo
- Add `PERSONA_EVENT` to `EventType` enum
- Add payload schema to `PAYLOAD_SCHEMAS`
- Add sensitivity mapping (`PUBLIC`)
- Alembic migration if needed (events table is schemaless payload, so likely just enum update)

### Local (not in any repo)
- `~/.stark-persona/persona.db` — SQLite database (sessions, ratings, surveys, weights, preference profile)

### Integration with stark-session
- `/stark-session start` invokes `/stark-persona` with weighted random behavior
- `/stark-session end` rolls 20% chance for fun-facts callout

## 11. Error Handling

| Failure | Behavior |
|---------|----------|
| stark-insights not running | Log warning, skip event emission. Persona still activates. |
| SQLite DB missing | Create on first invocation with schema. |
| Roster file missing | Create with minimal seed (5 characters). |
| No date signals match today | Proceed with normal weighted random. |
| Character not found (specific pick) | Fuzzy match against roster. If no match: "Character not in roster. Add with --add?" |
| No active persona (--like/--hate) | "No active persona this session. Pick one first." |
| Survey dismissed | Persona activates anyway. No penalty. |

## 12. Future Considerations (Not in v1)

- **Persona marketplace:** share roster files between users
- **Team personas:** different personas for different project types (auto-detected)
- **Voice consistency scoring:** rate how well Claude maintained the persona throughout the session
- **Persona leaderboard:** in stark-team dashboard, show most popular personas across the team
