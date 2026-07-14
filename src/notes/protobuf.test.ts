import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToken,
  encodeProtoTokens,
  encodeVarint,
  readProtoFields,
  readProtoTokens,
  varintToken,
} from "./protobuf.js";

test("encodeVarint produces minimal encodings", () => {
  assert.deepEqual([...encodeVarint(0n)], [0x00]);
  assert.deepEqual([...encodeVarint(1n)], [0x01]);
  assert.deepEqual([...encodeVarint(127n)], [0x7f]);
  assert.deepEqual([...encodeVarint(128n)], [0x80, 0x01]);
  assert.deepEqual([...encodeVarint(300n)], [0xac, 0x02]);
  assert.deepEqual([...encodeVarint(0xffffffffn)], [0xff, 0xff, 0xff, 0xff, 0x0f]);
});

test("token round-trip preserves bytes exactly, including field order and zero values", () => {
  const original = encodeProtoTokens([
    varintToken(1, 0),
    bytesToken(2, encodeProtoTokens([varintToken(1, 0), varintToken(2, 0)])),
    varintToken(1, 5), // repeated field, out of ascending order
    bytesToken(3, new Uint8Array([0xde, 0xad])),
  ]);

  const tokens = readProtoTokens(original);
  assert.deepEqual(encodeProtoTokens(tokens), original);
  assert.equal(tokens.length, 4);
  assert.deepEqual(
    tokens.map((token) => token.fieldNumber),
    [1, 2, 1, 3],
  );
});

test("readProtoTokens agrees with readProtoFields on the same buffer", () => {
  const buf = encodeProtoTokens([varintToken(7, 42), bytesToken(2, new TextEncoder().encode("hi"))]);
  const fields = readProtoFields(buf);
  const tokens = readProtoTokens(buf);

  const varint = fields.get(7)?.[0];
  assert.equal(varint?.wireType === 0 && varint.varint, 42n);
  assert.equal(tokens[0]?.wireType === 0 && tokens[0].varint, 42n);
});

test("truncated length-delimited values are rejected", () => {
  // field 1, wire type 2, declared length 5, only 2 bytes present
  const truncated = new Uint8Array([0x0a, 0x05, 0x01, 0x02]);
  assert.throws(() => readProtoTokens(truncated), /Truncated/);
});

test("negative varints are refused rather than silently misencoded", () => {
  assert.throws(() => encodeVarint(-1n), /negative/);
  assert.throws(() => varintToken(1, -5), /negative/);
});
