import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSecrets } from "../lib/secret.ts";

test("clean text has no hits", () => {
  const r = scanSecrets("hello world\nnothing here\n");
  assert.equal(r.length, 0);
});

test("AWS access key triggers", () => {
  const r = scanSecrets("AKIAIOSFODNN7EXAMPLE\n");
  assert.equal(r.length, 1);
  assert.equal(r[0]!.category, "aws-access-key");
});

test("GitHub PAT triggers", () => {
  const r = scanSecrets("ghp_" + "a".repeat(36));
  assert.ok(r.find(h => h.category === "github-token"));
});

test("PEM private key header triggers", () => {
  const r = scanSecrets("-----BEGIN RSA PRIVATE KEY-----");
  assert.ok(r.find(h => h.category === "pem-private-key"));
});

test("high-entropy random hex triggers", () => {
  const hex = "9f3a8b67c2e1d540af89bc73a16e2f0d958c4b71e02d6f3a8b67c2e1d540af89";
  const r = scanSecrets(hex);
  assert.ok(r.find(h => h.category === "high-entropy"));
});

test("low-entropy long string does not trigger high-entropy", () => {
  const r = scanSecrets("a".repeat(60));
  assert.equal(r.find(h => h.category === "high-entropy"), undefined);
});

// --- NAME=value assignment splitting ------------------------------------
// `=` sits in the entropy-token charset (base64 padding), so an assignment
// line fuses NAME and value into one token; the sides are scored
// independently so innocent fusions pass and real secrets still flag.

// 64 distinct chars — Shannon entropy 6.0, far above the 4.5 threshold.
const HIGH_ENTROPY_64 =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";

test("NAME=/filesystem/path does NOT flag (atlas #162 regression)", () => {
  // The exact docs/install.md line that blocked Atlas PR #162: env-var name
  // and path fused into a 76-char token that crossed the 4.5 threshold even
  // though neither side is a secret.
  const line =
    "+export ATLAS_EGRESS_CAPABILITY_KEY=/usr/local/etc/atlas/keys/shared/egress-capability.key";
  assert.deepEqual(scanSecrets(line), []);
});

test("NAME=<high-entropy secret> still flags on the value side", () => {
  const r = scanSecrets(`+export API_KEY=${HIGH_ENTROPY_64}`);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.category, "high-entropy");
});

test("NAME=<high-entropy hex secret> still flags on the value side", () => {
  const hex = "9f3a8b67c2e1d540af89bc73a16e2f0d958c4b71";
  assert.equal(scanSecrets(`+DEPLOY_KEY=${hex}`).length, 1);
});

test("bare high-entropy token (no assignment shape) still flags", () => {
  const r = scanSecrets(`+const secret = ${HIGH_ENTROPY_64}`);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.category, "high-entropy");
});

test("base64 body with trailing = padding still flags (splits into name slot)", () => {
  // ASSIGNMENT_RE splits at the first `=`; the 64-char body lands in the
  // name slot and must flag on its own.
  assert.equal(scanSecrets(`+token: ${HIGH_ENTROPY_64}==`).length, 1);
});

test("NAME=value where neither side reaches 40 chars does not flag", () => {
  assert.deepEqual(scanSecrets("+SOME_LONGISH_ENV_VARIABLE_NAME=q8Zx3vNp1KfT7"), []);
});

test("NAME=<long low-entropy value> does not flag", () => {
  assert.deepEqual(scanSecrets("+LONG_NAME=" + "ab".repeat(40)), []);
});

test("assignment split keeps the correct line number", () => {
  const text = ["clean line", `KEY=${HIGH_ENTROPY_64}`, "clean line"].join("\n");
  const r = scanSecrets(text);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.lineNumber, 2);
});

// --- word-structured identifier carve-out (apple-developer STARK-552) ----
// A long, descriptive camelCase test name is entropy-dense enough to cross the
// 4.5 base threshold, yet it is code, not credential material. Shortening such
// names to appease the scanner removes the disambiguation detailed names give an
// LLM reader, so the scanner exempts word-structured identifiers instead.

test("long camelCase identifier does NOT flag (STARK-552 regression)", () => {
  // The exact Go test name whose pr-open preflight blocked apple-developer #87:
  // 56 chars, Shannon entropy ~4.57, over the 4.5 threshold.
  const line =
    "+func TestPullGracefullySkipsDefaultedDomain403WithoutWipingIt(t *testing.T) {";
  assert.deepEqual(scanSecrets(line), []);
});

test("long snake_case identifier does NOT flag", () => {
  assert.deepEqual(
    scanSecrets("+  resolve_by_local_id_index_lookup_helper_function := nil"),
    [],
  );
});

test("a real base64 secret is NOT exempted by the carve-out", () => {
  // 44-char base64 body with + / = — word-structured carve-out must not touch it.
  const r = scanSecrets("+const k = aGVsbG8rd29ybGQvdGhpcz1zZWNyZXQxMjM0NTY3ODkw");
  assert.ok(r.find((h) => h.category === "high-entropy"));
});

test("a random letters+digits blob (no vowel-words) is NOT exempted", () => {
  // 56 chars, high entropy, but segments are consonant clusters — stays flagged.
  const r = scanSecrets("+id := kJ8fQ2xZ9pLmN4vWbT7yRcA1sD6gH0uYeI3oPzXqBnMwErTyUiO");
  assert.ok(r.find((h) => h.category === "high-entropy"));
});

test("high-entropy assignment with a word-structured value still flags on the name side", () => {
  // name side is a real secret, value side reads like words — must NOT be exempted.
  const r = scanSecrets(`+${HIGH_ENTROPY_64}=SomeReadableCamelCaseWordsHereForTheValue`);
  assert.ok(r.find((h) => h.category === "high-entropy"));
});

// --- lockfile / checksum-manifest exemption (STARK-1323) -----------------
// go.sum and friends are base64/hex CONTENT hashes: legitimately high-entropy,
// but public and required, never secrets. The entropy detector is skipped
// inside a lockfile's diff hunk while the regex/token detectors stay active so
// a pasted credential in a lockfile still flags. Repro: frigg PR #13 added the
// modernc.org/sqlite tree → 188 go.sum lines flagged, zero real secrets.

// A go.sum h1: checksum is base64(SHA-256) — 44 chars incl. `+ / =` padding.
// Genuinely high-entropy: the paired .go test below proves the fixture trips
// the detector when it is NOT inside a lockfile.
const LOCK_HASH = "h1:" + HIGH_ENTROPY_64.slice(20, 62) + "==";

function goSumDiff(hashLine: string): string {
  return [
    "diff --git a/go.sum b/go.sum",
    "index 1234567..89abcde 100644",
    "--- a/go.sum",
    "+++ b/go.sum",
    "@@ -1,2 +1,3 @@",
    hashLine,
  ].join("\n");
}

test("go.sum checksum line does NOT flag high-entropy (STARK-1323)", () => {
  const diff = goSumDiff(`+modernc.org/sqlite v1.34.1 ${LOCK_HASH}`);
  assert.deepEqual(scanSecrets(diff), []);
});

test("same high-entropy token in a .go file STILL flags (exemption is lockfile-scoped)", () => {
  const diff = [
    "diff --git a/main.go b/main.go",
    "+++ b/main.go",
    `+const key = "${LOCK_HASH}"`,
  ].join("\n");
  assert.ok(scanSecrets(diff).find((h) => h.category === "high-entropy"));
});

test("regex detector still fires inside a go.sum hunk (STARK-1323)", () => {
  // Key assembled from parts so pr-open's own secret scan doesn't flag this
  // test fixture; the runtime value still exercises the AWS detector.
  const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
  const diff = goSumDiff(`+${awsKey} leaked into a lockfile`);
  assert.ok(scanSecrets(diff).find((h) => h.category === "aws-access-key"));
});

test("package-lock.json integrity hash does NOT flag (STARK-1323)", () => {
  const diff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1,2 @@",
    `+      "integrity": "sha512-${HIGH_ENTROPY_64}==",`,
  ].join("\n");
  assert.deepEqual(scanSecrets(diff), []);
});

test("nested-path lockfile (frontend/pnpm-lock.yaml) does NOT flag (STARK-1323)", () => {
  const diff = [
    "diff --git a/frontend/pnpm-lock.yaml b/frontend/pnpm-lock.yaml",
    "+++ b/frontend/pnpm-lock.yaml",
    `+  resolution: {integrity: sha512-${HIGH_ENTROPY_64}==}`,
  ].join("\n");
  assert.deepEqual(scanSecrets(diff), []);
});

test("DELETING a go.sum does NOT flag its removed hashes (STARK-1323)", () => {
  // A delete has `+++ /dev/null`; file identity is the pre-image `--- a/go.sum`,
  // so the removed `-<hash>` lines must still be exempt.
  const diff = [
    "diff --git a/go.sum b/go.sum",
    "deleted file mode 100644",
    "index 89abcde..0000000",
    "--- a/go.sum",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    `-modernc.org/sqlite v1.34.1 ${LOCK_HASH}`,
  ].join("\n");
  assert.deepEqual(scanSecrets(diff), []);
});

test("file after a go.sum block in the SAME diff is scanned normally (STARK-1323)", () => {
  // Exemption must end at the next `diff --git`, not leak into the next file.
  const diff = [
    goSumDiff(`+modernc.org/x v1.0.0 ${LOCK_HASH}`),
    "diff --git a/secrets.txt b/secrets.txt",
    "+++ b/secrets.txt",
    `+${HIGH_ENTROPY_64}`,
  ].join("\n");
  assert.ok(scanSecrets(diff).find((h) => h.category === "high-entropy"));
});

test("secret in a separate prose segment after a go.sum diff still flags (no context leak)", () => {
  const diff = goSumDiff(`+modernc.org/x v1.0.0 ${LOCK_HASH}`);
  const prose = `commit message pasting a token ${HIGH_ENTROPY_64}`;
  const r = scanSecrets([{ text: diff }, { text: prose }]);
  assert.ok(r.find((h) => h.category === "high-entropy"));
});

test("segment path hint exempts bare lockfile content with no diff header (STARK-1323)", () => {
  const content = `modernc.org/sqlite v1.34.1 ${LOCK_HASH}`;
  assert.deepEqual(scanSecrets([{ text: content, path: "go.sum" }]), []);
});

test("segment path hint on a non-lockfile does NOT exempt", () => {
  const content = `const key = ${HIGH_ENTROPY_64}`;
  const r = scanSecrets([{ text: content, path: "config.ts" }]);
  assert.ok(r.find((h) => h.category === "high-entropy"));
});

test("string-form line numbers unchanged by segment refactor", () => {
  const text = ["clean", `KEY=${HIGH_ENTROPY_64}`, "clean"].join("\n");
  const r = scanSecrets(text);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.lineNumber, 2);
});

test("multi-segment line numbers are cumulative as if joined by newline", () => {
  const r = scanSecrets([{ text: "a\nb" }, { text: `KEY=${HIGH_ENTROPY_64}` }]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.lineNumber, 3); // seg1 = lines 1,2; seg2 first line = 3
});
