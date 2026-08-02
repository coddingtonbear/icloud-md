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
 *                 file's domain model calls it `sequence`. These are real
 *                 DAG edges (0-based indexes into the substring array, each
 *                 pointing at a *child* run), not save-order sequence
 *                 numbers: Apple's serializer writes each substring's
 *                 in-memory `children` array as indexes, and its save order
 *                 is a Kahn-style topological traversal, so every edge
 *                 points forward in the array. Linear documents therefore
 *                 look renumbered 1..N (run k points at run k+1) - the
 *                 shape that previously misled this file into flattening
 *                 the graph on every push. Edits now preserve the graph,
 *                 doing the same edge surgery Apple's own client does
 *                 (`splitTopoSubstring_atIndex` /
 *                 `insertAttributedString_after_before`, recovered from the
 *                 captured iCloud web bundle - dev log 2026-08-02).
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
import { diffIndices } from "node-diff3";
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
  /** This run's outgoing child edges in the insertion-order DAG: 0-based
   * indexes into the document's runs array, always pointing at a *later*
   * index (Apple serializes in topological order). Usually one entry; more
   * on a branch node, where concurrent replicas inserted after the same run
   * (a real 2026-07-15 capture carries a two-child run) - see
   * `proto/topotext.proto`'s `Substring.child` comment. Maintained through
   * edits by `splitRunAt`/`insertRunAt`; the end sentinel has none. */
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
 * Applies a plain-text edit to the document in place: the old and new text
 * are diffed into per-hunk splices (`computeSplices`), each removed visible
 * range is tombstoned - never physically deleted, other replicas need it to
 * merge - and each inserted piece becomes a new run (or extends our own
 * trailing run) with clocks from our replica's counter.
 *
 * Per-hunk rather than one spanning splice because the untouched text
 * BETWEEN two edits must keep its original runs and authorship: the
 * 2026-07-29 fusion investigation (vault dev log) caught the old
 * single-splice version tombstoning another replica's live runs and
 * re-authoring their text under our replica id merely because a second,
 * distant difference (a trailing newline) had destroyed the common suffix.
 * A device replica with unmerged history then revived its concurrently
 * edited runs alongside our re-authored copy, fusing the text.
 *
 * Returns false if the text is unchanged (nothing to push).
 */
export function applyTextEdit(doc: NoteDocument, newText: string, options: ApplyTextEditOptions): boolean {
  const oldText = doc.text;
  if (oldText === newText) {
    return false;
  }
  validateDocumentInvariants(doc);

  const splices = computeSplices(oldText, newText);
  const replicaIndex = ensureReplica(doc, options.replicaId);
  // Apple's TTMergeableString captures its style clock once per save pass
  // (generateIdsForLocalChanges reads `_replicaStyleClock` into a local
  // before the loop), so every stamp in one push shares the same floor.
  const styleClockFloor = styleClockSeed(doc, replicaIndex);
  let maxAssignedStyleClock = -1;

  let structuralChange = false;
  let insertedNewRun = false;
  // Splices carry oldText offsets, ascending and non-overlapping; applying
  // them in order shifts every later offset by the net length change so far.
  let delta = 0;
  for (const { start: oldStart, deleteLength, insertText } of splices) {
    const start = oldStart + delta;
    if (deleteLength > 0) {
      // A deletion is a formatting op in Apple's model: each tombstoned
      // substring is restamped with (us, max(its old style clock + 8, the
      // pass's style-clock floor)) - the deletion bias straight from Apple's
      // generateIdsForLocalChanges (`u.timestamp.clock + (isTombstone ? 8 :
      // 1)`), which biases a deletion to win the merge-time LWW against up
      // to 8 clock steps of concurrent restyling. The 2026-07-17
      // formatting-evolution capture's op-clock sequence 1 -> 9 -> 10 is
      // this exact rule observed live: max(0+8, 1) = 8 stamped, table 9.
      maxAssignedStyleClock = Math.max(
        maxAssignedStyleClock,
        tombstoneVisibleRange(doc, start, deleteLength, replicaIndex, styleClockFloor),
      );
      structuralChange = true;
    }
    if (insertText.length > 0) {
      const newRun = insertVisibleText(doc, start, insertText, replicaIndex);
      insertedNewRun = insertedNewRun || newRun;
      structuralChange = newRun || structuralChange;
    }
    adjustAttributeRuns(doc, start, deleteLength, insertText.length);
    delta += insertText.length - deleteLength;
  }

  // The second replica counter is the style clock
  // (TTMergeableStringTimestampTypeStyle in Apple's source): a pure
  // extension of the replica's own trailing run leaves it alone (observed
  // across two consecutive web-client saves of an append), a new run raises
  // it to at least 1 (Apple: `max(_replicaStyleClock, 1)` when stamping
  // fresh runs at clock 0), and restamped tombstones push it past the
  // highest clock they consumed (Apple: `max(d + 1, _replicaStyleClock)`).
  if (structuralChange) {
    const replica = doc.replicas[replicaIndex - 1];
    if (replica) {
      replica.counters[1] = Math.max(maxAssignedStyleClock + 1, styleClockFloor, insertedNewRun ? 1 : 0);
    }
  }

  // Child edges were maintained in place by the split/insert surgery above
  // (see TextRun.sequence): untouched runs keep the exact edges they were
  // parsed with - only index-shifted for array splices - so a branched
  // insertion graph survives our save the same way it survives Apple's.

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
      // ahead of all real content, its one child edge pointing at the end
      // sentinel - Apple's initWithReplicaID seeds exactly this two-node
      // graph, and the first insert splices itself into that edge.
      { coord: { replica: 0, clock: 0 }, length: 0, anchor: { replica: 0, clock: 0 }, tombstone: false, sequence: [1] },
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

// --- child-edge surgery -----------------------------------------------------

/** Adds `delta` to every child edge across `runs` that points at an array
 * index >= `threshold` - the bookkeeping every runs-array splice owes the
 * graph, since edges are stored as array indexes. */
function shiftChildEdges(runs: readonly TextRun[], threshold: number, delta: number): void {
  for (const run of runs) {
    for (let i = 0; i < run.sequence.length; i += 1) {
      if (run.sequence[i]! >= threshold) {
        run.sequence[i]! += delta;
      }
    }
  }
}

/**
 * Splits `runs[index]` at `offset` (0 < offset < length) into head and tail
 * in place, exactly the edge surgery of Apple's `splitTopoSubstring_atIndex`:
 * the tail inherits the head's outgoing child edges, the head's only child
 * becomes the tail, and every edge that pointed at the split run keeps
 * pointing at the head (which keeps the run's coord, so edges by index stay
 * correct). The tail lands at `index + 1`; returns it. Exported for
 * `tableCellEdit.ts`, whose cell strings share the run discipline.
 */
export function splitRunAt(runs: TextRun[], index: number, offset: number): TextRun {
  const run = runs[index];
  if (!run || offset <= 0 || offset >= run.length) {
    throw new Error(`Cannot split run ${index} at offset ${offset} - CRDT model out of sync`);
  }
  shiftChildEdges(runs, index + 1, 1);
  const tail: TextRun = {
    coord: { replica: run.coord.replica, clock: run.coord.clock + offset },
    length: run.length - offset,
    anchor: { replica: run.anchor.replica, clock: run.anchor.clock },
    tombstone: run.tombstone,
    // Ownership of the outgoing edges moves to the tail (values already
    // shifted above; they all pointed past `index`, this array is not
    // shared - every run's sequence array has one owner).
    sequence: run.sequence,
  };
  run.length = offset;
  run.sequence = [index + 1];
  runs.splice(index + 1, 0, tail);
  return tail;
}

/**
 * Splices a freshly created `run` into the array at `index` and into the
 * child graph between its new array neighbours, mirroring Apple's
 * `insertAttributedString_after_before`: when the predecessor has an edge to
 * the run being displaced, the new run takes that edge's place
 * (predecessor -> new -> successor); when it doesn't (a branched graph where
 * the array neighbours aren't graph-linked), the new run takes over ALL of
 * the predecessor's children and becomes its only child. Exported for
 * `tableCellEdit.ts`.
 */
export function insertRunAt(runs: TextRun[], index: number, run: TextRun): void {
  shiftChildEdges(runs, index, 1);
  const predecessor = index > 0 ? runs[index - 1] : undefined;
  if (predecessor) {
    // The displaced successor sat at `index`; after the shift, edges to it
    // read `index + 1`.
    const successorEdge = predecessor.sequence.indexOf(index + 1);
    if (successorEdge !== -1) {
      predecessor.sequence[successorEdge] = index;
      run.sequence = [index + 1];
    } else {
      run.sequence = predecessor.sequence;
      predecessor.sequence = [index];
    }
  } else {
    // No predecessor: a document without the usual zero-length origin lead
    // run (never observed in a capture). The new run becomes a start node
    // pointing at the run it displaced.
    run.sequence = [index + 1];
  }
  runs.splice(index, 0, run);
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

/**
 * Multi-hunk diff over UTF-16 code units: line-level LCS (node-diff3, the
 * same engine `mergeConflict.ts` merges with) locates each changed region,
 * then `computeSplice` tightens every hunk to character precision. Returned
 * splices carry non-overlapping, ascending `oldText` offsets.
 *
 * This is what keeps a push's CRDT edit minimal when the file differs from
 * the server text in more than one place (two edited paragraphs, or an edit
 * plus the markdown pipeline's trailing newline): only genuinely changed
 * characters are tombstoned/inserted, and everything between hunks keeps its
 * original runs and authorship - see `applyTextEdit`'s doc comment for the
 * fusion this prevents.
 */
export function computeSplices(oldText: string, newText: string): Splice[] {
  if (oldText === newText) {
    return [];
  }
  const oldLines = splitLinesInclusive(oldText);
  const newLines = splitLinesInclusive(newText);
  const oldOffsets = lineStartOffsets(oldLines);
  const newOffsets = lineStartOffsets(newLines);

  const splices: Splice[] = [];
  for (const hunk of diffIndices(oldLines, newLines)) {
    const oldStart = oldOffsets[hunk.buffer1[0]]!;
    const oldHunk = hunk.buffer1Content.join("");
    const newStart = newOffsets[hunk.buffer2[0]]!;
    const newHunk = hunk.buffer2Content.join("");
    const inner = computeSplice(oldHunk, newHunk);
    if (inner.deleteLength === 0 && inner.insertText.length === 0) {
      continue;
    }
    splices.push({ start: oldStart + inner.start, deleteLength: inner.deleteLength, insertText: inner.insertText });
  }
  return splices;
}

/** Splits into lines with their "\n" terminators kept attached, so line
 * indexes convert to character offsets by plain accumulation. */
function splitLinesInclusive(text: string): string[] {
  const lines = text.split("\n").map((line) => `${line}\n`);
  const last = lines[lines.length - 1]!;
  if (last === "\n") {
    lines.pop();
  } else {
    lines[lines.length - 1] = last.slice(0, -1);
  }
  return lines;
}

/** `result[i]` = character offset where line `i` starts; one extra trailing
 * entry (the text's total length) so a hunk starting past the last line -
 * a pure append - still resolves. */
function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [0];
  for (const line of lines) {
    offsets.push(offsets[offsets.length - 1]! + line.length);
  }
  return offsets;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Marks the visible range [start, start+length) as tombstoned, splitting
 * runs where the range boundaries fall inside one (`splitRunAt`, which owns
 * the child-edge surgery - tombstoning itself never touches edges, exactly
 * like Apple's `deleteSubstrings_withCharacterRanges`), and restamps each
 * newly tombstoned piece's style timestamp with (replicaIndex, max(its old
 * style clock + 8, styleClockFloor)) - Apple's deletion-bias rule from
 * generateIdsForLocalChanges. Returns the highest clock stamped (or -1 when
 * the range covered nothing), so the caller can advance the replica's style
 * clock past it. Clock arithmetic follows the pattern in captured notes: a
 * run starting at clock c, split at offset k, continues at c+k. */
function tombstoneVisibleRange(
  doc: NoteDocument,
  start: number,
  length: number,
  replicaIndex: number,
  styleClockFloor: number,
): number {
  const end = start + length;
  if (end > visibleLengthFrom(doc.runs, 0)) {
    throw new Error("Tombstone range extends past the end of the visible text - CRDT model out of sync");
  }
  const runs = doc.runs;
  let visible = 0;
  let maxAssigned = -1;
  for (let i = 0; i < runs.length && visible < end; i += 1) {
    const run = runs[i]!;
    if (run.tombstone || run.length === 0 || isSentinel(run)) {
      continue;
    }
    const runStart = visible;
    const runEnd = runStart + run.length;
    if (runEnd <= start) {
      visible = runEnd;
      continue;
    }

    let target = run;
    let targetIndex = i;
    let targetStart = runStart;
    if (start > runStart) {
      target = splitRunAt(runs, i, start - runStart);
      targetIndex = i + 1;
      targetStart = start;
    }
    if (end < targetStart + target.length) {
      splitRunAt(runs, targetIndex, end - targetStart);
    }
    const assigned = Math.max(target.anchor.clock + 8, styleClockFloor);
    target.tombstone = true;
    target.anchor = { replica: replicaIndex, clock: assigned };
    maxAssigned = Math.max(maxAssigned, assigned);
    visible = targetStart + target.length;
    i = targetIndex;
  }
  return maxAssigned;
}

/**
 * Applies one formatting operation covering the given visible ranges, the
 * way Apple's client does (generateIdsForLocalChanges): every substring
 * overlapping a range - split at range boundaries - has its style timestamp
 * restamped with (us, max(its old style clock + 1, the pass's style-clock
 * floor)), and the replica's style clock (second counter) ends past the
 * highest stamp assigned. The caller is responsible for the attribute-run
 * rewrite the op corresponds to (`formatReconcile.ts`).
 */
export function applyFormattingOp(doc: NoteDocument, ranges: readonly { start: number; end: number }[], replicaId: Uint8Array): void {
  const replicaIndex = ensureReplica(doc, replicaId);
  const replica = doc.replicas[replicaIndex - 1]!;
  const styleClockFloor = styleClockSeed(doc, replicaIndex);
  let maxAssigned = -1;
  for (const range of ranges) {
    maxAssigned = Math.max(maxAssigned, restampVisibleRange(doc, range.start, range.end, replicaIndex, styleClockFloor));
  }
  replica.counters[1] = Math.max(maxAssigned + 1, styleClockFloor);
}

/** Restamps the style timestamp of every visible substring overlapping
 * [start, end), splitting runs at the boundaries (`splitRunAt` owns the
 * child-edge surgery; restamping itself never touches edges); each
 * restamped piece gets (replicaIndex, max(its old style clock + 1,
 * styleClockFloor)). Returns the highest clock stamped, or -1 when nothing
 * overlapped. */
function restampVisibleRange(
  doc: NoteDocument,
  start: number,
  end: number,
  replicaIndex: number,
  styleClockFloor: number,
): number {
  const runs = doc.runs;
  let visible = 0;
  let maxAssigned = -1;
  for (let i = 0; i < runs.length && visible < end; i += 1) {
    const run = runs[i]!;
    if (run.tombstone || run.length === 0 || isSentinel(run)) {
      continue;
    }
    const runStart = visible;
    const runEnd = runStart + run.length;
    if (runEnd <= start) {
      visible = runEnd;
      continue;
    }

    let target = run;
    let targetIndex = i;
    let targetStart = runStart;
    if (start > runStart) {
      target = splitRunAt(runs, i, start - runStart);
      targetIndex = i + 1;
      targetStart = start;
    }
    if (end < targetStart + target.length) {
      splitRunAt(runs, targetIndex, end - targetStart);
    }
    const assigned = Math.max(target.anchor.clock + 1, styleClockFloor);
    target.anchor = { replica: replicaIndex, clock: assigned };
    maxAssigned = Math.max(maxAssigned, assigned);
    visible = targetStart + target.length;
    i = targetIndex;
  }
  return maxAssigned;
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
        splitRunAt(doc.runs, i, offset);
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

  insertRunAt(doc.runs, insertIndex, {
    coord: { replica: replicaIndex, clock },
    length: text.length,
    // The anchor is the run's style timestamp in the formatting-op clock
    // domain (`counters[1]`), not a position: (replica, 0) = "never
    // restyled", exactly what the iOS client writes for its own plain typed
    // runs (2026-07-29 device captures, vault dev log). Clients bulk-restamp
    // it on style ops. Child edges are wired by `insertRunAt`.
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
  // A replica joining an existing document initializes both clocks to the
  // maxima observed across the table - the 2026-07-17 formatting-evolution
  // follow-up capture shows Apple's own fresh web replica picking up the
  // previous session's text clock and continuing the global formatting-op
  // numbering (so its ops win LWW against every older op, as intended). On
  // a brand-new document (empty table) both maxima are zero, which is
  // exactly the captured create shape.
  const maxTextClock = Math.max(0, ...doc.replicas.map((replica) => replica.counters[0] ?? 0));
  const maxOpClock = Math.max(0, ...doc.replicas.map((replica) => replica.counters[1] ?? 0));
  doc.replicas.push({ id: replicaId, counters: [maxTextClock, maxOpClock] });
  return doc.replicas.length;
}

/**
 * The style-clock floor for one editing pass, mirroring Apple's
 * `updateClock`: the highest style timestamp any run in the document
 * carries (compared clock-first, then by replica UUID bytes - the same
 * TTIDComparator ordering the merge's LWW uses), plus one when that
 * stamp's holder would beat us in the UUID tie-break, so our new stamps
 * never lose to anything already in the document. Also floored at our own
 * table counter so the clock never regresses. Replica 0 is the
 * origin/sentinel pseudo-replica and carries no real stamps.
 */
function styleClockSeed(doc: NoteDocument, replicaIndex: number): number {
  const ourId = doc.replicas[replicaIndex - 1]?.id;
  if (!ourId) {
    throw new Error("Replica entry is missing while seeding the style clock");
  }
  let maxClock = -1;
  let maxHolder: Uint8Array | undefined;
  for (const run of doc.runs) {
    if (run.anchor.replica === 0) {
      continue;
    }
    const holder = doc.replicas[run.anchor.replica - 1]?.id ?? new Uint8Array(16);
    if (run.anchor.clock > maxClock || (run.anchor.clock === maxClock && maxHolder && compareBytes(holder, maxHolder) > 0)) {
      maxClock = run.anchor.clock;
      maxHolder = holder;
    }
  }
  let seed = 0;
  if (maxHolder !== undefined) {
    seed = maxClock + (compareBytes(maxHolder, ourId) >= 0 ? 1 : 0);
  }
  return Math.max(seed, doc.replicas[replicaIndex - 1]?.counters[1] ?? 0);
}

/** Byte-lexicographic UUID comparison - Apple's NSUUID compare, the
 * tie-break half of TTIDComparator's (clock, replicaID) ordering. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return a.length - b.length;
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
    //
    // Exception: a run carrying `attachmentInfo` must keep covering exactly
    // its one U+FFFC placeholder - growing it would attach the inserted text
    // to the embed, a shape Apple's own clients never write (every captured
    // attachmentInfo run is length 1). Inserting right next to an embed
    // gives the text its own run instead, inheriting the embed's paragraph
    // formatting but not the attachment linkage.
    let grown = false;
    let runEnd = 0;
    for (let i = 0; i < out.length; i += 1) {
      const run = out[i];
      if (!run) {
        continue;
      }
      runEnd += run.length;
      if (start <= runEnd) {
        if (run.attachmentInfo === undefined) {
          run.length += insertLength;
        } else {
          const piece = clone(AttributeRunSchema, run);
          piece.attachmentInfo = undefined;
          piece.length = insertLength;
          out.splice(start === runEnd ? i + 1 : i, 0, piece);
        }
        grown = true;
        break;
      }
    }
    if (!grown) {
      const lastRun = out[out.length - 1];
      if (lastRun && lastRun.attachmentInfo === undefined) {
        lastRun.length += insertLength;
      } else if (lastRun) {
        const piece = clone(AttributeRunSchema, lastRun);
        piece.attachmentInfo = undefined;
        piece.length = insertLength;
        out.push(piece);
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

  validateChildEdges(doc.runs);
}

/**
 * Sanity for the child-edge graph (see `TextRun.sequence`): every edge in
 * range and strictly forward-pointing (Apple's save order is a topological
 * traversal, so any document its clients wrote satisfies this - and forward
 * edges can't form a cycle), and every non-sentinel run linked into the
 * graph (only the end sentinel is an end node in a non-fragment document).
 * Exported for `tableCellEdit.ts`'s cell/mirror variant of the discipline.
 */
export function validateChildEdges(runs: readonly TextRun[], what = "note"): void {
  runs.forEach((run, index) => {
    if (isSentinel(run)) {
      return;
    }
    if (run.sequence.length === 0) {
      throw new Error(`Run ${index} has no child edge - refusing to touch this ${what}`);
    }
    for (const child of run.sequence) {
      if (!Number.isInteger(child) || child <= index || child >= runs.length) {
        throw new Error(`Run ${index} has a child edge to ${child}, outside the forward range - refusing to touch this ${what}`);
      }
    }
  });
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
