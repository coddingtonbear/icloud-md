import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeTableMarkdown,
  parseTableDocument,
  encodeTableDocument,
  tableDocumentRoundTrips,
  gridFromTableDocument,
} from "./decodeTableRecord.js";
import { buildFreshTableDocument } from "./tableEdit.js";
import {
  TABLE_FIRST_REVISION,
  TABLE_FINAL_REVISION,
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

/**
 * The core write-path claim, verified against every one of the 9 real
 * transitions mined above: parse revision N as the "current" document,
 * `buildFreshTableDocument` it toward revision N+1's own grid (a real
 * user's own edit, reproduced through our model - not a hand-picked grid),
 * and the rebuilt result must decode back to *exactly* revision N+1's grid.
 * Also checks the rebuilt document round-trips through our own model again
 * (parse -> encode -> parse), the same discipline `push` requires before
 * trusting a rebuilt document enough to upload it. Unlike the old
 * incremental-patch write path, every transition here - including the ones
 * that add/remove rows or columns - goes through the exact same rebuild
 * function; there's no "kind" of edit for this loop to classify first.
 */
for (let i = 1; i < TABLE_WRITE_PATH_REVISIONS.length; i += 1) {
  const before = TABLE_WRITE_PATH_REVISIONS[i - 1]!;
  const after = TABLE_WRITE_PATH_REVISIONS[i]!;
  test(`rebuilding the real ${before.tag} document toward revision ${after.tag}'s grid reproduces it exactly`, () => {
    const afterGrid = gridFromTableDocument(parseTableDocument(Buffer.from(after.base64, "base64")));

    const doc = parseTableDocument(Buffer.from(before.base64, "base64"));
    buildFreshTableDocument(doc, afterGrid);

    assert.deepEqual(gridFromTableDocument(doc), afterGrid);

    const encoded = encodeTableDocument(doc);
    assert.equal(tableDocumentRoundTrips(encoded), true);
    assert.deepEqual(gridFromTableDocument(parseTableDocument(encoded)), afterGrid);
  });
}

