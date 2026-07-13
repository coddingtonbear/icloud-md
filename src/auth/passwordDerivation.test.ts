import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, pbkdf2Sync } from "node:crypto";
import { deriveSrpPassword } from "./passwordDerivation.js";

// These vectors are self-consistency checks (independently re-deriving the
// expected bytes via node:crypto primitives here, not an Apple-confirmed
// test vector) - they validate that the s2k/s2k_fo composition is wired
// correctly, not that it matches Apple's server byte-for-byte.

test("s2k: PBKDF2 over the raw SHA256 password digest", () => {
  const password = "correct horse battery staple";
  const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const iterations = 1000;

  const digest = createHash("sha256").update(password, "utf8").digest();
  const expected = new Uint8Array(pbkdf2Sync(digest, salt, iterations, 32, "sha256"));

  const actual = deriveSrpPassword(password, salt, iterations, "s2k");
  assert.deepEqual(actual, expected);
});

test("s2k_fo: PBKDF2 over the hex-encoded SHA256 password digest", () => {
  const password = "correct horse battery staple";
  const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const iterations = 1000;

  const digest = createHash("sha256").update(password, "utf8").digest();
  const hexEncoded = Buffer.from(digest.toString("hex"), "utf8");
  const expected = new Uint8Array(pbkdf2Sync(hexEncoded, salt, iterations, 32, "sha256"));

  const actual = deriveSrpPassword(password, salt, iterations, "s2k_fo");
  assert.deepEqual(actual, expected);
});

test("s2k and s2k_fo produce different output for the same inputs", () => {
  const password = "correct horse battery staple";
  const salt = new Uint8Array([9, 9, 9, 9]);
  const iterations = 500;

  const s2k = deriveSrpPassword(password, salt, iterations, "s2k");
  const s2kFo = deriveSrpPassword(password, salt, iterations, "s2k_fo");
  assert.notDeepEqual(s2k, s2kFo);
});

test("output is always 32 bytes", () => {
  const result = deriveSrpPassword("x", new Uint8Array([1]), 10, "s2k");
  assert.equal(result.length, 32);
});
