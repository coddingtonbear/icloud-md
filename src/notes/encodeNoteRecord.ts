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
