import path from "node:path";
import { UnknownVersionSnapshotError, UntrackedFileError } from "../errors.js";
import type { CloneState, CloneStateNoteEntry } from "./cloneState.js";
import { listVersions, type VersionSnapshot } from "./versionHistory.js";

export interface TrackedNote {
  recordName: string;
  entry: CloneStateNoteEntry;
}

/** Resolves a file argument to its tracked note, by basename match against
 * `state.notes` - the same lookup `restore` uses. Throws `UntrackedFileError`
 * if it doesn't match a tracked note. */
export function resolveTrackedNote(state: CloneState, fileArg: string, targetDir: string): TrackedNote {
  const fileName = path.basename(fileArg);
  const match = Object.entries(state.notes).find(([, entry]) => entry.file === fileName);
  if (!match) {
    throw new UntrackedFileError(fileName, targetDir);
  }
  const [recordName, entry] = match;
  return { recordName, entry };
}

/** Every recordName whose version history belongs to this note: its own
 * Note record, plus any table attachments currently associated with it. */
export function historyRecordNames(state: CloneState, recordName: string): string[] {
  const tableRecordNames = Object.entries(state.tableAttachments ?? {})
    .filter(([, entry]) => entry.noteRecordName === recordName)
    .map(([tableRecordName]) => tableRecordName);
  return [recordName, ...tableRecordNames];
}

/** Finds a snapshot by id across a set of recordNames (a note's own history
 * plus its table attachments'), for `diff`/`revert`. Throws
 * `UnknownVersionSnapshotError` if no recorded snapshot matches - `fileArg`
 * is only used for that error's message. */
export async function findSnapshotById(
  targetDir: string,
  recordNames: readonly string[],
  id: string,
  fileArg: string,
): Promise<VersionSnapshot> {
  for (const recordName of recordNames) {
    const match = (await listVersions(targetDir, recordName)).find((snapshot) => snapshot.id === id);
    if (match) {
      return match;
    }
  }
  throw new UnknownVersionSnapshotError(id, fileArg);
}
