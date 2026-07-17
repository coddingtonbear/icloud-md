/**
 * Generic primitives for building a `CRDT.Document` object pool from
 * scratch, rather than patching an existing one in place - the pattern
 * behind the table write engine rewrite (see the project's Obsidian dev
 * log, "Table write engine rewrite: wholesale rebuild instead of
 * minimal-diff/patch" and "...found an undocumented generation-stamp
 * mechanism", 2026-07-15), generalized so future data types needing their
 * own from-scratch write path don't have to re-derive it. Nothing here is
 * table-specific; `decodeTableRecord.ts`/`tableEdit.ts` are just this
 * module's first caller.
 *
 * A `MergeableDataPool` mirrors `CRDT.Document`'s parallel fields: the
 * object pool itself (`objects`, addressed by index everywhere else via an
 * `ObjectID.objectIndex`), the key-name table (`keyNames`), the UUID table
 * (`uuidTable`), and the document's version vector (`version` - see below).
 * Callers own clearing/rebuilding `objects` from index 0 (a from-scratch
 * rebuild's actual job); this module only provides the primitives for
 * appending to it correctly.
 *
 * On version vectors: what the 2026-07-15 dev log called the opaque
 * "generation-stamp mechanism" turned out to be plain CRDT version vectors
 * once Apple's own schema was recovered (dev log 2026-07-16T15:18) -
 * `Document.version` is the document's vector clock, and each
 * `Dictionary.Element.timestamp` stamps that element with the vector time
 * of its last write. The stamping *policy* below (read `version.element[0]`,
 * add 2, stamp everything uniformly, rebuild the registry with uniform
 * copies) is a faithful port of the pre-alignment behavior derived from
 * byte-level capture evidence; whether it's the semantically right policy
 * against Apple's real merge rules is exactly what the table-write 3/4
 * evidence pass is establishing.
 */

import { randomBytes } from "node:crypto";
import { create, isFieldSet } from "@bufbuild/protobuf";
import { newCellDocument, encodeCellDocument } from "./tableCellEdit.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import {
  ArraySchema,
  DictionarySchema,
  Dictionary_ElementSchema,
  ObjectIDSchema,
  OrderedSetSchema,
  StringArraySchema,
  StringArray_ArrayAttachmentSchema,
  VectorTimestampSchema,
  VectorTimestamp_ElementSchema,
  type Dictionary_Element,
  type Document_DocObject,
  type ObjectID,
  type OrderedSet,
  type VectorTimestamp,
  type VectorTimestamp_Element,
} from "./gen/crdt_pb.js";

export interface MergeableDataPool {
  /** Pool objects, addressed by index ("ref N" throughout this codebase). */
  objects: Document_DocObject[];
  keyNames: string[];
  uuidTable: Uint8Array[];
  /**
   * `CRDT.Document.version` - the document's version vector. In every real
   * capture its first element is `{replicaIndex: 0, clock: N, subclock: 0}`
   * where N is the highest clock anywhere in the document (a running
   * "current generation" counter under the pre-alignment reading); later
   * elements are per-replica entries. Same message reference as the parsed
   * document's own field - mutate its `element` array in place (never
   * reassign the message), matching every other array on this interface.
   */
  version: VectorTimestamp;
}

// --- pool object / key-name / UUID helpers ---------------------------------

export function pushObject(pool: MergeableDataPool, entry: Document_DocObject): number {
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

// --- version-vector stamps -------------------------------------------------

const ELEMENT_FIELDS = {
  replicaIndex: VectorTimestamp_ElementSchema.fields.find((f) => f.localName === "replicaIndex")!,
  clock: VectorTimestamp_ElementSchema.fields.find((f) => f.localName === "clock")!,
  subclock: VectorTimestamp_ElementSchema.fields.find((f) => f.localName === "subclock")!,
};

/** Every stamp this project writes matches the shape every real capture has
 * shown for freshly created elements: a single `{replicaIndex: 0, clock:
 * stamp, subclock: 0}` element with all three fields encoded explicitly
 * (Apple's encoder writes the zeros, and the round-trip gate depends on
 * matching that). */
function stampElement(stamp: number): VectorTimestamp_Element {
  return create(VectorTimestamp_ElementSchema, { replicaIndex: 0n, clock: BigInt(stamp), subclock: 0n });
}

function stampVector(stamp: number): VectorTimestamp {
  return create(VectorTimestampSchema, { element: [stampElement(stamp)] });
}

/** Requires the exact first-element shape every real capture has shown
 * (`{0, N, 0}`, all fields explicitly present) and returns its clock. */
function requireLeadClock(version: VectorTimestamp): number {
  const first = version.element[0];
  if (
    !first ||
    !isFieldSet(first, ELEMENT_FIELDS.replicaIndex) ||
    !isFieldSet(first, ELEMENT_FIELDS.clock) ||
    !isFieldSet(first, ELEMENT_FIELDS.subclock) ||
    first.replicaIndex !== 0n ||
    first.subclock !== 0n
  ) {
    throw new Error("Table's version vector doesn't lead with the expected {0, N, 0} element - refusing to guess its meaning");
  }
  return Number(first.clock);
}

/** Reads the version vector's leading clock and returns the next value to
 * use for this rebuild - matches the `+2` step size observed between real
 * saves (a column insertion bumped it from 62 to 78... in steps of 2 per
 * created element pair, per the pre-alignment reading). Throws if the vector
 * is empty or shaped unexpectedly: a rebuild always starts from a real
 * fetched document, so that means something unexpected about the document,
 * not a case to paper over with a made-up starting value. */
export function nextGenerationStamp(pool: MergeableDataPool): number {
  return requireLeadClock(pool.version) + 2;
}

/** Replaces the document's version vector with a fresh one: a leading
 * element holding `stamp` itself (the new running maximum), followed by
 * `freshElementCount` more copies - matching the observed pattern where
 * every object created in one save shares a single stamp. Mutates
 * `pool.version.element` in place (same message reference as the parsed
 * document's own field), never reassigns the message. */
export function resetGenerationRegistry(pool: MergeableDataPool, stamp: number, freshElementCount: number): void {
  pool.version.element.length = 0;
  for (let i = 0; i <= freshElementCount; i += 1) {
    pool.version.element.push(stampElement(stamp));
  }
}

/** Builds a `Dictionary.Element` carrying the given stamp as its
 * `timestamp` - `cellColumns`, every row-map, and both `OrderedSet.set`
 * dicts are built from these. Callers are responsible for counting how many
 * they create in one rebuild and passing that count to
 * `resetGenerationRegistry` once at the end. */
export function stampedDictionaryElement(keyRef: number, valueRef: number, stamp: number): Dictionary_Element {
  return create(Dictionary_ElementSchema, {
    key: refTo(keyRef),
    value: refTo(valueRef),
    timestamp: stampVector(stamp),
  });
}

// --- ordered collections -------------------------------------------------

/**
 * Builds a complete, fresh `OrderedSet` from a plain ordered list of
 * identities - generic over what those identities represent (table rows,
 * table columns, or any future ordered CRDT list): populates
 * `array.array.attachments` (the identity-UUID list in order),
 * `array.array.contents` (the per-character U+FFFC mirror whose *absence*
 * caused the live corruption incident this rewrite exists to fix - built by
 * reusing `tableCellEdit.ts`'s `newCellDocument`/`encodeCellDocument`, since
 * `StringArray.contents` is the same `topotext.String` message type table
 * cells use; this is the only place outside `tableCellEdit.ts` itself that
 * reuses that "build a fresh CRDT-backed String from text" mechanism, not
 * because this concept is table-specific), `set` (one stamped self-pair per
 * entry), and an empty `array.dictionary` (no redirects - nothing built by
 * this rewrite ever creates duplicate identities).
 */
export function buildFreshOrderedSet(entries: readonly { ref: number; uuid: Uint8Array }[], stamp: number): OrderedSet {
  const attachments = entries.map((entry, index) =>
    create(StringArray_ArrayAttachmentSchema, { attachmentIndex: BigInt(index), contents: entry.uuid }),
  );
  const contents = encodeCellDocument(newCellDocument(OBJECT_REPLACEMENT_CHARACTER.repeat(entries.length)));
  const elements = entries.map((entry) => stampedDictionaryElement(entry.ref, entry.ref, stamp));

  return create(OrderedSetSchema, {
    array: create(ArraySchema, {
      array: create(StringArraySchema, { contents, attachments }),
      dictionary: create(DictionarySchema, { element: [] }),
    }),
    set: create(DictionarySchema, { element: elements }),
  });
}
