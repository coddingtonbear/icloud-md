import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTextEdit,
  computeSplice,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
  validateDocumentInvariants,
  type NoteDocument,
  type TextRun,
} from "./noteDocument.js";
import { bytesToken, varintToken } from "./protobuf.js";
import { decodeNoteBodyText, compressNoteDocument } from "./noteText.js";

const REPLICA_A = new Uint8Array(16).fill(0xaa);
const REPLICA_B = new Uint8Array(16).fill(0xbb);
const SENTINEL: TextRun = {
  coord: { replica: 0, clock: 0xffffffff },
  length: 0,
  anchor: { replica: 0, clock: 0xffffffff },
  tombstone: false,
  sequence: undefined,
};

/**
 * A synthetic document in the exact shape observed in captured web-client
 * saves: origin run, one content run per replica edit, end sentinel, replica
 * table, one plain attribute run. `applyTextEdit` requires the CRDT
 * invariants to hold, so the runs/replica clocks must be consistent.
 */
function makeDocument(text: string, runs: TextRun[], replicaClocks: number[]): NoteDocument {
  const doc: NoteDocument = {
    rootTokens: [varintToken(1, 0), bytesToken(2, new Uint8Array())],
    documentTokens: [varintToken(1, 0), varintToken(2, 0), bytesToken(3, new Uint8Array())],
    text,
    runs: [
      {
        coord: { replica: 0, clock: 0 },
        length: 0,
        anchor: { replica: 0, clock: 0 },
        tombstone: false,
        sequence: 1,
      },
      ...runs,
      SENTINEL,
    ],
    replicas: [{ id: REPLICA_A, counters: [replicaClocks[0] ?? 0, 1] }],
    attributeRuns: [{ length: text.length, rest: [] }],
  };
  for (const clock of replicaClocks.slice(1)) {
    doc.replicas.push({ id: REPLICA_B, counters: [clock, 1] });
  }
  return doc;
}

function simpleDocument(text: string): NoteDocument {
  return makeDocument(
    text,
    [
      {
        coord: { replica: 1, clock: 0 },
        length: text.length,
        anchor: { replica: 1, clock: 0 },
        tombstone: false,
        sequence: 2,
      },
    ],
    [text.length],
  );
}

function visibleText(doc: NoteDocument): string {
  // Reconstructs the text from the runs alone, to prove the CRDT structure
  // agrees with the note_text field after an edit.
  let position = 0;
  let out = "";
  for (const run of doc.runs) {
    if (run.tombstone || run.coord.clock === 0xffffffff) {
      continue;
    }
    out += doc.text.slice(position, position + run.length);
    position += run.length;
  }
  return out;
}

function reencodeAndDecode(doc: NoteDocument): string {
  return decodeNoteBodyText(compressNoteDocument(encodeNoteDocument(doc)));
}

test("parse/encode round-trips a synthetic document byte-for-byte", () => {
  const original = encodeNoteDocument(simpleDocument("Grocery list\nEggs\n"));
  assert.equal(noteDocumentRoundTrips(original), true);

  const reparsed = parseNoteDocument(original);
  assert.equal(reparsed.text, "Grocery list\nEggs\n");
  assert.equal(reparsed.runs.length, 3);
  assert.equal(reparsed.replicas.length, 1);
  assert.deepEqual(reparsed.attributeRuns, [{ length: 18, rest: [] }]);
});

test("parsed document decodes to the same text noteText.ts sees", () => {
  const doc = simpleDocument("Hello\nWorld");
  assert.equal(reencodeAndDecode(doc), "Hello\nWorld");
});

test("appending with our own replica extends our trailing run without adding a run", () => {
  const doc = simpleDocument("Hello");
  const runCountBefore = doc.runs.length;

  assert.equal(applyTextEdit(doc, "Hello there", { replicaId: REPLICA_A }), true);

  assert.equal(doc.text, "Hello there");
  assert.equal(doc.runs.length, runCountBefore);
  assert.equal(doc.replicas.length, 1);
  assert.equal(doc.replicas[0]?.counters[0], 11);
  // A pure extension is not a new edit event (matches the captured
  // append, which left the second counter alone).
  assert.equal(doc.replicas[0]?.counters[1], 1);
  assert.deepEqual(doc.attributeRuns, [{ length: 11, rest: [] }]);
  assert.equal(visibleText(doc), "Hello there");
  assert.equal(reencodeAndDecode(doc), "Hello there");
});

test("appending as a new replica adds a replica entry and a new run", () => {
  const doc = simpleDocument("Hello");

  assert.equal(applyTextEdit(doc, "Hello!", { replicaId: REPLICA_B }), true);

  assert.equal(doc.replicas.length, 2);
  assert.deepEqual(doc.replicas[1]?.counters, [1, 1]);
  const inserted = doc.runs[doc.runs.length - 2];
  assert.deepEqual(inserted?.coord, { replica: 2, clock: 0 });
  assert.equal(inserted?.length, 1);
  assert.equal(visibleText(doc), "Hello!");
  assert.equal(reencodeAndDecode(doc), "Hello!");
  validateDocumentInvariants(doc);
});

test("mid-text insertion splits the containing run", () => {
  const doc = simpleDocument("Hello world");

  assert.equal(applyTextEdit(doc, "Hello brave world", { replicaId: REPLICA_B }), true);

  assert.equal(doc.text, "Hello brave world");
  assert.equal(visibleText(doc), "Hello brave world");
  // Original single run split in two around the inserted run.
  const contentRuns = doc.runs.filter((run) => run.length > 0);
  assert.equal(contentRuns.length, 3);
  assert.deepEqual(
    contentRuns.map((run) => ({ replica: run.coord.replica, clock: run.coord.clock, length: run.length })),
    [
      { replica: 1, clock: 0, length: 6 },
      { replica: 2, clock: 0, length: 6 },
      { replica: 1, clock: 6, length: 5 },
    ],
  );
  assert.equal(reencodeAndDecode(doc), "Hello brave world");
  validateDocumentInvariants(doc);
});

test("deletion tombstones the removed range instead of dropping it", () => {
  const doc = simpleDocument("Hello brave world");

  assert.equal(applyTextEdit(doc, "Hello world", { replicaId: REPLICA_B }), true);

  assert.equal(doc.text, "Hello world");
  assert.equal(visibleText(doc), "Hello world");
  const tombstones = doc.runs.filter((run) => run.tombstone);
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0]?.length, 6);
  assert.equal(tombstones[0]?.coord.clock, 6); // split from the middle of the original run
  // Our replica is registered (the deletion is an edit event it must record)
  // but inserted no text.
  assert.equal(doc.replicas.length, 2);
  assert.deepEqual(doc.replicas[1]?.counters, [0, 1]);
  assert.equal(reencodeAndDecode(doc), "Hello world");
  validateDocumentInvariants(doc);
});

test("deletion spanning multiple runs tombstones each covered piece", () => {
  const doc = makeDocument(
    "aaabbbccc",
    [
      { coord: { replica: 1, clock: 0 }, length: 3, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: 2 },
      { coord: { replica: 2, clock: 0 }, length: 3, anchor: { replica: 2, clock: 0 }, tombstone: false, sequence: 3 },
      { coord: { replica: 1, clock: 3 }, length: 3, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: 4 },
    ],
    [6, 3],
  );

  // Delete "abbbc": partially covers run 1, fully covers run 2, partially covers run 3.
  assert.equal(applyTextEdit(doc, "aacc", { replicaId: REPLICA_A }), true);

  assert.equal(visibleText(doc), "aacc");
  const tombstoned = doc.runs.filter((run) => run.tombstone);
  assert.equal(tombstoned.length, 3);
  assert.equal(
    tombstoned.reduce((sum, run) => sum + run.length, 0),
    5,
  );
  assert.equal(reencodeAndDecode(doc), "aacc");
  validateDocumentInvariants(doc);
});

test("replacing text mid-note tombstones the old range and inserts at the same spot", () => {
  const doc = simpleDocument("The quick brown fox");

  assert.equal(applyTextEdit(doc, "The slow brown fox", { replicaId: REPLICA_B }), true);

  assert.equal(visibleText(doc), "The slow brown fox");
  assert.equal(reencodeAndDecode(doc), "The slow brown fox");
  validateDocumentInvariants(doc);
});

test("edits never split a surrogate pair", () => {
  const doc = simpleDocument("ab\u{1f600}cd"); // emoji is two UTF-16 units

  assert.equal(applyTextEdit(doc, "ab\u{1f601}cd", { replicaId: REPLICA_B }), true);

  assert.equal(doc.text, "ab\u{1f601}cd");
  assert.equal(visibleText(doc), "ab\u{1f601}cd");
  assert.equal(reencodeAndDecode(doc), "ab\u{1f601}cd");
  validateDocumentInvariants(doc);
});

test("unchanged text is a no-op", () => {
  const doc = simpleDocument("same");
  const before = encodeNoteDocument(doc);
  assert.equal(applyTextEdit(doc, "same", { replicaId: REPLICA_B }), false);
  assert.deepEqual(encodeNoteDocument(doc), before);
});

test("consecutive pushes from the same replica keep extending the same run", () => {
  const doc = simpleDocument("v1");
  applyTextEdit(doc, "v1 v2", { replicaId: REPLICA_B });
  const runsAfterFirst = doc.runs.length;
  applyTextEdit(doc, "v1 v2 v3", { replicaId: REPLICA_B });

  assert.equal(doc.runs.length, runsAfterFirst); // extended, not appended
  assert.equal(visibleText(doc), "v1 v2 v3");
  assert.equal(doc.replicas.length, 2);
  assert.equal(reencodeAndDecode(doc), "v1 v2 v3");
  validateDocumentInvariants(doc);
});

test("a document with unexpected note fields is refused", () => {
  const doc = simpleDocument("hi");
  const encoded = encodeNoteDocument(doc);
  // Append an unknown field 9 inside the Note message by rebuilding by hand.
  const parsed = parseNoteDocument(encoded);
  const mutated = {
    ...parsed,
    attributeRuns: [{ length: 2, rest: [varintToken(1, 7)] }],
  };
  assert.throws(() => encodeNoteDocument(mutated) && parseNoteDocument(encodeNoteDocument(mutated)), /repeated length/);
});

test("invariant validation rejects run lengths that disagree with the text", () => {
  const doc = simpleDocument("hello");
  doc.text = "hello!";
  assert.throws(() => validateDocumentInvariants(doc), /do not match note text length/);
});

test("invariant validation rejects clocks past the replica counter", () => {
  const doc = simpleDocument("hello");
  const replica = doc.replicas[0];
  if (!replica) throw new Error("missing replica");
  replica.counters[0] = 3;
  assert.throws(() => validateDocumentInvariants(doc), /exceed replica/);
});

test("sequence numbers are renumbered to list order after an edit, like every captured save", () => {
  const doc = simpleDocument("Hello world");
  applyTextEdit(doc, "Hello brave world", { replicaId: REPLICA_B });

  const sequences = doc.runs.filter((run) => run.coord.clock !== 0xffffffff).map((run) => run.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, i) => i + 1),
  );
});

test("structural edits advance the event counter; the sentinel run never gets a sequence", () => {
  const doc = simpleDocument("Hello brave world");
  assert.equal(doc.replicas[0]?.counters[1], 1);

  // Deletion by the existing replica: one push, one event.
  applyTextEdit(doc, "Hello world", { replicaId: REPLICA_A });
  assert.equal(doc.replicas[0]?.counters[1], 2);

  assert.equal(doc.runs[doc.runs.length - 1]?.sequence, undefined);
});

test("computeSplice finds minimal edits", () => {
  assert.deepEqual(computeSplice("abc", "abXc"), { start: 2, deleteLength: 0, insertText: "X" });
  assert.deepEqual(computeSplice("abc", "ac"), { start: 1, deleteLength: 1, insertText: "" });
  assert.deepEqual(computeSplice("abc", "aXc"), { start: 1, deleteLength: 1, insertText: "X" });
  assert.deepEqual(computeSplice("abc", "abc def"), { start: 3, deleteLength: 0, insertText: " def" });
  assert.deepEqual(computeSplice("", "new"), { start: 0, deleteLength: 0, insertText: "new" });
});
