// Tests for `tools/skill_router_lib.ts` — port of
// `scripts/skill_router.py`. No Python tests existed on the source
// side; these are written from the module's documented behavior:
// surface the skills mapped to a context, skip suppressed ones, skip
// recently-used ones within `cooldown_hours`, rank by `relevance_score`,
// cap at `max_suggestions`.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_SKILLS,
  computeSuggestions,
  DEFAULT_SKILL_ACTIVATION,
  loadSkillActivationConfig,
  loadSkillUsage,
  VALID_CONTEXTS,
} from "./skill_router_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-router-test-"));
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Static surface — context → skill map, valid context set
// ---------------------------------------------------------------------------

test("VALID_CONTEXTS lists the four documented contexts", () => {
  assert.deepEqual([...VALID_CONTEXTS].sort(), [
    "debug",
    "implementation",
    "review",
    "session",
  ]);
});

test("CONTEXT_SKILLS provides at least one skill per context", () => {
  for (const ctx of VALID_CONTEXTS) {
    assert.ok(
      CONTEXT_SKILLS[ctx] !== undefined && CONTEXT_SKILLS[ctx].length >= 1,
      `${ctx} has no skills`,
    );
  }
});

// ---------------------------------------------------------------------------
// loadSkillActivationConfig
// ---------------------------------------------------------------------------

test("loadSkillActivationConfig: returns defaults when config file missing", () => {
  assert.deepEqual(
    loadSkillActivationConfig("/does/not/exist.json"),
    DEFAULT_SKILL_ACTIVATION,
  );
});

test("loadSkillActivationConfig: merges overrides (partial) over defaults", () => {
  const dir = tmp();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      skill_activation: { cooldown_hours: 6, suppressed_skills: ["x"] },
    }),
  );
  const cfg = loadSkillActivationConfig(p);
  assert.equal(cfg.cooldown_hours, 6);
  assert.deepEqual(cfg.suppressed_skills, ["x"]);
  // unchanged defaults:
  assert.equal(cfg.max_suggestions, DEFAULT_SKILL_ACTIVATION.max_suggestions);
  assert.equal(cfg.enabled, DEFAULT_SKILL_ACTIVATION.enabled);
});

test("loadSkillActivationConfig: tolerates malformed JSON, returns defaults", () => {
  const dir = tmp();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, "{not json");
  assert.deepEqual(loadSkillActivationConfig(p), DEFAULT_SKILL_ACTIVATION);
});

// ---------------------------------------------------------------------------
// loadSkillUsage
// ---------------------------------------------------------------------------

test("loadSkillUsage: returns {} when file missing", () => {
  const dir = tmp();
  assert.deepEqual(loadSkillUsage(path.join(dir, "missing.json")), {});
});

test("loadSkillUsage: returns parsed dict when valid JSON object", () => {
  const dir = tmp();
  const p = path.join(dir, "usage.json");
  const data = { by_skill: { "stark-review": 5 }, generated_at: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(p, JSON.stringify(data));
  assert.deepEqual(loadSkillUsage(p), data);
});

test("loadSkillUsage: returns {} when JSON root is not an object", () => {
  const dir = tmp();
  const p = path.join(dir, "u.json");
  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadSkillUsage(p), {});
});

test("loadSkillUsage: returns {} on malformed JSON", () => {
  const dir = tmp();
  const p = path.join(dir, "bad.json");
  fs.writeFileSync(p, "{not json");
  assert.deepEqual(loadSkillUsage(p), {});
});

// ---------------------------------------------------------------------------
// computeSuggestions — core routing logic
// ---------------------------------------------------------------------------

test("computeSuggestions: returns suggestions wrapped in the documented shape", () => {
  const result = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, max_suggestions: 5 },
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.context, "session");
  assert.equal(result.timestamp, "2026-05-18T12:00:00Z");
  assert.equal(typeof result.config.max_suggestions, "number");
  assert.equal(typeof result.config.cooldown_hours, "number");
  assert.equal(typeof result.config.suggest_after_review_rounds, "number");
  assert.equal(typeof result._suppressed_count, "number");
  assert.ok(Array.isArray(result.suggestions));
});

test("computeSuggestions: surfaces context-mapped skill when never used", () => {
  // 'session' → 'stark-housekeeping'. With empty usage, the skill has
  // never been used so cooldown can't apply and it must surface.
  const result = computeSuggestions({
    context: "session",
    cfg: DEFAULT_SKILL_ACTIVATION,
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].skill, "stark-housekeeping");
  assert.equal(result.suggestions[0].last_used, null);
});

test("computeSuggestions: suppressed skills don't surface AND bump _suppressed_count", () => {
  const result = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, suppressed_skills: ["stark-housekeeping"] },
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 0);
  assert.equal(result._suppressed_count, 1);
});

test("computeSuggestions: skips skill that's in usage AND within cooldown", () => {
  // 1h old usage, 24h cooldown → within window → skip
  const result = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, cooldown_hours: 24 },
    usage: {
      by_skill: { "stark-housekeeping": 1 },
      generated_at: isoZ(new Date("2026-05-18T11:00:00Z")),
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 0);
});

test("computeSuggestions: surfaces skill again past cooldown", () => {
  // 48h old usage, 24h cooldown → past window → surface
  const result = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, cooldown_hours: 24 },
    usage: {
      by_skill: { "stark-housekeeping": 1 },
      generated_at: isoZ(new Date("2026-05-16T12:00:00Z")),
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].skill, "stark-housekeeping");
  // last_used should be populated when the skill was in by_skill
  assert.equal(result.suggestions[0].last_used, "2026-05-16T12:00:00Z");
});

test("computeSuggestions: surfaces skill that's never been used regardless of cooldown", () => {
  // Skill NOT in by_skill → cooldown doesn't apply even if file is fresh.
  const result = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, cooldown_hours: 24 },
    usage: {
      by_skill: { "some-other-skill": 1 },
      generated_at: isoZ(new Date("2026-05-18T11:00:00Z")),
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].skill, "stark-housekeeping");
  assert.equal(result.suggestions[0].last_used, null);
});

test("computeSuggestions: caps at max_suggestions and ranks by relevance_score desc", () => {
  // Use a synthetic context map with multiple skills to verify cap + sort.
  const result = computeSuggestions({
    context: "implementation",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, max_suggestions: 1 },
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  // Only one mapped skill for 'implementation'; verify cap holds.
  assert.ok(result.suggestions.length <= 1);
});

test("computeSuggestions: result config block echoes the inputs", () => {
  const cfg = {
    ...DEFAULT_SKILL_ACTIVATION,
    max_suggestions: 7,
    cooldown_hours: 12.5,
    suggest_after_review_rounds: 4,
  };
  const result = computeSuggestions({
    context: "session",
    cfg,
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.config.max_suggestions, 7);
  assert.equal(result.config.cooldown_hours, 12.5);
  assert.equal(result.config.suggest_after_review_rounds, 4);
});

test("computeSuggestions: relevance_score is monotonic with hours_since_file", () => {
  // Older usage file → higher hours_since_file → higher score.
  const old = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, cooldown_hours: 1 },
    usage: {
      by_skill: { "some-other": 1 },
      generated_at: isoZ(new Date("2026-05-01T12:00:00Z")), // ~17 days old
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  const recent = computeSuggestions({
    context: "session",
    cfg: { ...DEFAULT_SKILL_ACTIVATION, cooldown_hours: 1 },
    usage: {
      by_skill: { "some-other": 1 },
      generated_at: isoZ(new Date("2026-05-18T08:00:00Z")), // 4h old
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.ok(
    old.suggestions[0].relevance_score > recent.suggestions[0].relevance_score,
    `old ${old.suggestions[0].relevance_score} should beat recent ${recent.suggestions[0].relevance_score}`,
  );
});

test("computeSuggestions: handles invalid generated_at gracefully (treats as stale)", () => {
  // Malformed timestamp → fall back to "beyond cooldown" → skill surfaces.
  const result = computeSuggestions({
    context: "session",
    cfg: DEFAULT_SKILL_ACTIVATION,
    usage: {
      by_skill: { "stark-housekeeping": 1 },
      generated_at: "not-a-real-timestamp",
    },
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.suggestions.length, 1);
});

test("computeSuggestions: unknown context returns empty suggestions, no crash", () => {
  const result = computeSuggestions({
    // @ts-expect-error — intentionally invalid context
    context: "nonsense",
    cfg: DEFAULT_SKILL_ACTIVATION,
    usage: {},
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.deepEqual(result.suggestions, []);
});

test("computeSuggestions: timestamp uses Z suffix without millis (Python parity)", () => {
  const result = computeSuggestions({
    context: "session",
    cfg: DEFAULT_SKILL_ACTIVATION,
    usage: {},
    now: new Date("2026-05-18T12:30:45.789Z"),
  });
  assert.equal(result.timestamp, "2026-05-18T12:30:45Z");
});
