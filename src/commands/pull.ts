import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  ATTACHMENTS_DIR,
  removeAttachmentsForNote,
  removeTableAttachmentsForNote,
  resolveNoteAttachments,
  untrackAttachmentsForNote,
  type AttachmentAuth,
} from "../notes/attachmentSync.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { isEnoent } from "../fsUtil.js";
import { fileNameCarriesTitle, noteFileNameFor, titleNeedingFrontmatter, uniqueFileName } from "../notes/filename.js";
import { representabilityProblem } from "../notes/titleFilename.js";
import { joinFrontmatter, splitFrontmatter } from "../notes/frontmatter.js";
import { buildVaultLayout, noteDirOf, placeNote, previousLayoutDirs, type SharedZoneRecords } from "../notes/folderLayout.js";
import { reconcileNotePlacements, removeStaleDirs } from "../notes/folderReconcile.js";
import { hasConflictMarkers, mergeNoteVersions } from "../notes/mergeConflict.js";
import { readBaseCopy, removeBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { localFileState, readLocalNote } from "../notes/localFileState.js";
import { writeCloneState, type CloneState, type CloneStateNoteEntry, type TitleMode } from "../notes/cloneState.js";
import { migrationReporter, openVault } from "../notes/vaultMigrations.js";
import { pendingRenameTarget, settlePendingRenames } from "../notes/pendingRename.js";
import { clearNoteId, composeNoteFile, NOTE_TITLE_KEY, readNoteTitle, setNoteTitle } from "../notes/noteIdFrontmatter.js";
import { decodeNoteBodyText } from "../notes/noteText.js";
import { recordEpoch } from "../notes/noteEpoch.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { listVersions, recordVersion } from "../notes/versionHistory.js";
import type { SyncNotice, SyncProgress } from "../progress.js";
import { isPurged } from "./delete.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export type PullNotice = SyncNotice;

/** Which of the ways a pull can touch a local file this change represents.
 * "untrack" is a note left on disk but dropped from tracking (it became
 * unsyncable remotely, or was deleted remotely while it had local edits) -
 * the file stays, the sync relationship goes. */
export type PullChangeKind = "add" | "update" | "merge" | "remove" | "move" | "untrack";

export interface PullChangeRemark {
  /** "conflict": the reader must act, then re-sync (magenta on screen);
   * "unsyncable": content this tool can't sync as-is (black-on-red) -
   * mirroring the plan listing's conflict/refused split; "note": nothing to
   * do, just something that would otherwise be baffling (dim). */
  tone: "conflict" | "unsyncable" | "note";
  message: string;
}

/** One file-level thing this pull did, in the order it happened - both the
 * human changelist and `--json` consumers read from this. */
export interface PullChange {
  kind: PullChangeKind;
  file: string;
  /** Where the note lived before this pull moved it: a remote folder change
   * (kind "move"), or - in a filename-as-title vault - a remote *retitle*,
   * which renames the file and can land on any kind, since the note's
   * content usually changed in the same breath. */
  previousFile?: string;
  /** Set by `--defer-renames`: the path this file should be renamed to, which
   * this pull deliberately did *not* rename it to. The note stays at `file`
   * until a consumer performs it - see `pendingRename.ts`. */
  pendingRename?: string;
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

export interface PullOptions {
  /** Don't rename files a remote retitle wants renamed - record the rename
   * and leave the file alone, for a consumer that can update wikilinks as it
   * goes. See `pendingRename.ts`; a no-op in an in-body vault, which never
   * renames anything. */
  deferRenames?: boolean;
}

export async function runPull(
  targetDir: string,
  progress?: SyncProgress,
  onLoginStatus?: (message: string) => void,
  options: PullOptions = {},
): Promise<PullSummary> {
  const state = await openVault(targetDir, migrationReporter(onLoginStatus));
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }
  const titleMode = state.titleMode === "filename" ? "filename" : "in-body";
  const deferRenames = options.deferRenames === true;

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
  const { records, syncToken, resyncedFromScratch } = await fetchAllNoteRecords(
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
  // Before anything reads a tracked path: pick up renames a `--defer-renames`
  // consumer has since carried out, and - unless this run is deferring too -
  // finish the ones nobody got to. A plain `pull` is how a vault left holding
  // a rename forever gets unstuck.
  const settled = await settlePendingRenames(targetDir, notes, { perform: !deferRenames, titleMode });
  // File names are unique per directory; both maps are keyed by the note's
  // vault-root-relative directory ("" for the root). A name a deferred rename
  // is holding counts as taken: the file isn't there yet, but it is spoken
  // for, and handing it to another note would strand the rename.
  const usedFileNames = new Map<string, Set<string>>();
  for (const entry of Object.values(notes)) {
    usedNamesFor(usedFileNames, noteDirOf(entry.file)).add(path.posix.basename(entry.file));
    const pending = pendingRenameTarget(entry);
    if (pending !== undefined) {
      usedNamesFor(usedFileNames, noteDirOf(pending)).add(path.posix.basename(pending));
    }
  }
  const usedAttachmentFileNames = new Map<string, Set<string>>();
  for (const entry of Object.values(attachments)) {
    // entry.file is "<noteDir>/attachments/<name>" - key by the note dir.
    usedNamesFor(usedAttachmentFileNames, noteDirOf(path.posix.dirname(entry.file))).add(path.posix.basename(entry.file));
  }
  // Directories whose `attachments/` listing has been folded into the map
  // above - see `usedAttachmentNamesFor`.
  const scannedAttachmentDirs = new Set<string>();
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
  for (const done of settled.performed) {
    summary.changes.push({ kind: "move", file: done.to, previousFile: done.from });
  }
  for (const stuck of settled.blocked) {
    summary.notices.push({
      level: "warn",
      message: `Couldn't rename ${stuck.file} to ${stuck.to}: something else is already there. The rename stays pending.`,
    });
  }

  const sources: Array<{ records: CloudKitRecord[]; sharedZoneOwner?: string | undefined; resynced: boolean }> = [
    { records, resynced: resyncedFromScratch },
  ];
  const sharedZoneSyncTokens: Record<string, string> = {};
  const sharedZoneRecords: SharedZoneRecords[] = [];
  for (const zone of sharedZones) {
    if (zone.zoneID.ownerRecordName && zone.syncToken) {
      sharedZoneSyncTokens[zone.zoneID.ownerRecordName] = zone.syncToken;
    }
    if (zone.zoneID.ownerRecordName) {
      sharedZoneRecords.push({ ownerRecordName: zone.zoneID.ownerRecordName, records: zone.records });
    }
    sources.push({ records: zone.records, sharedZoneOwner: zone.zoneID.ownerRecordName, resynced: zone.resyncedFromScratch });
  }
  // A skipped zone yielded no new sync token - carry the stored one forward
  // so the zone resumes incrementally on a later pull instead of refetching
  // from scratch (and, for a missing-bodies skip, so the records that didn't
  // come through complete are re-delivered rather than lost to an advanced
  // token).
  for (const skipped of skippedZones) {
    const owner = skipped.zoneID.ownerRecordName;
    const carried = owner ? (state.sharedZoneSyncTokens ?? {})[owner] : undefined;
    if (owner && carried) {
      sharedZoneSyncTokens[owner] = carried;
    }
    summary.notices.push({
      level: "warn",
      message:
        skipped.reason === "zone-not-found"
          ? `Skipped a shared zone the server no longer has (owner ${owner ?? "unknown"}, ${skipped.serverErrorCode}) - ` +
            "its share was likely revoked or deleted; its local notes were left in place and stay tracked for now"
          : `Skipped the shared zone owned by ${owner ?? "unknown"} this run: ${skipped.missingRecordNames.length} ` +
            "note(s) came through without their text and looking them up didn't fill it in - nothing from that zone " +
            "was touched, and the next pull will retry it",
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

        // A resynced zone re-delivers *every* record, changed or not. One
        // whose change tag still matches what this vault last synced hasn't
        // moved remotely - skip it, exactly as an incremental fetch would
        // have by never sending it. (A record with local-only edits is
        // untouched either way: not rewriting it here is what an incremental
        // pull already does, and `push` picks the edits up as usual.)
        if (source.resynced && existing !== undefined && record.recordChangeTag !== undefined && record.recordChangeTag === existing.recordChangeTag) {
          continue;
        }

        const decoded = classifyNoteRecord(record, { titleMode });

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
          await handleRemoteDeletion(targetDir, record, existing, notes, attachments, tableAttachments, summary, titleMode);
          continue;
        }

        if (decoded.status === "unsyncable") {
          // A record delivered without its body says nothing durable about
          // the note - only that this run didn't get its text (shared-zone
          // listings omit bodies; a lookup backfill can fail). Untracking on
          // it would sever the sync relationship over a transient gap, so a
          // tracked note is left exactly as it is; the shared-database fetch
          // already holds back whole zones with missing bodies, so this is
          // the last line of defense, not the usual path.
          if (decoded.reason === "missing-body") {
            if (existing) {
              summary.notices.push({
                level: "warn",
                message: `${existing.file}: the server sent this note without its text this run - left unchanged and still tracked`,
              });
            } else {
              summary.skippedNewUnsyncable += 1;
            }
            continue;
          }
          if (!existing) {
            summary.skippedNewUnsyncable += 1;
            continue;
          }
          await dropUnsyncableNote(targetDir, record, existing, notes, attachments, tableAttachments, summary, decoded.reason, titleMode);
          continue;
        }

        // decoded.status === "ok"
        // The rare note whose title a file name genuinely can't hold: it is
        // filed as "Untitled.md" and its real title recorded in
        // frontmatter. Undefined for everything else, which is what
        // *removes* the key from a note that has just been retitled to
        // something a name can carry after all.
        const recordedTitle = titleNeedingFrontmatter(decoded.titleLine, titleMode);
        // The changelist line already shows the "Untitled.md" this landed at,
        // which is baffling on its own - the note isn't untitled. Say where
        // its real title went, and why it had to go there.
        const titleRemarks: PullChangeRemark[] =
          recordedTitle === undefined
            ? []
            : [
                {
                  tone: "note",
                  message:
                    `title kept in ${NOTE_TITLE_KEY}: ` +
                    `${representabilityProblem(recordedTitle) ?? "a file name can't carry it"}`,
                },
              ];
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
            await usedAttachmentNamesFor(targetDir, usedAttachmentFileNames, scannedAttachmentDirs, noteDir),
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
          const fileName = uniqueFileName(noteFileNameFor(decoded.titleLine, titleMode), usedInDir);
          usedInDir.add(fileName);
          const relativeFile = path.posix.join(noteDir, fileName);

          const filePath = path.join(targetDir, relativeFile);
          await writeFile(
            filePath,
            composeNoteFile("", bodyText, record.recordName, recordedTitle),
            "utf-8",
          );
          await applyNoteFileTimes(filePath, record);
          await writeBaseCopy(targetDir, record.recordName, bodyText);
          notes[record.recordName] = {
            file: relativeFile,
            recordChangeTag: record.recordChangeTag ?? "",
            modificationDate: modificationDateOf(record),
            sharedZoneOwner: source.sharedZoneOwner,
            unpublishableReason,
            folderRecordName: placement.folderRecordName,
            frontmatterTitle: recordedTitle,
          };
          summary.added += 1;
          summary.changes.push({
            kind: "add",
            file: relativeFile,
            ...remarksFor(titleRemarks, unpublishableReason),
          });
          continue;
        }

        const local = await localFileState(targetDir, existing, record.recordName, titleMode);

        // A remote retitle has to rename the file, because in this vault the
        // file name is the only place the title lives. Leaving it stale
        // isn't cosmetic: push reads a *renamed* file's name as the user's
        // new title, so a name that silently disagrees with the note is a
        // retitle waiting to be reverted by whoever next touches the file.
        // Deliberately after `localFileState`, which reads the old path.
        const { file, pendingRename } = await renameForRemoteTitle(targetDir, existing.file, decoded.titleLine, titleMode, {
          usedFileNames,
          onDisk: local !== "missing",
          defer: deferRenames,
        });
        const previousFile = file === existing.file ? undefined : { previousFile: existing.file };
        // Every branch below rewrites this note's entry, so `pendingRename`
        // is set unconditionally rather than carried through `...existing`:
        // undefined is the answer that *clears* a rename that has since been
        // performed or overtaken by a newer title.
        const renameFields = { pendingRename };
        const deferred =
          pendingRename === undefined ? {} : { pendingRename: path.posix.join(noteDirOf(file), pendingRename) };
        const deferredRemarks: PullChangeRemark[] =
          pendingRename === undefined
            ? []
            : [{ tone: "note", message: `rename deferred: this file should become "${pendingRename}"` }];
        const infoRemarks: PullChangeRemark[] = [...titleRemarks, ...deferredRemarks];

        if (local === "clean" || local === "missing") {
          const filePath = path.join(targetDir, file);
          // Preserve any local-only frontmatter on a clean file (a missing
          // file has none to keep); the base copy stays body-only.
          const frontmatter =
            local === "clean"
              ? splitFrontmatter(await readFile(filePath, "utf-8"), { filenameAsTitle: titleMode === "filename" }).frontmatter
              : "";
          // Also the self-healing path for an id: a file whose envelope was
          // stripped (by hand, or by an older build's `restore`) gets it back
          // the next time the note changes remotely.
          await writeFile(
            filePath,
            composeNoteFile(frontmatter, bodyText, record.recordName, recordedTitle),
            "utf-8",
          );
          await applyNoteFileTimes(filePath, record);
          await writeBaseCopy(targetDir, record.recordName, bodyText);
          if (local === "missing") {
            summary.notices.push({ level: "info", message: `Recreated ${file} (was missing locally)` });
          }
          notes[record.recordName] = {
            ...existing,
            file,
            recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
            modificationDate: modificationDateOf(record),
            unpublishableReason,
            folderRecordName: placement.folderRecordName,
            frontmatterTitle: recordedTitle,
            ...renameFields,
          };
          summary.updated += 1;
          summary.changes.push({
            kind: "update",
            file,
            ...previousFile,
            ...deferred,
            ...remarksFor(infoRemarks, unpublishableReason),
          });
          continue;
        }

        // local === "modified": real 3-way merge against the base copy.
        const merged = await mergeRemoteChangeIntoLocalFile(
          targetDir,
          record.recordName,
          file,
          bodyText,
          recordedTitle,
          titleMode,
        );
        if (merged.status === "unresolvedMarkers") {
          // No *sync* state advanced - not the content, not the base copy,
          // not the tag: the remote change stays pending for `push` (which
          // fetches live records) to reconcile once the markers are
          // resolved. The tracked path is not sync state, though, and a
          // retitle has already moved the file: leaving the old path
          // recorded would read as "missing" on the next pull and recreate
          // the note beside itself.
          notes[record.recordName] = { ...existing, file, ...renameFields };
          summary.conflicts.push(
            `${file}: still contains diff3 conflict markers - resolve them, then run "push" to reconcile`,
          );
          summary.changes.push({
            kind: "update",
            file,
            ...previousFile,
            ...deferred,
            remarks: [
              { tone: "conflict", message: 'still contains diff3 conflict markers - resolve them, then run "push" to reconcile' },
              ...deferredRemarks,
            ],
          });
          continue;
        }
        notes[record.recordName] = {
          ...existing,
          file,
          recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
          modificationDate: modificationDateOf(record),
          unpublishableReason,
          folderRecordName: placement.folderRecordName,
          frontmatterTitle: recordedTitle,
          ...renameFields,
        };

        if (merged.status === "conflict") {
          summary.conflicts.push(`${file}: merged with conflict markers - resolve manually`);
          summary.changes.push({
            kind: "merge",
            file,
            ...previousFile,
            ...deferred,
            remarks: [
              { tone: "conflict", message: "merged with conflict markers - resolve manually" },
              ...infoRemarks,
              ...(unpublishableReason !== undefined ? [READ_ONLY_REMARK] : []),
            ],
          });
        } else {
          summary.merged += 1;
          summary.changes.push({
            kind: "merge",
            file,
            ...previousFile,
            ...deferred,
            ...remarksFor(infoRemarks, unpublishableReason),
          });
        }
      } finally {
        progress?.onRecordProcessed?.();
      }
    }
  }

  progress?.onProcessComplete?.();

  // A zone that was resynced from scratch (its stored sync token rejected -
  // see `fetchZoneNoteRecords`) delivered a complete listing rather than a
  // delta, and a full listing carries no tombstones: whatever was deleted
  // remotely while the token was unusable simply isn't in it. Reconcile by
  // absence, zone by zone, so those deletions aren't silently missed forever.
  for (const source of sources) {
    if (!source.resynced) {
      continue;
    }
    const removed = await reconcileNotesAfterResync(
      targetDir,
      source.sharedZoneOwner,
      new Set(source.records.map((record) => record.recordName)),
      notes,
      attachments,
      tableAttachments,
      summary,
      titleMode,
    );
    const zoneLabel = source.sharedZoneOwner === undefined ? "this vault's own notes" : `the notes shared by ${source.sharedZoneOwner}`;
    summary.notices.push({
      level: "warn",
      message:
        `iCloud no longer accepted the stored sync token for ${zoneLabel}, so they were resynced from scratch` +
        (removed > 0 ? ` - ${removed} note(s) deleted remotely in the meantime were reconciled` : ""),
    });
  }

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
    titleMode: state.titleMode,
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

/**
 * Renames a tracked note's file when the note's title changed remotely and
 * this vault carries titles in file names, returning the path it now lives
 * at (unchanged in every other case).
 *
 * The known cost, accepted when the mode was designed: a rename performed
 * outside Obsidian doesn't trigger its link updating, so wikilinks pointing
 * at a remotely-retitled note go stale. `context.defer` is `--defer-renames`,
 * which hands the rename to a consumer that can do better: the file stays
 * where it is and the target name comes back as `pendingRename` for the
 * caller to record. Deferring only applies to a file that's actually there -
 * a missing note is recreated further down, and recreating it under a title
 * it no longer has would be a rename nobody could complete.
 *
 * The new name is resolved against both the names this run has claimed and
 * what is actually on disk. Tracked names alone aren't enough here the way
 * they are for a brand-new note: this writes over an existing directory, and
 * an untracked file the user put there themselves must not be destroyed by
 * a rename landing on top of it.
 */
export async function renameForRemoteTitle(
  targetDir: string,
  currentFile: string,
  titleLine: string,
  titleMode: "in-body" | "filename",
  context: { usedFileNames: Map<string, Set<string>>; onDisk: boolean; defer?: boolean },
): Promise<{ file: string; pendingRename?: string | undefined }> {
  const currentName = path.posix.basename(currentFile);
  if (titleMode !== "filename" || fileNameCarriesTitle(currentName, titleLine)) {
    return { file: currentFile };
  }
  const defer = context.defer === true && context.onDisk;

  const dir = noteDirOf(currentFile);
  const usedInDir = usedNamesFor(context.usedFileNames, dir);
  // The note's own name is in the set (it was seeded from tracked state);
  // leaving it there would make every candidate collide with the file being
  // renamed away from.
  usedInDir.delete(currentName);

  let wanted = uniqueFileName(noteFileNameFor(titleLine, titleMode), usedInDir);
  while (await fileExists(path.join(targetDir, dir, wanted))) {
    usedInDir.add(wanted);
    wanted = uniqueFileName(noteFileNameFor(titleLine, titleMode), usedInDir);
  }
  usedInDir.add(wanted);

  if (defer) {
    // The old name is still occupied - by this very file, which isn't going
    // anywhere this run - so it goes back in the pool of taken names.
    usedInDir.add(currentName);
    return { file: currentFile, pendingRename: wanted };
  }

  const newFile = path.posix.join(dir, wanted);
  if (context.onDisk) {
    await rename(path.join(targetDir, currentFile), path.join(targetDir, newFile));
  }
  return { file: newFile };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (cause) {
    if (isEnoent(cause)) {
      return false;
    }
    throw cause;
  }
}

/** The remarks a change carries, or nothing at all - the field stays absent
 * rather than an empty array, which is what every `--json` consumer written
 * against the old shape expects. */
function remarksFor(leading: PullChangeRemark[], unpublishableReason: string | undefined): { remarks?: PullChangeRemark[] } {
  const remarks = [...leading, ...(unpublishableReason !== undefined ? [READ_ONLY_REMARK] : [])];
  return remarks.length > 0 ? { remarks } : {};
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
 * The attachment file names taken next to notes in `noteDir`: every tracked
 * attachment there, plus - listed once per directory per pull - whatever is
 * actually sitting in its `attachments/` directory. Tracked names alone
 * aren't enough, because not every file there is tracked: a note kept after
 * a remote deletion leaves its attachment files behind with their tracking
 * dropped, and `uniqueFileName` never looks at the disk, so a later download
 * of a same-named attachment (`image.png` is the usual one) would be written
 * right over the last copy.
 */
export async function usedAttachmentNamesFor(
  targetDir: string,
  byDir: Map<string, Set<string>>,
  scannedDirs: Set<string>,
  noteDir: string,
): Promise<Set<string>> {
  const names = usedNamesFor(byDir, noteDir);
  if (!scannedDirs.has(noteDir)) {
    scannedDirs.add(noteDir);
    let onDisk: string[] = [];
    try {
      onDisk = await readdir(path.join(targetDir, noteDir, ATTACHMENTS_DIR));
    } catch (cause) {
      if (!isEnoent(cause)) {
        throw cause;
      }
    }
    for (const name of onDisk) {
      names.add(name);
    }
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

/**
 * Applies the deletions a from-scratch resync can only reveal by absence: a
 * note tracked to this zone (`sharedZoneOwner` `undefined` = the private
 * zone) whose record appears nowhere in the zone's complete listing no
 * longer exists remotely, and goes through the same remote-deletion handling
 * a tombstone would have driven - a clean local copy is removed, one with
 * local edits stays on disk, untracked, as a new note for the next push.
 *
 * `seenRecordNames` must come from the *complete* listing, every record type
 * included: matching on Note records alone would misread a record whose type
 * changed (e.g. a note that got password-protected) as a deletion. And it
 * must only ever be called for a zone whose full walk actually completed -
 * absence from a partial listing proves nothing.
 */
export async function reconcileNotesAfterResync(
  targetDir: string,
  sharedZoneOwner: string | undefined,
  seenRecordNames: ReadonlySet<string>,
  notes: CloneState["notes"],
  attachments: NonNullable<CloneState["attachments"]>,
  tableAttachments: NonNullable<CloneState["tableAttachments"]>,
  summary: PullSummary,
  titleMode: TitleMode,
): Promise<number> {
  let removed = 0;
  for (const [recordName, entry] of Object.entries(notes)) {
    if (entry.sharedZoneOwner !== sharedZoneOwner || seenRecordNames.has(recordName)) {
      continue;
    }
    const tombstone: CloudKitRecord = { recordName, recordType: "Note", fields: {}, deleted: true };
    await handleRemoteDeletion(targetDir, tombstone, entry, notes, attachments, tableAttachments, summary, titleMode);
    removed += 1;
  }
  return removed;
}

async function handleRemoteDeletion(
  targetDir: string,
  record: CloudKitRecord,
  existing: CloneStateNoteEntry,
  notes: CloneState["notes"],
  attachments: NonNullable<CloneState["attachments"]>,
  tableAttachments: NonNullable<CloneState["tableAttachments"]>,
  summary: PullSummary,
  titleMode: TitleMode,
): Promise<void> {
  const local = await readLocalNote(targetDir, existing, record.recordName, titleMode);

  if (local.status !== "modified") {
    // "clean" or "missing": nothing local worth protecting.
    if (local.status === "clean") {
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

  // Local edits to a note deleted elsewhere are kept as a *new* note: the file
  // stays, edits and all, but stops being tracked and loses its
  // `apple-note-id`, so the next push creates it. Keeping it tracked behind
  // delete/modify conflict markers (what this used to do) left it stuck for
  // good - push can't update a record that no longer exists, and no later
  // pull ever delivers that record again to settle it. Its attachment files
  // stay on disk too, since the kept text still points at them and the
  // remote copies are gone; only their tracking goes. (Nothing reserves
  // their names once they're untracked except the files themselves - see
  // `usedAttachmentNamesFor`.)
  //
  // "modified" also covers a note whose base copy is missing, where there's
  // no telling whether it was edited at all. Keeping it is still the side to
  // err on - a note the user deleted on purpose comes back, which they can
  // see and undo, rather than edits they made going away - but the remark
  // says it was a guess.
  const baseMissing = (await readBaseCopy(targetDir, record.recordName)) === undefined;
  const keptTitle = await titleToKeep(targetDir, existing.file, record.recordName, local.frontmatter, titleMode);
  const frontmatter = clearNoteId(local.frontmatter);
  await writeFile(
    path.join(targetDir, existing.file),
    joinFrontmatter(keptTitle === undefined ? frontmatter : setNoteTitle(frontmatter, keptTitle), local.body),
    "utf-8",
  );
  delete notes[record.recordName];
  await removeBaseCopy(targetDir, record.recordName);
  for (const removed of untrackAttachmentsForNote(record.recordName, attachments)) {
    delete attachments[removed];
  }
  for (const removed of removeTableAttachmentsForNote(record.recordName, tableAttachments)) {
    delete tableAttachments[removed];
  }
  const why = baseMissing
    ? "deleted on another device, and its last synced copy is missing, so it may have local edits"
    : "deleted on another device, but has local edits";
  // A note in someone else's area can only be created again inside one of
  // their shared folders that's writable - a note shared on its own, or one
  // in a read-only folder, gets push's create refusal instead, and the way
  // out is moving it into one of the user's own folders.
  const next =
    existing.sharedZoneOwner === undefined
      ? "the next push creates it - delete the file first if you don't want it back"
      : "the next push creates it again in the shared folder if you can write to it (otherwise move it into one of your own folders) - delete the file first if you don't want it back";
  summary.changes.push({
    kind: "untrack",
    file: existing.file,
    remarks: [{ tone: "note", message: `${why} - kept as a new note; ${next}` }],
  });
}

/**
 * The title a kept note should be created under, when its file name alone
 * would get it wrong: under filename-as-title, pull's collision uniquifier
 * can have put "Groceries" at "Groceries 2.md", and once the note is
 * untracked push takes a new note's title from its file name. Push's move
 * and retitle paths compare against the tracked path to avoid exactly this;
 * a create has no tracked path, so the title has to travel in
 * `apple-note-title` instead.
 *
 * The note's real title is the first line of the last version pull saw,
 * from its version history. Undefined - the file name is right, or there's
 * no history to tell - leaves the frontmatter as it was; an
 * `apple-note-title` already there wins too, since push reads it first.
 */
async function titleToKeep(
  targetDir: string,
  file: string,
  recordName: string,
  frontmatter: string,
  titleMode: TitleMode,
): Promise<string | undefined> {
  if (titleMode !== "filename" || readNoteTitle(frontmatter) !== undefined) {
    return undefined;
  }
  const last = (await listVersions(targetDir, recordName))
    .filter((snapshot) => snapshot.recordType === "Note" && snapshot.field === "TextDataEncrypted")
    .at(-1);
  if (last === undefined) {
    return undefined;
  }
  let titleLine: string;
  try {
    titleLine = decodeNoteBodyText(Buffer.from(last.valueBase64, "base64")).split(/\r\n?|\n/)[0] ?? "";
  } catch {
    return undefined;
  }
  const fileName = path.posix.basename(file);
  return fileName !== noteFileNameFor(titleLine, titleMode) && fileNameCarriesTitle(fileName, titleLine)
    ? titleLine
    : undefined;
}

/**
 * A previously-tracked note that's no longer safely syncable at all -
 * `classifyNoteRecord` returned `"unsyncable"` with reason `"undecodable"`:
 * body bytes are present but don't parse, a durable fact about the record. A
 * record merely *missing* its body never lands here (that's a delivery gap,
 * handled above by leaving the note tracked), and neither does unrecognized
 * *embedded* content - that's written with an unknown-content marker and
 * flagged unpublishable instead, per the Safety Guarantee Audit. Local edits
 * are never discarded silently: a modified file is left in place but
 * reported as a conflict; a clean one is left in place and simply untracked.
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
  titleMode: TitleMode,
): Promise<void> {
  const local = await localFileState(targetDir, existing, record.recordName, titleMode);
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
  unrepresentableTitle?: string | undefined,
  titleMode: TitleMode = "in-body",
): Promise<{ status: "merged" | "conflict" | "unresolvedMarkers" }> {
  const base = (await readBaseCopy(targetDir, recordName)) ?? "";
  const { frontmatter, body: localContent } = splitFrontmatter(await readFile(path.join(targetDir, file), "utf-8"), {
    filenameAsTitle: titleMode === "filename",
  });
  if (hasConflictMarkers(localContent)) {
    // Diff3 over text that already carries conflict markers nests markers
    // into soup (reproduced live, dev log 2026-07-29). Leave the file, the
    // base copy, and - via the caller - the tracked tag alone: the remote
    // change stays pending, and `push` (which always fetches the live
    // record) reconciles it after the user resolves the markers.
    return { status: "unresolvedMarkers" };
  }
  const outcome = mergeNoteVersions(base, localContent, remoteBodyText);

  await writeFile(
    path.join(targetDir, file),
    composeNoteFile(frontmatter, outcome.text, recordName, unrepresentableTitle),
    "utf-8",
  );
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
