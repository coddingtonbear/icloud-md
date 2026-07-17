import { NotClonedDirectoryError } from "../errors.js";
import { readCloneState } from "../notes/cloneState.js";
import { listEpochs, type NoteEpoch } from "../notes/noteEpoch.js";
import { historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import { listVersions, type VersionSnapshot } from "../notes/versionHistory.js";

export interface HistoryOptions {
  /** Restores the pre-epoch flat per-record snapshot listing. */
  records?: boolean;
}

/**
 * Lists a tracked note's recorded history, newest first. By default this is
 * the epoch timeline (one line per coordinated pull/push capture - see the
 * "Whole-note coordinated version epochs" investigation); `--records` (via
 * `options.records`) restores the previous per-record flat listing.
 */
export async function runHistory(targetDir: string, fileArg: string, options: HistoryOptions = {}): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName } = resolveTrackedNote(state, fileArg, targetDir);

  if (options.records) {
    await printRecordHistory(targetDir, historyRecordNames(state, recordName), recordName, fileArg);
    return;
  }

  const epochs = await listEpochs(targetDir, recordName);
  if (epochs.length === 0) {
    console.log(`No version history recorded yet for ${fileArg}.`);
    return;
  }

  // oldest-first from listEpochs; walking forward lets each epoch compare
  // against the one immediately before it to say what changed vs. carried
  // over, then the finished rows print newest-first to match the default.
  const rows: string[] = [];
  let previous: NoteEpoch | undefined;
  for (const epoch of epochs) {
    rows.push(describeEpoch(epoch, previous, recordName));
    previous = epoch;
  }
  for (const row of rows.reverse()) {
    console.log(row);
  }
}

function describeEpoch(epoch: NoteEpoch, previous: NoteEpoch | undefined, noteRecordName: string): string {
  const changed: string[] = [];
  const carried: string[] = [];
  for (const [recordName, snapshotId] of Object.entries(epoch.snapshots)) {
    const label = recordName === noteRecordName ? "note" : `table ${recordName}`;
    const previousSnapshotId = previous?.snapshots[recordName];
    if (previous && previousSnapshotId === snapshotId) {
      carried.push(label);
    } else {
      changed.push(label);
    }
  }

  let line = `${epoch.id}  ${epoch.timestamp}  changed: ${changed.join(", ")}`;
  if (carried.length > 0) {
    line += `  (carried over: ${carried.join(", ")})`;
  }
  return line;
}

async function printRecordHistory(targetDir: string, recordNames: string[], noteRecordName: string, fileArg: string): Promise<void> {
  const rows: Array<{ snapshot: VersionSnapshot; label: string }> = [];
  for (const rn of recordNames) {
    const label = rn === noteRecordName ? "note" : `table ${rn}`;
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
