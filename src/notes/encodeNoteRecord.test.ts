import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoteUpdateFields, deriveNoteSnippet, deriveNoteTitle } from "./encodeNoteRecord.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

test("title is the first line for short notes", () => {
  assert.equal(deriveNoteTitle("Grocery list\nEggs\nMilk"), "Grocery list");
  assert.equal(deriveNoteTitle("Single line, no newline"), "Single line, no newline");
});

test("long first lines are cut at a word boundary, matching the captured save", () => {
  // Mirrors the captured note: a 255-char first line whose title was cut to
  // 66 chars ("...through a real"), with the next word ending at 78.
  const firstLine =
    "Schwartz wrote up his experiment supervising Claude through a real theoretical physics calculation" +
    ", and this line keeps going well past any plausible title limit for quite a while longer";
  const title = deriveNoteTitle(firstLine + "\nBody");
  assert.equal(title, "Schwartz wrote up his experiment supervising Claude through a real");
});

test("a long first word is hard-cut rather than dropped", () => {
  const title = deriveNoteTitle("x".repeat(100));
  assert.equal(title.length, 76);
});

test("snippet continues where a truncated title left off, to the end of that line", () => {
  const firstLine =
    "Schwartz wrote up his experiment supervising Claude through a real theoretical physics calculation, producing a paper";
  assert.equal(
    deriveNoteSnippet(firstLine + "\nSecond line"),
    "theoretical physics calculation, producing a paper",
  );
});

test("snippet is the first non-empty line after a short title", () => {
  assert.equal(deriveNoteSnippet("Grocery list\nEggs\nMilk"), "Eggs");
  assert.equal(deriveNoteSnippet("Grocery list\n\n\nEggs"), "Eggs");
});

test("snippet falls back to the captured placeholder when there is no body", () => {
  // Observed verbatim in captured web-client saves of single-line notes.
  assert.equal(deriveNoteSnippet("Just a title"), "No additional text");
  assert.equal(deriveNoteSnippet("Just a title\n\n"), "No additional text");
});

function makeRecord(fields: CloudKitRecord["fields"]): CloudKitRecord {
  return { recordName: "R1", recordType: "Note", fields, recordChangeTag: "1a" };
}

test("buildNoteUpdateFields overrides content fields and echoes the rest", () => {
  const record = makeRecord({
    TitleEncrypted: { value: "b2xk", type: "ENCRYPTED_BYTES" }, // "old"
    ModificationDate: { value: 111, type: "TIMESTAMP" },
    CreationDate: { value: 100, type: "TIMESTAMP" },
    Deleted: { value: 0, type: "INT64" },
    Folder: { value: { recordName: "DefaultFolder-CloudKit" }, type: "REFERENCE" },
    MinimumSupportedNotesVersion: { value: 0, type: "INT64" },
    TextDataEncrypted: { value: "aWdub3JlZA==", type: "ENCRYPTED_BYTES" },
  });

  const fields = buildNoteUpdateFields(record, "TkVXX0RPQw==", "Title line\nBody line", 222);

  assert.equal(fields.TextDataEncrypted?.value, "TkVXX0RPQw==");
  assert.equal(fields.ModificationDate?.value, 222);
  assert.equal(Buffer.from(String(fields.TitleEncrypted?.value), "base64").toString(), "Title line");
  assert.equal(Buffer.from(String(fields.SnippetEncrypted?.value), "base64").toString(), "Body line");
  // Echoed verbatim.
  assert.equal(fields.CreationDate?.value, 100);
  assert.deepEqual(fields.Folder?.value, { recordName: "DefaultFolder-CloudKit" });
  // Sent as literal nulls when absent, like the captured web client does.
  assert.deepEqual(fields.TextDataAsset, { value: null });
  assert.deepEqual(fields.FirstAttachmentThumbnail, { value: null });
  assert.deepEqual(fields.FirstAttachmentUTIEncrypted, { value: null });
  // Fields the record doesn't have (beyond the always-null trio) are not invented.
  assert.equal("PaperStyleType" in fields, false);
  // No read-side type wrappers on the write path.
  assert.equal(Object.values(fields).every((field) => !("type" in field)), true);
});
