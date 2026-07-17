import { test } from "node:test";
import assert from "node:assert/strict";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { StringSchema } from "./gen/topotext_pb.js";
import {
  applyCellTextEdit,
  encodeCellDocument,
  newCellDocument,
  parseCellDocument,
  validateCellInvariants,
  type TableCellDocument,
  type TopotextClockSource,
} from "./tableCellEdit.js";

/**
 * A real cell-text object (text "A1", 7 `substring` runs including 3
 * tombstoned) extracted from the committed `TABLE_FINAL_REVISION` table
 * fixture (`decodeTableRecord.test.ts`) at grid position [row 1, col 0] -
 * the best stress case for tombstone-splitting per the write-path plan.
 * Re-extract via
 * `toBinary(StringSchema, doc.objects[resolveTable(doc).cells.get("1,0").textRef].string)`
 * against that same fixture if this ever needs regenerating.
 */
const REAL_MULTI_TOMBSTONE_A1_CELL =
  "EgJBMRoQCgQIABAAEAAaBAgAEAAoARoQCgQIARAuEAEaBAgBEAAoAhoSCgQIARAvEAEaBAgBEAAgASgDGhIKBAgBEAIQAhoECAEQCSABKAQaEgoECAEQMBADGgQIARAAIAEoBRoQCgQIARAzEAEaBAgBEAAoBhoWCggIABD/////DxAAGggIABD/////DyoCCAI=";

function loadRealCell(): TableCellDocument {
  return parseCellDocument(fromBinary(StringSchema, Buffer.from(REAL_MULTI_TOMBSTONE_A1_CELL, "base64")));
}

/** A standalone document-global clock, the shape `tableEdit.ts`'s write
 * session provides in production - replica 1, counting from `start`. */
function testClock(start = 0): TopotextClockSource & { readonly value: number } {
  let counter = start;
  return {
    replicaIndex: 1,
    take(units: number): number {
      const value = counter;
      counter += units;
      return value;
    },
    get value() {
      return counter;
    },
  };
}

function filledCell(text: string, clock: TopotextClockSource = testClock()): TableCellDocument {
  const cell = newCellDocument();
  if (text.length > 0) {
    applyCellTextEdit(cell, text, clock);
  }
  return cell;
}

test("parseCellDocument/encodeCellDocument round-trips the real multi-tombstone cell byte-for-byte", () => {
  const raw = Buffer.from(REAL_MULTI_TOMBSTONE_A1_CELL, "base64");
  const str = fromBinary(StringSchema, raw);
  const cell = parseCellDocument(str);
  assert.equal(cell.text, "A1");
  assert.equal(cell.runs.length, 7);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
  const reencoded = toBinary(StringSchema, encodeCellDocument(cell));
  assert.deepEqual(reencoded, new Uint8Array(raw));
});

test("newCellDocument matches the real captured brand-new-empty-cell shape: origin + end sentinel only", () => {
  const cell = newCellDocument();
  assert.equal(cell.text, "");
  assert.equal(cell.runs.length, 2);
  assert.deepEqual(cell.runs[0]?.sequence, [1]);
  assert.equal(cell.runs[0]?.length, 0);
  assert.equal(cell.runs[1]?.coord.clock, 0xffffffff);
  assert.deepEqual(cell.attributeRuns, []);
  validateCellInvariants(cell);
});

test("first fill matches the real captured freshly-filled-cell shape: origin, one full run under the shared clock, end sentinel", () => {
  const clock = testClock(13); // mid-session, like the real "berry-r1c2" fill at clock 13
  const cell = filledCell("hello", clock);
  assert.equal(cell.text, "hello");
  assert.equal(cell.runs.length, 3);
  assert.equal(cell.runs[1]?.length, 5);
  assert.equal(cell.runs[1]?.coord.replica, 1);
  assert.equal(cell.runs[1]?.coord.clock, 13);
  assert.deepEqual(cell.runs[1]?.anchor, { replica: 1, clock: 0 });
  assert.deepEqual(
    cell.attributeRuns.map((run) => run.length),
    [5],
  );
  assert.equal(clock.value, 18);
  validateCellInvariants(cell);
});

test("clocks are drawn from the shared document-global sequence: two cells filled in one session never overlap", () => {
  const clock = testClock();
  const first = filledCell("abcde", clock);
  const second = filledCell("xyz", clock);
  assert.equal(first.runs[1]?.coord.clock, 0);
  assert.equal(second.runs[1]?.coord.clock, 5);
  assert.equal(clock.value, 8);
});

test("applyCellTextEdit returns false and changes nothing when the text is unchanged", () => {
  const clock = testClock();
  const cell = filledCell("same", clock);
  const before = JSON.stringify(cell);
  const counterBefore = clock.value;
  assert.equal(applyCellTextEdit(cell, "same", clock), false);
  assert.equal(JSON.stringify(cell), before);
  assert.equal(clock.value, counterBefore);
});

test("applyCellTextEdit gives a brand-new empty cell its first text", () => {
  const cell = newCellDocument();
  assert.equal(applyCellTextEdit(cell, "hi", testClock()), true);
  assert.equal(cell.text, "hi");
  validateCellInvariants(cell);
});

test("applyCellTextEdit splits a run when editing in the middle of existing text", () => {
  const clock = testClock();
  const cell = filledCell("abcdef", clock);
  applyCellTextEdit(cell, "abcXYZdef", clock);
  assert.equal(cell.text, "abcXYZdef");
  validateCellInvariants(cell);
});

test("applyCellTextEdit fully deletes a cell's text, tombstoning the removed range without touching the clock", () => {
  const clock = testClock();
  const cell = filledCell("gone", clock);
  const counterBefore = clock.value;
  applyCellTextEdit(cell, "", clock);
  assert.equal(cell.text, "");
  validateCellInvariants(cell);
  assert.equal(
    cell.runs.some((run) => run.tombstone),
    true,
  );
  assert.equal(clock.value, counterBefore);
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: appending preserves its prior tombstone history", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "A1-edited", testClock(100));
  assert.equal(cell.text, "A1-edited");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: deleting everything tombstones the visible run(s) too", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "", testClock(100));
  assert.equal(cell.text, "");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length > 3, true);
});

test("applyCellTextEdit on the real multi-tombstone A1 cell: mid-text edit splits without disturbing tombstoned runs", () => {
  const cell = loadRealCell();
  applyCellTextEdit(cell, "AX1", testClock(100));
  assert.equal(cell.text, "AX1");
  validateCellInvariants(cell);
  assert.equal(cell.runs.filter((run) => run.tombstone).length, 3);
});

test("applyCellTextEdit renumbers sequences 1..N in list order after an edit, leaving sentinels alone", () => {
  const clock = testClock();
  const cell = filledCell("ab", clock);
  applyCellTextEdit(cell, "abc", clock);
  const nonSentinelSequences = cell.runs.filter((run) => run.coord.clock !== 0xffffffff).map((run) => run.sequence[0]);
  assert.deepEqual(
    nonSentinelSequences,
    nonSentinelSequences.map((_, i) => i + 1),
  );
});

test("validateCellInvariants throws when visible run lengths don't match the text", () => {
  const cell = filledCell("hello");
  cell.text = "hello world";
  assert.throws(() => validateCellInvariants(cell), /visible run lengths/);
});

test("validateCellInvariants throws when attribute run lengths don't match the text", () => {
  const cell = filledCell("hello");
  cell.attributeRuns = [];
  assert.throws(() => validateCellInvariants(cell), /attribute run lengths/);
});
