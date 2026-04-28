import type { SecretCategory } from "./secret.ts";

interface RedactionPattern {
  category: SecretCategory;
  re: RegExp;
}

const PATTERNS: RedactionPattern[] = [
  { category: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { category: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { category: "slack-token", re: /\b(?:xoxb|xoxp|xoxa|xoxr|xoxe)-[0-9A-Za-z-]{10,}/g },
  {
    category: "pem-private-key",
    re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
  },
];

export interface RedactionResult {
  text: string;
  spans: { category: SecretCategory; replaced: number }[];
}

// Mirror lib/secret.ts thresholds so anything the scanner flags as
// high-entropy is also redacted by the same path.
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{40,}/g;
const HEX_RE = /^[0-9a-fA-F]+$/;
const ENTROPY_THRESHOLD = 4.5;
const HEX_ENTROPY_THRESHOLD = 3.2;

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  const n = s.length;
  let h = 0;
  for (const v of counts.values()) {
    const p = v / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redactSecrets(text: string): RedactionResult {
  const spans: { category: SecretCategory; replaced: number }[] = [];
  let out = text;
  for (const { category, re } of PATTERNS) {
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return `<<REDACTED:${category}>>`;
    });
    if (count > 0) spans.push({ category, replaced: count });
  }
  let entropyCount = 0;
  out = out.replace(ENTROPY_TOKEN_RE, tok => {
    const threshold = HEX_RE.test(tok) ? HEX_ENTROPY_THRESHOLD : ENTROPY_THRESHOLD;
    if (shannon(tok) > threshold) {
      entropyCount++;
      return "<<REDACTED:high-entropy>>";
    }
    return tok;
  });
  if (entropyCount > 0) spans.push({ category: "high-entropy", replaced: entropyCount });
  return { text: out, spans };
}
