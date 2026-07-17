import { unlink } from "node:fs/promises";
import path from "node:path";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords, updateNoteRecord, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { IcloudSession } from "../session.js";
import { removeAttachmentsForNote, removeTableAttachmentsForNote } from "../notes/attachmentSync.js";
import { removeBaseCopy } from "../notes/baseCopy.js";
import {
  readCloneState,
  writeCloneState,
  type CloneState,
  type CloneStateNoteEntry,
} from "../notes/cloneState.js";
import { NoteDeleteRejectedError, NotClonedDirectoryError, NotesUnavailableError, UntrackedFileError } from "../errors.js";
import { buildNotePurgeFields, buildNoteTrashFields, TRASH_FOLDER_RECORD_NAME } from "../notes/encodeNoteRecord.js";
import { isEnoent } from "../fsUtil.js";
import { localFileState, type LocalFileState } from "../notes/localFileState.js";
import { matchTrackedFile, resolveTrackedNote } from "../notes/trackedFile.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface DeleteOptions {
  /** Also permanently delete (Apple's stage-2 purge, `Deleted: 1`) instead
   * of stopping at Recently Deleted. */
  hard?: boolean;
  onLoginStatus?: (message: string) => void;
}

/**
 * Deletes a tracked note from iCloud the way Apple's own client does (see
 * the 2026-07-16 lifecycle/purge HAR analyses in the project notes): an
 * ordinary update moving the note to Recently Deleted, and - with `--hard` -
 * a second update setting `Deleted: 1` to permanently delete it. Neither
 * stage forceDeletes, so both work on notes with attachments, and neither
 * ever decodes note content - a note too broken to parse (the very case
 * `--hard` exists to repair) deletes just the same.
 *
 * A soft-deleted note stays reachable for a later `delete --hard <file>`
 * through the trash registry in state.json, even though its file and
 * tracking entry are cleaned up. Unlike `revert`, there's no confirmation
 * gate here - calling `delete <file>` at all is already the specific,
 * deliberate action, not a blind write of arbitrary content.
 *
 * A local edit made since the last sync is never silently discarded: the
 * file is left on disk (just untracked) rather than deleted along with the
 * remote note.
 */
export async function runDelete(targetDir: string, fileArg: string, options: DeleteOptions = {}): Promise<void> {
  const hard = options.hard === true;
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const target = resolveDeletionTarget(state, fileArg, targetDir, hard);

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }
  const { session, dsid } = auth;
  const ckdatabasewsUrl = auth.ckdatabasewsUrl;

  const records = await lookupRecords(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, [
    target.recordName,
  ]);
  const record = records[0];

  if (!record || record.deleted === true || isPurged(record)) {
    const local = await forgetNoteLocally(targetDir, target, state);
    await writeCloneState(targetDir, state);
    console.log(`${target.file}: already deleted remotely - ${describeLocalOutcome(local)}`);
    return;
  }

  if (!hard) {
    if (isInTrash(record)) {
      const local = await forgetNoteLocally(targetDir, target, state);
      rememberTrashedNote(state, target.recordName, target.file);
      await writeCloneState(targetDir, state);
      console.log(`${target.file}: already in Recently Deleted - ${describeLocalOutcome(local)}`);
      return;
    }
    await trashNote(session, ckdatabasewsUrl, dsid, target.file, target.recordName, record);
    const local = await forgetNoteLocally(targetDir, target, state);
    rememberTrashedNote(state, target.recordName, target.file);
    await writeCloneState(targetDir, state);
    console.log(`Moved ${target.file} to Recently Deleted (recoverable in Notes for ~30 days) - ${describeLocalOutcome(local)}`);
    return;
  }

  // --hard: Apple's own two-stage sequence, staying on captured precedent -
  // trash first (skipped when the note is already there), then purge using
  // the changeTag the trash-move's response handed back.
  let current = record;
  if (!isInTrash(current)) {
    current = await trashNote(session, ckdatabasewsUrl, dsid, target.file, target.recordName, current);
  }
  const purged = await updateNoteRecord(session, ckdatabasewsUrl, dsid, PRIVATE_NOTES_ZONE, {
    recordName: target.recordName,
    recordChangeTag: current.recordChangeTag ?? "",
    fields: buildNotePurgeFields(current, Date.now()),
    parentRecordName: current.parentRecordName,
  });
  if (!purged.ok) {
    throw new NoteDeleteRejectedError(target.file, purged.serverErrorCode, purged.reason);
  }
  const local = await forgetNoteLocally(targetDir, target, state);
  await writeCloneState(targetDir, state);
  console.log(`Permanently deleted ${target.file} from iCloud - ${describeLocalOutcome(local)}`);
}

/** What `runDelete` operates on: a currently-tracked note, or (for `--hard`)
 * a previously soft-deleted one still known to the trash registry. */
interface DeletionTarget {
  recordName: string;
  file: string;
  /** Absent when resolved through the trash registry - there's no tracked
   * file left to clean up locally. */
  entry?: CloneStateNoteEntry | undefined;
}

function resolveDeletionTarget(state: CloneState, fileArg: string, targetDir: string, hard: boolean): DeletionTarget {
  try {
    const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);
    return { recordName, file: entry.file, entry };
  } catch (cause) {
    if (!(cause instanceof UntrackedFileError)) {
      throw cause;
    }
    const registered = matchTrackedFile(state.trashed ?? {}, fileArg, targetDir);
    if (!registered) {
      throw cause;
    }
    const [recordName, entry] = registered;
    if (!hard) {
      throw new UntrackedFileError(fileArg, targetDir, {
        hint: `This note was already moved to Recently Deleted by this tool. Run "icloud-notes delete --hard ${fileArg}" to permanently delete it.`,
      });
    }
    return { recordName, file: entry.file };
  }
}

/** Stage 1: the trash-move update. Returns the post-update record (with its
 * fresh changeTag) so `--hard` can chain the purge off it directly. */
async function trashNote(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  file: string,
  recordName: string,
  record: CloudKitRecord,
): Promise<CloudKitRecord> {
  const result = await updateNoteRecord(session, ckdatabasewsUrl, dsid, PRIVATE_NOTES_ZONE, {
    recordName,
    recordChangeTag: record.recordChangeTag ?? "",
    fields: buildNoteTrashFields(record, Date.now()),
    parentRecordName: record.parentRecordName,
  });
  if (!result.ok) {
    throw new NoteDeleteRejectedError(file, result.serverErrorCode, result.reason);
  }
  return result.record;
}

export function isInTrash(record: CloudKitRecord): boolean {
  const folder = record.fields.Folder?.value;
  return (
    typeof folder === "object" &&
    folder !== null &&
    (folder as Record<string, unknown>).recordName === TRASH_FOLDER_RECORD_NAME
  );
}

/** Whether the record already carries Apple's stage-2 `Deleted: 1` mark
 * (permanently deleted, awaiting server-side GC). */
export function isPurged(record: CloudKitRecord): boolean {
  const deleted = record.fields.Deleted?.value;
  return typeof deleted === "number" && deleted !== 0;
}

/** Records a soft-deleted note in the trash registry so `delete --hard`
 * can still find it after its file and tracking entry are gone. */
export function rememberTrashedNote(state: CloneState, recordName: string, file: string): void {
  const trashed = state.trashed ?? {};
  trashed[recordName] = { file, trashedAt: Date.now() };
  state.trashed = trashed;
}

/** All local cleanup for a note that's now (at least) trashed remotely:
 * `applyLocalNoteDeletion` when it's still tracked, plus dropping any trash
 * registry entry. Mutates `state`; the caller writes it. */
async function forgetNoteLocally(targetDir: string, target: DeletionTarget, state: CloneState): Promise<LocalFileState> {
  delete state.trashed?.[target.recordName];
  if (!target.entry) {
    return "missing";
  }
  return applyLocalNoteDeletion(targetDir, target.recordName, target.entry, state);
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
