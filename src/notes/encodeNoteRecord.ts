import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

/**
 * Builds the field set for a `records/modify` update of a note, mirroring
 * decodeNoteRecord.ts on the way back up. The derivation rules for the
 * display metadata (TitleEncrypted / SnippetEncrypted) and the exact list of
 * fields to send all come from real update operations captured from
 * www.icloud.com - see the dev notes (2026-07-13, push groundwork).
 */

/**
 * Title truncation: the title is the note's first line, cut back to a word
 * boundary when the line is long. A captured 255-character first line was
 * cut to 66 characters, at the last space before the next word would have
 * ended at 78 - so the real limit is somewhere in 67..77; 76 reproduces the
 * capture. Cosmetic metadata (list views), not note content: devices
 * re-derive it whenever they edit the note themselves.
 */
const TITLE_MAX_LENGTH = 76;

const SNIPPET_MAX_LENGTH = 500;

/**
 * What the web client stores when there's no content after the first line.
 * Yes, the placeholder string lives in the data, not the UI (observed
 * verbatim in captured saves of single-line notes) - and it's presumably
 * whatever the writing client's locale renders, since ours captured the
 * English text.
 */
const EMPTY_SNIPPET_PLACEHOLDER = "No additional text";

export function deriveNoteTitle(text: string): string {
  const lineEnd = text.indexOf("\n");
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  if (firstLine.length <= TITLE_MAX_LENGTH) {
    return firstLine;
  }
  const wordBoundary = firstLine.lastIndexOf(" ", TITLE_MAX_LENGTH);
  return wordBoundary > 0 ? firstLine.slice(0, wordBoundary) : firstLine.slice(0, TITLE_MAX_LENGTH);
}

export function deriveNoteSnippet(text: string): string {
  const afterTitle = text.slice(deriveNoteTitle(text).length).replace(/^\s+/, "");
  const lineEnd = afterTitle.indexOf("\n");
  const snippet = (lineEnd === -1 ? afterTitle : afterTitle.slice(0, lineEnd)).slice(0, SNIPPET_MAX_LENGTH);
  return snippet.length > 0 ? snippet : EMPTY_SNIPPET_PLACEHOLDER;
}

/** A modify-request field: bare `{value}` with no `type`, matching captured
 * web-client update operations (types only appear on the read side). */
export interface UpdateFieldValue {
  value: unknown;
}

/**
 * Fields echoed back from the current remote record on every update, exactly
 * the set the captured web client sends. Order is preserved for fidelity to
 * the captures (JSON object order survives serialization).
 */
const ECHOED_FIELDS = [
  "MinimumSupportedNotesVersion",
  "Folders",
  "Deleted",
  "Folder",
  "CreationDate",
  "ReplicaIDToNotesVersionDataEncrypted",
  "FoldersModificationDate",
  "AttachmentViewType",
  "PaperStyleType",
  "ReplicaIDToUserIDEncrypted",
] as const;

/** Fields the captured web client sends as literal nulls on plain notes. */
const NULL_FIELDS = ["FirstAttachmentThumbnail", "FirstAttachmentUTIEncrypted", "TextDataAsset"] as const;

/**
 * Assembles the full update field set: the new text data (already
 * re-encoded and zlib-compressed, passed base64), freshly derived display
 * metadata, and everything else echoed verbatim from the looked-up record.
 */
/**
 * The Folder reference every deletion stage points at. Apple's own client
 * never `forceDelete`s a note the user deletes - both stages of its deletion
 * flow are ordinary updates (see the 2026-07-16 lifecycle + purge HAR
 * captures in har_captures/): stage 1 reparents the note here, stage 2 sets
 * `Deleted: 1` with the note still parented here.
 */
export const TRASH_FOLDER_RECORD_NAME = "TrashFolder-CloudKit";

function folderReference(folderRecordName: string): unknown {
  // Bare zoneName, no ownerRecordName - matching what the captured client
  // sends on writes (the fuller zone identity only appears on the read side).
  return { recordName: folderRecordName, action: "VALIDATE", zoneID: { zoneName: "Notes" } };
}

/**
 * Fields the captured deletion updates send as literal empty objects `{}`
 * (not `null` - unlike edit updates, see NULL_FIELDS), even on a note that
 * has a table attachment. `{value: undefined}` serializes to exactly `{}`.
 */
const DELETION_EMPTY_FIELDS = ["FirstAttachmentThumbnail", "FirstAttachmentUTIEncrypted", "TextDataAsset"] as const;

/**
 * Stage 1 of Apple's two-stage deletion: the field set that moves a note to
 * Recently Deleted, byte-matching the captured web-client request (see
 * har_captures/2026-07-16_note-lifecycle-create-table-delete.har, entry 56).
 * Works regardless of attachments - nothing is deleted, so no reference
 * validation can fail.
 */
export function buildNoteTrashFields(current: CloudKitRecord, nowMs: number): Record<string, UpdateFieldValue> {
  return buildNoteRelocationFields(current, TRASH_FOLDER_RECORD_NAME, nowMs, { markDeleted: false });
}

/**
 * The field set that moves a note into an arbitrary folder - structurally
 * identical to the trash-move (Apple's "delete to Recently Deleted" IS a
 * folder move, see the lifecycle HAR analysis), just pointed at a real
 * folder instead of `TrashFolder-CloudKit`. The one write shape Step 4 of
 * the folders plan relies on, precisely because it was already proven live.
 */
export function buildNoteMoveFields(
  current: CloudKitRecord,
  folderRecordName: string,
  nowMs: number,
): Record<string, UpdateFieldValue> {
  return buildNoteRelocationFields(current, folderRecordName, nowMs, { markDeleted: false });
}

/**
 * Stage 2: the field set that permanently deletes an already-trashed note
 * (`Deleted: 1`; the server garbage-collects the record, its attachments,
 * and backing media asynchronously) - byte-matching the captured request
 * (har_captures/2026-07-16_purge-from-recently-deleted.har). Also moves the
 * note to Trash in the same update, so callers may run it directly against
 * a live note; the capture shows both fields together.
 */
export function buildNotePurgeFields(current: CloudKitRecord, nowMs: number): Record<string, UpdateFieldValue> {
  return buildNoteRelocationFields(current, TRASH_FOLDER_RECORD_NAME, nowMs, { markDeleted: true });
}

function buildNoteRelocationFields(
  current: CloudKitRecord,
  folderRecordName: string,
  nowMs: number,
  options: { markDeleted: boolean },
): Record<string, UpdateFieldValue> {
  // Field order and echo-vs-override choices match the captured requests.
  // Echoed fields are copied value-verbatim, never decoded - a deletion must
  // work on a note too broken to parse; echo-if-present tolerates a broken
  // record that's missing them entirely.
  const fields: Record<string, UpdateFieldValue> = {};
  const echo = (name: string): void => {
    const field = current.fields[name];
    if (field !== undefined) {
      fields[name] = { value: field.value };
    }
  };

  echo("CreationDate");
  fields.ModificationDate = { value: nowMs };
  echo("TitleEncrypted");
  fields.Folders = { value: [folderReference(folderRecordName)] };
  fields.FoldersModificationDate = { value: nowMs };
  fields.Folder = { value: folderReference(folderRecordName) };
  echo("SnippetEncrypted");
  if (options.markDeleted) {
    fields.Deleted = { value: 1 };
  }
  for (const name of DELETION_EMPTY_FIELDS) {
    fields[name] = { value: undefined };
  }
  echo("TextDataEncrypted");
  return fields;
}

/**
 * The field set for a brand-new note's `create` operation, byte-matching
 * the captured first-ever save (see
 * har_captures/2026-07-16_note-lifecycle-create-table-delete.har, entry 2,
 * analyzed in the 2026-07-16T10:50 dev notes): real date values (nothing to
 * echo on a create), both folder references at the default folder, derived
 * display metadata, the placeholder trio as literal `{}`, and notably NO
 * ReplicaIDToNotesVersionDataEncrypted - the capture simply omits it.
 */
export function buildNoteCreateFields(
  newTextDataBase64: string,
  newText: string,
  nowMs: number,
  folderRecordName: string = "DefaultFolder-CloudKit",
): Record<string, UpdateFieldValue> {
  const folder = folderReference(folderRecordName);
  const fields: Record<string, UpdateFieldValue> = {
    CreationDate: { value: nowMs },
    Folders: { value: [folder] },
    Folder: { value: folder },
    ModificationDate: { value: nowMs },
    TitleEncrypted: { value: Buffer.from(deriveNoteTitle(newText), "utf-8").toString("base64") },
    SnippetEncrypted: { value: Buffer.from(deriveNoteSnippet(newText), "utf-8").toString("base64") },
  };
  for (const name of DELETION_EMPTY_FIELDS) {
    // Same literal-`{}` trio the deletion updates send - the captured
    // create sends them empty too.
    fields[name] = { value: undefined };
  }
  fields.TextDataEncrypted = { value: newTextDataBase64 };
  return fields;
}

/**
 * Assembles the full update field set: the new text data (already
 * re-encoded and zlib-compressed, passed base64), freshly derived display
 * metadata, and everything else echoed verbatim from the looked-up record.
 */
export function buildNoteUpdateFields(
  current: CloudKitRecord,
  newTextDataBase64: string,
  newText: string,
  modificationDateMs: number,
): Record<string, UpdateFieldValue> {
  const fields: Record<string, UpdateFieldValue> = {
    ModificationDate: { value: modificationDateMs },
    TitleEncrypted: { value: Buffer.from(deriveNoteTitle(newText), "utf-8").toString("base64") },
  };

  for (const name of ECHOED_FIELDS) {
    const field = current.fields[name];
    if (field !== undefined) {
      fields[name] = { value: field.value };
    }
  }

  fields.SnippetEncrypted = { value: Buffer.from(deriveNoteSnippet(newText), "utf-8").toString("base64") };

  for (const name of NULL_FIELDS) {
    // Anything non-null here means an attachment-ish note, which push
    // refuses long before this point; sending null mirrors the captures.
    fields[name] = { value: current.fields[name]?.value ?? null };
  }

  fields.TextDataEncrypted = { value: newTextDataBase64 };
  return fields;
}
