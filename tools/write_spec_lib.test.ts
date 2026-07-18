import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONTRACT_HEADER,
  NO_TOOLS,
  SECTION_IDS,
  TRUNCATION_MARKER,
  assembleBriefForDispatch,
  buildLeadCmd,
  buildWingCmd,
  composePrompt,
  computeDone,
  deriveSlugFromOut,
  extractAgentUsage,
  extractContractVerdictJson,
  loadContractText,
  normalizeContractVerdict,
  parseClaudeJson,
  runWriteSpec,
  writeExitArtifacts,
} from "./write_spec_lib.ts";
import type {
  ContractItem,
  FinalVerdict,
  WriteSpecDeps,
  WriteSpecReceipt,
} from "./write_spec_lib.ts";
import { DECIDER_DISALLOWED_TOOLS } from "./red_team_fold_lib.ts";
import { computeDispatchCost } from "./cost_lib.ts";
import { assetPromptsDir } from "./asset_root_lib.ts";

// Route the drift check through the real asset resolver (the runtime seam),
// NOT a hardcoded source-relative path, so it validates the same contract.md
// that the flat vendored plugin layout resolves.
const CONTRACT_MD = path.join(assetPromptsDir(), "write-spec", "contract.md");

function fenced(obj: unknown): string {
  return "some preamble\n\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
}

// test_contract_verdict_extracted
test("test_contract_verdict_extracted", () => {
  const contract = {
    items: [{ section: "intent", status: "satisfied", note: "ok" }],
    done: false,
    summary: "wip",
  };
  const text = fenced(contract);
  const got = extractContractVerdictJson(text);
  assert.ok(got, "expected a contract verdict object");
  assert.deepEqual(got!["items"], contract.items);
  assert.equal(got!["done"], false);
  assert.equal("verdict" in got!, false);

  // A copilot-shaped {verdict: approve} control must NOT be grabbed.
  const control = extractContractVerdictJson(fenced({ verdict: "approve" }));
  assert.equal(control, null);
});

// test_parser_drops_unknown_sections
test("test_parser_drops_unknown_sections", () => {
  const items = [
    ...SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
    { section: "totally-new-tenth", status: "satisfied", note: "sneaky" },
  ];
  const { verdict, droppedSections } = normalizeContractVerdict({
    items,
    done: true,
    summary: "s",
  });
  assert.deepEqual(droppedSections, ["totally-new-tenth"]);
  assert.equal(verdict.items.length, SECTION_IDS.length);
  assert.deepEqual(
    verdict.items.map((i) => i.section),
    [...SECTION_IDS],
  );
  // done computed from the 9 known sections, all satisfied.
  assert.equal(verdict.done, true);
});

// test_status_enum_rejects_unknown
test("test_status_enum_rejects_unknown", () => {
  const { verdict } = normalizeContractVerdict({
    items: [{ section: "intent", status: "brilliant", note: "n" }],
    done: true,
    summary: "",
  });
  const intent = verdict.items.find((i) => i.section === "intent")!;
  assert.equal(intent.status, "underspecified");
  // Unknown status coerced to a blocking status → done is false.
  assert.equal(verdict.done, false);
});

// over_scoped is a valid status: it survives normalization (not coerced to
// underspecified) and blocks done just like missing/underspecified.
test("test_over_scoped_status_survives_and_blocks_done", () => {
  const { verdict } = normalizeContractVerdict({
    items: SECTION_IDS.map((section, i) => ({
      section,
      status: i === 0 ? "over_scoped" : "satisfied",
      note: i === 0 ? "cut the extra auth machinery" : "x",
    })),
    done: true, // wing lies
    summary: "",
  });
  const intent = verdict.items.find((i) => i.section === "intent")!;
  assert.equal(intent.status, "over_scoped");
  // over_scoped does not count toward done.
  assert.equal(verdict.done, false);
});

// extractContractVerdictJson returns the LAST contract-shaped candidate in
// DOCUMENT order: an earlier inline object must lose to a later fenced one.
test("test_last_candidate_precedence", () => {
  const early = { items: [{ section: "intent", status: "underspecified", note: "draft" }], done: false, summary: "draft" };
  const late = { items: [{ section: "intent", status: "satisfied", note: "final" }], done: true, summary: "final" };
  const text =
    "first pass: " + JSON.stringify(early) +
    "\n\ncorrected:\n\n```json\n" + JSON.stringify(late, null, 2) + "\n```\n";
  const got = extractContractVerdictJson(text);
  assert.ok(got, "expected a contract verdict object");
  assert.equal(got!["summary"], "final");
  assert.deepEqual(got!["items"], late.items);
});

// test_done_recomputed_from_items
test("test_done_recomputed_from_items", () => {
  // Wing lies: claims done:true but a section is missing/underspecified.
  const items = SECTION_IDS.map((section, i) => ({
    section,
    status: i === 0 ? "underspecified" : "satisfied",
    note: "x",
  }));
  const { verdict } = normalizeContractVerdict({
    items,
    done: true, // never trusted
    summary: "",
  });
  assert.equal(verdict.done, false);

  // Flip that section to satisfied → done recomputes true.
  const allGood = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
    done: false, // wing under-reports; host still computes true
    summary: "",
  });
  assert.equal(allGood.verdict.done, true);

  // Reasoned n_a counts as satisfied; reason-less n_a is downgraded → blocks.
  const reasonedNa = computeDone(
    SECTION_IDS.map((section) => ({ section, status: "n_a" as const, note: "not relevant" })),
  );
  assert.equal(reasonedNa, true);
});

// test_partial_verdict_fails_closed
test("test_partial_verdict_fails_closed", () => {
  // Only one section reported; the other 8 are synthesized as `missing`.
  const { verdict } = normalizeContractVerdict({
    items: [{ section: "intent", status: "satisfied", note: "ok" }],
    done: true,
    summary: "partial",
  });
  assert.equal(verdict.items.length, SECTION_IDS.length);
  const missing = verdict.items.filter((i) => i.status === "missing");
  assert.equal(missing.length, SECTION_IDS.length - 1);
  assert.equal(verdict.done, false);

  // Reason-less n_a is downgraded to underspecified and blocks.
  const naNoReason = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({ section, status: "n_a", note: "" })),
    done: true,
    summary: "",
  });
  assert.ok(naNoReason.verdict.items.every((i) => i.status === "underspecified"));
  assert.equal(naNoReason.verdict.done, false);
});

// A non-object raw (JSON array / string / null) is not a valid verdict shape.
// The isPlainObject guard must fail closed: no items trusted, all 9 sections
// synthesized as missing, done=false, empty summary — never throw, never
// fabricate a truthy done.
test("test_non_object_raw_fails_closed", () => {
  for (const raw of [
    [{ section: "intent", status: "satisfied", note: "ok" }],
    "done",
    42,
    null,
    true,
  ] as unknown[]) {
    const { verdict, droppedSections } = normalizeContractVerdict(raw);
    assert.equal(verdict.items.length, SECTION_IDS.length);
    assert.ok(
      verdict.items.every((i) => i.status === "missing"),
      "all sections synthesized missing",
    );
    assert.equal(verdict.done, false);
    assert.equal(verdict.summary, "");
    assert.deepEqual(droppedSections, []);
  }
});

// Duplicate sections: first occurrence of a known section wins; a later
// contradictory duplicate cannot flip the recorded status nor fabricate a
// false done. Each SECTION_ID is counted once by computeDone.
test("test_duplicate_section_first_occurrence_wins", () => {
  // intent appears twice: satisfied then missing. First wins → intent stays
  // satisfied, but the other 8 sections are absent → done still false.
  const { verdict } = normalizeContractVerdict({
    items: [
      { section: "intent", status: "satisfied", note: "ok" },
      { section: "intent", status: "missing", note: "no" },
    ],
    done: true,
    summary: "",
  });
  const intents = verdict.items.filter((i) => i.section === "intent");
  assert.equal(intents.length, 1, "intent counted exactly once");
  assert.equal(intents[0]!.status, "satisfied");
  assert.equal(verdict.done, false);

  // All 9 satisfied, then a trailing missing duplicate of one → cannot flip
  // the completed verdict to false (first-occurrence-wins), and cannot inflate
  // beyond 9 items.
  const dupAllGood = normalizeContractVerdict({
    items: [
      ...SECTION_IDS.map((section) => ({ section, status: "satisfied", note: "x" })),
      { section: "intent", status: "missing", note: "late flip attempt" },
    ],
    done: false,
    summary: "",
  });
  assert.equal(dupAllGood.verdict.items.length, SECTION_IDS.length);
  assert.equal(dupAllGood.verdict.done, true);
});

// Reasoned n_a exercised THROUGH normalizeContractVerdict (not computeDone
// directly): a reasoned n_a survives normalization and counts toward done.
test("test_reasoned_na_through_normalization", () => {
  const { verdict } = normalizeContractVerdict({
    items: SECTION_IDS.map((section) => ({
      section,
      status: "n_a",
      note: "not relevant to this spec",
    })),
    done: false,
    summary: "",
  });
  assert.ok(
    verdict.items.every((i) => i.status === "n_a"),
    "reasoned n_a not downgraded",
  );
  assert.equal(verdict.done, true);
});

// test_prompts_reference_canonical_ids — every write-spec generate/verify/revise
// prompt (claude AND codex) must mention each SECTION_IDS id at least once, so a
// drifted canonical id fails the prompt set, not just the parser.
test("test_prompts_reference_canonical_ids", () => {
  // Resolve from the source repo (tools/ -> ../global/prompts), not the
  // published asset dir — these prompts may be branch-new and not yet vendored.
  const promptsDir = path.join(import.meta.dirname, "..", "global", "prompts", "write-spec");
  const agents = ["claude", "codex"];
  const roles = ["generate", "verify", "revise"];
  for (const agent of agents) {
    for (const role of roles) {
      const file = path.join(promptsDir, agent, `${role}.md`);
      const text = readFileSync(file, "utf8");
      for (const id of SECTION_IDS) {
        assert.ok(
          text.includes(id),
          `${agent}/${role}.md is missing canonical id "${id}"`,
        );
      }
    }
  }
});

// ── Dispatch primitives (#699) ───────────────────────────────────────────

// test_derive_slug_from_out
test("test_derive_slug_from_out", () => {
  // canonical path -> slug
  assert.equal(
    deriveSlugFromOut("docs/specs/2026-07-18-write-spec-dispatch-spec.md"),
    "write-spec-dispatch",
  );
  // multi-word slug round-trips (bare basename too)
  assert.equal(
    deriveSlugFromOut("2026-01-02-a-b-c-spec.md"),
    "a-b-c",
  );
  // non-conforming path throws the documented error
  assert.throws(
    () => deriveSlugFromOut("docs/specs/not-a-spec.md"),
    /out path must match docs\/specs\/YYYY-MM-DD-<slug>-spec\.md; got not-a-spec\.md/,
  );
  // no --slug escape hatch: a path missing the -spec.md suffix throws.
  assert.throws(
    () => deriveSlugFromOut("2026-07-18-write-spec-dispatch.md"),
    /out path must match/,
  );
});

// test_agent_commands_expose_no_tools
test("test_agent_commands_expose_no_tools", () => {
  // NO_TOOLS is the fold decider's disallowed set, verbatim.
  assert.deepEqual([...NO_TOOLS], [...DECIDER_DISALLOWED_TOOLS]);

  for (const build of [buildLeadCmd, buildWingCmd]) {
    // claude builder: no-tools, empty allowedTools (never grantable).
    const claude = build("claude");
    assert.equal(claude.cmd, "claude");
    const di = claude.args.indexOf("--disallowedTools");
    assert.ok(di >= 0, "claude cmd carries --disallowedTools");
    assert.deepEqual(claude.args.slice(di + 1, di + 1 + NO_TOOLS.length), [...NO_TOOLS]);
    // Nothing grantable: no --allowedTools flag, and no tool name is granted.
    assert.equal(claude.args.includes("--allowedTools"), false);
    for (const t of ["Read", "Glob", "Grep", "Bash", "Write"]) {
      assert.equal(
        claude.args.includes(`--allowedTools`) && claude.args.includes(t) &&
          claude.args.indexOf(t) < di,
        false,
        `${t} must not be grantable`,
      );
    }
    assert.equal(claude.args.includes("--output-format"), true);
    assert.equal(claude.args[claude.args.indexOf("--output-format") + 1], "json");

    // codex builder: read-only.
    const codex = build("codex");
    assert.equal(codex.cmd, "codex");
    assert.equal(codex.args.includes("exec"), true);
    const si = codex.args.indexOf("-s");
    assert.ok(si >= 0 && codex.args[si + 1] === "read-only", "codex cmd is -s read-only");
  }

  // wing codex gets the higher xhigh reasoning effort; lead codex is high.
  assert.ok(buildWingCmd("codex").args.some((a) => a.includes('model_reasoning_effort="xhigh"')));
  assert.ok(buildLeadCmd("codex").args.some((a) => a.includes('model_reasoning_effort="high"')));
});

// A configured wing_reasoning_effort override reaches the codex wing argv
// (threaded through buildWingCmd, not literal-coded to xhigh).
test("test_wing_reasoning_effort_config_honored", () => {
  const overridden = buildWingCmd("codex", "high");
  assert.ok(
    overridden.args.some((a) => a.includes('model_reasoning_effort="high"')),
    "config override 'high' reaches the wing argv",
  );
  assert.ok(
    !overridden.args.some((a) => a.includes('model_reasoning_effort="xhigh"')),
    "override replaces the default xhigh",
  );
  // Still consumes the read-only codex command surface.
  const si = overridden.args.indexOf("-s");
  assert.ok(si >= 0 && overridden.args[si + 1] === "read-only");
});

// test_parse_claude_json_envelope
test("test_parse_claude_json_envelope", () => {
  const canned = JSON.stringify({
    type: "result",
    result: "the spec text",
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  const got = parseClaudeJson(canned);
  assert.equal(got.text, "the spec text");
  assert.deepEqual(got.usage, { input_tokens: 12, output_tokens: 34 });

  // Missing usage / result → empty text, null usage.
  const bare = parseClaudeJson(JSON.stringify({ type: "result" }));
  assert.equal(bare.text, "");
  assert.equal(bare.usage, null);

  // Non-JSON stdout → raw passthrough, null usage.
  const raw = parseClaudeJson("not json at all");
  assert.equal(raw.text, "not json at all");
  assert.equal(raw.usage, null);
});

// test_contract_text_reaches_agents
test("test_contract_text_reaches_agents", () => {
  const SENTINEL = "SENTINEL-CONTRACT-LINE-42";
  const contract = `## intent — bar\n${SENTINEL}\n`;
  // A generate, a verify, and a revise template each carry the sentinel.
  for (const tmpl of ["GENERATE template", "VERIFY template", "REVISE template"]) {
    const out = composePrompt(tmpl, contract, "the brief");
    assert.ok(out.includes(SENTINEL), `${tmpl} output carries contract sentinel`);
    assert.ok(out.includes(CONTRACT_HEADER), "contract header present");
    assert.ok(out.includes(tmpl), "per-agent template present");
    assert.ok(out.includes("the brief"), "brief present");
    // composePrompt is pure — contract precedes template precedes brief.
    assert.ok(out.indexOf(SENTINEL) < out.indexOf(tmpl));
    assert.ok(out.indexOf(tmpl) < out.indexOf("the brief"));
  }

  // loadContractText reads the real asset once and returns non-empty text.
  const loaded = loadContractText();
  assert.ok(loaded.trim().length > 0, "contract.md is non-empty");

  // Missing/empty contract → throws (fail-closed). Point the asset resolver
  // at an empty temp tree.
  const prevAssetRoot = process.env.STARK_ASSET_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "write-spec-contract-"));
  try {
    process.env.STARK_ASSET_ROOT = tmp;
    assert.throws(() => loadContractText(), /spec contract not found|is empty/);
  } finally {
    if (prevAssetRoot === undefined) delete process.env.STARK_ASSET_ROOT;
    else process.env.STARK_ASSET_ROOT = prevAssetRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// test_contract_ids_match_asset
test("test_contract_ids_match_asset", () => {
  const md = readFileSync(CONTRACT_MD, "utf8");
  const ids: string[] = [];
  for (const m of md.matchAll(/^## ([a-z-]+) —/gm)) {
    if (m[1]) ids.push(m[1]);
  }
  assert.deepEqual(
    ids,
    [...SECTION_IDS],
    "contract.md section headers drifted from SECTION_IDS",
  );
});

// ── runWriteSpec loop + durable exit writer (#700) ───────────────────────

/** All nine sections satisfied — the host recomputes `done` true. */
const ALL_SATISFIED: ContractItem[] = SECTION_IDS.map((section) => ({
  section,
  status: "satisfied",
  note: "ok",
}));

/** Nine sections with `intent` set to a blocking `status`. */
function withIntent(status: string): ContractItem[] {
  return SECTION_IDS.map((section) => ({
    section,
    status: section === "intent" ? (status as ContractItem["status"]) : "satisfied",
    note: section === "intent" ? "needs work" : "ok",
  }));
}

/** Fence a ContractVerdict object as wing stdout. `done` is never trusted. */
function wingJson(items: ContractItem[], summary = "s"): string {
  return "```json\n" + JSON.stringify({ items, done: true, summary }) + "\n```";
}

interface MockConfig {
  leadDrafts: string[];
  wingReplies: string[];
  writeArtifacts?: WriteSpecDeps["writeArtifacts"];
}

interface MockHandle {
  deps: Partial<WriteSpecDeps>;
  leadPrompts: string[];
  wingPrompts: string[];
  counts: () => { leadCalls: number; wingCalls: number };
}

function mockDeps(cfg: MockConfig): MockHandle {
  let leadCalls = 0;
  let wingCalls = 0;
  const leadPrompts: string[] = [];
  const wingPrompts: string[] = [];
  const deps: Partial<WriteSpecDeps> = {
    loadContract: () => "CONTRACT TEXT",
    loadAgentPrompt: (agent, role) => `[${agent}:${role}]`,
    dispatchLead: async ({ prompt }) => {
      leadPrompts.push(prompt);
      return cfg.leadDrafts[leadCalls++] ?? "";
    },
    dispatchWing: async ({ prompt }) => {
      wingPrompts.push(prompt);
      return cfg.wingReplies[wingCalls++] ?? "no json here at all";
    },
  };
  if (cfg.writeArtifacts) deps.writeArtifacts = cfg.writeArtifacts;
  return {
    deps,
    leadPrompts,
    wingPrompts,
    counts: () => ({ leadCalls, wingCalls }),
  };
}

/** A temp run dir + conforming --out path for on-disk assertions. */
function tmpRun(): { dir: string; out: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-spec-run-"));
  const out = path.join(dir, "2026-07-18-loop-test-spec.md");
  return { dir, out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// test_early_exit_single_pass — a clean first draft exits in ONE round with
// exactly one lead + one wing call.
test("test_early_exit_single_pass", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const m = mockDeps({
      leadDrafts: ["the spec draft"],
      wingReplies: [wingJson(ALL_SATISFIED)],
    });
    const receipt = await runWriteSpec({ out, brief: "make it", runDir: dir }, m.deps);
    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.rounds, 1);
    assert.deepEqual(m.counts(), { leadCalls: 1, wingCalls: 1 });
    // Spec + receipt on disk.
    assert.equal(fs.readFileSync(out, "utf8"), "the spec draft");
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8"));
    assert.equal(persisted.final_verdict, "contract_satisfied");
  } finally {
    cleanup();
  }
});

// test_over_scoped_routes_to_revise — an over_scoped section on round 1 blocks
// done and routes to a revise round; the second lead prompt is a revise carrying
// the non-satisfied item.
test("test_over_scoped_routes_to_revise", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const m = mockDeps({
      leadDrafts: ["draft one", "draft two"],
      wingReplies: [wingJson(withIntent("over_scoped")), wingJson(ALL_SATISFIED)],
    });
    const receipt = await runWriteSpec({ out, brief: "b", runDir: dir }, m.deps);
    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.rounds, 2);
    assert.deepEqual(m.counts(), { leadCalls: 2, wingCalls: 2 });
    // Round-2 lead prompt is a revise carrying the over_scoped item.
    assert.ok(m.leadPrompts[1]!.includes("[claude:revise]"), "round-2 uses revise template");
    assert.ok(m.leadPrompts[1]!.includes("over_scoped"), "revise brief names the item");
    assert.ok(m.leadPrompts[1]!.includes("draft one"), "revise brief carries prior draft");
    assert.ok(m.leadPrompts[0]!.includes("[claude:generate]"), "round-1 uses generate");
    assert.equal(fs.readFileSync(out, "utf8"), "draft two");
  } finally {
    cleanup();
  }
});

// test_termination_matrix — each breaker yields the right final_verdict, ok=false,
// error.code, and spec + receipt.json on disk.
test("test_termination_matrix", async () => {
  const cases: {
    name: FinalVerdict;
    cfg: MockConfig;
    maxRounds?: number;
    expectRounds: number;
    expectSpec: string;
  }[] = [
    {
      name: "max_rounds_unsatisfied",
      cfg: {
        leadDrafts: ["d1", "d2"],
        wingReplies: [wingJson(withIntent("underspecified")), wingJson(withIntent("underspecified"))],
      },
      maxRounds: 2,
      expectRounds: 2,
      expectSpec: "d2",
    },
    {
      name: "lead_empty_draft",
      cfg: { leadDrafts: [""], wingReplies: [] },
      expectRounds: 1,
      expectSpec: "",
    },
    {
      name: "unchanged_revision",
      cfg: {
        leadDrafts: ["same", "same"],
        wingReplies: [wingJson(withIntent("missing"))],
      },
      maxRounds: 3,
      expectRounds: 2,
      expectSpec: "same",
    },
    {
      name: "wing_unparseable",
      cfg: { leadDrafts: ["a draft"], wingReplies: ["nope", "still nope"] },
      expectRounds: 1,
      expectSpec: "a draft",
    },
  ];

  for (const c of cases) {
    const { dir, out, cleanup } = tmpRun();
    try {
      const m = mockDeps(c.cfg);
      const receipt = await runWriteSpec(
        { out, brief: "b", runDir: dir, maxRounds: c.maxRounds },
        m.deps,
      );
      assert.equal(receipt.final_verdict, c.name, `${c.name}: final_verdict`);
      assert.equal(receipt.ok, false, `${c.name}: ok=false`);
      assert.equal(receipt.error?.code, c.name, `${c.name}: error.code`);
      assert.equal(receipt.rounds, c.expectRounds, `${c.name}: rounds`);
      // Spec + receipt on disk in the slug-derived run dir.
      assert.equal(fs.readFileSync(out, "utf8"), c.expectSpec, `${c.name}: spec text`);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(dir, "receipt.json"), "utf8"),
      ) as WriteSpecReceipt;
      assert.equal(persisted.final_verdict, c.name, `${c.name}: persisted verdict`);
      assert.equal(persisted.slug, "loop-test", `${c.name}: slug`);
    } finally {
      cleanup();
    }
  }
});

// test_receipt_contract_status_persisted — contract_status is the full
// nine-section array on EVERY terminal verdict (5-2/5-3's input contract).
test("test_receipt_contract_status_persisted", async () => {
  const cases: { name: string; cfg: MockConfig; maxRounds?: number }[] = [
    {
      name: "satisfied",
      cfg: { leadDrafts: ["d"], wingReplies: [wingJson(ALL_SATISFIED)] },
    },
    {
      name: "max_rounds",
      cfg: {
        leadDrafts: ["d1", "d2"],
        wingReplies: [wingJson(withIntent("underspecified")), wingJson(withIntent("underspecified"))],
      },
      maxRounds: 2,
    },
    // No good verdict was ever produced → all-missing nine-id floor.
    { name: "empty_draft", cfg: { leadDrafts: [""], wingReplies: [] } },
    {
      name: "wing_unparseable",
      cfg: { leadDrafts: ["d"], wingReplies: ["x", "y"] },
    },
  ];
  for (const c of cases) {
    const { dir, out, cleanup } = tmpRun();
    try {
      const receipt = await runWriteSpec(
        { out, brief: "b", runDir: dir, maxRounds: c.maxRounds },
        mockDeps(c.cfg).deps,
      );
      assert.equal(
        receipt.contract_status.length,
        SECTION_IDS.length,
        `${c.name}: nine items`,
      );
      assert.deepEqual(
        receipt.contract_status.map((i) => i.section),
        [...SECTION_IDS],
        `${c.name}: every section id present`,
      );
      for (const it of receipt.contract_status) {
        assert.ok(typeof it.status === "string" && typeof it.note === "string");
      }
    } finally {
      cleanup();
    }
  }
});

// test_spec_write_failure_is_fatal — a stubbed spec/receipt write failure fails
// the run (distinct from Phase 4 non-fatal history writes).
test("test_spec_write_failure_is_fatal", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const m = mockDeps({
      leadDrafts: ["draft"],
      wingReplies: [wingJson(ALL_SATISFIED)],
      writeArtifacts: () => {
        throw new Error("disk full");
      },
    });
    await assert.rejects(
      () => runWriteSpec({ out, brief: "b", runDir: dir }, m.deps),
      /disk full/,
    );
  } finally {
    cleanup();
  }
});

// writeExitArtifacts writes spec (to receipt.spec_path) + receipt.json (to
// runDir) atomically; both are real files afterward.
test("test_write_exit_artifacts_atomic", () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const receipt: WriteSpecReceipt = {
      ok: true,
      final_verdict: "contract_satisfied",
      slug: "loop-test",
      spec_path: out,
      run_dir: dir,
      run_id: "run-1",
      rounds: 1,
      lead_agent: "claude",
      wing_agent: "codex",
      contract_status: ALL_SATISFIED,
      dropped_sections: [],
      summary: "done",
      cost_usd: 0,
      cost_breakdown: [],
      cost_notes: [],
      persistence_errors: [],
    };
    writeExitArtifacts(dir, "SPEC BODY", receipt);
    assert.equal(fs.readFileSync(out, "utf8"), "SPEC BODY");
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8"));
    assert.equal(persisted.slug, "loop-test");
  } finally {
    cleanup();
  }
});

// ── Intent-brief assembly + truncation (#702) ────────────────────────────

const ASK_SECTION = "## Ask\nBuild the write-spec intent brief loader.\n\n";
const CONSTRAINTS_SECTION =
  "## Constraints\nTypeScript only; immutable-asset reads via assetPromptsDir().\n\n";
const TARGET_SECTION = "## Target\ntools/write_spec_lib.ts\n\n";

// test_intent_brief_under_cap_passthrough
test("assembleBriefForDispatch: under cap returns verbatim, no marker", () => {
  const brief =
    ASK_SECTION + CONSTRAINTS_SECTION + TARGET_SECTION + "## Source\nsome context\n";
  const got = assembleBriefForDispatch(brief, 100_000);
  assert.equal(got, brief);
  assert.equal(got.includes(TRUNCATION_MARKER), false);
});

// test_intent_brief_truncation
test("assembleBriefForDispatch: over cap truncates source only, marker present", () => {
  const bulk = "## Source Material\n" + "x".repeat(50_000) + "\n";
  const brief = ASK_SECTION + CONSTRAINTS_SECTION + TARGET_SECTION + bulk;
  const cap = 2_000;
  const got = assembleBriefForDispatch(brief, cap);

  // Cap honored and marker present iff truncation occurred.
  assert.ok(got.length <= cap, `expected <= ${cap}, got ${got.length}`);
  assert.ok(got.endsWith(TRUNCATION_MARKER), "expected truncation marker at end");
  assert.equal(
    got.indexOf(TRUNCATION_MARKER),
    got.lastIndexOf(TRUNCATION_MARKER),
    "marker must appear exactly once",
  );

  // Ask / Constraints / Target preserved VERBATIM.
  assert.ok(got.includes(ASK_SECTION), "Ask section must be verbatim");
  assert.ok(got.includes(CONSTRAINTS_SECTION), "Constraints section must be verbatim");
  assert.ok(got.includes(TARGET_SECTION), "Target section must be verbatim");

  // The bulk source material was actually cut.
  assert.ok(!got.includes("x".repeat(50_000)), "source material must be truncated");
});

// test_intent_brief_boundary_passthrough
test("assembleBriefForDispatch: exactly at cap is passthrough (no marker)", () => {
  const brief = ASK_SECTION + "## Source\n" + "y".repeat(20) + "\n";
  const got = assembleBriefForDispatch(brief, brief.length);
  assert.equal(got, brief);
  assert.equal(got.includes(TRUNCATION_MARKER), false);
});

// test_intent_brief_protected_sections_never_truncated
test("assembleBriefForDispatch: protected sections survive under a tiny cap", () => {
  const brief =
    ASK_SECTION +
    CONSTRAINTS_SECTION +
    TARGET_SECTION +
    "## Source\n" +
    "bulk ".repeat(1000);
  const cap =
    ASK_SECTION.length +
    CONSTRAINTS_SECTION.length +
    TARGET_SECTION.length +
    TRUNCATION_MARKER.length +
    10;
  const got = assembleBriefForDispatch(brief, cap);
  assert.ok(got.includes(ASK_SECTION));
  assert.ok(got.includes(CONSTRAINTS_SECTION));
  assert.ok(got.includes(TARGET_SECTION));
  assert.ok(got.endsWith(TRUNCATION_MARKER));
});

test("assembleBriefForDispatch: protected sections ALONE exceeding cap are preserved verbatim", () => {
  // Pathological branch: Ask/Constraints/Target alone already exceed `cap`, so
  // sourceBudget clamps to 0 and ALL source is dropped. The documented invariant
  // exception is that protected text is NEVER truncated — the result therefore
  // exceeds `cap`, but every protected section survives verbatim.
  const brief = ASK_SECTION + CONSTRAINTS_SECTION + TARGET_SECTION + "## Source\nextra\n";
  const protectedLen = ASK_SECTION.length + CONSTRAINTS_SECTION.length + TARGET_SECTION.length;
  const cap = protectedLen - 20; // strictly below the protected total
  const got = assembleBriefForDispatch(brief, cap);
  // Protected text is never truncated — all three survive verbatim, in order.
  assert.ok(got.includes(ASK_SECTION), "Ask section verbatim");
  assert.ok(got.includes(CONSTRAINTS_SECTION), "Constraints section verbatim");
  assert.ok(got.includes(TARGET_SECTION), "Target section verbatim");
  // All source material was dropped (sourceBudget clamped to 0).
  assert.ok(!got.includes("extra"), "source material dropped");
  assert.ok(got.endsWith(TRUNCATION_MARKER), "marker appended (truncation occurred)");
  // Behavior is well-defined: the result is exactly protected text + marker, and
  // it deliberately exceeds the cap rather than corrupting protected content.
  assert.equal(got, ASK_SECTION + CONSTRAINTS_SECTION + TARGET_SECTION + TRUNCATION_MARKER);
  assert.ok(got.length > cap, "protected-alone result exceeds cap by design");
});

// ── Model-override argv pinning: --model must appear EXACTLY ONCE ─────────
// Guards the pinModelFlag replace-vs-append branch: claudeAgentCmd/codexAgentCmd
// already emit a default `--model <default>`, and pinModelFlag must REPLACE that
// value in place, never append a second flag (last-wins CLI ambiguity).

test("buildLeadCmd: model override yields exactly one --model flag", () => {
  const cmd = buildLeadCmd("claude", "claude-fable-5");
  const modelFlags = cmd.args.filter((a) => a === "--model");
  assert.equal(modelFlags.length, 1, "exactly one --model flag");
  const idx = cmd.args.indexOf("--model");
  assert.equal(cmd.args[idx + 1], "claude-fable-5", "override value pinned");
});

test("buildWingCmd: model override yields exactly one model flag", () => {
  // Codex's model flag is `-m` (modelFlagFor). Assert it appears exactly once.
  const cmd = buildWingCmd("codex", "xhigh", "gpt-5.6-sol");
  const modelFlags = cmd.args.filter((a) => a === "-m");
  assert.equal(modelFlags.length, 1, "exactly one -m flag");
  const idx = cmd.args.indexOf("-m");
  assert.equal(cmd.args[idx + 1], "gpt-5.6-sol", "override value pinned");
});

// ── Per-agent token accounting + cost aggregation (#703) ─────────────────

/** A claude `--output-format json` envelope carrying a usage block. */
function claudeRaw(text: string, input: number, output: number): string {
  return JSON.stringify({
    type: "result",
    result: text,
    usage: { input_tokens: input, output_tokens: output },
  });
}

/**
 * A MULTI-EVENT codex JSONL stream. The `token_count` events are cumulative;
 * only the FINAL one carries the run totals `(input, output)`. An earlier event
 * carries smaller running totals to prove the extractor takes the last, not the
 * sum.
 */
function codexRaw(input: number, output: number): string {
  const early = {
    type: "token_count",
    info: { total_token_usage: { input_tokens: Math.floor(input / 2), output_tokens: Math.floor(output / 3) } },
  };
  const final = {
    type: "token_count",
    info: { total_token_usage: { input_tokens: input, output_tokens: output } },
  };
  return [JSON.stringify(early), JSON.stringify(final)].join("\n");
}

// test_usage_extraction_per_agent — claude envelope + a multi-event codex JSONL
// both yield the expected token pair (codex reads the LAST event, not a sum);
// a usage-less output yields {0,0} + available:false.
test("test_usage_extraction_per_agent", () => {
  // claude: read from the JSON envelope.
  const c = extractAgentUsage("claude", claudeRaw("spec text", 111, 222));
  assert.deepEqual(
    { inputTokens: c.inputTokens, outputTokens: c.outputTokens, available: c.available },
    { inputTokens: 111, outputTokens: 222, available: true },
  );

  // codex: cumulative — take the FINAL event, never sum across events.
  const cx = extractAgentUsage("codex", codexRaw(900, 600));
  assert.equal(cx.inputTokens, 900, "codex input = last event, not a sum");
  assert.equal(cx.outputTokens, 600, "codex output = last event, not a sum");
  assert.equal(cx.available, true);
  // Prove it is NOT the sum of the two events (early = 450/200, final = 900/600).
  assert.notEqual(cx.inputTokens, 450 + 900);
  assert.notEqual(cx.outputTokens, 200 + 600);

  // claude with null usage → floor + unavailable.
  const bare = extractAgentUsage("claude", JSON.stringify({ type: "result", result: "x" }));
  assert.deepEqual(
    { inputTokens: bare.inputTokens, outputTokens: bare.outputTokens, available: bare.available },
    { inputTokens: 0, outputTokens: 0, available: false },
  );

  // codex with no token_count events → floor + unavailable (never throws).
  const noTok = extractAgentUsage("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}');
  assert.deepEqual(
    { inputTokens: noTok.inputTokens, outputTokens: noTok.outputTokens, available: noTok.available },
    { inputTokens: 0, outputTokens: 0, available: false },
  );

  // gemini: generic usageMetadata branch.
  const g = extractAgentUsage(
    "gemini",
    JSON.stringify({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9 } }),
  );
  assert.deepEqual(
    { inputTokens: g.inputTokens, outputTokens: g.outputTokens, available: g.available },
    { inputTokens: 7, outputTokens: 9, available: true },
  );

  // Garbage input never throws.
  assert.equal(extractAgentUsage("claude", "not json").available, false);
  assert.equal(extractAgentUsage("gemini", "not json").available, false);
});

// The extractor documents supporting the OLDER/FLAT codex `token_count` shape
// where the totals sit directly on `info` (or on the event) with no nested
// `total_token_usage`. Exercise both flat variants to lock that branch.
test("codex flat/older token_count shapes extract correctly", () => {
  // Flat on `info` (no nested total_token_usage).
  const flatOnInfo = JSON.stringify({
    type: "token_count",
    info: { input_tokens: 321, output_tokens: 123 },
  });
  const a = extractAgentUsage("codex", flatOnInfo);
  assert.deepEqual(
    { inputTokens: a.inputTokens, outputTokens: a.outputTokens, available: a.available },
    { inputTokens: 321, outputTokens: 123, available: true },
  );

  // Flat on the event itself (no `info` object at all — oldest CLI shape).
  const flatOnEvent = JSON.stringify({
    type: "token_count",
    input_tokens: 50,
    output_tokens: 60,
  });
  const b = extractAgentUsage("codex", flatOnEvent);
  assert.deepEqual(
    { inputTokens: b.inputTokens, outputTokens: b.outputTokens, available: b.available },
    { inputTokens: 50, outputTokens: 60, available: true },
  );
});

/** Deps whose dispatches return rich {text, raw} envelopes carrying usage. */
function costMockDeps(cfg: {
  leadDrafts: { text: string; raw: string }[];
  wingReplies: { text: string; raw: string }[];
}): Partial<WriteSpecDeps> {
  let leadCalls = 0;
  let wingCalls = 0;
  return {
    loadContract: () => "CONTRACT TEXT",
    loadAgentPrompt: (agent, role) => `[${agent}:${role}]`,
    dispatchLead: async () => cfg.leadDrafts[leadCalls++] ?? { text: "", raw: "" },
    dispatchWing: async () => cfg.wingReplies[wingCalls++] ?? { text: "no json", raw: "no json" },
  };
}

// test_receipt_cost_counts_all_invocations — a 2-round run (lead x2, wing x2)
// plus one wing parse-retry → cost_breakdown has 5 rows and cost_usd equals the
// sum over all 5 (retry included).
test("test_receipt_cost_counts_all_invocations", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const nonDone = wingJson(withIntent("underspecified"));
    const done = wingJson(ALL_SATISFIED);
    const LEAD_MODEL = "claude-opus-4-8";
    const WING_MODEL = "gpt-5.6-sol";

    const deps = costMockDeps({
      leadDrafts: [
        { text: "draft one", raw: claudeRaw("draft one", 1000, 500) }, // round 1 generate
        { text: "draft two", raw: claudeRaw("draft two", 1200, 700) }, // round 2 revise
      ],
      wingReplies: [
        { text: nonDone, raw: codexRaw(2000, 300) }, // round 1 verify (non-done → revise)
        { text: "unparseable", raw: codexRaw(2100, 100) }, // round 2 attempt 1 (parse-retry)
        { text: done, raw: codexRaw(2200, 400) }, // round 2 attempt 2 (done)
      ],
    });

    const receipt = await runWriteSpec(
      { out, brief: "b", runDir: dir, leadModel: LEAD_MODEL, wingModel: WING_MODEL, maxRounds: 3 },
      deps,
    );

    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.rounds, 2);
    // 5 invocations: 2 lead + 3 wing (one of which is the parse-retry).
    assert.equal(receipt.cost_breakdown.length, 5, "one row per invocation");

    // cost_usd equals the sum over all 5 rows (retry included).
    const expected =
      computeDispatchCost(LEAD_MODEL, 1000, 500) +
      computeDispatchCost(LEAD_MODEL, 1200, 700) +
      computeDispatchCost(WING_MODEL, 2000, 300) +
      computeDispatchCost(WING_MODEL, 2100, 100) +
      computeDispatchCost(WING_MODEL, 2200, 400);
    assert.ok(Math.abs(receipt.cost_usd - expected) < 1e-12, "cost_usd = sum of all 5 rows");

    // Each row's cost_usd is internally consistent with its tokens + model.
    const sumRows = receipt.cost_breakdown.reduce((n, r) => n + r.cost_usd, 0);
    assert.ok(Math.abs(receipt.cost_usd - sumRows) < 1e-12);

    // Agents attributed correctly: 2 lead (claude), 3 wing (codex).
    assert.equal(receipt.cost_breakdown.filter((r) => r.agent === "claude").length, 2);
    assert.equal(receipt.cost_breakdown.filter((r) => r.agent === "codex").length, 3);
    // The parse-retry row is present (a codex wing invocation with 2100 input).
    assert.ok(receipt.cost_breakdown.some((r) => r.agent === "codex" && r.inputTokens === 2100));
    // All usage was available → no cost notes.
    assert.equal(receipt.cost_notes.length, 0);

    // Persisted to disk with the cost fields.
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8"));
    assert.equal(persisted.cost_breakdown.length, 5);
    assert.ok(Math.abs(persisted.cost_usd - expected) < 1e-12);
  } finally {
    cleanup();
  }
});

// test_missing_usage_degrades_to_note — a dispatch that surfaces no usage
// (bare-string return, as with the text-fallback path) floors to {0,0} and
// pushes a cost_notes entry per invocation; the run never crashes.
test("test_missing_usage_degrades_to_note", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const m = mockDeps({
      leadDrafts: ["the spec draft"],
      wingReplies: [wingJson(ALL_SATISFIED)],
    });
    const receipt = await runWriteSpec({ out, brief: "make it", runDir: dir }, m.deps);
    assert.equal(receipt.final_verdict, "contract_satisfied");
    // 1 lead + 1 wing, neither surfaced usage → 2 notes, all usage_unavailable.
    assert.equal(receipt.cost_breakdown.length, 2);
    assert.equal(receipt.cost_notes.length, 2);
    assert.ok(receipt.cost_notes.every((n) => n.reason === "usage_unavailable"));
    assert.equal(receipt.cost_usd, 0, "floor cost when no usage");
    for (const r of receipt.cost_breakdown) {
      assert.equal(r.inputTokens, 0);
      assert.equal(r.outputTokens, 0);
    }
  } finally {
    cleanup();
  }
});

// ── Incremental history persistence + retention (#704) ───────────────────

// test_receipt_incremental_persistence — after a simulated round-3 crash (the
// lead throws mid-loop), rounds.json holds the 2 completed rounds and
// receipt.json reflects rounds-so-far (rounds:2). rounds.json is written after
// EVERY round, so a crash leaves a durable partial record, never corruption.
test("test_receipt_incremental_persistence", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const nonDone = wingJson(withIntent("underspecified"));
    let leadCalls = 0;
    let wingCalls = 0;
    const deps: Partial<WriteSpecDeps> = {
      loadContract: () => "CONTRACT",
      loadAgentPrompt: (a, r) => `[${a}:${r}]`,
      dispatchLead: async () => {
        leadCalls++;
        if (leadCalls >= 3) throw new Error("simulated crash on round 3");
        return `draft ${leadCalls}`;
      },
      dispatchWing: async () => {
        wingCalls++;
        return nonDone; // never done → keeps revising
      },
    };
    await assert.rejects(
      () => runWriteSpec({ out, brief: "b", runDir: dir, maxRounds: 5 }, deps),
      /simulated crash on round 3/,
    );

    // rounds.json holds exactly the 2 completed rounds.
    const rounds = JSON.parse(fs.readFileSync(path.join(dir, "rounds.json"), "utf8"));
    assert.equal(rounds.rounds.length, 2, "two completed rounds recorded");
    assert.deepEqual(rounds.rounds.map((r: { round: number }) => r.round), [1, 2]);
    assert.equal(rounds.rounds[0].lead_role, "generate");
    assert.equal(rounds.rounds[1].lead_role, "revise");
    for (const r of rounds.rounds) {
      assert.ok(typeof r.duration_ms === "number" && r.duration_ms >= 0);
    }

    // Interim receipt.json reflects rounds-so-far (2), verdict not yet terminal.
    const interim = JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8"));
    assert.equal(interim.rounds, 2, "interim receipt reflects 2 rounds");
    assert.equal(interim.ok, false);

    // brief.md was copied in at dispatch.
    assert.ok(fs.existsSync(path.join(dir, "brief.md")), "brief.md present");
  } finally {
    cleanup();
  }
});

// test_history_retention — with the lib owning the slug-dir layout, creating
// history_keep_runs + 2 run dirs prunes down to history_keep_runs newest, and
// latest points at the just-completed run.
test("test_history_retention", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "write-spec-hist-"));
  try {
    const keep = 2;
    const slug = "retain-test";
    const slugDir = path.join(base, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    // Pre-create keep+1 OLD run dirs (names sort before the 2026 run id).
    const old = ["19990101-000000-aaa", "20000101-000000-bbb", "20010101-000000-ccc"];
    for (const name of old) fs.mkdirSync(path.join(slugDir, name));

    const runId = "20260718-000000-zzz"; // newest — sorts last
    const out = path.join(base, "2026-07-18-retain-test-spec.md");
    const m = mockDeps({ leadDrafts: ["d"], wingReplies: [wingJson(ALL_SATISFIED)] });
    const receipt = await runWriteSpec(
      { out, brief: "b", historyRoot: base, runId, historyKeepRuns: keep },
      m.deps,
    );
    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.run_id, runId);
    assert.equal(receipt.run_dir, path.join(slugDir, runId));

    // Exactly `keep` run dirs remain (latest pointer excluded).
    const remaining = fs
      .readdirSync(slugDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name !== "latest")
      .map((e) => e.name)
      .sort();
    assert.equal(remaining.length, keep, `pruned to ${keep} run dirs`);
    // Newest survivors: our run + the newest pre-existing (ccc).
    assert.deepEqual(remaining, ["20010101-000000-ccc", runId]);

    // latest points at the just-completed run.
    const latest = path.join(slugDir, "latest");
    if (fs.existsSync(latest) && fs.lstatSync(latest).isSymbolicLink()) {
      assert.equal(fs.readlinkSync(latest), runId);
    } else {
      assert.equal(fs.readFileSync(path.join(slugDir, "latest.txt"), "utf8").trim(), runId);
    }

    // The run dir carries rounds.json + brief.md + the terminal receipt.
    const runDir = path.join(slugDir, runId);
    assert.ok(fs.existsSync(path.join(runDir, "rounds.json")));
    assert.ok(fs.existsSync(path.join(runDir, "brief.md")));
    assert.ok(fs.existsSync(path.join(runDir, "receipt.json")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// test_history_write_error_non_fatal — a stubbed history write-failure surfaces
// in persistence_errors and the run STILL returns its verdict, with the FATAL
// spec + terminal receipt written (contrast test_spec_write_failure_is_fatal).
test("test_history_write_error_non_fatal", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const m = mockDeps({ leadDrafts: ["the draft"], wingReplies: [wingJson(ALL_SATISFIED)] });
    // Stub the NON-FATAL history JSON writer to throw. writeArtifacts (FATAL)
    // is a distinct dep and uses the real writer, so it still succeeds.
    const deps: Partial<WriteSpecDeps> = {
      ...m.deps,
      writeHistoryJson: () => {
        throw new Error("history disk full");
      },
    };
    const receipt = await runWriteSpec({ out, brief: "b", runDir: dir }, deps);

    // The run returned its verdict despite the history failures.
    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.ok, true);
    // Persistence errors surfaced (rounds.json + interim receipt.json).
    assert.ok(receipt.persistence_errors.length >= 1, "history failure surfaced");
    assert.ok(
      receipt.persistence_errors.every((e) => e.includes("history disk full")),
      "each error names the stubbed cause",
    );
    // FATAL writes still landed: spec + terminal receipt on disk.
    assert.equal(fs.readFileSync(out, "utf8"), "the draft");
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "receipt.json"), "utf8"));
    assert.equal(persisted.final_verdict, "contract_satisfied");
    assert.ok(persisted.persistence_errors.length >= 1);
  } finally {
    cleanup();
  }
});

// test_dry_run_no_history — a dry run performs ZERO writes: no history dir, no
// spec, no receipt — but still returns its verdict.
test("test_dry_run_no_history", async () => {
  const { dir, out, cleanup } = tmpRun();
  try {
    const runDir = path.join(dir, "nested-run"); // not created by tmpRun
    const m = mockDeps({ leadDrafts: ["a draft"], wingReplies: [wingJson(ALL_SATISFIED)] });
    const receipt = await runWriteSpec(
      { out, brief: "b", runDir, dryRun: true },
      m.deps,
    );
    // Verdict still returned.
    assert.equal(receipt.final_verdict, "contract_satisfied");
    assert.equal(receipt.ok, true);
    // NO history dir, NO spec, NO receipt on disk.
    assert.equal(fs.existsSync(runDir), false, "no history dir created");
    assert.equal(fs.existsSync(out), false, "no spec written");
    assert.equal(receipt.persistence_errors.length, 0, "no history attempted");
  } finally {
    cleanup();
  }
});
