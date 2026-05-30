/**
 * Audit-text retention policy for red-team findings (FU-rt6).
 *
 * TS port of `scripts/red_team_audit_text.py`. Pure functions — no I/O,
 * no SQLite, no subprocess. Used by:
 *   - `tools/red_team_lib.ts::buildFindingPayload` so insights events
 *     honor `red_team.audit.retain_full_text` instead of hard-coding
 *     `retention_mode: "full"`.
 *   - `tools/red_team_audit_lib.ts::recordFindings` so audit rows match.
 *
 * Excerpt mode (the default) stores a short redacted excerpt plus a
 * SHA-256 of the original text. The hash is the link between a redacted
 * row and a finding the operator may also see in a sidecar / PR comment.
 */

import { createHash } from "node:crypto";

const DEFAULT_EXCERPT_MAX_CHARS = 240;
const TRUNCATION_MARKER = "…";

// Secret + PII redaction patterns. Keep in lockstep with
// `tools/red_team_lib.ts::REDACTION_RULES`
// — divergence is what the parity test catches.
const REDACTION_RULES: ReadonlyArray<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]"],
  [/ghp_[A-Za-z0-9]{10,}/g, "ghp_[REDACTED]"],
  [/ghs_[A-Za-z0-9]{10,}/g, "ghs_[REDACTED]"],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[EMAIL-REDACTED]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP-REDACTED]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN-REDACTED]"],
  [/\b\d{4}[ \-]?\d{4}[ \-]?\d{4}[ \-]?\d{4}\b/g, "[CC-REDACTED]"],
  [/\b(?:\(?\d{3}\)?[ \-.]?)\d{3}[ \-.]?\d{4}\b/g, "[PHONE-REDACTED]"],
  [/[A-Za-z0-9+/]{41,}={0,2}/g, "[BASE64-REDACTED]"],
];

/** Run the secret + PII regex set over `text`. Idempotent. */
export function redactAuditText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export interface AuditRetentionPolicy {
  readonly retainFullText: boolean;
  readonly excerptMaxChars: number;
}

export type RetentionMode = "full" | "excerpt";

export function policyMode(policy: AuditRetentionPolicy): RetentionMode {
  return policy.retainFullText ? "full" : "excerpt";
}

export interface RetainedText {
  readonly stored: string | null;
  readonly hash: string | null;
}

/** Build a policy from the `red_team.audit` config sub-dict. Missing
 *  config falls back to excerpt mode — the secure default. Only an
 *  explicit `retain_full_text: true` opens full-text retention. */
export function policyFromConfig(
  cfgAudit: Record<string, unknown> | null | undefined,
): AuditRetentionPolicy {
  const cfg = cfgAudit ?? {};
  const retainRaw = cfg["retain_full_text"];
  const excerptRaw = cfg["excerpt_max_chars"];
  // Match Python `int(cfg_audit.get("excerpt_max_chars", DEFAULT))` —
  // any finite numeric value flows through (including negatives, which
  // `excerpt()` collapses to ""). Non-numeric / NaN / Infinity / missing
  // fall back to the documented default. Clamping was a parity drift
  // caught in #551 self-review.
  return {
    retainFullText: retainRaw === true,
    excerptMaxChars:
      typeof excerptRaw === "number" && Number.isFinite(excerptRaw)
        ? Math.trunc(excerptRaw)
        : DEFAULT_EXCERPT_MAX_CHARS,
  };
}

/** SHA-256 hex of `text`, or `null` for empty values. Content-only —
 *  no per-finding salt — so two findings with identical text hash to the
 *  same value (the point: operators can match recurrences by hash without
 *  re-disclosing the underlying prose). */
export function hashText(text: string | null | undefined): string | null {
  if (!text) return null;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Truncate to `maxChars` with a single-character ellipsis suffix.
 *  Matches Python `_excerpt` byte-for-byte, including the
 *  `maxChars <= len(marker)` degenerate-case branch. */
export function excerpt(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Apply the retention policy to one free-text field.
 *  - `null` / empty → `{stored: null, hash: null}` (preserves SQL NULL).
 *  - Full-text mode → `stored` is the redacted original; `hash` is null.
 *  - Excerpt mode → `stored` is a redacted excerpt; `hash` is SHA-256 of
 *    the **original** (pre-redaction, pre-truncation) text so two reruns
 *    of the same finding still hash-match. */
export function applyToField(
  text: string | null | undefined,
  policy: AuditRetentionPolicy,
): RetainedText {
  if (!text) return { stored: null, hash: null };
  if (policy.retainFullText) {
    return { stored: redactAuditText(text), hash: null };
  }
  const redacted = redactAuditText(text);
  return {
    stored: excerpt(redacted, policy.excerptMaxChars),
    hash: hashText(text),
  };
}
