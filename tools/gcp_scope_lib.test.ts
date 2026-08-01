import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLOCK_CLOSE,
  BLOCK_OPEN,
  DIRENVRC_OPEN,
  LOCAL_OVERRIDE,
  acceptedProjects,
  ambientProblems,
  definesUseGcp,
  exportsProject,
  findBlock,
  hasSourceUp,
  parseMap,
  probeProblem,
  renderBlock,
  spliceBlock,
  spliceDirenvrc,
} from "./gcp_scope_lib.ts";
import type { RepoScope } from "./gcp_scope_lib.ts";
import { DIRENVRC_FUNCTIONS, direnvrcFunctions } from "./gcp_scope_direnvrc.ts";

const SCOPE: RepoScope = {
  repo: "demo/repo",
  project: "demo-project",
  region: "us-east1",
  account: "",
  sourceUp: false,
  alternates: [],
  why: "test fixture",
  notes: [],
};

const NESTED: RepoScope = { ...SCOPE, sourceUp: true };

const ok = (r: ReturnType<typeof spliceBlock>) => {
  assert.equal(r.ok, true, r.ok ? "" : `unexpected refusal: ${r.error}`);
  return r as Extract<typeof r, { ok: true }>;
};

// --- map -------------------------------------------------------------------

test("parseMap accepts a minimal row and defaults the rest", () => {
  const { scopes, errors } = parseMap({ repos: [{ repo: "a/b", project: "some-project" }] });
  assert.deepEqual(errors, []);
  assert.equal(scopes.length, 1);
  assert.deepEqual(scopes[0], {
    repo: "a/b",
    project: "some-project",
    region: "",
    account: "",
    sourceUp: false,
    alternates: [],
    why: "",
    notes: [],
  });
});

test("parseMap rejects bad shapes without throwing", () => {
  assert.match(parseMap({}).errors[0] ?? "", /repos/);
  assert.match(parseMap({ repos: [{ project: "p-roject" }] }).errors[0] ?? "", /missing "repo"/);
  assert.match(parseMap({ repos: [{ repo: "a" }] }).errors[0] ?? "", /missing "project"/);
  assert.match(parseMap({ repos: [{ repo: "a", project: "X" }] }).errors[0] ?? "", /not a valid GCP project/);
  assert.match(
    parseMap({ repos: [{ repo: "a", project: "good-project", region: "nowhere" }] }).errors[0] ?? "",
    /not a valid compute region/,
  );
});

test("parseMap reports duplicates instead of silently overwriting", () => {
  const { scopes, errors } = parseMap({
    repos: [
      { repo: "a/b", project: "one-project" },
      { repo: "a/b", project: "two-project" },
    ],
  });
  assert.equal(scopes.length, 1);
  assert.match(errors[0] ?? "", /duplicate/);
});

test("no real infrastructure identifiers ship in this package", () => {
  // The package is published to a public marketplace; the map is local data.
  const shipped = [direnvrcFunctions(), renderBlock(SCOPE), JSON.stringify(parseMap({ repos: [] }))].join("\n");
  assert.equal(/@[a-z0-9.-]+\.(com|net|org)/i.test(shipped), false, "no email/domain literals");
  assert.equal(/\b\d{6,}\b/.test(shipped), false, "no numeric project ids");
});

// --- rendering -------------------------------------------------------------

test("renderBlock emits the use_gcp call between markers", () => {
  const block = renderBlock(SCOPE);
  assert.ok(block.startsWith(BLOCK_OPEN));
  assert.ok(block.endsWith(BLOCK_CLOSE));
  assert.ok(block.includes("use_gcp demo-project us-east1"));
  assert.ok(block.includes("test fixture"));
});

test("renderBlock omits empty positional args", () => {
  assert.ok(renderBlock({ ...SCOPE, region: "" }).includes("\nuse_gcp demo-project\n"));
});

test("renderBlock passes the account through as the third arg", () => {
  assert.ok(
    renderBlock({ ...SCOPE, account: "someone@example.test" }).includes(
      "use_gcp demo-project us-east1 someone@example.test",
    ),
  );
});

test("renderBlock keeps notes as comments, never as code", () => {
  const block = renderBlock({ ...SCOPE, notes: ["use_gcp other-project us-central1"] });
  assert.ok(block.includes("# use_gcp other-project us-central1"));
  const executable = block.split("\n").filter((l) => l.startsWith("use_gcp "));
  assert.deepEqual(executable, ["use_gcp demo-project us-east1"]);
});

test("alternates are documented as a local-override, not an in-block edit", () => {
  const block = renderBlock({ ...SCOPE, alternates: ["other-project"] });
  assert.ok(block.includes("other-project"));
  assert.ok(block.includes(LOCAL_OVERRIDE));
  assert.ok(block.includes("do NOT edit inside these"));
});

test("every block sources the local override last, so it wins", () => {
  const lines = renderBlock(SCOPE).split("\n");
  assert.equal(lines[lines.length - 2], `source_env_if_exists ${LOCAL_OVERRIDE}`);
});

// --- splicing --------------------------------------------------------------

test("a new nested .envrc sources the parent tree first", () => {
  const { content, action } = ok(spliceBlock(null, NESTED));
  assert.equal(action, "create");
  assert.ok(hasSourceUp(content));
  assert.ok(content.indexOf("source_up_if_exists") < content.indexOf(BLOCK_OPEN));
});

test("a new top-level .envrc does not source up", () => {
  assert.equal(hasSourceUp(ok(spliceBlock(null, SCOPE)).content), false);
});

test("appending preserves every hand-written line", () => {
  const existing = 'export DATABASE_URL="postgres://secret@localhost/db"\n';
  const { content, action } = ok(spliceBlock(existing, SCOPE));
  assert.equal(action, "append");
  assert.ok(content.startsWith(existing));
});

test("appending to a nested repo REPAIRS a missing source_up_if_exists", () => {
  const existing = 'export TYR_KEY_FILE="$HOME/.config/x.key"\n';
  const { content, action } = ok(spliceBlock(existing, NESTED));
  assert.equal(action, "prepend+append");
  assert.ok(hasSourceUp(content));
  assert.ok(content.indexOf("source_up_if_exists") < content.indexOf("TYR_KEY_FILE"));
  assert.ok(content.includes("TYR_KEY_FILE"), "hand-written line survives");
});

test("the repair also fires on the REPLACE path", () => {
  // Regression: repos whose .envrc predated the tool already carry a managed
  // block, so they land on replace — the append-only repair never reached them
  // and they stayed permanently shadowed.
  const existing = `export KEEP=1\n\n${renderBlock(NESTED)}\n`;
  assert.equal(hasSourceUp(existing), false);
  const { content, action } = ok(spliceBlock(existing, NESTED));
  assert.equal(action, "prepend+replace");
  assert.ok(hasSourceUp(content));
  assert.ok(content.includes("export KEEP=1"));
});

test("the repair is idempotent — a second pass adds nothing", () => {
  const once = ok(spliceBlock('export KEEP=1\n', NESTED)).content;
  const twice = ok(spliceBlock(once, NESTED));
  assert.equal(twice.action, "unchanged");
  // Exactly one executable directive (the header comment mentions it too).
  const directives = once.split("\n").filter((l) => l.trim() === "source_up_if_exists");
  assert.equal(directives.length, 1);
});

test("re-splicing is idempotent", () => {
  const first = ok(spliceBlock(null, SCOPE)).content;
  assert.equal(ok(spliceBlock(first, SCOPE)).action, "unchanged");
});

test("a changed mapping replaces only the managed region", () => {
  const existing = ok(spliceBlock('export KEEP=1\n', SCOPE)).content;
  const { content, action } = ok(spliceBlock(existing, { ...SCOPE, project: "moved-project" }));
  assert.equal(action, "replace");
  assert.ok(content.includes("export KEEP=1"));
  assert.ok(content.includes("use_gcp moved-project us-east1"));
  assert.equal(content.includes("demo-project"), false);
  assert.equal(content.split(BLOCK_OPEN).length - 1, 1);
});

test("a stray OPEN marker is REFUSED, not paired with a later CLOSE", () => {
  // Regression: naive indexOf pairing deleted everything between a stray OPEN
  // and the appended block's CLOSE — losing hand-written secrets outright.
  const mangled = `${BLOCK_OPEN}\nexport DATABASE_URL="postgres://secret@h/db"\n`;
  const first = spliceBlock(mangled, SCOPE);
  assert.equal(first.ok, false);
  assert.match(first.ok ? "" : first.error, /malformed managed block/);
});

test("duplicated markers are REFUSED", () => {
  const doubled = `${BLOCK_OPEN}\n${BLOCK_CLOSE}\n${BLOCK_OPEN}\n${BLOCK_CLOSE}\n`;
  const r = spliceBlock(doubled, SCOPE);
  assert.equal(r.ok, false);
});

test("out-of-order markers are REFUSED", () => {
  const r = spliceBlock(`${BLOCK_CLOSE}\nkeep=1\n${BLOCK_OPEN}\n`, SCOPE);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /out of order/);
});

test("findBlock returns null for a clean unmarked file", () => {
  assert.equal(findBlock("export A=1\n"), null);
});

// --- direnvrc --------------------------------------------------------------

test("spliceDirenvrc REFUSES an unmarked hand-rolled use_gcp rather than deleting it", () => {
  // Regression: the old wholesale-replace path discarded layout_go/use_nvm too.
  const handRolled = "layout_go() { :; }\nuse_gcp() {\n  export CLOUDSDK_CORE_PROJECT=$1\n}\n";
  const r = spliceDirenvrc(handRolled, "use_gcp() { :; }");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /already defines use_gcp/);
});

test("spliceDirenvrc preserves unrelated content when appending", () => {
  const other = "layout_go() { :; }\nuse_nvm() { :; }\n";
  const { content, action } = ok(spliceDirenvrc(other, "use_gcp() { :; }"));
  assert.equal(action, "append");
  assert.ok(content.includes("layout_go()"));
  assert.ok(content.includes("use_nvm()"));
});

test("spliceDirenvrc replaces only between its own markers", () => {
  const seeded = ok(spliceDirenvrc("layout_go() { :; }\n", "use_gcp() { OLD; }")).content;
  const { content, action } = ok(spliceDirenvrc(seeded, "use_gcp() { NEW; }"));
  assert.equal(action, "replace");
  assert.ok(content.includes("layout_go()"));
  assert.ok(content.includes("NEW"));
  assert.equal(content.includes("OLD"), false);
  assert.equal(content.split(DIRENVRC_OPEN).length - 1, 1);
});

test("spliceDirenvrc is idempotent", () => {
  const first = ok(spliceDirenvrc(null, "use_gcp() { :; }")).content;
  assert.equal(ok(spliceDirenvrc(first, "use_gcp() { :; }")).action, "unchanged");
});

test("spliceDirenvrc refuses a mangled managed block", () => {
  assert.equal(spliceDirenvrc(`${DIRENVRC_OPEN}\nstuff\n`, "x").ok, false);
});

test("definesUseGcp ignores comments", () => {
  assert.equal(definesUseGcp("use_gcp() {\n}\n"), true);
  assert.equal(definesUseGcp("# use_gcp() is documented here\n"), false);
});

// --- shipped shell ---------------------------------------------------------

test("the shell payload is embedded, not read from a sidecar", () => {
  assert.ok(DIRENVRC_FUNCTIONS.length > 10);
  assert.ok(direnvrcFunctions().includes("use_gcp() {"));
  assert.ok(direnvrcFunctions().includes("use_gcp_identity() {"));
});

test("use_gcp exports a proof-of-execution marker", () => {
  assert.ok(direnvrcFunctions().includes("export GCP_SCOPE_ACTIVE="));
});

test("use_gcp never exports GOOGLE_CLOUD_LOCATION", () => {
  // It is a Vertex serving location, not a compute region: an ambient regional
  // value 404s preview models, which only exist on the global endpoint.
  assert.equal(direnvrcFunctions().includes("export GOOGLE_CLOUD_LOCATION"), false);
  assert.ok(direnvrcFunctions().includes("export CLOUDSDK_COMPUTE_REGION="));
});

test("use_gcp pins no default account", () => {
  assert.equal(/CLOUDSDK_CORE_ACCOUNT="\$\{/.test(direnvrcFunctions()), false);
  assert.ok(direnvrcFunctions().includes('if [ -n "$account" ]; then'));
});

test("the shell payload stays bash-3.2 safe", () => {
  const sh = direnvrcFunctions();
  assert.equal(sh.includes("<<"), false, "no here-docs or here-strings");
  assert.equal(sh.includes("declare -A"), false, "no associative arrays");
  assert.equal(/\$\{[A-Za-z_]+,,\}/.test(sh), false, "no lowercase expansion");
});

// --- ambient ---------------------------------------------------------------

test("a neutralized ambient default reports nothing", () => {
  assert.deepEqual(
    ambientProblems({
      defaultConfigProject: "",
      auditedConfigDir: "/home/u/.config/gcloud",
      shellRcExportsProject: false,
      shellRcPath: "/home/u/.zshrc",
    }),
    [],
  );
});

test("a lingering default-config project names the state dir it was found in", () => {
  const [problem] = ambientProblems({
    defaultConfigProject: "some-project",
    auditedConfigDir: "/home/u/.config/gcloud",
    shellRcExportsProject: false,
    shellRcPath: "/home/u/.zshrc",
  });
  assert.match(problem ?? "", /some-project/);
  assert.match(problem ?? "", /\/home\/u\/\.config\/gcloud/);
  assert.match(problem ?? "", /gcloud config unset project/);
});

test("both ambient sources are reported independently", () => {
  assert.equal(
    ambientProblems({
      defaultConfigProject: "some-project",
      auditedConfigDir: "",
      shellRcExportsProject: true,
      shellRcPath: "/home/u/.zshrc",
    }).length,
    2,
  );
});

test("exportsProject ignores comments and near-misses", () => {
  assert.equal(exportsProject('export GOOGLE_CLOUD_PROJECT="p"\n'), true);
  assert.equal(exportsProject("  export GOOGLE_CLOUD_PROJECT=p\n"), true);
  assert.equal(exportsProject("# export GOOGLE_CLOUD_PROJECT removed\n"), false);
  assert.equal(exportsProject("export GOOGLE_CLOUD_PROJECT_ID=p\n"), false);
});

// --- probe -----------------------------------------------------------------

test("a matching marker passes", () => {
  assert.equal(
    probeProblem(SCOPE, { active: "demo-project", project: "demo-project", stderr: "direnv: loading .envrc" }),
    null,
  );
});

test("an inherited project with NO marker is caught, not trusted", () => {
  // Regression: direnv exec exits 0 on a failed .envrc and runs the command with
  // the caller's env, so CLOUDSDK_CORE_PROJECT alone proved nothing.
  const problem = probeProblem(SCOPE, { active: "", project: "demo-project", stderr: "" });
  assert.match(problem ?? "", /use_gcp did not run/);
});

test("direnv diagnostics on stderr are fatal even with exit 0", () => {
  const problem = probeProblem(SCOPE, {
    active: "",
    project: "demo-project",
    stderr: "direnv: error use_gcp: command not found",
  });
  assert.match(problem ?? "", /failed to load/);
});

test("a wrong project is reported with what was expected", () => {
  const problem = probeProblem(SCOPE, { active: "other-project", project: "other-project", stderr: "" });
  assert.match(problem ?? "", /expected "demo-project"/);
});

test("a declared alternate is accepted and listed", () => {
  const scope = { ...SCOPE, alternates: ["other-project"] };
  assert.equal(probeProblem(scope, { active: "other-project", project: "other-project", stderr: "" }), null);
  assert.deepEqual(acceptedProjects(scope), ["demo-project", "other-project"]);
});

test("a post-use_gcp override of the project is caught", () => {
  const problem = probeProblem(SCOPE, { active: "demo-project", project: "hijacked-project", stderr: "" });
  assert.match(problem ?? "", /disagrees/);
});
