import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFreshTableDocument } from "./tableEdit.js";
import { gridFromTableDocument, parseTableDocument, tableDocumentRoundTrips, encodeTableDocument } from "./decodeTableRecord.js";
import { nextGenerationStamp } from "./mergeableDataPool.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import type { Dictionary_Element } from "./gen/crdt_pb.js";
import { TABLE_FIRST_REVISION, TABLE_WRITE_PATH_REVISIONS } from "./realFixtures.js";

function rebuild(base64: string, desiredGrid: string[][]) {
  const doc = parseTableDocument(Buffer.from(base64, "base64"));
  buildFreshTableDocument(doc, desiredGrid);
  return doc;
}

function assertRoundTripsAndDecodesTo(doc: ReturnType<typeof parseTableDocument>, desiredGrid: string[][]) {
  assert.deepEqual(gridFromTableDocument(doc), desiredGrid);
  const encoded = encodeTableDocument(doc);
  assert.equal(tableDocumentRoundTrips(encoded), true);
  assert.deepEqual(gridFromTableDocument(parseTableDocument(encoded)), desiredGrid);
}

// --- hand-picked desired grids against a real fixture -----------------------

test("buildFreshTableDocument: grid unchanged still rebuilds cleanly (a no-op grid isn't special-cased)", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "B0"],
    ["", ""],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["A0", "B0"],
    ["", ""],
  ]);
});

test("buildFreshTableDocument: single cell edit", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "B0-edited"],
    ["", ""],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["A0", "B0-edited"],
    ["", ""],
  ]);
});

test("buildFreshTableDocument: row inserted at the start", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["NEW-A", "NEW-B"],
    ["A0", "B0"],
    ["", ""],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["NEW-A", "NEW-B"],
    ["A0", "B0"],
    ["", ""],
  ]);
});

test("buildFreshTableDocument: row inserted in the middle", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "B0"],
    ["MID-A", "MID-B"],
    ["", ""],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["A0", "B0"],
    ["MID-A", "MID-B"],
    ["", ""],
  ]);
});

test("buildFreshTableDocument: row appended at the end", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "B0"],
    ["", ""],
    ["NEW-A", "NEW-B"],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["A0", "B0"],
    ["", ""],
    ["NEW-A", "NEW-B"],
  ]);
});

test("buildFreshTableDocument: row deleted", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [["A0", "B0"]]);
  assertRoundTripsAndDecodesTo(doc, [["A0", "B0"]]);
});

test("buildFreshTableDocument: column inserted", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "NEW", "B0"],
    ["", "NEW", ""],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["A0", "NEW", "B0"],
    ["", "NEW", ""],
  ]);
});

test("buildFreshTableDocument: column deleted", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [["A0"], [""]]);
  assertRoundTripsAndDecodesTo(doc, [["A0"], [""]]);
});

test("buildFreshTableDocument: pure row reorder (refused by the old incremental write path) now just works", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["", ""],
    ["A0", "B0"],
  ]);
  assertRoundTripsAndDecodesTo(doc, [
    ["", ""],
    ["A0", "B0"],
  ]);
});

test("buildFreshTableDocument: refuses a grid with no columns", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  assert.throws(() => buildFreshTableDocument(doc, []), /no columns/);
});

test("buildFreshTableDocument: refuses a ragged grid (rows with different column counts)", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  assert.throws(() => buildFreshTableDocument(doc, [["A", "B"], ["C"]]), /same number of columns/);
});

// --- real fixtures as "current" state, across every mined transition -------

for (const revision of TABLE_WRITE_PATH_REVISIONS) {
  test(`buildFreshTableDocument reproduces real revision ${revision.tag}'s own grid when rebuilt toward itself`, () => {
    const doc = rebuild(revision.base64, gridFromTableDocument(parseTableDocument(Buffer.from(revision.base64, "base64"))));
    assertRoundTripsAndDecodesTo(doc, gridFromTableDocument(parseTableDocument(Buffer.from(revision.base64, "base64"))));
  });
}

// --- regression: the incident this rewrite exists to fix --------------------

test("regression: the FFFC ordering mirror's visible text length matches the attachments entry count for both rows and columns", () => {
  const doc = rebuild(TABLE_FIRST_REVISION, [
    ["A0", "B0", "C0"],
    ["A1", "B1", "C1"],
    ["A2", "B2", "C2"],
  ]);

  const rowsOrderedSet = doc.objects[doc.crRowsRef]?.tsOrderedSet;
  const columnsOrderedSet = doc.objects[doc.crColumnsRef]?.tsOrderedSet;
  assert.ok(rowsOrderedSet && columnsOrderedSet);

  const rowContents = rowsOrderedSet.array?.array?.contents?.string ?? "";
  const rowAttachments = rowsOrderedSet.array?.array?.attachments.length ?? -1;
  assert.equal(rowContents.length, rowAttachments);
  assert.equal([...rowContents].every((char) => char === OBJECT_REPLACEMENT_CHARACTER), true);
  assert.equal(rowAttachments, 3);

  const columnContents = columnsOrderedSet.array?.array?.contents?.string ?? "";
  const columnAttachments = columnsOrderedSet.array?.array?.attachments.length ?? -1;
  assert.equal(columnContents.length, columnAttachments);
  assert.equal([...columnContents].every((char) => char === OBJECT_REPLACEMENT_CHARACTER), true);
  assert.equal(columnAttachments, 3);
});

// --- regression: the generation-stamp mechanism found while planning this --

test("regression: every fresh Dictionary.Element carries a version-vector timestamp, and the document vector's leading clock advances", () => {
  const original = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  const expectedStamp = BigInt(nextGenerationStamp(original));

  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  buildFreshTableDocument(doc, [
    ["A0", "B0"],
    ["A1", "B1"],
  ]);

  // The vector's leading element carries the new running maximum.
  assert.equal(doc.version.element[0]?.clock, expectedStamp);
  assert.equal(doc.version.element.length > 1, true);

  const stampClockOf = (element: Dictionary_Element) => {
    assert.equal(element.timestamp?.element.length, 1);
    assert.equal(element.timestamp?.element[0]?.replicaIndex, 0n);
    assert.equal(element.timestamp?.element[0]?.subclock, 0n);
    return element.timestamp?.element[0]?.clock;
  };

  // cellColumns' own entries, every row-map entry, and both OrderedSets'
  // `set` entries all carry the same stamp.
  const cellColumnsDict = doc.objects[doc.cellColumnsRef]?.dictionary;
  assert.ok(cellColumnsDict && cellColumnsDict.element.length > 0);
  for (const element of cellColumnsDict.element) {
    assert.equal(stampClockOf(element), expectedStamp);
    const rowMapRef = element.value?.objectIndex;
    const rowMapDict = rowMapRef !== undefined ? doc.objects[rowMapRef]?.dictionary : undefined;
    assert.ok(rowMapDict && rowMapDict.element.length > 0);
    for (const rowElement of rowMapDict.element) {
      assert.equal(stampClockOf(rowElement), expectedStamp);
    }
  }

  const rowsElements = doc.objects[doc.crRowsRef]?.tsOrderedSet?.set?.element ?? [];
  const columnsElements = doc.objects[doc.crColumnsRef]?.tsOrderedSet?.set?.element ?? [];
  assert.ok(rowsElements.length > 0 && columnsElements.length > 0);
  for (const element of [...rowsElements, ...columnsElements]) {
    assert.equal(stampClockOf(element), expectedStamp);
  }
});

test("regression: a second rebuild advances the generation stamp past the first rebuild's", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  buildFreshTableDocument(doc, [
    ["A0", "B0"],
    ["", ""],
  ]);
  const firstStamp = doc.version.element[0]?.clock;

  buildFreshTableDocument(doc, [
    ["A0", "B0-again"],
    ["", ""],
  ]);
  const secondStamp = doc.version.element[0]?.clock;

  assert.ok(firstStamp !== undefined && secondStamp !== undefined);
  assert.ok(secondStamp > firstStamp);
});
