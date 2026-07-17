import type { CloudKitFieldValue, CloudKitRecord } from "../cloudkit/databaseClient.js";
import { TRASH_FOLDER_RECORD_NAME } from "./encodeNoteRecord.js";
import { decodeNoteAttachmentRefs, OBJECT_REPLACEMENT_CHARACTER, type AttachmentReference } from "./noteAttachments.js";
import { decodeNoteBodyText } from "./noteText.js";
import { UNKNOWN_CONTENT_BANNER } from "./unknownContent.js";

export type NoteDecodeResult =
  | { status: "deleted" }
  | { status: "unsyncable"; reason: "undecodable" }
  | {
      status: "ok";
      title: string;
      bodyText: string;
      attachments: AttachmentReference[];
      /** False when this note contains content we can't safely push - see
       * the Safety Guarantee Audit dev notes. `push` always re-derives this
       * itself from a fresh record fetch; it's the authoritative gate. */
      publishable: boolean;
      unpublishableReason?: string | undefined;
    };

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
  const title = decodeTitleField(record.fields.TitleEncrypted);
  if (placeholderCount !== attachments.length) {
    // Some embedded object we don't understand (a drawing, scanned document,
    // ...) also uses this placeholder, or our attachment-run parse missed
    // one - either
    // way we can't trust a positional correlation between the two, so we
    // can't localize *which* placeholder is the problem. Per the Safety
    // Guarantee Audit: still fetch the note (banner up top, since we can't
    // pinpoint the spot), but never allow it to be pushed. See dev notes,
    // 2026-07-13/14.
    return {
      status: "ok",
      title,
      bodyText: UNKNOWN_CONTENT_BANNER + bodyText,
      attachments,
      publishable: false,
      unpublishableReason: "contains unrecognized embedded content this tool couldn't parse or place precisely",
    };
  }

  return { status: "ok", title, bodyText, attachments, publishable: true };
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
