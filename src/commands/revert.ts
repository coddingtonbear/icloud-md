import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords, updateRecords, type RecordUpdate } from "../cloudkit/databaseClient.js";
import { NotClonedDirectoryError, NotesUnavailableError, VersionContentUnavailableError } from "../errors.js";
import { decodeTableMarkdown } from "../notes/decodeTableRecord.js";
import { readCloneState } from "../notes/cloneState.js";
import { decompressNoteDocument } from "../notes/noteText.js";
import { noteDocumentRoundTrips } from "../notes/noteDocument.js";
import { findSnapshotById, historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

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
 * Deliberately not the same thing as the existing `restore` command -
 * `restore` is local-only (overwrites the working file from the base copy,
 * no network call); `revert` is a real remote write.
 */
export async function runRevert(targetDir: string, fileArg: string, id: string, options: RevertOptions): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName } = resolveTrackedNote(state, fileArg, targetDir);
  const recordNames = historyRecordNames(state, recordName);
  const snapshot = await findSnapshotById(targetDir, recordNames, id, fileArg);

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  const records = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    "private",
    PRIVATE_NOTES_ZONE,
    [snapshot.recordName],
  );
  const record = records[0];
  if (!record || record.deleted === true) {
    throw new VersionContentUnavailableError(`"${snapshot.recordName}" no longer exists remotely`);
  }

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
    parentRecordName: record.parentRecordName,
  };

  const [result] = await updateRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, PRIVATE_NOTES_ZONE, [update]);
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
