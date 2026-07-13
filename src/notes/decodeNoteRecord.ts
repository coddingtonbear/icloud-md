import type { CloudKitFieldValue, CloudKitRecord } from "../cloudkit/databaseClient.js";
import { decodeNoteBodyText } from "./noteText.js";

export type NoteDecodeResult =
  | { status: "deleted" }
  | { status: "unsyncable"; reason: "attachment" | "undecodable" }
  | { status: "ok"; title: string; bodyText: string };

const TRASH_FOLDER_RECORD_NAME = "TrashFolder-CloudKit";

/** Shared skip/decode rules used by both `clone` and `pull` so they can't drift apart. */
export function classifyNoteRecord(record: CloudKitRecord): NoteDecodeResult {
  if (isDeleted(record)) {
    return { status: "deleted" };
  }
  if (hasAttachment(record)) {
    return { status: "unsyncable", reason: "attachment" };
  }

  const textField = record.fields.TextDataEncrypted;
  if (!textField || typeof textField.value !== "string") {
    return { status: "unsyncable", reason: "undecodable" };
  }

  let bodyText: string;
  try {
    bodyText = decodeNoteBodyText(Buffer.from(textField.value, "base64"));
  } catch {
    return { status: "unsyncable", reason: "undecodable" };
  }

  return { status: "ok", title: decodeTitleField(record.fields.TitleEncrypted), bodyText };
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

function hasAttachment(record: CloudKitRecord): boolean {
  return Object.values(record.fields).some((field) => field.type === "ASSETID");
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
