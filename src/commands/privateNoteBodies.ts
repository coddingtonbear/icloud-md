import { lookupRecords, mergeLookedUpRecords, noteZone, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import type { IcloudSession } from "../session.js";

/**
 * Looks up, by id, every note *new to this vault* that the private
 * `changes/zone` walk listed without its text, and merges what comes back
 * into `records` in place. The shared-database fetch has always done this
 * (`fetchSharedNoteRecords`); the private walk didn't, so a new private note
 * listed without `TextDataEncrypted` was skipped while the sync token moved
 * past it - and an incremental pull never delivered it again until something
 * edited it on another device.
 *
 * `heldBack` is the recordNames that still have no text afterwards and might
 * get it on a later fetch. The caller keeps its previous private sync token
 * while this is non-empty (pull carries the stored one forward; clone saves
 * none), so the next walk delivers those notes again instead of moving past
 * them.
 *
 * A note whose text lives in a `TextDataAsset` is left out of that list: its
 * text is never going to arrive inline, so holding the token back for it
 * would pin it there for good. It is skipped as before.
 *
 * A failed lookup (a 503, a throttle) doesn't fail the sync: every note it
 * was for is held back, the same as if it had come back without text, and
 * `lookupError` says why.
 *
 * Tracked notes listed without text are left alone - pull already keeps them
 * as they are, with a warning.
 */
export async function backfillNewPrivateNoteBodies(
  session: IcloudSession,
  ckDatabaseHost: string,
  dsid: string,
  records: CloudKitRecord[],
  tracked: Readonly<Record<string, unknown>>,
): Promise<PrivateNoteBodyBackfill> {
  const missing = records.filter((record) => isNewNoteWithoutText(record, tracked));
  if (missing.length === 0) {
    return { heldBack: [] };
  }
  const zone = noteZone(undefined);
  let lookupError: string | undefined;
  try {
    const lookedUp = await lookupRecords(
      session,
      ckDatabaseHost,
      dsid,
      zone.database,
      zone.zoneID,
      missing.map((record) => record.recordName),
    );
    mergeLookedUpRecords(records, lookedUp);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }
  const heldBack = records
    .filter((record) => isNewNoteWithoutText(record, tracked) && !storesTextAsAsset(record))
    .map((record) => record.recordName);
  return lookupError === undefined ? { heldBack } : { heldBack, lookupError };
}

export interface PrivateNoteBodyBackfill {
  /** New notes still without their text, which the caller holds its token back for. */
  heldBack: string[];
  /** Set when `records/lookup` itself failed, so nothing was filled in. */
  lookupError?: string;
}

function isNewNoteWithoutText(record: CloudKitRecord, tracked: Readonly<Record<string, unknown>>): boolean {
  if (record.recordType !== "Note" || Object.hasOwn(tracked, record.recordName)) {
    return false;
  }
  // classifyNoteRecord's own rule, so a deleted or trashed note (which has
  // no text to find) is never looked up or held back for.
  const decoded = classifyNoteRecord(record);
  return decoded.status === "unsyncable" && decoded.reason === "missing-body";
}

function storesTextAsAsset(record: CloudKitRecord): boolean {
  return record.fields.TextDataAsset?.value != null;
}
