import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { NoteSchema } from "./gen/notestore_pb.js";
import {
  applyCellTextEdit,
  encodeCellDocument,
  newCellDocument,
  parseCellDocument,
  validateCellInvariants,
  type TableCellDocument,
} from "./tableCellEdit.js";

/**
 * A real cell-text object (text "A1", 7 `text_run`s including 3 tombstoned)
 * extracted from the committed `TABLE_FINAL_REVISION` table fixture
 * (`decodeTableRecord.test.ts`) at grid position [row 1, col 0] - the best
 * stress case for tombstone-splitting per the write-path plan. Re-extract
 * via `toBinary(NoteSchema, doc.objects[resolveTable(doc).cells.get("1,0").textRef].note)`
 * against that same fixture if this ever needs regenerating.
 */
const REAL_MULTI_TOMBSTONE_A1_CELL =
  "EgJBMRoQCgQIABAAEAAaBAgAEAAoARoQCgQIARAuEAEaBAgBEAAoAhoSCgQIARAvEAEaBAgBEAAgASgDGhIKBAgBEAIQAhoECAEQCSABKAQaEgoECAEQMBADGgQIARAAIAEoBRoQCgQIARAzEAEaBAgBEAAoBhoWCggIABD/////DxAAGggIABD/////DyoCCAI=";

function loadRealCell(): TableCellDocument {
  return parseCellDocument(fromBinary(NoteSchema, Buffer.from(REAL_MULTI_TOMBSTONE_A1_CELL, "base64")));
}

test("parseCellDocument/encodeCellDocument round-trips the real multi-tombstone cell byte-for-byte", () => {
  const raw = Buffer.from(REAL_MULTI_TOMBSTONE_A1_CELL, "base64");
  const note = fromBinary(NoteSchema, raw);
  const cell = parseCellDocument(note);
  assert.equal(cell.text, "A1");
  assert.equal(cell.runs.length, 7);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
  const reencoded = toBinary(NoteSchema, encodeCellDocument(cell));
  assert.deepEqual(reencoded, new Uint8Array(raw));
});

test("newCellDocument for empty text matches the real captured brand-new-empty-cell shape: origin + end sentinel only", () => {
  const cell = newCellDocument("");
  assert.equal(cell.text, "");
  assert.equal(cell.runs.length, 2);
  assert.deepEqual(cell.runs[0]?.sequence, [1]);
  assert.equal(cell.runs[0]?.length, 0);
  assert.equal(cell.runs[1]?.coord.clock, 0xffffffff);
  assert.deepEqual(cell.attributeRuns, []);
  validateCellInvariants(cell);
});

test("newCellDocument for non-empty text matches the real captured brand-new-cell shape: origin, one full run, end sentinel", () => {
  const cell = newCellDocument("hello");
  assert.equal(cell.text, "hello");
  assert.equal(cell.runs.length, 3);
  assert.equal(cell.runs[1]?.length, 5);
  assert.equal(cell.runs[1]?.coord.replica, 1);
  assert.equal(cell.runs[1]?.coord.clock, 0);
  assert.deepEqual(
    cell.attributeRuns.map((run) => run.length),
    [5],
  );
  validateCellInvariants(cell);
});

test("applyCellTextEdit returns false and changes nothing when the text is unchanged", () => {
  const cell = newCellDocument("same");
  const before = JSON.stringify(cell);
  assert.equal(applyCellTextEdit(cell, "same"), false);
  assert.equal(JSON.stringify(cell), before);
});

test("applyCellTextEdit gives a brand-new empty cell its first text", () => {
  const cell = newCellDocument("");
  assert.equal(applyCellTextEdit(cell, "hi"), true);
  assert.equal(cell.text, "hi");
  validateCellInvariants(cell);
});

test("applyCellTextEdit splits a run when editing in the middle of existing text", () => {
  const cell = newCellDocument("abcdef");
  applyCellTextEdit(cell, "abcXYZdef");
  assert.equal(cell.text, "abcXYZdef");
  validateCellInvariants(cell);
});

test("applyCellTextEdit fully deletes a cell's text, tombstoning the removed range", () => {
  const cell = newCellDocument("gone");
  applyCellTextEdit(cell, "");
  assert.equal(cell.text, "");
  validateCellInvariants(cell);
  assert.equal(
    cell.runs.some((run) => run.tombstone),
    true,
  );
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: appending preserves its prior tombstone history", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "A1-edited");
  assert.equal(cell.text, "A1-edited");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: deleting everything tombstones the visible run(s) too", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "");
  assert.equal(cell.text, "");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length > 3, true);
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: mid-text edit splits without disturbing tombstoned runs", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "AX1");
  assert.equal(cell.text, "AX1");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
});

test("applyCellTextEdit renumbers sequences 1..N in list order after an edit, leaving sentinels alone", () => {
  const cell = newCellDocument("ab");
  applyCellTextEdit(cell, "abc");
  const nonSentinelSequences = cell.runs.filter((run) => run.coord.clock !== 0xffffffff).map((run) => run.sequence[0]);
  assert.deepEqual(
    nonSentinelSequences,
    nonSentinelSequences.map((_, i) => i + 1),
  );
});

test("validateCellInvariants throws when visible run lengths don't match the text", () => {
  const cell = newCellDocument("hello");
  cell.text = "hello world";
  assert.throws(() => validateCellInvariants(cell), /visible run lengths/);
});

test("validateCellInvariants throws when attribute run lengths don't match the text", () => {
  const cell = newCellDocument("hello");
  cell.attributeRuns = [];
  assert.throws(() => validateCellInvariants(cell), /attribute run lengths/);
});
