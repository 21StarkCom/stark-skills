export type SecretCategory =
  | "aws-access-key"
  | "github-token"
  | "slack-token"
  | "pem-private-key"
  | "high-entropy";

export interface SecretHit {
  category: SecretCategory;
  lineNumber: number;
}

const REGEX_PATTERNS: { category: SecretCategory; re: RegExp }[] = [
  { category: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { category: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { category: "slack-token", re: /\b(xoxb|xoxp|xoxa|xoxr|xoxe)-[0-9A-Za-z-]{10,}/ },
  { category: "pem-private-key", re: /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/ },
];

const ENTROPY_MIN_LENGTH = 40;
const ENTROPY_THRESHOLD = 4.5;
const HEX_ENTROPY_THRESHOLD = 3.2;
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{40,}/g;
const HEX_RE = /^[0-9a-fA-F]+$/;

function shannonEntropy(s: string): number {
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

export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { category, re } of REGEX_PATTERNS) {
      if (re.test(line)) hits.push({ category, lineNumber: i + 1 });
    }
    for (const m of line.matchAll(ENTROPY_TOKEN_RE)) {
      const tok = m[0];
      if (tok.length < ENTROPY_MIN_LENGTH) continue;
      const threshold = HEX_RE.test(tok) ? HEX_ENTROPY_THRESHOLD : ENTROPY_THRESHOLD;
      if (shannonEntropy(tok) > threshold) {
        hits.push({ category: "high-entropy", lineNumber: i + 1 });
      }
    }
  }
  return hits;
}
