import type { CloudKitFieldValue, CloudKitRecord } from "../cloudkit/databaseClient.js";
import { TRASH_FOLDER_RECORD_NAME } from "./encodeNoteRecord.js";
import { decodeNoteEmbedSlots, type AttachmentReference, type EmbedSlot } from "./noteAttachments.js";
import { decodeNoteBodyText } from "./noteText.js";
import { UNKNOWN_CONTENT_BANNER } from "./unknownContent.js";

export type NoteDecodeResult =
  | { status: "deleted" }
  | { status: "unsyncable"; reason: "undecodable" }
  | {
      status: "ok";
      title: string;
      bodyText: string;
      /** One entry per U+FFFC placeholder in `bodyText`, in document order -
       * see `decodeNoteEmbedSlots`. Empty when `publishable` is false (the
       * structure couldn't be mapped, so there are no trustworthy slots). */
      embedSlots: EmbedSlot[];
      /** The fully-identified references among `embedSlots`, in the same
       * order - what attachment resolution and the table write path consume. */
      attachments: AttachmentReference[];
      /** False when this note contains content we can't safely push - see
       * the Safety Guarantee Audit dev notes. `push` always re-derives this
       * itself from a fresh record fetch; it's the authoritative gate.
       * Since Step 1 of the formatting plan (2026-07-17), an embed we can't
       * *render* no longer clears this - such notes carry inline markers and
       * stay pushable under the marker-survival policy. Only a structure we
       * can't *map* (no trustworthy slots) still refuses. */
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

  const title = decodeTitleField(record.fields.TitleEncrypted);
  const embedSlots = decodeNoteEmbedSlots(compressed);
  if (embedSlots === undefined) {
    // The embed structure defies the model verified against real captures
    // (an attachmentInfo run not sitting on a lone U+FFFC), so no placeholder
    // can be trusted to mean what it appears to. Per the Safety Guarantee
    // Audit: still fetch the note (banner up top, since nothing can be
    // localized), but never allow it to be pushed.
    return {
      status: "ok",
      title,
      bodyText: UNKNOWN_CONTENT_BANNER + bodyText,
      embedSlots: [],
      attachments: [],
      publishable: false,
      unpublishableReason: "contains unrecognized embedded content this tool couldn't parse or place precisely",
    };
  }

  const attachments = embedSlots.filter((slot): slot is EmbedSlot & { kind: "attachment" } => slot.kind === "attachment").map((slot) => slot.ref);
  return { status: "ok", title, bodyText, embedSlots, attachments, publishable: true };
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
