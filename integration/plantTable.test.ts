/**
 * Offline coverage for the live suite's table planter, on captured bytes.
 * Runs under plain `npm test` - no account, no network.
 *
 * The live test it supports asserts things about *editing* a table. That only
 * means anything if the thing it starts from is a genuine, well-formed
 * table-bearing note; a planter that quietly produced a malformed body would
 * make the live test fail for a reason that has nothing to do with the write
 * path (or, worse, skip past a refusal and pass having proved nothing). So
 * these tests establish, without a network, that the planted document is one
 * this project's own read and write paths both accept:
 *
 *   - it round-trips byte-for-byte and satisfies the document invariants,
 *   - production decode finds exactly one table embed slot, pointed at our
 *     attachment id, on a length-1 attribute run,
 *   - the note is publishable, and
 *   - rendering it to markdown and planning a push straight back reconstructs
 *     the identical body text - i.e. planting a table does not, by itself,
 *     leave a vault with a phantom pending change.
 *
 * The Apple-shaped-ness of the plant (that Apple's own client accepts and
 * renders it) is not something offline tests can establish; that is the live
 * test's first assertion, before any edit.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { classifyNoteRecord } from "../src/notes/decodeNoteRecord.js";
import { decodeTableMarkdown } from "../src/notes/decodeTableRecord.js";
import { planEmbedRepresentations } from "../src/notes/embedPushEdit.js";
import { decodeNoteEmbedSlots, renderPlaceholders, TABLE_UTI } from "../src/notes/noteAttachments.js";
import {
  buildInitialNoteDocument,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
  validateDocumentInvariants,
} from "../src/notes/noteDocument.js";
import { ParagraphStyleSchema } from "../src/notes/gen/topotext_pb.js";
import { compressNoteDocument } from "../src/notes/noteText.js";
import { TABLE_REV_BASELINE } from "../src/notes/realFixtures.js";
import type { CloudKitRecord } from "../src/cloudkit/databaseClient.js";
import { buildTableAttachmentFields, buildTableEmbedInsertion } from "./plantTable.js";

const REPLICA = new Uint8Array(Array.from({ length: 16 }, (_, i) => 0xb0 + i));
const ATTACHMENT_ID = "3f1c9e64-0a2d-4a77-8f3e-1d0c5b7a9e21";
const NOTE_ID = "5a2b8c10-77de-4f1a-9c33-6b0e2d4a8f57";

/** What `push` writes for a freshly created fixture note - the real starting point. */
const NOTE_TEXT = "(itest-ab12cd) table canary\n\nprose above the table\n";

function plantedDocument(text = NOTE_TEXT): ReturnType<typeof buildTableEmbedInsertion> {
  return buildTableEmbedInsertion(encodeNoteDocument(buildInitialNoteDocument(text, REPLICA)), ATTACHMENT_ID, REPLICA);
}

function noteRecord(compressedBase64: string): CloudKitRecord {
  return {
    recordName: NOTE_ID,
    recordType: "Note",
    recordChangeTag: "1a",
    fields: { TextDataEncrypted: { value: compressedBase64, type: "ENCRYPTED_BYTES" } },
  };
}

test("the planted note document round-trips byte-for-byte and holds its invariants", () => {
  const planted = plantedDocument();
  assert.equal(noteDocumentRoundTrips(planted.raw), true);
  assert.doesNotThrow(() => validateDocumentInvariants(parseNoteDocument(planted.raw)));
  assert.equal(planted.newText, `${NOTE_TEXT}\n￼\n`);
  assert.equal(planted.newText[planted.placeholderIndex], "￼");
});

test("the placeholder gets its own length-1 attribute run carrying the attachment", () => {
  const planted = plantedDocument();
  const doc = parseNoteDocument(planted.raw);

  const carriers = doc.attributeRuns.filter((run) => run.attachmentInfo !== undefined);
  assert.equal(carriers.length, 1, "exactly one run should carry an attachment");
  const carrier = carriers[0]!;
  assert.equal(carrier.length, 1, "an attachmentInfo run must cover exactly its placeholder - Apple never writes a longer one");
  assert.equal(carrier.attachmentInfo?.attachmentIdentifier, ATTACHMENT_ID);
  assert.equal(carrier.attachmentInfo?.typeUTI, TABLE_UTI);
  assert.equal(carrier.paragraphStyle, undefined, "captured table embeds sit in a plain Body paragraph");

  // The carrier must be positioned on the placeholder, and the runs must
  // still tile the text exactly.
  let offset = 0;
  for (const run of doc.attributeRuns) {
    if (run === carrier) {
      break;
    }
    offset += run.length;
  }
  assert.equal(offset, planted.placeholderIndex, "the attachment run should sit on the placeholder character");
  assert.equal(
    doc.attributeRuns.reduce((sum, run) => sum + run.length, 0),
    doc.text.length,
  );
});

test("a table would not be planted into a styled paragraph", () => {
  // A note whose last line is a bullet would otherwise hand the placeholder
  // that list style, producing a table shape Apple has never been seen to
  // write - and a live failure that looks like a decoder bug.
  const doc = buildInitialNoteDocument("(itest-ab12cd) styled canary\n\n- a bullet\n", REPLICA);
  const styled = doc.attributeRuns[doc.attributeRuns.length - 1];
  assert.ok(styled !== undefined);
  styled.paragraphStyle = create(ParagraphStyleSchema, { style: 100 });

  assert.throws(
    () => buildTableEmbedInsertion(encodeNoteDocument(doc), ATTACHMENT_ID, REPLICA),
    /style 100/,
    "planting into a list paragraph should be refused, not guessed at",
  );
});

test("production decode sees exactly one table slot on the planted note", () => {
  const compressed = compressNoteDocument(plantedDocument().raw);
  const slots = decodeNoteEmbedSlots(compressed);
  assert.ok(slots !== undefined, "the embed structure should be one decodeNoteEmbedSlots can map");
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0], { kind: "attachment", ref: { attachmentIdentifier: ATTACHMENT_ID, typeUti: TABLE_UTI } });
});

test("the planted note classifies as publishable, with its placeholder intact", () => {
  const compressed = compressNoteDocument(plantedDocument().raw);
  const classified = classifyNoteRecord(noteRecord(Buffer.from(compressed).toString("base64")));
  assert.equal(classified.status, "ok");
  assert.equal(classified.publishable, true, `should stay pushable: ${classified.unpublishableReason}`);
  assert.equal(classified.attachments.length, 1);
  assert.ok(classified.markdownText.includes("￼"), "the placeholder should survive into the rendered markdown");
});

test("rendering the table in and planning a push back reconstructs the same body", () => {
  // The full local round trip a vault performs: pull substitutes the decoded
  // table for the placeholder, and an unedited push must reconstruct exactly
  // the body text the record already holds. If these differ, every table test
  // would start from a vault that believes it has a pending change.
  const compressed = compressNoteDocument(plantedDocument().raw);
  const classified = classifyNoteRecord(noteRecord(Buffer.from(compressed).toString("base64")));
  assert.equal(classified.status, "ok");

  const tableMarkdown = decodeTableMarkdown(Buffer.from(TABLE_REV_BASELINE, "base64"));
  const localText = renderPlaceholders(classified.markdownText, [tableMarkdown]);
  assert.ok(localText.includes("| R0C0 | R0C1 |"), `the table should render into the file: ${JSON.stringify(localText)}`);

  const plan = planEmbedRepresentations(localText, classified.embedSlots, new Set());
  assert.equal(plan.ok, true, plan.ok ? "" : plan.reason);
  assert.ok(plan.ok);
  assert.equal(plan.reconstructedBodyText, classified.markdownText, "an untouched table must plan back to an identical body");
  assert.equal(plan.tables.length, 1);
  assert.equal(plan.tables[0]?.ref.attachmentIdentifier, ATTACHMENT_ID);
  assert.deepEqual(plan.tables[0]?.block.grid[0], ["R0C0", "R0C1", "R0C2", "R0C3", "R0C4"]);
});

test("a local table edit plans back as a changed grid and an unchanged body", () => {
  // The shape every live edit test relies on: editing a cell must reach the
  // table attachment only, leaving the note record's own text alone.
  const compressed = compressNoteDocument(plantedDocument().raw);
  const classified = classifyNoteRecord(noteRecord(Buffer.from(compressed).toString("base64")));
  assert.equal(classified.status, "ok");

  const tableMarkdown = decodeTableMarkdown(Buffer.from(TABLE_REV_BASELINE, "base64"));
  const edited = renderPlaceholders(classified.markdownText, [tableMarkdown.replace("R2C1", "R2C1-edited")]);

  const plan = planEmbedRepresentations(edited, classified.embedSlots, new Set());
  assert.ok(plan.ok);
  assert.equal(plan.reconstructedBodyText, classified.markdownText, "a cell edit must not disturb the note's own text");
  assert.equal(plan.tables[0]?.block.grid[1]?.[1], "R2C1-edited");
});

test("a planter refuses a note that already carries an embed", () => {
  const planted = plantedDocument();
  assert.throws(
    () => buildTableEmbedInsertion(planted.raw, ATTACHMENT_ID, REPLICA),
    /already carries an embed/,
    "planting twice would make the placeholder-to-slot correspondence ambiguous",
  );
});

test("the attachment record carries Apple's captured field set", () => {
  // Copied from entry 39 of har_captures/2026-07-16_note-lifecycle-create-table-delete.har,
  // the create Apple's own web client sent when a user inserted a table.
  const fields = buildTableAttachmentFields(NOTE_ID, "Notes", TABLE_REV_BASELINE, 1_784_216_547_986);
  assert.deepEqual(Object.keys(fields).sort(), [
    "CreationDate",
    "EncryptedValues",
    "EncryptedValuesAsset",
    "MergeableDataAsset",
    "MergeableDataEncrypted",
    "MinimumSupportedNotesVersion",
    "Note",
    "TitleEncrypted",
    "UTI",
    "UTIEncrypted",
  ]);
  assert.deepEqual(fields.Note?.value, { action: "VALIDATE", recordName: NOTE_ID, zoneID: { zoneName: "Notes" } });
  assert.equal(fields.UTI?.value, TABLE_UTI);
  assert.equal(fields.UTIEncrypted?.value, Buffer.from(TABLE_UTI, "utf-8").toString("base64"));
  assert.equal(fields.TitleEncrypted?.value, Buffer.from("Table", "utf-8").toString("base64"));
  assert.equal(fields.MinimumSupportedNotesVersion?.value, 2);
  assert.equal(fields.MergeableDataEncrypted?.value, TABLE_REV_BASELINE, "the payload must be copied through untouched");
  assert.equal(fields.MergeableDataAsset?.value, null);
  assert.equal(fields.EncryptedValues?.value, null);
  assert.equal(fields.EncryptedValuesAsset?.value, null);
});
