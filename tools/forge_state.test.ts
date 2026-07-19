// Tests for `tools/forge_state.ts` — the HOST (disk) layer of `/stark-forge`.
// Run: node --experimental-strip-types --test tools/forge_state.test.ts
//
// Covers the Phase 3 named tests against a temp `stateRoot()` (via
// STARK_STATE_ROOT): #11 atomic write, #12 retention, #15 0600 perms, plus
// listResumeCandidates multi-slug enumeration + latest-pointer recovery +
// repo-scoping, plus the parseRemoteUrl canonicalizer.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  forgeHistoryRoot,
  listResumeCandidates,
  loadState,
  parseRemoteUrl,
  persistState,
  resolveLatest,
  slugDir,
} from "./forge_state.ts";
import type { RepoIdentity, RunState } from "./forge_state_lib.ts";

const REPO: RepoIdentity = {
  host: "github.com",
  owner: "21StarkCom",
  name: "stark-skills",
};
const OTHER_REPO: RepoIdentity = {
  host: "github.com",
  owner: "someone",
  name: "other",
};

/** Build a minimal-but-complete RunState for persistence tests. */
function makeState(
  slug: string,
  runId: string,
  repo: RepoIdentity = REPO,
): RunState {
  return {
    slug,
    run_id: runId,
    input: { kind: "intent", value: "do a thing" },
    initial_artifacts: {},
    mode: "in-session",
    chain: ["write-spec", "review-spec"],
    merge_points: [{ after_stage: "review-spec", artifact: "spec" }],
    artifact_prs: {},
    repo,
    default_branch: "main",
    created_at: "2026-07-19T00:00:00Z",
    updated_at: "2026-07-19T00:00:00Z",
    abandoned_at: null,
    // One stage record per chain entry (the chain is two stages, so are these).
    stages: [
      {
        stage: "write-spec",
        status: "pending",
        prs: [],
        merges: [],
        fold_prs: [],
        artifacts: {},
        gate: null,
        started_at: null,
        ended_at: null,
        attempts: [],
      },
      {
        stage: "review-spec",
        status: "pending",
        prs: [],
        merges: [],
        fold_prs: [],
        artifacts: {},
        gate: null,
        started_at: null,
        ended_at: null,
        attempts: [],
      },
    ],
  };
}

/** Run `fn` with STARK_STATE_ROOT + HOME pointed at fresh temp dirs, and an
 * optional forge_pipeline config override written into the HOME config. */
function withTempRoots(
  fn: (stateDir: string) => void,
  pipelineOverride?: Record<string, unknown>,
): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-state-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "forge-home-"));
  const prevState = process.env.STARK_STATE_ROOT;
  const prevHome = process.env.HOME;
  process.env.STARK_STATE_ROOT = stateDir;
  process.env.HOME = home;
  if (pipelineOverride) {
    const cfgFile = path.join(home, ".claude", "code-review", "config.json");
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({ forge_pipeline: pipelineOverride }),
    );
  }
  try {
    fn(stateDir);
  } finally {
    if (prevState === undefined) delete process.env.STARK_STATE_ROOT;
    else process.env.STARK_STATE_ROOT = prevState;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// #11 — atomic write leaves no partial state on failure
// ---------------------------------------------------------------------------

test("#11 atomic write leaves no partial/corrupt state on a failed write", () => {
  withTempRoots(() => {
    const good = makeState("atomic-test", "20260719-000000-aaa");
    persistState(good);
    const file = path.join(slugDir(good.slug), good.run_id, "state.json");

    // A serialization failure (circular ref) must throw BEFORE any rename, so
    // the previously-persisted state.json is left fully intact — no partial.
    const circular = makeState("atomic-test", "20260719-000000-aaa") as unknown as {
      self?: unknown;
    };
    circular.self = circular;
    assert.throws(() => persistState(circular as unknown as RunState));

    const reread = JSON.parse(fs.readFileSync(file, "utf8")) as RunState;
    assert.equal(reread.run_id, good.run_id);
    assert.equal(reread.slug, good.slug);
    assert.deepEqual(reread, good);
  });
});

// ---------------------------------------------------------------------------
// #12 — retention prunes to history_keep_runs, keeps latest pointer
// ---------------------------------------------------------------------------

test("#12 retention prunes to history_keep_runs and keeps the latest pointer", () => {
  withTempRoots(
    () => {
      const slug = "retain-test";
      const runIds = [
        "20260719-000000-aaa",
        "20260719-010000-bbb",
        "20260719-020000-ccc",
      ];
      for (const id of runIds) persistState(makeState(slug, id));

      const remaining = fs
        .readdirSync(slugDir(slug), { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.isSymbolicLink() &&
            e.name !== "latest" &&
            e.name !== "latest.txt",
        )
        .map((e) => e.name)
        .sort();
      assert.deepEqual(remaining, ["20260719-010000-bbb", "20260719-020000-ccc"]);

      // latest points at the newest run, and loadState with no runId resolves it.
      assert.equal(resolveLatest(slug), "20260719-020000-ccc");
      assert.equal(loadState(slug).run_id, "20260719-020000-ccc");
    },
    { history_keep_runs: 2 },
  );
});

test("#12b persisting an older resumed run keeps it and a valid latest pointer", () => {
  withTempRoots(
    () => {
      const slug = "resume-retain";
      // Persist newer B and C first (retention full at keep=2), then persist an
      // OLDER run A (a resumed run). Retention keeps the lexicographically-newest
      // ids and would prune A — the very run we just wrote — leaving `latest`
      // dangling. persistState must preserve A and repoint latest at it.
      persistState(makeState(slug, "20260719-010000-bbb"));
      persistState(makeState(slug, "20260719-020000-ccc"));
      persistState(makeState(slug, "20260719-000000-aaa"));

      const aDir = path.join(slugDir(slug), "20260719-000000-aaa", "state.json");
      assert.ok(fs.existsSync(aDir), "just-persisted older run A must survive pruning");

      // The cap stays EXACT: preserving the resumed A must NOT leave keep+1 dirs.
      // Retention keeps A (current) + the (keep-1) newest others = {A, C}; the
      // oldest other (B) is evicted.
      const remaining = fs
        .readdirSync(slugDir(slug), { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.isSymbolicLink() &&
            e.name !== "latest" &&
            e.name !== "latest.txt",
        )
        .map((e) => e.name)
        .sort();
      assert.deepEqual(
        remaining,
        ["20260719-000000-aaa", "20260719-020000-ccc"],
        "exactly history_keep_runs dirs: the resumed run + the newest other",
      );

      // latest resolves to the just-persisted run and loadState follows it.
      assert.equal(resolveLatest(slug), "20260719-000000-aaa");
      assert.equal(loadState(slug).run_id, "20260719-000000-aaa");
    },
    { history_keep_runs: 2 },
  );
});

// ---------------------------------------------------------------------------
// #15 — state files written 0600
// ---------------------------------------------------------------------------

test("#15 state files are written mode 0600", () => {
  withTempRoots(() => {
    const s = makeState("perm-test", "20260719-000000-aaa");
    persistState(s);
    const file = path.join(slugDir(s.slug), s.run_id, "state.json");
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `state.json mode ${mode.toString(8)} != 600`);
  });
});

// ---------------------------------------------------------------------------
// listResumeCandidates — multi-slug + pointer recovery + repo scoping
// ---------------------------------------------------------------------------

test("listResumeCandidates enumerates multiple slugs and recovers a missing latest pointer", () => {
  withTempRoots(() => {
    // slug A: persisted normally (pointer present).
    persistState(makeState("alpha", "20260719-000000-aaa"));

    // slug B: simulate a crash between the state-file write and the pointer
    // swap — write state.json by hand, NO latest pointer.
    const bDir = path.join(slugDir("beta"), "20260719-010000-bbb");
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(
      path.join(bDir, "state.json"),
      JSON.stringify(makeState("beta", "20260719-010000-bbb")),
    );
    assert.throws(() => resolveLatest("beta"), /no 'latest' pointer/);

    const found = listResumeCandidates(REPO);
    const slugs = found.map((s) => s.slug).sort();
    assert.deepEqual(slugs, ["alpha", "beta"]);

    // The missing pointer was repaired in-place.
    assert.equal(resolveLatest("beta"), "20260719-010000-bbb");

    // Deterministic order: newest run-id first (beta's 010000 > alpha's 000000).
    assert.equal(found[0].slug, "beta");
    assert.equal(found[1].slug, "alpha");
  });
});

test("listResumeCandidates never surfaces another repo's run", () => {
  withTempRoots(() => {
    persistState(makeState("mine", "20260719-000000-aaa", REPO));
    persistState(makeState("theirs", "20260719-010000-bbb", OTHER_REPO));

    const found = listResumeCandidates(REPO);
    assert.deepEqual(
      found.map((s) => s.slug),
      ["mine"],
    );
  });
});

test("listResumeCandidates scopes latest-pointer recovery to the current repo (same slug, two repos)", () => {
  withTempRoots(() => {
    // Same slug, two repositories. The FOREIGN run is newer, so after it is
    // persisted `latest` points at it. Discovery from the current repo must NOT
    // let the newer foreign run steer the pointer — it recovers the pointer to
    // the current repo's newest run, so a subsequent slug-only load resolves the
    // right repository's run (the regression the wing flagged).
    const slug = "shared";
    persistState(makeState(slug, "20260719-000000-aaa", REPO));
    persistState(makeState(slug, "20260719-020000-ccc", OTHER_REPO));
    // Sanity: the last write left `latest` on the foreign (newer) run.
    assert.equal(resolveLatest(slug), "20260719-020000-ccc");

    const found = listResumeCandidates(REPO);
    assert.deepEqual(
      found.map((s) => s.run_id),
      ["20260719-000000-aaa"],
      "only the current repo's run is a candidate",
    );

    // Pointer recovered to the current repo's run, so slug-only load is correct.
    assert.equal(resolveLatest(slug), "20260719-000000-aaa");
    assert.equal(loadState(slug).repo.owner, REPO.owner);
  });
});

test("listResumeCandidates skips an unreadable slug dir and still finds valid runs beside it", () => {
  withTempRoots(() => {
    persistState(makeState("good", "20260719-000000-aaa"));

    // A slug dir that cannot be enumerated (chmod 000). One hostile/broken
    // entry must never abort discovery of every valid run next to it.
    const badDir = slugDir("unreadable");
    fs.mkdirSync(badDir, { recursive: true });
    fs.chmodSync(badDir, 0o000);
    try {
      const found = listResumeCandidates(REPO);
      assert.deepEqual(found.map((s) => s.slug), ["good"]);
    } finally {
      // restore so the temp-root cleanup can remove it
      fs.chmodSync(badDir, 0o700);
    }
  });
});

test("listResumeCandidates skips a slug dir that disappears mid-scan", () => {
  withTempRoots(() => {
    persistState(makeState("good", "20260719-000000-aaa"));

    // Directory present at root-scan time, gone by the time it is enumerated.
    const vanishing = slugDir("vanishing");
    fs.mkdirSync(vanishing, { recursive: true });
    const realReaddir = fs.readdirSync;
    (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = ((
      p: fs.PathLike,
      o?: never,
    ) => {
      if (String(p) === vanishing) {
        fs.rmSync(vanishing, { recursive: true, force: true });
        const e = new Error("ENOENT: no such file or directory") as Error & {
          code?: string;
        };
        e.code = "ENOENT";
        throw e;
      }
      return realReaddir(p, o);
    }) as typeof fs.readdirSync;
    try {
      const found = listResumeCandidates(REPO);
      assert.deepEqual(found.map((s) => s.slug), ["good"]);
    } finally {
      (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = realReaddir;
    }
  });
});

test("listResumeCandidates returns [] when no persisted run matches the repo", () => {
  withTempRoots(() => {
    persistState(makeState("mine", "20260719-000000-aaa", REPO));
    assert.deepEqual(
      listResumeCandidates({ host: "nope", owner: "nope", name: "nope" }),
      [],
    );
  });
});

test("listResumeCandidates returns [] when no history root exists", () => {
  withTempRoots(() => {
    assert.ok(!fs.existsSync(forgeHistoryRoot()));
    assert.deepEqual(listResumeCandidates(REPO), []);
  });
});

test("listResumeCandidates repairs a stale-but-valid latest pointer", () => {
  withTempRoots(() => {
    // Persist A then B. Simulate the crash where B's state.json landed but the
    // pointer swap didn't: force `latest` back to the OLDER run A. A is still a
    // valid run, so a membership-only check would wrongly treat this as OK.
    persistState(makeState("gamma", "20260719-000000-aaa"));
    persistState(makeState("gamma", "20260719-010000-bbb"));

    const dir = slugDir("gamma");
    fs.rmSync(path.join(dir, "latest"), { force: true });
    fs.rmSync(path.join(dir, "latest.txt"), { force: true });
    fs.writeFileSync(path.join(dir, "latest.txt"), "20260719-000000-aaa");
    assert.equal(resolveLatest("gamma"), "20260719-000000-aaa"); // stale

    listResumeCandidates(REPO);

    // Repaired to the NEWEST valid run, not left pointing at the stale-but-valid A.
    assert.equal(resolveLatest("gamma"), "20260719-010000-bbb");
  });
});

test("listResumeCandidates skips a corrupt state and still finds valid runs", () => {
  withTempRoots(() => {
    // A valid run + a parseable-but-corrupt one (`repo: {}`) under the same slug.
    persistState(makeState("delta", "20260719-000000-aaa"));
    const badDir = path.join(slugDir("delta"), "20260719-010000-bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "state.json"),
      JSON.stringify({ slug: "delta", run_id: "20260719-010000-bad", repo: {} }),
    );

    // The corrupt run is skipped; the valid run is still discovered (no crash).
    const found = listResumeCandidates(REPO);
    assert.deepEqual(
      found.map((s) => s.run_id),
      ["20260719-000000-aaa"],
    );
  });
});

test("listResumeCandidates skips an unsafe slug dir and still finds valid runs", () => {
  withTempRoots(() => {
    // A valid run, plus a stray noncanonical directory (`.bad`) whose name fails
    // the disk-boundary slug check (`slugDir` throws `unsafe_slug`). Discovery
    // must skip it, not let the throw abort enumeration of the valid run.
    persistState(makeState("safe", "20260719-000000-aaa"));
    const badSlugDir = path.join(forgeHistoryRoot(), ".bad");
    fs.mkdirSync(path.join(badSlugDir, "20260719-010000-bbb"), { recursive: true });
    fs.writeFileSync(
      path.join(badSlugDir, "20260719-010000-bbb", "state.json"),
      JSON.stringify(makeState(".bad", "20260719-010000-bbb")),
    );

    const found = listResumeCandidates(REPO);
    assert.deepEqual(
      found.map((s) => s.slug),
      ["safe"],
    );
  });
});

test("loadState reports corruption on a structurally-invalid state.json", () => {
  withTempRoots(() => {
    const dir = path.join(slugDir("epsilon"), "20260719-000000-aaa");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ slug: "epsilon", run_id: "20260719-000000-aaa", repo: {} }),
    );
    assert.throws(
      () => loadState("epsilon", "20260719-000000-aaa"),
      /corrupt state\.json/,
    );
  });
});

test("loadState rejects a state.json whose identity does not match its location", () => {
  withTempRoots(() => {
    // A structurally-valid state written under the WRONG slug/run-id directory
    // (e.g. a misplaced/relocated file). loadState must refuse it — otherwise
    // the next persistState would redirect into a different run dir.
    const dir = path.join(slugDir("here"), "20260719-000000-aaa");
    fs.mkdirSync(dir, { recursive: true });
    // slug says "elsewhere", run_id says a different id — both mismatch the path.
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(makeState("elsewhere", "20260719-999999-zzz")),
    );
    assert.throws(
      () => loadState("here", "20260719-000000-aaa"),
      /does not match its location/,
    );
  });
});

test("listResumeCandidates skips a state.json whose identity does not match its location", () => {
  withTempRoots(() => {
    persistState(makeState("good", "20260719-000000-aaa"));
    // A valid-but-misplaced file: contents describe another slug/run.
    const dir = path.join(slugDir("good"), "20260719-010000-mis");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(makeState("good", "20260719-999999-zzz")),
    );
    const found = listResumeCandidates(REPO);
    assert.deepEqual(
      found.map((s) => s.run_id),
      ["20260719-000000-aaa"],
    );
  });
});

// ---------------------------------------------------------------------------
// Table-driven schema validation — every malformed form of a RunState is
// rejected by loadState AND skipped by discovery (never surfaced as valid).
// ---------------------------------------------------------------------------

/** Deep-clone the canonical valid state, then mutate it into a malformed form. */
function corrupt(mutate: (s: Record<string, unknown>) => void): unknown {
  const s = JSON.parse(
    JSON.stringify(makeState("tbl", "20260719-000000-aaa")),
  ) as Record<string, unknown>;
  mutate(s);
  return s;
}

const MALFORMED: Array<{ name: string; value: unknown }> = [
  { name: "missing slug", value: corrupt((s) => delete s.slug) },
  { name: "missing run_id", value: corrupt((s) => delete s.run_id) },
  { name: "missing input", value: corrupt((s) => delete s.input) },
  {
    name: "invalid input kind",
    value: corrupt((s) => {
      (s.input as Record<string, unknown>).kind = "bogus";
    }),
  },
  {
    name: "input value non-string",
    value: corrupt((s) => {
      (s.input as Record<string, unknown>).value = 42;
    }),
  },
  { name: "invalid mode", value: corrupt((s) => (s.mode = "turbo")) },
  { name: "missing repo", value: corrupt((s) => delete s.repo) },
  { name: "repo missing owner", value: corrupt((s) => delete (s.repo as Record<string, unknown>).owner) },
  { name: "missing default_branch", value: corrupt((s) => delete s.default_branch) },
  { name: "missing created_at", value: corrupt((s) => delete s.created_at) },
  { name: "chain not array", value: corrupt((s) => (s.chain = "write-spec")) },
  { name: "empty chain", value: corrupt((s) => (s.chain = [])) },
  {
    name: "chain has invalid stage",
    value: corrupt((s) => ((s.chain as string[])[0] = "bogus-stage")),
  },
  { name: "stages not array", value: corrupt((s) => (s.stages = {})) },
  {
    name: "stages/chain length mismatch",
    value: corrupt((s) => (s.stages as unknown[]).pop()),
  },
  {
    name: "stages/chain order mismatch",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>).reverse();
    }),
  },
  {
    name: "stage invalid status",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].status = "zombie";
    }),
  },
  {
    name: "stage prs non-numeric",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].prs = ["x"];
    }),
  },
  {
    name: "stage gate malformed",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].gate = { reason: 1 };
    }),
  },
  {
    name: "stage merges malformed",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].merges = [{ pr: "x" }];
    }),
  },
  {
    name: "stage attempts malformed",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].attempts = [
        { outcome: "nope" },
      ];
    }),
  },
  {
    name: "stage artifacts non-string scalar",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].artifacts = {
        spec_path: 5,
      };
    }),
  },
  {
    name: "merge_point after_stage not in chain",
    value: corrupt(
      (s) => (s.merge_points = [{ after_stage: "copilot", artifact: "impl" }]),
    ),
  },
  {
    name: "merge_point invalid artifact",
    value: corrupt(
      (s) =>
        (s.merge_points = [{ after_stage: "review-spec", artifact: "bogus" }]),
    ),
  },
  {
    // The required merge-gate bypass: an EMPTY merge_points for a
    // write-spec→review-spec chain (which derives a spec merge point) must be
    // rejected — valid enums alone are not enough, the mapping must EQUAL
    // mergePointsFor(chain).
    name: "merge_points empty but chain requires one",
    value: corrupt((s) => (s.merge_points = [])),
  },
  {
    name: "merge_points valid-enum but wrong point for chain",
    value: corrupt(
      (s) =>
        (s.merge_points = [{ after_stage: "write-spec", artifact: "spec" }]),
    ),
  },
  { name: "artifact_prs non-numeric", value: corrupt((s) => (s.artifact_prs = { spec: ["x"] })) },
  {
    name: "artifact_prs fractional identifier",
    value: corrupt((s) => (s.artifact_prs = { spec: [12.5] })),
  },
  {
    name: "stage prs fractional identifier",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].prs = [3.14];
    }),
  },
  {
    name: "stage issue_numbers fractional identifier",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].artifacts = {
        issue_numbers: [7.5],
      };
    }),
  },
  {
    name: "merge record fractional pr",
    value: corrupt((s) => {
      (s.stages as Array<Record<string, unknown>>)[0].merges = [
        { pr: 2.5, merged_by_forge: true },
      ];
    }),
  },
];

for (const { name, value } of MALFORMED) {
  test(`loadState rejects malformed state: ${name}`, () => {
    withTempRoots(() => {
      const dir = path.join(slugDir("tbl"), "20260719-000000-aaa");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(value));
      assert.throws(
        () => loadState("tbl", "20260719-000000-aaa"),
        /corrupt state\.json|does not match/,
        `${name} should be rejected`,
      );
    });
  });

  test(`discovery skips malformed state: ${name}`, () => {
    withTempRoots(() => {
      // A valid run for another slug so discovery has something to return.
      persistState(makeState("valid", "20260719-000000-bbb"));
      const dir = path.join(slugDir("tbl"), "20260719-000000-aaa");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(value));
      const found = listResumeCandidates(REPO);
      assert.ok(
        !found.some((s) => s.slug === "tbl"),
        `${name} should not surface as a candidate`,
      );
      // The valid run is still discovered — one bad file never breaks enumeration.
      assert.ok(found.some((s) => s.run_id === "20260719-000000-bbb"));
    });
  });
}

// ---------------------------------------------------------------------------
// Path-traversal safety at the disk boundary
// ---------------------------------------------------------------------------

test("persistState/loadState reject traversal in slug or run id", () => {
  withTempRoots((stateDir) => {
    // A hostile slug must be refused at the disk boundary, not written outside
    // stateRoot()/history/forge.
    assert.throws(
      () => persistState(makeState("../../escape", "20260719-000000-aaa")),
      /unsafe slug/,
    );
    // A hostile run id likewise.
    assert.throws(
      () => persistState(makeState("ok-slug", "../../../etc/passwd")),
      /unsafe run id/,
    );
    // Reads are guarded too.
    assert.throws(() => loadState("../../escape"), /unsafe slug/);
    assert.throws(
      () => loadState("ok-slug", "../../escape"),
      /unsafe run id/,
    );
    // Nothing was written outside the forge history root.
    assert.ok(!fs.existsSync(path.join(stateDir, "escape")));
  });
});

test("resolveLatest rejects a tampered pointer that targets a traversal", () => {
  withTempRoots(() => {
    persistState(makeState("zeta", "20260719-000000-aaa"));
    const dir = slugDir("zeta");
    fs.rmSync(path.join(dir, "latest"), { force: true });
    fs.rmSync(path.join(dir, "latest.txt"), { force: true });
    // `..` survives path.basename as `..` — the pointer must be rejected, not
    // resolved to the slug dir's parent. (A multi-segment target like
    // `../../etc/passwd` is separately neutralized to its last segment.)
    fs.writeFileSync(path.join(dir, "latest.txt"), "..");
    assert.throws(() => resolveLatest("zeta"), /unsafe run id/);
  });
});

// ---------------------------------------------------------------------------
// parseRemoteUrl — canonicalize the three git remote forms
// ---------------------------------------------------------------------------

test("parseRemoteUrl canonicalizes scp, https, and ssh remote forms", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:21StarkCom/stark-skills.git"), {
    host: "github.com",
    owner: "21StarkCom",
    name: "stark-skills",
  });
  assert.deepEqual(
    parseRemoteUrl("https://github.com/21StarkCom/stark-skills.git"),
    { host: "github.com", owner: "21StarkCom", name: "stark-skills" },
  );
  assert.deepEqual(
    parseRemoteUrl("ssh://git@github.com/21StarkCom/stark-skills"),
    { host: "github.com", owner: "21StarkCom", name: "stark-skills" },
  );
  // Nested group path (GitLab-style) keeps the last two segments.
  assert.deepEqual(parseRemoteUrl("https://gitlab.com/grp/sub/proj.git"), {
    host: "gitlab.com",
    owner: "sub",
    name: "proj",
  });
  assert.equal(parseRemoteUrl(""), null);
  assert.equal(parseRemoteUrl("not-a-url"), null);
});
