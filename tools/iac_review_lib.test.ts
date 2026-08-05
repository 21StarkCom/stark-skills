import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAgents,
  parseFindings,
  dedupeFindings,
  renderReport,
  buildCodexCmd,
  collectFiles,
  runScanners,
  type IacFinding,
  type IacReviewReceipt,
} from "./iac_review_lib.ts";

test("iac_review --help documents the preview and mandatory consent flags", () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "iac_review.ts");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", cli, "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--dry-run[\s\S]*preview resolved agents \+ selected files/);
  assert.match(result.stdout, /--allow-agent-dispatch[\s\S]*REQUIRED for model dispatch/);
  assert.match(result.stdout, /--trust-source[\s\S]*REQUIRED before scanners\/provider tools/);
  assert.match(result.stdout, /--include-tfvars[\s\S]*separately acknowledge inclusion/);
  assert.match(result.stdout, /--dry-run --no-tools --json/);
  assert.match(result.stdout, /--allow-agent-dispatch --no-tools/);
  assert.match(result.stdout, /--allow-agent-dispatch --trust-source --include-tfvars/);
});

test("collectFiles: tfvars are excluded unless explicitly included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iac-review-files-"));
  try {
    fs.writeFileSync(path.join(dir, "main.tf"), "resource \"x\" \"y\" {}\n");
    fs.writeFileSync(path.join(dir, "secret.tfvars"), "password = \"secret\"\n");
    const safe = collectFiles("terraform", dir, false, 20, 10_000);
    assert.deepEqual(safe.map((f) => f.rel), ["main.tf"]);
    const optedIn = collectFiles("terraform", dir, false, 20, 10_000, true);
    assert.deepEqual(optedIn.map((f) => f.rel), ["main.tf", "secret.tfvars"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanners: untrusted source skips every host scanner", () => {
  const result = runScanners("terraform", ".", false);
  assert.deepEqual(result.ran, []);
  assert.equal(result.report, "");
  assert.ok(result.skipped[0]?.includes("source not trusted"));
});

test("Codex IaC dispatch works outside a git checkout in a read-only sandbox", () => {
  const cmd = buildCodexCmd();
  assert.ok(cmd.args.includes("--skip-git-repo-check"));
  assert.ok(cmd.args.includes("read-only"));
});

test("renderReport: never leaks an absolute local path into the title", () => {
  const receipt: IacReviewReceipt = {
    kind: "terraform",
    target: "/private/tmp/claude-501/abc/scratchpad/devops-infra-pr484/terragrunt/modules/gcp/organization_audit_config",
    agents: ["codex"],
    files_reviewed: ["main.tf"],
    scanners_run: [],
    scanners_skipped: [],
    agent_runs: [{ agent: "codex", model: "gpt-5.5", ok: true, error: null, finding_count: 0, duration_s: 1, api_key_fallback: false }],
    findings: [],
    posted_pr: null,
    posted_ok: null,
    dry_run: false,
  };
  const out = renderReport(receipt);
  assert.ok(!out.includes("/private/tmp"), "must not leak the scratchpad path");
  assert.ok(out.includes("organization_audit_config"), "should keep the meaningful tail");
  assert.ok(out.includes("…/"), "should show a truncated label");
});

test("resolveAgents: CLI overrides config, filters unknown, dedupes, preserves order", () => {
  const { agents, skipped } = resolveAgents(
    ["gemini", "codex", "gemini", "bogus"],
    ["claude"],
  );
  assert.deepEqual(agents, ["gemini", "codex"]);
  assert.ok(skipped.some((s) => s.startsWith("bogus")));
});

test("resolveAgents: falls back to config when no CLI agents", () => {
  const { agents } = resolveAgents(null, ["codex"]);
  assert.deepEqual(agents, ["codex"]);
});

test("resolveAgents: falls back to ['codex'] when neither given", () => {
  const { agents } = resolveAgents(null, undefined);
  assert.deepEqual(agents, ["codex"]);
});

test("parseFindings: extracts trailing JSON array, ignores prose/fences", () => {
  const raw = [
    "Here is my review. I found one issue.",
    "```json",
    '[{"severity":"high","file":"main.tf","line":12,"title":"Public bucket","description":"no PAB","suggestion":"add aws_s3_bucket_public_access_block"}]',
    "```",
    "Done.",
  ].join("\n");
  const f = parseFindings(raw, "codex");
  assert.equal(f.length, 1);
  assert.equal(f[0].agent, "codex");
  assert.equal(f[0].severity, "high");
  assert.equal(f[0].file, "main.tf");
  assert.equal(f[0].line, 12);
});

test("parseFindings: coerces bad severity to medium, drops title-less items, empty array", () => {
  assert.deepEqual(parseFindings("[]", "codex"), []);
  const f = parseFindings(
    '[{"severity":"sev0","title":"x"},{"description":"no title"}]',
    "gemini",
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "medium");
  assert.equal(f[0].line, 0);
});

test("parseFindings: returns [] on garbage", () => {
  assert.deepEqual(parseFindings("no json here", "codex"), []);
  assert.deepEqual(parseFindings("", "codex"), []);
});

test("dedupeFindings: merges same file+title across agents into cross-validated", () => {
  const findings: IacFinding[] = [
    {
      agent: "codex", severity: "high", file: "main.tf", line: 10,
      title: "Public S3 bucket", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "gemini", severity: "critical", file: "main.tf", line: 11,
      title: "Public S3 bucket!", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "codex", severity: "low", file: "variables.tf", line: 3,
      title: "Missing description", description: "", suggestion: "", cross_validated_by: [],
    },
  ];
  const merged = dedupeFindings(findings);
  assert.equal(merged.length, 2);
  // highest severity wins for the merged group, and the other agent is recorded
  const bucket = merged.find((m) => m.file === "main.tf")!;
  assert.equal(bucket.severity, "critical");
  assert.ok(bucket.cross_validated_by.length >= 1);
  // sorted: critical before low
  assert.equal(merged[0].severity, "critical");
});

test("dedupeFindings: collapses cross-agent findings on the exact same file+line despite different titles", () => {
  const findings: IacFinding[] = [
    {
      agent: "gemini", severity: "critical", file: "root.hcl", line: 5,
      title: "Shared state key across units", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "codex", severity: "critical", file: "root.hcl", line: 5,
      title: "Isolate remote state keys per unit", description: "", suggestion: "", cross_validated_by: [],
    },
  ];
  const merged = dedupeFindings(findings);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].cross_validated_by, ["codex"]);
});

test("dedupeFindings: keeps same-agent findings on the same line separate (two real issues)", () => {
  const findings: IacFinding[] = [
    {
      agent: "codex", severity: "high", file: "main.tf", line: 5,
      title: "Missing encryption", description: "", suggestion: "", cross_validated_by: [],
    },
    {
      agent: "codex", severity: "high", file: "main.tf", line: 5,
      title: "Public access not blocked", description: "", suggestion: "", cross_validated_by: [],
    },
  ];
  const merged = dedupeFindings(findings);
  assert.equal(merged.length, 2);
});
