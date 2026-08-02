/**
 * Offline proof that the corrupt-document helper corrupts the right thing.
 *
 * The live negative control asserts that a client *discards* what this helper
 * pushes. That assertion is only worth anything if the helper really produces
 * the wrong shape: a helper that quietly emitted a correctly restamped
 * deletion would make the live test pass for the opposite of the intended
 * reason, and a helper that emitted a malformed document would make it pass
 * because the client rejected garbage rather than because it lost a
 * last-writer-wins comparison. Both failure modes are ruled out here, on real
 * captured bytes, with no account involved.
 *
 * Runs under `npm test` alongside the unit suite (see package.json) - it is
 * an offline test that happens to live beside the live suite because the code
 * it covers must not ship in `src/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  applyTextEdit,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
  validateDocumentInvariants,
  type NoteDocument,
  type TextRun,
} from "../src/notes/noteDocument.js";
import { decompressNoteDocument } from "../src/notes/noteText.js";
import { REAL_PLAIN_NOTE } from "../src/notes/realFixtures.js";
import { buildTiedAnchorDeletion } from "./tiedAnchorDeletion.js";

const REPLICA_ID = new Uint8Array(Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
const ORIGINAL_TEXT = "Test Note\nThis is a test note used for testing out `icloud-notes-sync`\n";
const DELETED_WORDS = "used for testing out ";
const NEW_TEXT = ORIGINAL_TEXT.replace(DELETED_WORDS, "");

function originalRaw(): Buffer {
  return decompressNoteDocument(Buffer.from(REAL_PLAIN_NOTE, "base64"));
}

/** The same deletion, done properly - the document a real push would send. */
function correctDeletion(): NoteDocument {
  const doc = parseNoteDocument(originalRaw());
  assert.equal(applyTextEdit(doc, NEW_TEXT, { replicaId: REPLICA_ID }), true);
  return doc;
}

function runKey(run: TextRun): string {
  return `${run.coord.replica}:${run.coord.clock}+${run.length}`;
}

test("the tied-anchor deletion deletes the same text a correct push would", () => {
  const corrupted = parseNoteDocument(buildTiedAnchorDeletion(originalRaw(), NEW_TEXT, REPLICA_ID).raw);

  assert.equal(corrupted.text, NEW_TEXT);
  assert.equal(corrupted.text, correctDeletion().text);
  assert.doesNotMatch(corrupted.text, /used for testing out/);
  // The words are tombstoned, not dropped: a CRDT deletion retains them.
  const visible = corrupted.runs.filter((run) => !run.tombstone).reduce((total, run) => total + run.length, 0);
  assert.equal(visible, NEW_TEXT.length);
});

test("the tied-anchor deletion is a structurally valid document, not garbage", () => {
  // If the client discarded a malformed document the live test would prove
  // nothing about clocks, so the corrupt document has to be one the parser,
  // the invariant checker and the round-trip gate all accept.
  const { raw } = buildTiedAnchorDeletion(originalRaw(), NEW_TEXT, REPLICA_ID);

  const corrupted = parseNoteDocument(raw);
  validateDocumentInvariants(corrupted);
  assert.equal(noteDocumentRoundTrips(raw), true);
  assert.deepEqual(encodeNoteDocument(corrupted), raw);
});

test("the tied-anchor deletion differs from a correct one in the stamps and nothing else", () => {
  const { raw, tiedRuns } = buildTiedAnchorDeletion(originalRaw(), NEW_TEXT, REPLICA_ID);
  const corrupted = parseNoteDocument(raw);
  const correct = correctDeletion();

  assert.ok(tiedRuns > 0, "the edit should have tombstoned something");

  // Identical run graph: same runs, same lengths, same tombstone flags, same
  // child edges. Only the style timestamps are allowed to differ.
  assert.deepEqual(
    corrupted.runs.map((run) => ({ key: runKey(run), tombstone: run.tombstone, sequence: run.sequence })),
    correct.runs.map((run) => ({ key: runKey(run), tombstone: run.tombstone, sequence: run.sequence })),
  );
  assert.deepEqual(corrupted.attributeRuns, correct.attributeRuns);
  assert.deepEqual(
    corrupted.replicas.map((replica) => ({ id: Buffer.from(replica.id).toString("hex"), textClock: replica.counters[0] })),
    correct.replicas.map((replica) => ({ id: Buffer.from(replica.id).toString("hex"), textClock: replica.counters[0] })),
  );

  // Untouched runs must be untouched in both.
  for (const [index, run] of corrupted.runs.entries()) {
    if (!run.tombstone) {
      assert.deepEqual(run.anchor, correct.runs[index]?.anchor, `run ${index} is visible - its stamp should not differ`);
    }
  }
});

test("the tombstoned runs keep their original style timestamp instead of being restamped", () => {
  const original = parseNoteDocument(originalRaw());
  const { raw, tiedAnchors, correctAnchors, tiedRuns } = buildTiedAnchorDeletion(originalRaw(), NEW_TEXT, REPLICA_ID);
  const corrupted = parseNoteDocument(raw);
  const correct = correctDeletion();

  assert.equal(tiedAnchors.length, tiedRuns);
  assert.equal(correctAnchors.length, tiedRuns);

  for (const [index, run] of corrupted.runs.entries()) {
    if (!run.tombstone) {
      continue;
    }
    const properlyStamped = correct.runs[index];
    assert.ok(properlyStamped?.tombstone, `run ${index} should be tombstoned in both documents`);

    // The run this piece came from, in the document a reader still holds.
    const source = original.runs.find(
      (candidate) =>
        candidate.coord.replica === run.coord.replica &&
        run.coord.clock >= candidate.coord.clock &&
        run.coord.clock < candidate.coord.clock + candidate.length,
    );
    if (source === undefined || source.tombstone) {
      continue; // Dead before this edit; its stamp was never ours to change.
    }

    // The corruption: our tombstone claims exactly the timestamp the holder's
    // own copy of this run carries. It ties, so it cannot out-rank it.
    assert.deepEqual(run.anchor, source.anchor, `run ${index} should have kept its original stamp`);

    // And that is strictly weaker than what the real rule would have stamped:
    // (us, max(old clock + 8, floor)) - the deletion bias from PR 9/12.
    const ourIndex = correct.replicas.findIndex((replica) => Buffer.from(replica.id).equals(Buffer.from(REPLICA_ID))) + 1;
    assert.equal(properlyStamped.anchor.replica, ourIndex, "a correct push stamps the tombstone under our own replica");
    assert.ok(
      properlyStamped.anchor.clock >= source.anchor.clock + 8,
      `a correct push would have stamped run ${index} at >= ${source.anchor.clock + 8}, not ${properlyStamped.anchor.clock}`,
    );
    assert.ok(
      properlyStamped.anchor.clock > run.anchor.clock,
      `run ${index}'s corrupt stamp (${run.anchor.clock}) should lose to the correct one (${properlyStamped.anchor.clock})`,
    );
  }
});

test("the style counter is rolled back with the stamps", () => {
  const original = parseNoteDocument(originalRaw());
  const corrupted = parseNoteDocument(buildTiedAnchorDeletion(originalRaw(), NEW_TEXT, REPLICA_ID).raw);
  const correct = correctDeletion();

  const styleClockOf = (doc: NoteDocument, id: Uint8Array): number | undefined =>
    doc.replicas.find((replica) => Buffer.from(replica.id).equals(Buffer.from(id)))?.counters[1];

  // Every replica that was already in the table keeps the clock it had.
  for (const replica of original.replicas) {
    assert.equal(styleClockOf(corrupted, replica.id), replica.counters[1]);
  }
  // Ours is the one a correct push would have advanced.
  const ourCorrect = styleClockOf(correct, REPLICA_ID);
  const ourCorrupt = styleClockOf(corrupted, REPLICA_ID);
  assert.ok(ourCorrect !== undefined && ourCorrupt !== undefined);
  assert.ok(ourCorrect > ourCorrupt, `a correct push advances our style clock (${ourCorrect}) past the reverted one (${ourCorrupt})`);
});

test("it refuses anything that is not a pure deletion", () => {
  assert.throws(
    () => buildTiedAnchorDeletion(originalRaw(), `${ORIGINAL_TEXT}and one more line\n`, REPLICA_ID),
    /only pure deletions/,
  );
  assert.throws(() => buildTiedAnchorDeletion(originalRaw(), ORIGINAL_TEXT, REPLICA_ID), /text is unchanged/);
});
