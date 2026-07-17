import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnoent } from "../fsUtil.js";
import { listVersions } from "./versionHistory.js";

/**
 * A second layer on top of `versionHistory.ts`'s per-record snapshots: one
 * epoch written per pull/push run that actually changed a note, indexing
 * which snapshot was current for every record associated with that note (its
 * own text, plus any table attachments) at that moment. Per-record snapshots
 * alone can't answer "what did this whole note look like at 3pm Tuesday" -
 * there's no guarantee a Note snapshot and a table snapshot near the same
 * time were actually captured together. Epochs exist so `history`/`diff`/
 * `revert` can treat a note as one coordinated unit. See the "Whole-note
 * coordinated version epochs" investigation.
 */
const HISTORY_DIR_SEGMENTS = [".icloud-notes-sync", "history"];
const EPOCH_SUBDIR = "epochs";

export interface NoteEpoch {
  id: string;
  timestamp: string;
  noteRecordName: string;
  /**
   * Maps every record associated with this note at capture time -> the
   * snapshot id that was current for that record at this epoch. null means
   * the record existed but no snapshot had ever been captured for it
   * (predates history tracking, or this is the first pull of a very old
   * note).
   */
  snapshots: Record<string, string | null>;
}

/**
 * Writes a new epoch for `noteRecordName`, covering every record in
 * `recordNames` (conventionally the note's own recordName first, then any
 * table attachments - see `historyRecordNames`). For each, the most recently
 * captured snapshot id is looked up fresh: a record whose snapshot was just
 * written this run picks up its new id this way too, so the caller doesn't
 * need to track "new vs. carried over" separately - every entry is just
 * "whatever's current right now."
 */
export async function recordEpoch(targetDir: string, noteRecordName: string, recordNames: readonly string[]): Promise<void> {
  const snapshots: Record<string, string | null> = {};
  for (const recordName of recordNames) {
    const versions = await listVersions(targetDir, recordName);
    snapshots[recordName] = versions[versions.length - 1]?.id ?? null;
  }

  const capturedAt = new Date();
  const id = randomUUID();
  const epoch: NoteEpoch = { id, timestamp: capturedAt.toISOString(), noteRecordName, snapshots };

  const dir = epochDir(targetDir, noteRecordName);
  await mkdir(dir, { recursive: true });
  const shortId = id.replace(/-/g, "").slice(0, 8);
  // Same monotonic-counter discipline as `recordVersion` - see its comment.
  const existing = await listEpochs(targetDir, noteRecordName);
  const seq = String(existing.length).padStart(6, "0");
  const fileName = `${capturedAt.getTime()}-${seq}-${shortId}.json`;
  await writeFile(path.join(dir, fileName), JSON.stringify(epoch, null, 2) + "\n", "utf-8");
}

/** Every epoch recorded for `noteRecordName`, oldest first. Empty if none exist. */
export async function listEpochs(targetDir: string, noteRecordName: string): Promise<NoteEpoch[]> {
  const dir = epochDir(targetDir, noteRecordName);
  let fileNames: string[];
  try {
    fileNames = await readdir(dir);
  } catch (cause) {
    if (isEnoent(cause)) {
      return [];
    }
    throw cause;
  }

  const epochs: NoteEpoch[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith(".json")).sort()) {
    const raw = await readFile(path.join(dir, fileName), "utf-8");
    epochs.push(JSON.parse(raw) as NoteEpoch);
  }
  return epochs;
}

/**
 * Finds an epoch by id under a note's own recordName - unlike
 * `findSnapshotById`, this never needs to search across a note's table
 * recordNames too, since an epoch is always filed under the note's own
 * history directory regardless of which records it covers.
 */
export async function findEpochById(targetDir: string, noteRecordName: string, id: string): Promise<NoteEpoch | undefined> {
  return (await listEpochs(targetDir, noteRecordName)).find((epoch) => epoch.id === id);
}

function epochDir(targetDir: string, noteRecordName: string): string {
  return path.join(targetDir, ...HISTORY_DIR_SEGMENTS, noteRecordName, EPOCH_SUBDIR);
}
