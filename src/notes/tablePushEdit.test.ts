import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import { gridFromTableDocument, parseTableDocument } from "./decodeTableRecord.js";
import { findMarkdownTableBlocks, renderMarkdownTable } from "./markdownTable.js";
import { prepareTableAttachmentUpdate, reconstructBodyTextWithPlaceholders } from "./tablePushEdit.js";
import { TABLE_FIRST_REVISION } from "./realFixtures.js";

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

test("prepareTableAttachmentUpdate: a cell edit is refused, not written - table writes aren't safe yet", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0-edited", "B0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
});

test("prepareTableAttachmentUpdate: a row insertion is refused - structural edits aren't safe yet either", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0", "B0"],
    ["", ""],
    ["NEW", "ROW"],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
});

test("prepareTableAttachmentUpdate: a row deletion is refused", () => {
  const record = noteRecordName();
  const desiredGrid = [["A0", "B0"]];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
});

test("prepareTableAttachmentUpdate: a column insertion is refused", () => {
  const record = noteRecordName();
  const desiredGrid = [
    ["A0", "B0", "NEW"],
    ["", "", "COL"],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
});

test("prepareTableAttachmentUpdate: a column deletion is refused", () => {
  const record = noteRecordName();
  const desiredGrid = [["A0"], [""]];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
});

test("prepareTableAttachmentUpdate: a pure reorder is refused too - no edit kind is exempt", () => {
  const record = noteRecordName();
  // Same 2 columns, swapped - a pure reorder with nothing added or removed.
  const desiredGrid = [
    ["B0", "A0"],
    ["", ""],
  ];
  const result = prepareTableAttachmentUpdate(record, desiredGrid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /table writes aren't safe yet/);
  }
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
