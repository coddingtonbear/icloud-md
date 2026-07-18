import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords, noteZone, updateRecords, type NoteZone, type RecordUpdate } from "../cloudkit/databaseClient.js";
import { NotClonedDirectoryError, NotesUnavailableError, UnknownVersionSnapshotError, VersionContentUnavailableError } from "../errors.js";
import { decodeTableMarkdown } from "../notes/decodeTableRecord.js";
import { readCloneState, type CloneState } from "../notes/cloneState.js";
import { decompressNoteDocument } from "../notes/noteText.js";
import { noteDocumentRoundTrips } from "../notes/noteDocument.js";
import { findEpochById, type NoteEpoch } from "../notes/noteEpoch.js";
import { findSnapshotById, historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import { listVersions, type VersionSnapshot } from "../notes/versionHistory.js";
import { sharedNoteWriteRefusal } from "./push.js";

export interface RevertOptions {
  /** The actual server-side write only fires with this set - without it,
   * `revert` fetches the target record, verifies the historical bytes are
   * safe to write, and reports what it *would* do, given the stakes of a
   * real remote write. */
  confirmed: boolean;
  onLoginStatus?: (message: string) => void;
}

/**
 * The real server-side write-back, generalizing exactly what manual
 * incident recovery did by hand (2026-07-15T17:13 dev note): fetch the
 * target record fresh for its current recordChangeTag, round-trip-verify
 * the historical bytes through our own model as a safety gate (the same
 * discipline `push` already applies to new edits, applied here to a
 * snapshot instead), submit via `updateRecords` with that fresh tag.
 *
 * `id` may be a per-record snapshot id, or a whole-note epoch id (see the
 * "Whole-note coordinated version epochs" investigation) - epoch lookup is
 * a separate, sibling path (`findEpochById`) tried only after the ordinary
 * snapshot lookup misses, rather than folding both into one return shape;
 * they're different operations downstream (one write vs. a batch of them),
 * not one operation wearing two shapes.
 *
 * Deliberately not the same thing as the existing `restore` command -
 * `restore` is local-only (overwrites the working file from the base copy,
 * no network call); `revert` is a real remote write.
 */
export async function runRevert(targetDir: string, fileArg: string, id: string, options: RevertOptions): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);
  const recordNames = historyRecordNames(state, recordName);
  // Same policy gate as push - revert is the same kind of remote write, so
  // an individually-shared note or a READ_ONLY shared folder refuses here
  // for the same reasons, before any snapshot or network work.
  const refusal = sharedNoteWriteRefusal(state, entry);
  if (refusal !== undefined) {
    throw new Error(`"${entry.file}" can't be reverted: ${refusal}`);
  }
  const zone = noteZone(entry.sharedZoneOwner);

  let snapshot: VersionSnapshot;
  try {
    snapshot = await findSnapshotById(targetDir, recordNames, id, fileArg);
  } catch (cause) {
    if (!(cause instanceof UnknownVersionSnapshotError)) {
      throw cause;
    }
    const epoch = await findEpochById(targetDir, recordName, id);
    if (!epoch) {
      throw cause;
    }
    await runEpochRevert(targetDir, state, recordName, zone, fileArg, epoch, options);
    return;
  }

  verifySnapshotRevertible(snapshot, id);

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  const records = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    zone.database,
    zone.zoneID,
    [snapshot.recordName],
  );
  const record = records[0];
  if (!record || record.deleted === true) {
    throw new VersionContentUnavailableError(`"${snapshot.recordName}" no longer exists remotely`);
  }

  const targetDescription =
    snapshot.recordType === "Note" ? `${fileArg}'s own text` : `a table in ${fileArg} (${snapshot.recordName})`;

  if (!options.confirmed) {
    console.log(`Would revert ${targetDescription} to the snapshot captured ${snapshot.timestamp} (id ${snapshot.id}).`);
    console.log(`This is a real write to your iCloud account. Re-run with --yes to actually do it.`);
    return;
  }

  const update: RecordUpdate = {
    recordName: record.recordName,
    recordType: record.recordType,
    recordChangeTag: record.recordChangeTag ?? "",
    fields: { [snapshot.field]: { value: snapshot.valueBase64 } },
    // Shared-zone Note updates omit the record-hierarchy parent, matching
    // push's captured-shape discipline (Attachment updates keep it).
    parentRecordName:
      zone.database === "shared" && record.recordType === "Note" ? undefined : record.parentRecordName,
  };

  const [result] = await updateRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, zone.database, zone.zoneID, [update]);
  if (!result) {
    throw new VersionContentUnavailableError("the server returned no result for the revert");
  }
  if (!result.ok) {
    const detail = result.reason ? ` (${result.reason})` : "";
    throw new VersionContentUnavailableError(`the server rejected the revert: ${result.serverErrorCode}${detail}`);
  }

  console.log(`Reverted ${targetDescription} to the snapshot captured ${snapshot.timestamp}.`);
  console.log(`Run "icloud-notes pull" to bring this change into your local copy.`);
}

/** The safety gate `push` already applies to new edits, applied here to a
 * historical snapshot instead - refuses to revert to bytes that don't
 * round-trip byte-for-byte (Note text) or decode cleanly (table) through our
 * own model. */
function verifySnapshotRevertible(snapshot: VersionSnapshot, id: string): void {
  const rawBytes = Buffer.from(snapshot.valueBase64, "base64");
  if (snapshot.field === "TextDataEncrypted") {
    const raw = new Uint8Array(decompressNoteDocument(rawBytes));
    if (!noteDocumentRoundTrips(raw)) {
      throw new VersionContentUnavailableError(
        `snapshot "${id}" doesn't round-trip byte-for-byte through our model - refusing to revert`,
      );
    }
  } else {
    try {
      decodeTableMarkdown(rawBytes);
    } catch {
      throw new VersionContentUnavailableError(`snapshot "${id}" doesn't decode as a valid table - refusing to revert`);
    }
  }
}

function recordLabel(recordName: string, noteRecordName: string): string {
  return recordName === noteRecordName ? "the note's own text" : `table ${recordName}`;
}

/**
 * Reverts every record covered by a whole-note epoch in one batch: fresh
 * recordChangeTags for all of them via a single `lookupRecords` call, then
 * one `updateRecords` call for all of them. Per the investigation's open
 * questions: a table created after the epoch isn't touched (there's no
 * CKRecord delete API here, and destruction is too risky); a `null` entry
 * (predates history tracking) or a snapshot that's vanished locally is
 * skipped with a warning; a table deleted remotely since the epoch is
 * skipped with a warning rather than aborting the whole batch. There's no
 * rollback on partial failure - each record's result is reported
 * independently, matching `updateRecords`' own per-record semantics.
 */
async function runEpochRevert(
  targetDir: string,
  state: CloneState,
  noteRecordName: string,
  zone: NoteZone,
  fileArg: string,
  epoch: NoteEpoch,
  options: RevertOptions,
): Promise<void> {
  const entries: Array<{ recordName: string; snapshot: VersionSnapshot }> = [];
  const notices: string[] = [];

  for (const [recordName, snapshotId] of Object.entries(epoch.snapshots)) {
    if (snapshotId === null) {
      notices.push(`${recordLabel(recordName, noteRecordName)}: no snapshot was ever captured for this record - skipped`);
      continue;
    }
    const snapshot = (await listVersions(targetDir, recordName)).find((candidate) => candidate.id === snapshotId);
    if (!snapshot) {
      notices.push(`${recordLabel(recordName, noteRecordName)}: recorded snapshot "${snapshotId}" no longer exists locally - skipped`);
      continue;
    }
    verifySnapshotRevertible(snapshot, snapshotId);
    entries.push({ recordName, snapshot });
  }

  for (const recordName of historyRecordNames(state, noteRecordName)) {
    if (!(recordName in epoch.snapshots)) {
      notices.push(`${recordLabel(recordName, noteRecordName)}: wasn't part of this epoch (created after it was captured) - left unchanged`);
    }
  }

  if (entries.length === 0) {
    console.log(`Nothing to revert for ${fileArg} at epoch "${epoch.id}" - every associated record was skipped:`);
    for (const notice of notices) {
      console.log(`  - ${notice}`);
    }
    return;
  }

  if (!options.confirmed) {
    console.log(`Would revert ${fileArg} to the whole-note epoch captured ${epoch.timestamp} (id ${epoch.id}):`);
    for (const { recordName, snapshot } of entries) {
      console.log(`  - ${recordLabel(recordName, noteRecordName)}, to the snapshot captured ${snapshot.timestamp}`);
    }
    for (const notice of notices) {
      console.log(`  - ${notice}`);
    }
    console.log(`This is a real write to your iCloud account, sent as one batch. Re-run with --yes to actually do it.`);
    return;
  }

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  const records = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    zone.database,
    zone.zoneID,
    entries.map((entry) => entry.recordName),
  );
  const recordsByName = new Map(records.map((record) => [record.recordName, record]));

  const updates: RecordUpdate[] = [];
  for (const { recordName, snapshot } of entries) {
    const record = recordsByName.get(recordName);
    if (!record || record.deleted === true) {
      notices.push(`${recordLabel(recordName, noteRecordName)}: no longer exists remotely - skipped`);
      continue;
    }
    updates.push({
      recordName: record.recordName,
      recordType: record.recordType,
      recordChangeTag: record.recordChangeTag ?? "",
      fields: { [snapshot.field]: { value: snapshot.valueBase64 } },
      // See the single-snapshot path: shared-zone Note updates omit parent.
      parentRecordName:
        zone.database === "shared" && record.recordType === "Note" ? undefined : record.parentRecordName,
    });
  }

  if (updates.length === 0) {
    console.log(`Nothing to revert for ${fileArg} - every targeted record is gone remotely:`);
    for (const notice of notices) {
      console.log(`  - ${notice}`);
    }
    return;
  }

  const results = await updateRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, zone.database, zone.zoneID, updates);
  console.log(`Reverting ${fileArg} to the whole-note epoch captured ${epoch.timestamp}:`);
  for (let i = 0; i < updates.length; i += 1) {
    const update = updates[i];
    const result = results[i];
    if (!update) {
      continue;
    }
    const label = recordLabel(update.recordName, noteRecordName);
    if (!result) {
      console.log(`  - ${label}: the server returned no result`);
    } else if (result.ok) {
      console.log(`  - ${label}: reverted`);
    } else {
      const detail = result.reason ? ` (${result.reason})` : "";
      console.log(`  - ${label}: FAILED - ${result.serverErrorCode}${detail}`);
    }
  }
  for (const notice of notices) {
    console.log(`  - ${notice}`);
  }
  console.log(`No rollback is performed on partial failure - check each line above.`);
  console.log(`Run "icloud-notes pull" to bring these changes into your local copy.`);
}
