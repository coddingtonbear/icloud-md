import assert from "node:assert/strict";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import type { CloudKitRecord, RecordUpdateResult } from "../cloudkit/databaseClient.js";
import { StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { compressNoteDocument } from "./noteText.js";
import { confirmedDrawingTitleRename, prepareDrawingTitleRename } from "./drawingTitleRename.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";

function replyFixture() {
  const f = fixture();
  const prepared = prepareDrawingTitleRename(f.note, f.attachment, f.options);
  assert.ok(prepared.ok);
  const records: CloudKitRecord[] = prepared.updates.map(update => ({ ...update, recordChangeTag: `${update.recordChangeTag}-after`,
    fields: { ...update.fields, Deleted: { value: 0, type: "INT64" } } }));
  const results: RecordUpdateResult[] = records.map(record => ({ ok: true, record }));
  return { updates: prepared.updates, records, results };
}

test("confirms the exact rename pair in either response order without mutating inputs", () => {
  const { updates, records, results } = replyFixture();
  const before = structuredClone({ updates, results });
  assert.equal(confirmedDrawingTitleRename(updates, results), records[0]);
  assert.equal(confirmedDrawingTitleRename(updates, [...results].reverse()), records[0]);
  assert.deepEqual({ updates, results }, before);
});

const badReplies: Array<[string, (f: ReturnType<typeof replyFixture>) => void]> = [
  ["empty reply", f => { f.results.length = 0; }],
  ["missing record", f => { f.results.pop(); }],
  ["extra record", f => { f.results.push({ ok: true, record: { ...f.records[0]!, recordName: folderId } }); }],
  ["duplicate identity", f => { f.results[1] = f.results[0]!; }],
  ["unexpected identity", f => { f.records[1]!.recordName = folderId; }],
  ["wrong type", f => { f.records[1]!.recordType = "Note"; }],
  ["server refusal", f => { f.results[1] = { ok: false, serverErrorCode: "CONFLICT", reason: undefined }; }],
  ["deleted record", f => { Object.assign(f.records[1]!, { deleted: true }); }],
  ["Deleted field", f => { f.records[1]!.fields.Deleted!.value = 1; }],
  ["missing deletion state", f => { delete (f.records[1]!.fields as CloudKitRecord["fields"]).Deleted; }],
  ["missing tag", f => { delete (f.records[1]! as CloudKitRecord).recordChangeTag; }],
  ["empty tag", f => { f.records[1]!.recordChangeTag = ""; }],
  ["unchanged tag", f => { f.records[1]!.recordChangeTag = f.updates[1].recordChangeTag; }],
  ["missing requested field", f => { delete f.records[1]!.fields.UserTitle; }],
  ["wrong title", f => { f.records[1]!.fields.UserTitle = { value: "wrong", type: "ENCRYPTED_BYTES" }; }],
  ["wrong date", f => { f.records[0]!.fields.ModificationDate = { value: 201, type: "TIMESTAMP" }; }],
];
for (const [name, change] of badReplies) {
  test(`does not confirm rename with ${name}`, () => {
    const f = replyFixture();
    change(f);
    assert.equal(confirmedDrawingTitleRename(f.updates, f.results), undefined);
  });
}

function fixture(text = "\uFFFC\n", count = 1) {
  const body = create(StringSchema, {
    string: text,
    attributeRun: [
      ...Array.from({ length: count }, () => ({ length: 1, attachmentInfo: { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" } })),
      { length: text.length - count },
    ],
  });
  const document = create(DocumentSchema, { version: [create(VersionSchema, { data: toBinary(StringSchema, body) })] });
  const note: CloudKitRecord = {
    recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId,
    fields: {
      Deleted: { type: "INT64", value: 0 },
      Folder: { type: "REFERENCE", value: { recordName: folderId } },
      TextDataEncrypted: { type: "ENCRYPTED_BYTES", value: compressNoteDocument(toBinary(DocumentSchema, document)).toString("base64") },
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: Buffer.from("Old title").toString("base64") },
      FirstAttachmentThumbnail: { type: "ASSETID", value: { fileChecksum: "unchanged-thumbnail" } },
    },
  };
  const attachment: CloudKitRecord = {
    recordName: attachmentId, recordType: "Attachment", recordChangeTag: "drawing-tag", parentRecordName: noteId,
    fields: {
      Deleted: { type: "INT64", value: 0 },
      Note: { type: "REFERENCE", value: { recordName: noteId } },
      UTI: { type: "STRING", value: "com.apple.paper" },
      TitleEncrypted: { type: "ENCRYPTED_BYTES", value: "bGVnYWN5" },
      PaperDatabase: { type: "ASSETID", value: { fileChecksum: "unchanged-drawing" } },
    },
  };
  const options = {
    recordName: noteId,
    entry: { file: "TEST/Old title.md", recordChangeTag: "note-tag", modificationDate: 10, folderRecordName: folderId },
    localText: "[Drawing](attachments/drawing.png)\n", baseText: "[Drawing](attachments/drawing.png)\n",
    newTitle: "New drawing ✏️", modificationDateMs: 200,
  };
  return { note, attachment, options };
}

test("prepares only UserTitle and note title/date with both snapshot CAS tags", () => {
  const { note, attachment, options } = fixture();
  const before = structuredClone({ note, attachment, options });
  const result = prepareDrawingTitleRename(note, attachment, options);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const title = Buffer.from(options.newTitle).toString("base64");
  assert.deepEqual(result.updates, [
    { recordName: noteId, recordType: "Note", recordChangeTag: "note-tag", parentRecordName: folderId,
      fields: { TitleEncrypted: { value: title }, ModificationDate: { value: 200 } } },
    { recordName: attachmentId, recordType: "Attachment", recordChangeTag: "drawing-tag", parentRecordName: noteId,
      fields: { UserTitle: { value: title } } },
  ]);
  assert.deepEqual({ note, attachment, options }, before, "preparation leaves document, assets, legacy title and inputs untouched");
  note.recordChangeTag = "later-note";
  attachment.recordChangeTag = "later-drawing";
  assert.equal(result.updates[0].recordChangeTag, "note-tag");
  assert.equal(result.updates[1].recordChangeTag, "drawing-tag");
});

test("accepts the project's default Notes folder record name", () => {
  const f = fixture();
  f.options.entry.folderRecordName = "DefaultFolder-CloudKit";
  f.note.parentRecordName = "DefaultFolder-CloudKit";
  f.note.fields.Folder!.value = { recordName: "DefaultFolder-CloudKit" };
  assert.equal(prepareDrawingTitleRename(f.note, f.attachment, f.options).ok, true);
});

const refusals: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ["changed local body", f => { f.options.localText += "edited"; }],
  ["missing base", f => { Object.assign(f.options, { baseText: undefined }); }],
  ["stale note", f => { f.note.recordChangeTag = "newer"; }],
  ["missing note CAS", f => { delete f.note.recordChangeTag; }],
  ["missing attachment CAS", f => { delete f.attachment.recordChangeTag; }],
  ["wrong note identity", f => { f.note.recordName = attachmentId; }],
  ["wrong attachment identity", f => { f.attachment.recordName = folderId; }],
  ["wrong record type", f => { f.attachment.recordType = "Note"; }],
  ["same note and attachment identity", f => {
    f.options.recordName = attachmentId;
    f.note.recordName = attachmentId;
    f.attachment.parentRecordName = attachmentId;
    f.attachment.fields.Note!.value = { recordName: attachmentId };
  }],
  ["shared state", f => { Object.assign(f.options.entry, { sharedZoneOwner: "other" }); }],
  ["deferred pull rename", f => { Object.assign(f.options.entry, { pendingRename: "Remote title.md" }); }],
  ["shared cloud note", f => { f.note.shareRecordName = "share"; }],
  ["shared cloud drawing", f => { f.attachment.shareRecordName = "share"; }],
  ["deleted note", f => { f.note.deleted = true; }],
  ["deleted drawing", f => { f.attachment.fields.Deleted!.value = 1; }],
  ["unknown deletion state", f => { delete f.attachment.fields.Deleted; }],
  ["changed folder", f => { f.note.fields.Folder!.value = { recordName: attachmentId }; }],
  ["changed note parent", f => { f.note.parentRecordName = attachmentId; }],
  ["changed drawing owner", f => { f.attachment.fields.Note!.value = { recordName: folderId }; }],
  ["changed drawing parent", f => { f.attachment.parentRecordName = folderId; }],
  ["unsupported attachment", f => { f.attachment.fields.UTI!.value = "public.jpeg"; }],
  ["text as asset", f => { f.note.fields.TextDataAsset = { type: "ASSETID", value: { size: 1 } }; }],
  ["missing body", f => { delete f.note.fields.TextDataEncrypted; }],
  ["invalid body", f => { f.note.fields.TextDataEncrypted!.value = "not-a-document"; }],
  ["empty title", f => { f.options.newTitle = " "; }],
  ["multiline title", f => { f.options.newTitle = "New\ntitle"; }],
  ["object placeholder title", f => { f.options.newTitle = "\uFFFC"; }],
  ["invalid date", f => { f.options.modificationDateMs = NaN; }],
];
for (const [name, change] of refusals) {
  test(`refuses ${name} without preparing updates`, () => {
    const f = fixture();
    change(f);
    const result = prepareDrawingTitleRename(f.note, f.attachment, f.options);
    assert.equal(result.ok, false);
    assert.equal("updates" in result, false);
  });
}

for (const [text, count] of [["\uFFFC\nProse", 1], ["\uFFFC\uFFFC\n", 2]] as const) {
  test(`refuses unsupported drawing document ${JSON.stringify(text)}`, () => {
    const f = fixture(text, count);
    assert.equal(prepareDrawingTitleRename(f.note, f.attachment, f.options).ok, false);
  });
}

for (const [text, accepted] of [["\n\uFFFC\n", false], [" \uFFFC \n", true]] as const) {
  test(`drawing first-line placement ${JSON.stringify(text)} is ${accepted ? "accepted" : "refused"}`, () => {
    const f = fixture();
    const body = create(StringSchema, {
      string: text,
      attributeRun: [
        { length: 1 },
        { length: 1, attachmentInfo: { attachmentIdentifier: attachmentId, typeUTI: "com.apple.paper" } },
        { length: text.length - 2 },
      ],
    });
    const document = create(DocumentSchema, { version: [create(VersionSchema, { data: toBinary(StringSchema, body) })] });
    f.note.fields.TextDataEncrypted!.value = compressNoteDocument(toBinary(DocumentSchema, document)).toString("base64");
    assert.equal(prepareDrawingTitleRename(f.note, f.attachment, f.options).ok, accepted);
  });
}
