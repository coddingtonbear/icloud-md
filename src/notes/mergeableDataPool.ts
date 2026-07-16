/**
 * Generic primitives for building a `MergeableData` object pool from
 * scratch, rather than patching an existing one in place - the pattern
 * behind the table write engine rewrite (see the project's Obsidian dev
 * log, "Table write engine rewrite: wholesale rebuild instead of
 * minimal-diff/patch" and "...found an undocumented generation-stamp
 * mechanism", 2026-07-15), generalized so future data types needing their
 * own from-scratch write path don't have to re-derive it. Nothing here is
 * table-specific; `decodeTableRecord.ts`/`tableEdit.ts` are just this
 * module's first caller.
 *
 * A `MergeableDataPool` mirrors `MergeableDataObjectData`'s four parallel
 * arrays: the object pool itself (`objects`, addressed by index everywhere
 * else via an `ObjectID.objectIndex`), the key-name table (`keyNames`), the
 * UUID table (`uuidTable`), and the generation-stamp registry
 * (`generationStamps` - see below). Callers own clearing/rebuilding
 * `objects` from index 0 (a from-scratch rebuild's actual job); this module
 * only provides the primitives for appending to it correctly.
 */

import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { newCellDocument, encodeCellDocument } from "./tableCellEdit.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import {
  DictionaryElementSchema,
  DictionarySchema,
  ObjectIDSchema,
  OrderedSetSchema,
  OrderedSetOrderingSchema,
  OrderedSetOrderingArraySchema,
  OrderedSetOrderingArrayAttachmentSchema,
  type DictionaryElement,
  type MergeableDataObjectEntry,
  type ObjectID,
  type OrderedSet,
} from "./gen/notestore_pb.js";

export interface MergeableDataPool {
  /** Pool objects, addressed by index ("ref N" throughout this codebase). */
  objects: MergeableDataObjectEntry[];
  keyNames: string[];
  uuidTable: Uint8Array[];
  /**
   * `MergeableDataObjectData.unknown_field_1` - a flat, append-only,
   * per-document registry of the same `{0, N, 0}` stamps every
   * `DictionaryElement` carries (see `encodeGenerationStamp`'s docstring).
   * Slot 0 is always the single highest `N` anywhere in the document (a
   * running "current generation" counter); every other slot is one
   * historical stamp. Same array reference as the parsed message's own
   * field - mutate in place (never reassign), matching every other array
   * on this interface.
   */
  generationStamps: Uint8Array[];
}

// --- pool object / key-name / UUID helpers ---------------------------------

export function pushObject(pool: MergeableDataPool, entry: MergeableDataObjectEntry): number {
  pool.objects.push(entry);
  return pool.objects.length - 1;
}

/** Throws rather than interning a new key name: a from-scratch rebuild only
 * ever runs against a document just fetched and round-trip-verified, so
 * every key name it needs (`identity`, `crRows`, `UUIDIndex`, etc.) is
 * guaranteed already present - refusing on a miss is safer than silently
 * appending a key name whose position elsewhere in the document we can't
 * verify. */
export function requireKeyIndex(pool: MergeableDataPool, name: string): number {
  const index = pool.keyNames.indexOf(name);
  if (index === -1) {
    throw new Error(`Table's key-name table is missing "${name}" - refusing to guess its index`);
  }
  return index;
}

export function pushUuid(pool: MergeableDataPool, uuid: Uint8Array = new Uint8Array(randomBytes(16))): number {
  pool.uuidTable.push(uuid);
  return pool.uuidTable.length - 1;
}

export function refTo(poolIndex: number): ObjectID {
  return create(ObjectIDSchema, { objectIndex: poolIndex });
}

// --- generation stamps -------------------------------------------------

/**
 * The exact byte shape decoded from real captures while planning the table
 * write engine rewrite (Obsidian dev log, 2026-07-15T20:04, corrected after
 * an initial byte-counting error while implementing it - see the follow-up
 * note added to that entry): an 8-byte record, `0a 06 08 00 10 <stamp> 18
 * 00` - standard nested-protobuf framing, a length-delimited field 1 (tag
 * `0a`, length 6) wrapping a 3-field varint submessage `{0, stamp, 0}`, no
 * extra wrapper beyond that. The *identical* record shape is used in two
 * places: `DictionaryElement.generation_stamp` (one record per element) and
 * `MergeableDataObjectData.unknown_field_1` (real captures show this
 * `repeated bytes` field holding exactly one entry - a single blob of
 * these 8-byte records concatenated back to back, one per `DictionaryElement`
 * ever created in the document's history, with the *first* record holding
 * the running maximum). Every real capture has shown a single-byte varint
 * (`stamp < 128`) - encoding a larger value would be guessing at a shape no
 * evidence supports, so this refuses instead.
 */
const GENERATION_STAMP_RECORD_LENGTH = 8;

function encodeGenerationStampRecord(stamp: number): Uint8Array {
  if (!Number.isInteger(stamp) || stamp < 0 || stamp >= 128) {
    throw new Error(
      `Generation stamp ${stamp} is outside the single-byte varint range every real capture has shown - refusing to guess at a multi-byte encoding`,
    );
  }
  return new Uint8Array([0x0a, 0x06, 0x08, 0x00, 0x10, stamp, 0x18, 0x00]);
}

function decodeGenerationStampRecord(bytes: Uint8Array): number {
  if (
    bytes.length !== GENERATION_STAMP_RECORD_LENGTH ||
    bytes[0] !== 0x0a ||
    bytes[1] !== 0x06 ||
    bytes[2] !== 0x08 ||
    bytes[3] !== 0x00 ||
    bytes[4] !== 0x10 ||
    bytes[6] !== 0x18 ||
    bytes[7] !== 0x00
  ) {
    throw new Error("Generation-stamp record doesn't match the observed byte shape - refusing to guess at its meaning");
  }
  return bytes[5]!;
}

/** Reads the registry's running-maximum record (the first 8 bytes of its
 * single concatenated blob) and returns the next value to use for this
 * rebuild - matches the `+2` step size observed between real saves (a
 * column insertion bumped the registry's maximum from 62 to 78). Throws if
 * the registry is empty or too short to hold one record: a rebuild always
 * starts from a real fetched document, so that means something unexpected
 * about the document, not a case to paper over with a made-up starting
 * value. */
export function nextGenerationStamp(pool: MergeableDataPool): number {
  const blob = pool.generationStamps[0];
  if (!blob || blob.length < GENERATION_STAMP_RECORD_LENGTH) {
    throw new Error("Table's generation-stamp registry is empty - refusing to guess a starting value");
  }
  return decodeGenerationStampRecord(blob.subarray(0, GENERATION_STAMP_RECORD_LENGTH)) + 2;
}

/** Replaces the registry with a fresh one: a single blob whose first record
 * holds `stamp` itself (the new running maximum), followed by
 * `freshElementCount` more copies of the same record - matching both the
 * observed "single concatenated blob" shape and the observed pattern where
 * every object created in one save shares a single stamp. Mutates
 * `pool.generationStamps` in place (same array reference as the parsed
 * message's own field), never reassigns. */
export function resetGenerationRegistry(pool: MergeableDataPool, stamp: number, freshElementCount: number): void {
  const record = encodeGenerationStampRecord(stamp);
  const blob = new Uint8Array(GENERATION_STAMP_RECORD_LENGTH * (freshElementCount + 1));
  for (let i = 0; i <= freshElementCount; i += 1) {
    blob.set(record, i * GENERATION_STAMP_RECORD_LENGTH);
  }
  pool.generationStamps.length = 0;
  pool.generationStamps.push(blob);
}

/** Builds a `DictionaryElement` carrying the given generation stamp -
 * `cellColumns`, every row-map, and both `OrderedSet.elements` dicts are
 * built from these. Callers are responsible for counting how many they
 * create in one rebuild and passing that count to
 * `resetGenerationRegistry` once at the end. */
export function stampedDictionaryElement(keyRef: number, valueRef: number, stamp: number): DictionaryElement {
  return create(DictionaryElementSchema, {
    key: refTo(keyRef),
    value: refTo(valueRef),
    generationStamp: encodeGenerationStampRecord(stamp),
  });
}

// --- ordered collections -------------------------------------------------

/**
 * Builds a complete, fresh `OrderedSet` from a plain ordered list of
 * identities - generic over what those identities represent (table rows,
 * table columns, or any future ordered CRDT list): populates
 * `array.attachment` (the uuid list in order), `array.contents` (the
 * per-character U+FFFC mirror whose *absence* caused the live corruption
 * incident this rewrite exists to fix - built by reusing
 * `tableCellEdit.ts`'s `newCellDocument`/`encodeCellDocument`, since
 * `OrderedSetOrderingArray.contents` is declared as the same `Note` message
 * type table cells use; this is the only place outside `tableCellEdit.ts`
 * itself that reuses that "build a fresh CRDT-backed Note from a string"
 * mechanism, not because this concept is table-specific), `elements` (one
 * stamped self-pair per entry), and an empty `ordering.contents` (no
 * redirects - nothing built by this rewrite ever creates duplicate
 * identities).
 */
export function buildFreshOrderedSet(entries: readonly { ref: number; uuid: Uint8Array }[], stamp: number): OrderedSet {
  const attachment = entries.map((entry, index) => create(OrderedSetOrderingArrayAttachmentSchema, { index, uuid: entry.uuid }));
  const contents = encodeCellDocument(newCellDocument(OBJECT_REPLACEMENT_CHARACTER.repeat(entries.length)));
  const elements = entries.map((entry) => stampedDictionaryElement(entry.ref, entry.ref, stamp));

  return create(OrderedSetSchema, {
    ordering: create(OrderedSetOrderingSchema, {
      array: create(OrderedSetOrderingArraySchema, { contents, attachment }),
      contents: create(DictionarySchema, { element: [] }),
    }),
    elements: create(DictionarySchema, { element: elements }),
  });
}
