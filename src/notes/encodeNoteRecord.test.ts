import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoteCreateFields, buildNotePurgeFields, buildNoteTrashFields, buildNoteUpdateFields, deriveNoteSnippet, deriveNoteTitle } from "./encodeNoteRecord.js";
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

test("buildNoteTrashFields repoints the folder references at Trash and echoes content verbatim", () => {
  const record = makeRecord({
    TitleEncrypted: { value: "dGl0bGU=", type: "ENCRYPTED_BYTES" },
    SnippetEncrypted: { value: "c25pcHBldA==", type: "ENCRYPTED_BYTES" },
    CreationDate: { value: 100, type: "TIMESTAMP" },
    ModificationDate: { value: 111, type: "TIMESTAMP" },
    Folder: { value: { recordName: "DefaultFolder-CloudKit" }, type: "REFERENCE" },
    Folders: { value: [{ recordName: "DefaultFolder-CloudKit" }], type: "REFERENCE_LIST" },
    TextDataEncrypted: { value: "RE9D", type: "ENCRYPTED_BYTES" },
  });

  const fields = buildNoteTrashFields(record, 999);

  const trashRef = { recordName: "TrashFolder-CloudKit", action: "VALIDATE", zoneID: { zoneName: "Notes" } };
  assert.deepEqual(fields.Folder?.value, trashRef);
  assert.deepEqual(fields.Folders?.value, [trashRef]);
  assert.equal(fields.ModificationDate?.value, 999);
  assert.equal(fields.FoldersModificationDate?.value, 999);
  // Content fields echoed verbatim, never decoded or re-derived - the
  // deletion path must work on a note too broken to parse.
  assert.equal(fields.TitleEncrypted?.value, "dGl0bGU=");
  assert.equal(fields.SnippetEncrypted?.value, "c25pcHBldA==");
  assert.equal(fields.TextDataEncrypted?.value, "RE9D");
  assert.equal(fields.CreationDate?.value, 100);
  // Stage 1 never marks Deleted - that's the purge's job.
  assert.equal("Deleted" in fields, false);
  // The captured requests send these as literal `{}` (not null) - which is
  // exactly what `{value: undefined}` serializes to.
  assert.equal(JSON.stringify(fields.FirstAttachmentThumbnail), "{}");
  assert.equal(JSON.stringify(fields.FirstAttachmentUTIEncrypted), "{}");
  assert.equal(JSON.stringify(fields.TextDataAsset), "{}");
});

test("buildNotePurgeFields additionally sets Deleted: 1, matching the captured permanent delete", () => {
  const record = makeRecord({
    CreationDate: { value: 100, type: "TIMESTAMP" },
    TextDataEncrypted: { value: "RE9D", type: "ENCRYPTED_BYTES" },
  });

  const fields = buildNotePurgeFields(record, 999);

  assert.deepEqual(fields.Deleted, { value: 1 });
  assert.equal(fields.Folder !== undefined, true);
  assert.equal(fields.TextDataEncrypted?.value, "RE9D");
});

test("deletion field builders tolerate a broken record missing echoable fields entirely", () => {
  const fields = buildNotePurgeFields(makeRecord({}), 999);

  assert.equal("TitleEncrypted" in fields, false);
  assert.equal("SnippetEncrypted" in fields, false);
  assert.equal("TextDataEncrypted" in fields, false);
  assert.equal("CreationDate" in fields, false);
  assert.deepEqual(fields.Deleted, { value: 1 });
  assert.equal(fields.ModificationDate?.value, 999);
});

test("buildNoteCreateFields matches the captured first-save request shape", () => {
  const fields = buildNoteCreateFields("RE9D", "Title line\nBody line", 555);

  assert.equal(fields.CreationDate?.value, 555);
  assert.equal(fields.ModificationDate?.value, 555);
  const defaultRef = { recordName: "DefaultFolder-CloudKit", action: "VALIDATE", zoneID: { zoneName: "Notes" } };
  assert.deepEqual(fields.Folder?.value, defaultRef);
  assert.deepEqual(fields.Folders?.value, [defaultRef]);
  assert.equal(Buffer.from(String(fields.TitleEncrypted?.value), "base64").toString(), "Title line");
  assert.equal(Buffer.from(String(fields.SnippetEncrypted?.value), "base64").toString(), "Body line");
  assert.equal(fields.TextDataEncrypted?.value, "RE9D");
  // The placeholder trio goes out as literal `{}`, like the capture.
  assert.equal(JSON.stringify(fields.FirstAttachmentThumbnail), "{}");
  assert.equal(JSON.stringify(fields.FirstAttachmentUTIEncrypted), "{}");
  assert.equal(JSON.stringify(fields.TextDataAsset), "{}");
  // The capture omits ReplicaIDToNotesVersionDataEncrypted and
  // FoldersModificationDate entirely on a create - so do we.
  assert.equal("ReplicaIDToNotesVersionDataEncrypted" in fields, false);
  assert.equal("FoldersModificationDate" in fields, false);
});

test("buildNoteCreateFields qualifies the folder references with the sharer's zone owner for a shared-folder create", () => {
  // Matches the 2026-07-17 shared-note-modifications capture: writes into a
  // shared zone carry the owner in the reference zoneIDs (private writes
  // keep the bare zoneName, per the test above).
  const fields = buildNoteCreateFields("RE9D", "Hi", 555, "F-SHARED", "_owner1");

  const sharedRef = {
    recordName: "F-SHARED",
    action: "VALIDATE",
    zoneID: { zoneName: "Notes", ownerRecordName: "_owner1" },
  };
  assert.deepEqual(fields.Folder?.value, sharedRef);
  assert.deepEqual(fields.Folders?.value, [sharedRef]);
});
