import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureAuthenticated } from "../auth/ensureAuthenticated.js";
import { fetchAllNoteRecords, fetchSharedNoteRecords, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName, uniqueFileName } from "../notes/filename.js";
import { mergeNoteVersions } from "../notes/mergeConflict.js";
import { readBaseCopy, removeBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { localFileState } from "../notes/localFileState.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import type { IcloudSession } from "../session.js";

interface PullSummary {
  added: number;
  updated: number;
  merged: number;
  removed: number;
  skippedNewUnsyncable: number;
  droppedUnsyncable: number;
  unsharedUntracked: number;
  conflicts: string[];
}

export async function runPull(session: IcloudSession, targetDir: string): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new Error(
      `${targetDir} doesn't look like a cloned notes directory (no .icloud-notes-sync/state.json) - run "clone" first.`,
    );
  }

  const auth = await ensureAuthenticated(session);
  if (!auth.ckdatabasewsUrl) {
    throw new Error("Authenticated, but the account reported no ckdatabasews host - can't reach Notes.");
  }

  const { records, syncToken } = await fetchAllNoteRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, state.syncToken);
  const sharedZones = await fetchSharedNoteRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    state.sharedZoneSyncTokens ?? {},
  );

  const notes: CloneState["notes"] = { ...state.notes };
  const usedFileNames = new Set(Object.values(state.notes).map((entry) => entry.file));
  const summary: PullSummary = {
    added: 0,
    updated: 0,
    merged: 0,
    removed: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    unsharedUntracked: 0,
    conflicts: [],
  };

  const sources: Array<{ records: CloudKitRecord[]; sharedZoneOwner?: string | undefined }> = [{ records }];
  const sharedZoneSyncTokens: Record<string, string> = {};
  for (const zone of sharedZones) {
    if (zone.zoneID.ownerRecordName && zone.syncToken) {
      sharedZoneSyncTokens[zone.zoneID.ownerRecordName] = zone.syncToken;
    }
    sources.push({ records: zone.records, sharedZoneOwner: zone.zoneID.ownerRecordName });
  }

  for (const source of sources) {
    for (const record of source.records) {
      if (record.recordType !== "Note") {
        continue;
      }

      const existing = notes[record.recordName];
      const decoded = classifyNoteRecord(record);

      if (decoded.status === "deleted") {
        if (!existing) {
          continue;
        }
        await handleRemoteDeletion(targetDir, record, existing, notes, summary);
        continue;
      }

      if (decoded.status === "unsyncable") {
        if (!existing) {
          summary.skippedNewUnsyncable += 1;
          continue;
        }
        const local = await localFileState(targetDir, existing, record.recordName);
        if (local === "modified") {
          summary.conflicts.push(
            `${existing.file}: became unsyncable remotely (${decoded.reason}), and has local edits - left in place, untracked`,
          );
        } else {
          summary.droppedUnsyncable += 1;
          if (local === "clean") {
            console.warn(
              `${existing.file}: no longer syncable remotely (${decoded.reason}) - leaving existing local copy but no longer tracking it`,
            );
          }
        }
        delete notes[record.recordName];
        await removeBaseCopy(targetDir, record.recordName);
        continue;
      }

      // decoded.status === "ok"
      if (!existing) {
        const fileName = uniqueFileName(noteFileName(decoded.title), usedFileNames);
        usedFileNames.add(fileName);

        const filePath = path.join(targetDir, fileName);
        await writeFile(filePath, decoded.bodyText, "utf-8");
        await applyNoteFileTimes(filePath, record);
        await writeBaseCopy(targetDir, record.recordName, decoded.bodyText);
        notes[record.recordName] = {
          file: fileName,
          recordChangeTag: record.recordChangeTag ?? "",
          modificationDate: modificationDateOf(record),
          sharedZoneOwner: source.sharedZoneOwner,
        };
        summary.added += 1;
        continue;
      }

      const local = await localFileState(targetDir, existing, record.recordName);
      if (local === "clean" || local === "missing") {
        const filePath = path.join(targetDir, existing.file);
        await writeFile(filePath, decoded.bodyText, "utf-8");
        await applyNoteFileTimes(filePath, record);
        await writeBaseCopy(targetDir, record.recordName, decoded.bodyText);
        if (local === "missing") {
          console.log(`Recreated ${existing.file} (was missing locally)`);
        }
        notes[record.recordName] = {
          ...existing,
          recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
          modificationDate: modificationDateOf(record),
        };
        summary.updated += 1;
        continue;
      }

      // local === "modified": real 3-way merge against the base copy.
      const base = (await readBaseCopy(targetDir, record.recordName)) ?? "";
      const localContent = await readFile(path.join(targetDir, existing.file), "utf-8");
      const outcome = mergeNoteVersions(base, localContent, decoded.bodyText);

      await writeFile(path.join(targetDir, existing.file), outcome.text, "utf-8");
      notes[record.recordName] = {
        ...existing,
        recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
        modificationDate: modificationDateOf(record),
      };

      if (outcome.hasConflict) {
        summary.conflicts.push(`${existing.file}: merged with conflict markers - resolve manually`);
        // Base copy deliberately NOT advanced: it stays the merge ancestor
        // until the conflict markers are actually resolved, so the next pull
        // (if this note changes again) merges against the right common point.
      } else {
        await writeBaseCopy(targetDir, record.recordName, outcome.text);
        summary.merged += 1;
      }
    }
  }

  await handleVanishedSharedZones(targetDir, sharedZones, notes, summary);

  await writeCloneState(targetDir, { syncToken, sharedZoneSyncTokens, notes });

  console.log(
    `Pulled into ${targetDir}: ${summary.added} added, ${summary.updated} updated, ${summary.merged} auto-merged, ` +
      `${summary.removed} removed`,
  );
  if (summary.skippedNewUnsyncable > 0 || summary.droppedUnsyncable > 0) {
    console.log(
      `${summary.skippedNewUnsyncable} new unsyncable note(s) skipped, ${summary.droppedUnsyncable} note(s) ` +
        "dropped from tracking (no longer syncable)",
    );
  }
  if (summary.unsharedUntracked > 0) {
    console.log(
      `${summary.unsharedUntracked} shared note(s) no longer shared with you - local copies left in place, untracked`,
    );
  }
  if (summary.conflicts.length > 0) {
    console.log(`${summary.conflicts.length} conflict(s) - resolve manually:`);
    for (const conflict of summary.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }
}

/**
 * A shared zone that disappears from the shared-database listing means its
 * owner stopped sharing with this account (or deleted their zone). That's
 * loss of *access*, not proof the notes were deleted - so local files are
 * deliberately left in place and only the tracking entries are dropped,
 * unlike a per-note remote deletion (which removes a clean local copy).
 */
async function handleVanishedSharedZones(
  targetDir: string,
  sharedZones: Array<{ zoneID: { ownerRecordName?: string | undefined } }>,
  notes: CloneState["notes"],
  summary: PullSummary,
): Promise<void> {
  const liveOwners = new Set(
    sharedZones.map((zone) => zone.zoneID.ownerRecordName).filter((owner): owner is string => owner !== undefined),
  );

  for (const [recordName, entry] of Object.entries(notes)) {
    if (!entry.sharedZoneOwner || liveOwners.has(entry.sharedZoneOwner)) {
      continue;
    }
    console.warn(
      `${entry.file}: no longer shared with you - leaving local copy in place but no longer tracking it`,
    );
    delete notes[recordName];
    await removeBaseCopy(targetDir, recordName);
    summary.unsharedUntracked += 1;
  }
}

async function handleRemoteDeletion(
  targetDir: string,
  record: CloudKitRecord,
  existing: CloneStateNoteEntry,
  notes: CloneState["notes"],
  summary: PullSummary,
): Promise<void> {
  const local = await localFileState(targetDir, existing, record.recordName);

  if (local !== "modified") {
    // "clean" or "missing": nothing local worth protecting.
    if (local === "clean") {
      await safeUnlink(path.join(targetDir, existing.file));
    }
    delete notes[record.recordName];
    await removeBaseCopy(targetDir, record.recordName);
    summary.removed += 1;
    return;
  }

  // A delete/modify conflict is never auto-resolved either direction - merge
  // against an empty remote so the markers show exactly what local kept.
  const base = (await readBaseCopy(targetDir, record.recordName)) ?? "";
  const localContent = await readFile(path.join(targetDir, existing.file), "utf-8");
  const outcome = mergeNoteVersions(base, localContent, "");

  await writeFile(path.join(targetDir, existing.file), outcome.text, "utf-8");
  summary.conflicts.push(`${existing.file}: deleted remotely, but has local edits - merged with conflict markers, resolve manually`);
  // Keep tracking (state entry + base copy) so this doesn't silently drop
  // out of state.json; there's no new recordChangeTag to advance to since
  // the record no longer exists remotely.
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

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
