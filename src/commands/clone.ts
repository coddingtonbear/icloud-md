import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindKnownAccount, bindNewFolderAccount } from "../auth/folderAuth.js";
import { fetchAllNoteRecords, fetchSharedNoteRecords } from "../cloudkit/databaseClient.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { resolveNoteAttachments, type AttachmentAuth } from "../notes/attachmentSync.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileNameFor, titleNeedingFrontmatter, uniqueFileName } from "../notes/filename.js";
import { buildVaultLayout, placeNote, type SharedZoneRecords } from "../notes/folderLayout.js";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneState } from "../notes/cloneState.js";
import { composeNoteFile } from "../notes/noteIdFrontmatter.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { AlreadyClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import type { SyncNotice, SyncProgress } from "../progress.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface CloneOptions {
  /**
   * Carry note titles in file names rather than as each note's first line -
   * the Obsidian-shaped layout, where the file name is the document title.
   * Every vault records note ids in frontmatter, which is what makes a
   * rename resolvable at all - and a rename *is* a retitle in this mode.
   */
  filenameAsTitle?: boolean;
  /**
   * Bind to an account already signed in on this machine (Apple ID or dsid)
   * instead of opening an interactive sign-in to discover which one to use.
   * Reuses that account's own trusted profile, so it normally completes with
   * no interaction at all - the difference from the default path is that the
   * caller has *named* the identity, so there is nothing ambiguous to resolve.
   */
  account?: string | undefined;
  /**
   * Never open a sign-in window: fail instead. For unattended callers (CI,
   * cron, the live integration suite), where a window has nobody to complete
   * it and so turns a fast failure into a long block. Only affects the
   * *visible* fallback - a saved session or a headless profile relaunch is
   * still tried, and is what makes an unattended `--account` clone work.
   */
  nonInteractive?: boolean;
}

export interface CloneSummary {
  written: number;
  writtenShared: number;
  writtenUnpublishable: number;
  attachmentsDownloaded: number;
  skippedDeleted: number;
  skippedUndecodable: number;
  notices: SyncNotice[];
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
  options: CloneOptions = {},
): Promise<CloneSummary> {
  if (await readCloneState(targetDir)) {
    throw new AlreadyClonedDirectoryError(targetDir);
  }
  const titleMode = options.filenameAsTitle === true ? "filename" : "in-body";

  const interactive = options.nonInteractive !== true;
  const auth =
    options.account !== undefined && options.account !== ""
      ? await bindKnownAccount(options.account, { onStatus: onLoginStatus, interactive })
      : await bindNewFolderAccount({ onStatus: onLoginStatus, interactive });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  await mkdir(targetDir, { recursive: true });

  progress?.onFetchStart?.();
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
  const { zones: sharedZones, skippedZones } = await fetchSharedNoteRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    {},
    onPage,
  );

  const summary: CloneSummary = {
    written: 0,
    writtenShared: 0,
    writtenUnpublishable: 0,
    attachmentsDownloaded: 0,
    skippedDeleted: 0,
    skippedUndecodable: 0,
    notices: [],
  };
  for (const skipped of skippedZones) {
    summary.notices.push({
      level: "warn",
      message:
        skipped.reason === "zone-not-found"
          ? `Skipped a shared zone the server no longer has (owner ${skipped.zoneID.ownerRecordName ?? "unknown"}, ` +
            `${skipped.serverErrorCode}) - its share was likely revoked or deleted; no notes from it were cloned`
          : `Skipped the shared zone owned by ${skipped.zoneID.ownerRecordName ?? "unknown"}: ` +
            `${skipped.missingRecordNames.length} note(s) came through without their text and looking them up didn't ` +
            "fill it in - no notes from it were cloned; the first pull will retry it",
    });
  }
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

        const decoded = classifyNoteRecord(record, { titleMode });
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
        const fileName = uniqueFileName(noteFileNameFor(decoded.titleLine, titleMode), usedInDir);
        usedInDir.add(fileName);
        const relativeFile = path.posix.join(placement.dir, fileName);

        const filePath = path.join(targetDir, relativeFile);
        // The rare title a file name can't hold is recorded in
        // frontmatter instead; `noteFileNameFor` filed it as "Untitled.md".
        const recordedTitle = titleNeedingFrontmatter(decoded.titleLine, titleMode);
        await writeFile(
          filePath,
          composeNoteFile("", bodyText, record.recordName, recordedTitle),
          "utf-8",
        );
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
          frontmatterTitle: recordedTitle,
        };
      } finally {
        progress?.onRecordProcessed?.();
      }
    }
  }

  progress?.onProcessComplete?.();

  await writeCloneState(targetDir, {
    account: { appleId: auth.appleId, dsid: auth.dsid },
    titleMode,
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
