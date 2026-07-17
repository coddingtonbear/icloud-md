/**
 * Reads and writes a table's `MergeableDataEncrypted` payload (an
 * `Attachment` record whose `UTI` is `com.apple.notes.table`) - a
 * GitHub-flavored-Markdown pipe table on one side, the object-pool CRDT
 * structure Apple's client uses on the other.
 *
 * The structure was reverse-engineered from real captures and cross-checked
 * against threeplanetssoftware/apple_cloud_notes_parser's
 * `AppleNotesEmbeddedTable.rb` (MIT licensed) - see the project dev notes,
 * "Consolidated reference: the complete `com.apple.notes.table`
 * MergeableData structure" (2026-07-14T14:46) and "Table write path planned
 * end-to-end" (2026-07-15T14:51), and `proto/notestore.proto` for the
 * generated-schema field names used below.
 *
 * Shape, once decompressed the same way `decompressNoteDocument` does:
 *
 *   MergableDataProto.mergableDataObject.mergeableDataObjectData
 *     .mergeableDataObjectEntry[]      object pool, addressed by index
 *                                      everywhere else via an ObjectID's
 *                                      `objectIndex` ("ref N" below)
 *     .mergeableDataObjectKeyItem[]    key-name table (strings)
 *     .mergeableDataObjectUuidItem[]   UUID table (16-byte UUIDs, plain-index addressed)
 *
 * `pool[0]` is the table object: a `customMap` (field 13), repeated
 * `MapEntry { key: key-table-index, value: ObjectID }` pairs, with keys
 * `crRows`, `crColumns`, `cellColumns` (each a ref) resolved via the
 * key-name table.
 *
 * `crRows`/`crColumns` are `OrderedSet` objects (field 16): `.ordering.array`
 * is the true visual-order list - `.ordering.array.attachment[]` is the
 * ordered `{index (redundant, ignored on read), uuid}` entries, list
 * position = visual position; `.ordering.array.contents` is a hidden
 * per-character CRDT mirror of that same list (one U+FFFC per entry) that
 * Apple's own client apparently uses for concurrent-insert merge resolution -
 * this project's editing operations deliberately don't maintain it (see
 * `insertRowAt`/`insertColumnAt`/`deleteRowAt`/`deleteColumnAt` in
 * `tableEdit.ts`): our own decode never reads it, so it has no effect on our
 * round-trip guarantee, only a theoretical effect on how gracefully a real
 * Apple client would later merge concurrent edits against a row/column this
 * tool added or removed - flagged as a known limitation for the live-push
 * verification the write path still needs (dev notes, 2026-07-15T14:51).
 * `.ordering.contents` (of `OrderedSetOrdering`) is a translation/redirect
 * `Dictionary` resolving stale/duplicate identities from concurrent edits
 * onto their canonical counterpart - not an order signal itself, and never
 * populated for rows/columns this tool creates (see `tableEdit.ts`).
 * `.elements` (of `OrderedSet` itself) is a `Dictionary` of trivial
 * `{key: ref, value: ref}` self-pairs, one per live `array.attachment`
 * entry (confirmed via real captures) - bookkeeping this project's decode
 * never reads either, but cheap enough to keep in sync on every structural
 * edit, so `tableEdit.ts` does.
 *
 * A row/column identity object is a `customMap` (`type` 2, confirmed via
 * real captures) with exactly one entry, key `UUIDIndex`, value a plain
 * inline number (`ObjectID.unsignedIntegerValue`) - the index into the
 * document-level UUID table. This value, not the object's own pool position,
 * is the join key used everywhere below. Real captures pair each row/column
 * with a second, otherwise-identical identity object plus a redirect entry
 * in `.ordering.contents` (never both referenced by the same live position -
 * apparently residue from Apple's own concurrent-edit history); this
 * project's own inserts create a single identity object and no redirect,
 * which decodes identically and needs no such pairing to be self-consistent
 * (see `tableEdit.ts` and the file's write-path dev note for why: the bar is
 * our own round-trip, not byte-identity with Apple's encoder).
 *
 * `cellColumns` is a `dictionary` (field 6), repeated `DictionaryElement
 * {key: ref to a column identity object, value: ref to that column's
 * row-map object}`. A row-map object has the identical shape: `{key: ref to
 * a row identity object, value: ref to a cell-text object}`. A cell-text
 * object is a `note` (field 10) whose `noteText` is the literal cell text -
 * the ground truth this project's decode reads directly, rather than
 * reconstructing visible text from `text_run` history the way the top-level
 * note body's decode does (see `tableCellEdit.ts` for why edits still have
 * to maintain that history correctly regardless).
 *
 * Row 0 is not structurally special: deleting the header row goes through
 * the exact same mechanism as any other row (confirmed via a real capture,
 * dev notes 2026-07-15T14:51) - it's rendered as a GFM header row purely
 * because GFM pipe tables require one syntactically.
 */

import { fromBinary, isFieldSet, toBinary } from "@bufbuild/protobuf";
import { compressNoteDocument, decompressNoteDocument } from "./noteText.js";
import { renderMarkdownTable } from "./markdownTable.js";
import type { MergeableDataPool } from "./mergeableDataPool.js";
import {
  MergableDataProtoSchema,
  ObjectIDSchema,
  type MergableDataProto,
  type MergeableDataObjectEntry,
  type ObjectID,
  type OrderedSet as OrderedSetMessage,
} from "./gen/notestore_pb.js";

export const OBJECT_INDEX_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "objectIndex")!;
export const UNSIGNED_INTEGER_VALUE_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "unsignedIntegerValue")!;
const STRING_VALUE_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "stringValue")!;

/** A row/column identity object's `customMap.type` (confirmed via real captures). */
export const IDENTITY_OBJECT_TYPE = 2;

/** Same shape as `mergeableDataPool.ts`'s generic `MergeableDataPool` - kept
 * as its own name here since most of this file's own history predates that
 * module, but it's the same type, not a parallel one. Every array is the
 * same reference as `TableDocument.message`'s own fields - mutating in
 * place (never reassigning) is what keeps `TableDocument.message` and this
 * pool consistent through edits. */
export type TablePool = MergeableDataPool;

/** A parsed, editable table document: the full protobuf message (mutable in
 * place via `@bufbuild/protobuf`'s `create`), plus the three top-level pool
 * refs every table-editing operation needs. Deliberately does *not* cache a
 * resolved rows/columns/cells snapshot as document fields - those go stale
 * the moment a structural edit runs, which is every edit `tableEdit.ts`
 * makes; `resolveTable` below computes a fresh one on demand instead. */
export interface TableDocument extends TablePool {
  message: MergableDataProto;
  crRowsRef: number;
  crColumnsRef: number;
  cellColumnsRef: number;
}

export interface TableRowColumn {
  /** Pool index of this row/column's identity object. */
  identityRef: number;
  /** Index into the document UUID table - the join key used everywhere else. */
  uuidIndex: number;
}

export interface TableCell {
  /** Pool index of the cell-text object (a `note`, field 10). */
  textRef: number;
  text: string;
}

export interface ResolvedTable {
  /** Rows/columns, in true visual order. */
  rows: TableRowColumn[];
  columns: TableRowColumn[];
  /** Keyed `${rowUuidIndex},${columnUuidIndex}`. */
  cells: Map<string, TableCell>;
}

const TABLE_OBJECT_INDEX = 0;
const LEFT_TO_RIGHT_DIRECTION = "CRTableColumnDirectionLeftToRight";

export function decodeTableMarkdown(compressedMergeableData: Buffer): string {
  const doc = parseTableDocument(compressedMergeableData);
  return renderMarkdownTable(gridFromTableDocument(doc));
}

export function gridFromTableDocument(doc: TableDocument): string[][] {
  const resolved = resolveTable(doc);
  const numRows = resolved.rows.length;
  const numCols = resolved.columns.length;
  if (numCols === 0) {
    throw new Error("Table has no columns - refusing to guess at its structure");
  }
  const grid: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(""));
  resolved.rows.forEach((_row, rowPos) => {
    resolved.columns.forEach((_col, colPos) => {
      const cell = resolved.cells.get(cellKey(rowPos, colPos));
      if (cell) {
        const rowCells = grid[rowPos];
        if (rowCells) {
          rowCells[colPos] = cell.text;
        }
      }
    });
  });
  return grid;
}

/** Keys `ResolvedTable.cells` by *position* (index into `ResolvedTable.rows`/
 * `.columns`), not by UUID-table index - real captures occasionally have a
 * row/column identity referenced by `cellColumns` that differs from the one
 * referenced by `crRows`/`crColumns`' own `OrderedSet.array` for the exact
 * same visual row/column (see `decodeTableRecord.ts`'s file header on
 * identity-pair residue), reconciled only via `computePositions`' redirect
 * following - so position, not raw identity, is the only key that's
 * guaranteed consistent between `resolveTable`'s two passes. */
export function cellKey(rowPosition: number, columnPosition: number): string {
  return `${rowPosition},${columnPosition}`;
}

// --- parse / encode / round-trip ------------------------------------------

export function parseTableDocument(compressedMergeableData: Buffer): TableDocument {
  const raw = decompressNoteDocument(compressedMergeableData);
  const message = fromBinary(MergableDataProtoSchema, raw);
  const pool = poolFromMessage(message);
  assertLeftToRight(pool);
  const refs = resolveTableRefs(pool);
  return { ...pool, message, ...refs };
}

/** `parseTableDocument` + `toBinary`/compress - always reflects `doc.message`
 * as currently mutated, since `doc.objects`/`.keyNames`/`.uuidTable` are the
 * same array references embedded in it. */
export function encodeTableDocument(doc: TableDocument): Buffer {
  const raw = toBinary(MergableDataProtoSchema, doc.message);
  return compressNoteDocument(raw);
}

/** The byte-for-byte round-trip gate over the *decompressed* bytes, same
 * discipline as `noteDocumentRoundTrips` - the compressed container isn't
 * compared, since re-deflating isn't guaranteed byte-stable and isn't what
 * we're actually verifying (whether our model captured everything). */
export function tableDocumentRoundTrips(compressedMergeableData: Buffer): boolean {
  let raw: Buffer;
  try {
    raw = decompressNoteDocument(compressedMergeableData);
  } catch {
    return false;
  }
  try {
    const message = fromBinary(MergableDataProtoSchema, raw);
    const pool = poolFromMessage(message);
    assertLeftToRight(pool);
    resolveTableRefs(pool);
    const reencoded = toBinary(MergableDataProtoSchema, message);
    return bytesEqual(raw, reencoded);
  } catch {
    return false;
  }
}

function poolFromMessage(message: MergableDataProto): TablePool {
  const data = message.mergableDataObject?.mergeableDataObjectData;
  if (!data) {
    throw new Error("Table MergeableData missing the object data field");
  }
  return {
    objects: data.mergeableDataObjectEntry,
    keyNames: data.mergeableDataObjectKeyItem,
    uuidTable: data.mergeableDataObjectUuidItem,
    generationStamps: data.unknownField1,
  };
}

function resolveTableRefs(pool: TablePool): { crRowsRef: number; crColumnsRef: number; cellColumnsRef: number } {
  const tableObject = pool.objects[TABLE_OBJECT_INDEX];
  if (!tableObject) {
    throw new Error("Table object pool is empty");
  }
  const table = parseDictByName(pool, tableObject, "table object");
  return {
    crRowsRef: resolveRef(requireEntry(table, "crRows"), "crRows"),
    crColumnsRef: resolveRef(requireEntry(table, "crColumns"), "crColumns"),
    cellColumnsRef: resolveRef(requireEntry(table, "cellColumns"), "cellColumns"),
  };
}

// --- resolving rows/columns/cells ------------------------------------------

export function resolveTable(doc: TableDocument): ResolvedTable {
  const rowSet = parseOrderedSet(doc, doc.crRowsRef);
  const columnSet = parseOrderedSet(doc, doc.crColumnsRef);
  const rowPositions = computePositions(doc, rowSet);
  const columnPositions = computePositions(doc, columnSet);

  const rows = rowSet.arrayUuidIndexes.map((uuidIndex) => identityOf(doc, uuidIndex));
  const columns = columnSet.arrayUuidIndexes.map((uuidIndex) => identityOf(doc, uuidIndex));

  const cells = new Map<string, TableCell>();
  for (const { a: columnRef, b: rowMapRef } of parseRefPairList(doc, doc.cellColumnsRef, "cellColumns")) {
    const columnPosition = columnPositions.get(uuidIndexOfRef(doc, resolveRef(columnRef, "cellColumns entry column ref")));
    if (columnPosition === undefined) {
      throw new Error("Table column reference does not resolve to a known column position");
    }
    for (const { a: rowRef, b: cellTextRef } of parseRefPairList(
      doc,
      resolveRef(rowMapRef, "cellColumns entry row-map ref"),
      "column row-map",
    )) {
      const rowPosition = rowPositions.get(uuidIndexOfRef(doc, resolveRef(rowRef, "row-map entry row ref")));
      if (rowPosition === undefined) {
        throw new Error("Table row reference does not resolve to a known row position");
      }
      const textRef = resolveRef(cellTextRef, "row-map entry cell-text ref");
      cells.set(cellKey(rowPosition, columnPosition), { textRef, text: resolveCellText(doc, textRef) });
    }
  }

  return { rows, columns, cells };
}

/** Finds a row/column's identity object by UUID-table index. Every entry in
 * an `OrderedSet.array` is guaranteed to resolve (that's how
 * `computePositions`/`uuidIndexOfRef` establish the position map in the
 * first place), so this re-scans the pool once per row/column - fine at
 * table sizes this project has ever seen. Exported for `tableEdit.ts`: real
 * captures occasionally have more than one identity object sharing the same
 * UUID-table index (apparently residue from Apple's own concurrent-edit
 * history - see the file header); this always returns the *first* match,
 * but every caller here and in `tableEdit.ts` treats row/column identity by
 * UUID-table index throughout, never by raw pool ref, so which specific
 * duplicate this resolves to never matters. */
export function identityOf(pool: TablePool, uuidIndex: number): TableRowColumn {
  const uuidIndexKeyIndex = pool.keyNames.indexOf("UUIDIndex");
  for (let ref = 0; ref < pool.objects.length; ref += 1) {
    const entry = pool.objects[ref];
    if (!entry?.customMap || entry.customMap.mapEntry.length !== 1) {
      continue;
    }
    const [mapEntry] = entry.customMap.mapEntry;
    if (
      mapEntry &&
      mapEntry.key === uuidIndexKeyIndex &&
      mapEntry.value &&
      isFieldSet(mapEntry.value, UNSIGNED_INTEGER_VALUE_FIELD) &&
      Number(mapEntry.value.unsignedIntegerValue) === uuidIndex
    ) {
      return { identityRef: ref, uuidIndex };
    }
  }
  throw new Error(`Table array entry's UUID-table index ${uuidIndex} has no matching identity object in the pool`);
}

/**
 * `crTableColumnDirection`'s value is a reference into a confusing extra
 * indirection layer we haven't fully mapped (its ref doesn't point straight
 * at the enum dict - see dev notes, cross-check entry). `AppleNotesEmbeddedTable.rb`
 * sidesteps this entirely by scanning the whole pool for the one dict object
 * whose single entry's key-table index equals `crTableColumnDirection`'s own
 * index + 1 (a quirk the reference implementation's own comment calls out as
 * unexplained), which is what this does too - ported rather than re-derived,
 * since only left-to-right tables have been captured and verified so far.
 * Column order/`OrderedSet` resolution above is direction-agnostic (it just
 * reflects `crColumns`' list order), so a right-to-left table would render
 * with reversed columns if we didn't refuse it here.
 */
function assertLeftToRight(pool: TablePool): void {
  const directionKeyIndex = pool.keyNames.indexOf("crTableColumnDirection") + 1;
  const directionKeyName = pool.keyNames[directionKeyIndex];
  if (directionKeyName === undefined) {
    throw new Error("Table's key-name table is missing the column-direction marker's key");
  }

  for (const object of pool.objects) {
    let dict: Map<string, ObjectID>;
    try {
      dict = parseDictByName(pool, object, "direction candidate");
    } catch {
      continue;
    }
    if (dict.size !== 1) {
      continue;
    }
    const value = dict.get(directionKeyName);
    if (!value || !isFieldSet(value, STRING_VALUE_FIELD)) {
      continue;
    }
    const direction = value.stringValue;
    if (direction !== LEFT_TO_RIGHT_DIRECTION) {
      throw new Error(`Table has unsupported column direction "${direction}" - refusing to guess at column order`);
    }
    return;
  }
  // No direction marker found at all: every capture so far has one, so
  // treat its absence as "we don't understand this table" rather than
  // silently assuming left-to-right.
  throw new Error("Table is missing its column-direction marker");
}

/** Resolves a `customMap` object (field 13) into its key-name -> ObjectID
 * pairs. Exported for `tableEdit.ts`: rebuilding pool[0] from scratch needs
 * to read its current `identity`/`crTableColumnDirection` entries first. */
export function parseDictByName(pool: TablePool, entry: MergeableDataObjectEntry, label: string): Map<string, ObjectID> {
  const customMap = entry.customMap;
  if (!customMap) {
    throw new Error(`Expected ${label} to be a dict (field 13)`);
  }
  const result = new Map<string, ObjectID>();
  for (const pair of customMap.mapEntry) {
    const keyName = pool.keyNames[pair.key];
    if (keyName !== undefined && pair.value) {
      result.set(keyName, pair.value);
    }
  }
  return result;
}

export function requireEntry(dict: Map<string, ObjectID>, key: string): ObjectID {
  const value = dict.get(key);
  if (!value) {
    throw new Error(`Table object is missing expected key "${key}"`);
  }
  return value;
}

/** Resolves an `ObjectID` known to be a pool reference (`objectIndex`). */
export function resolveRef(objectId: ObjectID, label: string): number {
  if (!isFieldSet(objectId, OBJECT_INDEX_FIELD)) {
    throw new Error(`Expected ${label} to be a pool reference`);
  }
  return objectId.objectIndex;
}

/** Resolves an `ObjectID` known to be an inline number (`unsignedIntegerValue`). */
function resolveNumber(objectId: ObjectID, label: string): number {
  if (!isFieldSet(objectId, UNSIGNED_INTEGER_VALUE_FIELD)) {
    throw new Error(`Expected ${label} to be an inline number`);
  }
  return Number(objectId.unsignedIntegerValue);
}

/** A row/column identity object: a one-entry dict, key `UUIDIndex`. Exported
 * for `tableEdit.ts`. */
export function uuidIndexOfRef(pool: TablePool, poolRef: number): number {
  const entry = pool.objects[poolRef];
  if (!entry) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const dict = parseDictByName(pool, entry, `pool[${poolRef}] identity object`);
  return resolveNumber(requireEntry(dict, "UUIDIndex"), `pool[${poolRef}] UUIDIndex`);
}

function findUuidTableIndex(pool: TablePool, uuidBytes: Uint8Array): number {
  const index = pool.uuidTable.findIndex((candidate) => bytesEqual(candidate, uuidBytes));
  if (index === -1) {
    throw new Error("Table array entry's UUID was not found in the document UUID table");
  }
  return index;
}

// --- OrderedSet (crRows / crColumns) ------------------------------------

export interface ParsedOrderedSet {
  /** Document-UUID-table indexes, in true visual order. */
  arrayUuidIndexes: number[];
  /** Stale-identity redirects: value's position should mirror key's. */
  contents: Array<{ keyRef: number; valueRef: number }>;
}

export function parseOrderedSet(pool: TablePool, poolRef: number): ParsedOrderedSet {
  const entry = pool.objects[poolRef];
  if (!entry) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const orderedSet: OrderedSetMessage | undefined = entry.orderedSet;
  if (!orderedSet) {
    throw new Error(`Expected pool[${poolRef}] to be an OrderedSet (field 16)`);
  }
  const ordering = orderedSet.ordering;
  if (!ordering) {
    throw new Error("OrderedSet is missing its ordering field");
  }
  const array = ordering.array;
  if (!array) {
    throw new Error("OrderedSet ordering is missing its array field");
  }

  const arrayUuidIndexes = array.attachment.map((attachment) => findUuidTableIndex(pool, attachment.uuid));

  const contents: ParsedOrderedSet["contents"] = [];
  if (ordering.contents) {
    for (const pair of ordering.contents.element) {
      if (!pair.key || !pair.value) {
        throw new Error("OrderedSet contents pair is missing its key or value");
      }
      contents.push({
        keyRef: resolveRef(pair.key, "contents key"),
        valueRef: resolveRef(pair.value, "contents value"),
      });
    }
  }

  return { arrayUuidIndexes, contents };
}

export function computePositions(pool: TablePool, orderedSet: ParsedOrderedSet): Map<number, number> {
  const positions = new Map<number, number>();
  orderedSet.arrayUuidIndexes.forEach((uuidIndex, position) => positions.set(uuidIndex, position));
  for (const { keyRef, valueRef } of orderedSet.contents) {
    const position = positions.get(uuidIndexOfRef(pool, keyRef));
    if (position !== undefined) {
      positions.set(uuidIndexOfRef(pool, valueRef), position);
    }
  }
  return positions;
}

// --- cellColumns / row-map / cell text ----------------------------------

/** `cellColumns` and each column's row-map share the same `dictionary`
 * (field 6), repeated `DictionaryElement {key: ref, value: ref}` shape. */
export function parseRefPairList(pool: TablePool, poolRef: number, label: string): Array<{ a: ObjectID; b: ObjectID }> {
  const entry = pool.objects[poolRef];
  if (!entry) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const dictionary = entry.dictionary;
  if (!dictionary) {
    throw new Error(`Expected ${label} (pool[${poolRef}]) to be a dictionary (field 6)`);
  }

  return dictionary.element.map((element) => {
    if (!element.key || !element.value) {
      throw new Error(`${label} entry is missing one of its two references`);
    }
    return { a: element.key, b: element.value };
  });
}

export function resolveCellText(pool: TablePool, poolRef: number): string {
  const entry = pool.objects[poolRef];
  if (!entry) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const note = entry.note;
  if (!note) {
    throw new Error(`Expected pool[${poolRef}] to be a cell-text object (field 10)`);
  }
  return note.noteText;
}

// --- small shared helpers -------------------------------------------------

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, i) => byte === b[i]);
}
