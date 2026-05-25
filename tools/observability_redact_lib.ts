/**
 * Redaction surfaces for the stark-review observability stack (Phase 2 Task 5
 * + E6 errata).
 *
 * Two callable shapes:
 *
 * - `redact(text)` — one-shot match-and-mask for short fields
 *   (subagent_progress.payload string leaves, error/summary fields).
 * - `createStreamRedactor()` — stateful redactor for chunked stdout/stderr,
 *   carries an overlap buffer so a secret split across two `attachChild`
 *   Buffer arrivals or across the Phase 2 Task 4 56 KiB serialized-request
 *   split is still matched.
 * - `redactJson(value)` — recursive structured-payload sanitiser (E6) used by
 *   the daemon before writing structured `subagent_progress` payloads,
 *   `subagent_end.summary`, etc. Depth-capped at 32; strings over 1 MB are
 *   replaced with a sentinel rather than scanned (to bound CPU).
 *
 * Replacement preserves character count: matches are replaced by
 * `<REDACTED:name>` padded with `*` to the matched length so log byte offsets
 * are stable. This is load-bearing for `event_offsets` correctness: the index
 * writer pre-computes `byte_end - byte_start` for WebSocket backfill, and a
 * length-changing replacement would invalidate every cached offset.
 *
 * Patterns are configurable at boot via the OBSERVABILITY_REDACT_EXTRA_ENV
 * env-var-listed values (literal-match) and `redactors.json` (additional
 * regexes). Disabling specific built-in patterns: comma-list in
 * OBSERVABILITY_REDACT_DISABLE_PATTERNS.
 */

import fs from "node:fs";
import path from "node:path";

import { OBSERVABILITY_ROOT } from "./observability_paths_lib.ts";

export interface RedactionPattern {
  /** Stable id used in the `<REDACTED:NAME>` replacement and in toggles. */
  name: string;
  /** Regex (with `g` flag) that finds the secret. */
  pattern: RegExp;
  /** Upper bound on a single match's character length. */
  maxLen: number;
}

const DEFAULT_PATTERNS: RedactionPattern[] = [
  // RFC 7519 JSON Web Token: three dot-separated base64url segments.
  // header.payload.signature; each segment ≥ 4 chars, no padding.
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, maxLen: 4096 },
  // GitHub personal-access tokens — `ghp_` + 36 alphanum.
  { name: "ghp", pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, maxLen: 80 },
  { name: "ghs", pattern: /\bghs_[A-Za-z0-9]{30,}\b/g, maxLen: 80 },
  { name: "gho", pattern: /\bgho_[A-Za-z0-9]{30,}\b/g, maxLen: 80 },
  { name: "ghu", pattern: /\bghu_[A-Za-z0-9]{30,}\b/g, maxLen: 80 },
  { name: "ghr", pattern: /\bghr_[A-Za-z0-9]{30,}\b/g, maxLen: 80 },
  // Anthropic API keys: `sk-ant-` + alphanum + dashes.
  { name: "sk-ant", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, maxLen: 200 },
  // OpenAI / generic sk- keys (must check AFTER sk-ant- so the ant variant wins).
  { name: "sk", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, maxLen: 200 },
  // AWS access key id.
  { name: "akia", pattern: /\bAKIA[0-9A-Z]{16}\b/g, maxLen: 24 },
  // Authorization: Bearer <token> headers — match through end-of-token (no whitespace).
  // Case-insensitive on the prefix; bearer token chars are RFC 6750 b64token = [A-Za-z0-9-._~+/]+=*
  {
    name: "bearer",
    pattern: /(?:[Aa]uthorization:\s*)?[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    maxLen: 4096,
  },
];

function loadExtraPatternsFromFile(): RedactionPattern[] {
  const p = path.join(OBSERVABILITY_ROOT, "redactors.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Array<{
      name: string;
      pattern: string;
      flags?: string;
      max_len?: number;
    }>;
    if (!Array.isArray(parsed)) return [];
    const out: RedactionPattern[] = [];
    for (const entry of parsed) {
      if (!entry?.name || !entry?.pattern) continue;
      const flags = entry.flags ?? "g";
      const flagSet = flags.includes("g") ? flags : flags + "g";
      const maxLen = Number.isFinite(entry.max_len) ? Number(entry.max_len) : 4096;
      try {
        out.push({ name: entry.name, pattern: new RegExp(entry.pattern, flagSet), maxLen });
      } catch {
        // Bad regex — skip silently; redactors.json is operator-owned.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function loadLiteralExtras(): RedactionPattern[] {
  const env = process.env.OBSERVABILITY_REDACT_EXTRA_ENV;
  if (!env) return [];
  const names = env.split(",").map((s) => s.trim()).filter(Boolean);
  const out: RedactionPattern[] = [];
  for (const name of names) {
    const v = process.env[name];
    if (!v) continue;
    // Escape regex metacharacters — we want a literal match.
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push({
      name: `env:${name}`,
      pattern: new RegExp(escaped, "g"),
      maxLen: v.length,
    });
  }
  return out;
}

function disabledNames(): Set<string> {
  const env = process.env.OBSERVABILITY_REDACT_DISABLE_PATTERNS;
  if (!env) return new Set();
  return new Set(env.split(",").map((s) => s.trim()).filter(Boolean));
}

let CACHED_PATTERNS: RedactionPattern[] | null = null;

/** Reload patterns from env + redactors.json. Test seam — also called once
 * at first use. */
export function getActivePatterns(): RedactionPattern[] {
  if (CACHED_PATTERNS) return CACHED_PATTERNS;
  const disabled = disabledNames();
  const merged = [
    ...DEFAULT_PATTERNS.filter((p) => !disabled.has(p.name)),
    ...loadLiteralExtras(),
    ...loadExtraPatternsFromFile().filter((p) => !disabled.has(p.name)),
  ];
  CACHED_PATTERNS = merged;
  return merged;
}

export function resetPatternCacheForTests(): void {
  CACHED_PATTERNS = null;
}

/** Cap on a single string scanned by redact / redactJson. Inputs over this
 * size are replaced with a sentinel rather than scanned, to keep one
 * pathological field from stalling the writer queue. */
export const MAX_REDACT_STRING_BYTES = 1 << 20; // 1 MiB

/** Cap on object/array depth for redactJson. Anything deeper is replaced
 * with the sentinel `"<REDACT_DEPTH_LIMIT>"` to prevent stack blow-up. */
export const REDACT_MAX_DEPTH = 32;

function padToLen(name: string, n: number): string {
  const core = `<REDACTED:${name}>`;
  if (n <= core.length) return core.slice(0, n) || core;
  return core + "*".repeat(n - core.length);
}

export interface RedactResult {
  text: string;
  redacted: boolean;
}

/**
 * One-shot redaction. Returns the rewritten text and whether anything
 * matched. Length-preserving (each match is replaced by `<REDACTED:NAME>`
 * padded with `*` to the original match length).
 */
export function redact(text: string): RedactResult {
  if (typeof text !== "string") return { text: String(text ?? ""), redacted: false };
  if (text.length === 0) return { text, redacted: false };
  // Hard byte cap — keep one pathological field from stalling the writer
  // queue. We replace with a length-preserving sentinel so downstream byte
  // offsets stay coherent.
  if (Buffer.byteLength(text, "utf8") > MAX_REDACT_STRING_BYTES) {
    return {
      text: padToLen("oversize", text.length),
      redacted: true,
    };
  }
  let out = text;
  let hit = false;
  for (const { name, pattern } of getActivePatterns()) {
    pattern.lastIndex = 0;
    if (!pattern.test(out)) continue;
    hit = true;
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => padToLen(name, match.length));
  }
  return { text: out, redacted: hit };
}

/**
 * Compute the longest plausible match length across the active pattern set.
 * Used as the overlap-buffer size for `createStreamRedactor` — a secret
 * crossing the boundary will sit inside that tail until the next feed.
 *
 * Patterns advertise their own `maxLen`; if a pattern's `maxLen` exceeds
 * 65_536 we cap it (above that an attacker could starve the stream by
 * forcing infinite buffering).
 */
function computeMaxPatternLen(): number {
  const patterns = getActivePatterns();
  let best = 64;
  for (const p of patterns) {
    const capped = Math.min(p.maxLen, 65_536);
    if (capped > best) best = capped;
  }
  return best;
}

export interface StreamRedactor {
  /** Append a chunk of bytes/text. Returns the safe-to-emit prefix. */
  feed(chunk: string): string;
  /** Flush the residual tail — caller must concat into the final emit. */
  flush(): string;
  /** True if any redaction has fired since construction. */
  hasRedacted(): boolean;
}

/**
 * Stateful redactor for chunked output.
 *
 * Invariant: every emitted prefix has no secret split across any
 * chunk-boundary up to `MAX_PATTERN_LEN`. Held tail size is exactly
 * `MAX_PATTERN_LEN - 1`; on each feed we run the regexes over the full
 * `tail + chunk` window, emit the prefix corresponding to
 * `len(tail+chunk) - (MAX_PATTERN_LEN - 1)`, and carry the new tail.
 *
 * `flush()` is called on `end_subagent` / `chunk-budget-exceeded` to drain
 * the residual tail with one final pass.
 */
export function createStreamRedactor(): StreamRedactor {
  const maxPatternLen = computeMaxPatternLen();
  const tailKeep = Math.max(1, maxPatternLen - 1);
  let buffer = "";
  let redactedFlag = false;

  const scanAll = (input: string): { text: string; hit: boolean } => {
    if (input.length === 0) return { text: input, hit: false };
    let out = input;
    let hit = false;
    for (const { name, pattern } of getActivePatterns()) {
      pattern.lastIndex = 0;
      if (!pattern.test(out)) continue;
      hit = true;
      pattern.lastIndex = 0;
      out = out.replace(pattern, (match) => padToLen(name, match.length));
    }
    return { text: out, hit };
  };

  return {
    feed(chunk: string): string {
      if (chunk.length === 0) return "";
      buffer += chunk;
      if (buffer.length <= tailKeep) {
        // Not enough data to safely emit anything; everything stays buffered.
        return "";
      }
      const emitLen = buffer.length - tailKeep;
      // Scan FULL tail+chunk window before splitting. A secret that starts
      // before the head/tail boundary and ends inside the retained tail
      // would otherwise be emitted in pieces unredacted, with `flush()`
      // later seeing only the secret's suffix. Because redact() is
      // length-preserving, splitting the scanned text by byte offset is
      // safe — every offset stays stable across the redact rewrite.
      const scanned = scanAll(buffer);
      if (scanned.hit) redactedFlag = true;
      const head = scanned.text.slice(0, emitLen);
      buffer = scanned.text.slice(emitLen);
      return head;
    },
    flush(): string {
      const remaining = buffer;
      buffer = "";
      if (remaining.length === 0) return "";
      const scanned = scanAll(remaining);
      if (scanned.hit) redactedFlag = true;
      return scanned.text;
    },
    hasRedacted(): boolean {
      return redactedFlag;
    },
  };
}

/**
 * Recursively redact every string leaf in a JSON-shaped value. Depth-capped
 * at 32 and per-string size-capped at 1 MiB (oversize strings are replaced
 * with a length-preserving sentinel).
 *
 * Returns `{value, redacted}` so the caller can stamp `redacted: true` on
 * the outgoing JSONL record when any leaf matched.
 */
export interface RedactJsonResult {
  value: unknown;
  redacted: boolean;
}

export function redactJson(value: unknown, depth: number = 0): RedactJsonResult {
  if (depth > REDACT_MAX_DEPTH) {
    return { value: "<REDACT_DEPTH_LIMIT>", redacted: false };
  }
  if (value === null || value === undefined) return { value, redacted: false };
  if (typeof value === "string") {
    const r = redact(value);
    return { value: r.text, redacted: r.redacted };
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { value, redacted: false };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let hit = false;
    for (const el of value) {
      const r = redactJson(el, depth + 1);
      out.push(r.value);
      if (r.redacted) hit = true;
    }
    return { value: out, redacted: hit };
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let hit = false;
    for (const k of Object.keys(obj)) {
      const r = redactJson(obj[k], depth + 1);
      out[k] = r.value;
      if (r.redacted) hit = true;
    }
    return { value: out, redacted: hit };
  }
  return { value: String(value), redacted: false };
}

/** Test seam — exposes the internals the unit test corpus needs. */
export const __test = {
  DEFAULT_PATTERNS,
  computeMaxPatternLen,
  padToLen,
};
