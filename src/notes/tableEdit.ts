/**
 * Grid-level diffing and structural editing for a parsed `TableDocument`
 * (`decodeTableRecord.ts`): cell text edits, row/column insertion at any
 * position, and row/column deletion at any position - see the project dev
 * notes, "Table write path planned end-to-end" (2026-07-15T14:51), for the
 * real-capture evidence this is built on.
 *
 * `diffTableGrid` is deliberately narrower than a full two-dimensional LCS:
 * it only recognizes a single contiguous run of inserted or deleted
 * rows *or* columns (never both axes in the same edit), with every
 * surviving row/column outside that run required to match exactly - the
 * same single-splice model `noteDocument.ts`'s `computeSplice` already uses
 * for plain text, generalized to row/column granularity instead of
 * characters. Every real capture behind this plan was a single isolated
 * structural change, so this covers everything there's real evidence for;
 * anything messier (both axes changed at once, a structural change mixed
 * with unrelated cell edits elsewhere, or a pure reorder with nothing added
 * or removed) is classified `unsupported` rather than guessed at.
 *
 * Row/column insertion never mimics Apple's own "identity pair + orphaned
 * duplicate + redirect entry" residue (see `decodeTableRecord.ts`'s file
 * header) - a single fresh identity object is simpler and decodes
 * identically. Deletion *does* mirror Apple's confirmed behavior of leaving
 * the deleted row/column's identity object orphaned in the pool rather than
 * removing it (real captures always do this), physically removing only the
 * cell-text objects it owned (and, for a column, its row-map object too) -
 * which is what actually forces pool compaction, since a flat `repeated`
 * protobuf field can't have gaps.
 */

import { randomBytes } from "node:crypto";
import { create, isFieldSet } from "@bufbuild/protobuf";
import {
  cellKey,
  computePositions,
  parseOrderedSet,
  parseRefPairList,
  resolveRef,
  resolveTable,
  uuidIndexOfRef,
  IDENTITY_OBJECT_TYPE,
  OBJECT_INDEX_FIELD,
  bytesEqual,
  type TableDocument,
  type TableRowColumn,
} from "./decodeTableRecord.js";
import { applyCellTextEdit, encodeCellDocument, newCellDocument, parseCellDocument } from "./tableCellEdit.js";
import {
  DictionaryElementSchema,
  DictionarySchema,
  MapEntrySchema,
  MergeableDataObjectEntrySchema,
  MergeableDataObjectMapSchema,
  ObjectIDSchema,
  OrderedSetOrderingArrayAttachmentSchema,
  type MergeableDataObjectEntry,
  type ObjectID,
} from "./gen/notestore_pb.js";

// --- grid diffing ------------------------------------------------------

export interface CellEdit {
  row: number;
  column: number;
  text: string;
}

export type TableEditPlan =
  | { kind: "noop" }
  | { kind: "cellEdits"; edits: CellEdit[] }
  | { kind: "insertRows"; position: number; rows: string[][] }
  | { kind: "deleteRows"; position: number; count: number }
  /** Each entry is one new column's cell text, top-to-bottom over the
   * table's (unchanged) row order. */
  | { kind: "insertColumns"; position: number; columns: string[][] }
  | { kind: "deleteColumns"; position: number; count: number }
  | { kind: "unsupported"; reason: string };

export function diffTableGrid(current: readonly string[][], desired: readonly string[][]): TableEditPlan {
  if (gridsEqual(current, desired)) {
    return { kind: "noop" };
  }

  const currentCols = current[0]?.length ?? 0;
  const desiredCols = desired[0]?.length ?? 0;
  const rowCountChanged = current.length !== desired.length;
  const colCountChanged = currentCols !== desiredCols;

  if (rowCountChanged && colCountChanged) {
    return {
      kind: "unsupported",
      reason: "both row and column counts changed in the same edit - can't safely resolve this as one structural operation",
    };
  }

  if (!rowCountChanged && !colCountChanged) {
    if (isPureReorder(current, desired)) {
      return { kind: "unsupported", reason: "rows or columns were reordered without anything added or removed - not supported" };
    }
    const edits: CellEdit[] = [];
    current.forEach((row, r) => {
      row.forEach((cell, c) => {
        const desiredCell = desired[r]?.[c];
        if (desiredCell !== undefined && desiredCell !== cell) {
          edits.push({ row: r, column: c, text: desiredCell });
        }
      });
    });
    return edits.length === 0 ? { kind: "noop" } : { kind: "cellEdits", edits };
  }

  if (rowCountChanged) {
    const splice = computeAxisSplice(current, desired);
    if (!splice) {
      return { kind: "unsupported", reason: "row insertion/deletion couldn't be resolved to a single contiguous change" };
    }
    return splice.deleteCount > 0
      ? { kind: "deleteRows", position: splice.start, count: splice.deleteCount }
      : { kind: "insertRows", position: splice.start, rows: splice.inserted };
  }

  const splice = computeAxisSplice(transpose(current), transpose(desired));
  if (!splice) {
    return { kind: "unsupported", reason: "column insertion/deletion couldn't be resolved to a single contiguous change" };
  }
  return splice.deleteCount > 0
    ? { kind: "deleteColumns", position: splice.start, count: splice.deleteCount }
    : { kind: "insertColumns", position: splice.start, columns: splice.inserted };
}

interface AxisSplice {
  start: number;
  deleteCount: number;
  inserted: string[][];
}

/** `computeSplice` (`noteDocument.ts`), generalized from characters to
 * whole rows: the longest matching prefix + longest matching suffix, with
 * everything in between treated as one contiguous insert or delete. Returns
 * undefined if the prefix/suffix trim doesn't account for every row outside
 * the changed region - i.e. something beyond a single clean insert/delete
 * is going on, which `diffTableGrid` reports as `unsupported`. */
function computeAxisSplice(current: readonly (readonly string[])[], desired: readonly (readonly string[])[]): AxisSplice | undefined {
  const minLen = Math.min(current.length, desired.length);
  let prefix = 0;
  while (prefix < minLen && rowsEqual(current[prefix]!, desired[prefix]!)) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (suffix < maxSuffix && rowsEqual(current[current.length - 1 - suffix]!, desired[desired.length - 1 - suffix]!)) {
    suffix += 1;
  }

  if (prefix + suffix !== minLen) {
    return undefined;
  }

  const deleteCount = current.length - prefix - suffix;
  const insertCount = desired.length - prefix - suffix;
  const inserted = desired.slice(prefix, prefix + insertCount).map((row) => [...row]);
  return { start: prefix, deleteCount, inserted };
}

function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function gridsEqual(a: readonly string[][], b: readonly string[][]): boolean {
  return a.length === b.length && a.every((row, i) => rowsEqual(row, b[i] ?? []));
}

function transpose(grid: readonly string[][]): string[][] {
  const cols = grid[0]?.length ?? 0;
  return Array.from({ length: cols }, (_, c) => grid.map((row) => row[c] ?? ""));
}

/** A pure reorder: the same multiset of rows (or, transposed, columns), in
 * a different order, with nothing added or removed. Deliberately refused -
 * see file header. */
function isPureReorder(current: readonly string[][], desired: readonly string[][]): boolean {
  if (rowsMultisetEqual(current, desired)) {
    return true;
  }
  return rowsMultisetEqual(transpose(current), transpose(desired));
}

function rowsMultisetEqual(a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const row of b) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of a) {
    const key = JSON.stringify(row);
    const count = counts.get(key) ?? 0;
    if (count === 0) {
      return false;
    }
    counts.set(key, count - 1);
  }
  return true;
}

// --- applying a plan --------------------------------------------------

export function applyTableEdit(doc: TableDocument, plan: TableEditPlan): void {
  switch (plan.kind) {
    case "noop":
      return;
    case "unsupported":
      throw new Error(plan.reason);
    case "cellEdits":
      applyCellEdits(doc, plan.edits);
      return;
    case "insertRows":
      plan.rows.forEach((cellTexts, offset) => insertRowAt(doc, plan.position + offset, cellTexts));
      return;
    case "deleteRows":
      for (let i = 0; i < plan.count; i += 1) {
        deleteRowAt(doc, plan.position);
      }
      return;
    case "insertColumns":
      plan.columns.forEach((cellTexts, offset) => insertColumnAt(doc, plan.position + offset, cellTexts));
      return;
    case "deleteColumns":
      for (let i = 0; i < plan.count; i += 1) {
        deleteColumnAt(doc, plan.position);
      }
      return;
  }
}

function applyCellEdits(doc: TableDocument, edits: readonly CellEdit[]): void {
  const resolved = resolveTable(doc);
  for (const edit of edits) {
    if (!resolved.rows[edit.row] || !resolved.columns[edit.column]) {
      throw new Error(`Cell edit references row ${edit.row}/column ${edit.column} outside the table`);
    }
    const cell = resolved.cells.get(cellKey(edit.row, edit.column));
    if (!cell) {
      throw new Error(`No cell found at row ${edit.row}, column ${edit.column}`);
    }
    const entry = doc.objects[cell.textRef];
    if (!entry?.note) {
      throw new Error(`Table pool[${cell.textRef}] is not a cell-text object`);
    }
    const cellDoc = parseCellDocument(entry.note);
    applyCellTextEdit(cellDoc, edit.text);
    entry.note = encodeCellDocument(cellDoc);
  }
}

// --- row/column insertion -----------------------------------------------

export function insertRowAt(doc: TableDocument, position: number, cellTexts: readonly string[]): void {
  const resolved = resolveTable(doc);
  const identity = createIdentity(doc);
  insertIntoOrderedSet(doc, doc.crRowsRef, position, identity);
  resolved.columns.forEach((_column, colIndex) => {
    const cellPoolRef = pushCellNote(doc, cellTexts[colIndex] ?? "");
    const rowMapPoolRef = findRowMapRefForColumn(doc, colIndex);
    requireDictionary(doc, rowMapPoolRef, "column row-map").element.push(
      create(DictionaryElementSchema, { key: refTo(identity.identityRef), value: refTo(cellPoolRef) }),
    );
  });
}

export function insertColumnAt(doc: TableDocument, position: number, cellTexts: readonly string[]): void {
  const resolved = resolveTable(doc);
  const identity = createIdentity(doc);
  insertIntoOrderedSet(doc, doc.crColumnsRef, position, identity);
  const rowMapElements = resolved.rows.map((row, rowIndex) => {
    const cellPoolRef = pushCellNote(doc, cellTexts[rowIndex] ?? "");
    return create(DictionaryElementSchema, { key: refTo(row.identityRef), value: refTo(cellPoolRef) });
  });
  const rowMapPoolRef = pushPoolObject(
    doc,
    create(MergeableDataObjectEntrySchema, { dictionary: create(DictionarySchema, { element: rowMapElements }) }),
  );
  requireDictionary(doc, doc.cellColumnsRef, "cellColumns").element.push(
    create(DictionaryElementSchema, { key: refTo(identity.identityRef), value: refTo(rowMapPoolRef) }),
  );
}

// --- row/column deletion -------------------------------------------------

export function deleteRowAt(doc: TableDocument, position: number): void {
  const resolved = resolveTable(doc);
  const row = resolved.rows[position];
  if (!row) {
    throw new Error(`Row deletion position ${position} is out of bounds`);
  }
  // Captured before any mutation: a row-map's own entry for this row may
  // reference a *different* (but same-position) identity object than the
  // one `crRows`' own `OrderedSet.array` uses - see `decodeTableRecord.ts`'s
  // file header on identity-pair residue - so matching has to go through
  // the same redirect-aware position map `resolveTable` uses internally,
  // not a raw UUID-table-index comparison.
  const rowPositions = computePositions(doc, parseOrderedSet(doc, doc.crRowsRef));

  const freed: number[] = [];
  for (const { b: rowMapRef } of parseRefPairList(doc, doc.cellColumnsRef, "cellColumns")) {
    const rowMapPoolRef = resolveRef(rowMapRef, "cellColumns row-map ref");
    const dict = doc.objects[rowMapPoolRef]?.dictionary;
    if (!dict) {
      continue;
    }
    const index = dict.element.findIndex(
      (el) => el.key !== undefined && rowPositions.get(uuidIndexOfRef(doc, resolveRef(el.key, "row-map row ref"))) === position,
    );
    if (index !== -1) {
      const [removed] = dict.element.splice(index, 1);
      if (removed?.value) {
        freed.push(resolveRef(removed.value, "freed cell ref"));
      }
    }
  }
  removeFromOrderedSet(doc, doc.crRowsRef, row.uuidIndex);
  compactPool(doc, freed);
}

export function deleteColumnAt(doc: TableDocument, position: number): void {
  const resolved = resolveTable(doc);
  const column = resolved.columns[position];
  if (!column) {
    throw new Error(`Column deletion position ${position} is out of bounds`);
  }
  const columnPositions = computePositions(doc, parseOrderedSet(doc, doc.crColumnsRef));

  const cellColumnsDict = requireDictionary(doc, doc.cellColumnsRef, "cellColumns");
  const index = cellColumnsDict.element.findIndex(
    (el) =>
      el.key !== undefined && columnPositions.get(uuidIndexOfRef(doc, resolveRef(el.key, "cellColumns column ref"))) === position,
  );
  const freed: number[] = [];
  if (index !== -1) {
    const [removed] = cellColumnsDict.element.splice(index, 1);
    if (removed?.value) {
      const rowMapPoolRef = resolveRef(removed.value, "cellColumns row-map ref");
      for (const { b: cellRef } of parseRefPairList(doc, rowMapPoolRef, "column row-map")) {
        freed.push(resolveRef(cellRef, "freed cell ref"));
      }
      freed.push(rowMapPoolRef);
    }
  }
  removeFromOrderedSet(doc, doc.crColumnsRef, column.uuidIndex);
  compactPool(doc, freed);
}

// --- pool object builders ------------------------------------------------

interface NewIdentity extends TableRowColumn {
  uuid: Uint8Array;
}

function createIdentity(doc: TableDocument): NewIdentity {
  const uuid = new Uint8Array(randomBytes(16));
  doc.uuidTable.push(uuid);
  const uuidIndex = doc.uuidTable.length - 1;
  const uuidIndexKey = doc.keyNames.indexOf("UUIDIndex");
  if (uuidIndexKey === -1) {
    throw new Error('Table\'s key-name table is missing "UUIDIndex"');
  }
  const identityRef = pushPoolObject(
    doc,
    create(MergeableDataObjectEntrySchema, {
      customMap: create(MergeableDataObjectMapSchema, {
        type: IDENTITY_OBJECT_TYPE,
        mapEntry: [create(MapEntrySchema, { key: uuidIndexKey, value: create(ObjectIDSchema, { unsignedIntegerValue: BigInt(uuidIndex) }) })],
      }),
    }),
  );
  return { identityRef, uuidIndex, uuid };
}

function pushCellNote(doc: TableDocument, text: string): number {
  const note = encodeCellDocument(newCellDocument(text));
  return pushPoolObject(doc, create(MergeableDataObjectEntrySchema, { note }));
}

function pushPoolObject(doc: TableDocument, entry: MergeableDataObjectEntry): number {
  doc.objects.push(entry);
  return doc.objects.length - 1;
}

function refTo(poolIndex: number): ObjectID {
  return create(ObjectIDSchema, { objectIndex: poolIndex });
}

function requireDictionary(doc: TableDocument, poolRef: number, label: string) {
  const dictionary = doc.objects[poolRef]?.dictionary;
  if (!dictionary) {
    throw new Error(`Expected ${label} (pool[${poolRef}]) to be a dictionary`);
  }
  return dictionary;
}

/** Position-based, not raw-UUID-index-based - see `deleteRowAt`'s comment
 * on identity-pair residue for why. */
function findRowMapRefForColumn(doc: TableDocument, columnPosition: number): number {
  const columnPositions = computePositions(doc, parseOrderedSet(doc, doc.crColumnsRef));
  for (const { a: columnRef, b: rowMapRef } of parseRefPairList(doc, doc.cellColumnsRef, "cellColumns")) {
    if (columnPositions.get(uuidIndexOfRef(doc, resolveRef(columnRef, "cellColumns column ref"))) === columnPosition) {
      return resolveRef(rowMapRef, "cellColumns row-map ref");
    }
  }
  throw new Error(`No row-map found for column at position ${columnPosition}`);
}

function insertIntoOrderedSet(doc: TableDocument, orderedSetRef: number, position: number, identity: NewIdentity): void {
  const orderedSet = doc.objects[orderedSetRef]?.orderedSet;
  const array = orderedSet?.ordering?.array;
  const elements = orderedSet?.elements;
  if (!array || !elements) {
    throw new Error(`Table pool[${orderedSetRef}] is not a well-formed OrderedSet`);
  }
  array.attachment.splice(
    position,
    0,
    create(OrderedSetOrderingArrayAttachmentSchema, { index: position, uuid: identity.uuid }),
  );
  elements.element.push(create(DictionaryElementSchema, { key: refTo(identity.identityRef), value: refTo(identity.identityRef) }));
}

function removeFromOrderedSet(doc: TableDocument, orderedSetRef: number, uuidIndex: number): void {
  const orderedSet = doc.objects[orderedSetRef]?.orderedSet;
  const array = orderedSet?.ordering?.array;
  const elements = orderedSet?.elements;
  if (!array || !elements) {
    throw new Error(`Table pool[${orderedSetRef}] is not a well-formed OrderedSet`);
  }
  const uuid = doc.uuidTable[uuidIndex];
  if (!uuid) {
    throw new Error(`UUID-table index ${uuidIndex} is out of range`);
  }
  const attachIndex = array.attachment.findIndex((a) => bytesEqual(a.uuid, uuid));
  if (attachIndex === -1) {
    throw new Error(`No live row/column found for UUID-table index ${uuidIndex}`);
  }
  array.attachment.splice(attachIndex, 1);

  // Matched by UUID-table index, not a specific identity pool ref: real
  // captures confirm `elements` only ever carries one entry per *live* row/
  // column (see `decodeTableRecord.ts`'s file header), so this can't
  // over-match, and it's robust regardless of which specific identity
  // object (of possibly more than one sharing this UUID-table index) is
  // the "canonical" one `elements` happens to reference.
  elements.element = elements.element.filter(
    (el) => !(el.key !== undefined && uuidIndexOfRef(doc, resolveRef(el.key, "elements key")) === uuidIndex),
  );
}

// --- pool compaction -------------------------------------------------------

/**
 * Physically removes `removedRefs` from the pool and remaps every remaining
 * `ObjectID.objectIndex` reference in the document (including the three
 * refs cached on `doc` itself) to account for the shift - the mechanical
 * consequence of a flat, gapless `repeated` protobuf field, confirmed via a
 * real header-row deletion capture (dev notes, 2026-07-15T14:51): removing
 * pool entries shifts every reference past them down by however many were
 * removed. Deliberately generic over "what got removed" - `deleteRowAt`/
 * `deleteColumnAt` decide that; this only knows how to erase pool slots and
 * fix up every reference to what's left, which is why it's tested
 * independently with a synthetic pool (see `tableEdit.test.ts`).
 */
export function compactPool(doc: TableDocument, removedRefs: readonly number[]): void {
  if (removedRefs.length === 0) {
    return;
  }
  const removedSet = new Set(removedRefs);
  const remap = new Map<number, number>();
  let shift = 0;
  for (let oldIndex = 0; oldIndex < doc.objects.length; oldIndex += 1) {
    if (removedSet.has(oldIndex)) {
      shift += 1;
      continue;
    }
    remap.set(oldIndex, oldIndex - shift);
  }

  // Skip entries about to be physically removed: their own internal
  // references (e.g. a freed row-map's references to the cell objects it
  // owned, also being freed alongside it) point at other removed indices
  // that were deliberately left out of `remap` - nothing needs to remap
  // them since the whole entry is going away regardless.
  doc.objects.forEach((entry, index) => {
    if (!removedSet.has(index)) {
      remapEntry(entry, remap);
    }
  });
  doc.crRowsRef = remapRequired(doc.crRowsRef, remap);
  doc.crColumnsRef = remapRequired(doc.crColumnsRef, remap);
  doc.cellColumnsRef = remapRequired(doc.cellColumnsRef, remap);

  for (const ref of [...removedSet].sort((a, b) => b - a)) {
    doc.objects.splice(ref, 1);
  }
}

function remapRequired(ref: number, remap: ReadonlyMap<number, number>): number {
  const next = remap.get(ref);
  if (next === undefined) {
    throw new Error(`Pool compaction: reference to a removed pool index ${ref} - refusing to guess`);
  }
  return next;
}

function remapEntry(entry: MergeableDataObjectEntry, remap: ReadonlyMap<number, number>): void {
  if (entry.registerLatest?.contents) {
    remapObjectId(entry.registerLatest.contents, remap);
  }
  if (entry.list) {
    for (const listEntry of entry.list.listEntry) {
      if (listEntry.id) {
        remapObjectId(listEntry.id, remap);
      }
      if (listEntry.details?.id) {
        remapObjectId(listEntry.details.id, remap);
      }
      if (listEntry.additionalDetails?.id) {
        remapObjectId(listEntry.additionalDetails.id, remap);
      }
    }
  }
  if (entry.dictionary) {
    remapDictionary(entry.dictionary, remap);
  }
  if (entry.customMap) {
    for (const mapEntry of entry.customMap.mapEntry) {
      if (mapEntry.value) {
        remapObjectId(mapEntry.value, remap);
      }
    }
  }
  if (entry.orderedSet) {
    if (entry.orderedSet.ordering?.contents) {
      remapDictionary(entry.orderedSet.ordering.contents, remap);
    }
    if (entry.orderedSet.elements) {
      remapDictionary(entry.orderedSet.elements, remap);
    }
  }
}

function remapDictionary(dictionary: { element: { key?: ObjectID | undefined; value?: ObjectID | undefined }[] }, remap: ReadonlyMap<number, number>): void {
  for (const element of dictionary.element) {
    if (element.key) {
      remapObjectId(element.key, remap);
    }
    if (element.value) {
      remapObjectId(element.value, remap);
    }
  }
}

function remapObjectId(id: ObjectID, remap: ReadonlyMap<number, number>): void {
  if (!isFieldSet(id, OBJECT_INDEX_FIELD)) {
    return;
  }
  id.objectIndex = remapRequired(id.objectIndex, remap);
}
