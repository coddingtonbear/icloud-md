/**
 * Typed model of the decompressed TextDataEncrypted "mergeable data" document
 * - the same protobuf `noteText.ts` reads note_text out of, but parsed
 * strictly enough to be *edited and re-encoded*, which is what `push` needs.
 *
 * Built on the generated `proto/topotext.proto`/`proto/versioned_document.proto`
 * schemas (protobuf-es). This project's own `NoteDocument`/`TextRun`/
 * `ReplicaEntry` stay plain domain types, decoupled from the generated
 * message shapes, so editing logic below doesn't need to think in
 * wire-format terms (their names predate the 2026-07-16 schema alignment
 * with Apple's recovered source: domain `TextRun` = wire `Substring`,
 * `coord` = `charID`, `anchor` = `Substring.timestamp`, `sequence` =
 * `child`, `ReplicaEntry` = `VectorTimestamp.Clock`). `AttributeRun` is the
 * one exception: it's a direct alias for the generated message type rather
 * than a separate wrapper, since Apple's formatting fields are numerous,
 * still mostly unused by this project (rendering them is out of scope until
 * a follow-on plan), and protobuf-es's own unknown-field retention already
 * makes preserving whatever we don't understand "nearly free" - see
 * `proto/topotext.proto` and the dev notes, 2026-07-15 (Step 1 spike).
 *
 * The shape here was derived empirically from real `records/modify` bodies
 * captured from www.icloud.com (see the project dev notes, 2026-07-13 "push
 * groundwork" entry), cross-checked against every note in those captures,
 * and since 2026-07-16 aligned with Apple's own recovered schema names
 * (dev log 2026-07-16T15:18):
 *
 *   versioned_document.Document > Version.data (see `versionedDocument.ts`)
 *   topotext.String:
 *              2: string (UTF-8; title is its first line)
 *              3: repeated Substring - the CRDT history of the string
 *              4: timestamp - per-replica clock table
 *                 (repeated { 1: 16-byte UUID, 2+: clocks })
 *              5: repeated AttributeRun - formatting spans over visible text
 *   Substring: 1: charID { 1: replica index, 2: clock }
 *              2: length
 *              3: timestamp (this file's domain `anchor`; Apple calls it the
 *                 run's style timestamp)
 *              4: tombstone flag (1 = deleted text, retained for merging)
 *              5: child run index(es) - genuinely `repeated`: a real capture
 *                 (2026-07-15) had two occurrences in one run; see
 *                 `proto/topotext.proto`'s `Substring.child` comment. This
 *                 file's domain model calls it `sequence` (every real save
 *                 renumbers it 1..N in document order).
 *
 * Invariants verified against every captured note:
 *  - run lengths and clocks count UTF-16 code units;
 *  - visible text == concatenation of non-tombstoned runs, in list order;
 *  - each replica's clock in the table == total length it ever inserted;
 *  - replica indexes in coords are 1-based into the table (0 is reserved for
 *    the zero-length origin run and the (0, 0xFFFFFFFF) end sentinel);
 *  - attribute-run lengths sum to the visible text length.
 *
 * Everything this parser does not understand makes `parseNoteDocument` throw,
 * and `push` treats that note as read-only. On top of that, callers must
 * verify `encodeNoteDocument(parseNoteDocument(raw))` reproduces `raw`
 * byte-for-byte before trusting an edit - the round-trip gate from the
 * project README's Phase 3 plan. Unlike the pre-migration hand-rolled codec,
 * that gate is no longer just "did we understand every field" - protobuf-es
 * sorts declared fields by number and appends undeclared ones at the end on
 * encode, so it also silently catches "declared, but positioned somewhere
 * the schema doesn't yet account for" the same way it always caught
 * "not declared at all". A genuinely unrecognized field in the Note message
 * is therefore no longer rejected up front the way it used to be - it's
 * tolerated (preserved via protobuf-es's own unknown-field retention) and
 * only refused if the round-trip actually fails, which is strictly more
 * permissive without weakening the guarantee.
 */

import { clone, create, fromBinary, isFieldSet, toBinary } from "@bufbuild/protobuf";
import {
  AttributeRunSchema,
  CharIDSchema,
  StringSchema,
  SubstringSchema,
  VectorTimestampSchema,
  VectorTimestamp_ClockSchema,
  VectorTimestamp_Clock_ReplicaClockSchema,
  type AttributeRun as GenAttributeRun,
  type Substring as GenSubstring,
  type VectorTimestamp_Clock as GenReplicaClockTable,
} from "./gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { parseVersionedDocument } from "./versionedDocument.js";

const TOMBSTONE_FIELD = SubstringSchema.fields.find((f) => f.localName === "tombstone")!;
const SUBCLOCK_FIELD = VectorTimestamp_Clock_ReplicaClockSchema.fields.find((f) => f.localName === "subclock")!;

export interface RunCoord {
  replica: number;
  clock: number;
}

export interface TextRun {
  coord: RunCoord;
  length: number;
  anchor: RunCoord;
  tombstone: boolean;
  /** Almost always one entry; occasionally more in real captures - see
   * `proto/topotext.proto`'s `Substring.child` comment. Empty for a
   * brand-new run pending `applyTextEdit`'s renumbering pass. */
  sequence: number[];
}

export interface ReplicaEntry {
  id: Uint8Array;
  /** First entry is the replica's text clock (total UTF-16 units it has
   * inserted); later entries' meanings are unknown and preserved verbatim. */
  counters: number[];
}

/** Apple's formatting fields (paragraph style, fonts, colors, ...) - opaque
 * to this project's editing logic, which only ever reads/writes `.length`.
 * A direct alias for the generated message rather than a separate wrapper;
 * see file header. */
export type AttributeRun = GenAttributeRun;

export interface NoteDocument {
  /** `versioned_document.Document.serializationVersion`; always observed 0,
   * preserved verbatim. */
  rootSerializationVersion: number;
  /** `versioned_document.Version.serializationVersion`; always observed 0,
   * preserved verbatim. */
  versionSerializationVersion: number;
  /** `versioned_document.Version.minimumSupportedVersion`. */
  minimumSupportedVersion: number;
  text: string;
  runs: TextRun[];
  replicas: ReplicaEntry[];
  attributeRuns: AttributeRun[];
}

const SENTINEL_CLOCK = 0xffffffff;

export function parseNoteDocument(raw: Uint8Array): NoteDocument {
  const { wrapper, data } = parseVersionedDocument(raw);
  const version = wrapper.version[0]!;
  const str = fromBinary(StringSchema, data);
  if (!str.timestamp) {
    throw new Error("Note document is missing its replica clock table (String field 4)");
  }

  return {
    rootSerializationVersion: wrapper.serializationVersion,
    versionSerializationVersion: version.serializationVersion,
    minimumSupportedVersion: version.minimumSupportedVersion,
    text: str.string,
    runs: str.substring.map(parseTextRun),
    replicas: str.timestamp.clock.map(parseReplicaEntry),
    attributeRuns: str.attributeRun,
  };
}

export function encodeNoteDocument(doc: NoteDocument): Uint8Array {
  const str = create(StringSchema, {
    string: doc.text,
    substring: doc.runs.map(encodeTextRun),
    timestamp: create(VectorTimestampSchema, { clock: doc.replicas.map(encodeReplicaEntry) }),
    attributeRun: doc.attributeRuns,
  });
  const wrapper = create(VersionedDocumentSchema, {
    serializationVersion: doc.rootSerializationVersion,
    version: [
      create(VersionSchema, {
        serializationVersion: doc.versionSerializationVersion,
        minimumSupportedVersion: doc.minimumSupportedVersion,
        data: toBinary(StringSchema, str),
      }),
    ],
  });
  return toBinary(VersionedDocumentSchema, wrapper);
}

/** The byte-for-byte round-trip gate: true only if we can reproduce `raw`
 * exactly from our parsed model, proving the model captured everything. */
export function noteDocumentRoundTrips(raw: Uint8Array): boolean {
  let reencoded: Uint8Array;
  try {
    reencoded = encodeNoteDocument(parseNoteDocument(raw));
  } catch {
    return false;
  }
  return bytesEqual(raw, reencoded);
}

export interface ApplyTextEditOptions {
  /** 16-byte replica UUID identifying this tool's edits in the CRDT. */
  replicaId: Uint8Array;
}

/**
 * Applies a plain-text edit to the document in place, the way the captured
 * web client does: the old and new text are compared (common prefix/suffix),
 * the removed visible range is tombstoned - never physically deleted, other
 * replicas need it to merge - and the inserted text becomes a new run (or
 * extends our own trailing run) with clocks from our replica's counter.
 *
 * Returns false if the text is unchanged (nothing to push).
 */
export function applyTextEdit(doc: NoteDocument, newText: string, options: ApplyTextEditOptions): boolean {
  const oldText = doc.text;
  if (oldText === newText) {
    return false;
  }
  validateDocumentInvariants(doc);

  const { start, deleteLength, insertText } = computeSplice(oldText, newText);
  const replicaIndex = ensureReplica(doc, options.replicaId);

  let structuralChange = false;
  if (deleteLength > 0) {
    tombstoneVisibleRange(doc, start, deleteLength);
    structuralChange = true;
  }
  if (insertText.length > 0) {
    structuralChange = insertVisibleText(doc, start, insertText, replicaIndex) || structuralChange;
  }
  adjustAttributeRuns(doc, start, deleteLength, insertText.length);

  // The second replica counter behaves as an edit-event counter in captured
  // traffic: a pure extension of the replica's own trailing run leaves it
  // alone (observed across two consecutive web-client saves of an append),
  // while saves containing splits/tombstones/new runs advance it (observed
  // 1 -> 9 -> 10 across the "Test Note" capture). One push = one event.
  if (structuralChange) {
    const replica = doc.replicas[replicaIndex - 1];
    if (replica) {
      replica.counters[1] = (replica.counters[1] ?? 0) + 1;
    }
  }

  // Sequence numbers are not stable identifiers: every captured save has
  // them renumbered 1..N in list (= document) order, so do the same -
  // collapsing any multi-value sequence (see TextRun.sequence) back down to
  // one, matching what a real save always does.
  renumberSequences(doc);

  doc.text = newText;
  validateDocumentInvariants(doc);
  return true;
}

/**
 * Builds the document for a brand-new note's very first save. A truly blank
 * document never crosses the wire - the captured create (see
 * har_captures/2026-07-16_note-lifecycle-create-table-delete.har, entry 2,
 * analyzed in the 2026-07-16T10:50 dev notes) is already an ordinary
 * one-replica document carrying the typed text - so this seeds the minimal
 * empty skeleton that capture implies (the zero-length replica-0 lead run,
 * the end sentinel, an empty replica table) and lets `applyTextEdit`, the
 * same machinery every push edit goes through, insert the actual content.
 *
 * One deliberate difference from the capture: no paragraph styling on the
 * first line (Apple's client styles it as a Title). Purely cosmetic - the
 * list-view title comes from the TitleEncrypted field, not from styling.
 */
export function buildInitialNoteDocument(text: string, replicaId: Uint8Array): NoteDocument {
  if (text.length === 0) {
    throw new Error("A new note needs some text - refusing to create an empty document");
  }
  const doc: NoteDocument = {
    rootSerializationVersion: 0,
    versionSerializationVersion: 0,
    minimumSupportedVersion: 0,
    text: "",
    runs: [
      // The captured document leads with this zero-length replica-0 run
      // (sequence 1) ahead of all real content.
      { coord: { replica: 0, clock: 0 }, length: 0, anchor: { replica: 0, clock: 0 }, tombstone: false, sequence: [] },
      {
        coord: { replica: 0, clock: SENTINEL_CLOCK },
        length: 0,
        anchor: { replica: 0, clock: SENTINEL_CLOCK },
        tombstone: false,
        sequence: [],
      },
    ],
    replicas: [],
    attributeRuns: [],
  };
  applyTextEdit(doc, text, { replicaId });
  return doc;
}

function renumberSequences(doc: NoteDocument): void {
  let sequence = 1;
  for (const run of doc.runs) {
    if (isSentinel(run)) {
      continue;
    }
    run.sequence = [sequence];
    sequence += 1;
  }
}

// --- parsing ---------------------------------------------------------------

/** Exported for `tableCellEdit.ts`: a cell's `.string` field (field 10)
 * reuses this exact `Substring` message shape for its own CRDT run history. */
export function parseTextRun(run: GenSubstring): TextRun {
  const coord = run.charID;
  const anchor = run.timestamp;
  if (!coord || !anchor) {
    throw new Error("Substring is missing charID, length, or timestamp");
  }
  let tombstone = false;
  if (isFieldSet(run, TOMBSTONE_FIELD)) {
    if (run.tombstone !== 1) {
      throw new Error(`Substring tombstone flag has unexpected value ${run.tombstone}`);
    }
    tombstone = true;
  }
  return {
    coord: { replica: coord.replicaID, clock: coord.clock },
    length: run.length,
    anchor: { replica: anchor.replicaID, clock: anchor.clock },
    tombstone,
    sequence: run.child,
  };
}

function parseReplicaEntry(entry: GenReplicaClockTable): ReplicaEntry {
  if (entry.replicaUUID.length !== 16) {
    throw new Error("Replica clock entry does not start with a 16-byte UUID");
  }
  return {
    id: entry.replicaUUID,
    counters: entry.replicaClock.map((counter) => {
      // Never observed set; this domain model doesn't carry it through an
      // edit, so a document that uses it must be refused, not silently
      // re-encoded without it.
      if (isFieldSet(counter, SUBCLOCK_FIELD)) {
        throw new Error("Replica clock entry carries a subclock this tool doesn't understand - refusing to touch this note");
      }
      return counter.clock;
    }),
  };
}

// --- encoding --------------------------------------------------------------

/** Exported for `tableCellEdit.ts`; see `parseTextRun`. */
export function encodeTextRun(run: TextRun): GenSubstring {
  return create(SubstringSchema, {
    charID: create(CharIDSchema, { replicaID: run.coord.replica, clock: run.coord.clock }),
    length: run.length,
    timestamp: create(CharIDSchema, { replicaID: run.anchor.replica, clock: run.anchor.clock }),
    // Zero/absent values are encoded explicitly (Apple's encoder does the
    // same, and the round-trip gate depends on matching it) - so tombstone
    // is only ever set (to literal 1) when true, left absent otherwise.
    ...(run.tombstone ? { tombstone: 1 } : {}),
    child: run.sequence,
  });
}

function encodeReplicaEntry(entry: ReplicaEntry): GenReplicaClockTable {
  return create(VectorTimestamp_ClockSchema, {
    replicaUUID: entry.id,
    replicaClock: entry.counters.map((clock) => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock })),
  });
}

// --- editing ---------------------------------------------------------------

interface Splice {
  start: number;
  deleteLength: number;
  insertText: string;
}

/** Minimal single-splice diff over UTF-16 code units, never splitting a
 * surrogate pair. */
export function computeSplice(oldText: string, newText: string): Splice {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }
  // Don't split a surrogate pair at the prefix boundary.
  while (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) {
    prefix -= 1;
  }

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix += 1;
  }
  while (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) {
    suffix -= 1;
  }

  return {
    start: prefix,
    deleteLength: oldText.length - prefix - suffix,
    insertText: newText.slice(prefix, newText.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Marks the visible range [start, start+length) as tombstoned, splitting
 * runs where the range boundaries fall inside one. Clock arithmetic follows
 * the pattern in captured notes: a run starting at clock c, split at offset
 * k, continues at clock c+k. */
function tombstoneVisibleRange(doc: NoteDocument, start: number, length: number): void {
  const end = start + length;
  const out: TextRun[] = [];
  let visible = 0;

  for (const run of doc.runs) {
    if (run.tombstone || run.length === 0 || isSentinel(run)) {
      out.push(run);
      continue;
    }
    const runStart = visible;
    const runEnd = visible + run.length;
    visible = runEnd;

    if (runEnd <= start || runStart >= end) {
      out.push(run);
      continue;
    }

    const overlapStart = Math.max(start, runStart);
    const overlapEnd = Math.min(end, runEnd);
    if (overlapStart > runStart) {
      out.push(pieceOf(run, 0, overlapStart - runStart, false));
    }
    out.push(pieceOf(run, overlapStart - runStart, overlapEnd - overlapStart, true));
    if (runEnd > overlapEnd) {
      out.push(pieceOf(run, overlapEnd - runStart, runEnd - overlapEnd, false));
    }
  }

  if (visible < end) {
    throw new Error("Tombstone range extends past the end of the visible text - CRDT model out of sync");
  }
  doc.runs = out;
}

/** A sub-range of `run` as its own run, with fresh coord/anchor objects.
 * `sequence` is copied by reference - harmless, since `applyTextEdit` always
 * finishes with `renumberSequences`, which replaces it outright. */
function pieceOf(run: TextRun, offset: number, length: number, tombstone: boolean): TextRun {
  return {
    coord: { replica: run.coord.replica, clock: run.coord.clock + offset },
    length,
    anchor: { replica: run.anchor.replica, clock: run.anchor.clock },
    tombstone: tombstone || run.tombstone,
    sequence: run.sequence,
  };
}

/** Inserts `text` at visible position `start`, extending our own trailing
 * run when possible (exactly what the captured web client's own append
 * does), otherwise adding a new run under our replica id. Returns whether a
 * structural change (a new run, as opposed to an extension) was made. */
function insertVisibleText(doc: NoteDocument, start: number, text: string, replicaIndex: number): boolean {
  const replica = doc.replicas[replicaIndex - 1];
  const clock = replica?.counters[0];
  if (!replica || clock === undefined) {
    throw new Error("Replica entry has no text clock counter");
  }
  if (start > visibleLengthFrom(doc.runs, 0)) {
    throw new Error("Insertion point is past the end of the visible text - CRDT model out of sync");
  }

  // Find where visible position `start` falls in the run list, splitting a
  // run in two if it lands inside one.
  let visible = 0;
  let insertIndex = doc.runs.length;
  for (let i = 0; i < doc.runs.length; i += 1) {
    const run = doc.runs[i];
    if (!run) continue;
    if (isSentinel(run)) {
      insertIndex = i;
      break;
    }
    if (run.tombstone || run.length === 0) {
      insertIndex = i + 1;
      continue;
    }
    const runEnd = visible + run.length;
    if (start < runEnd) {
      const offset = start - visible;
      if (offset === 0) {
        insertIndex = i;
      } else {
        doc.runs.splice(i, 1, pieceOf(run, 0, offset, false), pieceOf(run, offset, run.length - offset, false));
        insertIndex = i + 1;
      }
      break;
    }
    visible = runEnd;
    insertIndex = i + 1;
  }

  // If the run right before the insertion point is our own replica's newest
  // text (its clocks run right up to our counter), extend it instead of
  // adding a run - byte-for-byte what the web client did between the two
  // captured saves of the same note.
  const previous = doc.runs[insertIndex - 1];
  if (
    previous &&
    !previous.tombstone &&
    !isSentinel(previous) &&
    previous.coord.replica === replicaIndex &&
    previous.coord.clock + previous.length === clock
  ) {
    previous.length += text.length;
    replica.counters[0] = clock + text.length;
    return false;
  }

  doc.runs.splice(insertIndex, 0, {
    coord: { replica: replicaIndex, clock },
    length: text.length,
    // Anchor (replica, 0) matches most live runs in the captures; its exact
    // semantics are still unknown (see dev notes). Sequence is assigned by
    // the caller's renumbering pass.
    anchor: { replica: replicaIndex, clock: 0 },
    tombstone: false,
    sequence: [],
  });
  replica.counters[0] = clock + text.length;
  return true;
}

function visibleLengthFrom(runs: readonly TextRun[], startIndex: number): number {
  let total = 0;
  for (let i = startIndex; i < runs.length; i += 1) {
    const run = runs[i];
    if (run && !run.tombstone) {
      total += run.length;
    }
  }
  return total;
}

/** Returns the 1-based replica-table index for `replicaId`, adding a new
 * entry if this document has never seen our replica. */
function ensureReplica(doc: NoteDocument, replicaId: Uint8Array): number {
  const existing = doc.replicas.findIndex((replica) => bytesEqual(replica.id, replicaId));
  if (existing !== -1) {
    return existing + 1;
  }
  // Counters start at zero: the text clock advances as we insert, and the
  // event counter is advanced by applyTextEdit's structural-change bump
  // (making a brand-new replica's first edit land on [inserted, 1], which
  // matches the captured create of a fresh note).
  doc.replicas.push({ id: replicaId, counters: [0, 0] });
  return doc.replicas.length;
}

function adjustAttributeRuns(doc: NoteDocument, start: number, deleteLength: number, insertLength: number): void {
  // Shrink the deleted range out of the runs covering it, dropping any run
  // the deletion fully consumes.
  const end = start + deleteLength;
  const out: AttributeRun[] = [];
  let visible = 0;
  for (const run of doc.attributeRuns) {
    const runStart = visible;
    const runEnd = visible + run.length;
    visible = runEnd;
    const overlap = Math.max(0, Math.min(end, runEnd) - Math.max(start, runStart));
    if (run.length - overlap > 0) {
      const piece = clone(AttributeRunSchema, run);
      piece.length = run.length - overlap;
      out.push(piece);
    }
  }
  if (visible < end) {
    throw new Error("Attribute runs are shorter than the deleted range - document model out of sync");
  }

  if (insertLength > 0) {
    // Grow the run containing the character just before the insertion point,
    // so inserted text inherits its formatting (matches the captured append,
    // which extended the trailing attribute run). At position 0, the first
    // run grows instead (inheriting the following character's formatting).
    let grown = false;
    let runEnd = 0;
    for (const run of out) {
      runEnd += run.length;
      if (start <= runEnd) {
        run.length += insertLength;
        grown = true;
        break;
      }
    }
    if (!grown) {
      const lastRun = out[out.length - 1];
      if (lastRun) {
        lastRun.length += insertLength;
      } else {
        // Every attribute run was consumed by the deletion (the note was
        // fully replaced): keep a single plain run covering the new text.
        out.push(create(AttributeRunSchema, { length: insertLength }));
      }
    }
  }
  doc.attributeRuns = out;
}

// --- validation ------------------------------------------------------------

export function validateDocumentInvariants(doc: NoteDocument): void {
  const visibleLength = doc.runs.filter((run) => !run.tombstone).reduce((sum, run) => sum + run.length, 0);
  if (visibleLength !== doc.text.length) {
    throw new Error(
      `Visible run lengths (${visibleLength}) do not match note text length (${doc.text.length}) - refusing to touch this note`,
    );
  }

  const attributeLength = doc.attributeRuns.reduce((sum, run) => sum + run.length, 0);
  if (attributeLength !== doc.text.length) {
    throw new Error(
      `Attribute run lengths (${attributeLength}) do not match note text length (${doc.text.length}) - refusing to touch this note`,
    );
  }

  for (const run of doc.runs) {
    if (isSentinel(run)) {
      continue;
    }
    if (run.coord.replica < 0 || run.coord.replica > doc.replicas.length) {
      throw new Error(`Run references replica ${run.coord.replica} outside the replica table - refusing to touch this note`);
    }
    const replica = run.coord.replica === 0 ? undefined : doc.replicas[run.coord.replica - 1];
    if (replica) {
      const clock = replica.counters[0] ?? 0;
      if (run.coord.clock + run.length > clock) {
        throw new Error(
          `Run clocks exceed replica ${run.coord.replica}'s counter (${run.coord.clock}+${run.length} > ${clock}) - refusing to touch this note`,
        );
      }
    }
  }
}

/** Exported for `tableCellEdit.ts`; see `parseTextRun`. */
export function isSentinel(run: TextRun): boolean {
  return run.coord.clock === SENTINEL_CLOCK;
}

// --- small shared helpers ---------------------------------------------------

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, i) => byte === b[i]);
}
