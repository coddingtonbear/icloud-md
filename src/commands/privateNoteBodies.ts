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
 * `pending` is the recordNames that still have no text afterwards and might
 * get it on a later fetch. The caller stores them (`pendingBodyLookups` in
 * the state file) and passes them back as `carried` on its next run, when
 * they are looked up again even though the walk - whose token has moved on -
 * no longer lists them. One that comes back is appended to `records`, to be
 * applied like any other new note; one that is gone, or tracked by now, is
 * dropped from the list.
 *
 * A note whose text lives in a `TextDataAsset` is left out of that list: its
 * text is never going to arrive inline, so it would be looked up on every
 * pull for good. It is skipped as before.
 *
 * A failed lookup (a 503, a throttle that outlasted its retries) doesn't fail
 * the sync: every note it was for stays pending, the same as if it had come
 * back without text, and `lookupError` says why.
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
  carried: readonly string[] = [],
): Promise<PrivateNoteBodyBackfill> {
  const listed = new Set(records.map((record) => record.recordName));
  const missing = records.filter((record) => isNewNoteWithoutText(record, tracked));
  // A carried id the walk delivered again is handled as whatever it now is
  // (bodyless, filled in, deleted), and one this vault tracks has arrived.
  const unlisted = [...new Set(carried)].filter((name) => !listed.has(name) && !Object.hasOwn(tracked, name));
  if (missing.length === 0 && unlisted.length === 0) {
    return { pending: [] };
  }
  const zone = noteZone(undefined);
  let lookupError: string | undefined;
  try {
    const lookedUp = await lookupRecords(session, ckDatabaseHost, dsid, zone.database, zone.zoneID, [
      ...missing.map((record) => record.recordName),
      ...unlisted,
    ]);
    mergeLookedUpRecords(records, lookedUp);
    const wanted = new Set(unlisted);
    for (const record of lookedUp) {
      // `delete`, so a name the server answers twice is appended once.
      if (wanted.delete(record.recordName)) {
        records.push(record);
      }
    }
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }
  const pending = records
    .filter((record) => isNewNoteWithoutText(record, tracked) && !storesTextAsAsset(record))
    .map((record) => record.recordName);
  if (lookupError === undefined) {
    return { pending };
  }
  // Nothing was learned about the unlisted ones, so they stay as they were.
  return { pending: [...pending, ...unlisted], lookupError };
}

export interface PrivateNoteBodyBackfill {
  /** New notes still without their text, for the caller to store and pass
   * back as `carried` on its next run. */
  pending: string[];
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
