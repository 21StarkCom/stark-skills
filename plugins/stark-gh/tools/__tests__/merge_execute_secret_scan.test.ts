import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  redactProseInPlace,
  bulletToSubject,
  normalizeOriginUrl,
} from "../gh_pr_merge_execute.ts";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("bulletToSubject strips leading '- '", () => {
  assert.equal(bulletToSubject("- add cool feature"), "add cool feature");
  assert.equal(bulletToSubject("- "), "");
  // Idempotent on already-stripped
  assert.equal(bulletToSubject("plain"), "plain");
  // Trims trailing whitespace
  assert.equal(bulletToSubject("- foo  "), "foo");
});

test("normalizeOriginUrl: HTTPS form", () => {
  assert.equal(normalizeOriginUrl("https://github.com/Evinced/stark-skills"), "Evinced/stark-skills");
  assert.equal(normalizeOriginUrl("https://github.com/Evinced/stark-skills.git"), "Evinced/stark-skills");
});

test("normalizeOriginUrl: SSH form", () => {
  assert.equal(normalizeOriginUrl("git@github.com:Evinced/stark-skills.git"), "Evinced/stark-skills");
  assert.equal(normalizeOriginUrl("git@github.com:Evinced/stark-skills"), "Evinced/stark-skills");
});

test("normalizeOriginUrl: returns null on non-matching", () => {
  assert.equal(normalizeOriginUrl(""), null);
  assert.equal(normalizeOriginUrl("not-a-url"), null);
});

test("redactProseInPlace: no secrets → no redaction", () => {
  const dir = tmpDir("stark-redact-clean-");
  const sf = path.join(dir, "subject.txt");
  const bf = path.join(dir, "body.md");
  const lf = path.join(dir, "bullet.txt");
  fs.writeFileSync(sf, "feat: clean subject");
  fs.writeFileSync(bf, "Body without secrets.");
  fs.writeFileSync(lf, "- bullet without secrets");
  const r = redactProseInPlace({ subjectFile: sf, bodyFile: bf, bulletFile: lf });
  assert.equal(r.redacted, false);
  assert.deepEqual(r.categories, []);
  // Files unchanged
  assert.equal(fs.readFileSync(sf, "utf8"), "feat: clean subject");
  fs.rmSync(dir, { recursive: true });
});

test("redactProseInPlace: GitHub token redacted in body", () => {
  const dir = tmpDir("stark-redact-tok-");
  const sf = path.join(dir, "subject.txt");
  const bf = path.join(dir, "body.md");
  const lf = path.join(dir, "bullet.txt");
  fs.writeFileSync(sf, "feat: cool");
  fs.writeFileSync(bf, "Token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  fs.writeFileSync(lf, "- ok");
  const r = redactProseInPlace({ subjectFile: sf, bodyFile: bf, bulletFile: lf });
  assert.equal(r.redacted, true);
  assert.ok(r.categories.includes("github-token"));
  // Body file rewritten with redacted content.
  const newBody = fs.readFileSync(bf, "utf8");
  assert.match(newBody, /<<REDACTED:github-token>>/);
  assert.doesNotMatch(newBody, /ghp_a{36}/);
  fs.rmSync(dir, { recursive: true });
});

test("redactProseInPlace: redaction is atomic across all 3 files", () => {
  const dir = tmpDir("stark-redact-atom-");
  const sf = path.join(dir, "subject.txt");
  const bf = path.join(dir, "body.md");
  const lf = path.join(dir, "bullet.txt");
  // Each file has the same secret. After redaction all three should contain
  // the redaction sentinel; none should retain the raw secret.
  const tok = "ghp_" + "x".repeat(36);
  fs.writeFileSync(sf, `feat: ${tok}`);
  fs.writeFileSync(bf, `body: ${tok}`);
  fs.writeFileSync(lf, `- bullet ${tok}`);
  const r = redactProseInPlace({ subjectFile: sf, bodyFile: bf, bulletFile: lf });
  assert.equal(r.redacted, true);
  for (const f of [sf, bf, lf]) {
    const c = fs.readFileSync(f, "utf8");
    assert.match(c, /<<REDACTED:github-token>>/, `${f} should be redacted`);
    assert.doesNotMatch(c, new RegExp(tok), `${f} should not retain secret`);
  }
  fs.rmSync(dir, { recursive: true });
});

test("redactProseInPlace: file mode preserved as 0600 after rewrite", () => {
  const dir = tmpDir("stark-redact-mode-");
  const sf = path.join(dir, "subject.txt");
  const bf = path.join(dir, "body.md");
  const lf = path.join(dir, "bullet.txt");
  fs.writeFileSync(sf, "ghp_" + "y".repeat(36), { mode: 0o600 });
  fs.writeFileSync(bf, "x", { mode: 0o600 });
  fs.writeFileSync(lf, "- y", { mode: 0o600 });
  redactProseInPlace({ subjectFile: sf, bodyFile: bf, bulletFile: lf });
  for (const f of [sf, bf, lf]) {
    const m = fs.statSync(f).mode & 0o777;
    assert.equal(m, 0o600, `${f} mode should be 0600`);
  }
  fs.rmSync(dir, { recursive: true });
});
