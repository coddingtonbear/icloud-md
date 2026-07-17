import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTableEdit, diffTableGrid, validateTableDocumentInvariants } from "./tableEdit.js";
import {
  encodeTableDocument,
  gridFromTableDocument,
  parseOrderedSet,
  parseTableDocument,
  tableDocumentRoundTrips,
  uuidIndexOfRef,
  resolveRef,
  type TableDocument,
} from "./decodeTableRecord.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import {
  TABLE_EVOLUTION_REVISIONS,
  TABLE_FIRST_REVISION,
  TABLE_FINAL_REVISION,
  TABLE_LONG_LIVED_SNAPSHOTS,
  TABLE_UNSORTED_TT_REGRESSION,
  TABLE_WRITE_PATH_REVISIONS,
} from "./realFixtures.js";

/** A fixed 16-byte replica identity, standing in for the per-clone
 * `state.json` replicaId `push` uses. */
const OUR_REPLICA = new Uint8Array(Array.from({ length: 16 }, (_, i) => 0xa0 + i));

function parse(base64: string): TableDocument {
  return parseTableDocument(Buffer.from(base64, "base64"));
}

/** Applies `desiredGrid` and runs the full acceptance gauntlet: the edit
 * reports a change, the document decodes to exactly the desired grid,
 * passes every structural invariant, and its encoded bytes pass the
 * byte-for-byte round-trip gate and re-decode to the same grid. */
function editAndVerify(doc: TableDocument, desiredGrid: string[][]): TableDocument {
  assert.equal(applyTableEdit(doc, desiredGrid, OUR_REPLICA), true);
  assert.deepEqual(gridFromTableDocument(doc), desiredGrid);
  validateTableDocumentInvariants(doc);
  const encoded = encodeTableDocument(doc);
  assert.equal(tableDocumentRoundTrips(encoded), true);
  const reparsed = parseTableDocument(encoded);
  assert.deepEqual(gridFromTableDocument(reparsed), desiredGrid);
  return reparsed;
}

// --- every committed fixture satisfies the rulebook's invariants ------------

const ALL_FIXTURES: readonly { tag: string; base64: string }[] = [
  { tag: "first-2026-07-14", base64: TABLE_FIRST_REVISION },
  { tag: "final-2026-07-14", base64: TABLE_FINAL_REVISION },
  ...TABLE_WRITE_PATH_REVISIONS,
  ...TABLE_LONG_LIVED_SNAPSHOTS,
  ...TABLE_EVOLUTION_REVISIONS.map((rev) => ({ tag: `evolution-${rev.seq}`, base64: rev.base64 })),
];

for (const fixture of ALL_FIXTURES) {
  test(`validateTableDocumentInvariants accepts real fixture ${fixture.tag} untouched`, () => {
    validateTableDocumentInvariants(parse(fixture.base64));
  });
}

// --- ground truth: replay Apple's own scripted evolution --------------------
//
// Each consecutive pair of TABLE_EVOLUTION_REVISIONS is exactly one edit a
// real user made in Apple's own web client. Applying the same logical edit
// to revision N-1 must produce a document that decodes to revision N's grid
// and is structurally equivalent to Apple's own revision N - the same live
// entries, set self-pairs, redirects, mirror shape, and per-column cell
// counts (clock values and UUIDs necessarily differ: we write as our own
// replica and don't mint Apple's per-save bookkeeping replicas).

interface AxisSummary {
  attachments: number;
  setPairs: number;
  redirects: number;
  mirrorText: string;
  mirrorTombstonedUnits: number;
}

function axisSummary(doc: TableDocument, poolRef: number): AxisSummary {
  const orderedSet = doc.objects[poolRef]?.tsOrderedSet;
  assert.ok(orderedSet?.array?.array?.contents && orderedSet.array.dictionary && orderedSet.set);
  const mirror = orderedSet.array.array.contents;
  return {
    attachments: orderedSet.array.array.attachments.length,
    setPairs: orderedSet.set.element.length,
    redirects: orderedSet.array.dictionary.element.length,
    mirrorText: mirror.string,
    mirrorTombstonedUnits: mirror.substring.filter((s) => s.tombstone === 1).reduce((sum, s) => sum + s.length, 0),
  };
}

function structuralSummary(doc: TableDocument): Record<string, unknown> {
  const uuidIndexKey = doc.keyNames.indexOf("UUIDIndex");
  const identityObjects = doc.objects.filter(
    (entry) => entry.custom?.mapEntry.length === 1 && entry.custom.mapEntry[0]?.key === uuidIndexKey,
  ).length;
  const cellColumns = doc.objects[doc.cellColumnsRef]?.dictionary;
  assert.ok(cellColumns);
  const rowMapSizes = cellColumns.element
    .map((element) => {
      const rowMap = element.value ? doc.objects[element.value.objectIndex]?.dictionary : undefined;
      return rowMap?.element.length ?? -1;
    })
    .sort((a, b) => a - b);
  return {
    grid: gridFromTableDocument(doc),
    rows: axisSummary(doc, doc.crRowsRef),
    columns: axisSummary(doc, doc.crColumnsRef),
    cellColumnsEntries: cellColumns.element.length,
    rowMapSizes,
    identityObjects,
  };
}

for (let i = 1; i < TABLE_EVOLUTION_REVISIONS.length; i += 1) {
  const before = TABLE_EVOLUTION_REVISIONS[i - 1]!;
  const after = TABLE_EVOLUTION_REVISIONS[i]!;
  test(`evolution replay ${before.seq} -> ${after.seq} (${after.op}): our edit is structurally equivalent to Apple's own save`, () => {
    const doc = parse(before.base64);
    const reparsed = editAndVerify(doc, after.grid.map((row) => [...row]));
    assert.deepEqual(structuralSummary(reparsed), structuralSummary(parse(after.base64)));
  });
}

// --- the older 10-revision capture replays too -------------------------------

for (let i = 1; i < TABLE_WRITE_PATH_REVISIONS.length; i += 1) {
  const before = TABLE_WRITE_PATH_REVISIONS[i - 1]!;
  const after = TABLE_WRITE_PATH_REVISIONS[i]!;
  test(`write-path replay ${before.tag} -> ${after.tag}: the same logical edit applies cleanly`, () => {
    const doc = parse(before.base64);
    const desiredGrid = gridFromTableDocument(parse(after.base64));
    editAndVerify(doc, desiredGrid);
  });
}

// --- replica registration, in both clock systems ----------------------------

test("first edit registers our replica: version element appended, UUID inserted at the replica-segment end, every identity UUIDIndex shifted", () => {
  const original = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const replicaCountBefore = original.version.element.length;
  const uuidCountBefore = original.uuidTable.length;
  const identityIndexesBefore = identityUuidIndexes(original).sort((a, b) => a - b);

  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  editAndVerify(doc, [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-changed"],
  ]);

  assert.equal(doc.version.element.length, replicaCountBefore + 1);
  const ourElement = doc.version.element[replicaCountBefore]!;
  assert.equal(Number(ourElement.replicaIndex), replicaCountBefore);
  assert.equal(Number(ourElement.clock), 1); // pure text edit: base 0 + 1 (structural saves land on base+2)
  assert.equal(doc.uuidTable.length, uuidCountBefore + 1);
  assert.deepEqual([...doc.uuidTable[replicaCountBefore]!], [...OUR_REPLICA]);
  assert.deepEqual(
    identityUuidIndexes(doc).sort((a, b) => a - b),
    identityIndexesBefore.map((index) => index + 1),
  );
});

// OUR_REPLICA (0xa0...) sorts *after* every fixture's replica UUIDs, so the
// tests above and below exercise the append case of sorted registration;
// SMALL_REPLICA sorts *before* them all, exercising the displacement case
// the Stage-1 doubling incident missed (ttTimestamp is a sorted set - see
// tableEdit.ts's file header).
const SMALL_REPLICA = new Uint8Array(Array.from({ length: 16 }, () => 0x01));

test("registration below existing entries inserts at the sorted rank and remaps every existing CharID up by one", () => {
  const original = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const mirrorRunsBefore = original.objects[original.crRowsRef]!.tsOrderedSet!.array!.array!.contents!.substring.map((s) => ({
    replicaID: s.charID!.replicaID,
    clock: s.charID!.clock,
  }));

  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const desired = [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-small"],
  ];
  assert.equal(applyTableEdit(doc, desired, SMALL_REPLICA), true);
  validateTableDocumentInvariants(doc);
  assert.deepEqual(gridFromTableDocument(doc), desired);

  const tt = doc.document.ttTimestamp!;
  assert.deepEqual([...tt.clock[0]!.replicaUUID], [...SMALL_REPLICA]);
  // Apple's runs (previously replicaID 1) now live at rank 2 ...
  const mirrorRunsAfter = doc.objects[doc.crRowsRef]!.tsOrderedSet!.array!.array!.contents!.substring;
  mirrorRunsBefore.forEach((before, i) => {
    const after = mirrorRunsAfter[i]!;
    assert.equal(after.charID!.replicaID, before.replicaID === 0 ? 0 : before.replicaID + 1);
    assert.equal(after.charID!.clock, before.clock);
  });
  // ... and our new run writes under rank 1.
  const editedCell = doc.objects.find((o) => o.string?.string === "delta-r2c2-small")!;
  const ourRun = editedCell.string!.substring.find((s) => s.charID!.replicaID === 1);
  assert.ok(ourRun, "the inserted text's run should carry our sorted rank (1)");

  const encoded = encodeTableDocument(doc);
  assert.equal(tableDocumentRoundTrips(encoded), true);
  assert.deepEqual(gridFromTableDocument(parseTableDocument(encoded)), desired);
});

test("the direction marker's registerLatest is left untouched, matching the real foreign-device save (2AV -> 2AX)", () => {
  const original = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const registerBefore = original.objects.find((o) => o.registerLatest)!.registerLatest!;
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  editAndVerify(doc, [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-reg"],
  ]);
  const registerAfter = doc.objects.find((o) => o.registerLatest)!.registerLatest!;
  assert.equal(registerAfter.timestamp?.replicaIndex, registerBefore.timestamp?.replicaIndex);
  assert.equal(registerAfter.timestamp?.counter, registerBefore.timestamp?.counter);
});

// --- the Stage-1 doubling incident's own artifact -----------------------------

const INCIDENT_REPLICA = new Uint8Array(Buffer.from("44681ad5c726c5e57d0008df7530ae41", "hex"));

test("the unsorted-ttTimestamp incident document violates the sorted-set/accounting invariants as parsed", () => {
  assert.throws(() => validateTableDocumentInvariants(parse(TABLE_UNSORTED_TT_REGRESSION)), /sorted UUID order|clock/);
});

test("editing the incident document under its own replica heals it: sorted table, remapped CharIDs, invariants restored", () => {
  const doc = parse(TABLE_UNSORTED_TT_REGRESSION);
  const desired = [
    ["alpha", "bravo"],
    ["one", "two-edited-again"],
  ];
  assert.equal(applyTableEdit(doc, desired, INCIDENT_REPLICA), true);
  assert.deepEqual(gridFromTableDocument(doc), desired);
  validateTableDocumentInvariants(doc);
  const tt = doc.document.ttTimestamp!;
  assert.deepEqual([...tt.clock[0]!.replicaUUID], [...INCIDENT_REPLICA]); // 44... sorts before 7c...
  const encoded = encodeTableDocument(doc);
  assert.equal(tableDocumentRoundTrips(encoded), true);
  assert.deepEqual(gridFromTableDocument(parseTableDocument(encoded)), desired);
});

test("a no-op edit against the incident document reports no change rather than half-healing", () => {
  const doc = parse(TABLE_UNSORTED_TT_REGRESSION);
  const currentGrid = gridFromTableDocument(doc);
  assert.equal(applyTableEdit(doc, currentGrid, INCIDENT_REPLICA), false);
});

test("an unsorted document that is not our own residue is refused, not reinterpreted", () => {
  const doc = parse(TABLE_UNSORTED_TT_REGRESSION);
  const changed = gridFromTableDocument(doc).map((row) => [...row]);
  changed[0]![0] = "changed";
  assert.throws(() => applyTableEdit(doc, changed, OUR_REPLICA), /isn't this tool's own residue/);
});

test("first edit registers our topotext clock: a fresh two-counter ttTimestamp entry, advanced by the units we wrote", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const ttEntriesBefore = doc.document.ttTimestamp!.clock.length;
  editAndVerify(doc, [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-XY"],
  ]);
  const tt = doc.document.ttTimestamp!;
  assert.equal(tt.clock.length, ttEntriesBefore + 1);
  const ours = tt.clock[tt.clock.length - 1]!;
  assert.deepEqual([...ours.replicaUUID], [...OUR_REPLICA]);
  assert.equal(ours.replicaClock.length, 2);
  assert.equal(Number(ours.replicaClock[0]!.clock), 3); // "-XY" replaced "2": wrote "2-XY"? no - splice inserted "-XY" after shared prefix/suffix trim
  assert.equal(Number(ours.replicaClock[1]!.clock), 1); // no deletions yet
});

test("a second edit reuses the registered replica and keeps both clocks monotonic", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  editAndVerify(doc, [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-more"],
  ]);
  const replicaCount = doc.version.element.length;
  const ttEntries = doc.document.ttTimestamp!.clock.length;
  const clockAfterFirst = Number(doc.version.element[replicaCount - 1]!.clock);

  editAndVerify(doc, [
    ["apple-r1c1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2-more-still"],
  ]);
  assert.equal(doc.version.element.length, replicaCount);
  assert.equal(doc.document.ttTimestamp!.clock.length, ttEntries);
  assert.ok(Number(doc.version.element[replicaCount - 1]!.clock) > clockAfterFirst);
});

function identityUuidIndexes(doc: TableDocument): number[] {
  const uuidIndexKey = doc.keyNames.indexOf("UUIDIndex");
  const indexes: number[] = [];
  for (const entry of doc.objects) {
    const mapEntry = entry.custom?.mapEntry.length === 1 ? entry.custom.mapEntry[0] : undefined;
    if (mapEntry && mapEntry.key === uuidIndexKey && mapEntry.value) {
      indexes.push(Number(mapEntry.value.unsignedIntegerValue));
    }
  }
  return indexes;
}

// --- the redirect/identity-pair rules, per edit type -------------------------
//
// The direct regression tests for both live corruption incidents: after
// every edit type, the ordering array, the FFFC mirror, the set self-pairs,
// and the redirect dictionary must stay mutually consistent (that's
// validateTableDocumentInvariants, run inside editAndVerify), and the
// redirect/identity residue must follow the retention rules.

const BASE_3X2 = TABLE_EVOLUTION_REVISIONS[7]!; // ["apple-r1c1-edit1","berry-r1c2"],["cedar-r2c1","delta-r2c2"],["echo-r3c1",""]

function redirectCounts(doc: TableDocument): { rows: number; columns: number } {
  return {
    rows: doc.objects[doc.crRowsRef]!.tsOrderedSet!.array!.dictionary!.element.length,
    columns: doc.objects[doc.crColumnsRef]!.tsOrderedSet!.array!.dictionary!.element.length,
  };
}

test("row insert mints a real identity pair: one new redirect (ordering -> content), a set self-pair, and content-keyed cells", () => {
  const doc = parse(BASE_3X2.base64);
  const before = redirectCounts(doc);
  editAndVerify(doc, [
    ["apple-r1c1-edit1", "berry-r1c2"],
    ["new-r2c1", "new-r2c2"],
    ["cedar-r2c1", "delta-r2c2"],
    ["echo-r3c1", ""],
  ]);
  assert.deepEqual(redirectCounts(doc), { rows: before.rows + 1, columns: before.columns });

  // The redirect's two sides are distinct identity objects: ordering (in
  // attachments/set) and content (keying the row-maps).
  const rowSet = doc.objects[doc.crRowsRef]!.tsOrderedSet!;
  const newRedirect = rowSet.array!.dictionary!.element[before.rows]!;
  const orderingIdentity = uuidIndexOfRef(doc, resolveRef(newRedirect.key!, "redirect key"));
  const contentIdentity = uuidIndexOfRef(doc, resolveRef(newRedirect.value!, "redirect value"));
  assert.notEqual(orderingIdentity, contentIdentity);
});

test("column insert mints an identity pair and a full content-keyed row-map", () => {
  const doc = parse(BASE_3X2.base64);
  const before = redirectCounts(doc);
  editAndVerify(doc, [
    ["apple-r1c1-edit1", "mid-r1", "berry-r1c2"],
    ["cedar-r2c1", "mid-r2", "delta-r2c2"],
    ["echo-r3c1", "mid-r3", ""],
  ]);
  assert.deepEqual(redirectCounts(doc), { rows: before.rows, columns: before.columns + 1 });
});

test("row delete retains redirects and identity objects forever, removes the set self-pair, and tombstones the mirror at our deletion counter", () => {
  const doc = parse(BASE_3X2.base64);
  const before = redirectCounts(doc);
  const identityCountBefore = identityUuidIndexes(doc).length;
  const setPairsBefore = doc.objects[doc.crRowsRef]!.tsOrderedSet!.set!.element.length;

  editAndVerify(doc, [
    ["apple-r1c1-edit1", "berry-r1c2"],
    ["echo-r3c1", ""],
  ]);

  assert.deepEqual(redirectCounts(doc), before);
  assert.equal(identityUuidIndexes(doc).length, identityCountBefore);
  assert.equal(doc.objects[doc.crRowsRef]!.tsOrderedSet!.set!.element.length, setPairsBefore - 1);

  const mirror = doc.objects[doc.crRowsRef]!.tsOrderedSet!.array!.array!.contents!;
  const tombstoned = mirror.substring.filter((s) => s.tombstone === 1);
  assert.equal(tombstoned.length, 1);
  assert.equal(tombstoned[0]!.length, 1);
  // Anchored at our fresh deletion counter (starts at 1), which then advanced.
  const ourTt = doc.document.ttTimestamp!.clock[doc.document.ttTimestamp!.clock.length - 1]!;
  assert.equal(tombstoned[0]!.timestamp!.replicaID, doc.document.ttTimestamp!.clock.length);
  assert.equal(tombstoned[0]!.timestamp!.clock, 1);
  assert.equal(Number(ourTt.replicaClock[1]!.clock), 2);
});

test("column delete physically removes the row-map and its cells from the pool, retaining redirects and identities", () => {
  const doc = parse(BASE_3X2.base64);
  const before = redirectCounts(doc);
  const identityCountBefore = identityUuidIndexes(doc).length;
  const poolSizeBefore = doc.objects.length;

  editAndVerify(doc, [["apple-r1c1-edit1"], ["cedar-r2c1"], ["echo-r3c1"]]);

  assert.deepEqual(redirectCounts(doc), before);
  assert.equal(identityUuidIndexes(doc).length, identityCountBefore);
  // One row-map object + its three cell objects gone.
  assert.equal(doc.objects.length, poolSizeBefore - 4);
});

test("cell edits change nothing structural: no new identities, redirects, set pairs, or dictionary element stamps", () => {
  const doc = parse(BASE_3X2.base64);
  const summaryBefore = structuralSummary(doc);
  editAndVerify(doc, [
    ["apple-r1c1-edit1", "berry-r1c2-changed"],
    ["cedar-r2c1", "delta-r2c2"],
    ["echo-r3c1", "now filled"],
  ]);
  const summaryAfter = structuralSummary(doc);
  assert.deepEqual(
    { ...summaryAfter, grid: undefined },
    { ...summaryBefore, grid: undefined },
  );
});

// --- accumulation: a long-lived local editing session ------------------------

test("sequential edits accumulate cleanly: every edit type in a row on one document", () => {
  let doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const steps: string[][][] = [
    // cell edit
    [
      ["apple-x", "berry-r1c2"],
      ["cedar-r2c1", "delta-r2c2"],
    ],
    // row insert with text
    [
      ["apple-x", "berry-r1c2"],
      ["mid-1", "mid-2"],
      ["cedar-r2c1", "delta-r2c2"],
    ],
    // column insert with text
    [
      ["apple-x", "berry-r1c2", "c3-1"],
      ["mid-1", "mid-2", "c3-2"],
      ["cedar-r2c1", "delta-r2c2", "c3-3"],
    ],
    // row delete
    [
      ["apple-x", "berry-r1c2", "c3-1"],
      ["cedar-r2c1", "delta-r2c2", "c3-3"],
    ],
    // column delete
    [
      ["apple-x", "c3-1"],
      ["cedar-r2c1", "c3-3"],
    ],
    // final cell edit
    [
      ["apple-x", "c3-1"],
      ["cedar-r2c1", "done"],
    ],
  ];
  for (const desiredGrid of steps) {
    // Re-parse from encoded bytes between steps, like consecutive pushes do.
    doc = editAndVerify(doc, desiredGrid);
  }
});

// --- long-lived, multi-replica documents -------------------------------------

for (const snapshot of TABLE_LONG_LIVED_SNAPSHOTS) {
  test(`long-lived snapshot ${snapshot.tag} (multi-replica, startVersion-bearing): cell edit and row insert apply cleanly`, () => {
    const doc = parse(snapshot.base64);
    const grid = gridFromTableDocument(doc);
    const edited = grid.map((row) => [...row]);
    edited[0]![0] = `${edited[0]![0]}-ours`;
    const reparsed = editAndVerify(doc, edited);

    const withRow = gridFromTableDocument(reparsed).map((row) => [...row]);
    withRow.splice(1, 0, Array.from({ length: withRow[0]!.length }, (_, i) => `ours-${i}`));
    editAndVerify(reparsed, withRow);
  });
}

// --- diffTableGrid plan shapes ------------------------------------------------

test("diffTableGrid: identical grids are a noop", () => {
  assert.deepEqual(diffTableGrid([["a", "b"]], [["a", "b"]]), { kind: "noop" });
});

test("diffTableGrid: cell-only changes become cellEdits", () => {
  const plan = diffTableGrid(
    [
      ["a", "b"],
      ["c", "d"],
    ],
    [
      ["a", "B"],
      ["C", "d"],
    ],
  );
  assert.deepEqual(plan, {
    kind: "cellEdits",
    edits: [
      { row: 0, column: 1, text: "B" },
      { row: 1, column: 0, text: "C" },
    ],
  });
});

test("diffTableGrid: a contiguous multi-row insert is one plan", () => {
  const plan = diffTableGrid([["a"], ["z"]], [["a"], ["m"], ["n"], ["z"]]);
  assert.deepEqual(plan, { kind: "insertRows", position: 1, rows: [["m"], ["n"]] });
});

test("diffTableGrid: a contiguous multi-column delete is one plan", () => {
  const plan = diffTableGrid([["a", "b", "c", "d"]], [["a", "d"]]);
  assert.deepEqual(plan, { kind: "deleteColumns", position: 1, count: 2 });
});

test("diffTableGrid: both axes changed at once is unsupported", () => {
  const plan = diffTableGrid([["a", "b"]], [["a"], ["x"]]);
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: a structural change mixed with an unrelated cell edit is unsupported", () => {
  const plan = diffTableGrid(
    [
      ["a", "b"],
      ["c", "d"],
    ],
    [
      ["a", "EDITED"],
      ["new", "row"],
      ["c", "d"],
    ],
  );
  assert.equal(plan.kind, "unsupported");
});

test("diffTableGrid: a pure reorder is unsupported", () => {
  const plan = diffTableGrid(
    [
      ["a", "b"],
      ["c", "d"],
    ],
    [
      ["c", "d"],
      ["a", "b"],
    ],
  );
  assert.equal(plan.kind, "unsupported");
});

// --- applyTableEdit refusals ---------------------------------------------------

test("applyTableEdit returns false for an unchanged grid", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  assert.equal(applyTableEdit(doc, gridFromTableDocument(doc), OUR_REPLICA), false);
});

test("applyTableEdit refuses an empty grid", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  assert.throws(() => applyTableEdit(doc, [], OUR_REPLICA), /no rows or no columns/);
});

test("applyTableEdit refuses a ragged grid", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  assert.throws(() => applyTableEdit(doc, [["a", "b"], ["c"]], OUR_REPLICA), /same number of columns/);
});

test("applyTableEdit refuses an unsupported diff with the diff's reason", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  assert.throws(() => applyTableEdit(doc, [["only", "one", "wider", "row"]], OUR_REPLICA), /both row and column counts changed/);
});

test("applyTableEdit refuses a malformed replica id", () => {
  const doc = parse(TABLE_EVOLUTION_REVISIONS[4]!.base64);
  const changed = gridFromTableDocument(doc).map((row) => [...row]);
  changed[0]![0] = "changed";
  assert.throws(() => applyTableEdit(doc, changed, new Uint8Array(4)), /16 bytes/);
});

// --- the mirror stays the exact captured shape ---------------------------------

test("after a row insert the mirror is one U+FFFC per live row with per-character attribute runs", () => {
  const doc = parse(BASE_3X2.base64);
  editAndVerify(doc, [
    ["apple-r1c1-edit1", "berry-r1c2"],
    ["cedar-r2c1", "delta-r2c2"],
    ["echo-r3c1", ""],
    ["tail-1", "tail-2"],
  ]);
  const mirror = doc.objects[doc.crRowsRef]!.tsOrderedSet!.array!.array!.contents!;
  assert.equal(mirror.string, OBJECT_REPLACEMENT_CHARACTER.repeat(4));
  assert.deepEqual(
    mirror.attributeRun.map((run) => run.length),
    [1, 1, 1, 1],
  );
  // The ordering array and the mirror agree on the live count.
  assert.equal(parseOrderedSet(doc, doc.crRowsRef).arrayUuidIndexes.length, 4);
});
