import { test } from "node:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import {
  DictionaryElementSchema,
  DictionarySchema,
  MapEntrySchema,
  MergableDataObjectSchema,
  MergableDataProtoSchema,
  MergeableDataObjectDataSchema,
  MergeableDataObjectEntrySchema,
  MergeableDataObjectMapSchema,
  NoteSchema,
  ObjectIDSchema,
  OrderedSetOrderingArraySchema,
  OrderedSetOrderingSchema,
  OrderedSetSchema,
  type MergeableDataObjectEntry,
} from "./gen/notestore_pb.js";
import type { TableDocument } from "./decodeTableRecord.js";
import { applyTableEdit, compactPool, deleteRowAt, diffTableGrid, insertColumnAt, insertRowAt, type TableEditPlan } from "./tableEdit.js";
import { gridFromTableDocument, parseTableDocument } from "./decodeTableRecord.js";

// --- diffTableGrid classification -------------------------------------------

test("diffTableGrid: identical grids is a noop", () => {
  const grid = [
    ["A", "B"],
    ["C", "D"],
  ];
  assert.deepEqual(diffTableGrid(grid, grid), { kind: "noop" });
});

test("diffTableGrid: same shape, one cell differs, is a cell edit", () => {
  const current = [
    ["A", "B"],
    ["C", "D"],
  ];
  const desired = [
    ["A", "B"],
    ["C", "D-edited"],
  ];
  const plan = diffTableGrid(current, desired);
  assert.deepEqual(plan, { kind: "cellEdits", edits: [{ row: 1, column: 1, text: "D-edited" }] });
});

test("diffTableGrid: same shape, multiple cells differ, all reported", () => {
  const current = [["A", "B"]];
  const desired = [["A2", "B2"]];
  const plan = diffTableGrid(current, desired);
  assert.equal(plan.kind, "cellEdits");
  if (plan.kind === "cellEdits") {
    assert.equal(plan.edits.length, 2);
  }
});

test("diffTableGrid: row appended at the end", () => {
  const current = [["A"], ["B"]];
  const desired = [["A"], ["B"], ["C"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "insertRows", position: 2, rows: [["C"]] });
});

test("diffTableGrid: row prepended at the start", () => {
  const current = [["A"], ["B"]];
  const desired = [["Z"], ["A"], ["B"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "insertRows", position: 0, rows: [["Z"]] });
});

test("diffTableGrid: row inserted in the middle", () => {
  const current = [["A"], ["B"]];
  const desired = [["A"], ["M"], ["B"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "insertRows", position: 1, rows: [["M"]] });
});

test("diffTableGrid: multiple contiguous rows inserted at once", () => {
  const current = [["A"], ["B"]];
  const desired = [["A"], ["M1"], ["M2"], ["B"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "insertRows", position: 1, rows: [["M1"], ["M2"]] });
});

test("diffTableGrid: row deleted from the start", () => {
  const current = [["A"], ["B"], ["C"]];
  const desired = [["B"], ["C"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "deleteRows", position: 0, count: 1 });
});

test("diffTableGrid: row deleted from the end", () => {
  const current = [["A"], ["B"], ["C"]];
  const desired = [["A"], ["B"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "deleteRows", position: 2, count: 1 });
});

test("diffTableGrid: row deleted from the middle", () => {
  const current = [["A"], ["B"], ["C"]];
  const desired = [["A"], ["C"]];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "deleteRows", position: 1, count: 1 });
});

test("diffTableGrid: column inserted in the middle", () => {
  const current = [
    ["A", "B"],
    ["C", "D"],
  ];
  const desired = [
    ["A", "M", "B"],
    ["C", "N", "D"],
  ];
  assert.deepEqual(diffTableGrid(current, desired), {
    kind: "insertColumns",
    position: 1,
    columns: [["M", "N"]],
  });
});

test("diffTableGrid: column deleted", () => {
  const current = [
    ["A", "B", "C"],
    ["D", "E", "F"],
  ];
  const desired = [
    ["A", "C"],
    ["D", "F"],
  ];
  assert.deepEqual(diffTableGrid(current, desired), { kind: "deleteColumns", position: 1, count: 1 });
});

test("diffTableGrid: both row and column counts changed is unsupported", () => {
  const current = [["A"]];
  const desired = [
    ["A", "B"],
    ["C", "D"],
  ];
  const plan = diffTableGrid(current, desired);
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: pure row reorder (same rows, different order) is unsupported", () => {
  const current = [["A"], ["B"], ["C"]];
  const desired = [["C"], ["A"], ["B"]];
  const plan = diffTableGrid(current, desired);
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: pure column reorder is unsupported", () => {
  const current = [
    ["A", "B"],
    ["C", "D"],
  ];
  const desired = [
    ["B", "A"],
    ["D", "C"],
  ];
  const plan = diffTableGrid(current, desired);
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: a structural change combined with an unrelated cell edit elsewhere is unsupported", () => {
  const current = [["A"], ["B"], ["C"]];
  // "B" deleted AND "C" (a row outside the deleted window) also edited to "C-edited"
  const desired = [["A"], ["C-edited"]];
  const plan = diffTableGrid(current, desired);
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: empty-to-empty grid stays a noop", () => {
  assert.deepEqual(diffTableGrid([], []), { kind: "noop" });
});

// --- compactPool (pool compaction / reference remapping) -------------------

/** A minimal but well-formed `TableDocument` wrapping `objects` directly (no
 * OrderedSet/dictionary semantics assumed) - `compactPool` only cares about
 * pool positions and `ObjectID.objectIndex` references, so a synthetic pool
 * built from raw message shapes is enough to test it independent of
 * table-specific parsing, per the write-path plan's verification section. */
function makeSyntheticDoc(objects: MergeableDataObjectEntry[], refs: { crRowsRef: number; crColumnsRef: number; cellColumnsRef: number }): TableDocument {
  const data = create(MergeableDataObjectDataSchema, {
    mergeableDataObjectEntry: objects,
    mergeableDataObjectKeyItem: [],
    mergeableDataObjectUuidItem: [],
  });
  const object = create(MergableDataObjectSchema, { version: 1, mergeableDataObjectData: data });
  const message = create(MergableDataProtoSchema, { mergableDataObject: object });
  return {
    message,
    objects: data.mergeableDataObjectEntry,
    keyNames: data.mergeableDataObjectKeyItem,
    uuidTable: data.mergeableDataObjectUuidItem,
    ...refs,
  };
}

function refTo(index: number) {
  return create(ObjectIDSchema, { objectIndex: index });
}

function plainNote(text: string): MergeableDataObjectEntry {
  return create(MergeableDataObjectEntrySchema, { note: create(NoteSchema, { noteText: text }) });
}

function dictionaryEntry(pairs: Array<{ key: number; value: number }>): MergeableDataObjectEntry {
  return create(MergeableDataObjectEntrySchema, {
    dictionary: create(DictionarySchema, {
      element: pairs.map((pair) => create(DictionaryElementSchema, { key: refTo(pair.key), value: refTo(pair.value) })),
    }),
  });
}

function customMapEntry(valueRef: number): MergeableDataObjectEntry {
  return create(MergeableDataObjectEntrySchema, {
    customMap: create(MergeableDataObjectMapSchema, { type: 2, mapEntry: [create(MapEntrySchema, { key: 0, value: refTo(valueRef) })] }),
  });
}

function orderedSetEntry(contentsPairs: Array<{ key: number; value: number }>, elementsPairs: Array<{ key: number; value: number }>): MergeableDataObjectEntry {
  return create(MergeableDataObjectEntrySchema, {
    orderedSet: create(OrderedSetSchema, {
      ordering: create(OrderedSetOrderingSchema, {
        array: create(OrderedSetOrderingArraySchema, { contents: create(NoteSchema, {}), attachment: [] }),
        contents: create(DictionarySchema, {
          element: contentsPairs.map((pair) => create(DictionaryElementSchema, { key: refTo(pair.key), value: refTo(pair.value) })),
        }),
      }),
      elements: create(DictionarySchema, {
        element: elementsPairs.map((pair) => create(DictionaryElementSchema, { key: refTo(pair.key), value: refTo(pair.value) })),
      }),
    }),
  });
}

test("compactPool: removing a middle pool index shifts every reference past it down by one", () => {
  // pool[0] dictionary -> {key: 1, value: 3}
  // pool[1] customMap -> 3
  // pool[2] plain note (about to be removed)
  // pool[3] plain note "target" (the thing everything points at)
  // pool[4] orderedSet: contents {key:1,value:3}, elements {key:3,value:3}
  const objects = [
    dictionaryEntry([{ key: 1, value: 3 }]),
    customMapEntry(3),
    plainNote("removed"),
    plainNote("target"),
    orderedSetEntry([{ key: 1, value: 3 }], [{ key: 3, value: 3 }]),
  ];
  const doc = makeSyntheticDoc(objects, { crRowsRef: 4, crColumnsRef: 1, cellColumnsRef: 0 });

  compactPool(doc, [2]);

  assert.equal(doc.objects.length, 4);
  // pool[0] (dictionary) is now pool[0] still (before the removed index); its refs to 1 and 3 -> 1 and 2
  const dict = doc.objects[0]?.dictionary;
  assert.equal(dict?.element[0]?.key?.objectIndex, 1);
  assert.equal(dict?.element[0]?.value?.objectIndex, 2);
  // pool[1] (customMap) -> ref to 3 becomes 2
  assert.equal(doc.objects[1]?.customMap?.mapEntry[0]?.value?.objectIndex, 2);
  // pool[2] (was pool[3], "target") is unaffected content-wise
  assert.equal(doc.objects[2]?.note?.noteText, "target");
  // pool[3] (was pool[4], orderedSet) refs remapped too
  const orderedSet = doc.objects[3]?.orderedSet;
  assert.equal(orderedSet?.ordering?.contents?.element[0]?.value?.objectIndex, 2);
  assert.equal(orderedSet?.elements?.element[0]?.key?.objectIndex, 2);
  assert.equal(orderedSet?.elements?.element[0]?.value?.objectIndex, 2);
  // the three cached top-level refs on `doc` itself are remapped too
  assert.equal(doc.crRowsRef, 3);
  assert.equal(doc.crColumnsRef, 1);
  assert.equal(doc.cellColumnsRef, 0);
});

test("compactPool: removing multiple indices at once compacts correctly regardless of order given", () => {
  const objects = [plainNote("keep0"), plainNote("gone1"), plainNote("keep2"), plainNote("gone3"), dictionaryEntry([{ key: 2, value: 2 }])];
  const doc = makeSyntheticDoc(objects, { crRowsRef: 0, crColumnsRef: 0, cellColumnsRef: 0 });

  compactPool(doc, [3, 1]);

  assert.equal(doc.objects.length, 3);
  assert.equal(doc.objects[0]?.note?.noteText, "keep0");
  assert.equal(doc.objects[1]?.note?.noteText, "keep2");
  const dict = doc.objects[2]?.dictionary;
  assert.equal(dict?.element[0]?.key?.objectIndex, 1);
  assert.equal(dict?.element[0]?.value?.objectIndex, 1);
});

test("compactPool: is a no-op when nothing is removed", () => {
  const objects = [plainNote("a"), plainNote("b")];
  const doc = makeSyntheticDoc(objects, { crRowsRef: 0, crColumnsRef: 1, cellColumnsRef: 0 });
  compactPool(doc, []);
  assert.equal(doc.objects.length, 2);
  assert.equal(doc.crRowsRef, 0);
});

test("compactPool: refuses rather than guess when a surviving object references a removed index", () => {
  const objects = [dictionaryEntry([{ key: 1, value: 1 }]), plainNote("about to be removed, but referenced above")];
  const doc = makeSyntheticDoc(objects, { crRowsRef: 0, crColumnsRef: 0, cellColumnsRef: 0 });
  assert.throws(() => compactPool(doc, [1]), /removed pool index/);
});

// --- insertRowAt / insertColumnAt against a real small fixture -------------

// Real 2x2 table, second row still blank - see decodeTableRecord.test.ts.
const TABLE_FIRST_REVISION =
  "eJzt1E9oFFccwPGZyWZ39iWNr5OahofQdgxJjHZdB5tDxUOTqKTEoJtNemghxHW0u2x2ZXdFI3opiBcPihRLyUULObVNm4stNFQwSslhD+k/Dy0UNNAiEimoB7H27SbVbLKhh1JP32GH3/x+7/d5895jd23D+fq2ZRvSUF/etoQtgvrZbDZUX+ptO6BabcNx3Vej/3KpoG06VtTUsUbHGh1rdbR1DOr4gqoXQgRKM+vMUq+nNtumarMtZ6P7WncsPnIg7Xdn00dHMz3JnJ8oJLOZPv9QIZ6NJQ+/X1A/mx+Y35tiwhQnRJ8TXPj2G/1RsjxhaeHl2G6WK6auWKoc2y3VJGw99kRf63Tf0+cOyzZLt/OS3p7cOhuev3dhr3F5z0yxMXq+S1dNR16fbL6/M198PD98LRG5dHXKaReOsKKlbQXU02Mq10K6FnxWW9ZZW6Uz9Kym6lPCtvQhBRxLmhWZVZHVVGSB//tE7vRfnPbnHtxtGZ+9NTbUsLB4Ilc2dY7sOntj/5mBybbQw9S2pX0Kvafwin3W61rdqhMpdYoqnfVrnEhtRRasyEIVma06vMV31On5Gla8I6xrLy57xz+9pa/muhW9eraoXNa7O9bjWG9F/+PZWioS2+IYVWZZw1Ss0amyxsaVa+x67mt07eRBP1NIFsbcpkSu2o/YDeT99CE3mMjFssfybnhwsLenN3PQP+6GE7nF3rxbl/DT6aWk4+VEdjQycuRI2o90x3rikf6B/qOjB/xclYGBQi6ZOdyxftVA6S3L+zPZgp+PLP3NrB7o7V5jAIFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAVApPnmycaYlt/u6jYzt+/OlU17vvePLED198dfOT7WO/zQ21npuO/uHJ65PN93fmi4/nh68lIpeuTnnSP9V2OvDhGxOfnpt69PFfG+Ke3Dobnr93Ya9xec9MsTF6vsuTEyd794nxz4Y7fy/KP9XufZ68sqlzZNfZG/vPDEy2hR6mtnnyvdZXZFPdo19v/mLEPo8PbvTknf6L0/7cg7st47O3xoYaFt7cIJRYtUrHsi19m38DuMWS1w==";

test("insertRowAt at position 0 (prepend) works on a real fixture", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  insertRowAt(doc, 0, ["NEW-A", "NEW-B"]);
  assert.deepEqual(gridFromTableDocument(doc), [
    ["NEW-A", "NEW-B"],
    ["A0", "B0"],
    ["", ""],
  ]);
});

test("insertRowAt at the end (append) works on a real fixture", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  insertRowAt(doc, 2, ["NEW-A", "NEW-B"]);
  assert.deepEqual(gridFromTableDocument(doc), [
    ["A0", "B0"],
    ["", ""],
    ["NEW-A", "NEW-B"],
  ]);
});

test("insertColumnAt at position 0 (prepend) works on a real fixture", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  insertColumnAt(doc, 0, ["NEW-0", "NEW-1"]);
  assert.deepEqual(gridFromTableDocument(doc), [
    ["NEW-0", "A0", "B0"],
    ["NEW-1", "", ""],
  ]);
});

test("insertColumnAt at the end (append) works on a real fixture", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  insertColumnAt(doc, 2, ["NEW-0", "NEW-1"]);
  assert.deepEqual(gridFromTableDocument(doc), [
    ["A0", "B0", "NEW-0"],
    ["", "", "NEW-1"],
  ]);
});

test("deleteRowAt down to a single row still leaves a valid, decodable table", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  deleteRowAt(doc, 1);
  assert.deepEqual(gridFromTableDocument(doc), [["A0", "B0"]]);
});

test("a multi-row insertion plan (pasting several new rows at once) applies correctly via applyTableEdit", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  const plan: TableEditPlan = { kind: "insertRows", position: 1, rows: [["X0", "X1"], ["Y0", "Y1"]] };
  applyTableEdit(doc, plan);
  assert.deepEqual(gridFromTableDocument(doc), [
    ["A0", "B0"],
    ["X0", "X1"],
    ["Y0", "Y1"],
    ["", ""],
  ]);
});
