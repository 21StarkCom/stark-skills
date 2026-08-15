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
