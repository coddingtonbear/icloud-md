import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { CloneStateNoteEntry } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { compressNoteDocument } from "../notes/noteText.js";
import { parseNoteMarkdown } from "../notes/parseNoteMarkdown.js";
import { prepareNoteTextUpdate, prepareRetitle } from "./push.js";

/**
 * Push against a note whose text Apple keeps in a `TextDataAsset`. Push
 * re-reads records with `lookupRecords`, which doesn't inline asset bodies,
 * so today such a record arrives with no `TextDataEncrypted` at all. These
 * tests cover the record that would arrive if that ever changed - inline
 * text *and* the asset - which every gate has to refuse on the asset alone:
 * the inline text is perfectly editable, and an edit would send it back with
 * `TextDataAsset: null`.
 */

const REPLICA = new Uint8Array(16).fill(7);
const ASSET = { value: { downloadURL: "https://cvws.icloud-content.example/B/asset-1" }, type: "ASSETID" };

function noteRecord(text: string, extraFields: CloudKitRecord["fields"] = {}): CloudKitRecord {
  const compressed = compressNoteDocument(encodeNoteDocument(buildInitialNoteDocument(text, REPLICA)));
  return {
    recordName: "REC1",
    recordType: "Note",
    recordChangeTag: "1a",
    fields: {
      TitleEncrypted: { value: Buffer.from(text.split("\n")[0] ?? "", "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataEncrypted: { value: compressed.toString("base64"), type: "ENCRYPTED_BYTES" },
      ...extraFields,
    },
  };
}

function desired(markdown: string) {
  const parsed = parseNoteMarkdown(markdown);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") {
    throw new Error("unreachable");
  }
  return { text: parsed.text, paragraphs: parsed.paragraphs };
}

const ENTRY: CloneStateNoteEntry = {
  file: "Notes/Big.md",
  recordChangeTag: "1a",
  modificationDate: 100,
  folderRecordName: "DefaultFolder-CloudKit",
};

test("push's note-text gate refuses a record carrying both TextDataEncrypted and TextDataAsset", () => {
  const summary = { conflicts: [] as string[], refused: [] as string[] };
  const record = noteRecord("Big\nBody", { TextDataAsset: ASSET });

  const update = prepareNoteTextUpdate(record, "Big\nBody", desired("Big\nBody edited"), [], REPLICA, ENTRY, summary);

  assert.equal(update, undefined);
  assert.deepEqual(summary.refused, ["Notes/Big.md: remote note stores its text as an asset - refusing to edit"]);
});

test("the same edit goes through once the record has no TextDataAsset - the asset alone is what refuses it", () => {
  const summary = { conflicts: [] as string[], refused: [] as string[] };
  const record = noteRecord("Big\nBody", { TextDataAsset: { value: null, type: "ASSETID" } });

  const update = prepareNoteTextUpdate(record, "Big\nBody", desired("Big\nBody edited"), [], REPLICA, ENTRY, summary);

  assert.equal(update?.status, "ok");
  assert.deepEqual(summary.refused, []);
});

test("a retitle (a rename in a filename-as-title vault) refuses a record carrying both fields", () => {
  const record = noteRecord("Big\n\nBody", { TextDataAsset: ASSET });
  const classified = classifyNoteRecord(record, { titleMode: "filename" });
  assert.equal(classified.status === "ok" ? classified.publishable : undefined, false);

  const prepared = prepareRetitle(record, { entry: ENTRY, toFile: "Notes/Bigger.md", newTitle: "Bigger" }, REPLICA, "filename");

  assert.equal(prepared.ok, false);
  assert.match(prepared.ok ? "" : prepared.reason, /separate file/);
});
