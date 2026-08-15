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

// A long, descriptive camelCase / snake_case identifier is entropy-dense: an
// English mixed-case name like `TestPullDefaultedDomainForbiddenSkipsWithoutTombstoning`
// scores ~4.57, over the 4.5 base threshold, and false-flags as a secret — which
// pushes authors to shorten the very names that keep code unambiguous. But a
// word-structured identifier is CODE, not credential material: random secrets
// never decompose into pronounceable words. `isWordStructuredIdentifier` exempts
// a token only when it segments (camelCase / underscore / digit boundaries) into
// ≥3 vowel-bearing alphabetic words. It is deliberately narrow and safe against
// the accidental-commit threat this scanner exists for:
//   - it NEVER applies to a base64-shaped token (any of `+ / =`), so a real 40+-char
//     secret on either side of that charset still flags;
//   - a random `[A-Za-z0-9]` blob segments into short consonant clusters that fail
//     the ≥70%-vowel-word bar (verified: base64/base62/hex secrets stay flagged);
//   - the dedicated AWS/GitHub/Slack/PEM regexes are independent of it.
// Secrets are generated random, never crafted to read as English, so "looks like
// camelCase words" cannot be an evasion vector for the leak this guards.
const IDENT_CHARSET_RE = /^[A-Za-z0-9_]+$/;
const VOWEL_RE = /[aeiou]/i;

function isWordStructuredIdentifier(tok: string): boolean {
  const bare = tok.replace(/^[+-]/, ""); // drop a leading diff marker
  if (/[+/=]/.test(bare)) return false; // base64 alphabet/padding → never exempt
  if (!IDENT_CHARSET_RE.test(bare)) return false; // identifier charset only
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .replace(/([A-Za-z])([0-9])/g, "$1 $2") // letter→digit
    .replace(/([0-9])([A-Za-z])/g, "$1 $2") // digit→letter
    .split(/[_\s]+/)
    .filter((s) => /^[A-Za-z]{3,}$/.test(s)); // ≥3-char alphabetic segments
  if (words.length < 3) return false;
  const vowelBearing = words.filter((w) => VOWEL_RE.test(w)).length;
  return vowelBearing / words.length >= 0.7;
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
      // A word-structured identifier is code, not a secret — exempt it. For an
      // assignment, exempt only when BOTH sides are word-structured, so a real
      // secret on either side of the `=` still flags.
      const flagged = assignment
        ? (exceedsEntropyThreshold(assignment[1]!) || exceedsEntropyThreshold(assignment[2]!)) &&
          !(isWordStructuredIdentifier(assignment[1]!) && isWordStructuredIdentifier(assignment[2]!))
        : exceedsEntropyThreshold(tok) && !isWordStructuredIdentifier(tok);
      if (flagged) {
        hits.push({ category: "high-entropy", lineNumber: i + 1 });
      }
    }
  }
  return hits;
}
