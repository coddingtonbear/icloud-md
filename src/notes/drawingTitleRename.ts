import type { CloudKitRecord, RecordUpdate } from "../cloudkit/databaseClient.js";
import type { CloneStateNoteEntry } from "./cloneState.js";
import { classifyNoteRecord, storesTextAsAsset } from "./decodeNoteRecord.js";
import { hasEmbedOnlyFirstLine } from "./encodeNoteRecord.js";
import { isNoteId } from "./noteIdFrontmatter.js";

/** Offline candidate only: iOS assigns UserTitle, regenerates the containing
 * note's title, then saves its modification date. Native convergence of this
 * minimal CloudKit field set still requires verification before integration.
 * The caller owns filename/identity pairing and must revalidate before sending. */
export function prepareDrawingTitleRename(
  note: CloudKitRecord,
  attachment: CloudKitRecord,
  options: {
    recordName: string;
    entry: CloneStateNoteEntry;
    localText: string;
    baseText: string | undefined;
    newTitle: string;
    modificationDateMs: number;
  },
): { ok: true; updates: [RecordUpdate, RecordUpdate] } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  const { entry, newTitle, modificationDateMs } = options;
  const sameId = (actual: unknown, expected: string) => typeof actual === "string" && actual.toUpperCase() === expected.toUpperCase();
  const reference = (record: CloudKitRecord, key: string, expected: string) => {
    const field = record.fields[key];
    return field?.type === "REFERENCE" && sameId((field.value as { recordName?: unknown } | undefined)?.recordName, expected);
  };
  if (options.baseText === undefined || options.localText !== options.baseText) return refuse("Drawing body must match its base copy");
  if (!newTitle.trim() || /[\r\n\0\uFFFC]/.test(newTitle) || !Number.isSafeInteger(modificationDateMs) || modificationDateMs < 0) {
    return refuse("Unsupported drawing title or modification date");
  }
  if (!isNoteId(options.recordName) || !isNoteId(attachment.recordName) || !entry.folderRecordName || !isNoteId(entry.folderRecordName) ||
      note.recordType !== "Note" || attachment.recordType !== "Attachment" || !sameId(note.recordName, options.recordName) ||
      sameId(note.recordName, attachment.recordName)) {
    return refuse("Invalid drawing record identity");
  }
  if (entry.sharedZoneOwner !== undefined || entry.pendingRename !== undefined ||
      [note, attachment].some(record => record.deleted || record.shareRecordName !== undefined || !record.recordChangeTag ||
        record.fields.Deleted?.type !== "INT64" || record.fields.Deleted.value !== 0)) {
    return refuse("Drawing must be private, undeleted and versioned without a deferred rename");
  }
  if (note.recordChangeTag !== entry.recordChangeTag) return refuse("Note changed since the last pull");
  if (!reference(note, "Folder", entry.folderRecordName) || !sameId(note.parentRecordName, entry.folderRecordName) ||
      !reference(attachment, "Note", note.recordName) || !sameId(attachment.parentRecordName, note.recordName)) {
    return refuse("Drawing ownership or folder changed");
  }
  if (storesTextAsAsset(note) || attachment.fields.UTI?.type !== "STRING" || attachment.fields.UTI.value !== "com.apple.paper") {
    return refuse("Unsupported drawing storage");
  }
  const decoded = classifyNoteRecord(note, { titleMode: "filename" });
  if (decoded.status !== "ok" || !decoded.publishable || !hasEmbedOnlyFirstLine(decoded.bodyText) ||
      !/^\s*\uFFFC\s*$/u.test(decoded.bodyText) || decoded.embedSlots.length !== 1 ||
      decoded.attachments.length !== 1 || decoded.attachments[0]!.typeUti !== "com.apple.paper" ||
      !sameId(decoded.attachments[0]!.attachmentIdentifier, attachment.recordName)) {
    return refuse("Expected one drawing without prose");
  }
  const title = Buffer.from(newTitle, "utf-8").toString("base64");
  return { ok: true, updates: [
    { recordName: note.recordName, recordType: "Note", recordChangeTag: note.recordChangeTag!, parentRecordName: note.parentRecordName,
      fields: { TitleEncrypted: { value: title }, ModificationDate: { value: modificationDateMs } } },
    { recordName: attachment.recordName, recordType: "Attachment", recordChangeTag: attachment.recordChangeTag!, parentRecordName: attachment.parentRecordName,
      fields: { UserTitle: { value: title } } },
  ] };
}
