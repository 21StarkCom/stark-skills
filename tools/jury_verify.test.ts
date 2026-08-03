import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_TELLS,
  JUDGE_DIMENSIONS,
  RULES,
  SKILL_IDS,
  countWords,
  extractNumbers,
  numberMatches,
  parseScorecard,
  rulesFor,
  stripCodeFences,
  verify,
  type SkillId,
  type VerifyResult,
} from "./jury_verify.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ruleIds = (r: VerifyResult): string[] => r.violations.map((v) => v.rule);

const only = (r: VerifyResult, rule: string): void => {
  assert.deepEqual(
    ruleIds(r),
    [rule],
    `expected exactly one ${rule} violation, got ${JSON.stringify(r.violations, null, 2)}`,
  );
};

const clean = (r: VerifyResult): void => {
  assert.equal(
    r.verdict,
    "CLEAN",
    `expected CLEAN, got ${JSON.stringify(r.violations, null, 2)}`,
  );
};

// ---------------------------------------------------------------------------
// rule-table integrity
// ---------------------------------------------------------------------------

test("rule ids are unique and every appliesTo entry is a real skill id", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
  for (const rule of RULES) {
    assert.ok(rule.appliesTo.length > 0, `${rule.id} applies to nothing`);
    for (const skill of rule.appliesTo) {
      assert.ok(SKILL_IDS.includes(skill), `${rule.id} names unknown skill ${skill}`);
    }
  }
});

test("the exported table matches the spec's Applies-to column", () => {
  const expected: Record<SkillId, string[]> = {
    voice: ["em-dash-zero", "en-dash-creep", "no-new-numbers", "ai-tell-lexicon"],
    "story-edit": ["em-dash-zero", "en-dash-creep", "numbers-frozen"],
    "blog-sharpen": [
      "em-dash-zero",
      "en-dash-creep",
      "numbers-frozen",
      "no-new-paragraphs",
      "cut-only",
      "ai-tell-lexicon",
    ],
    "story-judge": [
      "em-dash-zero",
      "en-dash-creep",
      "quote-anchoring",
      "scorecard-shape",
    ],
  };
  for (const skill of SKILL_IDS) {
    assert.deepEqual(
      rulesFor(skill).map((r) => r.id).sort(),
      expected[skill].slice().sort(),
      `rules for ${skill}`,
    );
  }
});

test("an unknown skill id throws rather than silently passing everything", () => {
  assert.throws(
    () => verify("blog-shrpen" as SkillId, "a", "a"),
    /unknown skill id/,
  );
});

// ---------------------------------------------------------------------------
// em-dash zero
// ---------------------------------------------------------------------------

test("em-dash hit disqualifies a rewrite candidate", () => {
  const source = "The rollback plan was a wiki page nobody had read.";
  const candidate = "The rollback plan — a wiki page nobody had read.";
  const result = verify("story-edit", source, candidate);
  assert.equal(result.verdict, "DISQUALIFIED");
  only(result, "em-dash-zero");
  assert.match(result.violations[0].evidence ?? "", /rollback plan/);
});

test("one violation per em-dash, so the report names each one", () => {
  const result = verify("story-edit", "plain source text", "a — b — c");
  assert.equal(ruleIds(result).length, 2);
});

test("an em-dash inside a fenced code block is exempt", () => {
  const source = "The rollback plan was a wiki page nobody had read.";
  const candidate = [
    "The rollback plan was a wiki page nobody had read.",
    "",
    "```sh",
    "grep -n '—' post.md",
    "```",
  ].join("\n");
  clean(verify("story-edit", source, candidate));
});

// ---------------------------------------------------------------------------
// judge fixtures
// ---------------------------------------------------------------------------

const JUDGE_SOURCE = [
  "# The midnight rollback",
  "",
  "We shipped the migration at midnight and it broke.",
  "",
  "Nobody wanted to say it out loud - the rollback",
  "plan was a wiki page.",
  "",
  "The pager stayed quiet — the alert had been muted in March.",
  "",
  "The fix cost us $1,013 in credits and a week of trust.",
].join("\n");

interface Row {
  dim: string;
  score: number;
  quote: string | null;
  why: string;
}

const BASE_ROWS: Row[] = [
  {
    dim: "Hook",
    score: 3,
    quote: "We shipped the migration at midnight and it broke.",
    why: "the stake is up front",
  },
  {
    dim: "One idea",
    score: 2,
    quote: "the rollback plan was a wiki page",
    why: "a real mechanism",
  },
  {
    dim: "Pull",
    score: 2,
    quote: "Nobody wanted to say it out loud",
    why: "held to the end",
  },
  {
    dim: "Voice",
    score: 3,
    quote: "the alert had been muted in March",
    why: "a person is audible",
  },
  {
    dim: "Fluency",
    score: 3,
    quote: "The fix cost us $1,013 in credits",
    why: "clean",
  },
  { dim: "Honesty", score: 2, quote: "a week of trust", why: "carried by specifics" },
  {
    dim: "Landing",
    score: 2,
    quote: "The fix cost us $1,013 in credits and a week of trust.",
    why: "the lesson lands",
  },
];

const BASE_SUM = BASE_ROWS.reduce((a, r) => a + r.score, 0);

function scorecard(
  rows: Row[] = BASE_ROWS,
  opts: { total?: number | null; verdict?: string | null } = {},
): string {
  const total =
    opts.total === undefined ? rows.reduce((a, r) => a + r.score, 0) : opts.total;
  const verdict = opts.verdict === undefined ? "PUBLISH AFTER FIXES" : opts.verdict;
  const head: string[] = [];
  if (verdict !== null) head.push(`VERDICT: ${verdict}`);
  head.push("grade B");
  if (total !== null) head.push(`${total}/21`);
  const lines = [
    head.join(" - "),
    "Takeaway: a rollback nobody rehearsed is not a rollback.",
    "",
  ];
  for (const r of rows) {
    const quoted = r.quote === null ? "" : ` - "${r.quote}"`;
    lines.push(`- ${r.dim} - ${r.score}${quoted} - ${r.why}.`);
  }
  return lines.join("\n");
}

const withRow = (dim: string, patch: Partial<Row>): Row[] =>
  BASE_ROWS.map((r) => (r.dim === dim ? { ...r, ...patch } : r));

test("the base scorecard fixture is CLEAN (guards every other judge case)", () => {
  clean(verify("story-judge", JUDGE_SOURCE, scorecard()));
  assert.equal(BASE_SUM, 17);
});

test("parseScorecard reads seven rows, the stated total and the verdict", () => {
  const card = parseScorecard(scorecard());
  assert.deepEqual(card.rows.map((r) => r.dimension), [...JUDGE_DIMENSIONS]);
  assert.deepEqual(card.rows.map((r) => r.score), [3, 2, 2, 3, 3, 2, 2]);
  assert.equal(card.statedTotal, 17);
  assert.equal(card.verdict, "PUBLISH AFTER FIXES");
});

// ---------------------------------------------------------------------------
// judge-quote em-dash exemption
// ---------------------------------------------------------------------------

test("judge mode exempts an em-dash inside a span quoted from the source", () => {
  const rows = withRow("Hook", {
    quote: "The pager stayed quiet — the alert had been muted in March.",
  });
  const card = scorecard(rows);
  assert.ok(card.includes("—"), "fixture must carry the em-dash");
  clean(verify("story-judge", JUDGE_SOURCE, card));
});

test("judge mode still disqualifies an em-dash outside a quote", () => {
  const rows = withRow("Hook", { why: "the stake is up front — the pager is silent" });
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(rows));
  assert.equal(result.verdict, "DISQUALIFIED");
  assert.ok(ruleIds(result).includes("em-dash-zero"));
});

test("an em-dash in a quote that is NOT in the source is not exempt", () => {
  const rows = withRow("Hook", { quote: "A line — the post never contained." });
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(rows));
  assert.deepEqual(ruleIds(result).sort(), ["em-dash-zero", "quote-anchoring"]);
});

test("the exemption is judge-only: a rewrite skill gets no quote amnesty", () => {
  const source = "The pager stayed quiet — the alert had been muted in March.";
  const candidate = 'He wrote "The pager stayed quiet — the alert had been muted in March."';
  const result = verify("story-edit", source, candidate);
  assert.equal(result.verdict, "DISQUALIFIED");
  assert.ok(ruleIds(result).includes("em-dash-zero"));
});

// ---------------------------------------------------------------------------
// quote anchoring + whitespace normalization
// ---------------------------------------------------------------------------

test("a quote spanning a source line break anchors after whitespace normalization", () => {
  // The source wraps "the rollback / plan was a wiki page" across two lines.
  assert.ok(!JUDGE_SOURCE.includes("the rollback plan was a wiki page"));
  const rows = withRow("Pull", { quote: "the rollback plan was a wiki page" });
  clean(verify("story-judge", JUDGE_SOURCE, scorecard(rows)));
});

test("collapsed inner whitespace in a quote still anchors", () => {
  const rows = withRow("Pull", { quote: "Nobody   wanted to say  it out loud" });
  clean(verify("story-judge", JUDGE_SOURCE, scorecard(rows)));
});

test("a scorecard missing one quote is DISQUALIFIED on quote-anchoring", () => {
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(withRow("Pull", { quote: null })));
  assert.equal(result.verdict, "DISQUALIFIED");
  only(result, "quote-anchoring");
  assert.match(result.violations[0].message, /"Pull" carries no quoted span/);
});

test("a fabricated quote is DISQUALIFIED and the violation names the dimension", () => {
  const rows = withRow("Voice", { quote: "the alert screamed for an hour" });
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(rows));
  only(result, "quote-anchoring");
  assert.match(result.violations[0].message, /"Voice" quotes a span absent/);
});

// ---------------------------------------------------------------------------
// scorecard shape
// ---------------------------------------------------------------------------

test("a stated total that does not equal the sum disqualifies", () => {
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(BASE_ROWS, { total: 18 }));
  assert.equal(result.verdict, "DISQUALIFIED");
  only(result, "scorecard-shape");
  assert.match(result.violations[0].message, /stated total 18 does not equal .* 17/);
});

test("a missing dimension row disqualifies", () => {
  const rows = BASE_ROWS.filter((r) => r.dim !== "Honesty");
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(rows, { total: 15 }));
  assert.equal(result.verdict, "DISQUALIFIED");
  assert.ok(
    result.violations.some((v) => /missing dimension row: "Honesty"/.test(v.message)),
  );
});

test("a score outside 0-3 disqualifies", () => {
  const rows = withRow("Pull", { score: 5 });
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(rows));
  assert.equal(result.verdict, "DISQUALIFIED");
  assert.ok(ruleIds(result).includes("scorecard-shape"));
});

test("no stated total disqualifies", () => {
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(BASE_ROWS, { total: null }));
  only(result, "scorecard-shape");
  assert.match(result.violations[0].message, /no stated total/);
});

test("a verdict outside the enum disqualifies", () => {
  const result = verify("story-judge", JUDGE_SOURCE, scorecard(BASE_ROWS, { verdict: null }));
  only(result, "scorecard-shape");
  assert.match(result.violations[0].message, /no verdict from the enum/);
});

test("the verdict parser prefers PUBLISH AFTER FIXES over the PUBLISH prefix", () => {
  assert.equal(parseScorecard(scorecard()).verdict, "PUBLISH AFTER FIXES");
  assert.equal(
    parseScorecard(scorecard(BASE_ROWS, { verdict: "NO STORY YET" })).verdict,
    "NO STORY YET",
  );
});

// ---------------------------------------------------------------------------
// numbers frozen (value + unit class)
// ---------------------------------------------------------------------------

test("number tokens carry a normalized value and a unit class", () => {
  assert.deepEqual(extractNumbers("we saved $1,013"), [
    { raw: "$1,013", value: "1013", unit: "currency" },
  ]);
  assert.deepEqual(extractNumbers("margin hit 5%"), [
    { raw: "5%", value: "5", unit: "percent" },
  ]);
  assert.deepEqual(extractNumbers("12 rows").map((t) => t.unit), ["bare"]);
  assert.equal(extractNumbers("$1013.00")[0].value, "1013");
});

const numberCases: Array<[string, string, string, boolean]> = [
  ["$1,013 == $1013 (comma normalization, same class)", "We saved $1,013.", "We saved $1013.", true],
  ["$1013 == $1,013 (the other direction)", "We saved $1013.", "We saved $1,013.", true],
  ["$5 != 5% (value equal, unit class differs)", "The fee was $5.", "The fee was 5%.", false],
  ["bare candidate matches a currency source", "The fee was $5.", "The fee was 5 per seat.", true],
  ["bare source matches a currency candidate", "We counted 1013 rows.", "We counted $1013.", true],
  ["a number absent from the source disqualifies", "We saved $1013.", "We saved $1014.", false],
];

for (const [name, source, candidate, expectClean] of numberCases) {
  test(`numbers frozen: ${name}`, () => {
    const result = verify("story-edit", source, candidate);
    if (expectClean) {
      clean(result);
    } else {
      assert.equal(result.verdict, "DISQUALIFIED");
      only(result, "numbers-frozen");
    }
  });
}

test("numberMatches is symmetric on the bare class", () => {
  const [bare] = extractNumbers("5");
  const [pct] = extractNumbers("5%");
  const [cur] = extractNumbers("$5");
  assert.ok(numberMatches(bare, pct));
  assert.ok(numberMatches(pct, bare));
  assert.ok(!numberMatches(cur, pct));
});

test("numbers inside a candidate code fence are exempt", () => {
  const source = "We saved money last quarter.";
  const candidate = ["We saved money last quarter.", "", "```", "exit 42", "```"].join("\n");
  clean(verify("story-edit", source, candidate));
});

// ---------------------------------------------------------------------------
// cut-only + no new paragraphs (blog-sharpen)
// ---------------------------------------------------------------------------

const SHARPEN_SOURCE = [
  "The migration broke at midnight and the pager stayed quiet.",
  "",
  "The rollback plan was a wiki page nobody had read.",
  "",
  "We paid for that in credits and in trust.",
].join("\n");

test("cut-only boundary: equal word count passes, one word more disqualifies", () => {
  const equal = SHARPEN_SOURCE;
  assert.equal(countWords(equal), countWords(SHARPEN_SOURCE));
  clean(verify("blog-sharpen", SHARPEN_SOURCE, equal));

  const oneMore = SHARPEN_SOURCE.replace(
    "nobody had read.",
    "nobody had actually read.",
  );
  assert.equal(countWords(oneMore), countWords(SHARPEN_SOURCE) + 1);
  const result = verify("blog-sharpen", SHARPEN_SOURCE, oneMore);
  assert.equal(result.verdict, "DISQUALIFIED");
  only(result, "cut-only");
});

test("a real cut (fewer words, no invention) stays CLEAN", () => {
  const cut = [
    "The migration broke at midnight.",
    "",
    "The rollback plan was a wiki page nobody had read.",
  ].join("\n");
  assert.ok(countWords(cut) < countWords(SHARPEN_SOURCE));
  clean(verify("blog-sharpen", SHARPEN_SOURCE, cut));
});

test("paragraph swap at identical word count is caught by n-gram containment", () => {
  const invented = "Teams everywhere struggle with change and must communicate more openly.";
  const candidate = [
    "The migration broke at midnight and the pager stayed quiet.",
    "",
    invented,
    "",
    "We paid for that in credits and in trust.",
  ].join("\n");
  assert.equal(
    countWords(candidate),
    countWords(SHARPEN_SOURCE),
    "the swap must be word-count neutral, or cut-only would catch it instead",
  );
  const result = verify("blog-sharpen", SHARPEN_SOURCE, candidate);
  assert.equal(result.verdict, "DISQUALIFIED");
  only(result, "no-new-paragraphs");
  assert.match(result.violations[0].evidence ?? "", /Teams everywhere struggle/);
});

test("a fenced block needs no source paragraph anchor", () => {
  const candidate = [
    "The migration broke at midnight and the pager stayed quiet.",
    "",
    "```json",
    '{"alerts": 0}',
    "```",
  ].join("\n");
  clean(verify("blog-sharpen", SHARPEN_SOURCE, candidate));
});

// ---------------------------------------------------------------------------
// warnings vs disqualify
// ---------------------------------------------------------------------------

test("AI tells and new numbers are warnings: the candidate stays CLEAN", () => {
  const brief = "Write two lines about the outage. Keep it plain.";
  const candidate =
    "We must utilize the runbook and leverage the pager. It's worth noting the 4 alerts were muted.";
  const result = verify("voice", brief, candidate);
  clean(result);
  assert.ok(result.violations.length >= 4, JSON.stringify(result.violations));
  assert.ok(result.violations.every((v) => v.severity === "warning"));
  assert.deepEqual(new Set(ruleIds(result)), new Set(["ai-tell-lexicon", "no-new-numbers"]));
});

test("one disqualifying rule flips the verdict and the warnings still travel", () => {
  const brief = "Write two lines about the outage. Keep it plain.";
  const candidate =
    "We must utilize the runbook — leverage the pager. It's worth noting the 4 alerts were muted.";
  const result = verify("voice", brief, candidate);
  assert.equal(result.verdict, "DISQUALIFIED");
  assert.equal(result.violations.filter((v) => v.severity === "disqualify").length, 1);
  assert.ok(result.violations.some((v) => v.rule === "ai-tell-lexicon"));
  assert.ok(result.violations.some((v) => v.rule === "no-new-numbers"));
});

test("the tell lexicon carries the sharpen row plus tapestry and it's worth noting", () => {
  for (const tell of ["utilize", "leverage", "myriad", "plethora", "delve", "robust", "seamless", "tapestry", "it's worth noting"]) {
    assert.ok(AI_TELLS.includes(tell), `missing tell: ${tell}`);
  }
});

test("a curly apostrophe does not hide the it's-worth-noting tell", () => {
  const result = verify("voice", "brief", "It’s worth noting the plan held.");
  assert.deepEqual(ruleIds(result), ["ai-tell-lexicon"]);
  clean(result);
});

test("en-dash creep is a warning, not a disqualification", () => {
  const result = verify("story-edit", "The window was 2019–2021.", "The window was 2019–2021 – roughly.");
  clean(result);
  only(result, "en-dash-creep");
  assert.match(result.violations[0].message, /rose from 1 to 2/);
});

test("tells are not checked for story-edit or story-judge", () => {
  clean(verify("story-edit", "utilize the runbook", "utilize the runbook"));
});

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

test("stripCodeFences blanks fenced blocks and keeps paragraph boundaries", () => {
  const text = ["before", "", "```ts", "const x = 1;", "```", "", "after"].join("\n");
  const stripped = stripCodeFences(text);
  assert.ok(!stripped.includes("const x"));
  assert.ok(stripped.includes("before"));
  assert.ok(stripped.includes("after"));
  assert.equal(stripped.split("\n").length, text.split("\n").length);
});

test("stripCodeFences honours tildes and longer closing fences", () => {
  assert.ok(!stripCodeFences(["~~~", "hidden", "~~~"].join("\n")).includes("hidden"));
  assert.ok(
    !stripCodeFences(["````", "```", "hidden", "````"].join("\n")).includes("hidden"),
  );
});

// ---------------------------------------------------------------------------
// code-review regressions (PR #838): row anchoring, list markers, verdict case
// ---------------------------------------------------------------------------

test("a prose line beginning with a dimension word does not steal the row", () => {
  const card = ["Hook and landing are the weak points.", "", scorecard()].join("\n");
  clean(verify("story-judge", JUDGE_SOURCE, card));
  const parsed = parseScorecard(card);
  assert.equal(parsed.rows.find((r) => r.dimension === "Hook")?.score, 3);
});

test("a prefix collision (Hooks) does not claim the Hook dimension", () => {
  const collided = scorecard().replace("- Hook - 3", "- Hooks - 3");
  const parsed = parseScorecard(collided);
  assert.equal(parsed.rows.some((r) => r.dimension === "Hook"), false);
});

test("ordered-list markers introduced by a rewrite are not invented numbers", () => {
  const source = [
    "Three lessons:",
    "",
    "- rehearse the rollback",
    "- mute nothing",
    "- write it down",
  ].join("\n");
  const candidate = [
    "Three lessons:",
    "",
    "1. rehearse the rollback",
    "2. mute nothing",
    "3. write it down",
  ].join("\n");
  clean(verify("story-edit", source, candidate));
});

test("a real invented number is still caught among list markers", () => {
  const source = ["- rehearse the rollback", "- mute nothing"].join("\n");
  const candidate = ["1. rehearse the rollback for 45 minutes", "2. mute nothing"].join("\n");
  only(verify("story-edit", source, candidate), "numbers-frozen");
});

test("lowercase prose containing a verdict word is not a verdict", () => {
  const card =
    scorecard(BASE_ROWS, { verdict: null }) + "\nNote: this is not ready to publish yet.";
  const r = verify("story-judge", JUDGE_SOURCE, card);
  assert.equal(r.verdict, "DISQUALIFIED");
  assert.ok(ruleIds(r).includes("scorecard-shape"));
});
