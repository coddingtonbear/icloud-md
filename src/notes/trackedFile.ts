import path from "node:path";
import { AmbiguousTrackedFileError, UnknownVersionSnapshotError, UntrackedFileError } from "../errors.js";
import type { CloneState, CloneStateNoteEntry } from "./cloneState.js";
import { listVersions, type VersionSnapshot } from "./versionHistory.js";

export interface TrackedNote {
  recordName: string;
  entry: CloneStateNoteEntry;
}

/**
 * Matches a user-supplied file argument against tracked entries' vault-root-
 * relative `file` paths, git-style: the argument resolves against the
 * current directory first (so `icloud-notes delete Pie.md` works from inside
 * `Recipes/`, and `../Work/Standup.md` works from a sibling), with a
 * unique-basename fallback so a bare name still resolves from anywhere when
 * it's unambiguous. Returns undefined when nothing matches; throws
 * AmbiguousTrackedFileError when a bare name matches several entries.
 */
export function matchTrackedFile<T extends { file: string }>(
  entries: Record<string, T>,
  fileArg: string,
  targetDir: string,
  cwd: string = process.cwd(),
): [string, T] | undefined {
  const rootRelative = vaultRelativePath(fileArg, targetDir, cwd);
  if (rootRelative !== undefined) {
    const exact = Object.entries(entries).find(([, entry]) => entry.file === rootRelative);
    if (exact) {
      return exact;
    }
  }

  const base = path.basename(fileArg);
  const byBasename = Object.entries(entries).filter(([, entry]) => path.posix.basename(entry.file) === base);
  if (byBasename.length > 1) {
    throw new AmbiguousTrackedFileError(
      base,
      byBasename.map(([, entry]) => entry.file),
    );
  }
  return byBasename[0];
}

/** A file argument resolved against the current directory, re-expressed
 * relative to the vault root (POSIX form) - or undefined when it points
 * outside the vault entirely. */
function vaultRelativePath(fileArg: string, targetDir: string, cwd: string): string | undefined {
  const relative = path.relative(path.resolve(targetDir), path.resolve(cwd, fileArg));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/** Resolves a file argument to its tracked note - see `matchTrackedFile`
 * for the resolution rules. Throws `UntrackedFileError` if it doesn't match
 * a tracked note. */
export function resolveTrackedNote(state: CloneState, fileArg: string, targetDir: string): TrackedNote {
  const match = matchTrackedFile(state.notes, fileArg, targetDir);
  if (!match) {
    throw new UntrackedFileError(fileArg, targetDir);
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
