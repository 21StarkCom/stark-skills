/**
 * stark-jury mechanical rule verifier.
 *
 * Pure: no I/O, no network, no clock, no randomness. The rule table is
 * exported data — adding a rule or a skill is a table row.
 *
 * The verifier checks RULES and MEMBERSHIP, never MEANING. A candidate that
 * reattaches a number to the wrong claim passes here; catching that is the
 * anchored merge's job, watched by the author.
 */

export type SkillId = "voice" | "story-edit" | "blog-sharpen" | "story-judge";

export const SKILL_IDS: readonly SkillId[] = [
  "voice",
  "story-edit",
  "blog-sharpen",
  "story-judge",
];

export type Severity = "disqualify" | "warning";
export type Verdict = "CLEAN" | "DISQUALIFIED";

/** What a rule's `check` returns; `verify` stamps the rule id + severity on. */
export interface Finding {
  message: string;
  evidence?: string;
}

export interface Violation extends Finding {
  rule: string;
  severity: Severity;
}

export interface VerifyResult {
  verdict: Verdict;
  violations: Violation[];
}

export interface RuleContext {
  skillId: SkillId;
  /** Raw source, fences included. Membership lookups use this (permissive). */
  source: string;
  /** Raw candidate, fences included. */
  candidate: string;
  /** Source with fenced code blocks removed. */
  sourceBody: string;
  /** Candidate with fenced code blocks removed. Scanning rules use this. */
  candidateBody: string;
}

export interface Rule {
  readonly id: string;
  readonly appliesTo: readonly SkillId[];
  readonly severity: Severity;
  readonly description: string;
  readonly check: (ctx: RuleContext) => Finding[];
}

export const EM_DASH = "—";
export const EN_DASH = "–";

/** Word n-gram size and the containment floor for the no-new-paragraphs rule. */
export const NGRAM_SIZE = 3;
export const NGRAM_CONTAINMENT_THRESHOLD = 0.5;

/**
 * Seeded from stark-blog-sharpen's Thesaurus-prose row, plus tapestry and
 * "it's worth noting". Warning-severity: a tell is a smell, not a breach.
 */
export const AI_TELLS: readonly string[] = [
  "utilize",
  "leverage",
  "myriad",
  "plethora",
  "delve",
  "robust",
  "seamless",
  "tapestry",
  "it's worth noting",
];

/** stark-story-judge's scorecard contract, pinned from the skill's own text. */
export const JUDGE_DIMENSIONS: readonly string[] = [
  "Hook",
  "One idea",
  "Pull",
  "Voice",
  "Fluency",
  "Honesty",
  "Landing",
];
export const JUDGE_MAX_SCORE = 3;
export const JUDGE_VERDICTS: readonly string[] = [
  "PUBLISH",
  "PUBLISH AFTER FIXES",
  "REWRITE",
  "NO STORY YET",
];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Blank out fenced code blocks (``` or ~~~, 3+ markers, closed by the same
 * char at >= the opening length). Lines are replaced rather than deleted so
 * paragraph boundaries survive. An unterminated fence swallows the remainder,
 * which is what a markdown renderer does too.
 */
export function stripCodeFences(text: string): string {
  const out: string[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open === null) {
      if (m) {
        open = { char: m[1][0], len: m[1].length };
        out.push("");
        continue;
      }
      out.push(line);
      continue;
    }
    if (m && m[1][0] === open.char && m[1].length >= open.len) open = null;
    out.push("");
  }
  return out.join("\n");
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function countWords(text: string): number {
  return words(text).length;
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function ngrams(ws: string[], n: number): string[] {
  if (ws.length === 0) return [];
  const size = Math.min(n, ws.length);
  const out: string[] = [];
  for (let i = 0; i + size <= ws.length; i++) out.push(ws.slice(i, i + size).join(" "));
  return out;
}

/** Fraction of the candidate's n-grams that also occur in `srcGrams`. */
export function ngramContainment(
  candidate: string,
  source: string,
  n: number = NGRAM_SIZE,
): number {
  const cand = ngrams(words(candidate), n);
  if (cand.length === 0) return 1;
  const size = Math.min(n, words(candidate).length);
  const src = new Set(ngrams(words(source), size));
  let hit = 0;
  for (const g of cand) if (src.has(g)) hit++;
  return hit / cand.length;
}

interface Span {
  start: number;
  end: number;
  text: string;
}

/** Double-quoted spans, straight and curly, in document order. */
export function quotedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const re of [/"([^"]*)"/g, /“([^”]*)”/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function excerpt(text: string, index: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return normalizeWhitespace(text.slice(start, end));
}

// ---------------------------------------------------------------------------
// Number tokens
// ---------------------------------------------------------------------------

export type UnitClass = "currency" | "percent" | "bare";

export interface NumberToken {
  raw: string;
  /** Comma-free, trailing-zero-free decimal string. */
  value: string;
  unit: UnitClass;
}

const NUMBER_RE = /([$€£₪])?[ \t]?(\d+(?:,\d+)*(?:\.\d+)?)[ \t]?(%)?/g;

function normalizeNumeric(raw: string): string {
  let v = raw.replace(/,/g, "");
  if (v.includes(".")) v = v.replace(/0+$/, "").replace(/\.$/, "");
  return v;
}

export function extractNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  const re = new RegExp(NUMBER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const unit: UnitClass = m[1] ? "currency" : m[3] ? "percent" : "bare";
    out.push({ raw: m[0].trim(), value: normalizeNumeric(m[2]), unit });
  }
  return out;
}

/** Same value, and the unit classes agree — a bare number matches any class. */
export function numberMatches(a: NumberToken, b: NumberToken): boolean {
  if (a.value !== b.value) return false;
  return a.unit === b.unit || a.unit === "bare" || b.unit === "bare";
}

/** Blank markdown ordered-list markers (`1.` / `2)` at line start) so a
 *  bullets-to-numbers restructure is a formatting change, never an invented
 *  number. Applied to BOTH sides so membership stays symmetric. */
export function blankListMarkers(text: string): string {
  return text.replace(/^(\s{0,3})\d{1,3}[.)](\s)/gm, "$1 $2");
}

function numbersMissingFrom(candidateBody: string, source: string): NumberToken[] {
  return numbersMissingFromBlanked(
    blankListMarkers(candidateBody),
    blankListMarkers(source),
  );
}

function numbersMissingFromBlanked(candidateBody: string, source: string): NumberToken[] {
  const src = extractNumbers(source);
  const missing: NumberToken[] = [];
  const seen = new Set<string>();
  for (const tok of extractNumbers(candidateBody)) {
    if (src.some((s) => numberMatches(tok, s))) continue;
    const key = `${tok.value}|${tok.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(tok);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Scorecard parsing (stark-story-judge calibration mode)
// ---------------------------------------------------------------------------

export interface ScorecardRow {
  dimension: string;
  score: number | null;
  quote: string | null;
  line: string;
}

export interface Scorecard {
  rows: ScorecardRow[];
  statedTotal: number | null;
  verdict: string | null;
}

const dimensionRowCache = new Map<string, RegExp>();

function dimensionRowRe(dim: string): RegExp {
  let re = dimensionRowCache.get(dim);
  if (re === undefined) {
    const words = dim
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    re = new RegExp(`^${words}\\s*[:\\-–—]`, "i");
    dimensionRowCache.set(dim, re);
  }
  return re;
}

function stripRowMarkers(line: string): string {
  return line
    .replace(/[*_`>#|]/g, " ")
    .replace(/^\s*(?:\d+[.)])?\s*[-+•]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTotal(lines: string[]): number | null {
  for (const line of lines) {
    const slash = /(\d+)\s*\/\s*21\b/.exec(line);
    if (slash) return Number(slash[1]);
  }
  for (const line of lines) {
    if (!/total/i.test(line)) continue;
    const cleaned = line.replace(/out\s+of\s+21/gi, " ");
    const n = /total[^0-9]*(\d+)/i.exec(cleaned);
    if (n) return Number(n[1]);
  }
  return null;
}

function parseVerdict(text: string): string | null {
  // Case-SENSITIVE: the judge contract emits verdicts in uppercase, and
  // matching against an uppercased body read incidental prose ("not ready to
  // publish yet") as a verdict, so the missing-verdict disqualification never
  // fired.
  let best: { index: number; verdict: string } | null = null;
  for (const v of JUDGE_VERDICTS) {
    const i = text.indexOf(v);
    if (i === -1) continue;
    if (
      best === null ||
      i < best.index ||
      (i === best.index && v.length > best.verdict.length)
    ) {
      best = { index: i, verdict: v };
    }
  }
  return best === null ? null : best.verdict;
}

/**
 * Tolerant, line-based scorecard reader: the judge prompt pins the row
 * CONTENT (dimension, score, quote) but not a machine format, so a row is any
 * line whose text — after list/table/emphasis markers — starts with a
 * dimension name. First match per dimension wins; later mentions (fix lists,
 * a pasted rubric) are not rows.
 */
export function parseScorecard(text: string): Scorecard {
  const body = stripCodeFences(text);
  const lines = body.split("\n");
  const rows: ScorecardRow[] = [];
  const claimed = new Set<string>();

  for (const line of lines) {
    const flat = stripRowMarkers(line);
    if (flat.length === 0) continue;
    // A row is the dimension name followed by a separator (colon, dash, en/em
    // dash). Bare startsWith let a prose line ("Hook and landing are weak")
    // or a prefix collision ("Hooks") steal the dimension, discarding the
    // real scored row below it.
    const dim = JUDGE_DIMENSIONS.find(
      (d) => !claimed.has(d) && dimensionRowRe(d).test(flat),
    );
    if (dim === undefined) continue;
    claimed.add(dim);

    const quotes = quotedSpans(line);
    const quote = quotes.length > 0 ? quotes[0].text : null;
    // Blank the quoted spans before hunting the score: a quote is prose and
    // its digits are the post's, not the judge's.
    let masked = flat;
    for (const span of quotedSpans(flat)) {
      masked =
        masked.slice(0, span.start) +
        " ".repeat(span.end - span.start) +
        masked.slice(span.end);
    }
    const scoreMatch = /(?:^|[^\d])([0-3])(?![\d])/.exec(masked.slice(dim.length));
    rows.push({
      dimension: dim,
      score: scoreMatch ? Number(scoreMatch[1]) : null,
      quote,
      line: line.trim(),
    });
  }

  return { rows, statedTotal: parseTotal(lines), verdict: parseVerdict(body) };
}

// ---------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------

const ALL_SKILLS = SKILL_IDS;

export const RULES: readonly Rule[] = [
  {
    id: "em-dash-zero",
    appliesTo: ALL_SKILLS,
    severity: "disqualify",
    description:
      "No U+2014 in the candidate. Judge mode exempts em-dashes inside a span quoted verbatim from the source.",
    check: (ctx) => {
      const exempt =
        ctx.skillId === "story-judge"
          ? quotedSpans(ctx.candidateBody).filter((s) =>
              normalizeWhitespace(ctx.source).includes(normalizeWhitespace(s.text)),
            )
          : [];
      const findings: Finding[] = [];
      for (let i = ctx.candidateBody.indexOf(EM_DASH); i !== -1; i = ctx.candidateBody.indexOf(EM_DASH, i + 1)) {
        if (exempt.some((s) => i > s.start && i < s.end)) continue;
        findings.push({
          message: "em-dash (U+2014) in the candidate",
          evidence: excerpt(ctx.candidateBody, i),
        });
      }
      return findings;
    },
  },
  {
    id: "en-dash-creep",
    appliesTo: ALL_SKILLS,
    severity: "warning",
    description: "Candidate must not introduce en-dashes (U+2013) beyond the source count.",
    check: (ctx) => {
      const count = (text: string): number => text.split(EN_DASH).length - 1;
      const cand = count(ctx.candidateBody);
      const src = count(ctx.sourceBody);
      if (cand <= src) return [];
      return [
        {
          message: `en-dash count rose from ${src} to ${cand}`,
        },
      ];
    },
  },
  {
    id: "numbers-frozen",
    appliesTo: ["story-edit", "blog-sharpen"],
    severity: "disqualify",
    description:
      "Every number token in the candidate appears in the source. Value AND unit class must agree; a bare number matches any class.",
    check: (ctx) =>
      numbersMissingFrom(ctx.candidateBody, ctx.source).map((tok) => ({
        message: `number "${tok.raw}" (${tok.unit} ${tok.value}) is not in the source`,
        evidence: tok.raw,
      })),
  },
  {
    id: "no-new-paragraphs",
    appliesTo: ["blog-sharpen"],
    severity: "disqualify",
    description:
      "Every candidate paragraph shares n-gram containment with some source paragraph. Cut-only means nothing invented, not merely nothing net-added.",
    check: (ctx) => {
      const src = paragraphs(ctx.sourceBody);
      const findings: Finding[] = [];
      for (const para of paragraphs(ctx.candidateBody)) {
        let best = 0;
        for (const s of src) {
          const c = ngramContainment(para, s);
          if (c > best) best = c;
          if (best >= NGRAM_CONTAINMENT_THRESHOLD) break;
        }
        if (best >= NGRAM_CONTAINMENT_THRESHOLD) continue;
        findings.push({
          message: `paragraph has no source anchor (best ${NGRAM_SIZE}-gram containment ${best.toFixed(2)} < ${NGRAM_CONTAINMENT_THRESHOLD})`,
          evidence: normalizeWhitespace(para).slice(0, 120),
        });
      }
      return findings;
    },
  },
  {
    id: "cut-only",
    appliesTo: ["blog-sharpen"],
    severity: "disqualify",
    description: "Candidate word count must not exceed the source word count.",
    check: (ctx) => {
      const cand = countWords(ctx.candidateBody);
      const src = countWords(ctx.sourceBody);
      if (cand <= src) return [];
      return [{ message: `word count grew from ${src} to ${cand}` }];
    },
  },
  {
    id: "no-new-numbers",
    appliesTo: ["voice"],
    severity: "warning",
    description:
      "Number tokens absent from the brief. A brief may legitimately request a number, so the session decides.",
    check: (ctx) =>
      numbersMissingFrom(ctx.candidateBody, ctx.source).map((tok) => ({
        message: `number "${tok.raw}" is not in the brief`,
        evidence: tok.raw,
      })),
  },
  {
    id: "quote-anchoring",
    appliesTo: ["story-judge"],
    severity: "disqualify",
    description:
      "Every dimension row carries a quoted span appearing verbatim (whitespace-normalized) in the source.",
    check: (ctx) => {
      const haystack = normalizeWhitespace(ctx.source);
      const findings: Finding[] = [];
      for (const row of parseScorecard(ctx.candidate).rows) {
        if (row.quote === null || normalizeWhitespace(row.quote).length === 0) {
          findings.push({
            message: `dimension "${row.dimension}" carries no quoted span`,
            evidence: row.line,
          });
          continue;
        }
        if (haystack.includes(normalizeWhitespace(row.quote))) continue;
        findings.push({
          message: `dimension "${row.dimension}" quotes a span absent from the source`,
          evidence: row.quote,
        });
      }
      return findings;
    },
  },
  {
    id: "scorecard-shape",
    appliesTo: ["story-judge"],
    severity: "disqualify",
    description:
      "Seven dimensions each scored 0-3, a stated total equal to the recomputed sum, and a verdict from the enum.",
    check: (ctx) => {
      const card = parseScorecard(ctx.candidate);
      const findings: Finding[] = [];
      const byDim = new Map(card.rows.map((r) => [r.dimension, r]));

      for (const dim of JUDGE_DIMENSIONS) {
        const row = byDim.get(dim);
        if (row === undefined) {
          findings.push({ message: `missing dimension row: "${dim}"` });
          continue;
        }
        if (row.score === null) {
          findings.push({
            message: `dimension "${dim}" has no readable 0-${JUDGE_MAX_SCORE} score`,
            evidence: row.line,
          });
          continue;
        }
        if (row.score < 0 || row.score > JUDGE_MAX_SCORE) {
          findings.push({
            message: `dimension "${dim}" scored ${row.score}, outside 0-${JUDGE_MAX_SCORE}`,
            evidence: row.line,
          });
        }
      }

      const scores = JUDGE_DIMENSIONS.map((d) => byDim.get(d)?.score ?? null);
      if (scores.every((s) => s !== null)) {
        const sum = (scores as number[]).reduce((a, b) => a + b, 0);
        if (card.statedTotal === null) {
          findings.push({ message: `no stated total (recomputed sum is ${sum})` });
        } else if (card.statedTotal !== sum) {
          findings.push({
            message: `stated total ${card.statedTotal} does not equal the recomputed sum ${sum}`,
          });
        }
      } else if (card.statedTotal === null) {
        findings.push({ message: "no stated total" });
      }

      if (card.verdict === null) {
        findings.push({
          message: `no verdict from the enum {${JUDGE_VERDICTS.join(", ")}}`,
        });
      }
      return findings;
    },
  },
  {
    id: "ai-tell-lexicon",
    appliesTo: ["voice", "blog-sharpen"],
    severity: "warning",
    description: "Hits from the AI-tell lexicon.",
    check: (ctx) => {
      const hay = ctx.candidateBody.replace(/’/g, "'");
      const findings: Finding[] = [];
      for (const tell of AI_TELLS) {
        const re = new RegExp(`\\b${tell.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
        const hits = hay.match(re);
        if (hits === null) continue;
        findings.push({
          message: `AI-tell "${tell}" appears ${hits.length}×`,
          evidence: hits[0],
        });
      }
      return findings;
    },
  },
];

export function rulesFor(skillId: SkillId): Rule[] {
  return RULES.filter((r) => r.appliesTo.includes(skillId));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate the rule table for one candidate.
 *
 * Fenced code blocks are exempt from every rule, so scanning runs against the
 * fence-stripped candidate. Membership lookups (does this number / quote exist
 * in the source?) run against the RAW source deliberately: being permissive on
 * the source side cannot manufacture a false disqualification.
 */
export function verify(
  skillId: SkillId,
  source: string,
  candidate: string,
): VerifyResult {
  if (!SKILL_IDS.includes(skillId)) {
    throw new Error(
      `jury_verify: unknown skill id "${skillId}" (expected one of ${SKILL_IDS.join(", ")})`,
    );
  }
  const ctx: RuleContext = {
    skillId,
    source,
    candidate,
    sourceBody: stripCodeFences(source),
    candidateBody: stripCodeFences(candidate),
  };

  const violations: Violation[] = [];
  for (const rule of rulesFor(skillId)) {
    for (const finding of rule.check(ctx)) {
      violations.push({ ...finding, rule: rule.id, severity: rule.severity });
    }
  }

  const verdict: Verdict = violations.some((v) => v.severity === "disqualify")
    ? "DISQUALIFIED"
    : "CLEAN";
  return { verdict, violations };
}
