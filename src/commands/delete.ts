import { unlink } from "node:fs/promises";
import path from "node:path";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import { deleteNoteRecord, lookupRecords } from "../cloudkit/databaseClient.js";
import { removeAttachmentsForNote, removeTableAttachmentsForNote } from "../notes/attachmentSync.js";
import { removeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { NoteDeleteRejectedError, NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { isEnoent } from "../fsUtil.js";
import { localFileState, type LocalFileState } from "../notes/localFileState.js";
import { resolveTrackedNote } from "../notes/trackedFile.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface DeleteOptions {
  onLoginStatus?: (message: string) => void;
}

/**
 * Deletes a tracked note from iCloud via CloudKit's `forceDelete` (see the
 * "Delete a note from iCloud" investigation in the project notes) and
 * cleans up local tracking to match. Unlike `revert`, there's no
 * confirmation gate here - calling `delete <file>` at all is already the
 * specific, deliberate action, not a blind write of arbitrary content.
 *
 * A local edit made since the last sync is never silently discarded: the
 * file is left on disk (just untracked) rather than deleted along with the
 * remote note.
 */
export async function runDelete(targetDir: string, fileArg: string, options: DeleteOptions = {}): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);

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
    [recordName],
  );
  const record = records[0];

  if (!record || record.deleted === true) {
    const local = await applyLocalNoteDeletion(targetDir, recordName, entry, state);
    await writeCloneState(targetDir, state);
    console.log(`${entry.file}: already deleted remotely - ${describeLocalOutcome(local)}`);
    return;
  }

  const result = await deleteNoteRecord(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    PRIVATE_NOTES_ZONE,
    recordName,
    record.recordChangeTag ?? "",
  );
  if (!result.ok) {
    throw new NoteDeleteRejectedError(entry.file, result.serverErrorCode, result.reason);
  }

  const local = await applyLocalNoteDeletion(targetDir, recordName, entry, state);
  await writeCloneState(targetDir, state);
  console.log(`Deleted ${entry.file} from iCloud - ${describeLocalOutcome(local)}`);
}

/**
 * Local cleanup shared by both the "already deleted remotely" and the
 * real-delete-just-succeeded paths - mirrors `pull`'s own handling of a
 * remotely-detected deletion (`handleRemoteDeletion`): a clean or missing
 * local file is removed/left alone with nothing to protect, but a locally
 * modified file is kept on disk (just dropped from tracking) rather than
 * destroyed along with the remote note. Mutates `state` in place.
 */
export async function applyLocalNoteDeletion(
  targetDir: string,
  recordName: string,
  entry: CloneStateNoteEntry,
  state: CloneState,
): Promise<LocalFileState> {
  const attachments = state.attachments ?? {};
  const tableAttachments = state.tableAttachments ?? {};

  const local = await localFileState(targetDir, entry, recordName);
  if (local === "clean") {
    await safeUnlink(path.join(targetDir, entry.file));
  }

  delete state.notes[recordName];
  await removeBaseCopy(targetDir, recordName);
  for (const removed of await removeAttachmentsForNote(targetDir, recordName, attachments)) {
    delete attachments[removed];
  }
  for (const removed of removeTableAttachmentsForNote(recordName, tableAttachments)) {
    delete tableAttachments[removed];
  }
  state.attachments = attachments;
  state.tableAttachments = tableAttachments;

  return local;
}

function describeLocalOutcome(local: LocalFileState): string {
  switch (local) {
    case "clean":
      return "removed the local copy.";
    case "missing":
      return "local copy was already missing.";
    case "modified":
      return "kept the local copy since it has unpushed edits (now untracked).";
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
  }
}
