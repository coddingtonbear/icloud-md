import { NotClonedDirectoryError } from "../errors.js";
import { readCloneState } from "../notes/cloneState.js";
import { listEpochs, type NoteEpoch } from "../notes/noteEpoch.js";
import { historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import { listVersions, type VersionSnapshot } from "../notes/versionHistory.js";

export interface HistoryOptions {
  /** Restores the pre-epoch flat per-record snapshot listing. */
  records?: boolean;
}

/** One epoch in the default timeline view - which records changed at this
 * capture vs. which carried their previous snapshot over unchanged. */
export interface HistoryEpochRow {
  id: string;
  timestamp: string;
  changed: string[];
  carriedOver: string[];
}

/** One row in the `--records` flat per-record snapshot listing. */
export interface HistoryRecordRow {
  id: string;
  timestamp: string;
  label: string;
  recordChangeTag: string;
}

export type HistoryResult =
  | { mode: "epochs"; epochs: HistoryEpochRow[] }
  | { mode: "records"; records: HistoryRecordRow[] };

/**
 * Lists a tracked note's recorded history, newest first. By default this is
 * the epoch timeline (one line per coordinated pull/push capture - see the
 * "Whole-note coordinated version epochs" investigation); `--records` (via
 * `options.records`) restores the previous per-record flat listing.
 */
export async function runHistory(targetDir: string, fileArg: string, options: HistoryOptions = {}): Promise<HistoryResult> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName } = resolveTrackedNote(state, fileArg, targetDir);

  if (options.records) {
    return { mode: "records", records: await buildRecordHistory(targetDir, historyRecordNames(state, recordName), recordName) };
  }

  const epochs = await listEpochs(targetDir, recordName);

  // oldest-first from listEpochs; walking forward lets each epoch compare
  // against the one immediately before it to say what changed vs. carried
  // over, then the finished rows return newest-first to match the default.
  const rows: HistoryEpochRow[] = [];
  let previous: NoteEpoch | undefined;
  for (const epoch of epochs) {
    rows.push(describeEpoch(epoch, previous, recordName));
    previous = epoch;
  }
  return { mode: "epochs", epochs: rows.reverse() };
}

function describeEpoch(epoch: NoteEpoch, previous: NoteEpoch | undefined, noteRecordName: string): HistoryEpochRow {
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

  return { id: epoch.id, timestamp: epoch.timestamp, changed, carriedOver: carried };
}

async function buildRecordHistory(targetDir: string, recordNames: string[], noteRecordName: string): Promise<HistoryRecordRow[]> {
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

  rows.sort((a, b) => b.snapshot.timestamp.localeCompare(a.snapshot.timestamp));
  return rows.map(({ snapshot, label }) => ({
    id: snapshot.id,
    timestamp: snapshot.timestamp,
    label,
    recordChangeTag: snapshot.recordChangeTag,
  }));
}
