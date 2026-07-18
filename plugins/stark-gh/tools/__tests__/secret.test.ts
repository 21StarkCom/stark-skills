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
