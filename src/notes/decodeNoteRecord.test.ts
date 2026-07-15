import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNoteRecord } from "./decodeNoteRecord.js";
import { compressNoteDocument } from "./noteText.js";
import { bytesToken, encodeProtoTokens } from "./protobuf.js";
import { UNKNOWN_CONTENT_BANNER } from "./unknownContent.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

function makeRecord(fields: CloudKitRecord["fields"]): CloudKitRecord {
  return { recordName: "R1", recordType: "Note", fields, recordChangeTag: "1a" };
}

function encodeTextField(text: string): CloudKitRecord["fields"][string] {
  const noteBytes = encodeProtoTokens([bytesToken(2, new TextEncoder().encode(text))]);
  const documentBytes = encodeProtoTokens([bytesToken(3, noteBytes)]);
  const rootBytes = encodeProtoTokens([bytesToken(2, documentBytes)]);
  const compressed = compressNoteDocument(rootBytes);
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
  assert.deepEqual(classifyNoteRecord(record), {
    status: "ok",
    title: "",
    bodyText: "Grocery list\nEggs\nMilk",
    attachments: [],
    publishable: true,
  });
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

test("a placeholder character with no matching attachment run is still written, banner-marked and unpublishable", () => {
  // Synthetic: the U+FFFC placeholder with no AttachmentInfo run behind it -
  // e.g. an embedded object type we don't parse (a table, a drawing). Can't
  // trust a positional correlation that doesn't exist, so we can't localize
  // exactly which placeholder is the problem - fetch it anyway with a
  // whole-note banner, but never allow it to be pushed.
  const record = makeRecord({ TextDataEncrypted: encodeTextField("Some note\n\uFFFC") });
  assert.deepEqual(classifyNoteRecord(record), {
    status: "ok",
    title: "",
    bodyText: `${UNKNOWN_CONTENT_BANNER}Some note\n\uFFFC`,
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
