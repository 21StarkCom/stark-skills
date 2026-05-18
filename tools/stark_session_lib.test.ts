// Tests for `tools/stark_session_lib.ts` — collectors that gather
// session start/end state for the /stark-session SKILL.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  collectAlerts,
  collectAvailableSkills,
  collectBoard,
  collectBranchState,
  collectCanaryStatus,
  collectDiffSummary,
  collectEnd,
  collectGit,
  collectHealerCategories,
  collectHealthChecks,
  collectPersona,
  collectPRs,
  collectQueueHealth,
  collectSessionState,
  collectSkillSuggestions,
  collectStart,
  type Deps,
  type ErrSlot,
} from "./stark_session_lib.ts";

// ── Test helpers ─────────────────────────────────────────────────────

type StubRun = {
  cmd: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  timeoutMs?: number;
  delayMs?: number;
  timedOut?: boolean;
};

function makeDeps(opts: {
  runs?: StubRun[];
  files?: Record<string, string>;
  scriptsDir?: string;
  toolsDir?: string;
  home?: string;
  now?: () => Date;
  envLog?: Array<{ cmd: string[]; env: NodeJS.ProcessEnv | undefined }>;
} = {}): Deps {
  const runs = [...(opts.runs ?? [])];
  const files = opts.files ?? {};
  const envLog = opts.envLog;
  return {
    home: opts.home ?? "/home/u",
    scriptsDir: opts.scriptsDir ?? "/scripts",
    toolsDir: opts.toolsDir ?? "/tools",
    now: opts.now ?? (() => new Date("2026-05-18T12:00:00Z")),
    async run(cmd, runOpts) {
      if (envLog) envLog.push({ cmd: [...cmd], env: runOpts?.env });
      const idx = runs.findIndex(
        (s) =>
          s.cmd.length <= cmd.length &&
          s.cmd.every((tok, i) => tok === cmd[i]),
      );
      if (idx === -1) {
        return { stdout: "", stderr: `no stub for ${cmd.join(" ")}`, code: 127 };
      }
      const s = runs.splice(idx, 1)[0];
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      return {
        stdout: s.stdout ?? "",
        stderr: s.stderr ?? "",
        code: s.code ?? 0,
        timedOut: s.timedOut ?? false,
      };
    },
    async readFile(p) {
      return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
    },
    async fileExists(p) {
      return Object.prototype.hasOwnProperty.call(files, p);
    },
  };
}

// ── Fixes from PR #560 review ────────────────────────────────────────

test("collectStart: honors opts.session_id, start_head, started_at in session block", async () => {
  const envLog: Array<{ cmd: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const deps = makeDeps({
    envLog,
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        stdout: JSON.stringify({
          session_id: "from-state", started_at: "from-state",
          branch: "feat/x", repo: "x/y",
          tasks_completed: [], last_checkpoint: null, name: null,
          start_head: "from-state-sha",
        }),
      },
      { cmd: ["git", "branch", "--show-current"], stdout: "feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
      { cmd: ["git", "status", "--short"], stdout: "" },
      { cmd: ["git", "stash", "list"], stdout: "" },
      { cmd: ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"], stdout: "" },
      { cmd: ["gh", "pr", "list", "--author", "@me", "--state", "open"], stdout: "[]" },
      { cmd: ["gh", "pr", "view", "--json", "number,title,state,reviewDecision,statusCheckRollup"], code: 1 },
      // alerts, queue, canary, suggestions, persona, available, board — all OK
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"], stdout: JSON.stringify({ unacknowledged: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/emit_queue_cli.ts", "--health"], stdout: JSON.stringify({ pending_count: 0, dead_letter_count: 0, max_created_at: null }) },
      { cmd: ["python3", "/scripts/healer_canary.py", "--status", "--json"], stdout: JSON.stringify({ patterns: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts", "--context", "session", "--json"], stdout: JSON.stringify({ suggestions: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts", "select", "--auto"], stdout: JSON.stringify({ name: "Tony" }) },
      { cmd: ["python3", "/scripts/github_projects.py", "list-items"], stdout: "[]" },
      { cmd: ["sh", "-c"], stdout: "" },
    ],
  });
  const result = await collectStart(deps, {
    session_id: "from-cli",
    start_head: "from-cli-sha",
    started_at: "from-cli-time",
  });
  assert.equal(result.session?.session_id, "from-cli");
  assert.equal(result.session?.start_head, "from-cli-sha");
  assert.equal(result.session?.started_at, "from-cli-time");
  // session_state subprocess should have received CLAUDE_SESSION_ID = "from-cli"
  const sessionStateCall = envLog.find((e) =>
    e.cmd.some((c) => typeof c === "string" && c.endsWith("session_state.ts")),
  );
  assert.equal(sessionStateCall?.env?.CLAUDE_SESSION_ID, "from-cli");
});

test("collectStart: enforces total wall-clock deadline, slow collectors get null + timeout error", async () => {
  // One subprocess sleeps past the deadline; the call should still
  // return within the budget and that slot should be null with an
  // errors[] entry.
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        delayMs: 500,
        stdout: JSON.stringify({ session_id: "S", started_at: "", branch: "", repo: "",
          tasks_completed: [], last_checkpoint: null, name: null, start_head: null }),
      },
      { cmd: ["git", "branch", "--show-current"], stdout: "feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
      { cmd: ["git", "status", "--short"], stdout: "" },
      { cmd: ["git", "stash", "list"], stdout: "" },
      { cmd: ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"], stdout: "" },
      { cmd: ["gh", "pr", "list", "--author", "@me", "--state", "open"], stdout: "[]" },
      { cmd: ["gh", "pr", "view", "--json", "number,title,state,reviewDecision,statusCheckRollup"], code: 1 },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"], stdout: JSON.stringify({ unacknowledged: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/emit_queue_cli.ts", "--health"], stdout: JSON.stringify({ pending_count: 0, dead_letter_count: 0, max_created_at: null }) },
      { cmd: ["python3", "/scripts/healer_canary.py", "--status", "--json"], stdout: JSON.stringify({ patterns: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts", "--context", "session", "--json"], stdout: JSON.stringify({ suggestions: [] }) },
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts", "select", "--auto"], stdout: "{}" },
      { cmd: ["python3", "/scripts/github_projects.py", "list-items"], stdout: "[]" },
      { cmd: ["sh", "-c"], stdout: "" },
    ],
  });
  const t0 = Date.now();
  const result = await collectStart(deps, {
    session_id: "S", start_head: null, started_at: "",
    walltimeMs: 50, // 50ms deadline; the session_state call sleeps 500ms
  } as any);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 400, `expected fast exit, got ${elapsed}ms`);
  // The session_state slot should be null because it didn't return in time.
  assert.equal(result.session, null);
  assert.ok(result.errors.some((e) => e.source === "wall_clock_deadline"));
});

test("collectEnd: falls back to session_state.start_head when opts.start_head is null", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        stdout: JSON.stringify({
          session_id: "S", started_at: "", branch: "main", repo: "x/y",
          tasks_completed: [], last_checkpoint: null, name: null,
          start_head: "persisted-sha",
        }),
      },
      // collectDiffSummary should be invoked with persisted-sha, NOT fall to merge-base
      { cmd: ["git", "diff", "--numstat", "persisted-sha", "HEAD"], stdout: "5\t2\ta.ts\n" },
      { cmd: ["git", "diff", "--name-status", "persisted-sha", "HEAD"], stdout: "M\ta.ts\n" },
      { cmd: ["git", "rev-parse", "--abbrev-ref", "@{u}"], stdout: "origin/main\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
      { cmd: ["gh", "pr", "view", "--json", "number"], code: 1 },
    ],
  });
  const result = await collectEnd(deps, {
    session_id: "S", start_head: null, started_at: "", name: null,
  });
  assert.equal(result.diff?.added, 5);
  assert.equal(result.diff?.approximate, false);
  assert.equal(result.session.start_head, "persisted-sha");
});

test("collectHealthChecks: falls back to git toplevel when CWD has no config", async () => {
  const deps = makeDeps({
    files: {
      "/repo-root/.code-review/config.json": JSON.stringify({
        session: { health_checks: [{ name: "from-root", command: "echo ok" }] },
      }),
    },
    runs: [
      { cmd: ["git", "rev-parse", "--show-toplevel"], stdout: "/repo-root\n" },
      { cmd: ["sh", "-c", "echo ok"], stdout: "ok", code: 0 },
    ],
  });
  const result = await collectHealthChecks(deps, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "from-root");
});

test("collectBoard: --status flag includes Needs Clarification so needs_attention can fill", async () => {
  const envLog: Array<{ cmd: string[]; env: any }> = [];
  const deps = makeDeps({
    envLog,
    runs: [
      {
        cmd: ["python3", "/scripts/github_projects.py", "list-items"],
        stdout: JSON.stringify([{ title: "t1", number: "1", status: "Needs Clarification" }]),
      },
    ],
  });
  const result = await collectBoard(deps, []);
  // Statuses requested must include the clarification bucket
  const call = envLog.find((e) => e.cmd[1]?.endsWith("github_projects.py"));
  const statusFlagIdx = (call?.cmd ?? []).indexOf("--status");
  const statusArg = statusFlagIdx >= 0 ? call?.cmd[statusFlagIdx + 1] : "";
  assert.match(statusArg ?? "", /Needs Clarification/i);
  assert.equal(result?.needs_attention.length, 1);
});

test("pushSubprocessError: redacts GitHub tokens / Bearer headers from stderr", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        code: 1,
        stderr: "fatal: authentication failed: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 Bearer secret-token-here",
      },
    ],
  });
  const errors: ErrSlot[] = [];
  await collectSessionState(deps, errors);
  assert.equal(errors.length, 1);
  const msg = errors[0].message;
  assert.ok(!/ghp_abcdefghijklmnopqrstuvwxyz0123456789/.test(msg), `expected ghp token redacted: ${msg}`);
  assert.ok(!/secret-token-here/i.test(msg), `expected bearer redacted: ${msg}`);
  assert.match(msg, /REDACTED/);
});

test("collector: marks slot null + records timeout when result.timedOut", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"],
        code: 124, timedOut: true, stderr: "",
      },
    ],
  });
  const errors: ErrSlot[] = [];
  const result = await collectAlerts(deps, errors);
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, "alerts");
  assert.match(errors[0].message, /timeout/i);
});

// ── collectHealerCategories ──────────────────────────────────────────

test("collectHealerCategories: returns null when healer.jsonl is missing", async () => {
  const deps = makeDeps({ files: {} });
  const errors: ErrSlot[] = [];
  const result = await collectHealerCategories(deps, errors);
  assert.equal(result, null);
  assert.equal(errors.length, 0);
});

// ── collectQueueHealth ───────────────────────────────────────────────

test("collectQueueHealth: returns null when emit_queue_cli --health fails", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/emit_queue_cli.ts", "--health"],
        code: 1,
        stderr: "boom",
      },
    ],
  });
  const errors: ErrSlot[] = [];
  const result = await collectQueueHealth(deps, errors);
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, "queue");
});

test("collectQueueHealth: parses pending + dead-letter + max_created_at", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/emit_queue_cli.ts", "--health"],
        stdout: JSON.stringify({
          pending_count: 3,
          dead_letter_count: 1,
          max_created_at: "2026-05-18T10:00:00Z",
        }),
      },
    ],
  });
  const errors: ErrSlot[] = [];
  const result = await collectQueueHealth(deps, errors);
  assert.deepEqual(result, {
    pending: 3,
    dead_letter: 1,
    max_created_at: "2026-05-18T10:00:00Z",
  });
  assert.equal(errors.length, 0);
});

// ── collectCanaryStatus ──────────────────────────────────────────────

test("collectCanaryStatus: returns null when canary script not found", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["python3", "/scripts/healer_canary.py", "--status", "--json"], code: 2, stderr: "no" },
    ],
  });
  const errors: ErrSlot[] = [];
  assert.equal(await collectCanaryStatus(deps, errors), null);
});

test("collectCanaryStatus: extracts circuits_open + near_promotion", async () => {
  const payload = {
    patterns: [
      { name: "p1", circuit: "open", mode: "block", successful_suggests: 0 },
      { name: "p2", circuit: "closed", mode: "suggest", successful_suggests: 5 },
      { name: "p3", circuit: "closed", mode: "suggest", successful_suggests: 1 },
    ],
  };
  const deps = makeDeps({
    runs: [
      {
        cmd: ["python3", "/scripts/healer_canary.py", "--status", "--json"],
        stdout: JSON.stringify(payload),
      },
    ],
  });
  const errors: ErrSlot[] = [];
  const result = await collectCanaryStatus(deps, errors);
  assert.deepEqual(result, {
    circuits_open: ["p1"],
    near_promotion: ["p2"],
  });
});

// ── collectAlerts ────────────────────────────────────────────────────

test("collectAlerts: returns null when alert_delivery script fails", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"], code: 1 },
    ],
  });
  assert.equal(await collectAlerts(deps, []), null);
});

test("collectAlerts: returns unacknowledged list with normalized fields", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"],
        stdout: JSON.stringify({
          unacknowledged: [
            { level: "warning", message: "stale branch", context: "topic-a" },
            { level: "critical", message: "queue full" },
          ],
        }),
      },
    ],
  });
  const result = await collectAlerts(deps, []);
  assert.deepEqual(result, {
    unacknowledged: [
      { level: "warning", message: "stale branch", context: "topic-a" },
      { level: "critical", message: "queue full", context: "" },
    ],
  });
});

// ── collectSkillSuggestions ──────────────────────────────────────────

test("collectSkillSuggestions: returns [] when script fails", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts", "--context", "session", "--json"], code: 1 },
    ],
  });
  assert.deepEqual(await collectSkillSuggestions(deps, []), []);
});

test("collectSkillSuggestions: capped at 2 entries", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts", "--context", "session", "--json"],
        stdout: JSON.stringify({
          suggestions: [
            { name: "a", reason: "r1" },
            { name: "b", reason: "r2" },
            { name: "c", reason: "r3" },
          ],
        }),
      },
    ],
  });
  const result = await collectSkillSuggestions(deps, []);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { name: "a", reason: "r1" });
});

// ── collectPersona ───────────────────────────────────────────────────

test("collectPersona: returns null when stark_persona script fails", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts", "select", "--auto"], code: 1 },
    ],
  });
  assert.equal(await collectPersona(deps, []), null);
});

test("collectPersona: passes through name + catchphrase + source", async () => {
  const persona = { name: "TonyStark", source: "manual", catchphrase: "I am Iron Man" };
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts", "select", "--auto"],
        stdout: JSON.stringify(persona),
      },
    ],
  });
  const result = await collectPersona(deps, []);
  assert.deepEqual(result, persona);
});

// ── collectBoard ─────────────────────────────────────────────────────

test("collectBoard: returns null when board script fails", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["python3", "/scripts/github_projects.py", "list-items"],
        code: 1,
      },
    ],
  });
  assert.equal(await collectBoard(deps, []), null);
});

test("collectBoard: bucket items into in_flight / blocked / needs_attention", async () => {
  const items = [
    { title: "t1", number: "10", status: "In Progress" },
    { title: "t2", number: "11", status: "Blocked" },
    { title: "t3", number: "12", status: "Needs Clarification" },
  ];
  const deps = makeDeps({
    runs: [
      {
        cmd: ["python3", "/scripts/github_projects.py", "list-items"],
        stdout: JSON.stringify(items),
      },
    ],
  });
  const result = await collectBoard(deps, []);
  assert.deepEqual(result, {
    in_flight: [{ title: "t1", issue_number: "10" }],
    blocked: [{ title: "t2", issue_number: "11" }],
    needs_attention: [{ title: "t3", issue_number: "12" }],
  });
});

// ── collectSessionState ──────────────────────────────────────────────

test("collectSessionState: returns null when script fails", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"], code: 1 },
    ],
  });
  assert.equal(await collectSessionState(deps, []), null);
});

test("collectSessionState: returns parsed state payload", async () => {
  const state = {
    session_id: "abc",
    started_at: "2026-05-18T10:00:00Z",
    branch: "main",
    repo: "x/y",
    tasks_completed: ["t1"],
    last_checkpoint: null,
    name: null,
    start_head: "deadbeef",
  };
  const deps = makeDeps({
    runs: [
      { cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"], stdout: JSON.stringify(state) },
    ],
  });
  const result = await collectSessionState(deps, []);
  assert.equal(result?.session_id, "abc");
  assert.equal(result?.branch, "main");
  assert.equal(result?.start_head, "deadbeef");
});

// ── collectGit ───────────────────────────────────────────────────────

test("collectGit: returns null when git branch lookup fails", async () => {
  const deps = makeDeps({
    runs: [{ cmd: ["git", "branch", "--show-current"], code: 128 }],
  });
  assert.equal(await collectGit(deps, []), null);
});

test("collectGit: assembles branch + ahead/behind + uncommitted + recent commits", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["git", "branch", "--show-current"], stdout: "feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "1\t2\n" },
      { cmd: ["git", "status", "--short"], stdout: " M file.ts\n?? new.md\n" },
      { cmd: ["git", "stash", "list"], stdout: "stash@{0}\nstash@{1}\n" },
      {
        cmd: ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"],
        stdout: "abc1234|fix: x|2 hours ago\ndef5678|feat: y|1 day ago\n",
      },
    ],
  });
  const result = await collectGit(deps, []);
  assert.equal(result?.branch, "feat/x");
  assert.equal(result?.ahead, 2);
  assert.equal(result?.behind, 1);
  assert.deepEqual(result?.uncommitted, [" M file.ts", "?? new.md"]);
  assert.equal(result?.stashes, 2);
  assert.equal(result?.recent_commits.length, 2);
  assert.deepEqual(result?.recent_commits[0], {
    sha: "abc1234",
    message: "fix: x",
    age: "2 hours ago",
  });
});

// ── collectPRs ───────────────────────────────────────────────────────

test("collectPRs: returns null when gh is unavailable", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["gh", "pr", "list", "--author", "@me", "--state", "open"], code: 127, stderr: "gh not found" },
    ],
  });
  assert.equal(await collectPRs(deps, "feat/x", []), null);
});

test("collectPRs: returns mine + current_branch when both succeed", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["gh", "pr", "list", "--author", "@me", "--state", "open"],
        stdout: JSON.stringify([
          { number: 1, title: "PR1", headRefName: "feat/x", reviewDecision: "APPROVED", url: "u1" },
          { number: 2, title: "PR2", headRefName: "feat/y", reviewDecision: "", url: "u2" },
        ]),
      },
      {
        cmd: ["gh", "pr", "view", "--json", "number,title,state,reviewDecision,statusCheckRollup"],
        stdout: JSON.stringify({
          number: 1, title: "PR1", state: "OPEN", reviewDecision: "APPROVED",
          statusCheckRollup: [
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
            { conclusion: "" },
          ],
        }),
      },
    ],
  });
  const result = await collectPRs(deps, "feat/x", []);
  assert.equal(result?.mine.length, 2);
  assert.equal(result?.mine[0].number, 1);
  assert.equal(result?.mine[0].review_decision, "APPROVED");
  assert.equal(result?.current_branch?.number, 1);
  assert.deepEqual(result?.current_branch?.checks, { pass: 1, fail: 1, pending: 1 });
});

// ── collectAvailableSkills ───────────────────────────────────────────

test("collectAvailableSkills: globs SKILL.md from both locations and dedupes", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["sh", "-c"],
        stdout:
          "/home/u/.claude/skills/alpha/SKILL.md\n" +
          "/home/u/.claude/skills/beta/SKILL.md\n" +
          ".claude/skills/beta/SKILL.md\n" +
          ".claude/skills/gamma/SKILL.md\n",
      },
    ],
  });
  const result = await collectAvailableSkills(deps, []);
  assert.deepEqual(result, ["alpha", "beta", "gamma"]);
});

// ── collectHealthChecks ──────────────────────────────────────────────

test("collectHealthChecks: returns [] when no config file", async () => {
  const deps = makeDeps({ files: {} });
  assert.deepEqual(await collectHealthChecks(deps, []), []);
});

test("collectHealthChecks: runs each configured command, reports pass/fail+duration", async () => {
  const cfgPath = ".code-review/config.json";
  const deps = makeDeps({
    files: {
      [cfgPath]: JSON.stringify({
        session: {
          health_checks: [
            { name: "alpha", command: "echo ok" },
            { name: "beta", command: "false" },
          ],
        },
      }),
    },
    runs: [
      { cmd: ["sh", "-c", "echo ok"], stdout: "ok", code: 0 },
      { cmd: ["sh", "-c", "false"], stderr: "fail", code: 1 },
    ],
  });
  const result = await collectHealthChecks(deps, []);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "alpha");
  assert.equal(result[0].passed, true);
  assert.equal(result[1].name, "beta");
  assert.equal(result[1].passed, false);
});

// ── collectDiffSummary ───────────────────────────────────────────────

test("collectDiffSummary: returns null when start_head unset and no merge-base", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["git", "merge-base", "origin/main", "HEAD"], code: 1 },
    ],
  });
  const result = await collectDiffSummary(deps, null, []);
  assert.equal(result, null);
});

test("collectDiffSummary: parses added/removed/file_count + key files", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["git", "diff", "--numstat", "deadbeef", "HEAD"],
        stdout: "10\t2\tfile_a.ts\n3\t1\tfile_b.md\n-\t-\tbinary.png\n",
      },
      {
        cmd: ["git", "diff", "--name-status", "deadbeef", "HEAD"],
        stdout: "M\tfile_a.ts\nA\tfile_b.md\nM\tbinary.png\n",
      },
    ],
  });
  const result = await collectDiffSummary(deps, "deadbeef", []);
  assert.equal(result?.added, 13);
  assert.equal(result?.removed, 3);
  assert.equal(result?.file_count, 3);
  assert.equal(result?.approximate, false);
  // key_files ordered by total lines changed desc
  assert.equal(result?.key_files[0].path, "file_a.ts");
  assert.equal(result?.key_files[0].status, "M");
});

test("collectDiffSummary: marks approximate when falling back to merge-base", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["git", "merge-base", "origin/main", "HEAD"], stdout: "abc123\n" },
      { cmd: ["git", "diff", "--numstat", "abc123", "HEAD"], stdout: "1\t0\ta.txt\n" },
      { cmd: ["git", "diff", "--name-status", "abc123", "HEAD"], stdout: "M\ta.txt\n" },
    ],
  });
  const result = await collectDiffSummary(deps, null, []);
  assert.equal(result?.approximate, true);
});

// ── collectBranchState ───────────────────────────────────────────────

test("collectBranchState: returns ahead/behind + upstream + PR flag", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["git", "rev-parse", "--abbrev-ref", "@{u}"], stdout: "origin/feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "1\t3\n" },
      {
        cmd: ["gh", "pr", "view", "--json", "number"],
        stdout: JSON.stringify({ number: 42 }),
        code: 0,
      },
    ],
  });
  const result = await collectBranchState(deps, []);
  assert.equal(result.ahead, 3);
  assert.equal(result.behind, 1);
  assert.equal(result.upstream, "origin/feat/x");
  assert.equal(result.has_pr, true);
});

test("collectBranchState: degrades gracefully when no upstream + no PR", async () => {
  const deps = makeDeps({
    runs: [
      { cmd: ["git", "rev-parse", "--abbrev-ref", "@{u}"], code: 128 },
      { cmd: ["gh", "pr", "view", "--json", "number"], code: 1 },
    ],
  });
  const result = await collectBranchState(deps, []);
  assert.equal(result.upstream, null);
  assert.equal(result.has_pr, false);
});

// ── collectStart (orchestrator) ──────────────────────────────────────

test("collectStart: assembles every slot with overrides honored", async () => {
  const deps = makeDeps({
    runs: [
      // session_state
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        stdout: JSON.stringify({
          session_id: "S1", started_at: "T0", branch: "feat/x", repo: "x/y",
          tasks_completed: [], last_checkpoint: null, name: null, start_head: null,
        }),
      },
      // git
      { cmd: ["git", "branch", "--show-current"], stdout: "feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t0\n" },
      { cmd: ["git", "status", "--short"], stdout: "" },
      { cmd: ["git", "stash", "list"], stdout: "" },
      { cmd: ["git", "log", "--oneline", "--format=%h|%s|%ar", "-5"], stdout: "" },
      // prs
      { cmd: ["gh", "pr", "list", "--author", "@me", "--state", "open"], stdout: "[]" },
      { cmd: ["gh", "pr", "view", "--json", "number,title,state,reviewDecision,statusCheckRollup"], code: 1 },
      // board
      {
        cmd: ["python3", "/scripts/github_projects.py", "list-items"],
        stdout: "[]",
      },
      // alerts
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/alert_delivery.ts", "--check", "--json"],
        stdout: JSON.stringify({ unacknowledged: [] }),
      },
      // queue health
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/emit_queue_cli.ts", "--health"],
        stdout: JSON.stringify({ pending_count: 0, dead_letter_count: 0, max_created_at: null }),
      },
      // canary
      {
        cmd: ["python3", "/scripts/healer_canary.py", "--status", "--json"],
        stdout: JSON.stringify({ patterns: [] }),
      },
      // skills suggestions
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/skill_router.ts", "--context", "session", "--json"],
        stdout: JSON.stringify({ suggestions: [] }),
      },
      // persona
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/stark_persona.ts", "select", "--auto"],
        stdout: JSON.stringify({ name: "Tony", source: "manual", catchphrase: "..." }),
      },
      // available skills
      { cmd: ["sh", "-c"], stdout: "/home/u/.claude/skills/alpha/SKILL.md\n" },
    ],
    files: {},
  });
  const result = await collectStart(deps, {
    session_id: "S1",
    start_head: "deadbeef",
    started_at: "T0",
  });
  assert.equal(result.session?.session_id, "S1");
  assert.equal(result.git?.branch, "feat/x");
  assert.equal(result.prs?.mine.length, 0);
  assert.equal(result.queue?.pending, 0);
  assert.equal(result.skills.available.length, 1);
  assert.equal(result.persona?.name, "Tony");
  assert.equal(result.errors.length, 0);
});

// ── collectEnd (orchestrator) ────────────────────────────────────────

test("collectEnd: assembles session + diff + branch state", async () => {
  const deps = makeDeps({
    runs: [
      {
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tools/session_state.ts", "--json"],
        stdout: JSON.stringify({
          session_id: "S1", started_at: "T0", branch: "feat/x", repo: "x/y",
          tasks_completed: [], last_checkpoint: null, name: null, start_head: "deadbeef",
        }),
      },
      { cmd: ["git", "diff", "--numstat", "deadbeef", "HEAD"], stdout: "5\t2\ta.ts\n" },
      { cmd: ["git", "diff", "--name-status", "deadbeef", "HEAD"], stdout: "M\ta.ts\n" },
      { cmd: ["git", "rev-parse", "--abbrev-ref", "@{u}"], stdout: "origin/feat/x\n" },
      { cmd: ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], stdout: "0\t1\n" },
      { cmd: ["gh", "pr", "view", "--json", "number"], stdout: JSON.stringify({ number: 42 }) },
    ],
  });
  const result = await collectEnd(deps, {
    session_id: "S1",
    start_head: "deadbeef",
    started_at: "T0",
    name: "session-name",
  });
  assert.equal(result.session.session_id, "S1");
  assert.equal(result.session.name, "session-name");
  assert.equal(result.diff?.added, 5);
  assert.equal(result.branch.has_pr, true);
});

test("collectHealerCategories: counts categories sorted desc, top 5", async () => {
  const home = "/home/u";
  const path = `${home}/.claude/code-review/healer.jsonl`;
  // 1×alpha, 3×beta, 2×gamma, 1×delta, 1×epsilon, 1×zeta, malformed line ignored
  const body = [
    '{"category":"alpha"}',
    '{"category":"beta"}',
    '{"category":"beta"}',
    '{"category":"beta"}',
    '{"category":"gamma"}',
    '{"category":"gamma"}',
    '{"category":"delta"}',
    '{"category":"epsilon"}',
    '{"category":"zeta"}',
    "not-json",
    "", // blank line
  ].join("\n");
  const deps = makeDeps({
    files: { [path]: body },
    home,
  });
  const errors: ErrSlot[] = [];
  const result = await collectHealerCategories(deps, errors);
  assert.deepEqual(result, [
    { name: "beta", count: 3 },
    { name: "gamma", count: 2 },
    { name: "alpha", count: 1 },
    { name: "delta", count: 1 },
    { name: "epsilon", count: 1 },
  ]);
  assert.equal(errors.length, 0);
});
