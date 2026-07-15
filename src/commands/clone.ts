import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureAuthenticated } from "../auth/ensureAuthenticated.js";
import { fetchAllNoteRecords, fetchSharedNoteRecords } from "../cloudkit/databaseClient.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { resolveNoteAttachments, type AttachmentAuth } from "../notes/attachmentSync.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName, uniqueFileName } from "../notes/filename.js";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { combineUnpublishableReasons } from "../notes/unknownContent.js";
import { NotesUnavailableError } from "../errors.js";
import type { SyncProgress } from "../progress.js";
import type { IcloudSession } from "../session.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface CloneSummary {
  written: number;
  writtenShared: number;
  writtenUnpublishable: number;
  attachmentsDownloaded: number;
  skippedDeleted: number;
  skippedUndecodable: number;
}

export async function runClone(
  session: IcloudSession,
  targetDir: string,
  progress?: SyncProgress,
): Promise<CloneSummary> {
  const auth = await ensureAuthenticated(session);
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
  const usedFileNames = new Set<string>();
  const usedAttachmentFileNames = new Set<string>();
  const sharedZoneSyncTokens: Record<string, string> = {};
  const attachmentAuth: AttachmentAuth = { session: auth.session, ckdatabasewsUrl: auth.ckdatabasewsUrl, dsid: auth.dsid };

  const sources: Array<{ records: CloudKitRecord[]; sharedZoneOwner?: string | undefined }> = [{ records }];
  for (const zone of sharedZones) {
    if (zone.zoneID.ownerRecordName && zone.syncToken) {
      sharedZoneSyncTokens[zone.zoneID.ownerRecordName] = zone.syncToken;
    }
    sources.push({ records: zone.records, sharedZoneOwner: zone.zoneID.ownerRecordName });
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

        let bodyText = decoded.bodyText;
        let unpublishableReason = decoded.unpublishableReason;
        if (decoded.attachments.length > 0) {
          const zoneID = source.sharedZoneOwner
            ? { zoneName: PRIVATE_NOTES_ZONE.zoneName, ownerRecordName: source.sharedZoneOwner }
            : PRIVATE_NOTES_ZONE;
          const resolved = await resolveNoteAttachments(
            attachmentAuth,
            source.sharedZoneOwner ? "shared" : "private",
            zoneID,
            targetDir,
            record.recordName,
            decoded.bodyText,
            decoded.attachments,
            attachments,
            usedAttachmentFileNames,
          );
          bodyText = resolved.bodyText;
          unpublishableReason = combineUnpublishableReasons(unpublishableReason, resolved.unpublishableReason);
          Object.assign(attachments, resolved.attachments);
          summary.attachmentsDownloaded += Object.keys(resolved.attachments).length;
        }

        const fileName = uniqueFileName(noteFileName(decoded.title), usedFileNames);
        usedFileNames.add(fileName);

        const filePath = path.join(targetDir, fileName);
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
          file: fileName,
          recordChangeTag: record.recordChangeTag ?? "",
          modificationDate,
          sharedZoneOwner: source.sharedZoneOwner,
          unpublishableReason,
        };
      } finally {
        progress?.onRecordProcessed?.();
      }
    }
  }

  progress?.onProcessComplete?.();

  await writeCloneState(targetDir, { syncToken, sharedZoneSyncTokens, notes, attachments });

  return summary;
}
