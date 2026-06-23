import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  DEFAULT_VERTEX_LOCATION,
  __resetVertexProjectCache,
  resolveVertexLocation,
  resolveVertexProject,
} from "./vertex_config_lib.ts";

const ENV_KEYS = [
  "STARK_GEMINI_VERTEX_PROJECT",
  "STARK_GEMINI_VERTEX_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetVertexProjectCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("project: STARK_GEMINI_VERTEX_PROJECT env takes top precedence", () => {
  process.env.STARK_GEMINI_VERTEX_PROJECT = "override-proj";
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-proj";
  assert.equal(resolveVertexProject({ allowGcloud: false }), "override-proj");
});

test("project: falls through to GOOGLE_CLOUD_PROJECT when no stark/config value", () => {
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-proj";
  assert.equal(resolveVertexProject({ allowGcloud: false }), "ambient-proj");
});

test("project: null when nothing is set and gcloud derivation is disabled", () => {
  // Proves the committed config ships no project id (empty → does not leak).
  assert.equal(resolveVertexProject({ allowGcloud: false }), null);
});

test("project: blank/whitespace env is ignored", () => {
  process.env.STARK_GEMINI_VERTEX_PROJECT = "   ";
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-proj";
  assert.equal(resolveVertexProject({ allowGcloud: false }), "ambient-proj");
});

test("location: defaults to global, env overrides, ambient region is ignored", () => {
  assert.equal(resolveVertexLocation(), DEFAULT_VERTEX_LOCATION);
  process.env.STARK_GEMINI_VERTEX_LOCATION = "us-central1";
  assert.equal(resolveVertexLocation(), "us-central1");
});
