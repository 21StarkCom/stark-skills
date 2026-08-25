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

// A scan input segment. `text` is scanned line by line; an optional `path`
// seeds the file context (e.g. an untracked file's own path) so a bare file
// body with no diff header is still recognized as a lockfile. A plain string
// input is treated as one path-less segment — identical to prior behavior.
// Callers that concatenate DIFFS and PROSE into one scan pass segments so a
// lockfile's entropy exemption cannot leak past the diff into a commit message
// or PR body (each segment resets the file context).
export interface ScanSegment {
  text: string;
  path?: string;
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

// Dependency lockfiles / checksum manifests. Every line is a base64/hex CONTENT
// hash: legitimately high-entropy, but public and required — never a secret. A
// go.sum change alone flags 100+ lines (frigg PR #13: 188 hits, zero real
// secrets), which trains `--allow-secret-commit` as a reflex and would wave a
// real secret in the same diff straight through. So the ENTROPY detector is
// skipped inside a lockfile's diff hunk. The regex/token detectors
// (AWS/GitHub/Slack/PEM) still run, so a pasted credential in a lockfile flags.
const LOCKFILE_BASENAMES = new Set([
  "go.sum",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "Podfile.lock",
  "packages.lock.json",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Package.resolved",
]);
// Gradle emits `<config>.lockfile`; keep this a suffix rule, the rest exact.
const LOCKFILE_SUFFIX_RE = /\.lockfile$/;

function isLockfilePath(p: string | null): boolean {
  if (!p) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return LOCKFILE_BASENAMES.has(base) || LOCKFILE_SUFFIX_RE.test(base);
}

// git-diff structure markers used to track which file a line belongs to.
// `diff --git a/X b/Y` opens a new file block and resets context. The pre-image
// (`--- a/<path>`) and post-image (`+++ b/<path>`) path lines set the current
// file; `/dev/null` on either side is ignored so a file ADD keeps the post-image
// path and a file DELETE keeps the pre-image path (its removed `-` lines are
// still lockfile content). Tracking stops the exemption at the next file, so a
// secret in the file after a lockfile hunk is still scanned.
const DIFF_HEADER_RE = /^diff --git /;
const DIFF_PREIMAGE_RE = /^--- (?:a\/)?(.+?)\s*$/;
const DIFF_POSTIMAGE_RE = /^\+\+\+ (?:b\/)?(.+?)\s*$/;

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

export function scanSecrets(input: string | ScanSegment[]): SecretHit[] {
  // A plain string is one path-less segment. Segments joined by "\n" reproduce
  // the old whole-blob line numbering exactly (base += lines.length), so string
  // callers and their reported line numbers are unchanged.
  const segments: ScanSegment[] = typeof input === "string" ? [{ text: input }] : input;
  const hits: SecretHit[] = [];
  let lineBase = 0;
  for (const seg of segments) {
    // File context resets per segment, so a lockfile exemption cannot leak from
    // a diff segment into a following prose segment (commit message, PR body).
    let currentFile: string | null = seg.path ?? null;
    const lines = seg.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (DIFF_HEADER_RE.test(line)) {
        currentFile = null;
      } else {
        // Pre-image first (`--- a/x`), then post-image (`+++ b/x`) which wins
        // for a modify/rename; `/dev/null` on either side is left as-is so a
        // delete keeps its pre-image path and an add keeps its post-image path.
        const pre = DIFF_PREIMAGE_RE.exec(line);
        if (pre && pre[1] !== "/dev/null") currentFile = pre[1]!;
        const post = DIFF_POSTIMAGE_RE.exec(line);
        if (post && post[1] !== "/dev/null") currentFile = post[1]!;
      }
      const lineNumber = lineBase + i + 1;
      // Regex/token detectors run everywhere — a pasted credential flags even
      // inside a lockfile.
      for (const { category, re } of REGEX_PATTERNS) {
        if (re.test(line)) hits.push({ category, lineNumber });
      }
      // Entropy detector is skipped inside lockfiles: their content hashes are
      // legitimately high-entropy but public, never secrets (STARK-1323).
      if (isLockfilePath(currentFile)) continue;
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
          hits.push({ category: "high-entropy", lineNumber });
        }
      }
    }
    lineBase += lines.length;
  }
  return hits;
}
