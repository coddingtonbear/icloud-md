/**
 * Decodes a table's `MergeableDataEncrypted` payload (an `Attachment` record
 * whose `UTI` is `com.apple.notes.table`) into a GitHub-flavored-Markdown
 * pipe table, for the read path only (`clone`/`pull`).
 *
 * The structure was reverse-engineered from real captures and cross-checked
 * against threeplanetssoftware/apple_cloud_notes_parser's
 * `AppleNotesEmbeddedTable.rb` (MIT licensed) - see the project dev notes,
 * "Consolidated reference: the complete `com.apple.notes.table`
 * MergeableData structure" (2026-07-14T14:46), and `proto/notestore.proto`
 * for the generated-schema field names used below.
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
 * is the true visual-order list - `.contents` (of `OrderedSetOrderingArray`)
 * is CRDT run-tracking metadata for the list's own edit history (not needed
 * for a read-only decode) and `.attachment[]` is the ordered `{index
 * (redundant, ignored), uuid}` entries, list position = visual position.
 * `.ordering.contents` (of `OrderedSetOrdering`) is a translation/redirect
 * `Dictionary` resolving stale/duplicate identities from concurrent edits
 * onto their canonical counterpart - not an order signal itself.
 *
 * A row/column identity object is a `customMap` with exactly one entry, key
 * `UUIDIndex`, value a plain inline number (`ObjectID.unsignedIntegerValue`)
 * - the index into the document-level UUID table. This value, not the
 * object's own pool position, is the join key used everywhere below.
 *
 * `cellColumns` is a `dictionary` (field 6), repeated `DictionaryElement
 * {key: ref to a column identity object, value: ref to that column's
 * row-map object}`. A row-map object has the identical shape: `{key: ref to
 * a row identity object, value: ref to a cell-text object}`. A cell-text
 * object is a `note` (field 10) whose `noteText` is the literal cell text.
 *
 * Deliberately not covered here (open questions, see dev notes): the
 * tombstone/deletion marker, and whether a header row is structurally
 * distinguished from a data row or purely conventional - the first row is
 * rendered as a GFM header row purely because GFM pipe tables require one
 * syntactically, not because Apple's format marks it as such.
 */

import { fromBinary, isFieldSet } from "@bufbuild/protobuf";
import { decompressNoteDocument } from "./noteText.js";
import {
  MergableDataProtoSchema,
  ObjectIDSchema,
  type MergeableDataObjectEntry,
  type ObjectID,
  type OrderedSet as OrderedSetMessage,
} from "./gen/notestore_pb.js";

const OBJECT_INDEX_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "objectIndex")!;
const UNSIGNED_INTEGER_VALUE_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "unsignedIntegerValue")!;
const STRING_VALUE_FIELD = ObjectIDSchema.fields.find((f) => f.localName === "stringValue")!;

interface TablePool {
  /** Pool objects, addressed by index ("ref N" throughout). */
  objects: MergeableDataObjectEntry[];
  keyNames: string[];
  uuidTable: Uint8Array[];
}

interface OrderedSet {
  /** Document-UUID-table indexes, in true visual order. */
  arrayUuidIndexes: number[];
  /** Stale-identity redirects: value's position should mirror key's. */
  contents: Array<{ keyRef: number; valueRef: number }>;
}

const TABLE_OBJECT_INDEX = 0;
const LEFT_TO_RIGHT_DIRECTION = "CRTableColumnDirectionLeftToRight";

export function decodeTableMarkdown(compressedMergeableData: Buffer): string {
  const pool = loadPool(compressedMergeableData);
  assertLeftToRight(pool);
  const tableObject = pool.objects[TABLE_OBJECT_INDEX];
  if (!tableObject) {
    throw new Error("Table object pool is empty");
  }
  const table = parseDictByName(pool, tableObject, "table object");

  const crRowsRef = resolveRef(requireEntry(table, "crRows"), "crRows");
  const crColumnsRef = resolveRef(requireEntry(table, "crColumns"), "crColumns");
  const cellColumnsRef = resolveRef(requireEntry(table, "cellColumns"), "cellColumns");

  const rows = parseOrderedSet(pool, crRowsRef);
  const columns = parseOrderedSet(pool, crColumnsRef);
  const rowPositions = computePositions(pool, rows);
  const columnPositions = computePositions(pool, columns);

  const numRows = rows.arrayUuidIndexes.length;
  const numCols = columns.arrayUuidIndexes.length;
  if (numCols === 0) {
    throw new Error("Table has no columns - refusing to guess at its structure");
  }
  const grid: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(""));

  for (const { a: columnRef, b: rowMapRef } of parseRefPairList(pool, cellColumnsRef, "cellColumns")) {
    const col = columnPositions.get(uuidIndexOfRef(pool, resolveRef(columnRef, "cellColumns entry column ref")));
    if (col === undefined) {
      throw new Error("Table column reference does not resolve to a known column position");
    }
    for (const { a: rowRef, b: cellTextRef } of parseRefPairList(
      pool,
      resolveRef(rowMapRef, "cellColumns entry row-map ref"),
      "column row-map",
    )) {
      const row = rowPositions.get(uuidIndexOfRef(pool, resolveRef(rowRef, "row-map entry row ref")));
      if (row === undefined) {
        throw new Error("Table row reference does not resolve to a known row position");
      }
      const rowCells = grid[row];
      if (!rowCells) {
        throw new Error("Table row position is out of range");
      }
      rowCells[col] = resolveCellText(pool, resolveRef(cellTextRef, "row-map entry cell-text ref"));
    }
  }

  return renderMarkdownTable(grid);
}

// --- object pool -------------------------------------------------------

function loadPool(compressedMergeableData: Buffer): TablePool {
  const raw = decompressNoteDocument(compressedMergeableData);
  const message = fromBinary(MergableDataProtoSchema, raw);

  const data = message.mergableDataObject?.mergeableDataObjectData;
  if (!data) {
    throw new Error("Table MergeableData missing the object data field");
  }

  return {
    objects: data.mergeableDataObjectEntry,
    keyNames: data.mergeableDataObjectKeyItem,
    uuidTable: data.mergeableDataObjectUuidItem,
  };
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

/** Resolves a `customMap` object (field 13) into its key-name -> ObjectID pairs. */
function parseDictByName(pool: TablePool, entry: MergeableDataObjectEntry, label: string): Map<string, ObjectID> {
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

function requireEntry(dict: Map<string, ObjectID>, key: string): ObjectID {
  const value = dict.get(key);
  if (!value) {
    throw new Error(`Table object is missing expected key "${key}"`);
  }
  return value;
}

/** Resolves an `ObjectID` known to be a pool reference (`objectIndex`). */
function resolveRef(objectId: ObjectID, label: string): number {
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

/** A row/column identity object: a one-entry dict, key `UUIDIndex`. */
function uuidIndexOfRef(pool: TablePool, poolRef: number): number {
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

function parseOrderedSet(pool: TablePool, poolRef: number): OrderedSet {
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

  const contents: OrderedSet["contents"] = [];
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

function computePositions(pool: TablePool, orderedSet: OrderedSet): Map<number, number> {
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
function parseRefPairList(pool: TablePool, poolRef: number, label: string): Array<{ a: ObjectID; b: ObjectID }> {
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

function resolveCellText(pool: TablePool, poolRef: number): string {
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

// --- markdown rendering --------------------------------------------------

function renderMarkdownTable(grid: readonly string[][]): string {
  const header = grid[0];
  if (!header) {
    throw new Error("Table has no rows - refusing to guess at its structure");
  }
  const lines = [formatRow(header), formatRow(header.map(() => "---"))];
  for (const row of grid.slice(1)) {
    lines.push(formatRow(row));
  }
  return lines.join("\n");
}

function formatRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// --- small shared helpers -------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, i) => byte === b[i]);
}
