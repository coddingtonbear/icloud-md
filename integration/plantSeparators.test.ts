/**
 * Offline proof that the separator planter plants what the live CR tests
 * think it does.
 *
 * The live tests assert that a CR or CRLF note pulls, settles and survives an
 * edit. Those assertions are only worth anything if the planted record really
 * holds CRs in the right places and is otherwise a well-formed document: a
 * planter that quietly left the LFs alone would make every live assertion
 * pass trivially, and one that emitted a malformed document would make them
 * fail for a reason unrelated to separators. Both are ruled out here, on
 * real captured bytes, with no account involved.
 *
 * Runs under `npm test` alongside the unit suite (see package.json).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { noteDocumentRoundTrips, parseNoteDocument, validateDocumentInvariants } from "../src/notes/noteDocument.js";
import { decompressNoteDocument } from "../src/notes/noteText.js";
import { REAL_PLAIN_NOTE } from "../src/notes/realFixtures.js";
import { applySeparatorReplacements, buildSeparatorPlant } from "./plantSeparators.js";

const REPLICA_ID = new Uint8Array(Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
const ORIGINAL_TEXT = "Test Note\nThis is a test note used for testing out `icloud-notes-sync`\n";

function originalRaw(): Buffer {
  return decompressNoteDocument(Buffer.from(REAL_PLAIN_NOTE, "base64"));
}

test("the fixture is the text these tests assume", () => {
  assert.equal(parseNoteDocument(originalRaw()).text, ORIGINAL_TEXT);
});

test("a bare CR replaces exactly the LF it was aimed at", () => {
  const planted = buildSeparatorPlant(originalRaw(), [{ find: "Test Note\n", replace: "Test Note\r" }], REPLICA_ID);

  assert.equal(planted.oldText, ORIGINAL_TEXT);
  assert.equal(planted.newText, "Test Note\rThis is a test note used for testing out `icloud-notes-sync`\n");
  const doc = parseNoteDocument(planted.raw);
  assert.equal(doc.text, planted.newText);
  validateDocumentInvariants(doc);
  assert.equal(noteDocumentRoundTrips(planted.raw), true);
});

test("a CRLF plant grows the text by one code unit and keeps the attribute runs covering it", () => {
  const planted = buildSeparatorPlant(originalRaw(), [{ find: "Test Note\n", replace: "Test Note\r\n" }], REPLICA_ID);

  const doc = parseNoteDocument(planted.raw);
  assert.equal(doc.text, "Test Note\r\nThis is a test note used for testing out `icloud-notes-sync`\n");
  assert.equal(doc.text.length, ORIGINAL_TEXT.length + 1);
  // The attribute runs must still cover the whole text - an off-by-one here
  // is exactly the kind of malformed plant the live test must not be fed.
  assert.equal(
    doc.attributeRuns.reduce((sum, run) => sum + run.length, 0),
    doc.text.length,
  );
  validateDocumentInvariants(doc);
  assert.equal(noteDocumentRoundTrips(planted.raw), true);
});

test("a replacement that is missing or ambiguous is refused rather than silently skipped", () => {
  assert.throws(() => applySeparatorReplacements(ORIGINAL_TEXT, [{ find: "absent\n", replace: "absent\r" }]), /exactly once/);
  assert.throws(() => applySeparatorReplacements("a\nb\na\nb", [{ find: "a\n", replace: "a\r" }]), /exactly once/);
});
