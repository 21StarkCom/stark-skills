#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectSharedRefs,
  countWords,
  discoverSkillBundles,
  findRepoRoot,
  loadBundleFiles,
  rel,
  resolveSkillTarget,
  type SkillBundle,
} from "./skill_lib.ts";
import {
  assertCrossBundleConsistency,
  decodeRewriteProposal,
  extractOutputText,
  findStaleBundleFile,
  validateProposal,
  type RewriteAction,
  type RewriteProposal,
} from "./skill_validate.ts";

type Mode = "api" | "plan";
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

type CliOptions = {
  apply: boolean;
  apiTimeoutMs: number;
  diff: boolean;
  mode: Mode;
  model: string;
  outDir: string;
  pollIntervalMs: number;
  reasoningEffort: ReasoningEffort;
  reuseProposal: boolean;
  skillTargets: string[];
  maxOutputTokens: number;
};

type BundleRunSummary = {
  skillPath: string;
  artifactDir: string;
  diffPath?: string;
  mode: Mode;
  applied: boolean;
  proposalPath?: string;
  proposalSummaryPath?: string;
  changedFiles: Array<{
    path: string;
    action: RewriteAction;
    beforeWords: number;
    afterWords: number;
    deltaWords: number;
  }>;
  refsRemoved: string[];
  warnings: string[];
};

const repoRoot = findRepoRoot(process.cwd());
const options = parseArgs(process.argv.slice(2));

// Fail closed when the ancestor walk didn't actually find a .git/ — that
// means findRepoRoot returned the bogus fallback (cwd). Without this a
// caller running from anywhere would pass through the "inside repo root"
// check because repoRoot === cwd trivially.
if (!fs.existsSync(path.join(repoRoot, ".git"))) {
  throw new Error(
    `skill_optimize must run from inside a git repository; ` +
      `no .git/ found walking up from ${process.cwd()}.`,
  );
}

// And the CWD must still be inside that repo root (defense in depth).
{
  const cwdReal = fs.realpathSync(process.cwd());
  const repoRootReal = fs.realpathSync(repoRoot);
  if (
    !cwdReal.startsWith(repoRootReal + path.sep) &&
    cwdReal !== repoRootReal
  ) {
    throw new Error(
      `skill_optimize must run from inside the repo root (${repoRootReal}); ` +
        `current directory is ${cwdReal}.`,
    );
  }
}

// Require --mode api + an explicit --skill target to avoid accidentally
// uploading every discovered bundle to the Responses API. Plan mode can
// still operate on all bundles because it never makes a network call.
if (options.mode === "api" && !options.skillTargets.length) {
  throw new Error(
    "--mode api requires at least one --skill or --skills target " +
      "(prevents uploading every repo skill to the Responses API).",
  );
}

const bundles = discoverSkillBundles(repoRoot);
const selectedBundles = selectBundles(bundles, options.skillTargets);
const selectedSkillPaths = new Set(selectedBundles.map((bundle) => bundle.skillPath));
const sharedRefOwners = new Map<string, string[]>();
for (const { ref, skills } of collectSharedRefs(bundles)) {
  sharedRefOwners.set(ref, skills);
}
// Snapshot every selected bundle's files up front so that an earlier apply
// pass cannot delete a shared ref that a later bundle still needs to load.
// Without this, `--apply` across multi-bundle runs can crash mid-iteration.
const bundleFilesSnapshot = new Map<string, Array<{ path: string; content: string }>>();
// Capture the pre-run mtime of every source file so that later bundles'
// staleness checks compare against the PRE-apply state, not a mtime that
// was just updated by an earlier bundle's own apply step.
const preRunMtimes = new Map<string, number>();
for (const bundle of selectedBundles) {
  bundleFilesSnapshot.set(bundle.skillPath, loadBundleFiles(repoRoot, bundle));
  for (const file of bundleFilesSnapshot.get(bundle.skillPath) ?? []) {
    const abs = path.join(repoRoot, file.path);
    if (fs.existsSync(abs) && !preRunMtimes.has(file.path)) {
      preRunMtimes.set(file.path, fs.statSync(abs).mtimeMs);
    }
  }
}
const runSummaries: BundleRunSummary[] = [];
type PendingApply = { bundle: SkillBundle; proposal: RewriteProposal };
const pendingApplies: PendingApply[] = [];

for (const bundle of selectedBundles) {
  const { summary, proposal } = await processBundle(bundle, options);
  runSummaries.push(summary);
  if (options.apply && proposal) {
    pendingApplies.push({ bundle, proposal });
  }
}

if (options.apply && pendingApplies.length > 0) {
  // Cross-bundle consistency check before any disk mutation: two bundles
  // that share a ref must propose the SAME update content or both agree
  // on delete. Without this a sequential apply silently clobbers the
  // earlier bundle's edit.
  assertCrossBundleConsistency(
    pendingApplies.map((p) => ({ skillPath: p.bundle.skillPath, proposal: p.proposal })),
  );
  for (const { proposal } of pendingApplies) {
    applyProposal(proposal);
  }
  for (const summary of runSummaries) {
    if (summary.proposalPath) summary.applied = true;
  }
}

writeRunSummary(repoRoot, options.outDir, options, runSummaries);

console.log(
  JSON.stringify(
    {
      repoRoot,
      mode: options.mode,
      apply: options.apply,
      bundles: runSummaries,
    },
    null,
    2,
  ),
);

function assertInsideRepo(target: string, label: string): void {
  const repoRootReal = fs.realpathSync(repoRoot);
  let existingAncestor = target;
  const missingParts: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    missingParts.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const ancestorReal = fs.existsSync(existingAncestor)
    ? fs.realpathSync(existingAncestor)
    : existingAncestor;
  const resolvedReal = missingParts.length
    ? path.join(ancestorReal, ...missingParts)
    : ancestorReal;
  if (
    !resolvedReal.startsWith(repoRootReal + path.sep) &&
    resolvedReal !== repoRootReal
  ) {
    throw new Error(`${label} escapes the repo root: ${target}`);
  }
}

async function processBundle(
  bundle: SkillBundle,
  options: CliOptions,
): Promise<{ summary: BundleRunSummary; proposal: RewriteProposal | null }> {
  // Use the up-front snapshot so that a prior apply pass cannot affect the
  // file contents visible to this bundle's validation/diff generation.
  const bundleFiles = bundleFilesSnapshot.get(bundle.skillPath)
    ?? loadBundleFiles(repoRoot, bundle);
  const artifactDir = path.join(
    repoRoot,
    options.outDir,
    path.basename(path.dirname(bundle.skillPath)),
  );
  assertInsideRepo(artifactDir, "artifact directory");
  fs.mkdirSync(artifactDir, { recursive: true });

  const manifest = {
    repoRoot,
    skill: bundle.skillPath,
    refs: bundle.refs,
    missingRefs: bundle.missingRefs,
    files: bundleFiles.map((file) => ({
      path: file.path,
      words: countWords(file.content),
      lines: file.content.split(/\r?\n/).length,
    })),
  };
  writeUtf8(path.join(artifactDir, "bundle.json"), JSON.stringify(manifest, null, 2));

  if (options.mode === "plan") {
    writeUtf8(path.join(artifactDir, "rewrite-request.md"), buildRewriteRequest(bundle, bundleFiles));
    return {
      summary: {
        skillPath: bundle.skillPath,
        artifactDir: rel(repoRoot, artifactDir),
        mode: options.mode,
        applied: false,
        changedFiles: [],
        refsRemoved: [],
        warnings: ["Plan mode only: no proposal generated."],
      },
      proposal: null,
    };
  }

  const proposalPath = path.join(artifactDir, "proposal.json");
  const proposal = options.reuseProposal
    ? loadExistingProposal(proposalPath, bundleFiles)
    : await requestProposal(bundle, bundleFiles, options);
  validateProposal(bundle, proposal, bundleFiles, sharedRefOwners, selectedSkillPaths);
  if (!options.reuseProposal) {
    persistProposal(artifactDir, bundle, proposal);
  }
  const diffPath = path.join(artifactDir, "proposal.diff");
  const diffText = generateProposalDiff(bundleFiles, proposal);
  writeUtf8(diffPath, diffText);

  if (options.diff && diffText.trim()) {
    console.error(diffText);
  }

  const changedFiles = proposal.changes
    .filter((change) => change.action !== "keep")
    .map((change) => {
      const beforeContent =
        change.action === "delete"
          ? readExisting(change.path)
          : bundleFiles.find((file) => file.path === change.path)?.content ?? "";
      const afterContent = change.action === "update" ? change.content ?? "" : "";
      return {
        path: change.path,
        action: change.action,
        beforeWords: countWords(beforeContent),
        afterWords: countWords(afterContent),
        deltaWords: countWords(afterContent) - countWords(beforeContent),
      };
    });

  // Apply is deferred — the top-level loop runs cross-bundle consistency
  // over every selected bundle's proposal and then applies them together.
  return {
    summary: {
      skillPath: bundle.skillPath,
      artifactDir: rel(repoRoot, artifactDir),
      diffPath: rel(repoRoot, diffPath),
      mode: options.mode,
      applied: false,
      proposalPath: rel(repoRoot, proposalPath),
      proposalSummaryPath: rel(repoRoot, path.join(artifactDir, "proposal-summary.md")),
      changedFiles,
      refsRemoved: proposal.refs_removed,
      warnings: proposal.warnings,
    },
    proposal,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    apiTimeoutMs: 180000,
    diff: false,
    // Default to plan mode so a bare `skill_optimize` invocation never
    // uploads bundle contents off-box. API mode is explicit: `--mode api`.
    mode: "plan",
    model: "gpt-5.4-pro",
    outDir: "artifacts/skill-optimizer",
    pollIntervalMs: 5000,
    reasoningEffort: "medium",
    reuseProposal: false,
    skillTargets: [],
    maxOutputTokens: 16000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--diff") {
      options.diff = true;
      continue;
    }
    if (arg === "--reuse-proposal") {
      options.reuseProposal = true;
      continue;
    }
    if (arg === "--api-timeout-ms") {
      options.apiTimeoutMs = Number.parseInt(
        readValue(argv, ++index, "--api-timeout-ms"),
        10,
      );
      continue;
    }
    if (arg === "--mode") {
      const modeValue = readValue(argv, ++index, "--mode");
      if (modeValue !== "api" && modeValue !== "plan") {
        throw new Error(`--mode must be "api" or "plan", got "${modeValue}"`);
      }
      options.mode = modeValue;
      continue;
    }
    if (arg === "--skill") {
      options.skillTargets.push(readValue(argv, ++index, "--skill"));
      continue;
    }
    if (arg === "--skills") {
      options.skillTargets.push(
        ...readValue(argv, ++index, "--skills")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      continue;
    }
    if (arg === "--model") {
      options.model = readValue(argv, ++index, "--model");
      continue;
    }
    if (arg === "--out-dir") {
      const raw = readValue(argv, ++index, "--out-dir");
      const resolved = path.resolve(repoRoot, raw);
      const repoRootReal = fs.realpathSync(repoRoot);
      // Walk upward from resolved until we find an existing ancestor, then
      // take its realpath and rejoin the non-existing suffix. Without this,
      // a path like `symlinked-dir/new-run` where `symlinked-dir` is an
      // in-repo symlink to /tmp would pass by accident because the leaf
      // doesn't exist yet.
      let existingAncestor = resolved;
      const missingParts: string[] = [];
      while (!fs.existsSync(existingAncestor)) {
        missingParts.unshift(path.basename(existingAncestor));
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) break;
        existingAncestor = parent;
      }
      const ancestorReal = fs.existsSync(existingAncestor)
        ? fs.realpathSync(existingAncestor)
        : existingAncestor;
      const resolvedReal = missingParts.length
        ? path.join(ancestorReal, ...missingParts)
        : ancestorReal;
      if (
        !resolvedReal.startsWith(repoRootReal + path.sep) &&
        resolvedReal !== repoRootReal
      ) {
        throw new Error(`--out-dir must stay inside the repo root: ${raw}`);
      }
      options.outDir = path.relative(repoRoot, resolvedReal) || ".";
      continue;
    }
    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Number.parseInt(
        readValue(argv, ++index, "--poll-interval-ms"),
        10,
      );
      continue;
    }
    if (arg === "--reasoning-effort") {
      const effort = readValue(argv, ++index, "--reasoning-effort");
      const allowed: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
      if (!allowed.includes(effort as ReasoningEffort)) {
        throw new Error(`--reasoning-effort must be one of: ${allowed.join(", ")}, got "${effort}"`);
      }
      options.reasoningEffort = effort as ReasoningEffort;
      continue;
    }
    if (arg === "--max-output-tokens") {
      options.maxOutputTokens = Number.parseInt(
        readValue(argv, ++index, "--max-output-tokens"),
        10,
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
    throw new Error("--max-output-tokens must be a positive integer");
  }
  if (!Number.isFinite(options.apiTimeoutMs) || options.apiTimeoutMs <= 0) {
    throw new Error("--api-timeout-ms must be a positive integer");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive integer");
  }

  if (options.mode === "api" && !options.reuseProposal && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for --mode api (not needed with --reuse-proposal)");
  }
  if (
    options.mode === "api" &&
    options.model === "gpt-5.4-pro" &&
    options.reasoningEffort === "low"
  ) {
    throw new Error("gpt-5.4-pro supports reasoning effort: medium, high, xhigh");
  }

  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function selectBundles(
  bundles: SkillBundle[],
  targets: string[],
): SkillBundle[] {
  if (!targets.length) {
    return bundles;
  }
  return targets.map((target) => resolveSkillTarget(repoRoot, bundles, target));
}

async function requestProposal(
  bundle: SkillBundle,
  bundleFiles: Array<{ path: string; content: string }>,
  options: CliOptions,
): Promise<RewriteProposal> {
  const schema = buildProposalSchema(bundleFiles.map((file) => file.path), bundle.refs);
  const requestBody = {
    background: true,
    model: options.model,
    reasoning: {
      effort: options.reasoningEffort,
    },
    max_output_tokens: options.maxOutputTokens,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "Rewrite only the provided skill bundle files.",
              "Make them shorter, sharper, and internally consistent.",
              "Keep commands, paths, flags, frontmatter keys, and safety-critical rules exact.",
              "SKILL.md is the authoritative contract; delete redundant references when safe.",
              "Do not invent repo facts or touch paths outside the allowed set.",
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildRewriteRequest(bundle, bundleFiles),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "skill_bundle_rewrite",
        strict: true,
        schema,
      },
    },
  };

  const deadline = Date.now() + options.apiTimeoutMs;
  let payload = await openaiFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify(requestBody),
  }, Math.max(deadline - Date.now(), 5000));
  console.error(
    `[skill_optimize] submitted ${bundle.skillPath} -> ${payload.id} (${payload.status ?? "unknown"})`,
  );

  let lastStatus = payload.status;
  while (!isTerminalStatus(payload.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`OpenAI background response timed out after ${options.apiTimeoutMs}ms`);
    }
    await sleep(Math.min(options.pollIntervalMs, Math.max(deadline - Date.now(), 0)));
    payload = await openaiFetch(
      `https://api.openai.com/v1/responses/${payload.id}`,
      {
        method: "GET",
        headers: openAiHeaders(),
      },
      Math.max(deadline - Date.now(), 5000),
    );
    if (payload.status !== lastStatus) {
      console.error(
        `[skill_optimize] ${payload.id} status ${lastStatus ?? "unknown"} -> ${payload.status ?? "unknown"}`,
      );
      lastStatus = payload.status;
    }
  }
  console.error(`[skill_optimize] ${payload.id} completed with status ${payload.status}`);

  if (payload.status !== "completed") {
    throw new Error(
      `OpenAI response did not complete successfully: ${payload.status} ${JSON.stringify(payload.error ?? {})}`,
    );
  }
  const outputText = extractOutputText(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`Failed to parse proposal JSON: ${(error as Error).message}\n${outputText}`);
  }
  return decodeRewriteProposal(parsed);
}

function generateProposalDiff(
  bundleFiles: Array<{ path: string; content: string }>,
  proposal: RewriteProposal,
): string {
  const beforeMap = new Map(bundleFiles.map((file) => [file.path, file.content]));
  const chunks: string[] = [];

  for (const change of proposal.changes) {
    if (change.action === "keep") {
      continue;
    }
    const beforeContent = beforeMap.get(change.path) ?? "";
    const afterContent = change.action === "delete" ? "" : change.content ?? "";
    if (beforeContent === afterContent) {
      continue;
    }
    chunks.push(diffText(change.path, beforeContent, afterContent, change.action));
  }

  return chunks.join("\n");
}

function persistProposal(
  artifactDir: string,
  bundle: SkillBundle,
  proposal: RewriteProposal,
): void {
  writeUtf8(
    path.join(artifactDir, "proposal.json"),
    JSON.stringify(proposal, null, 2),
  );
  writeUtf8(path.join(artifactDir, "proposal-summary.md"), renderProposalSummary(bundle, proposal));
  writeProposalFiles(artifactDir, proposal);
}

function buildProposalSchema(allowedPaths: string[], refPaths: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "bundle_summary",
      "global_notes",
      "changes",
      "refs_kept",
      "refs_removed",
      "contradictions_resolved",
      "terminology_normalizations",
      "warnings",
    ],
    properties: {
      bundle_summary: { type: "string" },
      global_notes: {
        type: "array",
        items: { type: "string" },
      },
      changes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "action", "summary", "content"],
          properties: {
            path: { type: "string", enum: allowedPaths },
            action: { type: "string", enum: ["update", "delete", "keep"] },
            summary: { type: "string" },
            content: { type: "string" },
          },
        },
      },
      refs_kept: {
        type: "array",
        items: refPaths.length ? { type: "string", enum: refPaths } : { type: "string" },
      },
      refs_removed: {
        type: "array",
        items: refPaths.length ? { type: "string", enum: refPaths } : { type: "string" },
      },
      contradictions_resolved: {
        type: "array",
        items: { type: "string" },
      },
      terminology_normalizations: {
        type: "array",
        items: { type: "string" },
      },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}

function buildRewriteRequest(
  bundle: SkillBundle,
  bundleFiles: Array<{ path: string; content: string }>,
): string {
  const sections = [
    "# Rewrite brief",
    "",
    `Skill: ${bundle.skillPath}`,
    `References: ${bundle.refs.length ? bundle.refs.join(", ") : "(none)"}`,
    "",
    "Target state:",
    "- Shorter and easier to execute.",
    "- Consistent structure and terminology.",
    "- No duplicated caveats or contradictory instructions.",
    "- Reference docs kept only if they clearly add unique value.",
    "",
    "Rules:",
    "- Operate only on the allowed files below.",
    "- Preserve YAML frontmatter keys when present.",
    "- Keep commands, paths, literals, and non-obvious constraints intact.",
    "- If a reference doc is redundant, delete it and absorb the needed content elsewhere in the bundle.",
    "- Keep markdown link targets valid after the rewrite.",
    "- Prefer imperative instructions over explanation.",
    "",
    "Allowed files:",
    ...bundleFiles.map((file) => `- ${file.path}`),
    "",
    "Current files:",
    ...bundleFiles.flatMap((file) => {
      let fence = "```";
      while (file.content.includes(fence)) {
        fence += "`";
      }
      return [
        `## FILE: ${file.path}`,
        `${fence}md`,
        file.content.trimEnd(),
        fence,
        "",
      ];
    }),
  ];
  return sections.join("\n");
}

function loadExistingProposal(
  proposalPath: string,
  bundleFiles: Array<{ path: string; content: string }>,
): RewriteProposal {
  if (!fs.existsSync(proposalPath)) {
    throw new Error(`No existing proposal found at ${rel(repoRoot, proposalPath)}`);
  }
  const proposalMtime = fs.statSync(proposalPath).mtimeMs;
  // Compare against the pre-run mtime when available so an earlier bundle's
  // own apply step can't bump the live mtime and trigger a false stale.
  const stale = findStaleBundleFile(
    proposalMtime,
    bundleFiles.map((f) => f.path),
    (relPath) => {
      const pre = preRunMtimes.get(relPath);
      if (pre !== undefined) return pre;
      const abs = path.join(repoRoot, relPath);
      return fs.existsSync(abs) ? fs.statSync(abs).mtimeMs : null;
    },
  );
  if (stale.stale) {
    const verb = stale.reason === "deleted" ? "was deleted" : "was modified";
    throw new Error(
      `Refusing to reuse proposal: ${stale.path} ${verb} after the proposal was generated. ` +
        "Rerun without --reuse-proposal or regenerate the proposal.",
    );
  }
  return decodeRewriteProposal(JSON.parse(fs.readFileSync(proposalPath, "utf8")));
}

function diffText(
  filePath: string,
  beforeContent: string,
  afterContent: string,
  action: RewriteAction,
): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-opt-diff-"));
  const beforePath = path.join(tempDir, "before.md");
  const afterPath = path.join(tempDir, "after.md");
  writeUtf8(beforePath, beforeContent);
  writeUtf8(afterPath, afterContent);

  try {
    return execFileSync(
      "diff",
      [
        "-u",
        "--label",
        `a/${filePath}`,
        "--label",
        `${action === "delete" ? "/dev/null" : `b/${filePath}`}`,
        beforePath,
        afterPath,
      ],
      { encoding: "utf8" },
    );
  } catch (error: any) {
    if (typeof error?.stdout === "string" && error.stdout) {
      return error.stdout;
    }
    throw error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function openAiHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

type ResponsesPayload = {
  id: string;
  status?: string;
  error?: unknown;
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

async function openaiFetch(
  url: string,
  init: RequestInit,
  timeoutMs = 30000,
): Promise<ResponsesPayload> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API request failed: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as unknown;
  if (typeof json !== "object" || json === null || typeof (json as Record<string, unknown>).id !== "string") {
    throw new Error("Responses API did not return an object with an id");
  }
  return json as ResponsesPayload;
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "incomplete";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function writeProposalFiles(artifactDir: string, proposal: RewriteProposal): void {
  const proposedRoot = path.join(artifactDir, "proposed");
  for (const change of proposal.changes) {
    if (change.action !== "update") {
      continue;
    }
    const outputPath = path.join(proposedRoot, change.path);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writeUtf8(outputPath, change.content ?? "");
  }
}

function applyProposal(proposal: RewriteProposal): void {
  const repoRootReal = fs.realpathSync(repoRoot);
  for (const change of proposal.changes) {
    const outputPath = path.join(repoRoot, change.path);
    // Reject symlinked targets — writing/deleting would affect an external file.
    if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink()) {
      throw new Error(`Refusing to apply: ${change.path} is a symlink`);
    }
    // Walk upward to the first existing ancestor, realpath THAT, and rejoin
    // the non-existing suffix. Without this, a symlinked intermediate
    // directory (e.g. `skill/x -> /tmp/evil`) would pass the parent-dir
    // check when the leaf doesn't exist yet, and mkdirSync(recursive) would
    // follow the symlink out of the repo before writing.
    let existingAncestor = outputPath;
    const missingParts: string[] = [];
    while (!fs.existsSync(existingAncestor)) {
      missingParts.unshift(path.basename(existingAncestor));
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    const ancestorReal = fs.existsSync(existingAncestor)
      ? fs.realpathSync(existingAncestor)
      : existingAncestor;
    const resolvedReal = missingParts.length
      ? path.join(ancestorReal, ...missingParts)
      : ancestorReal;
    if (
      !resolvedReal.startsWith(repoRootReal + path.sep) &&
      resolvedReal !== repoRootReal
    ) {
      throw new Error(`Refusing to apply: ${change.path} escapes the repo root`);
    }
    if (change.action === "delete") {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      continue;
    }
    if (change.action === "update") {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      writeUtf8(outputPath, change.content ?? "");
    }
  }
}

function renderProposalSummary(
  bundle: SkillBundle,
  proposal: RewriteProposal,
): string {
  const lines = [
    `# Proposal Summary: ${bundle.skillPath}`,
    "",
    proposal.bundle_summary,
    "",
    "## Changes",
    ...proposal.changes.map((change) => `- \`${change.action}\` \`${change.path}\` — ${change.summary}`),
    "",
    "## Contradictions Resolved",
    ...(proposal.contradictions_resolved.length
      ? proposal.contradictions_resolved.map((item) => `- ${item}`)
      : ["- None called out."]),
    "",
    "## Terminology",
    ...(proposal.terminology_normalizations.length
      ? proposal.terminology_normalizations.map((item) => `- ${item}`)
      : ["- None called out."]),
    "",
    "## Notes",
    ...(proposal.global_notes.length
      ? proposal.global_notes.map((item) => `- ${item}`)
      : ["- None."]),
    "",
    "## Warnings",
    ...(proposal.warnings.length
      ? proposal.warnings.map((item) => `- ${item}`)
      : ["- None."]),
  ];
  return `${lines.join("\n")}\n`;
}

function writeRunSummary(
  repoRoot: string,
  outDir: string,
  options: CliOptions,
  bundles: BundleRunSummary[],
): void {
  const absoluteOutDir = path.join(repoRoot, outDir);
  fs.mkdirSync(absoluteOutDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  const runsDir = path.join(absoluteOutDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  const runSummary = {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    apply: options.apply,
    diff: options.diff,
    bundleCount: bundles.length,
    bundles,
  };

  const summaryJson = JSON.stringify(runSummary, null, 2);
  writeUtf8(path.join(absoluteOutDir, "run-summary.json"), summaryJson);
  writeUtf8(path.join(runsDir, `${timestamp}.json`), summaryJson);

  const lines = [
    "# Skill Optimizer Run Summary",
    "",
    `- Generated: ${runSummary.generatedAt}`,
    `- Mode: ${options.mode}`,
    `- Apply: ${options.apply ? "yes" : "no"}`,
    `- Diff requested: ${options.diff ? "yes" : "no"}`,
    `- Bundles: ${bundles.length}`,
    "",
    "## Bundles",
  ];

  for (const bundle of bundles) {
    lines.push(`### ${bundle.skillPath}`);
    lines.push(`- Artifact dir: \`${bundle.artifactDir}\``);
    if (bundle.proposalPath) {
      lines.push(`- Proposal: \`${bundle.proposalPath}\``);
    }
    if (bundle.proposalSummaryPath) {
      lines.push(`- Proposal summary: \`${bundle.proposalSummaryPath}\``);
    }
    if (bundle.diffPath) {
      lines.push(`- Diff: \`${bundle.diffPath}\``);
    }
    lines.push(`- Applied: ${bundle.applied ? "yes" : "no"}`);
    if (bundle.changedFiles.length) {
      lines.push("- Changed files:");
      for (const change of bundle.changedFiles) {
        lines.push(
          `  - \`${change.action}\` \`${change.path}\` (${change.beforeWords}w -> ${change.afterWords}w, delta ${change.deltaWords})`,
        );
      }
    } else {
      lines.push("- Changed files: none");
    }
    if (bundle.warnings.length) {
      lines.push("- Warnings:");
      for (const warning of bundle.warnings) {
        lines.push(`  - ${warning}`);
      }
    }
    lines.push("");
  }

  const summaryMd = `${lines.join("\n")}\n`;
  writeUtf8(path.join(absoluteOutDir, "run-summary.md"), summaryMd);
  writeUtf8(path.join(runsDir, `${timestamp}.md`), summaryMd);
}

function readExisting(filePath: string): string {
  const absolutePath = path.join(repoRoot, filePath);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
}

function writeUtf8(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}
