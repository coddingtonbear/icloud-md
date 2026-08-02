import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  applyFormattingOp,
  applyTextEdit,
  buildInitialNoteDocument,
  computeSplice,
  computeSplices,
  encodeNoteDocument,
  isSentinel,
  noteDocumentRoundTrips,
  parseNoteDocument,
  validateDocumentInvariants,
  type NoteDocument,
  type TextRun,
} from "./noteDocument.js";
import { AttributeRunSchema, StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { decodeNoteBodyText, compressNoteDocument } from "./noteText.js";

const REPLICA_A = new Uint8Array(16).fill(0xaa);
const REPLICA_B = new Uint8Array(16).fill(0xbb);
const SENTINEL: TextRun = {
  coord: { replica: 0, clock: 0xffffffff },
  length: 0,
  anchor: { replica: 0, clock: 0xffffffff },
  tombstone: false,
  sequence: [],
};

/**
 * A synthetic document in the exact shape observed in captured web-client
 * saves: origin run, one content run per replica edit, end sentinel, replica
 * table, one plain attribute run. `applyTextEdit` requires the CRDT
 * invariants to hold, so the runs/replica clocks must be consistent.
 */
function makeDocument(text: string, runs: TextRun[], replicaClocks: number[]): NoteDocument {
  const doc: NoteDocument = {
    rootSerializationVersion: 0,
    versionSerializationVersion: 0,
    minimumSupportedVersion: 0,
    text,
    runs: [
      {
        coord: { replica: 0, clock: 0 },
        length: 0,
        anchor: { replica: 0, clock: 0 },
        tombstone: false,
        sequence: [1],
      },
      ...runs,
      SENTINEL,
    ],
    replicas: [{ id: REPLICA_A, counters: [replicaClocks[0] ?? 0, 1] }],
    attributeRuns: [create(AttributeRunSchema, { length: text.length })],
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
        sequence: [2],
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
  assert.equal(reparsed.attributeRuns.length, 1);
  assert.equal(reparsed.attributeRuns[0]?.length, 18);
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
  assert.equal(doc.attributeRuns.length, 1);
  assert.equal(doc.attributeRuns[0]?.length, 11);
  assert.equal(visibleText(doc), "Hello there");
  assert.equal(reencodeAndDecode(doc), "Hello there");
});

test("appending as a new replica adds a replica entry and a new run", () => {
  const doc = simpleDocument("Hello");

  assert.equal(applyTextEdit(doc, "Hello!", { replicaId: REPLICA_B }), true);

  assert.equal(doc.replicas.length, 2);
  // A joining replica initializes both clocks to the observed maxima (text
  // clock 5 from replica A, style clock 1) - the 2026-07-17
  // formatting-evolution follow-up capture's behavior. A fresh run stamps at
  // style clock 0, which only requires the style clock to be at least 1
  // (Apple: `max(_replicaStyleClock, 1)`), so it stays 1.
  assert.deepEqual(doc.replicas[1]?.counters, [6, 1]);
  const inserted = doc.runs[doc.runs.length - 2];
  assert.deepEqual(inserted?.coord, { replica: 2, clock: 5 });
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
      // The joining replica's text clock starts at the observed maximum (11).
      { replica: 2, clock: 11, length: 6 },
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
  // A deletion is a formatting op with Apple's deletion bias: the tombstoned
  // substring is restamped with (us, max(its old style clock + 8, the style
  // clock floor)) - here max(0 + 8, 1) = 8 - so the deletion wins the
  // merge-time LWW against up to 8 clock steps of concurrent restyling.
  assert.deepEqual(tombstones[0]?.anchor, { replica: 2, clock: 8 });
  // Our replica is registered and its style clock advanced past the stamp it
  // assigned (Apple: `max(d + 1, _replicaStyleClock)`), but it inserted no
  // text - its text clock stays at the joined maximum.
  assert.equal(doc.replicas.length, 2);
  assert.deepEqual(doc.replicas[1]?.counters, [17, 9]);
  assert.equal(reencodeAndDecode(doc), "Hello world");
  validateDocumentInvariants(doc);
});

test("deletion spanning multiple runs tombstones each covered piece", () => {
  const doc = makeDocument(
    "aaabbbccc",
    [
      { coord: { replica: 1, clock: 0 }, length: 3, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: [2] },
      { coord: { replica: 2, clock: 0 }, length: 3, anchor: { replica: 2, clock: 0 }, tombstone: false, sequence: [3] },
      { coord: { replica: 1, clock: 3 }, length: 3, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: [4] },
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

test("a document missing its replica clock table is refused", () => {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, {
        minimumSupportedVersion: 0,
        // no String.timestamp (replica clock table) set
        data: toBinary(StringSchema, create(StringSchema, { string: "hi" })),
      }),
    ],
  });
  const raw = toBinary(VersionedDocumentSchema, message);
  assert.throws(() => parseNoteDocument(raw), /missing its replica clock table/);
  assert.equal(noteDocumentRoundTrips(raw), false);
});

test("a note carrying an unrecognized field only fails if the round-trip actually breaks", () => {
  // protobuf-es tolerates fields it doesn't recognize (preserved via its own
  // unknown-field retention) rather than rejecting them up front - the
  // round-trip byte comparison is what actually guards against silent data
  // loss now (see file header / dev notes, 2026-07-15). A well-formed
  // synthetic document with only known fields must still round-trip cleanly.
  const doc = simpleDocument("hi");
  assert.equal(noteDocumentRoundTrips(encodeNoteDocument(doc)), true);
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
    sequences.map((_, i) => [i + 1]),
  );
});

test("structural edits advance the event counter; the sentinel run never gets a sequence", () => {
  const doc = simpleDocument("Hello brave world");
  assert.equal(doc.replicas[0]?.counters[1], 1);

  // Deletion by the existing replica: the tombstone stamps at
  // max(0 + 8, 1) = 8 and the style clock lands just past it.
  applyTextEdit(doc, "Hello world", { replicaId: REPLICA_A });
  assert.equal(doc.replicas[0]?.counters[1], 9);

  assert.deepEqual(doc.runs[doc.runs.length - 1]?.sequence, []);
});

test("computeSplice finds minimal edits", () => {
  assert.deepEqual(computeSplice("abc", "abXc"), { start: 2, deleteLength: 0, insertText: "X" });
  assert.deepEqual(computeSplice("abc", "ac"), { start: 1, deleteLength: 1, insertText: "" });
  assert.deepEqual(computeSplice("abc", "aXc"), { start: 1, deleteLength: 1, insertText: "X" });
  assert.deepEqual(computeSplice("abc", "abc def"), { start: 3, deleteLength: 0, insertText: " def" });
  assert.deepEqual(computeSplice("", "new"), { start: 0, deleteLength: 0, insertText: "new" });
});

test("computeSplices keeps separated edits as separate hunks, leaving the lines between untouched", () => {
  assert.deepEqual(computeSplices("same", "same"), []);
  // A single changed region degenerates to computeSplice's answer.
  assert.deepEqual(computeSplices("abc def", "abc XX def"), [{ start: 4, deleteLength: 0, insertText: "XX " }]);
  // Edits on two different lines: two hunks, "two\n" belongs to neither.
  assert.deepEqual(computeSplices("one\ntwo\nthree\n", "one EDIT\ntwo\nthree, EDITED\n"), [
    { start: 3, deleteLength: 0, insertText: " EDIT" },
    { start: 13, deleteLength: 0, insertText: ", EDITED" },
  ]);
});

test("computeSplices: a mid-document insert plus a trailing-newline difference stays two small hunks (2026-07-29 fusion regression)", () => {
  // The live-reproduced fusion shape: the local edit inserts into an early
  // paragraph while the markdown pipeline's trailing newline differs from
  // the server text. The old single-splice diff lost its common suffix and
  // rewrote everything from the insert to the end of the note.
  const remote = "p2 bravo dev-E1\n\np3 charlie\ntyped-on-device tail";
  const local = "p2 bravo EDIT-E1 dev-E1\n\np3 charlie\ntyped-on-device tail\n";
  assert.deepEqual(computeSplices(remote, local), [
    { start: 9, deleteLength: 0, insertText: "EDIT-E1 " },
    { start: remote.length, deleteLength: 0, insertText: "\n" },
  ]);
});

test("a multi-hunk edit never re-authors another replica's text between the hunks (2026-07-29 fusion regression)", () => {
  const doc = makeDocument(
    "alpha\n\nmid\nbravo-device",
    [
      { coord: { replica: 1, clock: 0 }, length: 11, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: [2] },
      { coord: { replica: 2, clock: 0 }, length: 12, anchor: { replica: 2, clock: 0 }, tombstone: false, sequence: [3] },
    ],
    [11, 12],
  );

  assert.equal(applyTextEdit(doc, "alpha EDIT\n\nmid\nbravo-device\n", { replicaId: REPLICA_A }), true);

  // Replica B's run must come through byte-identical: same single run, same
  // coord, still visible - not tombstoned and re-typed under replica A.
  const foreignRuns = doc.runs.filter((run) => run.coord.replica === 2);
  assert.equal(foreignRuns.length, 1);
  assert.deepEqual(foreignRuns[0], { coord: { replica: 2, clock: 0 }, length: 12, anchor: { replica: 2, clock: 0 }, tombstone: false, sequence: foreignRuns[0]!.sequence });
  // Pure inserts: nothing was deleted, so nothing may be tombstoned.
  assert.equal(doc.runs.some((run) => run.tombstone), false);
  // Replica A authored exactly the 6 inserted units (" EDIT" + "\n").
  const inserted = doc.runs.filter((run) => run.coord.replica === 1 && run.coord.clock >= 11);
  assert.equal(inserted.reduce((sum, run) => sum + run.length, 0), 6);

  assert.equal(visibleText(doc), "alpha EDIT\n\nmid\nbravo-device\n");
  assert.equal(reencodeAndDecode(doc), "alpha EDIT\n\nmid\nbravo-device\n");
});

test("multi-hunk deletions consume a single formatting op - every tombstone carries the same stamp", () => {
  const doc = simpleDocument("aa bb\nmid\ncc dd\n");

  assert.equal(applyTextEdit(doc, "aa\nmid\ncc\n", { replicaId: REPLICA_A }), true);

  const tombstones = doc.runs.filter((run) => run.tombstone);
  assert.equal(tombstones.length, 2);
  for (const run of tombstones) {
    // Both hunks' text carried the same old style clock (0), so both stamp
    // at max(0 + 8, 1) = 8 - the style-clock floor is captured once per
    // push, exactly like Apple's generateIdsForLocalChanges pass.
    assert.deepEqual(run.anchor, { replica: 1, clock: 8 });
  }
  // The style clock ends one past the highest stamp assigned.
  assert.equal(doc.replicas[0]?.counters[1], 9);
  assert.equal(visibleText(doc), "aa\nmid\ncc\n");
});

test("deleting text another replica restyled stamps past that replica's higher style clock", () => {
  // The dropped-deletion scenario the style-clock floor exists to prevent:
  // replica B restyled its text up to style clock 80 while our own style
  // counter sat at 5. A deletion stamped from our stale counter would lose
  // the merge-time LWW on every device that saw B's stamp, silently undoing
  // the delete (Apple's mergeWithString keeps the higher stamp's tombstone
  // state). The floor must clear B's stamp, and the +8 deletion bias rides
  // on top of the run's own old clock.
  const doc = makeDocument(
    "Hellobrave ",
    [
      { coord: { replica: 1, clock: 0 }, length: 5, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: [2] },
      { coord: { replica: 2, clock: 0 }, length: 6, anchor: { replica: 2, clock: 80 }, tombstone: false, sequence: [3] },
    ],
    [5, 6],
  );
  doc.replicas[0]!.counters[1] = 5;
  doc.replicas[1]!.counters[1] = 81;

  assert.equal(applyTextEdit(doc, "Hello", { replicaId: REPLICA_A }), true);

  const tombstones = doc.runs.filter((run) => run.tombstone);
  assert.equal(tombstones.length, 1);
  // Floor: max stamp 80 held by B, whose UUID beats ours in the tie-break,
  // so the floor is 81; the run's own old clock adds the bias: max(80+8, 81).
  assert.deepEqual(tombstones[0]?.anchor, { replica: 1, clock: 88 });
  assert.equal(doc.replicas[0]?.counters[1], 89);
  assert.equal(visibleText(doc), "Hello");
  validateDocumentInvariants(doc);
});

test("a formatting op restamps past another replica's higher style clock", () => {
  const doc = makeDocument(
    "Hellobrave ",
    [
      { coord: { replica: 1, clock: 0 }, length: 5, anchor: { replica: 1, clock: 0 }, tombstone: false, sequence: [2] },
      { coord: { replica: 2, clock: 0 }, length: 6, anchor: { replica: 2, clock: 80 }, tombstone: false, sequence: [3] },
    ],
    [5, 6],
  );
  doc.replicas[0]!.counters[1] = 5;
  doc.replicas[1]!.counters[1] = 81;

  applyFormattingOp(doc, [{ start: 5, end: 11 }], REPLICA_A);

  const restamped = doc.runs.find((run) => run.coord.replica === 2);
  // max(old 80 + 1, floor 81) = 81 - never below what any device has seen.
  assert.deepEqual(restamped?.anchor, { replica: 1, clock: 81 });
  assert.equal(doc.replicas[0]?.counters[1], 82);
  validateDocumentInvariants(doc);
});

test("buildInitialNoteDocument builds a first-save document whose encoding decodes back to the text", () => {
  const replicaId = new Uint8Array(16).fill(7);
  const doc = buildInitialNoteDocument("Grocery list\nEggs\nMilk\n", replicaId);

  validateDocumentInvariants(doc);
  assert.equal(doc.text, "Grocery list\nEggs\nMilk\n");
  // One replica: ours, counters [clocks consumed, one edit event] - the
  // same shape the captured first save has (see REAL_FIRST_SAVE_NOTE).
  assert.equal(doc.replicas.length, 1);
  assert.deepEqual(doc.replicas[0]?.counters, [doc.text.length, 1]);
  // Structure: the zero-length replica-0 lead run, our content run, the end
  // sentinel - and nothing else.
  assert.equal(doc.runs.length, 3);
  assert.equal(doc.runs[1]?.coord.replica, 1);
  assert.equal(doc.runs[1]?.length, doc.text.length);
  assert.equal(isSentinel(doc.runs[2]!), true);

  const reparsed = parseNoteDocument(encodeNoteDocument(doc));
  assert.equal(reparsed.text, "Grocery list\nEggs\nMilk\n");
});

test("buildInitialNoteDocument output survives the same round-trip gate push applies to real documents", () => {
  const doc = buildInitialNoteDocument("One line\n", new Uint8Array(16).fill(3));
  assert.equal(noteDocumentRoundTrips(encodeNoteDocument(doc)), true);
});

test("buildInitialNoteDocument refuses empty text", () => {
  assert.throws(() => buildInitialNoteDocument("", new Uint8Array(16)), /refusing to create an empty document/);
});

test("a document built by buildInitialNoteDocument accepts a follow-up applyTextEdit like any pulled document", () => {
  const replicaId = new Uint8Array(16).fill(9);
  const doc = buildInitialNoteDocument("Title\nBody\n", replicaId);

  const changed = applyTextEdit(doc, "Title\nBody with more\n", { replicaId });

  assert.equal(changed, true);
  validateDocumentInvariants(doc);
  assert.equal(parseNoteDocument(encodeNoteDocument(doc)).text, "Title\nBody with more\n");
});

// --- the attachmentInfo-run insertion guard ---------------------------------

/** `simpleDocument` with its single attribute run replaced by a three-run
 * table putting an attachmentInfo run over the U+FFFC at offset 1 of "a￼b" -
 * the shape every captured embed note has (length-1 run on the placeholder). */
function documentWithEmbed(): NoteDocument {
  const doc = simpleDocument("a￼b");
  doc.attributeRuns = [
    create(AttributeRunSchema, { length: 1 }),
    create(AttributeRunSchema, {
      length: 1,
      paragraphStyle: { style: 3 },
      attachmentInfo: { attachmentIdentifier: "A-1", typeUTI: "public.jpeg" },
    }),
    create(AttributeRunSchema, { length: 1 }),
  ];
  return doc;
}

test("inserting right after an embed never grows its attachmentInfo run", () => {
  const doc = documentWithEmbed();
  assert.equal(applyTextEdit(doc, "a￼Xb", { replicaId: REPLICA_A }), true);

  validateDocumentInvariants(doc);
  assert.equal(doc.attributeRuns.length, 4);
  // The embed's own run is untouched...
  assert.equal(doc.attributeRuns[1]?.length, 1);
  assert.equal(doc.attributeRuns[1]?.attachmentInfo?.attachmentIdentifier, "A-1");
  // ...and the inserted text got its own run: the embed's formatting minus
  // the attachment linkage.
  assert.equal(doc.attributeRuns[2]?.length, 1);
  assert.equal(doc.attributeRuns[2]?.attachmentInfo, undefined);
  assert.equal(doc.attributeRuns[2]?.paragraphStyle?.style, 3);
  assert.equal(reencodeAndDecode(doc), "a￼Xb");
});

test("inserting at position 0 before a leading embed keeps its run first-class", () => {
  const doc = simpleDocument("￼b");
  doc.attributeRuns = [
    create(AttributeRunSchema, {
      length: 1,
      attachmentInfo: { attachmentIdentifier: "A-2", typeUTI: "com.apple.notes.gallery" },
    }),
    create(AttributeRunSchema, { length: 1 }),
  ];

  assert.equal(applyTextEdit(doc, "X￼b", { replicaId: REPLICA_A }), true);

  validateDocumentInvariants(doc);
  assert.equal(doc.attributeRuns.length, 3);
  assert.equal(doc.attributeRuns[0]?.length, 1);
  assert.equal(doc.attributeRuns[0]?.attachmentInfo, undefined);
  assert.equal(doc.attributeRuns[1]?.length, 1);
  assert.equal(doc.attributeRuns[1]?.attachmentInfo?.attachmentIdentifier, "A-2");
  assert.equal(reencodeAndDecode(doc), "X￼b");
});

test("appending after a trailing embed grows a fresh run, not the embed's", () => {
  const doc = simpleDocument("a￼");
  doc.attributeRuns = [
    create(AttributeRunSchema, { length: 1 }),
    create(AttributeRunSchema, {
      length: 1,
      attachmentInfo: { attachmentIdentifier: "A-3", typeUTI: "com.apple.paper" },
    }),
  ];

  assert.equal(applyTextEdit(doc, "a￼ tail", { replicaId: REPLICA_A }), true);

  validateDocumentInvariants(doc);
  assert.equal(doc.attributeRuns[1]?.length, 1);
  assert.equal(doc.attributeRuns[1]?.attachmentInfo?.attachmentIdentifier, "A-3");
  assert.equal(doc.attributeRuns[2]?.length, 5);
  assert.equal(doc.attributeRuns[2]?.attachmentInfo, undefined);
  assert.equal(reencodeAndDecode(doc), "a￼ tail");
});
