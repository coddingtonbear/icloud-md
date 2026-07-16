import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import { findMarkdownTableBlocks, gridFromTableDocument, parseTableDocument, renderMarkdownTable } from "./decodeTableRecord.js";
import { prepareTableAttachmentUpdate, reconstructBodyTextWithPlaceholders } from "./tablePushEdit.js";

// Real 2x2 table, second row still blank - same fixture used across the
// table test suite (decodeTableRecord.test.ts).
const TABLE_FIRST_REVISION =
  "eJzt1E9oFFccwPGZyWZ39iWNr5OahofQdgxJjHZdB5tDxUOTqKTEoJtNemghxHW0u2x2ZXdFI3opiBcPihRLyUULObVNm4stNFQwSslhD+k/Dy0UNNAiEimoB7H27SbVbLKhh1JP32GH3/x+7/d5895jd23D+fq2ZRvSUF/etoQtgvrZbDZUX+ptO6BabcNx3Vej/3KpoG06VtTUsUbHGh1rdbR1DOr4gqoXQgRKM+vMUq+nNtumarMtZ6P7WncsPnIg7Xdn00dHMz3JnJ8oJLOZPv9QIZ6NJQ+/X1A/mx+Y35tiwhQnRJ8TXPj2G/1RsjxhaeHl2G6WK6auWKoc2y3VJGw99kRf63Tf0+cOyzZLt/OS3p7cOhuev3dhr3F5z0yxMXq+S1dNR16fbL6/M198PD98LRG5dHXKaReOsKKlbQXU02Mq10K6FnxWW9ZZW6Uz9Kym6lPCtvQhBRxLmhWZVZHVVGSB//tE7vRfnPbnHtxtGZ+9NTbUsLB4Ilc2dY7sOntj/5mBybbQw9S2pX0Kvafwin3W61rdqhMpdYoqnfVrnEhtRRasyEIVma06vMV31On5Gla8I6xrLy57xz+9pa/muhW9eraoXNa7O9bjWG9F/+PZWioS2+IYVWZZw1Ss0amyxsaVa+x67mt07eRBP1NIFsbcpkSu2o/YDeT99CE3mMjFssfybnhwsLenN3PQP+6GE7nF3rxbl/DT6aWk4+VEdjQycuRI2o90x3rikf6B/qOjB/xclYGBQi6ZOdyxftVA6S3L+zPZgp+PLP3NrB7o7V5jAIFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAVApPnmycaYlt/u6jYzt+/OlU17vvePLED198dfOT7WO/zQ21npuO/uHJ65PN93fmi4/nh68lIpeuTnnSP9V2OvDhGxOfnpt69PFfG+Ke3Dobnr93Ya9xec9MsTF6vsuTEyd794nxz4Y7fy/KP9XufZ68sqlzZNfZG/vPDEy2hR6mtnnyvdZXZFPdo19v/mLEPo8PbvTknf6L0/7cg7st47O3xoYaFt7cIJRYtUrHsi19m38DuMWS1w==";

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

// --- reconstructBodyTextWithPlaceholders ------------------------------------

test("reconstructBodyTextWithPlaceholders replaces a single table block with the placeholder character", () => {
  const table = renderMarkdownTable([["A", "B"]]);
  const localText = ["Intro line.", table, "Outro line."].join("\n");
  const blocks = findMarkdownTableBlocks(localText);
  const reconstructed = reconstructBodyTextWithPlaceholders(localText, blocks);
  assert.equal(reconstructed, ["Intro line.", OBJECT_REPLACEMENT_CHARACTER, "Outro line."].join("\n"));
});

test("reconstructBodyTextWithPlaceholders handles multiple table blocks, in document order", () => {
  const first = renderMarkdownTable([["First"]]);
  const second = renderMarkdownTable([["Second", "Table"]]);
  const localText = ["Intro", first, "Middle", second, "Outro"].join("\n");
  const blocks = findMarkdownTableBlocks(localText);
  assert.equal(blocks.length, 2);
  const reconstructed = reconstructBodyTextWithPlaceholders(localText, blocks);
  assert.equal(
    reconstructed,
    ["Intro", OBJECT_REPLACEMENT_CHARACTER, "Middle", OBJECT_REPLACEMENT_CHARACTER, "Outro"].join("\n"),
  );
});

test("reconstructBodyTextWithPlaceholders round-trips with no surrounding prose at all", () => {
  const table = renderMarkdownTable([["Only", "Content"]]);
  const blocks = findMarkdownTableBlocks(table);
  assert.equal(reconstructBodyTextWithPlaceholders(table, blocks), OBJECT_REPLACEMENT_CHARACTER);
});

// --- prepareTableAttachmentUpdate --------------------------------------------

test("prepareTableAttachmentUpdate: unchanged grid resolves to a no-op, unchanged bytes", () => {
  const record = noteRecordName();
  const currentGrid = gridFromTableDocument(parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64")));
  const result = prepareTableAttachmentUpdate(record, currentGrid);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, false);
    assert.equal(result.mergeableDataBase64, TABLE_FIRST_REVISION);
  }
});

test("prepareTableAttachmentUpdate: a cell edit produces a new document that decodes to exactly the desired grid", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0-edited", "B0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.changed, true);
    const rebuilt = parseTableDocument(Buffer.from(result.mergeableDataBase64, "base64"));
    assert.deepEqual(gridFromTableDocument(rebuilt), desiredGrid);
  }
});

test("prepareTableAttachmentUpdate: refuses a row insertion - structural edits are disabled after the 2026-07-15 incident", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0", "B0"],
    ["", ""],
    ["NEW", "ROW"],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /temporarily disabled/);
  }
});

test("prepareTableAttachmentUpdate: refuses a row deletion - structural edits are disabled after the 2026-07-15 incident", () => {
  const record = noteRecordName();
  const result = prepareTableAttachmentUpdate(record, [["A0", "B0"]]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /temporarily disabled/);
  }
});

test("prepareTableAttachmentUpdate: refuses a column insertion - structural edits are disabled after the 2026-07-15 incident", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0", "B0", "NEW"],
    ["", "", "COL"],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /temporarily disabled/);
  }
});

test("prepareTableAttachmentUpdate: refuses a column deletion - structural edits are disabled after the 2026-07-15 incident", () => {
  const record = noteRecordName();
  const result = prepareTableAttachmentUpdate(record, [["A0"], [""]]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /temporarily disabled/);
  }
});

test("prepareTableAttachmentUpdate: cell text edits still work - structural-edit gate doesn't affect them", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0-edited", "B0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, true);
  if (result.ok) {
    const rebuilt = parseTableDocument(Buffer.from(result.mergeableDataBase64, "base64"));
    assert.deepEqual(gridFromTableDocument(rebuilt), desiredGrid);
  }
});

test("prepareTableAttachmentUpdate: refuses a pure reorder rather than guessing", () => {
  const record = noteRecordName();
  // Same 2 columns, swapped - a pure reorder with nothing added or removed.
  const desiredGrid = [
    ["B0", "A0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
});

test("prepareTableAttachmentUpdate: refuses a record with no readable MergeableDataEncrypted field", () => {
  const record = noteRecordName({ fields: {} });
  const result = prepareTableAttachmentUpdate(record, [["A"]]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no readable data/);
  }
});

test("prepareTableAttachmentUpdate: refuses a record whose bytes don't decompress/round-trip", () => {
  const record = noteRecordName({
    fields: { MergeableDataEncrypted: { value: Buffer.from("not a real table").toString("base64"), type: "ENCRYPTED_BYTES" } },
  });
  const result = prepareTableAttachmentUpdate(record, [["A"]]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /round-trip/);
  }
});
