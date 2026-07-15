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
import { NotesUnavailableError } from "../errors.js";
import type { IcloudSession } from "../session.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

interface CloneSummary {
  written: number;
  writtenShared: number;
  attachmentsDownloaded: number;
  skippedUnresolvableAttachment: number;
  skippedDeleted: number;
  skippedUndecodable: number;
}

export async function runClone(session: IcloudSession, targetDir: string): Promise<void> {
  const auth = await ensureAuthenticated(session);
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  await mkdir(targetDir, { recursive: true });

  const { records, syncToken } = await fetchAllNoteRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid);
  const sharedZones = await fetchSharedNoteRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid);

  const summary: CloneSummary = {
    written: 0,
    writtenShared: 0,
    attachmentsDownloaded: 0,
    skippedUnresolvableAttachment: 0,
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

  for (const source of sources) {
    for (const record of source.records) {
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
        if (!resolved) {
          summary.skippedUnresolvableAttachment += 1;
          continue;
        }
        bodyText = resolved.bodyText;
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

      const modificationDate = modificationDateOf(record);

      notes[record.recordName] = {
        file: fileName,
        recordChangeTag: record.recordChangeTag ?? "",
        modificationDate,
        sharedZoneOwner: source.sharedZoneOwner,
      };
    }
  }

  await writeCloneState(targetDir, { syncToken, sharedZoneSyncTokens, notes, attachments });

  console.log(
    `Cloned ${summary.written} notes (plus ${summary.writtenShared} shared with you) into ${targetDir}, ` +
      `${summary.attachmentsDownloaded} attachment(s) downloaded`,
  );
  console.log(
    `Skipped: ${summary.skippedDeleted} deleted, ${summary.skippedUndecodable} undecodable, ` +
      `${summary.skippedUnresolvableAttachment} with an attachment we couldn't fetch`,
  );
}
