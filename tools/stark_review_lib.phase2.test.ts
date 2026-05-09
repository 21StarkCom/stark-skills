import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  FINDING_SCHEMA_PROMPT,
  findingId,
  loadTrustedConfig,
  renderReviewPrompt,
  resolveAgentsForDomains,
  resolvePromptSources,
  compareSeverityDesc,
  selectDomains,
  severityMeetsThreshold,
  type AgentName,
  type ResolvedConfig,
} from "./stark_review_lib.ts";

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBareConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    quick_domains: [],
    default_agent: "codex",
    domain_agents: {},
    severity_overrides: {},
    fix_threshold: "medium",
    runtime: {
      lock_ttl_minutes: 30,
      subagent_env_allowlist: [],
      max_concurrent_agents: 3,
      temp_dir_prefix: "stark-env",
      large_pr_file_threshold: 40,
      large_pr_line_threshold: 3000,
      large_pr_timeout_s: 1800,
    },
    test_command: null,
    untrusted_fix_loop: false,
    history_retention_days: 90,
    lock_ttl_minutes: 30,
    ...overrides,
  };
}

// ─── Task 2-4: findingId & severityMeetsThreshold ───────────────────────────

test("findingId is deterministic across runs", () => {
  const a = findingId("security", "codex", "Unvalidated input");
  const b = findingId("security", "codex", "Unvalidated input");
  assert.equal(a, b);
  assert.equal(a.length, 12);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("findingId normalizes whitespace and punctuation", () => {
  const a = findingId("security", "codex", "Foo  bar.");
  const b = findingId("security", "codex", "foo bar");
  assert.equal(a, b);
});

test("findingId differs across domain/agent/title", () => {
  const base = findingId("security", "codex", "X");
  assert.notEqual(base, findingId("architecture", "codex", "X"));
  assert.notEqual(base, findingId("security", "claude", "X"));
  assert.notEqual(base, findingId("security", "codex", "Y"));
});

test("severityMeetsThreshold ordering", () => {
  assert.equal(severityMeetsThreshold("critical", "low"), true);
  assert.equal(severityMeetsThreshold("critical", "critical"), true);
  assert.equal(severityMeetsThreshold("high", "critical"), false);
  assert.equal(severityMeetsThreshold("medium", "high"), false);
  assert.equal(severityMeetsThreshold("low", "low"), true);
  assert.equal(severityMeetsThreshold("low", "medium"), false);
});

test("compareSeverityDesc orders critical → high → medium → low, ties by domain/file/line", () => {
  const items = [
    { severity: "low" as const,      domain: "a", file: "z.ts", line: 1 },
    { severity: "critical" as const, domain: "a", file: "z.ts", line: 1 },
    { severity: "medium" as const,   domain: "a", file: "z.ts", line: 1 },
    { severity: "high" as const,     domain: "a", file: "z.ts", line: 1 },
  ];
  const sorted = [...items].sort(compareSeverityDesc);
  assert.deepEqual(sorted.map((i) => i.severity), ["critical", "high", "medium", "low"]);
  // Ties broken by (domain, file, line)
  const ties = [
    { severity: "high" as const, domain: "b", file: "a.ts", line: 9 },
    { severity: "high" as const, domain: "a", file: "z.ts", line: 1 },
    { severity: "high" as const, domain: "a", file: "a.ts", line: 9 },
    { severity: "high" as const, domain: "a", file: "a.ts", line: 1 },
  ].sort(compareSeverityDesc);
  assert.deepEqual(
    ties.map((t) => `${t.domain}/${t.file}:${t.line}`),
    ["a/a.ts:1", "a/a.ts:9", "a/z.ts:1", "b/a.ts:9"],
  );
});

// ─── Task 2-3: selectDomains & resolveAgentsForDomains ──────────────────────

test("selectDomains explicit mode returns the explicit list", () => {
  const cfg = makeBareConfig({ quick_domains: ["security"] });
  const out = selectDomains({
    mode: "explicit",
    explicitDomains: ["architecture", "security"],
    config: cfg,
    promptRoot: "/nonexistent",
  });
  assert.deepEqual(out, ["architecture", "security"]);
});

test("selectDomains explicit overrides quick", () => {
  const cfg = makeBareConfig({ quick_domains: ["security"] });
  const out = selectDomains({
    mode: "explicit",
    explicitDomains: ["behavior"],
    config: cfg,
    promptRoot: "/nonexistent",
  });
  assert.deepEqual(out, ["behavior"]);
});

test("selectDomains quick mode returns quick_domains", () => {
  const cfg = makeBareConfig({ quick_domains: ["security", "behavior"] });
  const out = selectDomains({
    mode: "quick",
    config: cfg,
    promptRoot: "/nonexistent",
  });
  assert.deepEqual(out, ["security", "behavior"]);
});

test("selectDomains quick throws when quick_domains empty", () => {
  const cfg = makeBareConfig({ quick_domains: [] });
  assert.throws(
    () => selectDomains({ mode: "quick", config: cfg, promptRoot: "/nonexistent" }),
    /quick_domains/,
  );
});

test("selectDomains default mode lists prompts present for the resolved agent", () => {
  const tmp = makeTmpDir("stark-domains-");
  fs.mkdirSync(path.join(tmp, "claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "claude", "01-architecture.md"), "x");
  fs.writeFileSync(path.join(tmp, "claude", "04-security.md"), "x");
  fs.writeFileSync(path.join(tmp, "codex", "02-behavior.md"), "x");
  fs.writeFileSync(path.join(tmp, "codex", "agent.md"), "x"); // not a domain
  const cfg = makeBareConfig();
  const resolver = (d: string): AgentName => {
    if (d === "behavior") return "codex";
    return "claude";
  };
  const out = selectDomains({
    mode: "default",
    config: cfg,
    promptRoot: tmp,
    agentResolver: resolver,
  });
  assert.deepEqual(out, ["architecture", "behavior", "security"]); // sorted
});

test("selectDomains default mode skips domains not present for resolved agent", () => {
  const tmp = makeTmpDir("stark-domains-");
  fs.mkdirSync(path.join(tmp, "claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "gemini"), { recursive: true });
  // 'quality' exists ONLY under gemini
  fs.writeFileSync(path.join(tmp, "gemini", "05-quality.md"), "x");
  // 'architecture' exists under claude
  fs.writeFileSync(path.join(tmp, "claude", "01-architecture.md"), "x");
  const cfg = makeBareConfig();
  // Resolver sends both domains to codex (which has no prompt dir at all).
  const out = selectDomains({
    mode: "default",
    config: cfg,
    promptRoot: tmp,
    agentResolver: () => "codex",
  });
  assert.deepEqual(out, []);
});

test("selectDomains default mode throws without agentResolver", () => {
  const cfg = makeBareConfig();
  assert.throws(
    () =>
      selectDomains({ mode: "default", config: cfg, promptRoot: "/nonexistent" }),
    /agentResolver/,
  );
});

test("resolveAgentsForDomains precedence", () => {
  const cfg = makeBareConfig({
    default_agent: "codex",
    domain_agents: { security: "claude", behavior: "gemini" },
  });
  const out = resolveAgentsForDomains({
    domains: ["security", "behavior", "architecture"],
    config: cfg,
  });
  assert.deepEqual(out, {
    security: "claude",
    behavior: "gemini",
    architecture: "codex",
  });
});

test("resolveAgentsForDomains forcedAgent wins", () => {
  const cfg = makeBareConfig({
    default_agent: "codex",
    domain_agents: { security: "claude" },
  });
  const out = resolveAgentsForDomains({
    domains: ["security", "behavior"],
    forcedAgent: "gemini",
    config: cfg,
  });
  assert.deepEqual(out, { security: "gemini", behavior: "gemini" });
});

test("resolveAgentsForDomains falls back to codex when default_agent missing", () => {
  const cfg = { ...makeBareConfig(), default_agent: undefined as unknown as AgentName };
  const out = resolveAgentsForDomains({
    domains: ["security"],
    config: cfg,
  });
  assert.deepEqual(out, { security: "codex" });
});

// ─── Task 2-2: loadTrustedConfig ────────────────────────────────────────────

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

function gitCommitAll(dir: string, msg: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
}

test("loadTrustedConfig merges global and repo (base-branch) configs", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);

  // Global config
  const globalDir = path.join(home, ".claude", "code-review");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(
    path.join(globalDir, "config.json"),
    JSON.stringify({
      default_agent: "codex",
      fix_threshold: "low",
      domain_agents: { security: "codex" },
    }),
  );

  // Repo override (committed to base branch)
  fs.mkdirSync(path.join(repo, ".code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({ fix_threshold: "high", domain_agents: { architecture: "claude" } }),
  );
  gitCommitAll(repo, "init");

  const worktree = makeTmpDir("stark-wt-");

  const cfg = loadTrustedConfig({
    home,
    configRoot: repo,
    baseRef: "HEAD",
    worktree,
  });

  assert.equal(cfg.fix_threshold, "high");
  assert.equal(cfg.domain_agents.security, "codex");
  assert.equal(cfg.domain_agents.architecture, "claude");
});

test("loadTrustedConfig reads repo override from base branch, not worktree", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);

  fs.mkdirSync(path.join(repo, ".code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({ fix_threshold: "low" }),
  );
  gitCommitAll(repo, "init");

  // PR-controlled mutation in the worktree (post-commit)
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({ fix_threshold: "critical" }),
  );

  const worktree = makeTmpDir("stark-wt-");
  const cfg = loadTrustedConfig({
    home,
    configRoot: repo,
    baseRef: "HEAD",
    worktree,
  });

  assert.equal(cfg.fix_threshold, "low");
});

test("loadTrustedConfig handles missing repo override file gracefully", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x");
  gitCommitAll(repo, "init");

  const worktree = makeTmpDir("stark-wt-");
  const cfg = loadTrustedConfig({
    home,
    configRoot: repo,
    baseRef: "HEAD",
    worktree,
  });
  assert.ok(cfg);
});

test("loadTrustedConfig: configRoot inside repo subdir does NOT read repo override from disk", () => {
  // Layout: home/repo/sub  with home as ancestor of repo so the org walk runs.
  const home = makeTmpDir("stark-home-");
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  gitInit(repo);

  // Trusted, committed repo override: sets only default_agent.
  fs.mkdirSync(path.join(repo, ".code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({ default_agent: "codex" }),
  );
  gitCommitAll(repo, "init");

  // PR-controlled mutation in the worktree, post-commit. If the org walk reads
  // this, fix_threshold will leak into the merged config.
  fs.writeFileSync(
    path.join(repo, ".code-review", "config.json"),
    JSON.stringify({ default_agent: "codex", fix_threshold: "low" }),
  );

  const subdir = path.join(repo, "sub");
  fs.mkdirSync(subdir, { recursive: true });

  const worktree = makeTmpDir("stark-wt-");
  const cfg = loadTrustedConfig({
    home,
    configRoot: subdir,
    baseRef: "HEAD",
    worktree,
  });

  // Trusted value present
  assert.equal(cfg.default_agent, "codex");
  // PR-injected value MUST NOT have leaked through the org walk
  assert.equal((cfg as unknown as Record<string, unknown>).fix_threshold, undefined);
});

test("loadTrustedConfig: org walk does not escape the home subtree", () => {
  // home is unrelated to repo (not an ancestor). Walk must not traverse '/'.
  const home = makeTmpDir("stark-home-");
  const outerDir = makeTmpDir("stark-outer-");
  const repo = path.join(outerDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x");
  gitCommitAll(repo, "init");

  // Plant a hostile org-level config in an ancestor that is NOT under home.
  // If the walk escaped the home subtree it would merge this in.
  fs.mkdirSync(path.join(outerDir, ".code-review"), { recursive: true });
  fs.writeFileSync(
    path.join(outerDir, ".code-review", "config.json"),
    JSON.stringify({ fix_threshold: "critical" }),
  );

  const worktree = makeTmpDir("stark-wt-");
  const cfg = loadTrustedConfig({
    home,
    configRoot: repo,
    baseRef: "HEAD",
    worktree,
  });

  assert.equal(
    (cfg as unknown as Record<string, unknown>).fix_threshold,
    undefined,
    "org walk must not read configs outside the home subtree",
  );
});

test("loadTrustedConfig throws when configRoot is inside worktree", () => {
  const home = makeTmpDir("stark-home-");
  const worktree = makeTmpDir("stark-wt-");
  const configRoot = path.join(worktree, "inside");
  fs.mkdirSync(configRoot, { recursive: true });
  gitInit(configRoot);
  fs.writeFileSync(path.join(configRoot, "x"), "x");
  gitCommitAll(configRoot, "init");

  assert.throws(
    () =>
      loadTrustedConfig({
        home,
        configRoot,
        baseRef: "HEAD",
        worktree,
      }),
    /worktree/i,
  );
});

// ─── Task 2-5: resolvePromptSources & renderReviewPrompt ────────────────────

test("renderReviewPrompt is pure and assembles the canonical structure", () => {
  const out = renderReviewPrompt({
    agent: "codex",
    domain: "security",
    promptSources: { agentMd: "AGENT", domainPrompt: "DOMAIN" },
    prTitle: "T",
    prBody: "B",
    prDiff: "D",
  });
  assert.ok(out.startsWith("AGENT"));
  assert.ok(out.includes("DOMAIN"));
  assert.ok(out.includes(FINDING_SCHEMA_PROMPT));
  const idx = out.indexOf(FINDING_SCHEMA_PROMPT);
  assert.equal(out.indexOf(FINDING_SCHEMA_PROMPT, idx + 1), -1);
  assert.ok(out.includes("PR Title: T"));
  assert.ok(out.includes("PR Body:\nB"));
  assert.ok(out.includes("PR Diff:\nD"));
});

test("renderReviewPrompt is deterministic", () => {
  const args = {
    agent: "codex" as AgentName,
    domain: "security",
    promptSources: { agentMd: "A", domainPrompt: "D" },
    prTitle: "t",
    prBody: "b",
    prDiff: "d",
  };
  assert.equal(renderReviewPrompt(args), renderReviewPrompt(args));
});

test("resolvePromptSources: repo override beats global", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);

  const repoPromptDir = path.join(repo, ".code-review", "prompts", "claude");
  fs.mkdirSync(repoPromptDir, { recursive: true });
  fs.writeFileSync(path.join(repoPromptDir, "agent.md"), "REPO_AGENT");
  fs.writeFileSync(path.join(repoPromptDir, "01-architecture.md"), "REPO_DOMAIN");
  gitCommitAll(repo, "init");

  const globalRoot = path.join(home, ".claude", "code-review", "prompts");
  fs.mkdirSync(path.join(globalRoot, "claude"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "claude", "agent.md"), "GLOBAL_AGENT");
  fs.writeFileSync(path.join(globalRoot, "claude", "01-architecture.md"), "GLOBAL_DOMAIN");

  const sharedRoot = makeTmpDir("stark-shared-");

  const got = resolvePromptSources({
    agent: "claude",
    domain: "architecture",
    promptRoots: { global: globalRoot, shared: sharedRoot },
    baseRef: "HEAD",
    repoRoot: repo,
  });
  assert.equal(got.agentMd, "REPO_AGENT");
  assert.ok(got.domainPrompt.includes("REPO_DOMAIN"));
  assert.ok(!got.domainPrompt.includes(FINDING_SCHEMA_PROMPT));
});

test("resolvePromptSources: global wins when no repo override", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "x"), "x");
  gitCommitAll(repo, "init");

  const globalRoot = path.join(home, ".claude", "code-review", "prompts");
  fs.mkdirSync(path.join(globalRoot, "codex"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "codex", "agent.md"), "GLOBAL_AGENT");
  fs.writeFileSync(path.join(globalRoot, "codex", "04-security.md"), "GLOBAL_SEC_DOMAIN");

  const sharedRoot = makeTmpDir("stark-shared-");

  const got = resolvePromptSources({
    agent: "codex",
    domain: "security",
    promptRoots: { global: globalRoot, shared: sharedRoot },
    baseRef: "HEAD",
    repoRoot: repo,
  });
  assert.equal(got.agentMd, "GLOBAL_AGENT");
  assert.ok(got.domainPrompt.includes("GLOBAL_SEC_DOMAIN"));
});

test("resolvePromptSources: falls back to shared prompts/domains/", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "x"), "x");
  gitCommitAll(repo, "init");

  const globalRoot = path.join(home, ".claude", "code-review", "prompts");
  fs.mkdirSync(path.join(globalRoot, "gemini"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "gemini", "agent.md"), "AGENT_GEM");

  const sharedRoot = makeTmpDir("stark-shared-");
  fs.writeFileSync(path.join(sharedRoot, "07-shared-domain.md"), "SHARED_BODY");

  const got = resolvePromptSources({
    agent: "gemini",
    domain: "shared-domain",
    promptRoots: { global: globalRoot, shared: sharedRoot },
    baseRef: "HEAD",
    repoRoot: repo,
  });
  assert.ok(got.domainPrompt.includes("SHARED_BODY"));
});

test("resolvePromptSources: throws when domain missing in all layers", () => {
  const home = makeTmpDir("stark-home-");
  const repo = makeTmpDir("stark-repo-");
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "x"), "x");
  gitCommitAll(repo, "init");

  const globalRoot = path.join(home, ".claude", "code-review", "prompts");
  fs.mkdirSync(path.join(globalRoot, "claude"), { recursive: true });
  fs.writeFileSync(path.join(globalRoot, "claude", "agent.md"), "A");

  const sharedRoot = makeTmpDir("stark-shared-");

  assert.throws(
    () =>
      resolvePromptSources({
        agent: "claude",
        domain: "no-such-domain",
        promptRoots: { global: globalRoot, shared: sharedRoot },
        baseRef: "HEAD",
        repoRoot: repo,
      }),
    /no-such-domain/,
  );
});
