import type { CloudKitFieldValue, CloudKitRecord } from "../cloudkit/databaseClient.js";
import { decodeNoteAttachmentRefs, OBJECT_REPLACEMENT_CHARACTER, type AttachmentReference } from "./noteAttachments.js";
import { decodeNoteBodyText } from "./noteText.js";

export type NoteDecodeResult =
  | { status: "deleted" }
  | { status: "unsyncable"; reason: "undecodable" }
  | { status: "ok"; title: string; bodyText: string; attachments: AttachmentReference[] };

const TRASH_FOLDER_RECORD_NAME = "TrashFolder-CloudKit";

/** Shared skip/decode rules used by `clone`, `pull`, and `push` so they can't drift apart. */
export function classifyNoteRecord(record: CloudKitRecord): NoteDecodeResult {
  if (isDeleted(record)) {
    return { status: "deleted" };
  }

  const textField = record.fields.TextDataEncrypted;
  if (!textField || typeof textField.value !== "string") {
    return { status: "unsyncable", reason: "undecodable" };
  }

  const compressed = Buffer.from(textField.value, "base64");
  let bodyText: string;
  try {
    bodyText = decodeNoteBodyText(compressed);
  } catch {
    return { status: "unsyncable", reason: "undecodable" };
  }

  const attachments = decodeNoteAttachmentRefs(compressed);
  const placeholderCount = countOccurrences(bodyText, OBJECT_REPLACEMENT_CHARACTER);
  if (placeholderCount !== attachments.length) {
    // Some embedded object we don't understand (a table, drawing, ...) also
    // uses this placeholder, or our attachment-run parse missed one - either
    // way we can't trust a positional correlation between the two, so stay
    // read-only rather than guess. See dev notes, 2026-07-13/14.
    return { status: "unsyncable", reason: "undecodable" };
  }

  return { status: "ok", title: decodeTitleField(record.fields.TitleEncrypted), bodyText, attachments };
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function isDeleted(record: CloudKitRecord): boolean {
  if (record.deleted === true) {
    return true;
  }
  const deletedField = record.fields.Deleted;
  if (typeof deletedField?.value === "number" && deletedField.value !== 0) {
    return true;
  }
  // A note sitting in Trash isn't marked Deleted=1 until it's purged, but it's
  // not a live note either - treat it the same way for sync purposes.
  const folderField = record.fields.Folder;
  const folder = isRecord(folderField?.value) ? folderField.value : undefined;
  return folder?.recordName === TRASH_FOLDER_RECORD_NAME;
}

function decodeTitleField(field: CloudKitFieldValue | undefined): string {
  if (!field || typeof field.value !== "string") {
    return "";
  }
  return Buffer.from(field.value, "base64").toString("utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
