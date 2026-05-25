// Pure-logic tests for `jsonl_parser.ts`. No filesystem, no SQLite.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  LineBuffer,
  parseLine,
  rotationIndexFromBasename,
} from "./jsonl_parser.ts";

test("parseLine returns null for empty + whitespace lines", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("\t\t"), null);
});

test("parseLine returns null for non-JSON content", () => {
  assert.equal(parseLine("not json at all"), null);
  assert.equal(parseLine("{broken"), null);
});

test("parseLine returns null for non-object JSON (top-level array, number, string)", () => {
  assert.equal(parseLine("[1,2,3]"), null);
  assert.equal(parseLine("42"), null);
  assert.equal(parseLine('"hello"'), null);
});

test("parseLine returns the parsed record for a JSONL object", () => {
  const got = parseLine('{"a":1,"b":"x"}');
  assert.deepEqual(got, { a: 1, b: "x" });
});

test("LineBuffer.push yields complete lines with absolute offsets", () => {
  const buf = new LineBuffer(100);
  const out = buf.push('{"a":1}\n{"b":2}\n');
  assert.equal(out.length, 2);
  assert.equal(out[0]!.line, '{"a":1}');
  assert.equal(out[0]!.byteStart, 100);
  assert.equal(out[0]!.byteEnd, 100 + 7 + 1); // 7 bytes + \n
  assert.equal(out[1]!.line, '{"b":2}');
  assert.equal(out[1]!.byteStart, 108);
  assert.equal(out[1]!.byteEnd, 108 + 7 + 1);
});

test("LineBuffer holds partial trailing line across two pushes", () => {
  const buf = new LineBuffer(0);
  const out1 = buf.push('{"a":1}\n{"b":');
  assert.equal(out1.length, 1);
  assert.equal(out1[0]!.line, '{"a":1}');
  assert.equal(buf.partialBytes, 5);

  const out2 = buf.push('2}\n');
  assert.equal(out2.length, 1);
  assert.equal(out2[0]!.line, '{"b":2}');
  // First line was 8 bytes; second starts at byte 8.
  assert.equal(out2[0]!.byteStart, 8);
  assert.equal(out2[0]!.byteEnd, 8 + 7 + 1);
});

test("LineBuffer preserves byte ranges across multi-byte UTF-8 input", () => {
  const buf = new LineBuffer(0);
  // "é" = 2 bytes in UTF-8; line is `{"k":"é"}` = 9 chars / 10 bytes
  const out = buf.push('{"k":"é"}\n');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.byteStart, 0);
  assert.equal(out[0]!.byteEnd, 11); // 10 line bytes + \n
});

test("LineBuffer.reset clears carry and reseats absolute offset", () => {
  const buf = new LineBuffer(0);
  buf.push('{"partial":'); // carry holds 11 bytes
  buf.reset(99);
  const out = buf.push('{"complete":true}\n');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.byteStart, 99);
});

test("rotationIndexFromBasename pulls integer index from canonical names", () => {
  assert.equal(rotationIndexFromBasename("events-0000.jsonl"), 0);
  assert.equal(rotationIndexFromBasename("events-0001.jsonl"), 1);
  assert.equal(rotationIndexFromBasename("events-9999.jsonl"), 9999);
  assert.equal(rotationIndexFromBasename("events-12345.jsonl"), 12345);
});

test("rotationIndexFromBasename rejects malformed names", () => {
  assert.equal(rotationIndexFromBasename("events-001.jsonl"), null); // too few digits
  assert.equal(rotationIndexFromBasename("events-1.jsonl"), null);
  assert.equal(rotationIndexFromBasename("events.jsonl"), null);
  assert.equal(rotationIndexFromBasename("notes-0001.jsonl"), null);
  assert.equal(rotationIndexFromBasename("events-0001.txt"), null);
  assert.equal(rotationIndexFromBasename("README.md"), null);
});
