import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  FINDING_SCHEMA_PROMPT,
  findLegacyMarkers,
  listDomainPromptFiles,
  renderDomainPrompt,
  renderDomainPromptFile,
  stripLegacyOutputSection,
} from "./stark_review_lib.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("FINDING_SCHEMA_PROMPT spells out the JSONL/body contract", () => {
  assert.match(FINDING_SCHEMA_PROMPT, /JSONL/);
  for (const field of [
    "id",
    "domain",
    "agent",
    "severity",
    "file",
    "line",
    "title",
    "body",
    "classification",
    "classification_reason",
    "extra",
  ]) {
    assert.match(
      FINDING_SCHEMA_PROMPT,
      new RegExp(`\`${field}\``),
      `schema must mention field \`${field}\``,
    );
  }
  assert.match(FINDING_SCHEMA_PROMPT, /file.*null/);
  assert.match(FINDING_SCHEMA_PROMPT, /line.*null/);
  assert.doesNotMatch(FINDING_SCHEMA_PROMPT, /"description"/);
  assert.doesNotMatch(FINDING_SCHEMA_PROMPT, /"suggestion"/);
});

test("FINDING_SCHEMA_PROMPT requires the no-findings sentinel for clean reviews", () => {
  // The sentinel is the only valid clean-review signal. The contract must
  // (a) name the sentinel key, (b) show the literal example, and (c) NOT tell
  // agents to be silent on no-findings — silence trips the dispatcher's
  // unparseable-stdout check.
  assert.match(FINDING_SCHEMA_PROMPT, /no_findings/, "must mention no_findings");
  assert.match(FINDING_SCHEMA_PROMPT, /"no_findings"\s*:\s*true/, "must show sentinel JSON literal");
  assert.doesNotMatch(
    FINDING_SCHEMA_PROMPT,
    /emit nothing/i,
    "must NOT instruct agents to emit nothing — that triggers tier-1 unparseable",
  );
});

test("stripLegacyOutputSection is idempotent", () => {
  const clean = "# Title\n\nBody only.\n";
  assert.equal(stripLegacyOutputSection(clean), clean);
  const twice = stripLegacyOutputSection(stripLegacyOutputSection(clean));
  assert.equal(twice, clean);
});

test("listDomainPromptFiles finds all 15 NN-*.md prompts (5 domains × 3 agents)", () => {
  const files = listDomainPromptFiles(repoRoot);
  assert.ok(files.length >= 15, `expected ≥15 prompts, got ${files.length}`);
  for (const agent of ["claude", "codex", "gemini"]) {
    const count = files.filter((f) => f.includes(`/global/prompts/${agent}/`)).length;
    assert.ok(count >= 5, `expected ≥5 prompts for ${agent}, got ${count}`);
  }
});

test("rendered domain prompts contain FINDING_SCHEMA_PROMPT", () => {
  for (const file of listDomainPromptFiles(repoRoot)) {
    const rendered = renderDomainPromptFile(file);
    assert.ok(
      rendered.includes(FINDING_SCHEMA_PROMPT),
      `${path.relative(repoRoot, file)} missing canonical schema`,
    );
  }
});

test("rendered domain prompts contain zero legacy schema markers", () => {
  const offenders: string[] = [];
  for (const file of listDomainPromptFiles(repoRoot)) {
    const rendered = renderDomainPromptFile(file);
    // Strip out the canonical schema before scanning — its allowed mentions of
    // "description" as a field name would otherwise be flagged.
    const withoutSchema = rendered.replace(FINDING_SCHEMA_PROMPT, "");
    const hits = findLegacyMarkers(withoutSchema);
    if (hits.length) {
      offenders.push(`${path.relative(repoRoot, file)}: ${hits.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [], `legacy markers leaked into rendered prompts:\n${offenders.join("\n")}`);
});

test("renderDomainPrompt strips claude-style ## Output section", () => {
  const input = `# Domain X\n\nBody body body.\n\n## Output\n\`\`\`json\n[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]\n\`\`\`\nJSON array only. No other text. Empty array \`[]\` if clean.\n`;
  const out = renderDomainPrompt(input);
  assert.ok(!out.includes("## Output"));
  assert.ok(!out.includes('"description"'));
  assert.ok(out.includes("Body body body"));
  assert.ok(out.includes(FINDING_SCHEMA_PROMPT));
});

test("renderDomainPrompt strips codex-style 'Output a JSON array only:' section", () => {
  const input = `# Domain X\n\nBody.\n\nSeverities: critical = ...\n\nOutput a JSON array only:\n[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]\nEmpty array [] if clean. No other text.\n`;
  const out = renderDomainPrompt(input);
  assert.ok(!out.includes("Output a JSON array only"));
  assert.ok(!out.includes('"suggestion"'));
  assert.ok(out.includes(FINDING_SCHEMA_PROMPT));
});

test("renderDomainPrompt strips gemini-style IMPORTANT: Output section", () => {
  const input = `# Domain X\n\nBody.\n\n- low: foo\n\nIMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences.\n\n[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]\n\nIf no issues found, output exactly: []\n`;
  const out = renderDomainPrompt(input);
  assert.ok(!out.includes("IMPORTANT: Output ONLY"));
  assert.ok(!out.includes('"description"'));
  assert.ok(out.includes(FINDING_SCHEMA_PROMPT));
});

test("renderDomainPrompt strips codex spec-conformance 'Output:' fenced block", () => {
  const input = `# Domain X\n\nBody.\n\nSeverity: ...\n\nOutput:\n\`\`\`json\n[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]\n\`\`\`\nJSON array only. Empty array \`[]\` if clean.\n`;
  const out = renderDomainPrompt(input);
  assert.ok(!out.match(/\nOutput:\s*\n```json/));
  assert.ok(!out.includes('"description"'));
  assert.ok(out.includes(FINDING_SCHEMA_PROMPT));
});
