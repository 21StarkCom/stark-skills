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
