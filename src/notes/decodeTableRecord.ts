/**
 * Decodes a table's `MergeableDataEncrypted` payload (an `Attachment` record
 * whose `UTI` is `com.apple.notes.table`) into a GitHub-flavored-Markdown
 * pipe table, for the read path only (`clone`/`pull`).
 *
 * The structure was reverse-engineered from real captures and cross-checked
 * against threeplanetssoftware/apple_cloud_notes_parser's
 * `AppleNotesEmbeddedTable.rb` (MIT licensed) - see the project dev notes,
 * "Consolidated reference: the complete `com.apple.notes.table`
 * MergeableData structure" (2026-07-14T14:46), which this is a direct port
 * of. Field paths below use this project's own field-number convention.
 *
 * Shape, once decompressed the same way `decompressNoteDocument` does:
 *
 *   root.2                 the real document (Document wrapper)
 *     .3                     "body"
 *       .3[]                   object pool, addressed by index everywhere
 *                               else via a `{6: N}` value ("ref N" below)
 *       .4[]                   key-name table (strings)
 *       .6[]                   UUID table (16-byte UUIDs, plain-index addressed)
 *
 * `pool[0]` is the table object: a dict (field-13 wrapper, repeated
 * `{1: key-table-index, 2: value}` pairs under `.13.3`) with keys `crRows`,
 * `crColumns`, `cellColumns` (each a ref) resolved via the key-name table.
 *
 * `crRows`/`crColumns` are `OrderedSet` objects (field-16 wrapper):
 * `.16.1.1` is the true visual-order list - `.1` is CRDT run-tracking
 * metadata for the list's own edit history (not needed for a read-only
 * decode) and `.2[]` is the ordered `{1: index (redundant, ignored), 2:
 * 16-byte UUID}` entries, list position = visual position. `.16.1.2` is a
 * translation/redirect dictionary (`.1[]` repeated `{1: key ref, 2: value
 * ref, 3: ignored}`) resolving stale/duplicate identities from concurrent
 * edits onto their canonical counterpart - not an order signal itself.
 *
 * A row/column identity object is a dict with exactly one entry, key
 * `UUIDIndex`, value a plain inline number - the index into the
 * document-level UUID table. This value, not the object's own pool
 * position, is the join key used everywhere below.
 *
 * `cellColumns` is a field-6 wrapper, repeated `{1: ref to a column
 * identity object, 2: ref to that column's row-map object, 3: ignored}`.
 * A row-map object has the identical shape: `{1: ref to a row identity
 * object, 2: ref to a cell-text object, 3: ignored}`. A cell-text object is
 * a field-10 wrapper whose `.2` is the literal UTF-8 cell text.
 *
 * Deliberately not covered here (open questions, see dev notes): the
 * tombstone/deletion marker, and whether a header row is structurally
 * distinguished from a data row or purely conventional - the first row is
 * rendered as a GFM header row purely because GFM pipe tables require one
 * syntactically, not because Apple's format marks it as such.
 */

import { decompressNoteDocument } from "./noteText.js";
import { getLastBytesField, getLastVarintField, readProtoFields, type ProtoValue } from "./protobuf.js";

interface TablePool {
  /** Pool objects, addressed by index ("ref N" throughout). */
  objects: Uint8Array[];
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

  for (const { aRef: columnRef, bRef: rowMapRef } of parseRefPairList(pool, cellColumnsRef, "cellColumns")) {
    const col = columnPositions.get(uuidIndexOfRef(pool, columnRef));
    if (col === undefined) {
      throw new Error("Table column reference does not resolve to a known column position");
    }
    for (const { aRef: rowRef, bRef: cellTextRef } of parseRefPairList(pool, rowMapRef, "column row-map")) {
      const row = rowPositions.get(uuidIndexOfRef(pool, rowRef));
      if (row === undefined) {
        throw new Error("Table row reference does not resolve to a known row position");
      }
      const rowCells = grid[row];
      if (!rowCells) {
        throw new Error("Table row position is out of range");
      }
      rowCells[col] = resolveCellText(pool, cellTextRef);
    }
  }

  return renderMarkdownTable(grid);
}

// --- object pool -------------------------------------------------------

function loadPool(compressedMergeableData: Buffer): TablePool {
  const raw = decompressNoteDocument(compressedMergeableData);
  const root = readProtoFields(raw);

  const documentBytes = getLastBytesField(root, 2);
  if (!documentBytes) {
    throw new Error("Table MergeableData missing the document field (root field 2)");
  }
  const document = readProtoFields(documentBytes);

  const bodyBytes = getLastBytesField(document, 3);
  if (!bodyBytes) {
    throw new Error("Table MergeableData missing the body field (document field 3)");
  }
  const body = readProtoFields(bodyBytes);

  const objects = (body.get(3) ?? []).map((value) => expectBytesValue(value, "object pool entry"));
  const keyNames = (body.get(4) ?? []).map((value) => decodeUtf8(expectBytesValue(value, "key-name table entry")));
  const uuidTable = (body.get(6) ?? []).map((value) => expectBytesValue(value, "UUID table entry"));

  return { objects, keyNames, uuidTable };
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
    let dict: Map<string, Uint8Array>;
    try {
      dict = parseDictByName(pool, object, "direction candidate");
    } catch {
      continue;
    }
    if (dict.size !== 1) {
      continue;
    }
    const valueBytes = dict.get(directionKeyName);
    if (!valueBytes) {
      continue;
    }
    const stringBytes = getLastBytesField(readProtoFields(valueBytes), 4);
    if (!stringBytes) {
      continue;
    }
    const direction = decodeUtf8(stringBytes);
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

/** Resolves a dict object (field-13 wrapper) into its key-name -> raw value-bytes pairs. */
function parseDictByName(pool: TablePool, objectBytes: Uint8Array, label: string): Map<string, Uint8Array> {
  const wrapper = readProtoFields(objectBytes);
  const dictBytes = getLastBytesField(wrapper, 13);
  if (!dictBytes) {
    throw new Error(`Expected ${label} to be a dict (field 13)`);
  }
  const dict = readProtoFields(dictBytes);

  const result = new Map<string, Uint8Array>();
  for (const pair of dict.get(3) ?? []) {
    const pairFields = readProtoFields(expectBytesValue(pair, `${label} dict pair`));
    const keyIndex = getLastVarintField(pairFields, 1);
    const valueBytes = getLastBytesField(pairFields, 2);
    if (keyIndex === undefined || valueBytes === undefined) {
      continue;
    }
    const keyName = pool.keyNames[Number(keyIndex)];
    if (keyName !== undefined) {
      result.set(keyName, valueBytes);
    }
  }
  return result;
}

function requireEntry(dict: Map<string, Uint8Array>, key: string): Uint8Array {
  const value = dict.get(key);
  if (!value) {
    throw new Error(`Table object is missing expected key "${key}"`);
  }
  return value;
}

/** Resolves a dict-pair value known to be a pool reference (`{6: N}`). */
function resolveRef(valueBytes: Uint8Array, label: string): number {
  const fields = readProtoFields(valueBytes);
  const ref = getLastVarintField(fields, 6);
  if (ref === undefined) {
    throw new Error(`Expected ${label} to be a pool reference`);
  }
  return Number(ref);
}

/** Resolves a dict-pair value known to be an inline number (`{2: N}`). */
function resolveNumber(valueBytes: Uint8Array, label: string): number {
  const fields = readProtoFields(valueBytes);
  const num = getLastVarintField(fields, 2);
  if (num === undefined) {
    throw new Error(`Expected ${label} to be an inline number`);
  }
  return Number(num);
}

/** A row/column identity object: a one-entry dict, key `UUIDIndex`. */
function uuidIndexOfRef(pool: TablePool, poolRef: number): number {
  const object = pool.objects[poolRef];
  if (!object) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const dict = parseDictByName(pool, object, `pool[${poolRef}] identity object`);
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
  const object = pool.objects[poolRef];
  if (!object) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const objectFields = readProtoFields(object);
  const orderingWrapperBytes = getLastBytesField(objectFields, 16);
  if (!orderingWrapperBytes) {
    throw new Error(`Expected pool[${poolRef}] to be an OrderedSet (field 16)`);
  }
  const orderingWrapper = readProtoFields(orderingWrapperBytes);
  const orderingBytes = getLastBytesField(orderingWrapper, 1);
  if (!orderingBytes) {
    throw new Error("OrderedSet is missing its ordering field");
  }
  const ordering = readProtoFields(orderingBytes);

  const arrayBytes = getLastBytesField(ordering, 1);
  if (!arrayBytes) {
    throw new Error("OrderedSet ordering is missing its array field");
  }
  const arrayFields = readProtoFields(arrayBytes);
  const arrayUuidIndexes = (arrayFields.get(2) ?? []).map((entryValue) => {
    const entry = readProtoFields(expectBytesValue(entryValue, "OrderedSet array entry"));
    const uuidBytes = getLastBytesField(entry, 2);
    if (!uuidBytes) {
      throw new Error("OrderedSet array entry is missing its UUID");
    }
    return findUuidTableIndex(pool, uuidBytes);
  });

  const contents: OrderedSet["contents"] = [];
  const contentsBytes = getLastBytesField(ordering, 2);
  if (contentsBytes) {
    const contentsFields = readProtoFields(contentsBytes);
    for (const pairValue of contentsFields.get(1) ?? []) {
      const pairFields = readProtoFields(expectBytesValue(pairValue, "OrderedSet contents pair"));
      const keyBytes = getLastBytesField(pairFields, 1);
      const valueBytes = getLastBytesField(pairFields, 2);
      if (!keyBytes || !valueBytes) {
        throw new Error("OrderedSet contents pair is missing its key or value");
      }
      contents.push({ keyRef: resolveRef(keyBytes, "contents key"), valueRef: resolveRef(valueBytes, "contents value") });
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

/** `cellColumns` and each column's row-map share the same field-6 wrapper,
 * repeated `{1: ref, 2: ref, 3: ignored}` shape. */
function parseRefPairList(pool: TablePool, poolRef: number, label: string): Array<{ aRef: number; bRef: number }> {
  const object = pool.objects[poolRef];
  if (!object) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const objectFields = readProtoFields(object);
  const innerBytes = getLastBytesField(objectFields, 6);
  if (!innerBytes) {
    throw new Error(`Expected ${label} (pool[${poolRef}]) to be a field-6 wrapper`);
  }
  const inner = readProtoFields(innerBytes);

  return (inner.get(1) ?? []).map((entryValue) => {
    const fields = readProtoFields(expectBytesValue(entryValue, `${label} entry`));
    const aBytes = getLastBytesField(fields, 1);
    const bBytes = getLastBytesField(fields, 2);
    if (!aBytes || !bBytes) {
      throw new Error(`${label} entry is missing one of its two references`);
    }
    return { aRef: resolveRef(aBytes, `${label} entry ref 1`), bRef: resolveRef(bBytes, `${label} entry ref 2`) };
  });
}

function resolveCellText(pool: TablePool, poolRef: number): string {
  const object = pool.objects[poolRef];
  if (!object) {
    throw new Error(`Table pool reference ${poolRef} is out of range`);
  }
  const objectFields = readProtoFields(object);
  const cellBytes = getLastBytesField(objectFields, 10);
  if (!cellBytes) {
    throw new Error(`Expected pool[${poolRef}] to be a cell-text object (field 10)`);
  }
  const cellFields = readProtoFields(cellBytes);
  const textBytes = getLastBytesField(cellFields, 2);
  return textBytes ? decodeUtf8(textBytes) : "";
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

function expectBytesValue(value: ProtoValue, label: string): Uint8Array {
  if (value.wireType !== 2) {
    throw new Error(`${label} is not a length-delimited field`);
  }
  return value.bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, i) => byte === b[i]);
}
