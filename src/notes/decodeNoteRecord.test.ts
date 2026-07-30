import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { classifyNoteRecord } from "./decodeNoteRecord.js";
import { compressNoteDocument } from "./noteText.js";
import { StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { UNKNOWN_CONTENT_BANNER } from "./unknownContent.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

function makeRecord(fields: CloudKitRecord["fields"]): CloudKitRecord {
  return { recordName: "R1", recordType: "Note", fields, recordChangeTag: "1a" };
}

function encodeTextField(
  text: string,
  attributeRun: MessageInitShape<typeof StringSchema>["attributeRun"] = [],
): CloudKitRecord["fields"][string] {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, {
        minimumSupportedVersion: 0,
        data: toBinary(StringSchema, create(StringSchema, { string: text, attributeRun })),
      }),
    ],
  });
  const compressed = compressNoteDocument(toBinary(VersionedDocumentSchema, message));
  return { value: Buffer.from(compressed).toString("base64"), type: "ENCRYPTED_BYTES" };
}

// Real `TextDataEncrypted` captured live from "Call with Janice Elkins", a
// note with a single audio attachment (dev notes, 2026-07-13T21:54). Its
// Note record has no ASSETID-typed field anywhere - the attachment only
// shows up as an AttachmentInfo run embedded in this compressed body.
const AUDIO_ATTACHMENT_TEXT_DATA =
  "H4sIAAAAAAAAE+NgEPrMyMEgwCD1hlFI2jkxJ0ehPLMkQ8ErMS8zOVXBNSc7M6+Y6/3+PVICXCwgdUCVYFqDESzCCBSRlALTGkxSYlwcQLn/QMAPVAdnK8lwSXEJJPhc2rlRw0G3ods/UnqB/1chJg5JIGbUkuOQEBLhYPASmH4r88mnYucbq8RWvT250oY/Y8XpVSfYtII5GIWEvAR2M+dLZK9xldxU0u6seOnrhiRrLhVzF0c3F0czN10TR2cTXRNDFwtdS0tTC10DE0tjc2MnCwMLIxMh4eT8XL3EgoKcVL1ck0TdxNKUzHwAzdJGOPgAAAA=";

// Real `TextDataEncrypted` captured live from "Test Note" after adding a
// single image attachment (dev notes, 2026-07-14). Unlike the audio note,
// this Note record *does* carry a FirstAttachmentThumbnail ASSETID field.
const IMAGE_ATTACHMENT_TEXT_DATA =
  "H4sIAAAAAAAAE23STWgTQRQH8GzSNJupNZNNmrabCENRWQIbQkybopd+2IBFDEoR6sWYZGvSxmzY7LZdP2oRoQehogeh4qGCFoWCH6AglHoRpQoitRRPPYgnlfZQetKiL9tn8NBllxl+M++/j2F4m/DDxduoTfzmEswBpaKzE6qukIF8ocLgPcf0qpXA2JCqMaOisLGCnmfpQraoGjm5ulKRK2Ypm2a6ykYVrTBkMj2vME01SjlZ1wplNqZqIxWWVTVNyepFM0JIj6KUWUZVy4RsvF4gIiV11S6gD2uUOEs4kA7RGiU7SoJyKA6UI7QBpU4ULEnS0I4wTnKiKdRZs3qr0gHpQdEaJRdmDdeyeKzLULslbqhzo+X+9QBG0DpxHw/WgHb4v3170Dpq/TdKHuuvdVSnBMxO3dJeS5zQGYcSQtFrQq0kJzVQgpDuRRtFE8EEtDG0VjAf2jhaC5gfzURrBmtCu4gWAAugXUJrAmtGu4zmB2tBu4LmA2tFm0ATwES0q2hesKDoJU6YT3LWcdppCA4gQHi4FH/g8cAFqc3bpjkiEnrgVOPgy+171+0Hj009plvdgp034CMkSGj6+PKrZ1KXPHkjNRicTW0JDv4aB4v7qoV3cm2f1+bNpffvfv1cWHSs1gph7e6o2+g64/N8XR3vebv0fA58Aj6uGvqkeGv8xf1+89PM90cfNn+vQOhkNdQdbuGJ4Odt/ZStrc/NzKYuTD/c2P4YcLvCAX5EEPrp081e282VVOT22fUHoanTzvBJntvNM4fI/kTf0c5oLBGX4/FoVI73RmNyZ6KvW062x2PJaHtHMhmNCQ1lI1MsZCPDZeV8/s38l+X6cGj3yJ3Vvzm/RsfwAwAA";

test("a plain-text note decodes as ok with no attachments", () => {
  const record = makeRecord({ TextDataEncrypted: encodeTextField("Grocery list\nEggs\nMilk") });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.bodyText, "Grocery list\nEggs\nMilk");
  // No attribute runs means every line is a plain Body paragraph, and the
  // markdown rendering is the text itself.
  assert.equal(result.markdownText, "Grocery list\nEggs\nMilk");
  assert.deepEqual(result.embedSlots, []);
  assert.deepEqual(result.attachments, []);
  assert.equal(result.publishable, true);
  assert.deepEqual(
    result.format?.map((paragraph) => paragraph.kind),
    ["body", "body", "body"],
  );
});

test("a real audio-attachment note decodes as ok, surfacing the embedded attachment reference", () => {
  const record = makeRecord({ TextDataEncrypted: { value: AUDIO_ATTACHMENT_TEXT_DATA, type: "ENCRYPTED_BYTES" } });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.match(result.bodyText, /Call with Janice Elkins/);
  assert.deepEqual(result.attachments, [
    { attachmentIdentifier: "7DAFDA6F-4AC4-41D8-9958-049373B80824", typeUti: "com.apple.m4a-audio" },
  ]);
  assert.equal(result.publishable, true);
});

test("a real image-attachment note decodes as ok, surfacing the embedded attachment reference", () => {
  const record = makeRecord({
    TextDataEncrypted: { value: IMAGE_ATTACHMENT_TEXT_DATA, type: "ENCRYPTED_BYTES" },
    FirstAttachmentThumbnail: { value: { fileChecksum: "x" }, type: "ASSETID" },
  });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.attachments, [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ]);
  assert.equal(result.publishable, true);
});

test("a placeholder character with no matching attachment run becomes an unknown embed slot, still publishable", () => {
  // Synthetic: a U+FFFC placeholder with no AttachmentInfo run behind it.
  // Its *position* is still exact, so since Step 1 of the formatting plan
  // (2026-07-17) it's localized as an `unknown` slot (pull renders an inline
  // marker there) instead of banner-marking the whole note.
  const record = makeRecord({ TextDataEncrypted: encodeTextField("Some note\n\uFFFC") });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.bodyText, "Some note\n\uFFFC");
  assert.equal(result.markdownText, "Some note\n\uFFFC");
  assert.deepEqual(result.embedSlots, [{ kind: "unknown", typeUti: undefined }]);
  assert.deepEqual(result.attachments, []);
  assert.equal(result.publishable, true);
});

test("a partially-identified attachment run yields an unknown slot carrying its UTI", () => {
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("Title\n\uFFFC", [
      { length: 6 },
      { length: 1, attachmentInfo: { typeUTI: "com.apple.drawing.2" } },
    ]),
  });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.embedSlots, [{ kind: "unknown", typeUti: "com.apple.drawing.2" }]);
  assert.deepEqual(result.attachments, []);
  assert.equal(result.publishable, true);
});

test("an attachmentInfo run not sitting on a lone placeholder banner-marks the note as unpublishable", () => {
  // Structural weirdness: the attachment run covers two characters, so no
  // placeholder position can be trusted - the whole-note banner remains for
  // exactly this case.
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("Hi\n\uFFFC", [
      { length: 2 },
      { length: 2, attachmentInfo: { attachmentIdentifier: "A-1", typeUTI: "public.jpeg" } },
    ]),
  });
  assert.deepEqual(classifyNoteRecord(record), {
    status: "ok",
    title: "",
    titleLine: "Hi",
    bodyText: `${UNKNOWN_CONTENT_BANNER}Hi\n\uFFFC`,
    markdownText: `${UNKNOWN_CONTENT_BANNER}Hi\n\uFFFC`,
    format: undefined,
    embedSlots: [],
    attachments: [],
    publishable: false,
    unpublishableReason: "contains unrecognized embedded content this tool couldn't parse or place precisely",
  });
});

test("a note missing TextDataEncrypted is undecodable", () => {
  const record = makeRecord({});
  assert.deepEqual(classifyNoteRecord(record), { status: "unsyncable", reason: "undecodable" });
});

test("a note explicitly marked Deleted is deleted", () => {
  const record = makeRecord({ Deleted: { value: 1, type: "INT64" } });
  assert.deepEqual(classifyNoteRecord(record), { status: "deleted" });
});

test("a note in the Trash folder is treated as deleted", () => {
  const record = makeRecord({
    Folder: { value: { recordName: "TrashFolder-CloudKit" }, type: "REFERENCE" },
  });
  assert.deepEqual(classifyNoteRecord(record), { status: "deleted" });
});

test("a note with trailing spaces stays publishable; the rendering trims them", () => {
  // Regression: the round-trip gate once compared the reparse against the
  // raw bodyText, so any device-typed trailing space made the whole note
  // read-only the moment trimming entered the projection (2026-07-29).
  const record = makeRecord({ TextDataEncrypted: encodeTextField("Title \nFried Egg \nplain") });
  const result = classifyNoteRecord(record);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.publishable, true, result.status === "ok" ? result.unpublishableReason : undefined);
  assert.equal(result.bodyText, "Title \nFried Egg \nplain");
  assert.equal(result.markdownText, "Title\nFried Egg\nplain");
});

// --- filename-as-title stripping -------------------------------------------

test("filename mode leaves the title paragraph out of the markdown", () => {
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("My Note\n\nBody text", [
      { length: 8, paragraphStyle: { style: 0 } },
      { length: 10, paragraphStyle: { style: 3 } },
    ]),
  });

  const inBody = classifyNoteRecord(record);
  const filename = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(inBody.status === "ok" ? inBody.markdownText : "", "# My Note\n\nBody text");
  assert.equal(filename.status === "ok" ? filename.markdownText : "", "\nBody text");
  assert.equal(filename.status === "ok" ? filename.titleStripped : undefined, true);
  assert.equal(inBody.status === "ok" ? inBody.titleStripped : undefined, false);
});

test("the whole formatting model survives stripping, so push can put the title back", () => {
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("My Note\nBody text", [
      { length: 8, paragraphStyle: { style: 0 } },
      { length: 9, paragraphStyle: { style: 3 } },
    ]),
  });

  const result = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.format?.length, 2, "format keeps the title paragraph even though markdownText drops it");
  assert.equal(result.format?.[0]?.kind, "title");
  assert.equal(result.format?.[0]?.text, "My Note");
});

test("titleLine is the note's real first line, not Apple's truncated title metadata", () => {
  const longFirstLine = "A first line that runs well past the seventy-six characters Apple truncates its title metadata at";
  const record = makeRecord({
    TextDataEncrypted: encodeTextField(`${longFirstLine}\nBody`, [
      { length: longFirstLine.length + 1, paragraphStyle: { style: 0 } },
      { length: 4, paragraphStyle: { style: 3 } },
    ]),
    TitleEncrypted: { value: Buffer.from(longFirstLine.slice(0, 76), "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" },
  });

  const result = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.titleLine, longFirstLine);
  assert.notEqual(result.title, result.titleLine, "the cosmetic title really is the truncated one");
});

// The trap: dropping the first *line* of a note whose first paragraph is
// monospaced would leave an unbalanced code fence.
test("a monospaced first paragraph strips without corrupting the fence", () => {
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("code one\ncode two", [
      { length: 9, paragraphStyle: { style: 4 } },
      { length: 8, paragraphStyle: { style: 4 } },
    ]),
  });

  const result = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal((result.markdownText.match(/```/g) ?? []).length % 2, 0, result.markdownText);
});

test("a title paragraph holding an embed placeholder is never stripped", () => {
  // Stripping it would orphan the attachment reference - there'd be no file
  // left to carry it.
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("￼\nBody text", [
      { length: 1, attachmentInfo: { attachmentIdentifier: "A-1", typeUTI: "public.jpeg" } },
      { length: 10, paragraphStyle: { style: 3 } },
    ]),
  });

  const result = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.titleStripped, false, "the note keeps its title in the body rather than losing the embed");
  assert.ok(result.markdownText.includes("￼"));
});

test("a single-line note strips to an empty body", () => {
  const record = makeRecord({
    TextDataEncrypted: encodeTextField("Just a title", [{ length: 12, paragraphStyle: { style: 0 } }]),
  });

  const result = classifyNoteRecord(record, { titleMode: "filename" });

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.markdownText, "");
  assert.equal(result.titleStripped, true);
  assert.equal(result.publishable, true, "an empty body is a title-only note, not an unsyncable one");
});
