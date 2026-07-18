import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { gridFromTableDocument, parseTableDocument, tableDocumentRoundTrips } from "./decodeTableRecord.js";
import { validateTableDocumentInvariants } from "./tableEdit.js";
import { prepareTableAttachmentUpdate } from "./tablePushEdit.js";
import { TABLE_FIRST_REVISION } from "./realFixtures.js";

const OUR_REPLICA = new Uint8Array(Array.from({ length: 16 }, (_, i) => 0xb0 + i));

function noteRecordName(record: Partial<CloudKitRecord> = {}): CloudKitRecord {
  return {
    recordName: "attachment-1",
    recordType: "Attachment",
    recordChangeTag: "tag-1",
    fields: {
      MergeableDataEncrypted: { value: TABLE_FIRST_REVISION, type: "ENCRYPTED_BYTES" },
    },
    ...record,
  };
}

/** Asserts a successful write result and returns its decoded document,
 * after re-running the round-trip and invariant gates on the returned
 * bytes - the exact bytes `push` would send to CloudKit. */
function expectWritten(result: ReturnType<typeof prepareTableAttachmentUpdate>, desiredGrid: string[][]) {
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  assert.equal(result.changed, true);
  const compressed = Buffer.from(result.mergeableDataBase64, "base64");
  assert.equal(tableDocumentRoundTrips(compressed), true);
  const doc = parseTableDocument(compressed);
  assert.deepEqual(gridFromTableDocument(doc), desiredGrid);
  validateTableDocumentInvariants(doc);
  return doc;
}

// --- prepareTableAttachmentUpdate --------------------------------------------

test("prepareTableAttachmentUpdate: unchanged grid resolves to a no-op, unchanged bytes", () => {
  const record = noteRecordName();
  const currentGrid = gridFromTableDocument(parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64")));
  const result = prepareTableAttachmentUpdate(record, currentGrid, OUR_REPLICA);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, false);
    assert.equal(result.mergeableDataBase64, TABLE_FIRST_REVISION);
  }
});

test("prepareTableAttachmentUpdate: a cell edit produces new, gate-passing bytes", () => {
  const desiredGrid = [
    ["A0", "B0-edited"],
    ["", ""],
  ];
  expectWritten(prepareTableAttachmentUpdate(noteRecordName(), desiredGrid, OUR_REPLICA), desiredGrid);
});

test("prepareTableAttachmentUpdate: a row insertion is written", () => {
  const desiredGrid = [
    ["A0", "B0"],
    ["", ""],
    ["NEW", "ROW"],
  ];
  expectWritten(prepareTableAttachmentUpdate(noteRecordName(), desiredGrid, OUR_REPLICA), desiredGrid);
});

test("prepareTableAttachmentUpdate: a row deletion is written", () => {
  const desiredGrid = [["A0", "B0"]];
  expectWritten(prepareTableAttachmentUpdate(noteRecordName(), desiredGrid, OUR_REPLICA), desiredGrid);
});

test("prepareTableAttachmentUpdate: a column insertion is written", () => {
  const desiredGrid = [
    ["A0", "B0", "NEW"],
    ["", "", "COL"],
  ];
  expectWritten(prepareTableAttachmentUpdate(noteRecordName(), desiredGrid, OUR_REPLICA), desiredGrid);
});

test("prepareTableAttachmentUpdate: a column deletion is written", () => {
  const desiredGrid = [["A0"], [""]];
  expectWritten(prepareTableAttachmentUpdate(noteRecordName(), desiredGrid, OUR_REPLICA), desiredGrid);
});

test("prepareTableAttachmentUpdate: a pure reorder is still refused - the diff can't express it as one edit", () => {
  const record = noteRecordName();
  // Same 2 columns, swapped - a pure reorder with nothing added or removed.
  const desiredGrid = [
    ["B0", "A0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid, OUR_REPLICA);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /reordered/);
  }
});

test("prepareTableAttachmentUpdate: changing both axes at once is refused with the diff's reason", () => {
  const record = noteRecordName();
  const result = prepareTableAttachmentUpdate(record, [["one", "two", "three"]], OUR_REPLICA);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /both row and column counts changed/);
  }
});

test("prepareTableAttachmentUpdate: refuses a record with no readable MergeableDataEncrypted field", () => {
  const record = noteRecordName({ fields: {} });
  const result = prepareTableAttachmentUpdate(record, [["A"]], OUR_REPLICA);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no readable data/);
  }
});

test("prepareTableAttachmentUpdate: refuses a record whose bytes don't decompress/round-trip", () => {
  const record = noteRecordName({
    fields: { MergeableDataEncrypted: { value: Buffer.from("not a real table").toString("base64"), type: "ENCRYPTED_BYTES" } },
  });
  const result = prepareTableAttachmentUpdate(record, [["A"]], OUR_REPLICA);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /round-trip/);
  }
});
