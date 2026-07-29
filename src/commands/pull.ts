import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import {
  fetchAllNoteRecords,
  fetchSharedNoteRecords,
  lookupRecords,
  type CloudKitRecord,
  type SharedZoneChanges,
} from "../cloudkit/databaseClient.js";
import type { IcloudSession } from "../session.js";
import {
  removeAttachmentsForNote,
  removeTableAttachmentsForNote,
  resolveNoteAttachments,
  type AttachmentAuth,
} from "../notes/attachmentSync.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { isEnoent } from "../fsUtil.js";
import { noteFileName, uniqueFileName } from "../notes/filename.js";
import { joinFrontmatter, splitFrontmatter } from "../notes/frontmatter.js";
import { buildVaultLayout, noteDirOf, placeNote, previousLayoutDirs, type SharedZoneRecords } from "../notes/folderLayout.js";
import { reconcileNotePlacements, removeStaleDirs } from "../notes/folderReconcile.js";
import { hasConflictMarkers, mergeNoteVersions } from "../notes/mergeConflict.js";
import { readBaseCopy, removeBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { localFileState } from "../notes/localFileState.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { recordEpoch } from "../notes/noteEpoch.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { recordVersion } from "../notes/versionHistory.js";
import type { SyncNotice, SyncProgress } from "../progress.js";
import { isPurged } from "./delete.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export type PullNotice = SyncNotice;

/** Which of the ways a pull can touch a local file this change represents.
 * "untrack" is a note left on disk but dropped from tracking (it became
 * unsyncable remotely) - the file stays, the sync relationship goes. */
export type PullChangeKind = "add" | "update" | "merge" | "remove" | "move" | "untrack";

export interface PullChangeRemark {
  /** "conflict": the reader must act, then re-sync (magenta on screen);
   * "unsyncable": content this tool can't sync as-is (black-on-red) -
   * mirroring the plan listing's conflict/refused split. */
  tone: "conflict" | "unsyncable";
  message: string;
}

/** One file-level thing this pull did, in the order it happened - both the
 * human changelist and `--json` consumers read from this. */
export interface PullChange {
  kind: PullChangeKind;
  file: string;
  /** kind "move" only: where the note lived before the remote folder change. */
  previousFile?: string;
  remarks?: PullChangeRemark[];
}

export interface PullSummary {
  added: number;
  updated: number;
  merged: number;
  removed: number;
  attachmentsDownloaded: number;
  unpublishable: number;
  skippedNewUnsyncable: number;
  droppedUnsyncable: number;
  unsharedUntracked: number;
  changes: PullChange[];
  conflicts: string[];
  notices: PullNotice[];
}

/** The per-file counterpart to the whole-vault "N note(s) contain content
 * this tool couldn't fully parse" line this remark replaced: attached to any
 * pulled note carrying an `unpublishableReason`, so the reader learns *which*
 * files came down read-only, not just how many. */
const READ_ONLY_REMARK: PullChangeRemark = {
  tone: "unsyncable",
  message: "read-only: contains content this tool couldn't fully parse",
};

export async function runPull(
  targetDir: string,
  progress?: SyncProgress,
  onLoginStatus?: (message: string) => void,
): Promise<PullSummary> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

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
    state.syncToken,
    onPage,
  );
  const { zones: sharedZones, skippedZones } = await fetchSharedNoteRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    state.sharedZoneSyncTokens ?? {},
    onPage,
  );
  await backfillSharePermissions(auth.session, auth.ckdatabasewsUrl, auth.dsid, state.folders ?? {}, sharedZones);

  const notes: CloneState["notes"] = { ...state.notes };
  const attachments: NonNullable<CloneState["attachments"]> = { ...state.attachments };
  const tableAttachments: NonNullable<CloneState["tableAttachments"]> = { ...state.tableAttachments };
  const trashed: NonNullable<CloneState["trashed"]> = { ...state.trashed };
  // File names are unique per directory; both maps are keyed by the note's
  // vault-root-relative directory ("" for the root).
  const usedFileNames = new Map<string, Set<string>>();
  for (const entry of Object.values(state.notes)) {
    usedNamesFor(usedFileNames, noteDirOf(entry.file)).add(path.posix.basename(entry.file));
  }
  const usedAttachmentFileNames = new Map<string, Set<string>>();
  for (const entry of Object.values(attachments)) {
    // entry.file is "<noteDir>/attachments/<name>" - key by the note dir.
    usedNamesFor(usedAttachmentFileNames, noteDirOf(path.posix.dirname(entry.file))).add(path.posix.basename(entry.file));
  }
  const attachmentAuth: AttachmentAuth = { session: auth.session, ckdatabasewsUrl: auth.ckdatabasewsUrl, dsid: auth.dsid };
  const summary: PullSummary = {
    added: 0,
    updated: 0,
    merged: 0,
    removed: 0,
    attachmentsDownloaded: 0,
    unpublishable: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    unsharedUntracked: 0,
    changes: [],
    conflicts: [],
    notices: [],
  };

  const sources: Array<{ records: CloudKitRecord[]; sharedZoneOwner?: string | undefined }> = [{ records }];
  const sharedZoneSyncTokens: Record<string, string> = {};
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
  // A skipped zone (ZONE_NOT_FOUND on fetch) yielded no new sync token -
  // carry the stored one forward so a zone that turns out to be reachable
  // again later resumes incrementally instead of refetching from scratch.
  for (const skipped of skippedZones) {
    const owner = skipped.zoneID.ownerRecordName;
    const carried = owner ? (state.sharedZoneSyncTokens ?? {})[owner] : undefined;
    if (owner && carried) {
      sharedZoneSyncTokens[owner] = carried;
    }
    summary.notices.push({
      level: "warn",
      message:
        `Skipped a shared zone the server no longer has (owner ${owner ?? "unknown"}, ${skipped.serverErrorCode}) - ` +
        "its share was likely revoked or deleted; its local notes were left in place and stay tracked for now",
    });
  }

  // Rebuild the directory layout from carried state + this run's folder
  // records: new folders (own or shared) materialize as directories, a
  // renamed folder gets a freshly derived directory name, and everything
  // else keeps its name. The record loop below writes content at notes'
  // *current* paths; the reconciliation pass afterwards moves files whose
  // directory no longer matches the tree (remote renames/moves - remote
  // wins) and sweeps out emptied old directories.
  const layout = buildVaultLayout(records, sharedZoneRecords, { folders: state.folders, sharerHomes: state.sharerHomes });
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

        const existing = notes[record.recordName];
        const decoded = classifyNoteRecord(record);

        if (decoded.status === "deleted") {
          // A note this tool soft-deleted stays in the trash registry until
          // the server actually removes it (a real tombstone or Apple's
          // stage-2 `Deleted: 1` mark) - merely sitting in Recently Deleted
          // is exactly the state the registry exists to track, so that
          // doesn't prune. See `CloneState.trashed`.
          if (trashed[record.recordName] && (record.deleted === true || isPurged(record))) {
            delete trashed[record.recordName];
          }
          if (!existing) {
            continue;
          }
          await handleRemoteDeletion(targetDir, record, existing, notes, attachments, tableAttachments, summary);
          continue;
        }

        if (decoded.status === "unsyncable") {
          if (!existing) {
            summary.skippedNewUnsyncable += 1;
            continue;
          }
          await dropUnsyncableNote(targetDir, record, existing, notes, attachments, tableAttachments, summary, decoded.reason);
          continue;
        }

        // decoded.status === "ok"
        // Tracks whether any per-record snapshot below actually wrote
        // something new this run - an epoch is only worth recording when it
        // is (see `recordEpoch` below).
        let recordedNewSnapshot = false;
        const textValue = record.fields.TextDataEncrypted?.value;
        if (typeof textValue === "string") {
          recordedNewSnapshot =
            (await recordVersion(targetDir, {
              recordName: record.recordName,
              recordType: "Note",
              field: "TextDataEncrypted",
              recordChangeTag: record.recordChangeTag ?? "",
              valueBase64: textValue,
            })) || recordedNewSnapshot;
        }

        // Where this note lives: a tracked note stays at its current path
        // (even if its folder membership changed - reconciliation is a
        // later step); a new note is placed by the current folder tree.
        // `folderRecordName` always reflects the *current* membership.
        const placement = placeNote(layout, record, source.sharedZoneOwner);
        const noteDir = existing ? noteDirOf(existing.file) : placement.dir;

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
            usedNamesFor(usedAttachmentFileNames, noteDir),
            noteDir,
          );
          bodyText = resolved.bodyText;
          for (const stale of resolved.staleAttachmentRecordNames) {
            const staleEntry = attachments[stale];
            if (staleEntry) {
              await safeUnlink(path.join(targetDir, staleEntry.file));
            }
            delete attachments[stale];
          }
          Object.assign(attachments, resolved.attachments);
          summary.attachmentsDownloaded += Object.keys(resolved.attachments).length;
          for (const stale of resolved.staleTableAttachmentRecordNames) {
            delete tableAttachments[stale];
          }
          Object.assign(tableAttachments, resolved.tableAttachments);
          for (const tableSnapshot of resolved.tableAttachmentSnapshots) {
            recordedNewSnapshot =
              (await recordVersion(targetDir, {
                recordName: tableSnapshot.recordName,
                recordType: "Attachment",
                field: "MergeableDataEncrypted",
                recordChangeTag: tableSnapshot.recordChangeTag,
                valueBase64: tableSnapshot.valueBase64,
                noteRecordName: tableSnapshot.noteRecordName,
              })) || recordedNewSnapshot;
          }
        }
        if (unpublishableReason) {
          summary.unpublishable += 1;
        }

        // Coordinated whole-note index over everything just captured above,
        // plus the tail of any table's history that didn't change this run -
        // see the "Whole-note coordinated version epochs" investigation.
        // Skipped entirely when nothing changed, matching `recordVersion`'s
        // own no-op-on-unchanged discipline.
        if (recordedNewSnapshot) {
          const associatedRecordNames = [
            record.recordName,
            ...Object.entries(tableAttachments)
              .filter(([, entry]) => entry.noteRecordName === record.recordName)
              .map(([tableRecordName]) => tableRecordName),
          ];
          await recordEpoch(targetDir, record.recordName, associatedRecordNames);
        }

        if (!existing) {
          const usedInDir = usedNamesFor(usedFileNames, noteDir);
          const fileName = uniqueFileName(noteFileName(decoded.title), usedInDir);
          usedInDir.add(fileName);
          const relativeFile = path.posix.join(noteDir, fileName);

          const filePath = path.join(targetDir, relativeFile);
          await writeFile(filePath, bodyText, "utf-8");
          await applyNoteFileTimes(filePath, record);
          await writeBaseCopy(targetDir, record.recordName, bodyText);
          notes[record.recordName] = {
            file: relativeFile,
            recordChangeTag: record.recordChangeTag ?? "",
            modificationDate: modificationDateOf(record),
            sharedZoneOwner: source.sharedZoneOwner,
            unpublishableReason,
            folderRecordName: placement.folderRecordName,
          };
          summary.added += 1;
          summary.changes.push({
            kind: "add",
            file: relativeFile,
            ...(unpublishableReason !== undefined ? { remarks: [READ_ONLY_REMARK] } : {}),
          });
          continue;
        }

        const local = await localFileState(targetDir, existing, record.recordName);
        if (local === "clean" || local === "missing") {
          const filePath = path.join(targetDir, existing.file);
          // Preserve any local-only frontmatter on a clean file (a missing
          // file has none to keep); the base copy stays body-only.
          const frontmatter =
            local === "clean" ? splitFrontmatter(await readFile(filePath, "utf-8")).frontmatter : "";
          await writeFile(filePath, joinFrontmatter(frontmatter, bodyText), "utf-8");
          await applyNoteFileTimes(filePath, record);
          await writeBaseCopy(targetDir, record.recordName, bodyText);
          if (local === "missing") {
            summary.notices.push({ level: "info", message: `Recreated ${existing.file} (was missing locally)` });
          }
          notes[record.recordName] = {
            ...existing,
            recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
            modificationDate: modificationDateOf(record),
            unpublishableReason,
            folderRecordName: placement.folderRecordName,
          };
          summary.updated += 1;
          summary.changes.push({
            kind: "update",
            file: existing.file,
            ...(unpublishableReason !== undefined ? { remarks: [READ_ONLY_REMARK] } : {}),
          });
          continue;
        }

        // local === "modified": real 3-way merge against the base copy.
        const merged = await mergeRemoteChangeIntoLocalFile(targetDir, record.recordName, existing.file, bodyText);
        if (merged.status === "unresolvedMarkers") {
          // Nothing advanced - not the file, not the base copy, not the tag:
          // the remote change stays pending for `push` (which fetches live
          // records) to reconcile once the markers are resolved.
          summary.conflicts.push(
            `${existing.file}: still contains diff3 conflict markers - resolve them, then run "push" to reconcile`,
          );
          summary.changes.push({
            kind: "update",
            file: existing.file,
            remarks: [
              { tone: "conflict", message: 'still contains diff3 conflict markers - resolve them, then run "push" to reconcile' },
            ],
          });
          continue;
        }
        notes[record.recordName] = {
          ...existing,
          recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
          modificationDate: modificationDateOf(record),
          unpublishableReason,
          folderRecordName: placement.folderRecordName,
        };

        if (merged.status === "conflict") {
          summary.conflicts.push(`${existing.file}: merged with conflict markers - resolve manually`);
          summary.changes.push({
            kind: "merge",
            file: existing.file,
            remarks: [
              { tone: "conflict", message: "merged with conflict markers - resolve manually" },
              ...(unpublishableReason !== undefined ? [READ_ONLY_REMARK] : []),
            ],
          });
        } else {
          summary.merged += 1;
          summary.changes.push({
            kind: "merge",
            file: existing.file,
            ...(unpublishableReason !== undefined ? { remarks: [READ_ONLY_REMARK] } : {}),
          });
        }
      } finally {
        progress?.onRecordProcessed?.();
      }
    }
  }

  progress?.onProcessComplete?.();

  // A skipped zone is unreachable, not proven vanished: ZONE_NOT_FOUND on
  // its fetch could be a service-side inconsistency, and untracking every
  // note in it would be destructive if so. Count it as still-live here; a
  // share that's genuinely gone will also drop out of the
  // `changes/database` listing on a later pull and be untracked then.
  await handleVanishedSharedZones(targetDir, [...sharedZones, ...skippedZones], notes, attachments, tableAttachments, summary);

  // Tree reconciliation: move notes (and their attachments) whose directory
  // no longer matches the current layout, then sweep out directories the
  // previous layout used that are now empty.
  const relocations = await reconcileNotePlacements(targetDir, layout, notes, attachments);
  for (const relocation of relocations) {
    summary.changes.push({ kind: "move", file: relocation.to, previousFile: relocation.from });
  }
  await removeStaleDirs(
    targetDir,
    previousLayoutDirs({ folders: state.folders, sharerHomes: state.sharerHomes }),
    new Set(layout.allDirs),
  );

  await writeCloneState(targetDir, {
    account: state.account,
    syncToken,
    sharedZoneSyncTokens,
    // Carried through untouched - omitting this here used to silently wipe
    // the vault's replica identity on every pull, forcing the next push to
    // mint a fresh replica.
    replicaId: state.replicaId,
    notes,
    folders: layout.stateFolders,
    sharerHomes: layout.stateSharerHomes,
    attachments,
    tableAttachments,
    trashed,
  });

  return summary;
}

/**
 * One-time backfill for tracked shared folders with no stored share
 * permission (any vault cloned before the permission field existed): an
 * incremental pull only re-sends *changed* records, so an unchanged
 * `cloudkit.share` record may never arrive again and the permission would
 * stay unknown forever. For each such folder, look up its Folder record (to
 * get the record-level share reference) and then the share record itself,
 * and append both to the zone's record list - `buildVaultLayout` then
 * resolves and stores the permission exactly as if the server had re-sent
 * them. Skipped entirely once every shared folder has a stored permission,
 * so the extra lookups happen once per vault, not once per pull.
 */
async function backfillSharePermissions(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  folders: NonNullable<CloneState["folders"]>,
  sharedZones: SharedZoneChanges[],
): Promise<void> {
  for (const zone of sharedZones) {
    const owner = zone.zoneID.ownerRecordName;
    if (owner === undefined) {
      continue;
    }
    const unknown = Object.entries(folders)
      .filter(([, entry]) => entry.sharedZoneOwner === owner && entry.permission === undefined)
      .map(([recordName]) => recordName);
    if (unknown.length === 0) {
      continue;
    }
    const folderRecords = await lookupRecords(session, ckdatabasewsUrl, dsid, "shared", zone.zoneID, unknown);
    const shareRecordNames = folderRecords
      .map((record) => record.shareRecordName)
      .filter((name): name is string => name !== undefined);
    const shareRecords =
      shareRecordNames.length > 0
        ? await lookupRecords(session, ckdatabasewsUrl, dsid, "shared", zone.zoneID, shareRecordNames)
        : [];
    zone.records.push(...folderRecords, ...shareRecords);
  }
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
  attachments: NonNullable<CloneState["attachments"]>,
  tableAttachments: NonNullable<CloneState["tableAttachments"]>,
  summary: PullSummary,
): Promise<void> {
  const liveOwners = new Set(
    sharedZones.map((zone) => zone.zoneID.ownerRecordName).filter((owner): owner is string => owner !== undefined),
  );

  for (const [recordName, entry] of Object.entries(notes)) {
    if (!entry.sharedZoneOwner || liveOwners.has(entry.sharedZoneOwner)) {
      continue;
    }
    summary.notices.push({
      level: "warn",
      message: `${entry.file}: no longer shared with you - leaving local copy in place but no longer tracking it`,
    });
    delete notes[recordName];
    await removeBaseCopy(targetDir, recordName);
    for (const removed of await removeAttachmentsForNote(targetDir, recordName, attachments)) {
      delete attachments[removed];
    }
    for (const removed of removeTableAttachmentsForNote(recordName, tableAttachments)) {
      delete tableAttachments[removed];
    }
    summary.unsharedUntracked += 1;
  }
}

async function handleRemoteDeletion(
  targetDir: string,
  record: CloudKitRecord,
  existing: CloneStateNoteEntry,
  notes: CloneState["notes"],
  attachments: NonNullable<CloneState["attachments"]>,
  tableAttachments: NonNullable<CloneState["tableAttachments"]>,
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
    for (const removed of await removeAttachmentsForNote(targetDir, record.recordName, attachments)) {
      delete attachments[removed];
    }
    for (const removed of removeTableAttachmentsForNote(record.recordName, tableAttachments)) {
      delete tableAttachments[removed];
    }
    summary.removed += 1;
    summary.changes.push({ kind: "remove", file: existing.file });
    return;
  }

  // A delete/modify conflict is never auto-resolved either direction - merge
  // against an empty remote so the markers show exactly what local kept. The
  // local-only frontmatter is split off first and kept above the markers.
  const base = (await readBaseCopy(targetDir, record.recordName)) ?? "";
  const { frontmatter, body: localContent } = splitFrontmatter(
    await readFile(path.join(targetDir, existing.file), "utf-8"),
  );
  const outcome = mergeNoteVersions(base, localContent, "");

  await writeFile(path.join(targetDir, existing.file), joinFrontmatter(frontmatter, outcome.text), "utf-8");
  summary.conflicts.push(`${existing.file}: deleted remotely, but has local edits - merged with conflict markers, resolve manually`);
  summary.changes.push({
    kind: "update",
    file: existing.file,
    remarks: [{ tone: "conflict", message: "deleted remotely, but has local edits - merged with conflict markers, resolve manually" }],
  });
  // Keep tracking (state entry + base copy) so this doesn't silently drop
  // out of state.json; there's no new recordChangeTag to advance to since
  // the record no longer exists remotely.
}

/**
 * A previously-tracked note that's no longer safely syncable at all -
 * `classifyNoteRecord` returned `"unsyncable"` (a genuine decode failure,
 * e.g. missing text data). Unrecognized *embedded* content no longer lands
 * here - it's written with an unknown-content marker and flagged
 * unpublishable instead, per the Safety Guarantee Audit. Local edits are
 * never discarded silently: a modified file is left in place but reported
 * as a conflict; a clean one is left in place and simply untracked.
 */
async function dropUnsyncableNote(
  targetDir: string,
  record: CloudKitRecord,
  existing: CloneStateNoteEntry,
  notes: CloneState["notes"],
  attachments: NonNullable<CloneState["attachments"]>,
  tableAttachments: NonNullable<CloneState["tableAttachments"]>,
  summary: PullSummary,
  reason: string,
): Promise<void> {
  const local = await localFileState(targetDir, existing, record.recordName);
  if (local === "modified") {
    summary.conflicts.push(
      `${existing.file}: became unsyncable remotely (${reason}), and has local edits - left in place, untracked`,
    );
    summary.changes.push({
      kind: "untrack",
      file: existing.file,
      remarks: [{ tone: "conflict", message: `became unsyncable remotely (${reason}), and has local edits - left in place` }],
    });
  } else {
    summary.droppedUnsyncable += 1;
    if (local === "clean") {
      summary.changes.push({
        kind: "untrack",
        file: existing.file,
        remarks: [{ tone: "unsyncable", message: `no longer syncable remotely (${reason}) - local copy left in place` }],
      });
    }
  }
  delete notes[record.recordName];
  await removeBaseCopy(targetDir, record.recordName);
  for (const removed of await removeAttachmentsForNote(targetDir, record.recordName, attachments)) {
    delete attachments[removed];
  }
  for (const removed of removeTableAttachmentsForNote(record.recordName, tableAttachments)) {
    delete tableAttachments[removed];
  }
}

/**
 * The 3-way merge `pull` runs when a note changed both remotely and locally.
 * The merge runs on the body only; the local-only frontmatter envelope is
 * split off and re-attached above the merged result.
 *
 * State discipline (established by the 2026-07-29 device-in-the-loop
 * experiments, vault dev log, matching push's planRemoteChangedMerge): on a
 * clean merge the base copy holds the *remote* text - the merge ancestor
 * going forward - never the merged result. Writing the merged text made the
 * merged file compare clean, so the local half of the merge silently never
 * uploaded on the next push. On a conflict the base copy stays untouched:
 * it remains the common ancestor until the markers are actually resolved.
 */
export async function mergeRemoteChangeIntoLocalFile(
  targetDir: string,
  recordName: string,
  file: string,
  remoteBodyText: string,
): Promise<{ status: "merged" | "conflict" | "unresolvedMarkers" }> {
  const base = (await readBaseCopy(targetDir, recordName)) ?? "";
  const { frontmatter, body: localContent } = splitFrontmatter(await readFile(path.join(targetDir, file), "utf-8"));
  if (hasConflictMarkers(localContent)) {
    // Diff3 over text that already carries conflict markers nests markers
    // into soup (reproduced live, dev log 2026-07-29). Leave the file, the
    // base copy, and - via the caller - the tracked tag alone: the remote
    // change stays pending, and `push` (which always fetches the live
    // record) reconciles it after the user resolves the markers.
    return { status: "unresolvedMarkers" };
  }
  const outcome = mergeNoteVersions(base, localContent, remoteBodyText);

  await writeFile(path.join(targetDir, file), joinFrontmatter(frontmatter, outcome.text), "utf-8");
  if (!outcome.hasConflict) {
    await writeBaseCopy(targetDir, recordName, remoteBodyText);
  }
  return { status: outcome.hasConflict ? "conflict" : "merged" };
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
