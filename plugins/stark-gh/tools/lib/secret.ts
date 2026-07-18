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
// NAME=value assignment shape. `=` sits in the token charset for base64
// padding, so an env-assignment run fuses the variable name and its value
// into ONE token whose combined character spread can cross the entropy
// threshold even when both sides are innocent (e.g. a documented
// `ATLAS_EGRESS_CAPABILITY_KEY=/usr/local/etc/atlas/...` line). Score the
// two sides independently instead — a real 40+-char secret on either side
// of the `=` still flags on its own.
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

function exceedsEntropyThreshold(tok: string): boolean {
  if (tok.length < ENTROPY_MIN_LENGTH) return false;
  const threshold = HEX_RE.test(tok) ? HEX_ENTROPY_THRESHOLD : ENTROPY_THRESHOLD;
  return shannonEntropy(tok) > threshold;
}

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
      // In raw `git diff` text the +/- marker abuts column-0 content and both
      // chars sit in the token charset, so a `.env`-style `+NAME=value` line
      // fuses the marker into the token. Drop ONE leading marker before the
      // assignment probe; a non-assignment token is still scored whole.
      const assignment = ASSIGNMENT_RE.exec(tok.replace(/^[+-]/, ""));
      const flagged = assignment
        ? exceedsEntropyThreshold(assignment[1]!) || exceedsEntropyThreshold(assignment[2]!)
        : exceedsEntropyThreshold(tok);
      if (flagged) {
        hits.push({ category: "high-entropy", lineNumber: i + 1 });
      }
    }
  }
  return hits;
}
