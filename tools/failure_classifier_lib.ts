/**
 * Failure classifier — TypeScript port of `scripts/failure_classifier.py`.
 *
 * Classifies stderr output into canonical failure categories so the
 * self-healer can pick a recovery pattern. Pure leaf — no local imports.
 *
 * Classification is first-match-wins, in the same nesting order the
 * Python used: for each category, for each pattern, scan every line.
 * Literal patterns score 1.0 confidence; regex patterns score 0.7.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Pattern {
  text: string;
  isRegex: boolean;
}

interface Category {
  name: string;
  patternId: string | null;
  recommendedAction: string;
  patterns: Pattern[];
}

export interface ClassifyResult {
  category: string;
  confidence: number;
  pattern_id: string | null;
  recommended_action: string;
  stderr_excerpt?: string;
}

// Priority order: index 0 = highest priority.
export const CATEGORIES: Category[] = [
  {
    name: "AUTH_STALE",
    patternId: "auth-stale",
    recommendedAction: "refresh GitHub App token",
    patterns: [
      { text: "401", isRegex: false },
      { text: "403 Forbidden", isRegex: false },
      { text: "token expired", isRegex: false },
      { text: "Bad credentials", isRegex: false },
    ],
  },
  {
    name: "MISSING_IMPORT",
    patternId: "missing-import",
    recommendedAction: "add missing import or install package",
    patterns: [
      { text: "ModuleNotFoundError", isRegex: false },
      { text: "ImportError", isRegex: false },
      { text: "No module named", isRegex: false },
    ],
  },
  {
    name: "TYPE_ERROR",
    patternId: null,
    recommendedAction: "fix type mismatch in code",
    patterns: [
      { text: "TypeError", isRegex: false },
      { text: "type.*mismatch", isRegex: true },
      { text: "incompatible type", isRegex: false },
    ],
  },
  {
    name: "SYNTAX_ERROR",
    patternId: "syntax-error",
    recommendedAction: "fix syntax error in file",
    patterns: [
      { text: "SyntaxError", isRegex: false },
      { text: "IndentationError", isRegex: false },
      { text: "unexpected token", isRegex: false },
    ],
  },
  {
    name: "MIGRATION_CONFLICT",
    patternId: "migration-conflict",
    recommendedAction: "resolve migration head conflict",
    patterns: [
      { text: "alembic.*revision", isRegex: true },
      { text: "migration.*conflict", isRegex: true },
      { text: "duplicate.*migration", isRegex: true },
    ],
  },
  {
    name: "DEPENDENCY_MISMATCH",
    patternId: null,
    recommendedAction: "resolve dependency version conflict",
    patterns: [
      { text: "version.*conflict", isRegex: true },
      { text: "dependency.*resolution", isRegex: true },
      { text: "peer.*required", isRegex: true },
    ],
  },
  {
    name: "RESOURCE_EXHAUSTED",
    patternId: "stale-lock",
    recommendedAction: "wait for rate limit or free resources",
    patterns: [
      { text: "rate limit", isRegex: false },
      { text: "quota exceeded", isRegex: false },
      { text: "429", isRegex: false },
      { text: "OOM", isRegex: false },
      { text: "MemoryError", isRegex: false },
    ],
  },
];

const UNCLASSIFIED: ClassifyResult = {
  category: "UNCLASSIFIED",
  confidence: 0.5,
  pattern_id: null,
  recommended_action: "inspect stderr manually",
};

function lineMatches(line: string, pattern: Pattern): boolean {
  if (pattern.isRegex) {
    return new RegExp(pattern.text, "i").test(line);
  }
  return line.includes(pattern.text);
}

/** Classify stderr content into a canonical failure category. */
export function classify(stderrContent: string): ClassifyResult {
  if (stderrContent.trim() === "") {
    return { ...UNCLASSIFIED };
  }

  // Match Python's `str.splitlines()` — split on \n / \r\n / \r and drop
  // a trailing newline so it doesn't yield a spurious empty final line.
  const lines = stderrContent.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const category of CATEGORIES) {
    for (const pattern of category.patterns) {
      for (const line of lines) {
        if (lineMatches(line, pattern)) {
          return {
            category: category.name,
            confidence: pattern.isRegex ? 0.7 : 1.0,
            pattern_id: category.patternId,
            recommended_action: category.recommendedAction,
          };
        }
      }
    }
  }

  return { ...UNCLASSIFIED };
}

function utcNowZ(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Append the classification result to `~/.claude/code-review/healer.jsonl`.
 * Best-effort — logging failures are swallowed, never propagated.
 */
export function logResult(result: ClassifyResult, stderrFile: string): void {
  try {
    const logDir = path.join(os.homedir(), ".claude", "code-review");
    fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      timestamp: utcNowZ(),
      category: result.category,
      confidence: result.confidence,
      pattern_id: result.pattern_id,
      stderr_file: String(stderrFile),
    };
    fs.appendFileSync(path.join(logDir, "healer.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // Never fail on logging errors.
  }
}
