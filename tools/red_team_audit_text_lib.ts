/**
 * FU-rt6 retention policy for red-team audit text fields.
 *
 * `applyToField` decides, per field, whether to store the full model text or
 * a redacted excerpt. Used by:
 *   - `tools/red_team_lib.ts::buildFindingPayload` so audit-finding rows
 *     carry only the policy-permitted text.
 *   - `tools/red_team_audit_lib.ts` audit-row inserts.
 */
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
