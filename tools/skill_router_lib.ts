/**
 * Contextual skill router — TypeScript port of `scripts/skill_router.py`.
 *
 * Surfaces underused skills at relevant moments. Given a context
 * ("review", "implementation", "session", "debug"), returns the mapped
 * skills minus suppressed/recently-used ones, ranked by a
 * relevance + age score, capped at `max_suggestions`.
 *
 * `config_loader.py` is NOT pulled in — the `skill_activation` section
 * is loaded inline directly from `~/.claude/code-review/config.json`
 * with the same defaults the Python ships.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assetConfigPath } from "./asset_root_lib.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type Context = "review" | "implementation" | "session" | "debug";

export const VALID_CONTEXTS: ReadonlySet<Context> = new Set<Context>([
  "review",
  "implementation",
  "session",
  "debug",
]);

export const CONTEXT_SKILLS: Readonly<Record<Context, readonly string[]>> = {
  review: ["stark-review-improvement"],
  implementation: ["stark-init-docs"],
  session: ["stark-housekeeping"],
  debug: ["stark-review"],
};

export interface SkillActivationConfig {
  enabled: boolean;
  suggest_after_review_rounds: number;
  max_suggestions: number;
  cooldown_hours: number;
  suppressed_skills: string[];
  activation_signals: string[];
}

export const DEFAULT_SKILL_ACTIVATION: SkillActivationConfig = {
  enabled: true,
  suggest_after_review_rounds: 3,
  max_suggestions: 2,
  cooldown_hours: 24,
  suppressed_skills: [],
  activation_signals: ["review_finding", "correction", "skill_invocation"],
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function defaultSkillUsagePath(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "code-review",
    "history",
    "skill-usage.json",
  );
}

export function defaultConfigPath(): string {
  return assetConfigPath();
}

// ---------------------------------------------------------------------------
// Config + usage loaders
// ---------------------------------------------------------------------------

export function loadSkillActivationConfig(
  configPath?: string,
): SkillActivationConfig {
  const file = configPath ?? defaultConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ...DEFAULT_SKILL_ACTIVATION };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SKILL_ACTIVATION };
  }
  if (typeof data !== "object" || data === null) {
    return { ...DEFAULT_SKILL_ACTIVATION };
  }
  const section = (data as Record<string, unknown>).skill_activation;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    return { ...DEFAULT_SKILL_ACTIVATION };
  }
  const overrides = section as Record<string, unknown>;
  const cfg: SkillActivationConfig = {
    ...DEFAULT_SKILL_ACTIVATION,
    suppressed_skills: [...DEFAULT_SKILL_ACTIVATION.suppressed_skills],
    activation_signals: [...DEFAULT_SKILL_ACTIVATION.activation_signals],
  };
  if (typeof overrides.enabled === "boolean") cfg.enabled = overrides.enabled;
  if (typeof overrides.suggest_after_review_rounds === "number") {
    cfg.suggest_after_review_rounds = overrides.suggest_after_review_rounds;
  }
  if (typeof overrides.max_suggestions === "number") {
    cfg.max_suggestions = overrides.max_suggestions;
  }
  if (typeof overrides.cooldown_hours === "number") {
    cfg.cooldown_hours = overrides.cooldown_hours;
  }
  if (Array.isArray(overrides.suppressed_skills)) {
    cfg.suppressed_skills = overrides.suppressed_skills.map(String);
  }
  if (Array.isArray(overrides.activation_signals)) {
    cfg.activation_signals = overrides.activation_signals.map(String);
  }
  return cfg;
}

export function loadSkillUsage(
  usagePath?: string,
): Record<string, unknown> {
  const file = usagePath ?? defaultSkillUsagePath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {};
  }
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core routing
// ---------------------------------------------------------------------------

export interface Suggestion {
  skill: string;
  reason: string;
  last_used: string | null;
  relevance_score: number;
}

export interface SuggestionsResult {
  suggestions: Suggestion[];
  context: string;
  timestamp: string;
  config: {
    max_suggestions: number;
    cooldown_hours: number;
    suggest_after_review_rounds: number;
  };
  _suppressed_count: number;
}

export interface ComputeSuggestionsOpts {
  context: Context;
  cfg: SkillActivationConfig;
  usage: Record<string, unknown>;
  now: Date;
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function round4(n: number): number {
  // Match Python `round(x, 4)` semantics. JS doesn't have a clean
  // builtin, so do the standard *10000 round / 10000 dance.
  return Math.round(n * 10000) / 10000;
}

export function computeSuggestions(opts: ComputeSuggestionsOpts): SuggestionsResult {
  const { context, cfg, usage, now } = opts;
  const maxSuggestions = Math.floor(cfg.max_suggestions);
  const cooldownHours = cfg.cooldown_hours;
  const suppressed = new Set(cfg.suppressed_skills);

  const bySkillRaw = usage.by_skill;
  const bySkill: Record<string, number> =
    typeof bySkillRaw === "object" && bySkillRaw !== null && !Array.isArray(bySkillRaw)
      ? (bySkillRaw as Record<string, number>)
      : {};
  const generatedAtRaw = usage.generated_at;
  const generatedAtStr =
    typeof generatedAtRaw === "string" ? generatedAtRaw : null;

  let hoursSinceFile = cooldownHours + 1; // default: treat as old
  let generatedAtDt: Date | null = null;
  if (generatedAtStr) {
    // Handle both "...Z" and "...+00:00" suffixes.
    const parsed = new Date(generatedAtStr.replace(/Z$/, "+00:00"));
    if (!Number.isNaN(parsed.getTime())) {
      generatedAtDt = parsed;
      hoursSinceFile = (now.getTime() - parsed.getTime()) / 1000 / 3600;
    }
  }

  const relevantSkills = (CONTEXT_SKILLS as Record<string, readonly string[]>)[context] ?? [];
  let suppressedCount = 0;
  const candidates: Suggestion[] = [];

  for (let idx = 0; idx < relevantSkills.length; idx++) {
    const skill = relevantSkills[idx];
    if (suppressed.has(skill)) {
      suppressedCount += 1;
      continue;
    }
    const inUsage = Object.prototype.hasOwnProperty.call(bySkill, skill);
    const withinCooldown = hoursSinceFile <= cooldownHours;
    if (inUsage && withinCooldown) continue;

    const relevance = Math.max(1, 3 - idx);
    const score = hoursSinceFile * 0.5 + relevance;
    const lastUsed =
      inUsage && generatedAtDt !== null ? isoZ(generatedAtDt) : null;

    candidates.push({
      skill,
      reason: `Not used recently; relevant for ${context} context`,
      last_used: lastUsed,
      relevance_score: round4(score),
    });
  }

  candidates.sort((a, b) => b.relevance_score - a.relevance_score);
  const suggestions = candidates.slice(0, maxSuggestions);

  return {
    suggestions,
    context,
    timestamp: isoZ(now),
    config: {
      max_suggestions: maxSuggestions,
      cooldown_hours: cooldownHours,
      suggest_after_review_rounds: cfg.suggest_after_review_rounds,
    },
    _suppressed_count: suppressedCount,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatter (kept here so the CLI is a thin wrapper)
// ---------------------------------------------------------------------------

export function humanReadable(result: SuggestionsResult): string {
  const lines: string[] = [`Skill suggestions for '${result.context}' context:`];
  if (result.suggestions.length === 0) {
    lines.push("  (no suggestions)");
  } else {
    for (const s of result.suggestions) {
      lines.push(
        `  → ${s.skill.padEnd(30)} [score: ${s.relevance_score}]  ${s.reason}`,
      );
    }
  }
  return lines.join("\n");
}
