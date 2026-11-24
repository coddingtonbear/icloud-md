import test from "node:test";
import assert from "node:assert/strict";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { applyTextEdit, encodeNoteDocument, noteDocumentRoundTrips, parseNoteDocument } from "./noteDocument.js";
import { CharIDSchema, StringSchema, SubstringSchema, VectorTimestampSchema, VectorTimestamp_ClockSchema, VectorTimestamp_Clock_ReplicaClockSchema, AttributeRunSchema } from "./gen/topotext_pb.js";
import { DocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";

const HIGH = new Uint8Array(16).fill(0x99), LOW = new Uint8Array(16).fill(0x40);
const hex = (id: Uint8Array) => Buffer.from(id).toString("hex");
// Public synthetic wire fixture, independent of the domain encoder. Its clock
// messages are HIGH then LOW; the drawing uses HIGH rank 2 / LOW style rank 1.
const UNSORTED_GOLDEN = Uint8Array.from(Buffer.from("0800128501080010001a7f1203efbfbc1a100a040800100010001a040800100028011a100a040802100010011a040801100228021a160a08080010ffffffff0f10001a08080010ffffffff0f22380a1a0a109999999999999999999999999999999912020801120208020a1a0a104040404040404040404040404040404012020801120208032a020801", "hex"));
function archive() {
  // Deliberately unsorted clock rows. Apple resolves CharID indexes against
  // sorted UUID rank, independently of the order of these clock messages.
  return create(StringSchema, {
    string: "\uFFFC",
    timestamp: create(VectorTimestampSchema, { clock: [HIGH, LOW].map((id, index) => create(VectorTimestamp_ClockSchema, {
      replicaUUID: id, replicaClock: [1, index + 2].map(clock => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock })),
    })) }),
    substring: [
      create(SubstringSchema, { charID: create(CharIDSchema, { replicaID: 0, clock: 0 }), length: 0, timestamp: create(CharIDSchema, { replicaID: 0, clock: 0 }), child: [1] }),
      create(SubstringSchema, { charID: create(CharIDSchema, { replicaID: 2, clock: 0 }), length: 1, timestamp: create(CharIDSchema, { replicaID: 1, clock: 2 }), child: [2] }),
      create(SubstringSchema, { charID: create(CharIDSchema, { replicaID: 0, clock: 0xffffffff }), length: 0, timestamp: create(CharIDSchema, { replicaID: 0, clock: 0xffffffff }) }),
    ],
    attributeRun: [create(AttributeRunSchema, { length: 1 })],
  });
}
function wrap(str: ReturnType<typeof archive>) {
  return toBinary(DocumentSchema, create(DocumentSchema, { serializationVersion: 0, version: [create(VersionSchema, { serializationVersion: 0, minimumSupportedVersion: 0, data: toBinary(StringSchema, str) })] }));
}
function wire(raw: Uint8Array) { return fromBinary(StringSchema, fromBinary(DocumentSchema, raw).version[0]!.data); }
// Independent native-compatible interpretation: never use parseNoteDocument's
// domain table indexing to verify emitted character or style identities.
function wireIdentity(raw: Uint8Array) {
  const str = wire(raw), sorted = str.timestamp!.clock.map(row => row.replicaUUID).sort(Buffer.compare);
  const id = (rank: number) => rank === 0 ? "zero" : hex(sorted[rank - 1]!);
  return str.substring.map(run => ({ id: id(run.charID!.replicaID), clock: run.charID!.clock, anchor: id(run.timestamp!.replicaID), anchorClock: run.timestamp!.clock, tombstone: run.tombstone === 1 }));
}

test("unsorted clock archive translates wire UUID ranks into domain rows and round-trips exactly", () => {
  const raw = UNSORTED_GOLDEN, doc = parseNoteDocument(raw);
  assert.deepEqual(wrap(archive()), raw);
  assert.deepEqual(doc.replicas.map(row => hex(row.id)), [hex(HIGH), hex(LOW)]);
  assert.equal(doc.runs[1]!.coord.replica, 1, "rank 2 denotes HIGH at archive row 1");
  assert.equal(doc.runs[1]!.anchor.replica, 2, "rank 1 denotes LOW at archive row 2");
  assert.deepEqual(encodeNoteDocument(doc), raw);
  assert.equal(noteDocumentRoundTrips(raw), true);
});

test("encoder emits sorted UUID ranks for both coordinates and style anchors without mutating domain rows", () => {
  const doc = parseNoteDocument(wrap(archive()));
  doc.runs[1]!.coord.replica = 1; doc.runs[1]!.anchor.replica = 2;
  // structuredClone discards protobuf message prototypes; Node 20 correctly
  // distinguishes those objects even before encoding. Preserve schema identity.
  const before = { ...structuredClone(doc), attributeRuns: doc.attributeRuns.map(run => clone(AttributeRunSchema, run)) };
  const encoded = encodeNoteDocument(doc), content = wire(encoded).substring[1]!;
  assert.equal(content.charID!.replicaID, 2); assert.equal(content.timestamp!.replicaID, 1);
  assert.deepEqual(doc, before);
});

test("lower UUID insertion then deletion preserves original wire identity and tombstones only the new UUID", () => {
  const single = archive(); single.timestamp!.clock = [single.timestamp!.clock[0]!];
  single.substring[1]!.charID!.replicaID = 1; single.substring[1]!.timestamp!.replicaID = 1;
  const original = wrap(single), doc = parseNoteDocument(original);
  assert.equal(applyTextEdit(doc, "\uFFFCx", { replicaId: LOW }), true);
  assert.equal(applyTextEdit(doc, "\uFFFC", { replicaId: LOW }), true);
  const encoded = encodeNoteDocument(doc), identities = wireIdentity(encoded);
  assert.deepEqual(identities[1], wireIdentity(original)[1]);
  assert.equal(identities[2]!.id, hex(LOW)); assert.equal(identities[2]!.anchor, hex(LOW)); assert.equal(identities[2]!.tombstone, true);
  assert.equal(wire(encoded).string, "\uFFFC");
  assert.deepEqual(parseNoteDocument(encoded), doc);
});

for (const field of ["charID", "timestamp"] as const) test(`unknown wire ${field} UUID rank is refused`, () => {
  const str = archive(); str.substring[1]![field]!.replicaID = 3;
  assert.throws(() => parseNoteDocument(wrap(str)), /replica/i);
  assert.equal(noteDocumentRoundTrips(wrap(str)), false);
});
for (const field of ["coord", "anchor"] as const) test(`unknown domain ${field} replica row is refused`, () => {
  const doc = parseNoteDocument(wrap(archive())); doc.runs[1]![field].replica = 3;
  assert.throws(() => encodeNoteDocument(doc), /replica/i);
});
test("duplicate replica UUIDs are refused by parser and encoder", () => {
  const str = archive(); str.timestamp!.clock[1]!.replicaUUID = HIGH;
  assert.throws(() => parseNoteDocument(wrap(str)), /replica/i);
  const doc = parseNoteDocument(wrap(archive())); doc.replicas[1]!.id = HIGH;
  assert.throws(() => encodeNoteDocument(doc), /replica/i);
});
