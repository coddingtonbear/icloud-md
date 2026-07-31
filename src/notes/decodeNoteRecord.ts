import type { CloudKitFieldValue, CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { TitleMode } from "./cloneState.js";
import { TRASH_FOLDER_RECORD_NAME } from "./encodeNoteRecord.js";
import { decodeNoteEmbedSlots, OBJECT_REPLACEMENT_CHARACTER, type AttachmentReference, type EmbedSlot } from "./noteAttachments.js";
import { decodeNoteFormat, formatsRoundTripEqual, trimTrailingWhitespace, type FormatParagraph } from "./noteFormat.js";
import { decodeNoteString } from "./noteText.js";
import { parseNoteMarkdown } from "./parseNoteMarkdown.js";
import { renderNoteMarkdown } from "./renderNoteMarkdown.js";
import { splitTitleParagraph } from "./noteTitleParagraph.js";
import { UNKNOWN_CONTENT_BANNER } from "./unknownContent.js";

export type OkNoteDecodeResult = {
  status: "ok";
  title: string;
  /** The note's actual first line - what a filename-as-title vault names the
   * file after. Distinct from `title`, which is Apple's truncated, cosmetic
   * display metadata. */
  titleLine: string;
  /** The note's plain visible text - what the CRDT document stores, and
   * what push's text splice operates on. */
  bodyText: string;
  /** The note rendered as markdown (Step 2 of the formatting plan), with
   * U+FFFC placeholders still in place for `resolveNoteAttachments` to
   * substitute. Falls back to `bodyText` verbatim when `publishable` is
   * false - an unrenderable note keeps today's plain-text file shape. */
  markdownText: string;
  /** The decoded formatting model behind `markdownText`; undefined exactly
   * when the fallback above applies. Always the *whole* note, including its
   * title paragraph, even when `titleStripped` says `markdownText` omits it -
   * push needs the original paragraph to put back. */
  format: FormatParagraph[] | undefined;
  /**
   * Whether `markdownText` omits the note's title paragraph, because this
   * vault carries titles in file names. False in an in-body vault, and also
   * false for the individual notes a filename-as-title vault can't strip
   * (a title paragraph containing an embed placeholder) - so callers must
   * read this rather than assuming from the vault's mode.
   */
  titleStripped?: boolean;
  /** One entry per U+FFFC placeholder in `bodyText`, in document order -
   * see `decodeNoteEmbedSlots`. Empty when the embed structure couldn't be
   * mapped (there are no trustworthy slots). */
  embedSlots: EmbedSlot[];
  /** The fully-identified references among `embedSlots`, in the same
   * order - what attachment resolution and the table write path consume. */
  attachments: AttachmentReference[];
  /** False when this note contains content we can't safely push - see
   * the Safety Guarantee Audit dev notes. `push` always re-derives this
   * itself from a fresh record fetch; it's the authoritative gate.
   * Since Step 1 of the formatting plan (2026-07-17), an embed we can't
   * *render* no longer clears this - such notes carry inline markers and
   * stay pushable under the marker-survival policy. A structure we can't
   * *map* (no trustworthy slots) still refuses, and since Step 2 so does
   * formatting that doesn't survive the markdown round trip (unknown
   * paragraph styles, or renderings CommonMark can't reproduce). */
  publishable: boolean;
  unpublishableReason?: string | undefined;
};

/**
 * The two unsyncable reasons differ in what they say about the *note*:
 * "undecodable" means the body bytes are present but don't parse with this
 * tool's model - a durable fact about the record. "missing-body" means the
 * record arrived without `TextDataEncrypted` at all, which is a fact about
 * the *delivery* (shared-zone listings omit bodies, and a per-record lookup
 * can fail transiently) - pull must never untrack a note over it.
 */
export type NoteDecodeResult =
  | { status: "deleted" }
  | { status: "unsyncable"; reason: "undecodable" | "missing-body" }
  | OkNoteDecodeResult;

export interface ClassifyNoteOptions {
  /**
   * "filename": the vault carries note titles in file names, so
   * `markdownText` must exclude the note's title paragraph. The round-trip
   * gate then runs against that *stripped* projection rather than the whole
   * note - what reaches the file is what has to survive re-parsing, and
   * removing the first paragraph can change how what follows parses (a body
   * beginning `5.` being the classic case).
   */
  titleMode?: TitleMode;
}

/** Shared skip/decode rules used by `clone`, `pull`, and `push` so they can't drift apart. */
export function classifyNoteRecord(record: CloudKitRecord, options: ClassifyNoteOptions = {}): NoteDecodeResult {
  if (isDeleted(record)) {
    return { status: "deleted" };
  }

  const textField = record.fields.TextDataEncrypted;
  if (!textField || typeof textField.value !== "string") {
    return { status: "unsyncable", reason: "missing-body" };
  }

  const compressed = Buffer.from(textField.value, "base64");
  let bodyText: string;
  let attributeRuns;
  try {
    const str = decodeNoteString(compressed);
    bodyText = str.string;
    attributeRuns = str.attributeRun;
  } catch {
    return { status: "unsyncable", reason: "undecodable" };
  }

  const title = decodeTitleField(record.fields.TitleEncrypted);
  // The note's real first line, as distinct from `title`: TitleEncrypted is
  // cosmetic display metadata that devices re-derive and that Apple truncates
  // at ~76 characters, so it's the wrong thing to name a file after when the
  // file name has to carry the title faithfully.
  const titleLine = bodyText.split("\n")[0] ?? "";
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
      titleLine,
      bodyText: UNKNOWN_CONTENT_BANNER + bodyText,
      markdownText: UNKNOWN_CONTENT_BANNER + bodyText,
      format: undefined,
      embedSlots: [],
      attachments: [],
      publishable: false,
      unpublishableReason: "contains unrecognized embedded content this tool couldn't parse or place precisely",
    };
  }

  const attachments = embedSlots.filter((slot): slot is EmbedSlot & { kind: "attachment" } => slot.kind === "attachment").map((slot) => slot.ref);
  const base = { status: "ok" as const, title, titleLine, bodyText, embedSlots, attachments };

  // Step 2's round-trip gate: the note renders to markdown only if parsing
  // that markdown back reproduces both the exact text and the formatting
  // projection. A note that fails keeps the plain-text file shape and
  // becomes read-only - never guessed at.
  const format = decodeNoteFormat(bodyText, attributeRuns);
  if (format.status !== "ok") {
    return {
      ...base,
      markdownText: bodyText,
      format: undefined,
      publishable: false,
      unpublishableReason: format.reason,
    };
  }
  // What actually reaches the file: the whole note, or - in a
  // filename-as-title vault - the note without its title paragraph. The gate
  // below runs on whichever it is, because that projection is what has to
  // survive being re-parsed on the way back up.
  const titleParagraph = format.paragraphs[0];
  const stripTitle =
    options.titleMode === "filename" &&
    titleParagraph !== undefined &&
    // A title paragraph holding an embed placeholder can't be stripped: the
    // attachment reference would be orphaned, with no file to carry it. Such
    // a note keeps its title in the body, which is lossless if inconsistent.
    !titleParagraph.text.includes(OBJECT_REPLACEMENT_CHARACTER);
  const projected = stripTitle ? splitTitleParagraph(format.paragraphs).body : format.paragraphs;

  // A title-only note projects to nothing at all, and an empty projection
  // can't be round-tripped: parsing "" yields one empty paragraph rather than
  // zero, so the gate would fail a note that is perfectly fine. The empty
  // file *is* the faithful projection here - the title lives in its name.
  if (stripTitle && projected.length === 0) {
    return { ...base, markdownText: "", format: format.paragraphs, titleStripped: true, publishable: true };
  }

  const rendered = renderNoteMarkdown(projected);
  const reparsed = parseNoteMarkdown(rendered);
  // The reparse must reproduce the *projected* text: trailing whitespace is
  // outside the projection (`trimTrailingWhitespace`), so the raw bodyText
  // may carry trailing spaces the rendered file deliberately drops - a push
  // then deletes them remotely rather than the note going read-only here.
  const projectedText = projected.map((paragraph) => trimTrailingWhitespace(paragraph).text).join("\n");
  if (reparsed.status !== "ok" || reparsed.text !== projectedText || !formatsRoundTripEqual(projected, reparsed.paragraphs)) {
    return {
      ...base,
      markdownText: bodyText,
      format: undefined,
      publishable: false,
      unpublishableReason: "the note's formatting doesn't survive this tool's markdown round trip",
    };
  }

  return { ...base, markdownText: rendered, format: format.paragraphs, titleStripped: stripTitle, publishable: true };
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
