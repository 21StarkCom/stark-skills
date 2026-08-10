import test from "node:test";
import assert from "node:assert/strict";
import { classifyUntracked, formatRefusal } from "../lib/untracked_guard.ts";
import { stageChanges } from "../gh_pr_open_execute.ts";

// The regression this whole module exists for. `.envrc` held only paths and
// email subjects, so every content-based rule in lib/secret.ts passed it, and
// `git add -A` published it. The hazard was the file's identity.
test("classifyUntracked flags the .envrc that the content scanner missed", () => {
  const risky = classifyUntracked([".envrc"]);
  assert.equal(risky.length, 1);
  assert.equal(risky[0].path, ".envrc");
  assert.match(risky[0].reason, /direnv/);
});

test("classifyUntracked flags credential and key material anywhere in the tree", () => {
  const paths = [
    ".env",
    ".env.local",
    "app.pem",
    "deep/nested/key.pem",
    "id_rsa",
    "client_secret_123.json",
    "service-account-prod.json",
    "credentials.json",
    "reporter-credentials.json",
    "infra/terraform.tfstate",
    ".direnv/bin/x",
    ".claude/settings.local.json",
    ".DS_Store",
    ".netrc",
  ];
  const flagged = classifyUntracked(paths).map(r => r.path);
  for (const p of paths) {
    assert.ok(flagged.includes(p), `${p} should have been flagged`);
  }
});

// Friction has to be earned. A guard that stops ordinary work gets disabled,
// and then it protects nothing.
test("classifyUntracked ignores ordinary new source and doc files", () => {
  const benign = [
    "tools/lib/new_module.ts",
    "gh/apps.go",
    "docs/packages/gh-apps.md",
    "README.md",
    "src/components/Button.tsx",
    "testdata/fixture.json",
    "Makefile",
    "go.mod",
    "internal/cli/registry/catalog.json",
  ];
  assert.deepEqual(classifyUntracked(benign), []);
});

// Published examples are tracked on purpose. Flagging them would teach people
// to pass the override reflexively, which is how a guard stops working.
test("classifyUntracked allows the published example variants", () => {
  const examples = [
    ".env.example",
    ".env.sample",
    ".envrc.example",
    "credentials.example.json",
    "gcp/billing/trust.pubkeys/verifier.pem",
    "keys/signing.pub",
  ];
  assert.deepEqual(classifyUntracked(examples), []);
});

test("formatRefusal names every file, its reason, and both remedies", () => {
  const msg = formatRefusal([
    { path: ".envrc", reason: "direnv local environment" },
    { path: "app.pem", reason: "key or certificate material" },
  ]);
  assert.match(msg, /\.envrc/);
  assert.match(msg, /app\.pem/);
  assert.match(msg, /direnv local environment/);
  assert.match(msg, /\.gitignore/);
  assert.match(msg, /--allow-untracked-config/);
  // The check-ignore hint must carry the negation warning: a matching line in
  // .gitignore is not proof, which is the trap that caused the incident.
  assert.match(msg, /check-ignore -q/);
  assert.match(msg, /negation/);
});

// The guard has to run BEFORE `git add`, not after. Refusing post-stage would
// leave a dirty index the operator has to unpick by hand.
test("stageChanges refuses before touching the index, then proceeds when overridden", () => {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "ls-files") return ".envrc\nsrc/real_work.ts\n";
    return "";
  };
  const basePlan = {
    stage3: { willCommit: true, commitStrategy: "commit-all" },
    userArgs: { allowUntrackedConfig: false },
  } as never;

  assert.throws(
    () => stageChanges(basePlan, { exec: exec as never }),
    /refusing to stage 1 untracked file/,
  );
  assert.ok(
    !calls.some(c => c.startsWith("git add")),
    `git add must not run before the refusal; calls were: ${calls.join(" | ")}`,
  );

  calls.length = 0;
  const overridden = {
    stage3: { willCommit: true, commitStrategy: "commit-all" },
    userArgs: { allowUntrackedConfig: true },
  } as never;
  stageChanges(overridden, { exec: exec as never });
  assert.ok(calls.some(c => c === "git add -A"), "override must reach git add -A");
});

// A repo whose .gitignore is correct must see no behaviour change: the file
// never appears in `ls-files --others --exclude-standard` at all.
test("stageChanges is a no-op guard when nothing untracked is risky", () => {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "ls-files") return "src/real_work.ts\ndocs/notes.md\n";
    return "";
  };
  stageChanges(
    { stage3: { willCommit: true, commitStrategy: "commit-all" }, userArgs: {} } as never,
    { exec: exec as never },
  );
  assert.ok(calls.some(c => c === "git add -A"));
});
