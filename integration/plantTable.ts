/**
 * Test-only: brings a real Apple table into existence on a live note, so the
 * live suite has something to exercise the table write path against.
 *
 * ## Why the harness needs this at all
 *
 * `push` only ever *edits* a table that already exists - `prepareTableAttachmentUpdate`
 * starts from an `Attachment` record's `MergeableDataEncrypted` field - and the
 * web oracle is deliberately read-only. So nothing in the harness could put a
 * table in front of the tests, and the whole table path (two live corruption
 * incidents to its name) had zero live coverage.
 *
 * ## Why this isn't just testing our encoder against itself
 *
 * The obvious objection to planting a table is that a fixture we author with
 * our own codec, read back with our own codec, proves nothing. Three things
 * answer that, and it is worth keeping all three:
 *
 *  1. **The table document is Apple's bytes, verbatim.** The caller passes a
 *     captured `MergeableDataEncrypted` payload - `realFixtures.ts`'s
 *     `TABLE_REV_BASELINE` and friends, mined from real `records/modify`
 *     traffic. Nothing here encodes a table; the blob is copied through
 *     untouched.
 *  2. **The `Attachment` record is Apple-shaped, verbatim.** Its field set is
 *     the one Apple's own web client sent when it created a table, entry 39 of
 *     `har_captures/2026-07-16_note-lifecycle-create-table-delete.har`:
 *     `CreationDate`, a `Note` reference with `action: "VALIDATE"`,
 *     `UTIEncrypted`, `UTI`, `MinimumSupportedNotesVersion: 2`,
 *     `TitleEncrypted: "Table"`, the payload, and three explicit nulls.
 *  3. **The note-body wiring is checked by Apple, not by us.** Splicing the
 *     U+FFFC placeholder into the note is the one part this module authors,
 *     and it mirrors the attribute-run layout from entry 48 of that same
 *     capture (a `"\n"` run, then a length-1 run carrying `attachmentInfo`,
 *     then a `"\n"` run). The live test does not assert anything about *edits*
 *     until Apple's own client has rendered the planted table with the
 *     expected cells - if the wiring were wrong, the client would show a
 *     missing or broken embed and the run would stop there.
 *
 * Nothing in `src/` imports this, and nothing here can author a table
 * document: this file only ever copies one.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import {
  createZoneRecord,
  lookupRecords,
  updateRecords,
  type CloudKitRecord,
  type NoteUpdateResult,
  type RecordUpdateResult,
} from "../src/cloudkit/databaseClient.js";
import { gridFromTableDocument, parseTableDocument, tableDocumentRoundTrips } from "../src/notes/decodeTableRecord.js";
import { buildNoteUpdateFields } from "../src/notes/encodeNoteRecord.js";
import { AttachmentInfoSchema, AttributeRunSchema } from "../src/notes/gen/topotext_pb.js";
import { OBJECT_REPLACEMENT_CHARACTER, TABLE_UTI } from "../src/notes/noteAttachments.js";
import {
  applyTextEdit,
  encodeNoteDocument,
  parseNoteDocument,
  validateDocumentInvariants,
  type NoteDocument,
} from "../src/notes/noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";
import { resolveHarnessAccount } from "./harnessAccount.js";

/** What Apple's client titles the attachment record backing a table. */
const ATTACHMENT_TITLE = "Table";

/** `MinimumSupportedNotesVersion` on Apple's own table-attachment create. */
const MINIMUM_SUPPORTED_NOTES_VERSION = 2;

/** Apple's paragraph-style enum for Body - the style every captured table
 * embed sits in. An absent style means the same thing on the wire. */
const BODY_PARAGRAPH_STYLE = 3;

export interface TableEmbedInsertion {
  /** The note document with the embed spliced in, uncompressed. */
  raw: Uint8Array;
  /** The note's visible text before and after. */
  oldText: string;
  newText: string;
  /** Where the U+FFFC placeholder landed in `newText`. */
  placeholderIndex: number;
}

/**
 * Splices a table embed onto the end of a note document.
 *
 * The shape is Apple's, from the captured note that gained a table: the
 * placeholder sits in its own paragraph after a blank line, carried by an
 * attribute run of length exactly 1 - the invariant `decodeNoteEmbedSlots`
 * enforces on read, and the one Apple's clients have never been seen to
 * break. Everything else about the document is left to `applyTextEdit`, the
 * production text-edit path, so the planted note is a note this tool could
 * have written apart from the `attachmentInfo` itself.
 *
 * Appending rather than inserting mid-note is deliberate: it keeps the
 * fixture's prose and its table in a fixed, obvious relationship, and leaves
 * every existing run's authorship untouched.
 */
export function buildTableEmbedInsertion(
  originalRaw: Uint8Array,
  attachmentId: string,
  replicaId: Uint8Array,
): TableEmbedInsertion {
  const doc = parseNoteDocument(originalRaw);
  const oldText = doc.text;
  if (oldText.includes(OBJECT_REPLACEMENT_CHARACTER)) {
    throw new Error("buildTableEmbedInsertion: this note already carries an embed - refusing to add a second one");
  }
  if (oldText === "") {
    throw new Error("buildTableEmbedInsertion: refusing to plant a table on an empty note");
  }

  // A blank line before the table, matching what Apple's client produced when
  // a user inserted one at the end of a note.
  const separator = oldText.endsWith("\n") ? "\n" : "\n\n";
  const placeholderIndex = oldText.length + separator.length;
  const newText = `${oldText}${separator}${OBJECT_REPLACEMENT_CHARACTER}\n`;

  if (!applyTextEdit(doc, newText, { replicaId })) {
    throw new Error("buildTableEmbedInsertion: applyTextEdit reported no change");
  }
  isolatePlaceholderRun(doc, placeholderIndex, attachmentId);
  validateDocumentInvariants(doc);

  return { raw: encodeNoteDocument(doc), oldText, newText, placeholderIndex };
}

/**
 * Gives the placeholder character its own length-1 attribute run and hangs
 * the attachment reference off it.
 *
 * `applyTextEdit` grows a neighbouring run to cover inserted text (it will
 * never grow one that already carries `attachmentInfo`, but this text is new),
 * so the placeholder arrives sharing a run with the newlines around it. The
 * split keeps whatever paragraph formatting that run had - which is how the
 * embed inherits the body style Apple's own capture shows - and changes
 * nothing else.
 */
function isolatePlaceholderRun(doc: NoteDocument, placeholderIndex: number, attachmentId: string): void {
  const out = [];
  let offset = 0;
  let attached = false;

  for (const run of doc.attributeRuns) {
    const start = offset;
    const end = offset + run.length;
    offset = end;

    if (placeholderIndex < start || placeholderIndex >= end) {
      out.push(run);
      continue;
    }

    const before = placeholderIndex - start;
    const after = end - (placeholderIndex + 1);
    if (before > 0) {
      const head = clone(AttributeRunSchema, run);
      head.length = before;
      out.push(head);
    }

    const placeholder = clone(AttributeRunSchema, run);
    placeholder.length = 1;
    // Every captured table sits in a plain Body paragraph. Inheriting a list
    // or heading style from the note's last line would produce a table this
    // project has never seen Apple write, and the live failure it caused
    // would look like a decoder bug rather than a bad fixture.
    const style = placeholder.paragraphStyle?.style;
    if (style !== undefined && style !== BODY_PARAGRAPH_STYLE) {
      throw new Error(
        `isolatePlaceholderRun: the table would land in a paragraph of style ${style}; ` +
          "plant tables on notes whose last line is plain prose",
      );
    }
    placeholder.attachmentInfo = create(AttachmentInfoSchema, { attachmentIdentifier: attachmentId, typeUTI: TABLE_UTI });
    out.push(placeholder);

    if (after > 0) {
      const tail = clone(AttributeRunSchema, run);
      tail.length = after;
      out.push(tail);
    }
    attached = true;
  }

  if (!attached) {
    throw new Error(`isolatePlaceholderRun: no attribute run covers offset ${placeholderIndex}`);
  }
  doc.attributeRuns = out;
}

/**
 * The `Attachment` record fields for a table, exactly as Apple's web client
 * sends them on create.
 *
 * `UTIEncrypted`/`TitleEncrypted` are base64 of plain UTF-8 despite the name -
 * "Encrypted" is Apple's field naming for an account without Advanced Data
 * Protection, not a claim about this payload (the same holds for
 * `TextDataEncrypted` throughout this project).
 */
export function buildTableAttachmentFields(
  noteId: string,
  zoneName: string,
  mergeableDataBase64: string,
  creationDateMs: number,
): Record<string, { value: unknown }> {
  return {
    CreationDate: { value: creationDateMs },
    Note: { value: { action: "VALIDATE", recordName: noteId, zoneID: { zoneName } } },
    UTIEncrypted: { value: Buffer.from(TABLE_UTI, "utf-8").toString("base64") },
    UTI: { value: TABLE_UTI },
    MinimumSupportedNotesVersion: { value: MINIMUM_SUPPORTED_NOTES_VERSION },
    TitleEncrypted: { value: Buffer.from(ATTACHMENT_TITLE, "utf-8").toString("base64") },
    MergeableDataEncrypted: { value: mergeableDataBase64 },
    MergeableDataAsset: { value: null },
    EncryptedValues: { value: null },
    EncryptedValuesAsset: { value: null },
  };
}

export interface PlantTableOptions {
  /** A clone bound to the account that owns the note - the source of both the
   * session and the replica id. */
  vaultDir: string;
  /** The note's CloudKit record name (a file's `apple-note-id`). */
  noteId: string;
  /**
   * A real captured `MergeableDataEncrypted` payload for a
   * `com.apple.notes.table` attachment. Apple's bytes, copied through
   * untouched - see this file's header for why that matters.
   */
  tableMergeableDataBase64: string;
}

export interface PlantedTable extends TableEmbedInsertion {
  /** The new `Attachment` record's name, which is also the id the note's
   * `attachmentInfo` run points at. */
  attachmentId: string;
  /** The grid the planted bytes decode to - what every oracle should agree on
   * before a single edit is made. */
  grid: string[][];
  attachmentResult: NoteUpdateResult;
  noteResult: RecordUpdateResult;
  /** The note record as it stood before the plant. */
  record: CloudKitRecord;
}

/**
 * Creates the `Attachment` record and points the note at it, through the
 * ordinary `records/modify` create and update - the same calls `push` makes.
 *
 * The attachment goes first. There is then never a moment where the note
 * claims an embed that does not exist, which is a state this project's own
 * read path treats as an unrenderable note; the reverse order would leave a
 * failed run's debris looking like a decoder bug.
 *
 * Private-database notes only. Returns the CloudKit results rather than
 * throwing on refusal, so a test can assert on them directly.
 */
export async function plantTableOnNote(options: PlantTableOptions): Promise<PlantedTable> {
  const compressed = Buffer.from(options.tableMergeableDataBase64, "base64");
  if (!tableDocumentRoundTrips(compressed)) {
    throw new Error("plantTableOnNote: the table payload does not round-trip through our model - it is not a fixture we understand");
  }
  const grid = gridFromTableDocument(parseTableDocument(compressed));

  // Resolved in-process, and deliberately without the ability to log in
  // interactively - see `harnessAccount.ts` for why that matters mid-run.
  const { session, ckdatabasewsUrl, dsid, zone, replicaId } = await resolveHarnessAccount(options.vaultDir);

  const [record] = await lookupRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [options.noteId]);
  if (!record) {
    throw new Error(`Note record ${options.noteId} was not found`);
  }
  const changeTag = record.recordChangeTag;
  if (changeTag === undefined) {
    throw new Error(`Note record ${options.noteId} came back without a recordChangeTag`);
  }
  const textData = record.fields.TextDataEncrypted?.value;
  if (typeof textData !== "string") {
    throw new Error(`Note record ${options.noteId} has no readable TextDataEncrypted`);
  }

  const attachmentId = randomUUID();
  const insertion = buildTableEmbedInsertion(decompressNoteDocument(Buffer.from(textData, "base64")), attachmentId, replicaId);

  const attachmentResult = await createZoneRecord(
    "Attachment",
    session,
    ckdatabasewsUrl,
    dsid,
    zone.database,
    zone.zoneID,
    attachmentId,
    buildTableAttachmentFields(options.noteId, zone.zoneID.zoneName, options.tableMergeableDataBase64, Date.now()),
  );
  if (!attachmentResult.ok) {
    return { ...insertion, attachmentId, grid, attachmentResult, noteResult: attachmentResult, record };
  }

  const fields = buildNoteUpdateFields(
    record,
    compressNoteDocument(insertion.raw).toString("base64"),
    insertion.newText,
    Date.now(),
  );
  const [noteResult] = await updateRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [
    { recordName: options.noteId, recordType: "Note", recordChangeTag: changeTag, fields },
  ]);
  if (!noteResult) {
    throw new Error("records/modify returned no result for the planted note body");
  }

  return { ...insertion, attachmentId, grid, attachmentResult, noteResult, record };
}
