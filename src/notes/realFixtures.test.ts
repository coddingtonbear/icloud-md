import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeNoteBodyText, decompressNoteDocument } from "./noteText.js";
import { noteDocumentRoundTrips, parseNoteDocument } from "./noteDocument.js";
import { REAL_FIRST_SAVE_NOTE, REAL_FORMATTED_MULTI_EDIT_NOTE, REAL_PLAIN_NOTE, REAL_UNICODE_NOTE } from "./realFixtures.js";

test("REAL_PLAIN_NOTE decodes and round-trips", () => {
  const buf = Buffer.from(REAL_PLAIN_NOTE, "base64");
  assert.equal(decodeNoteBodyText(buf), "Test Note\nThis is a test note used for testing out `icloud-notes-sync`\n");
  assert.equal(noteDocumentRoundTrips(decompressNoteDocument(buf)), true);
});

test("REAL_UNICODE_NOTE decodes and round-trips", () => {
  const buf = Buffer.from(REAL_UNICODE_NOTE, "base64");
  assert.equal(
    decodeNoteBodyText(buf),
    "\nthis is a test note.  how well does this work when compared to the google version?\n\nbuenos días🥚",
  );
  assert.equal(noteDocumentRoundTrips(decompressNoteDocument(buf)), true);
});

test("REAL_FORMATTED_MULTI_EDIT_NOTE decodes and round-trips, including the repeated-sequence run", () => {
  const buf = Buffer.from(REAL_FORMATTED_MULTI_EDIT_NOTE, "base64");
  const raw = decompressNoteDocument(buf);
  const doc = parseNoteDocument(raw);

  assert.equal(doc.replicas.length, 6);
  assert.equal(doc.runs.length, 75);
  assert.equal(doc.runs.filter((run) => run.tombstone).length, 21);
  assert.equal(doc.attributeRuns.length, 58);

  // Formerly a known gap (dev notes, 2026-07-15T07:27): one TextRun in this
  // real capture encodes its `sequence` field twice. The pre-migration
  // hand-rolled codec kept only the last occurrence and failed to
  // round-trip this note; the protobuf-es migration (`TextRun.sequence`
  // declared `repeated`, dev notes 2026-07-15T07:48) fixes it - this
  // fixture is the proof.
  const multiSequenceRuns = doc.runs.filter((run) => run.sequence.length > 1);
  assert.equal(multiSequenceRuns.length, 1);
  assert.deepEqual(multiSequenceRuns[0]?.sequence, [14, 16]);
  assert.equal(noteDocumentRoundTrips(raw), true);
});

test("REAL_FIRST_SAVE_NOTE (a brand-new note's first save) decodes and round-trips with no code changes", () => {
  const raw = decompressNoteDocument(Buffer.from(REAL_FIRST_SAVE_NOTE, "base64"));
  const doc = parseNoteDocument(new Uint8Array(raw));

  assert.equal(doc.text, "Test Note (2026\n");
  // One replica, counters [total clocks consumed, one edit event] - the
  // shape buildInitialNoteDocument reproduces for synthetic creates.
  assert.equal(doc.replicas.length, 1);
  assert.deepEqual(doc.replicas[0]?.counters, [17, 1]);
  assert.equal(noteDocumentRoundTrips(new Uint8Array(raw)), true);
});
