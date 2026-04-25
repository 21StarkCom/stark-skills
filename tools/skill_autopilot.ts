#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

type CliOptions = {
  apiTimeoutMs?: number;
  diff: boolean;
  maxOutputTokens?: number;
  model?: string;
  outDir: string;
  outputPath: string;
  pollIntervalMs?: number;
  reasoningEffort?: ReasoningEffort;
  reuseProposal: boolean;
  skillTarget: string;
};

type OptimizerRun = {
  repoRoot: string;
  mode: string;
  apply: boolean;
  bundles: Array<{
    skillPath: string;
    artifactDir: string;
    proposalPath?: string;
    validationPath?: string;
  }>;
};

type BundleManifest = {
  repoRoot: string;
  skill: string;
  refs: string[];
  missingRefs: string[];
  refKinds?: Record<string, string>;
  files: Array<{
    path: string;
    kind: "markdown" | "python" | "text";
    sha256?: string;
  }>;
};

type Proposal = {
  bundle_summary: string;
  global_notes: string[];
  changes: Array<{
    path: string;
    action: "update" | "delete" | "keep";
    summary: string;
    content?: string;
  }>;
  refs_kept: string[];
  refs_removed: string[];
  contradictions_resolved: string[];
  terminology_normalizations: string[];
  warnings: string[];
};

type ValidationReport = {
  ok: boolean;
  errors: string[];
};

type BundleFile = {
  path: string;
  kind: "markdown" | "python" | "text";
  content: string;
  action: "update" | "delete" | "keep";
  summary: string;
};

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const options = parseArgs(process.argv.slice(2));
const optimizerRun = runOptimizer(options);
const bundle = expectSingleBundle(optimizerRun);
const manifestPath = path.join(optimizerRun.repoRoot, bundle.artifactDir, "bundle.json");
const proposalPath = bundle.proposalPath
  ? path.join(optimizerRun.repoRoot, bundle.proposalPath)
  : path.join(optimizerRun.repoRoot, bundle.artifactDir, "proposal.json");
const validationPath = bundle.validationPath
  ? path.join(optimizerRun.repoRoot, bundle.validationPath)
  : path.join(optimizerRun.repoRoot, bundle.artifactDir, "validation.json");
const sourceRoot = path.join(optimizerRun.repoRoot, bundle.artifactDir, "source");

const manifest = readJson<BundleManifest>(manifestPath);
const proposal = readJson<Proposal>(proposalPath);
const validation = readJson<ValidationReport>(validationPath);
const finalFiles = materializeFinalFiles(sourceRoot, manifest, proposal);
const output = renderUpgradedBundle(optimizerRun.repoRoot, manifest, proposal, validation, finalFiles);

fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
fs.writeFileSync(options.outputPath, output, "utf8");

console.log(
  JSON.stringify(
    {
      skill: manifest.skill,
      outputPath: options.outputPath,
      validationOk: validation.ok,
      artifactDir: bundle.artifactDir,
      filesWritten: finalFiles.length,
      pythonFiles: finalFiles.filter((file) => file.kind === "python").map((file) => file.path),
    },
    null,
    2,
  ),
);

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    diff: false,
    outDir: "artifacts/skill-optimizer",
    outputPath: path.join(repoRoot, "skill-upgraded.md"),
    reuseProposal: false,
    skillTarget: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skill") {
      options.skillTarget = readValue(argv, ++index, "--skill");
      continue;
    }
    if (arg === "--output") {
      options.outputPath = path.resolve(process.cwd(), readValue(argv, ++index, "--output"));
      continue;
    }
    if (arg === "--out-dir") {
      options.outDir = readValue(argv, ++index, "--out-dir");
      continue;
    }
    if (arg === "--reuse-proposal") {
      options.reuseProposal = true;
      continue;
    }
    if (arg === "--diff") {
      options.diff = true;
      continue;
    }
    if (arg === "--model") {
      options.model = readValue(argv, ++index, "--model");
      continue;
    }
    if (arg === "--reasoning-effort") {
      options.reasoningEffort = readValue(argv, ++index, "--reasoning-effort") as ReasoningEffort;
      continue;
    }
    if (arg === "--api-timeout-ms") {
      options.apiTimeoutMs = Number.parseInt(readValue(argv, ++index, "--api-timeout-ms"), 10);
      continue;
    }
    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Number.parseInt(readValue(argv, ++index, "--poll-interval-ms"), 10);
      continue;
    }
    if (arg === "--max-output-tokens") {
      options.maxOutputTokens = Number.parseInt(readValue(argv, ++index, "--max-output-tokens"), 10);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.skillTarget) {
    throw new Error("--skill is required");
  }

  if (!options.reuseProposal && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required unless you use --reuse-proposal",
    );
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

function runOptimizer(options: CliOptions): OptimizerRun {
  const args = [
    ...process.execArgv,
    "tools/skill_optimize.ts",
    "--mode",
    "api",
    "--skill",
    options.skillTarget,
    "--out-dir",
    options.outDir,
  ];

  if (options.reuseProposal) {
    args.push("--reuse-proposal");
  }
  if (options.diff) {
    args.push("--diff");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort) {
    args.push("--reasoning-effort", options.reasoningEffort);
  }
  if (options.apiTimeoutMs) {
    args.push("--api-timeout-ms", String(options.apiTimeoutMs));
  }
  if (options.pollIntervalMs) {
    args.push("--poll-interval-ms", String(options.pollIntervalMs));
  }
  if (options.maxOutputTokens) {
    args.push("--max-output-tokens", String(options.maxOutputTokens));
  }

  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    throw new Error(`skill_optimize.ts failed with exit code ${result.status ?? "unknown"}`);
  }

  return JSON.parse(result.stdout) as OptimizerRun;
}

function expectSingleBundle(run: OptimizerRun): OptimizerRun["bundles"][number] {
  if (run.bundles.length !== 1) {
    throw new Error(`Expected exactly one bundle, received ${run.bundles.length}`);
  }
  return run.bundles[0];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function materializeFinalFiles(
  sourceRoot: string,
  manifest: BundleManifest,
  proposal: Proposal,
): BundleFile[] {
  const finalFiles = new Map<string, BundleFile>();

  for (const file of manifest.files) {
    const absolutePath = path.join(sourceRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `Bundle snapshot missing for ${file.path}. Rerun tools/skill_optimize.ts to refresh the artifacts.`,
      );
    }
    finalFiles.set(file.path, {
      path: file.path,
      kind: file.kind,
      content: fs.readFileSync(absolutePath, "utf8"),
      action: "keep",
      summary: "Included from the validated bundle snapshot.",
    });
  }

  for (const change of proposal.changes) {
    if (change.action === "delete") {
      finalFiles.delete(change.path);
      continue;
    }

    const existing = finalFiles.get(change.path);
    finalFiles.set(change.path, {
      path: change.path,
      kind: existing?.kind ?? detectKind(change.path),
      content:
        change.action === "update"
          ? change.content ?? ""
          : existing?.content ?? change.content ?? "",
      action: change.action,
      summary: change.summary,
    });
  }

  return [...finalFiles.values()].sort(sortBundleFiles);
}

function renderUpgradedBundle(
  repoRoot: string,
  manifest: BundleManifest,
  proposal: Proposal,
  validation: ValidationReport,
  files: BundleFile[],
): string {
  const lines = [
    "# Skill Upgraded",
    "",
    `- Skill: \`${manifest.skill}\``,
    `- Generated: ${new Date().toISOString()}`,
    `- Source repo: \`${repoRoot}\``,
    `- Validation: ${validation.ok ? "pass" : "fail"}`,
    "",
    "## Summary",
    proposal.bundle_summary,
    "",
    "## Notes",
    ...(proposal.global_notes.length ? proposal.global_notes.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Validation Errors",
    ...(validation.errors.length ? validation.errors.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Included Files",
    ...files.map(
      (file) =>
        `- \`${file.path}\` (${file.kind}, proposal action: ${file.action}) — ${file.summary}`,
    ),
    "",
    "## Upgraded Skill",
  ];

  const skillFile = files.find((file) => file.path === manifest.skill);
  if (!skillFile) {
    throw new Error(`Final bundle is missing the main skill file: ${manifest.skill}`);
  }
  lines.push(...renderFileSection(skillFile));

  const pythonFiles = files.filter((file) => file.kind === "python");
  if (pythonFiles.length) {
    lines.push("", "## Python Files");
    for (const file of pythonFiles) {
      lines.push(...renderFileSection(file));
    }
  }

  const markdownRefs = files.filter(
    (file) => file.kind === "markdown" && file.path !== manifest.skill,
  );
  if (markdownRefs.length) {
    lines.push("", "## Markdown References");
    for (const file of markdownRefs) {
      lines.push(...renderFileSection(file));
    }
  }

  const otherFiles = files.filter((file) => file.kind === "text");
  if (otherFiles.length) {
    lines.push("", "## Other Files");
    for (const file of otherFiles) {
      lines.push(...renderFileSection(file));
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderFileSection(file: BundleFile): string[] {
  let fence = "```";
  while (file.content.includes(fence)) {
    fence += "`";
  }
  return [
    "",
    `### \`${file.path}\``,
    "",
    `${fence}${fenceLanguage(file.kind)}`,
    file.content.trimEnd(),
    fence,
  ];
}

function detectKind(filePath: string): "markdown" | "python" | "text" {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".md")) {
    return "markdown";
  }
  if (lowered.endsWith(".py")) {
    return "python";
  }
  return "text";
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

function sortBundleFiles(a: BundleFile, b: BundleFile): number {
  const rank = (file: BundleFile): number => {
    if (file.path.endsWith("/SKILL.md")) {
      return 0;
    }
    if (file.kind === "python") {
      return 1;
    }
    if (file.kind === "markdown") {
      return 2;
    }
    return 3;
  };

  return rank(a) - rank(b) || a.path.localeCompare(b.path);
}
