import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeTableMarkdown,
  parseTableDocument,
  encodeTableDocument,
  tableDocumentRoundTrips,
  gridFromTableDocument,
} from "./decodeTableRecord.js";
import {
  TABLE_FIRST_REVISION,
  TABLE_FINAL_REVISION,
  TABLE_LONG_LIVED_REV_2AX,
  TABLE_LONG_LIVED_SNAPSHOTS,
  TABLE_REV_BASELINE,
  TABLE_REV_CELL_EDIT_2,
  TABLE_WRITE_PATH_REVISIONS,
} from "./realFixtures.js";

test("decodeTableMarkdown renders a real captured 2x2 grid, one row still blank", () => {
  const markdown = decodeTableMarkdown(Buffer.from(TABLE_FIRST_REVISION, "base64"));
  assert.equal(markdown, ["| A0 | B0 |", "| - | - |", "| | |"].join("\n"));
});

test("decodeTableMarkdown renders a real captured 5x4 grid, verified against the live table", () => {
  const markdown = decodeTableMarkdown(Buffer.from(TABLE_FINAL_REVISION, "base64"));
  assert.equal(
    markdown,
    [
      "| A0 | B0 | B0-new | C0 |",
      "| - | - | - | - |",
      "| A1 | B1 | B1-new | C1 |",
      "| A2 | B2 | B2-new | C2 |",
      "| A3 | B3 | B3-new | C3-edited |",
      "| A4 | B4 | B4-new | C4 |",
    ].join("\n"),
  );
});

test("decodeTableMarkdown throws on bytes that aren't a table document, refusing rather than guessing", () => {
  assert.throws(() => decodeTableMarkdown(Buffer.from("not a real table")));
});

for (const revision of TABLE_WRITE_PATH_REVISIONS) {
  test(`tableDocumentRoundTrips is true for real captured revision ${revision.tag}`, () => {
    assert.equal(tableDocumentRoundTrips(Buffer.from(revision.base64, "base64")), true);
  });
}

// The long-lived-table snapshots are the regression proof for
// CRDT.Document's startVersion/ttTimestamp (fields 2/7, the pre-alignment
// unknown_field_2/unknown_field_7 - see realFixtures.ts): before those were
// declared, both failed this exact gate on field ordering alone, blocking
// every kind of push edit on that table.
for (const revision of TABLE_LONG_LIVED_SNAPSHOTS) {
  test(`tableDocumentRoundTrips is true for long-lived table revision ${revision.tag}`, () => {
    assert.equal(tableDocumentRoundTrips(Buffer.from(revision.base64, "base64")), true);
  });
}

test("long-lived table revision 2ax (carrying unknown fields 2 and 7) still decodes to the expected grid", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_LONG_LIVED_REV_2AX, "base64"));
  assert.deepEqual(gridFromTableDocument(doc), [
    ["A0", "B0", "B0-new", "C0"],
    ["A1", "B1", "B1-new", "C1"],
    ["A2", "B2", "B2-new", "C2"],
    ["A3", "B3", "B3-new", "C3-edited"],
    ["A4", "B4", "B4-new", "C4"],
  ]);
});

test("real revision 29z decodes to the expected 4x5 grid", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_REV_BASELINE, "base64"));
  assert.deepEqual(gridFromTableDocument(doc), [
    ["R0C0", "R0C1", "R0C2", "R0C3", "R0C4"],
    ["R2C0", "R2C1", "R2C2", "R2C3", "R2C4"],
    ["R3C0", "R3C1", "R3C2", "R3C3", "R3C4"],
    ["R4C0", "R4C1", "R4C2", "R4C3", "R4C4"],
  ]);
});

test("real revision 2ai (final state after every mined edit) decodes to the expected grid", () => {
  const doc = parseTableDocument(Buffer.from(TABLE_REV_CELL_EDIT_2, "base64"));
  assert.deepEqual(gridFromTableDocument(doc), [
    ["R2C2", "NEW COL", "R2C3"],
    ["NEW ROW", "NEW COL / NEW ROW", "NEW ROW (2)"],
    ["R3C2", "NEW COL", "R3C3"],
  ]);
});

// The write-path replay claim - "applying revision N+1's own grid to
// revision N reproduces it" - lives in tableEdit.test.ts now, run through
// the incremental engine that actually ships (the old from-scratch-rebuild
// replay this file carried is gone with the rebuild itself).

