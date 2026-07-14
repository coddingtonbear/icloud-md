/**
 * Typed model of the decompressed TextDataEncrypted "mergeable data" document
 * - the same protobuf `noteText.ts` reads note_text out of, but parsed
 * strictly enough to be *edited and re-encoded*, which is what `push` needs.
 *
 * The shape here was derived empirically from real `records/modify` bodies
 * captured from www.icloud.com (see the project dev notes, 2026-07-13 "push
 * groundwork" entry), cross-checked against every note in those captures:
 *
 *   root:      1: varint            (always 0 so far; preserved verbatim)
 *              2: Document
 *   Document:  1: varint, 2: varint (preserved verbatim)
 *              3: Note
 *   Note:      2: note_text (UTF-8 string; title is its first line)
 *              3: repeated TextRun  - the CRDT history of the string
 *              4: replica table     - repeated { 1: 16-byte UUID, 2+: clocks }
 *              5: repeated AttributeRun - formatting spans over visible text
 *   TextRun:   1: Coord { 1: replica index, 2: clock }
 *              2: length
 *              3: Coord (anchor; semantics not fully understood, preserved)
 *              4: tombstone flag (1 = deleted text, retained for merging)
 *              5: sequence number
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
 * project README's Phase 3 plan.
 */

import { bytesToken, encodeProtoTokens, readProtoTokens, varintToken, type ProtoToken } from "./protobuf.js";

export interface RunCoord {
  replica: number;
  clock: number;
}

export interface TextRun {
  coord: RunCoord;
  length: number;
  anchor: RunCoord;
  tombstone: boolean;
  sequence: number | undefined;
}

export interface ReplicaEntry {
  id: Uint8Array;
  /** First entry is the replica's text clock (total UTF-16 units it has
   * inserted); later entries' meanings are unknown and preserved verbatim. */
  counters: number[];
}

export interface AttributeRun {
  length: number;
  /** Everything but the length (paragraph style, fonts, ...) - opaque,
   * preserved in original order. */
  rest: ProtoToken[];
}

export interface NoteDocument {
  /** root-level tokens; the Document token's position is preserved. */
  rootTokens: ProtoToken[];
  /** Document-level tokens; the Note token's position is preserved. */
  documentTokens: ProtoToken[];
  text: string;
  runs: TextRun[];
  replicas: ReplicaEntry[];
  attributeRuns: AttributeRun[];
}

const ROOT_DOCUMENT_FIELD = 2;
const DOCUMENT_NOTE_FIELD = 3;
const NOTE_TEXT_FIELD = 2;
const NOTE_RUN_FIELD = 3;
const NOTE_REPLICA_TABLE_FIELD = 4;
const NOTE_ATTRIBUTE_RUN_FIELD = 5;
const SENTINEL_CLOCK = 0xffffffff;

export function parseNoteDocument(raw: Uint8Array): NoteDocument {
  const rootTokens = readProtoTokens(raw);
  const documentToken = singleBytesToken(rootTokens, ROOT_DOCUMENT_FIELD, "root Document");

  const documentTokens = readProtoTokens(documentToken.bytes);
  const noteToken = singleBytesToken(documentTokens, DOCUMENT_NOTE_FIELD, "Document Note");

  const note = parseNote(readProtoTokens(noteToken.bytes));
  return { rootTokens, documentTokens, ...note };
}

export function encodeNoteDocument(doc: NoteDocument): Uint8Array {
  const noteTokens: ProtoToken[] = [bytesToken(NOTE_TEXT_FIELD, new TextEncoder().encode(doc.text))];
  for (const run of doc.runs) {
    noteTokens.push(bytesToken(NOTE_RUN_FIELD, encodeRun(run)));
  }
  noteTokens.push(bytesToken(NOTE_REPLICA_TABLE_FIELD, encodeReplicaTable(doc.replicas)));
  for (const attributeRun of doc.attributeRuns) {
    noteTokens.push(
      bytesToken(NOTE_ATTRIBUTE_RUN_FIELD, encodeProtoTokens([varintToken(1, attributeRun.length), ...attributeRun.rest])),
    );
  }

  const documentTokens = replaceBytesToken(doc.documentTokens, DOCUMENT_NOTE_FIELD, encodeProtoTokens(noteTokens));
  const rootTokens = replaceBytesToken(doc.rootTokens, ROOT_DOCUMENT_FIELD, encodeProtoTokens(documentTokens));
  return encodeProtoTokens(rootTokens);
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
  // them renumbered 1..N in list (= document) order, so do the same.
  renumberSequences(doc);

  doc.text = newText;
  validateDocumentInvariants(doc);
  return true;
}

function renumberSequences(doc: NoteDocument): void {
  let sequence = 1;
  for (const run of doc.runs) {
    if (isSentinel(run)) {
      continue;
    }
    run.sequence = sequence;
    sequence += 1;
  }
}

// --- parsing ---------------------------------------------------------------

function parseNote(tokens: ProtoToken[]): Pick<NoteDocument, "text" | "runs" | "replicas" | "attributeRuns"> {
  // Strict field ordering: text, runs, replica table, attribute runs. Every
  // captured note matches this; anything else fails the round-trip gate
  // anyway (we re-encode in this order), so reject it up front.
  const kinds = tokens.map((token) => token.fieldNumber);
  const expected = [...kinds].sort((a, b) => a - b);
  if (!kinds.every((kind, i) => kind === expected[i])) {
    throw new Error("Note document fields are not in canonical order");
  }

  const textToken = singleBytesToken(tokens, NOTE_TEXT_FIELD, "note_text");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(textToken.bytes);

  const runs = tokens
    .filter((t) => t.fieldNumber === NOTE_RUN_FIELD)
    .map((t) => parseRun(expectBytes(t, "TextRun").bytes));
  const replicaTable = singleBytesToken(tokens, NOTE_REPLICA_TABLE_FIELD, "replica table");
  const replicas = parseReplicaTable(replicaTable.bytes);
  const attributeRuns = tokens
    .filter((t) => t.fieldNumber === NOTE_ATTRIBUTE_RUN_FIELD)
    .map((t) => parseAttributeRun(expectBytes(t, "AttributeRun").bytes));

  const known = new Set([NOTE_TEXT_FIELD, NOTE_RUN_FIELD, NOTE_REPLICA_TABLE_FIELD, NOTE_ATTRIBUTE_RUN_FIELD]);
  const unknown = tokens.find((t) => !known.has(t.fieldNumber));
  if (unknown) {
    throw new Error(`Note document has unrecognized field ${unknown.fieldNumber}`);
  }

  return { text, runs, replicas, attributeRuns };
}

function parseRun(bytes: Uint8Array): TextRun {
  const tokens = readProtoTokens(bytes);
  let coord: RunCoord | undefined;
  let length: number | undefined;
  let anchor: RunCoord | undefined;
  let tombstone = false;
  let sequence: number | undefined;

  for (const token of tokens) {
    switch (token.fieldNumber) {
      case 1:
        if (coord !== undefined) throw new Error("TextRun has repeated coord");
        coord = parseCoord(expectBytes(token, "TextRun coord").bytes);
        break;
      case 2:
        length = Number(expectVarint(token, "TextRun length").varint);
        break;
      case 3:
        if (anchor !== undefined) throw new Error("TextRun has repeated anchor");
        anchor = parseCoord(expectBytes(token, "TextRun anchor").bytes);
        break;
      case 4: {
        const flag = expectVarint(token, "TextRun tombstone flag").varint;
        if (flag !== 1n) throw new Error(`TextRun tombstone flag has unexpected value ${flag}`);
        tombstone = true;
        break;
      }
      case 5:
        sequence = Number(expectVarint(token, "TextRun sequence").varint);
        break;
      default:
        throw new Error(`TextRun has unrecognized field ${token.fieldNumber}`);
    }
  }

  if (!coord || length === undefined || !anchor) {
    throw new Error("TextRun is missing coord, length, or anchor");
  }
  return { coord, length, anchor, tombstone, sequence };
}

function parseCoord(bytes: Uint8Array): RunCoord {
  const tokens = readProtoTokens(bytes);
  if (tokens.length !== 2 || tokens[0]?.fieldNumber !== 1 || tokens[1]?.fieldNumber !== 2) {
    throw new Error("Run coordinate does not have the expected {replica, clock} shape");
  }
  return {
    replica: Number(expectVarint(tokens[0], "coord replica").varint),
    clock: Number(expectVarint(tokens[1], "coord clock").varint),
  };
}

function parseReplicaTable(bytes: Uint8Array): ReplicaEntry[] {
  return readProtoTokens(bytes).map((token) => {
    if (token.fieldNumber !== 1) {
      throw new Error(`Replica table has unrecognized field ${token.fieldNumber}`);
    }
    const entryTokens = readProtoTokens(expectBytes(token, "replica entry").bytes);
    const [idToken, ...counterTokens] = entryTokens;
    if (!idToken || idToken.fieldNumber !== 1 || idToken.wireType !== 2 || idToken.bytes.length !== 16) {
      throw new Error("Replica entry does not start with a 16-byte UUID");
    }
    const counters = counterTokens.map((counterToken) => {
      if (counterToken.fieldNumber !== 2) {
        throw new Error(`Replica entry has unrecognized field ${counterToken.fieldNumber}`);
      }
      const inner = readProtoTokens(expectBytes(counterToken, "replica counter").bytes);
      if (inner.length !== 1 || inner[0]?.fieldNumber !== 1) {
        throw new Error("Replica counter does not have the expected single-varint shape");
      }
      return Number(expectVarint(inner[0], "replica counter value").varint);
    });
    return { id: idToken.bytes, counters };
  });
}

function parseAttributeRun(bytes: Uint8Array): AttributeRun {
  const tokens = readProtoTokens(bytes);
  const [lengthToken, ...rest] = tokens;
  if (!lengthToken || lengthToken.fieldNumber !== 1 || lengthToken.wireType !== 0) {
    throw new Error("AttributeRun does not start with a length");
  }
  if (rest.some((token) => token.fieldNumber === 1)) {
    throw new Error("AttributeRun has a repeated length field");
  }
  return { length: Number(lengthToken.varint), rest };
}

// --- encoding --------------------------------------------------------------

function encodeRun(run: TextRun): Uint8Array {
  const tokens: ProtoToken[] = [
    bytesToken(1, encodeCoord(run.coord)),
    varintToken(2, run.length),
    bytesToken(3, encodeCoord(run.anchor)),
  ];
  if (run.tombstone) {
    tokens.push(varintToken(4, 1));
  }
  if (run.sequence !== undefined) {
    tokens.push(varintToken(5, run.sequence));
  }
  return encodeProtoTokens(tokens);
}

function encodeCoord(coord: RunCoord): Uint8Array {
  // Zero values are encoded explicitly (Apple's encoder does the same, and
  // the round-trip gate depends on matching it).
  return encodeProtoTokens([varintToken(1, coord.replica), varintToken(2, coord.clock)]);
}

function encodeReplicaTable(replicas: readonly ReplicaEntry[]): Uint8Array {
  return encodeProtoTokens(
    replicas.map((replica) =>
      bytesToken(
        1,
        encodeProtoTokens([
          bytesToken(1, replica.id),
          ...replica.counters.map((counter) => bytesToken(2, encodeProtoTokens([varintToken(1, counter)]))),
        ]),
      ),
    ),
  );
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

/** A sub-range of `run` as its own run, with fresh coord/anchor objects. */
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
    sequence: undefined,
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
      out.push({ length: run.length - overlap, rest: run.rest });
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
        out.push({ length: insertLength, rest: [] });
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

function isSentinel(run: TextRun): boolean {
  return run.coord.clock === SENTINEL_CLOCK;
}

// --- small shared helpers ---------------------------------------------------

function singleBytesToken(tokens: ProtoToken[], fieldNumber: number, label: string): { bytes: Uint8Array } {
  const matches = tokens.filter((token) => token.fieldNumber === fieldNumber);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} field, found ${matches.length}`);
  }
  return expectBytes(matches[0] as ProtoToken, label);
}

function replaceBytesToken(tokens: ProtoToken[], fieldNumber: number, bytes: Uint8Array): ProtoToken[] {
  return tokens.map((token) => (token.fieldNumber === fieldNumber ? bytesToken(fieldNumber, bytes) : token));
}

function expectBytes(token: ProtoToken, label: string): { bytes: Uint8Array } {
  if (token.wireType !== 2) {
    throw new Error(`${label} is not a length-delimited field`);
  }
  return token;
}

function expectVarint(token: ProtoToken, label: string): { varint: bigint } {
  if (token.wireType !== 0) {
    throw new Error(`${label} is not a varint field`);
  }
  return token;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, i) => byte === b[i]);
}
