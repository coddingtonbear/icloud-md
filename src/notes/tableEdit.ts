/**
 * Builds a table's CRDT object pool entirely from scratch, rather than
 * patching the existing one in place - see the project's Obsidian dev log,
 * "Table write engine rewrite: wholesale rebuild instead of
 * minimal-diff/patch" and "...found an undocumented generation-stamp
 * mechanism" (2026-07-15), for the full design rationale and byte-level
 * evidence this is built on.
 *
 * The prior incremental-patch design (diff the desired grid against the
 * current one, match row/column identities across the edit, splice/append/
 * compact only the changed slice of the pool) is what let a real bug
 * through the night it shipped: `insertColumnAt` grew the visible column
 * list but never updated `OrderedSetOrderingArray.contents` (a hidden
 * per-character CRDT mirror elsewhere in the same document), corrupting a
 * live table. The fix is structural, not a patch to the patcher: on any
 * write, throw away the existing pool and build a complete fresh one
 * representing only the desired end state. There's no "existing structure
 * to correctly patch" once nothing is preserved, so there's no hidden field
 * left to forget - the same discipline that must be followed here is simply
 * "populate everything a fresh table needs," not "remember to update
 * everything an edit might touch."
 *
 * Accepted trade-off (agreed with the project owner): concurrent edits to
 * the same note from another device/person are not merged - the more
 * recent write wins, silently discarding whatever it didn't know about.
 * Every row/column/cell gets a fresh UUID on every rebuild, even for
 * content that didn't change.
 *
 * The generic pool-building primitives this relies on (`mergeableDataPool.ts`)
 * are deliberately not table-specific, since future data types will need
 * their own from-scratch write paths too.
 */

import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  parseDictByName,
  requireEntry,
  resolveRef,
  IDENTITY_OBJECT_TYPE,
  type TableDocument,
} from "./decodeTableRecord.js";
import { encodeCellDocument, newCellDocument } from "./tableCellEdit.js";
import {
  nextGenerationStamp,
  pushObject,
  pushUuid,
  refTo,
  requireKeyIndex,
  resetGenerationRegistry,
  stampedDictionaryElement,
  buildFreshOrderedSet,
} from "./mergeableDataPool.js";
import {
  DictionarySchema,
  Document_CustomObjectSchema,
  Document_CustomObject_MapEntrySchema,
  Document_DocObjectSchema,
  ObjectIDSchema,
  RegisterLatestSchema,
} from "./gen/crdt_pb.js";

const TABLE_OBJECT_INDEX = 0;
/** `pool[0]`'s own `custom.type` (confirmed via real captures). */
const TABLE_OBJECT_TYPE = 4;
/** The direction marker's own `customMap.type` (confirmed via real
 * captures) - distinct from `IDENTITY_OBJECT_TYPE`. */
const DIRECTION_MARKER_TYPE = 1;
const LEFT_TO_RIGHT_DIRECTION = "CRTableColumnDirectionLeftToRight";

/**
 * Replaces `doc`'s entire object pool with a fresh one representing
 * `desiredGrid`, mutating `doc` in place. `doc.keyNames`/`doc.uuidTable` are
 * read from and appended to, never cleared - every key name a rebuild needs
 * is already guaranteed present in any real fetched document (see
 * `requireKeyIndex`), and leaving old UUID-table entries in place when
 * their owning identity is discarded is harmless residue, the same way
 * orphaned identity objects already are in real captures - reusing them
 * would reintroduce exactly the remapping risk this rewrite exists to
 * eliminate.
 */
export function buildFreshTableDocument(doc: TableDocument, desiredGrid: readonly string[][]): void {
  const numRows = desiredGrid.length;
  const numColumns = desiredGrid[0]?.length ?? 0;
  if (numColumns === 0) {
    throw new Error("Cannot build a table with no columns - refusing to guess at its structure");
  }
  for (const row of desiredGrid) {
    if (row.length !== numColumns) {
      throw new Error("Every row of a rebuilt table must have the same number of columns");
    }
  }

  // Capture everything needed from the current pool before clearing it.
  const identityKey = requireKeyIndex(doc, "identity");
  const directionKey = requireKeyIndex(doc, "crTableColumnDirection");
  const selfKey = requireKeyIndex(doc, "self");
  const crRowsKey = requireKeyIndex(doc, "crRows");
  const uuidIndexKey = requireKeyIndex(doc, "UUIDIndex");
  const crColumnsKey = requireKeyIndex(doc, "crColumns");
  const cellColumnsKey = requireKeyIndex(doc, "cellColumns");

  const tableObject = doc.objects[TABLE_OBJECT_INDEX];
  if (!tableObject) {
    throw new Error("Table object pool is empty");
  }
  const tableDict = parseDictByName(doc, tableObject, "table object");
  const identityValue = requireEntry(tableDict, "identity");
  const directionRef = resolveRef(requireEntry(tableDict, "crTableColumnDirection"), "crTableColumnDirection");
  const directionRegisterLatest = doc.objects[directionRef]?.registerLatest;
  if (!directionRegisterLatest) {
    throw new Error("Table's column-direction marker isn't the expected RegisterLatest shape - refusing to guess");
  }
  const directionMarkerTimestamp = directionRegisterLatest.timestamp;

  const stamp = nextGenerationStamp(doc);
  let dictionaryElementCount = 0;

  doc.objects.length = 0;
  pushObject(doc, create(Document_DocObjectSchema, {})); // reserve pool[0] for the table object, filled in last

  const directionMarkerRef = pushObject(
    doc,
    create(Document_DocObjectSchema, {
      custom: create(Document_CustomObjectSchema, {
        type: DIRECTION_MARKER_TYPE,
        mapEntry: [
          create(Document_CustomObject_MapEntrySchema, {
            key: selfKey,
            value: create(ObjectIDSchema, { stringValue: LEFT_TO_RIGHT_DIRECTION }),
          }),
        ],
      }),
    }),
  );
  const directionRegisterRef = pushObject(
    doc,
    create(Document_DocObjectSchema, {
      registerLatest: create(RegisterLatestSchema, {
        timestamp: directionMarkerTimestamp,
        contents: refTo(directionMarkerRef),
      }),
    }),
  );

  const rowIdentities = buildFreshIdentities(doc, numRows, uuidIndexKey);
  const columnIdentities = buildFreshIdentities(doc, numColumns, uuidIndexKey);

  const rowMapRefs = columnIdentities.map((_column, colIndex) => {
    const rowMapElements = rowIdentities.map((row, rowIndex) => {
      const cellRef = pushObject(
        doc,
        create(Document_DocObjectSchema, { string: encodeCellDocument(newCellDocument(desiredGrid[rowIndex]?.[colIndex] ?? "")) }),
      );
      dictionaryElementCount += 1;
      return stampedDictionaryElement(row.ref, cellRef, stamp);
    });
    return pushObject(doc, create(Document_DocObjectSchema, { dictionary: create(DictionarySchema, { element: rowMapElements }) }));
  });

  const cellColumnsElements = columnIdentities.map((column, colIndex) => {
    dictionaryElementCount += 1;
    return stampedDictionaryElement(column.ref, rowMapRefs[colIndex]!, stamp);
  });
  const cellColumnsRef = pushObject(
    doc,
    create(Document_DocObjectSchema, { dictionary: create(DictionarySchema, { element: cellColumnsElements }) }),
  );

  const crRowsRef = pushObject(doc, create(Document_DocObjectSchema, { tsOrderedSet: buildFreshOrderedSet(rowIdentities, stamp) }));
  dictionaryElementCount += rowIdentities.length;
  const crColumnsRef = pushObject(
    doc,
    create(Document_DocObjectSchema, { tsOrderedSet: buildFreshOrderedSet(columnIdentities, stamp) }),
  );
  dictionaryElementCount += columnIdentities.length;

  doc.objects[TABLE_OBJECT_INDEX] = create(Document_DocObjectSchema, {
    custom: create(Document_CustomObjectSchema, {
      type: TABLE_OBJECT_TYPE,
      mapEntry: [
        create(Document_CustomObject_MapEntrySchema, { key: identityKey, value: identityValue }),
        create(Document_CustomObject_MapEntrySchema, { key: directionKey, value: refTo(directionRegisterRef) }),
        create(Document_CustomObject_MapEntrySchema, { key: crRowsKey, value: refTo(crRowsRef) }),
        create(Document_CustomObject_MapEntrySchema, { key: crColumnsKey, value: refTo(crColumnsRef) }),
        create(Document_CustomObject_MapEntrySchema, { key: cellColumnsKey, value: refTo(cellColumnsRef) }),
      ],
    }),
  });

  doc.crRowsRef = crRowsRef;
  doc.crColumnsRef = crColumnsRef;
  doc.cellColumnsRef = cellColumnsRef;

  resetGenerationRegistry(doc, stamp, dictionaryElementCount);
}

function buildFreshIdentities(doc: TableDocument, count: number, uuidIndexKey: number): { ref: number; uuid: Uint8Array }[] {
  return Array.from({ length: count }, () => {
    const uuid = new Uint8Array(randomBytes(16));
    const uuidIndex = pushUuid(doc, uuid);
    const ref = pushObject(
      doc,
      create(Document_DocObjectSchema, {
        custom: create(Document_CustomObjectSchema, {
          type: IDENTITY_OBJECT_TYPE,
          mapEntry: [
            create(Document_CustomObject_MapEntrySchema, {
              key: uuidIndexKey,
              value: create(ObjectIDSchema, { unsignedIntegerValue: BigInt(uuidIndex) }),
            }),
          ],
        }),
      }),
    );
    return { ref, uuid };
  });
}
