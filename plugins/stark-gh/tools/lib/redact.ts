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
  return { text: out, spans };
}
