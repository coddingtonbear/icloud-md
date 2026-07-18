import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { compressNoteDocument } from "./noteText.js";
import {
  decodeAttachmentFilename,
  decodeNoteAttachmentRefs,
  decodeNoteEmbedSlots,
  formatAttachmentMarkdown,
  hasAttachmentReference,
  isImageUti,
  isTableUti,
  parseAssetField,
  renderAttachmentPlaceholders,
  renderPlaceholders,
  type AttachmentReference,
} from "./noteAttachments.js";

function encodeNoteBody(
  text: string,
  attributeRun: MessageInitShape<typeof StringSchema>["attributeRun"] = [],
): Buffer {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, {
        minimumSupportedVersion: 0,
        data: toBinary(StringSchema, create(StringSchema, { string: text, attributeRun })),
      }),
    ],
  });
  return compressNoteDocument(toBinary(VersionedDocumentSchema, message));
}

// Real `TextDataEncrypted` captured live from "Call with Janice Elkins", a
// note with a single audio attachment (dev notes, 2026-07-13T21:54).
const AUDIO_ATTACHMENT_TEXT_DATA =
  "H4sIAAAAAAAAE+NgEPrMyMEgwCD1hlFI2jkxJ0ehPLMkQ8ErMS8zOVXBNSc7M6+Y6/3+PVICXCwgdUCVYFqDESzCCBSRlALTGkxSYlwcQLn/QMAPVAdnK8lwSXEJJPhc2rlRw0G3ods/UnqB/1chJg5JIGbUkuOQEBLhYPASmH4r88mnYucbq8RWvT250oY/Y8XpVSfYtII5GIWEvAR2M+dLZK9xldxU0u6seOnrhiRrLhVzF0c3F0czN10TR2cTXRNDFwtdS0tTC10DE0tjc2MnCwMLIxMh4eT8XL3EgoKcVL1ck0TdxNKUzHwAzdJGOPgAAAA=";

// Real `TextDataEncrypted` captured live from "Test Note" after adding a
// single image attachment (dev notes, 2026-07-14).
const IMAGE_ATTACHMENT_TEXT_DATA =
  "H4sIAAAAAAAAE23STWgTQRQH8GzSNJupNZNNmrabCENRWQIbQkybopd+2IBFDEoR6sWYZGvSxmzY7LZdP2oRoQehogeh4qGCFoWCH6AglHoRpQoitRRPPYgnlfZQetKiL9tn8NBllxl+M++/j2F4m/DDxduoTfzmEswBpaKzE6qukIF8ocLgPcf0qpXA2JCqMaOisLGCnmfpQraoGjm5ulKRK2Ypm2a6ykYVrTBkMj2vME01SjlZ1wplNqZqIxWWVTVNyepFM0JIj6KUWUZVy4RsvF4gIiV11S6gD2uUOEs4kA7RGiU7SoJyKA6UI7QBpU4ULEnS0I4wTnKiKdRZs3qr0gHpQdEaJRdmDdeyeKzLULslbqhzo+X+9QBG0DpxHw/WgHb4v3170Dpq/TdKHuuvdVSnBMxO3dJeS5zQGYcSQtFrQq0kJzVQgpDuRRtFE8EEtDG0VjAf2jhaC5gfzURrBmtCu4gWAAugXUJrAmtGu4zmB2tBu4LmA2tFm0ATwES0q2hesKDoJU6YT3LWcdppCA4gQHi4FH/g8cAFqc3bpjkiEnrgVOPgy+171+0Hj009plvdgp034CMkSGj6+PKrZ1KXPHkjNRicTW0JDv4aB4v7qoV3cm2f1+bNpffvfv1cWHSs1gph7e6o2+g64/N8XR3vebv0fA58Aj6uGvqkeGv8xf1+89PM90cfNn+vQOhkNdQdbuGJ4Odt/ZStrc/NzKYuTD/c2P4YcLvCAX5EEPrp081e282VVOT22fUHoanTzvBJntvNM4fI/kTf0c5oLBGX4/FoVI73RmNyZ6KvW062x2PJaHtHMhmNCQ1lI1MsZCPDZeV8/s38l+X6cGj3yJ3Vvzm/RsfwAwAA";

test("decodeNoteAttachmentRefs finds the embedded audio attachment reference", () => {
  const refs = decodeNoteAttachmentRefs(Buffer.from(AUDIO_ATTACHMENT_TEXT_DATA, "base64"));
  assert.deepEqual(refs, [{ attachmentIdentifier: "7DAFDA6F-4AC4-41D8-9958-049373B80824", typeUti: "com.apple.m4a-audio" }]);
});

test("decodeNoteAttachmentRefs finds the embedded image attachment reference", () => {
  const refs = decodeNoteAttachmentRefs(Buffer.from(IMAGE_ATTACHMENT_TEXT_DATA, "base64"));
  assert.deepEqual(refs, [{ attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" }]);
});

test("decodeNoteEmbedSlots localizes the real audio attachment as an attachment slot", () => {
  const slots = decodeNoteEmbedSlots(Buffer.from(AUDIO_ATTACHMENT_TEXT_DATA, "base64"));
  assert.deepEqual(slots, [
    { kind: "attachment", ref: { attachmentIdentifier: "7DAFDA6F-4AC4-41D8-9958-049373B80824", typeUti: "com.apple.m4a-audio" } },
  ]);
});

test("decodeNoteEmbedSlots maps placeholders by offset, mixing identified and unknown slots", () => {
  // "T\n￼\nmid\n￼" - first placeholder has a full attachmentInfo run, the
  // second has none at all. Count-correlation would have mispaired these;
  // offsets don't.
  const body = encodeNoteBody("T\n￼\nmid\n￼", [
    { length: 2 },
    { length: 1, attachmentInfo: { attachmentIdentifier: "A-1", typeUTI: "public.jpeg" } },
    { length: 5 },
  ]);
  assert.deepEqual(decodeNoteEmbedSlots(body), [
    { kind: "attachment", ref: { attachmentIdentifier: "A-1", typeUti: "public.jpeg" } },
    { kind: "unknown", typeUti: undefined },
  ]);
});

test("decodeNoteEmbedSlots carries a partial attachmentInfo's UTI into the unknown slot", () => {
  const body = encodeNoteBody("x￼", [{ length: 1 }, { length: 1, attachmentInfo: { typeUTI: "com.apple.drawing.2" } }]);
  assert.deepEqual(decodeNoteEmbedSlots(body), [{ kind: "unknown", typeUti: "com.apple.drawing.2" }]);
});

test("decodeNoteEmbedSlots returns undefined when an attachmentInfo run isn't a lone placeholder", () => {
  const overlong = encodeNoteBody("x￼y", [
    { length: 1 },
    { length: 2, attachmentInfo: { attachmentIdentifier: "A", typeUTI: "public.jpeg" } },
  ]);
  assert.equal(decodeNoteEmbedSlots(overlong), undefined);

  const offPlaceholder = encodeNoteBody("xy", [
    { length: 1 },
    { length: 1, attachmentInfo: { attachmentIdentifier: "A", typeUTI: "public.jpeg" } },
  ]);
  assert.equal(decodeNoteEmbedSlots(offPlaceholder), undefined);
});

test("decodeNoteEmbedSlots returns undefined when run lengths overshoot the text", () => {
  const body = encodeNoteBody("hi", [{ length: 5 }]);
  assert.equal(decodeNoteEmbedSlots(body), undefined);
});

test("decodeNoteEmbedSlots tolerates an under-covering (or absent) run table", () => {
  assert.deepEqual(decodeNoteEmbedSlots(encodeNoteBody("plain text")), []);
  assert.deepEqual(decodeNoteEmbedSlots(encodeNoteBody("tail ￼", [{ length: 2 }])), [
    { kind: "unknown", typeUti: undefined },
  ]);
});

test("isImageUti recognizes known image UTIs and rejects others", () => {
  assert.equal(isImageUti("public.jpeg"), true);
  assert.equal(isImageUti("public.png"), true);
  assert.equal(isImageUti("com.apple.m4a-audio"), false);
  assert.equal(isImageUti("com.adobe.pdf"), false);
});

test("renderAttachmentPlaceholders embeds images and links everything else", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "A", typeUti: "public.jpeg" },
    { attachmentIdentifier: "B", typeUti: "com.apple.m4a-audio" },
  ];
  const result = renderAttachmentPlaceholders("Title\n\uFFFC\n\uFFFC\n", refs, [
    "attachments/photo.jpeg",
    "attachments/call.m4a",
  ]);
  assert.equal(result, "Title\n![photo.jpeg](attachments/photo.jpeg)\n[call.m4a](attachments/call.m4a)\n");
});

test("renderAttachmentPlaceholders percent-encodes path segments with spaces", () => {
  const refs: AttachmentReference[] = [{ attachmentIdentifier: "A", typeUti: "com.apple.m4a-audio" }];
  const result = renderAttachmentPlaceholders("\uFFFC", refs, ["attachments/Call with Janice Elkins.m4a"]);
  assert.equal(result, "[Call with Janice Elkins.m4a](attachments/Call%20with%20Janice%20Elkins.m4a)");
});

test("renderAttachmentPlaceholders is a no-op with no attachments", () => {
  assert.equal(renderAttachmentPlaceholders("Plain text", [], []), "Plain text");
});

test("renderAttachmentPlaceholders throws on a ref/file count mismatch", () => {
  assert.throws(
    () => renderAttachmentPlaceholders("\uFFFC", [{ attachmentIdentifier: "A", typeUti: "public.jpeg" }], []),
    /doesn't match/,
  );
});

test("decodeAttachmentFilename decodes a base64 FilenameEncrypted field", () => {
  const field = { value: Buffer.from("photo.jpg", "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" };
  assert.equal(decodeAttachmentFilename(field, "REC1", "public.jpeg"), "photo.jpg");
});

test("decodeAttachmentFilename falls back to a synthesized name when absent", () => {
  assert.equal(decodeAttachmentFilename(undefined, "REC1", "public.jpeg"), "REC1.jpeg");
  assert.equal(decodeAttachmentFilename(undefined, "REC2", "com.apple.m4a-audio"), "REC2.m4a");
  assert.equal(decodeAttachmentFilename(undefined, "REC3", "some.unknown.uti"), "REC3");
});

test("parseAssetField extracts downloadURL and fileChecksum from an ASSETID field", () => {
  const field = {
    value: { downloadURL: "https://cvws.icloud-content.com/x", fileChecksum: "abc123", size: 42 },
    type: "ASSETID",
  };
  assert.deepEqual(parseAssetField(field), { downloadURL: "https://cvws.icloud-content.com/x", fileChecksum: "abc123" });
});

test("parseAssetField returns undefined for non-ASSETID or malformed fields", () => {
  assert.equal(parseAssetField(undefined), undefined);
  assert.equal(parseAssetField({ value: "not an object", type: "ASSETID" }), undefined);
  assert.equal(parseAssetField({ value: { downloadURL: "x" }, type: "ASSETID" }), undefined);
  assert.equal(parseAssetField({ value: { downloadURL: "x", fileChecksum: "y" }, type: "STRING" }), undefined);
});

test("isTableUti recognizes the table UTI and rejects file UTIs", () => {
  assert.equal(isTableUti("com.apple.notes.table"), true);
  assert.equal(isTableUti("public.jpeg"), false);
  assert.equal(isTableUti("com.apple.m4a-audio"), false);
});

test("formatAttachmentMarkdown matches what renderAttachmentPlaceholders produces per-ref", () => {
  const ref: AttachmentReference = { attachmentIdentifier: "A", typeUti: "public.jpeg" };
  assert.equal(formatAttachmentMarkdown(ref, "attachments/photo.jpeg"), "![photo.jpeg](attachments/photo.jpeg)");
});

test("renderPlaceholders substitutes a mix of table markdown and file links by position", () => {
  const result = renderPlaceholders("Title\n￼\n￼\n", ["| a | b |\n| --- | --- |", "[call.m4a](attachments/call.m4a)"]);
  assert.equal(result, "Title\n| a | b |\n| --- | --- |\n[call.m4a](attachments/call.m4a)\n");
});

test("renderPlaceholders leaves a placeholder untouched when its replacement is undefined", () => {
  const result = renderPlaceholders("￼￼", ["resolved", undefined]);
  assert.equal(result, "resolved￼");
});

test("renderPlaceholders is a no-op with no replacements", () => {
  assert.equal(renderPlaceholders("Plain text", []), "Plain text");
});

test("hasAttachmentReference detects a hand-typed attachments/ link or embed", () => {
  assert.equal(hasAttachmentReference("See ![photo](attachments/photo.jpg) above"), true);
  assert.equal(hasAttachmentReference("See [file](attachments/notes.pdf) above"), true);
  assert.equal(hasAttachmentReference("Just plain text"), false);
  assert.equal(hasAttachmentReference("A [normal link](https://example.com) is fine"), false);
});
