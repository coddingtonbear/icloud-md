import { NotClonedDirectoryError } from "../errors.js";
import { readCloneState } from "../notes/cloneState.js";
import { historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import { listVersions, type VersionSnapshot } from "../notes/versionHistory.js";

/** Lists every recorded version snapshot for a tracked note - its own text
 * plus any table attachments currently associated with it - newest first. */
export async function runHistory(targetDir: string, fileArg: string): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName } = resolveTrackedNote(state, fileArg, targetDir);
  const recordNames = historyRecordNames(state, recordName);

  const rows: Array<{ snapshot: VersionSnapshot; label: string }> = [];
  for (const rn of recordNames) {
    const label = rn === recordName ? "note" : `table ${rn}`;
    // listVersions returns oldest-first; reversed here so that below,
    // Array.sort's stability preserves each record's own newest-first order
    // even when two of its snapshots tie on timestamp (millisecond
    // resolution - plausible for back-to-back captures in one pull/push).
    for (const snapshot of [...(await listVersions(targetDir, rn))].reverse()) {
      rows.push({ snapshot, label });
    }
  }

  if (rows.length === 0) {
    console.log(`No version history recorded yet for ${fileArg}.`);
    return;
  }

  rows.sort((a, b) => b.snapshot.timestamp.localeCompare(a.snapshot.timestamp));
  for (const { snapshot, label } of rows) {
    console.log(`${snapshot.id}  ${snapshot.timestamp}  ${label}  (changeTag ${snapshot.recordChangeTag})`);
  }
}
