import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindNewFolderAccount } from "../auth/folderAuth.js";
import { fetchAllNoteRecords, fetchSharedNoteRecords } from "../cloudkit/databaseClient.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { resolveNoteAttachments, type AttachmentAuth } from "../notes/attachmentSync.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName, uniqueFileName } from "../notes/filename.js";
import { buildVaultLayout, placeNote, type SharedZoneRecords } from "../notes/folderLayout.js";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneState } from "../notes/cloneState.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { AlreadyClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import type { SyncProgress } from "../progress.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface CloneSummary {
  written: number;
  writtenShared: number;
  writtenUnpublishable: number;
  attachmentsDownloaded: number;
  skippedDeleted: number;
  skippedUndecodable: number;
}

/**
 * `clone` only ever performs the *initial* export into a directory - mirrors
 * `git clone`'s own refusal to run against a non-empty destination. Re-running
 * it against an already-bound folder isn't a safe "resync" as this function
 * is written: it always does a full fresh fetch with no diffing against
 * local edits and never cleans up files for notes deleted upstream, unlike
 * `pull`. Use `pull` for an existing clone instead.
 */
export async function runClone(
  targetDir: string,
  progress?: SyncProgress,
  onLoginStatus?: (message: string) => void,
): Promise<CloneSummary> {
  if (await readCloneState(targetDir)) {
    throw new AlreadyClonedDirectoryError(targetDir);
  }

  const auth = await bindNewFolderAccount({ onStatus: onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  await mkdir(targetDir, { recursive: true });

  let fetchedCount = 0;
  const onPage = (pageRecordCount: number): void => {
    fetchedCount += pageRecordCount;
    progress?.onFetchPage?.(fetchedCount);
  };
  const { records, syncToken } = await fetchAllNoteRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    undefined,
    onPage,
  );
  const sharedZones = await fetchSharedNoteRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, {}, onPage);

  const summary: CloneSummary = {
    written: 0,
    writtenShared: 0,
    writtenUnpublishable: 0,
    attachmentsDownloaded: 0,
    skippedDeleted: 0,
    skippedUndecodable: 0,
  };
  const notes: CloneState["notes"] = {};
  const attachments: NonNullable<CloneState["attachments"]> = {};
  const tableAttachments: NonNullable<CloneState["tableAttachments"]> = {};
  const usedFileNames = new Map<string, Set<string>>();
  const usedAttachmentFileNames = new Map<string, Set<string>>();
  const sharedZoneSyncTokens: Record<string, string> = {};
  const attachmentAuth: AttachmentAuth = { session: auth.session, ckdatabasewsUrl: auth.ckdatabasewsUrl, dsid: auth.dsid };

  const sources: Array<{ records: CloudKitRecord[]; sharedZoneOwner?: string | undefined }> = [{ records }];
  const sharedZoneRecords: SharedZoneRecords[] = [];
  for (const zone of sharedZones) {
    if (zone.zoneID.ownerRecordName && zone.syncToken) {
      sharedZoneSyncTokens[zone.zoneID.ownerRecordName] = zone.syncToken;
    }
    if (zone.zoneID.ownerRecordName) {
      sharedZoneRecords.push({ ownerRecordName: zone.zoneID.ownerRecordName, records: zone.records });
    }
    sources.push({ records: zone.records, sharedZoneOwner: zone.zoneID.ownerRecordName });
  }

  // The account's folder tree (own + per-sharer) becomes the directory
  // tree; every folder materializes, empty ones included.
  const layout = buildVaultLayout(records, sharedZoneRecords);
  for (const dir of layout.allDirs) {
    await mkdir(path.join(targetDir, dir), { recursive: true });
  }

  const totalRecords = sources.reduce((sum, source) => sum + source.records.length, 0);
  progress?.onProcessStart?.(totalRecords);

  for (const source of sources) {
    for (const record of source.records) {
      try {
        if (record.recordType !== "Note") {
          continue;
        }

        const decoded = classifyNoteRecord(record);
        if (decoded.status === "deleted") {
          summary.skippedDeleted += 1;
          continue;
        }
        if (decoded.status === "unsyncable") {
          summary.skippedUndecodable += 1;
          continue;
        }

        const placement = placeNote(layout, record, source.sharedZoneOwner);

        let bodyText = decoded.markdownText;
        const unpublishableReason = decoded.unpublishableReason;
        if (decoded.embedSlots.length > 0) {
          const zoneID = source.sharedZoneOwner
            ? { zoneName: PRIVATE_NOTES_ZONE.zoneName, ownerRecordName: source.sharedZoneOwner }
            : PRIVATE_NOTES_ZONE;
          const resolved = await resolveNoteAttachments(
            attachmentAuth,
            source.sharedZoneOwner ? "shared" : "private",
            zoneID,
            targetDir,
            record.recordName,
            decoded.markdownText,
            decoded.embedSlots,
            attachments,
            tableAttachments,
            usedNamesFor(usedAttachmentFileNames, placement.dir),
            placement.dir,
          );
          bodyText = resolved.bodyText;
          Object.assign(attachments, resolved.attachments);
          summary.attachmentsDownloaded += Object.keys(resolved.attachments).length;
          Object.assign(tableAttachments, resolved.tableAttachments);
        }

        const usedInDir = usedNamesFor(usedFileNames, placement.dir);
        const fileName = uniqueFileName(noteFileName(decoded.title), usedInDir);
        usedInDir.add(fileName);
        const relativeFile = path.posix.join(placement.dir, fileName);

        const filePath = path.join(targetDir, relativeFile);
        await writeFile(filePath, bodyText, "utf-8");
        await applyNoteFileTimes(filePath, record);
        await writeBaseCopy(targetDir, record.recordName, bodyText);
        if (source.sharedZoneOwner) {
          summary.writtenShared += 1;
        } else {
          summary.written += 1;
        }
        if (unpublishableReason) {
          summary.writtenUnpublishable += 1;
        }

        const modificationDate = modificationDateOf(record);

        notes[record.recordName] = {
          file: relativeFile,
          recordChangeTag: record.recordChangeTag ?? "",
          modificationDate,
          sharedZoneOwner: source.sharedZoneOwner,
          unpublishableReason,
          folderRecordName: placement.folderRecordName,
        };
      } finally {
        progress?.onRecordProcessed?.();
      }
    }
  }

  progress?.onProcessComplete?.();

  await writeCloneState(targetDir, {
    account: { appleId: auth.appleId, dsid: auth.dsid },
    syncToken,
    sharedZoneSyncTokens,
    notes,
    folders: layout.stateFolders,
    sharerHomes: layout.stateSharerHomes,
    attachments,
    tableAttachments,
  });

  return summary;
}

/** The per-directory used-names set, created on first use. */
function usedNamesFor(byDir: Map<string, Set<string>>, dir: string): Set<string> {
  let names = byDir.get(dir);
  if (!names) {
    names = new Set();
    byDir.set(dir, names);
  }
  return names;
}
