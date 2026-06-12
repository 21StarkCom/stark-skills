#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectSharedRefs,
  countWords,
  detectFileKind,
  discoverSkillBundles,
  findRepoRoot,
  inspectLocalRefs,
  loadBundleFiles,
  rel,
  resolveSkillTarget,
  type BundleFile,
  type SkillBundle,
} from "./skill_lib.ts";
import {
  assertCrossBundleConsistency,
  assertSharedDeletedRefsRemoved,
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
  validationPath?: string;
  validationSummaryPath?: string;
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

type ValidationReport = {
  ok: boolean;
  frontmatter: Array<{
    path: string;
    ok: boolean;
    missingKeys: string[];
  }>;
  refs: Array<{
    path: string;
    ok: boolean;
    missing: string[];
  }>;
  pythonSyntax: Array<{
    path: string;
    ok: boolean;
    error?: string;
  }>;
  errors: string[];
};

// Module-level repoRoot is populated only when `main()` runs. Tests import
// this file to exercise planProposalApply/commitStagedOps without running
// the full CLI, so top-level code must not access process.argv / throw on
// a bad cwd. Per-run state (file snapshots, mtimes, selection) lives in a
// local RunState inside main() and flows into helpers as parameters —
// keeping the optimizer's data-flow explicit instead of leaning on hidden
// module globals.
let repoRoot: string;

type RunState = {
  bundleFilesSnapshot: Map<string, BundleFile[]>;
  preRunMtimes: Map<string, number>;
  selectedSkillPaths: Set<string>;
};

async function main(): Promise<void> {
  // findRepoRoot returns null when no ancestor has .git/, so the type
  // system forces an explicit guard here instead of relying on a follow-up
  // existsSync check that could drift out of sync with the resolver.
  const resolvedRoot = findRepoRoot(process.cwd());
  if (resolvedRoot === null) {
    throw new Error(
      `skill_optimize must run from inside a git repository; ` +
        `no .git/ found walking up from ${process.cwd()}.`,
    );
  }
  repoRoot = resolvedRoot;
  const options = parseArgs(process.argv.slice(2));

  // And the CWD must still be inside that repo root (defense in depth).
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

  const bundles = discoverSkillBundles(repoRoot);
  const selectedBundles = selectBundles(bundles, options.skillTargets);
  const sharedRefOwners = new Map<string, string[]>();
  for (const { ref, skills } of collectSharedRefs(bundles)) {
    sharedRefOwners.set(ref, skills);
  }
  // Snapshot every selected bundle's files up front so that an earlier apply
  // pass cannot delete a shared ref that a later bundle still needs to load.
  // Without this, `--apply` across multi-bundle runs can crash mid-iteration.
  const runState: RunState = {
    bundleFilesSnapshot: new Map(),
    preRunMtimes: new Map(),
    selectedSkillPaths: new Set(selectedBundles.map((b) => b.skillPath)),
  };
  for (const bundle of selectedBundles) {
    runState.bundleFilesSnapshot.set(
      bundle.skillPath,
      loadBundleFiles(repoRoot, bundle),
    );
    for (const file of runState.bundleFilesSnapshot.get(bundle.skillPath) ?? []) {
      const abs = path.join(repoRoot, file.path);
      if (fs.existsSync(abs) && !runState.preRunMtimes.has(file.path)) {
        runState.preRunMtimes.set(file.path, fs.statSync(abs).mtimeMs);
      }
    }
  }
  const runSummaries: BundleRunSummary[] = [];
  type BundleProposalPair = { bundle: SkillBundle; proposal: RewriteProposal };
  const pendingProposals: BundleProposalPair[] = [];

  for (const bundle of selectedBundles) {
    const { summary, proposal } = await processBundle(
      bundle,
      options,
      sharedRefOwners,
      runState,
    );
    runSummaries.push(summary);
    if (proposal) {
      pendingProposals.push({ bundle, proposal });
    }
  }

  // Run cross-bundle invariants regardless of --apply so dry runs surface
  // multi-bundle conflicts (conflicting shared-ref updates, dangling co-owner
  // links after a delete) before the user re-runs with --apply.
  const pendingEntries = pendingProposals.map((p) => ({
    skillPath: p.bundle.skillPath,
    proposal: p.proposal,
  }));
  const ownerSkillContents = new Map<string, string>();
  for (const bundle of selectedBundles) {
    const files = runState.bundleFilesSnapshot.get(bundle.skillPath) ?? [];
    const skillFile = files.find(
      (f: { path: string }) => f.path === bundle.skillPath,
    );
    if (skillFile) ownerSkillContents.set(bundle.skillPath, skillFile.content);
  }
  if (pendingEntries.length > 1) {
    assertCrossBundleConsistency(pendingEntries);
    assertSharedDeletedRefsRemoved(pendingEntries, sharedRefOwners, ownerSkillContents);
  }

  // Build ownerSkillContents once in a scope the apply block also reuses.
  if (options.apply && pendingProposals.length > 0) {
    const pendingApplies = pendingProposals;
    // Two-phase apply: stage every write under artifacts/skill-optimizer/
    // apply-staging first, then atomically swap them into place. A phase-1
    // error aborts without mutating the repo. A phase-2 error preserves the
    // staging dir so an operator can finish recovery by hand.
    const stagingRoot = path.join(repoRoot, options.outDir, "apply-staging");
    // A previous failed apply leaves the staging dir in place for manual
    // recovery and drops a `.recovery` marker. Refuse to wipe it so the
    // next run can't destroy the only record of partially committed work.
    const recoveryMarker = path.join(stagingRoot, ".recovery");
    if (fs.existsSync(recoveryMarker)) {
      throw new Error(
        `Refusing to start a new apply: recovery dir from an earlier ` +
          `failed run exists at ${stagingRoot}. Inspect the contents ` +
          `and remove ${recoveryMarker} (and the dir) once triaged.`,
      );
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });
    let plannedOps: StagedOp[][];
    try {
      plannedOps = pendingApplies.map(({ proposal }) =>
        planProposalApply(proposal, stagingRoot, repoRoot),
      );
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    // Dedupe targets across bundles: cross-bundle consistency has already
    // verified duplicate writes carry identical content and deletes agree,
    // so we only commit the first op for each target. Without this two
    // bundles that share a ref both stage the same file, but the second
    // rename fails with ENOENT after the first commit consumes the stage.
    const seenTargets = new Set<string>();
    const dedupedOps: StagedOp[] = [];
    for (const ops of plannedOps) {
      for (const op of ops) {
        if (seenTargets.has(op.target)) continue;
        seenTargets.add(op.target);
        dedupedOps.push(op);
      }
    }
    try {
      commitStagedOps(dedupedOps, repoRoot);
    } catch (error) {
      // Drop a marker so the next run refuses to wipe this dir until the
      // operator has actually triaged the partial commit. Marker contents
      // include the error so "why is this here?" doesn't require grep-ing
      // stderr logs from a previous run.
      try {
        fs.writeFileSync(
          recoveryMarker,
          JSON.stringify(
            {
              failed_at: new Date().toISOString(),
              error: (error as Error).message,
            },
            null,
            2,
          ),
        );
      } catch {
        // If we can't even drop the marker the dir is useless anyway.
      }
      console.error(
        `[skill_optimize] apply failed mid-commit; staging dir left for ` +
          `manual recovery: ${stagingRoot}`,
      );
      throw error;
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
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
}

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
  sharedRefOwners: Map<string, string[]>,
  runState: RunState,
): Promise<{ summary: BundleRunSummary; proposal: RewriteProposal | null }> {
  // Use the up-front snapshot so that a prior apply pass cannot affect the
  // file contents visible to this bundle's validation/diff generation.
  const bundleFiles = runState.bundleFilesSnapshot.get(bundle.skillPath)
    ?? loadBundleFiles(repoRoot, bundle);
  const artifactDir = path.join(
    repoRoot,
    options.outDir,
    bundleArtifactSlug(bundle.skillPath),
  );
  assertInsideRepo(artifactDir, "artifact directory");
  fs.mkdirSync(artifactDir, { recursive: true });

  const manifest = {
    repoRoot,
    skill: bundle.skillPath,
    refs: bundle.refs,
    missingRefs: bundle.missingRefs,
    refKinds: bundle.refKinds,
    files: bundleFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
      refKind: file.path === bundle.skillPath ? "skill" : bundle.refKinds[file.path] ?? null,
      words: countWords(file.content),
      lines: file.content.split(/\r?\n/).length,
    })),
  };
  writeUtf8(path.join(artifactDir, "bundle.json"), JSON.stringify(manifest, null, 2));
  writeBundleSourceFiles(artifactDir, bundleFiles);

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
    ? loadExistingProposal(proposalPath, bundleFiles, runState.preRunMtimes)
    : await requestProposal(bundle, bundleFiles, options);
  validateProposal(
    bundle,
    proposal,
    bundleFiles,
    sharedRefOwners,
    runState.selectedSkillPaths,
  );
  const validation = validateGeneratedBundle(bundle, bundleFiles, proposal);
  const validationPath = path.join(artifactDir, "validation.json");
  const validationSummaryPath = path.join(artifactDir, "validation.md");
  writeUtf8(validationPath, JSON.stringify(validation, null, 2));
  writeUtf8(validationSummaryPath, renderValidationSummary(bundle, validation));
  if (!validation.ok) {
    throw new Error(
      `Proposal validation failed for ${bundle.skillPath}. See ${rel(repoRoot, validationPath)}`,
    );
  }
  if (!options.reuseProposal) {
    persistProposal(artifactDir, bundle, proposal);
  }
  const diffPath = path.join(artifactDir, "proposal.diff");
  // Best-effort diff. generateProposalDiff shells out to `diff` using a temp
  // dir under os.tmpdir(); a locked-down sandbox or missing `diff` binary
  // shouldn't drop the proposal we already persisted in persistProposal.
  let diffText = "";
  try {
    diffText = generateProposalDiff(bundleFiles, proposal);
  } catch (error) {
    console.error(
      `[skill_optimize] diff generation failed for ${bundle.skillPath}: ` +
        `${(error as Error).message}. Proposal JSON and summary are still on disk.`,
    );
  }
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
      validationPath: rel(repoRoot, validationPath),
      validationSummaryPath: rel(repoRoot, validationSummaryPath),
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
    apiTimeoutMs: 900000,
    diff: false,
    // Default to plan mode so a bare `skill_optimize` invocation never
    // uploads bundle contents off-box. API mode is explicit: `--mode api`.
    mode: "plan",
    model: "gpt-5.5-pro",
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

  // Require --mode api + an explicit --skill target BEFORE auth checks so a
  // local run without OPENAI_API_KEY still reports the precise guard error
  // instead of a misleading auth failure. Plan mode can operate on all
  // bundles because it never makes a network call.
  if (options.mode === "api" && !options.skillTargets.length) {
    throw new Error(
      "--mode api requires at least one --skill or --skills target " +
        "(prevents uploading every repo skill to the Responses API).",
    );
  }
  if (options.mode === "api" && !options.reuseProposal && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for --mode api (not needed with --reuse-proposal)");
  }
  if (
    options.mode === "api" &&
    options.model.endsWith("-pro") &&
    options.reasoningEffort === "low"
  ) {
    throw new Error(`${options.model} supports reasoning effort: medium, high, xhigh`);
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
  bundleFiles: BundleFile[],
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
              "Keep included Python files syntactically valid.",
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
  // Endpoint override exists so integration tests can point at a local
  // mock server; production leaves OPENAI_RESPONSES_BASE unset and hits the
  // real OpenAI API. Restrict the override to loopback so a hostile env
  // var can't redirect the bundle + `Authorization: Bearer` header to an
  // arbitrary host.
  const responsesBase =
    process.env.OPENAI_RESPONSES_BASE ?? "https://api.openai.com/v1/responses";
  if (responsesBase !== "https://api.openai.com/v1/responses") {
    const host = (() => {
      try {
        // URL#hostname wraps IPv6 addresses in brackets (e.g. "[::1]"),
        // so strip them before comparing to the bare loopback literal.
        return new URL(responsesBase).hostname.replace(/^\[|\]$/g, "");
      } catch {
        return "";
      }
    })();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!loopback) {
      throw new Error(
        `OPENAI_RESPONSES_BASE must resolve to a loopback host (127.0.0.1, ` +
          `localhost, ::1); got ${host || "<invalid URL>"}. ` +
          `Leave the variable unset in production.`,
      );
    }
  }
  // Honor --api-timeout-ms. Floor at pollIntervalMs so a single fetch has
  // time to complete even when the remaining budget has dipped below it,
  // but never more — the old 5s floor blocked every short-budget run on
  // the POST alone, masking small --api-timeout-ms values.
  const fetchFloor = Math.max(options.pollIntervalMs, 100);
  let payload = await openaiFetch(responsesBase, {
    method: "POST",
    headers: openAiHeaders(responsesBase),
    body: JSON.stringify(requestBody),
  }, Math.max(deadline - Date.now(), fetchFloor));
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
      `${responsesBase}/${payload.id}`,
      {
        method: "GET",
        headers: openAiHeaders(responsesBase),
      },
      Math.max(deadline - Date.now(), fetchFloor),
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
    // Never echo the full outputText back to stderr — a buggy or malicious
    // endpoint could reflect the submitted bundle contents. Bound the sample
    // the same way openaiFetch bounds response bodies (500 chars).
    const sample =
      outputText.length > 500
        ? `${outputText.slice(0, 500)}… [truncated, ${outputText.length - 500} more chars]`
        : outputText;
    throw new Error(`Failed to parse proposal JSON: ${(error as Error).message}\n${sample}`);
  }
  return decodeRewriteProposal(parsed);
}

function generateProposalDiff(
  bundleFiles: BundleFile[],
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
  bundleFiles: BundleFile[],
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
    "- Keep Python files syntactically valid.",
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
        `${fence}${fenceLanguage(file.kind)}`,
        file.content.trimEnd(),
        fence,
        "",
      ];
    }),
  ];
  return sections.join("\n");
}

function fenceLanguage(kind: BundleFile["kind"]): string {
  if (kind === "markdown") {
    return "md";
  }
  if (kind === "python") {
    return "python";
  }
  return "";
}

function validateGeneratedBundle(
  bundle: SkillBundle,
  bundleFiles: BundleFile[],
  proposal: RewriteProposal,
): ValidationReport {
  const finalFiles = materializeBundleFiles(bundleFiles, proposal);
  const finalFileMap = new Map(finalFiles.map((file) => [file.path, file]));
  const trackedPaths = new Set([bundle.skillPath, ...bundle.refs]);
  const fileExists = (absolutePath: string): boolean => {
    if (absolutePath === repoRoot || absolutePath.startsWith(repoRoot + path.sep)) {
      const relativePath = rel(repoRoot, absolutePath);
      if (trackedPaths.has(relativePath)) {
        return finalFileMap.has(relativePath);
      }
    }
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
  };

  const frontmatter = bundleFiles
    .filter((file) => extractFrontmatterKeys(file.content).length > 0)
    .map((file) => {
      const finalFile = finalFileMap.get(file.path);
      if (!finalFile) {
        return {
          path: file.path,
          ok: true,
          missingKeys: [],
        };
      }
      const originalKeys = extractFrontmatterKeys(file.content);
      const finalKeys = extractFrontmatterKeys(finalFile.content);
      const missingKeys = originalKeys.filter((key) => !finalKeys.includes(key));
      return {
        path: file.path,
        ok: missingKeys.length === 0,
        missingKeys,
      };
    });

  const refs = finalFiles
    .filter((file) => file.kind === "markdown")
    .map((file) => {
      const inspection = inspectLocalRefs(
        repoRoot,
        path.join(repoRoot, file.path),
        file.content,
        { fileExists },
      );
      return {
        path: file.path,
        ok: inspection.missing.length === 0,
        missing: inspection.missing,
      };
    });

  const pythonSyntax = finalFiles
    .filter((file) => file.kind === "python")
    .map((file) => validatePythonSyntax(file));

  const errors = [
    ...frontmatter
      .filter((check) => !check.ok)
      .map(
        (check) =>
          `${check.path}: missing frontmatter keys ${check.missingKeys.join(", ")}`,
      ),
    ...refs
      .filter((check) => !check.ok)
      .map((check) => `${check.path}: broken refs ${check.missing.join(", ")}`),
    ...pythonSyntax
      .filter((check) => !check.ok)
      .map((check) => `${check.path}: ${check.error ?? "python syntax validation failed"}`),
  ];

  return {
    ok: errors.length === 0,
    frontmatter,
    refs,
    pythonSyntax,
    errors,
  };
}

function materializeBundleFiles(
  bundleFiles: BundleFile[],
  proposal: RewriteProposal,
): BundleFile[] {
  const finalFileMap = new Map(
    bundleFiles.map((file) => [file.path, { ...file }]),
  );

  for (const change of proposal.changes) {
    if (change.action === "delete") {
      finalFileMap.delete(change.path);
      continue;
    }
    if (change.action === "update") {
      finalFileMap.set(change.path, {
        path: change.path,
        content: change.content,
        kind: detectFileKind(change.path),
      });
    }
  }

  return [...finalFileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function extractFrontmatterKeys(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") {
    return [];
  }

  const keys: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      break;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

function validatePythonSyntax(file: BundleFile): ValidationReport["pythonSyntax"][number] {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-opt-py-"));
  const tempPath = path.join(tempDir, path.basename(file.path));
  writeUtf8(tempPath, file.content);

  try {
    execFileSync("python3", ["-m", "py_compile", tempPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      path: file.path,
      ok: true,
    };
  } catch (error: any) {
    const detail = `${error?.stderr ?? error?.stdout ?? error?.message ?? "unknown error"}`
      .trim()
      .split("\n")
      .slice(-2)
      .join(" ");
    return {
      path: file.path,
      ok: false,
      error: detail,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function renderValidationSummary(
  bundle: SkillBundle,
  validation: ValidationReport,
): string {
  const lines = [
    `# Validation: ${bundle.skillPath}`,
    "",
    `- Result: ${validation.ok ? "pass" : "fail"}`,
    "",
    "## Frontmatter",
    ...(validation.frontmatter.length
      ? validation.frontmatter.map((check) =>
          check.ok
            ? `- ${check.path}: ok`
            : `- ${check.path}: missing keys ${check.missingKeys.join(", ")}`,
        )
      : ["- No frontmatter-bearing files checked."]),
    "",
    "## Local Refs",
    ...(validation.refs.length
      ? validation.refs.map((check) =>
          check.ok
            ? `- ${check.path}: ok`
            : `- ${check.path}: missing ${check.missing.join(", ")}`,
        )
      : ["- No markdown files checked."]),
    "",
    "## Python Syntax",
    ...(validation.pythonSyntax.length
      ? validation.pythonSyntax.map((check) =>
          check.ok
            ? `- ${check.path}: ok`
            : `- ${check.path}: ${check.error ?? "failed"}`,
        )
      : ["- No python files checked."]),
    "",
    "## Errors",
    ...(validation.errors.length
      ? validation.errors.map((item) => `- ${item}`)
      : ["- None."]),
  ];

  return `${lines.join("\n")}\n`;
}

function loadExistingProposal(
  proposalPath: string,
  bundleFiles: BundleFile[],
  preRunMtimes: Map<string, number>,
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

function openAiHeaders(targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Only attach the live Bearer token when hitting the real OpenAI host.
  // A local mock bound on 127.0.0.1 doesn't need real credentials, and any
  // process bound to that port would otherwise see the key in plaintext.
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    hostname = "";
  }
  const loopback =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (!loopback && process.env.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }
  return headers;
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
    // Disallow redirect following: a localhost mock that returned a 307
    // could otherwise forward the bundle contents + Bearer token to an
    // arbitrary origin even though the loopback URL check passed.
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // Bound the embedded body so a verbose OpenAI error (or an HTML 502
    // page from a proxy) doesn't dump kilobytes of raw text — including
    // any echoed prompt fragments — into the CLI error output.
    const body = await response.text();
    const summary = body.length > 500 ? `${body.slice(0, 500)}… [truncated]` : body;
    throw new Error(
      `OpenAI API request failed: ${response.status} ${response.statusText} (${summary})`,
    );
  }
  return decodeResponsesPayload(await response.json());
}

function decodeResponsesPayload(raw: unknown): ResponsesPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Responses API did not return an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") {
    throw new Error("Responses API object is missing a string id");
  }
  const status = typeof r.status === "string" ? r.status : undefined;
  const output_text =
    typeof r.output_text === "string" ? r.output_text : undefined;
  const output = Array.isArray(r.output)
    ? (r.output as ResponsesPayload["output"])
    : undefined;
  return {
    id: r.id,
    status,
    error: r.error,
    output_text,
    output,
  };
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

function writeBundleSourceFiles(artifactDir: string, bundleFiles: BundleFile[]): void {
  const sourceRoot = path.join(artifactDir, "source");
  fs.rmSync(sourceRoot, { recursive: true, force: true });
  for (const file of bundleFiles) {
    const outputPath = path.join(sourceRoot, file.path);
    writeUtf8(outputPath, file.content);
  }
}

export type StagedOp =
  | { kind: "write"; target: string; staged: string }
  | { kind: "delete"; target: string };

/**
 * Phase 1: validate every change and stage update content into `stagingRoot`.
 * If any path validation fails or a staging write throws, no bundle file is
 * mutated — the caller discards the staging dir and the repo is untouched.
 */
export function planProposalApply(
  proposal: RewriteProposal,
  stagingRoot: string,
  repoRoot: string,
): StagedOp[] {
  const repoRootReal = fs.realpathSync(repoRoot);
  const ops: StagedOp[] = [];
  for (const change of proposal.changes) {
    if (change.action === "keep") continue;
    const outputPath = path.join(repoRoot, change.path);
    if (fs.existsSync(outputPath) && fs.lstatSync(outputPath).isSymbolicLink()) {
      throw new Error(`Refusing to apply: ${change.path} is a symlink`);
    }
    // Reject any symlink in the ancestor chain so `skill/alpha -> ../beta`
    // can't redirect a write on skill/alpha/SKILL.md to skill/beta/SKILL.md.
    // lstat on each literal ancestor catches directory symlinks that the
    // final-target check wouldn't see because lstat's final-only semantics
    // already followed the intermediate.
    let ancestor = path.dirname(outputPath);
    while (ancestor.length >= repoRoot.length && ancestor !== path.dirname(ancestor)) {
      if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(
          `Refusing to apply: ${change.path} has a symlinked ancestor directory (${path.relative(repoRoot, ancestor)}).`,
        );
      }
      if (ancestor === repoRoot) break;
      ancestor = path.dirname(ancestor);
    }
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
      ops.push({ kind: "delete", target: outputPath });
      continue;
    }
    const stagedPath = path.join(stagingRoot, stagingName(outputPath, repoRoot));
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    writeUtf8(stagedPath, change.content ?? "");
    ops.push({ kind: "write", target: outputPath, staged: stagedPath });
  }
  return ops;
}

/**
 * Phase 2: commit staged writes and deletes. Uses renameSync so each swap is
 * atomic on the same filesystem; falls back to copy+unlink across devices.
 * A phase-2 error leaves the staging dir in place so an operator can recover
 * the remaining changes manually.
 */
export function commitStagedOps(ops: StagedOp[], repoRootForGuard?: string): void {
  for (const op of ops) {
    // TOCTOU guard: planProposalApply rejected symlink targets and ancestors
    // at staging time, but a concurrent process could swap a symlink in
    // between staging and commit. Re-check the target (and its ancestors up
    // to repoRootForGuard) right before touching the filesystem. Without the
    // boundary, the walk would reach the system tmpdir which is itself a
    // symlink on macOS (/var -> /private/var) and trip a false positive.
    assertNotSymlinked(op.target, repoRootForGuard);
    if (op.kind === "delete") {
      if (fs.existsSync(op.target)) {
        fs.unlinkSync(op.target);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(op.target), { recursive: true });
    try {
      fs.renameSync(op.staged, op.target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
        fs.copyFileSync(op.staged, op.target);
        fs.unlinkSync(op.staged);
        continue;
      }
      throw err;
    }
  }
}

function assertNotSymlinked(target: string, repoRoot?: string): void {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(
      `Refusing to commit: ${target} became a symlink between staging and commit`,
    );
  }
  let ancestor = path.dirname(target);
  while (ancestor && ancestor !== path.dirname(ancestor)) {
    if (repoRoot && ancestor === repoRoot) break;
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) {
      throw new Error(
        `Refusing to commit: ancestor ${ancestor} became a symlink between staging and commit`,
      );
    }
    if (repoRoot && !ancestor.startsWith(repoRoot)) break;
    ancestor = path.dirname(ancestor);
  }
}

export function stagingName(absPath: string, repoRoot: string): string {
  // Preserve the repo-relative path segments verbatim. The previous flat
  // slug (`a/b/c.md` → `a__b__c.md`) aliased distinct targets whenever one
  // segment contained a literal `__` (e.g. `a__b/c.md` and `a/b__c.md`
  // both mapped to `a__b__c.md`). Keeping the nested structure under
  // stagingRoot makes the mapping one-to-one.
  return path.relative(repoRoot, absPath);
}

/**
 * Flatten a bundle's repo-relative SKILL.md path into a single directory
 * name. The encoding escapes `_` first (`_` → `_u`) so the separator
 * substitution (`/` → `_s`) can't alias with literal underscores in the
 * source path. Earlier schemes used `__` as a separator, which aliased
 * `skill/foo__bar/SKILL.md` and `skill/foo/bar/SKILL.md`. Reversibility
 * also means two bundles that share a leaf directory name stay distinct.
 */
export function bundleArtifactSlug(skillPath: string): string {
  return skillPath.replace(/_/g, "_u").replace(/[\\/]/g, "_s");
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
    if (bundle.validationPath) {
      lines.push(`- Validation JSON: \`${bundle.validationPath}\``);
    }
    if (bundle.validationSummaryPath) {
      lines.push(`- Validation summary: \`${bundle.validationSummaryPath}\``);
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

// Run the CLI only when this file is the entry point. Tests import planning
// and commit helpers without triggering main() and its process.argv parsing.
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl === import.meta.url) {
  try {
    await main();
  } catch (error) {
    // Print just the message — the full stack trace (with absolute repo
    // paths and internal file URLs) adds noise to operator-facing errors
    // without helping diagnosis. Set DEBUG=1 to surface the trace.
    const message = (error as Error)?.message ?? String(error);
    console.error(`[skill_optimize] ${message}`);
    if (process.env.DEBUG) {
      console.error((error as Error)?.stack ?? "");
    }
    process.exit(1);
  }
}
