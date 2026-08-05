import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HANDLER = path.join(REPO_ROOT, "skill", "stark-gh-user", "scripts", "handler.sh");

function runHandler(args: string[], active = "primary") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stark-gh-user-test-"));
  try {
    const bin = path.join(tmp, "bin");
    const assets = path.join(tmp, "assets");
    mkdirSync(bin);
    mkdirSync(path.join(assets, "tools"), { recursive: true });
    writeFileSync(path.join(assets, "tools", "user_token.ts"), "// fixture\n");
    const fakeNode = path.join(bin, "node");
    writeFileSync(fakeNode, "#!/bin/sh\nprintf 'TOP_SECRET_PAT\\n'\n");
    chmodSync(fakeNode, 0o755);

    return spawnSync("bash", [HANDLER, ...args], {
      encoding: "utf8",
      env: {
        HOME: tmp,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STARK_ASSET_ROOT: assets,
        STARK_GH_USER: active,
      },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function evaluateExports(emitted: string, nodeExit: number) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stark-gh-user-eval-"));
  try {
    const fakeNode = path.join(tmp, "node");
    writeFileSync(
      fakeNode,
      `#!/bin/sh\n${nodeExit === 0 ? "printf 'TOP_SECRET_PAT\\n'" : "echo 'resolver failed' >&2"}\nexit ${nodeExit}\n`,
    );
    chmodSync(fakeNode, 0o755);
    return spawnSync(
      "bash",
      ["-c", 'eval "$EMITTED"; rc=$?; printf "rc=%s user=%s kind=%s token=%s\\n" "$rc" "${STARK_GH_USER:-}" "${STARK_GH_TOKEN_KIND:-}" "${GH_TOKEN-unset}"; exit "$rc"'],
      {
        encoding: "utf8",
        env: {
          HOME: tmp,
          PATH: `${tmp}:${process.env.PATH ?? ""}`,
          EMITTED: emitted,
          STARK_GH_USER: "primary",
          GH_TOKEN: "OLD_TOKEN",
          GITHUB_TOKEN: "OLD_TOKEN",
        },
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("gh-user activation emits deferred Keychain lookup, never the PAT", () => {
  const result = runHandler(["secondary", "--kind", "fine"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /TOP_SECRET_PAT/);
  assert.match(result.stdout, /if GH_TOKEN="\$\(node /);
  assert.match(result.stdout, /export STARK_GH_USER=secondary/);
  assert.match(result.stdout, /export STARK_GH_TOKEN_KIND=fine/);
  assert.match(result.stdout, /export GITHUB_TOKEN="\$GH_TOKEN"/);

  const evaluated = evaluateExports(result.stdout, 0);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.match(evaluated.stdout, /rc=0 user=secondary kind=fine token=TOP_SECRET_PAT/);
});

test("gh-user swap also keeps the PAT out of output", () => {
  const result = runHandler(["swap"], "primary");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /TOP_SECRET_PAT/);
  assert.match(result.stdout, /export STARK_GH_USER=secondary/);
  assert.match(result.stdout, /# swapped primary -> secondary/);
});

test("gh-user rejects malicious active identity before emitting eval-able text", () => {
  const result = runHandler(["swap"], "primary\necho INJECTED");
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /# swapped|INJECTED\n/);
  assert.match(result.stderr, /STARK_GH_USER must be primary or secondary/);
});

test("gh-user deferred resolver failure is nonzero and does not switch identity", () => {
  const generated = runHandler(["secondary"]);
  assert.equal(generated.status, 0, generated.stderr);
  const evaluated = evaluateExports(generated.stdout, 7);
  assert.notEqual(evaluated.status, 0);
  assert.match(evaluated.stderr, /resolver failed/);
  assert.match(evaluated.stdout, /rc=1 user=primary kind= token=unset/);
  assert.doesNotMatch(evaluated.stdout + evaluated.stderr, /OLD_TOKEN/);
});
