import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import type { IcloudSession } from "../session.js";
import {
  createNoteRecord,
  lookupRecords,
  noteZone,
  updateNoteRecord,
  updateRecords,
  type CloudKitRecord,
  type NoteZone,
  type RecordUpdate,
} from "../cloudkit/databaseClient.js";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { classifyNoteRecord, type NoteDecodeResult } from "../notes/decodeNoteRecord.js";
import { CorruptStateFileError, NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { buildNoteCreateFields, buildNoteMoveFields, buildNoteTrashFields, buildNoteUpdateFields } from "../notes/encodeNoteRecord.js";
import { noteDirOf, stateDirIndex } from "../notes/folderLayout.js";
import { planEmbedRepresentations } from "../notes/embedPushEdit.js";
import { isEnoent } from "../fsUtil.js";
import { mergeNoteVersions } from "../notes/mergeConflict.js";
import { decodeNoteEmbedSlots, hasAttachmentReference, OBJECT_REPLACEMENT_CHARACTER, type EmbedSlot } from "../notes/noteAttachments.js";
import { hasEmbedMarker, hasUnknownContentMarker } from "../notes/unknownContent.js";
import { localFileState } from "../notes/localFileState.js";
import { recordEpoch } from "../notes/noteEpoch.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { renderPlan, stripFilePrefix, type PlanEntry } from "../notes/pushPlan.js";
import { compressNoteDocument, decodeNoteBodyText, decompressNoteDocument } from "../notes/noteText.js";
import { prepareTableAttachmentUpdate } from "../notes/tablePushEdit.js";
import { historyRecordNames } from "../notes/trackedFile.js";
import { recordVersion } from "../notes/versionHistory.js";
import { applyLocalNoteDeletion, isInTrash, isPurged, rememberTrashedNote } from "./delete.js";
import {
  applyTextEdit,
  buildInitialNoteDocument,
  computeSplice,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
} from "../notes/noteDocument.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

/**
 * Why an edit to this tracked shared note can't be pushed, or undefined
 * when it can. Notes *inside* a shared folder are editable when the share's
 * stored permission allows it (unknown permission - e.g. state written
 * before the permission field existed - is attempted and left to the
 * server, whose rejection is benign); individually-shared notes loose in a
 * sharer's home stay read-only - probably the same wire shape, but unproven,
 * and their per-note share permission isn't tracked. Exported for `revert`,
 * which is the same kind of remote write and applies the same policy.
 */
export function sharedNoteWriteRefusal(state: CloneState, entry: CloneStateNoteEntry): string | undefined {
  if (entry.sharedZoneOwner === undefined) {
    return undefined;
  }
  const folder = entry.folderRecordName !== undefined ? state.folders?.[entry.folderRecordName] : undefined;
  if (folder === undefined || folder.sharedZoneOwner !== entry.sharedZoneOwner) {
    return "individually-shared notes can't be edited yet - only notes inside a shared folder can";
  }
  if (folder.permission === "READ_ONLY") {
    return "this shared folder is read-only for you - the server would reject the edit";
  }
  return undefined;
}

export interface PushOptions {
  /** Report what would be pushed without sending anything or touching state. */
  dryRun?: boolean;
  /** Routes any headless-recovery login status messages; defaults to staying silent (see `resolveFolderAccount`). */
  onLoginStatus?: (message: string) => void;
  /** Presentation hook: re-express vault-root-relative paths for display
   * (the CLI passes cwd-relativization). Defaults to identity. */
  formatPath?: (file: string) => string;
}

interface PushCandidate {
  recordName: string;
  entry: CloneStateNoteEntry;
  localText: string;
}

interface PushSummary {
  conflicts: string[];
  refused: string[];
}

type OkNoteRecordResult = Extract<NoteDecodeResult, { status: "ok" }>;

/** What one candidate resolves to before any network write: the record
 * update(s) to submit atomically, plus which of them is the Note record's
 * own text (if any) - needed after a successful push to update local
 * state/file-time metadata the same way the plain-text-only path always did. */
interface PreparedCandidate {
  updates: RecordUpdate[];
  noteTextUpdated: boolean;
}

/** A `PlanEntry` plus (for anything `buildPushPlan` can actually act on) the
 * closure that does so. `status` only ever reads the `PlanEntry` fields;
 * `push` additionally invokes `execute` for every entry that has one. The
 * closure's return value is the *actual* outcome (a live write can still be
 * rejected after planning said "ready") - callers must use it rather than
 * the entry's `resolution` to decide whether something genuinely happened. */
export interface ExecutablePlanEntry extends PlanEntry {
  execute?: () => Promise<boolean>;
}

export interface BuildPushPlanResult {
  state: CloneState;
  entries: ExecutablePlanEntry[];
}

/**
 * Classifies every locally-relevant file into a create/update/delete plan
 * entry, running every live (network) check the way `push --dry-run` always
 * has - staleness, round-trip, attachment safety - without submitting any
 * write. Shared by `runPush` (which additionally executes the `ready`
 * entries) and `runStatus` (which only renders), so the two can't drift
 * apart - see the "Push becomes the full reconciler" project notes.
 *
 * Login/network access is skipped entirely when there's nothing that needs
 * it (no tracked note is missing or modified, and no untracked file passed
 * the local creation gates).
 */
export async function buildPushPlan(
  targetDir: string,
  options: { onLoginStatus?: ((message: string) => void) | undefined } = {},
): Promise<BuildPushPlanResult> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const entries: ExecutablePlanEntry[] = [];
  const dirIndex = stateDirIndex(state);

  const untracked: { file: string; localText: string }[] = [];
  for (const file of await listUntrackedMarkdownFiles(targetDir, state)) {
    untracked.push({ file, localText: await readFile(path.join(targetDir, file), "utf-8") });
  }

  const updateCandidates: PushCandidate[] = [];
  const missingCandidates: { recordName: string; entry: CloneStateNoteEntry }[] = [];

  for (const [recordName, entry] of Object.entries(state.notes)) {
    const fileState = await localFileState(targetDir, entry, recordName);
    if (fileState === "clean") {
      continue;
    }
    if (fileState === "missing") {
      missingCandidates.push({ recordName, entry });
      continue;
    }

    const localText = await readFile(path.join(targetDir, entry.file), "utf-8");

    const sharedRefusal = sharedNoteWriteRefusal(state, entry);
    if (sharedRefusal !== undefined) {
      entries.push({ kind: "update", file: entry.file, resolution: "refused", reason: sharedRefusal });
      continue;
    }
    if (hasConflictMarkers(localText)) {
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "conflict",
        reason: "still contains diff3 conflict markers - resolve them before pushing",
      });
      continue;
    }
    if (localText === "") {
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "refused",
        reason: "pushing a fully emptied note isn't supported yet - edit it in Notes instead",
      });
      continue;
    }
    if (hasUnknownContentMarker(localText)) {
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "refused",
        reason:
          "this note contains content this tool can't parse and can never be pushed - " +
          `run "icloud-notes restore ${entry.file}" to discard your local edit.`,
      });
      continue;
    }
    // A note that doesn't already have a tracked attachment but whose text
    // now contains an "attachments/..." reference was hand-typed (or
    // copy-pasted), not produced by `clone`/`pull` - there's no real file to
    // upload behind it. A note that *does* already have a tracked attachment
    // is caught more specifically below, once we have the remote record to
    // point at. Table attachments aren't tracked in state.attachments at all
    // (see `attachmentSync.ts`), so this check never fires for them.
    const notePreviouslyHadAttachments = Object.values(state.attachments ?? {}).some(
      (attachment) => attachment.noteRecordName === recordName,
    );
    if (!notePreviouslyHadAttachments && hasAttachmentReference(localText)) {
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "refused",
        reason:
          'contains an "attachments/..." reference, but this tool can\'t upload new attachments - ' +
          `remove it, or run "icloud-notes restore ${entry.file}" to discard the edit.`,
      });
      continue;
    }
    updateCandidates.push({ recordName, entry, localText });
  }

  // --- Local-move pairing: a missing tracked file plus an untracked one
  // may be the same note, moved by hand. Exact base-copy content equality
  // is the strong signal (a moved-but-unedited note); a unique basename
  // match catches a moved-and-edited one, but only when it's unambiguous
  // on both sides. Everything paired here becomes a Folder-reference move
  // instead of the delete + create the two halves would otherwise read as.
  // Shared notes pair too, but only so their move can be *refused* whole -
  // left unpaired, a renamed shared-note file would decay into a refused
  // delete plus a create that duplicates the note into the shared folder.
  const movePairs: Array<{ recordName: string; entry: CloneStateNoteEntry; toFile: string }> = [];
  const claimedByMove = new Set<string>();
  {
    const pairable = missingCandidates;
    for (const candidate of pairable) {
      const base = await readBaseCopy(targetDir, candidate.recordName);
      if (base === undefined) {
        continue;
      }
      const match = untracked.find((file) => !claimedByMove.has(file.file) && file.localText === base);
      if (match) {
        movePairs.push({ recordName: candidate.recordName, entry: candidate.entry, toFile: match.file });
        claimedByMove.add(match.file);
      }
    }
    const unpaired = pairable.filter((candidate) => !movePairs.some((pair) => pair.recordName === candidate.recordName));
    for (const candidate of unpaired) {
      const baseName = path.posix.basename(candidate.entry.file);
      const files = untracked.filter((file) => !claimedByMove.has(file.file) && path.posix.basename(file.file) === baseName);
      const rivals = unpaired.filter((other) => path.posix.basename(other.entry.file) === baseName);
      const file = files[0];
      if (files.length === 1 && rivals.length === 1 && file) {
        movePairs.push({ recordName: candidate.recordName, entry: candidate.entry, toFile: file.file });
        claimedByMove.add(file.file);
      }
    }
  }
  // A locally-deleted shared note is refused outright, before any network:
  // shared-note deletion isn't supported (Apple's own web client shows a
  // delete button for them but it doesn't work), and the old flow would
  // have looked the note up in the *private* db, found nothing, and
  // silently untracked it as "already deleted remotely".
  const unpairedMissing = missingCandidates.filter(
    (candidate) => !movePairs.some((pair) => pair.recordName === candidate.recordName),
  );
  const deleteCandidates: typeof unpairedMissing = [];
  for (const candidate of unpairedMissing) {
    if (candidate.entry.sharedZoneOwner !== undefined) {
      entries.push({
        kind: "delete",
        file: candidate.entry.file,
        resolution: "refused",
        reason:
          "deleting notes shared by someone else isn't supported - " +
          `run "icloud-notes restore ${candidate.entry.file}" to bring the file back`,
      });
      continue;
    }
    deleteCandidates.push(candidate);
  }

  // Classify each pair's target locally; only moves into a real own folder
  // ever need the network. Everything else resolves to a refusal right
  // here, so `status` can show it without a login.
  const readyMovePairs: Array<{ recordName: string; entry: CloneStateNoteEntry; toFile: string; folderRecordName: string }> = [];
  for (const pair of movePairs) {
    const toDir = noteDirOf(pair.toFile);
    const info = dirIndex.get(toDir);
    const base: ExecutablePlanEntry = { kind: "move", file: pair.toFile, previousFile: pair.entry.file, resolution: "refused" };

    if (pair.entry.sharedZoneOwner !== undefined) {
      entries.push({
        ...base,
        reason:
          "renaming or moving notes shared by someone else isn't supported yet - " +
          `move the file back to ${pair.entry.file}`,
      });
      continue;
    }
    if (toDir === "") {
      entries.push({
        ...base,
        reason: "moved to the top level of the clone, but every note lives in a folder - move it into a folder directory",
      });
      continue;
    }
    if (!info) {
      entries.push({
        ...base,
        reason:
          `moved into "${toDir}/", which isn't one of the account's folders - creating folders isn't supported yet; ` +
          "create the folder in Notes, pull, then move the file into it",
      });
      continue;
    }
    if (info.kind === "sharerHome" || info.sharedZoneOwner !== undefined) {
      entries.push({ ...base, reason: "moved into a sharer's area - notes can't be moved into someone else's share" });
      continue;
    }
    const hasTrackedAttachments = Object.values(state.attachments ?? {}).some(
      (attachment) => attachment.noteRecordName === pair.recordName,
    );
    if (hasTrackedAttachments) {
      entries.push({
        ...base,
        reason:
          "this note has attachments, whose files can't be relocated safely yet - move it back " +
          "(or move the note in Notes and pull instead)",
      });
      continue;
    }
    readyMovePairs.push({ ...pair, folderRecordName: info.folderRecordName as string });
  }

  // --- Classify the remaining untracked files by where they sit. Every
  // note must live in a folder directory the account actually has; an
  // untracked file passes the same local refusal gates a modified one does
  // - a brand-new file containing conflict markers or unparseable content
  // is just as unsendable as an edited one containing them.
  const createCandidates: { file: string; localText: string; folderRecordName: string; sharedZoneOwner?: string | undefined }[] = [];
  for (const { file, localText } of untracked) {
    if (claimedByMove.has(file)) {
      continue;
    }
    const dir = noteDirOf(file);
    const info = dirIndex.get(dir);
    if (dir === "") {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason:
          "sits at the top level of the clone, outside any folder - every note lives in a folder, " +
          "so move it into one of the folder directories first",
      });
      continue;
    }
    if (!info) {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason:
          `sits in "${dir}/", which isn't one of the account's folders - creating folders isn't supported yet; ` +
          "create the folder in Notes, pull, then move the file into it",
      });
      continue;
    }
    if (info.kind === "sharerHome") {
      // Only the *top* of a sharer's home is refused: a note there would
      // need folder membership in the sharer's unreadable private tree. A
      // real shared folder below it is a supported create target.
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason:
          "sits loose at the top of a sharer's area - notes can only be created inside one of their shared folders",
      });
      continue;
    }
    if (info.sharedZoneOwner !== undefined && info.permission === "READ_ONLY") {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason: "sits in a shared folder you only have read access to - the server would reject the create",
      });
      continue;
    }
    if (localText === "") {
      entries.push({ kind: "create", file, resolution: "refused", reason: "the file is empty - nothing to create" });
      continue;
    }
    if (hasConflictMarkers(localText)) {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason: "still contains diff3 conflict markers - resolve them before pushing",
      });
      continue;
    }
    if (hasUnknownContentMarker(localText)) {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason: "this file contains the unknown-content banner - remove it before pushing",
      });
      continue;
    }
    if (hasEmbedMarker(localText)) {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason: "contains an embed marker, but this tool can't create embeds - remove it before pushing",
      });
      continue;
    }
    if (hasAttachmentReference(localText)) {
      entries.push({
        kind: "create",
        file,
        resolution: "refused",
        reason: 'contains an "attachments/..." reference, but this tool can\'t upload new attachments - remove it first.',
      });
      continue;
    }
    createCandidates.push({
      file,
      localText,
      folderRecordName: info.folderRecordName as string,
      sharedZoneOwner: info.sharedZoneOwner,
    });
  }

  if (
    updateCandidates.length === 0 &&
    deleteCandidates.length === 0 &&
    createCandidates.length === 0 &&
    readyMovePairs.length === 0
  ) {
    return { state, entries };
  }

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }
  const { session, dsid } = auth;
  const ckdatabasewsUrl = auth.ckdatabasewsUrl;

  // Fresh lookup of every candidate: both the staleness check and the
  // document we build the edit on top of come from the server's current
  // state, not from anything cached locally. One lookup per zone: own notes
  // in the private db, each sharer's notes in that sharer's shared-db zone
  // (delete and move candidates are own-only by the refusals above).
  const lookupGroups = new Map<string | undefined, string[]>();
  const addLookup = (sharedZoneOwner: string | undefined, recordName: string): void => {
    const group = lookupGroups.get(sharedZoneOwner) ?? [];
    group.push(recordName);
    lookupGroups.set(sharedZoneOwner, group);
  };
  for (const candidate of updateCandidates) {
    addLookup(candidate.entry.sharedZoneOwner, candidate.recordName);
  }
  for (const candidate of deleteCandidates) {
    addLookup(undefined, candidate.recordName);
  }
  for (const pair of readyMovePairs) {
    addLookup(undefined, pair.recordName);
  }
  const recordsByName = new Map<string, CloudKitRecord>();
  for (const [sharedZoneOwner, recordNames] of lookupGroups) {
    const zone = noteZone(sharedZoneOwner);
    const records = await lookupRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, recordNames);
    for (const record of records) {
      recordsByName.set(record.recordName, record);
    }
  }

  // --- Local moves: push a Folder-reference update - the exact write shape
  // trash-move deletion already uses live, pointed at a real folder.
  for (const pair of readyMovePairs) {
    const base: ExecutablePlanEntry = { kind: "move", file: pair.toFile, previousFile: pair.entry.file, resolution: "refused" };
    const record = recordsByName.get(pair.recordName);
    if (!record || record.deleted === true || isPurged(record) || isInTrash(record)) {
      entries.push({ ...base, resolution: "conflict", reason: 'no longer exists remotely - run "pull" to reconcile' });
      continue;
    }
    if ((record.recordChangeTag ?? "") !== pair.entry.recordChangeTag) {
      entries.push({ ...base, resolution: "conflict", reason: 'changed remotely since the last pull - run "pull" first' });
      continue;
    }

    const folderRecordName = pair.folderRecordName;
    entries.push({
      ...base,
      resolution: "ready",
      execute: async () => {
        const result = await updateNoteRecord(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, {
          recordName: pair.recordName,
          recordChangeTag: record.recordChangeTag ?? "",
          fields: buildNoteMoveFields(record, folderRecordName, Date.now()),
          parentRecordName: record.parentRecordName,
        });
        if (!result.ok) {
          const detail = result.reason ? ` (${result.reason})` : "";
          console.log(chalk.red(`${pair.toFile}: server rejected the move: ${result.serverErrorCode}${detail}`));
          return false;
        }
        state.notes[pair.recordName] = {
          ...pair.entry,
          file: pair.toFile,
          folderRecordName,
          recordChangeTag: result.record.recordChangeTag ?? "",
          modificationDate: modificationDateOf(result.record) || Date.now(),
        };
        await applyNoteFileTimes(path.join(targetDir, pair.toFile), result.record);
        console.log(`Moved ${pair.entry.file} -> ${pair.toFile}`);
        return true;
      },
    });
  }

  for (const { recordName, entry } of deleteCandidates) {
    const record = recordsByName.get(recordName);
    if (!record || record.deleted === true || isPurged(record)) {
      entries.push({
        kind: "delete",
        file: entry.file,
        resolution: "ready",
        execute: async () => {
          await applyLocalNoteDeletion(targetDir, recordName, entry, state);
          delete state.trashed?.[recordName];
          console.log(`${entry.file}: already deleted remotely - removed from tracking`);
          return true;
        },
      });
      continue;
    }
    if (isInTrash(record)) {
      // Another client (or a previous run) already moved it to Recently
      // Deleted - nothing to send, just stop tracking it. Registered in the
      // trash registry so `delete --hard` can still reach it.
      entries.push({
        kind: "delete",
        file: entry.file,
        resolution: "ready",
        execute: async () => {
          await applyLocalNoteDeletion(targetDir, recordName, entry, state);
          rememberTrashedNote(state, recordName, entry.file);
          console.log(`${entry.file}: already in Recently Deleted - removed from tracking`);
          return true;
        },
      });
      continue;
    }
    if ((record.recordChangeTag ?? "") !== entry.recordChangeTag) {
      entries.push({
        kind: "delete",
        file: entry.file,
        resolution: "conflict",
        reason: 'changed remotely since the last pull - run "pull" first',
      });
      continue;
    }
    entries.push({
      kind: "delete",
      file: entry.file,
      resolution: "ready",
      execute: async () => {
        // Apple's own deletion is a folder move to Trash, not a forceDelete
        // - see the 2026-07-16 lifecycle HAR analysis. Works regardless of
        // attachments, and stays recoverable in Recently Deleted (~30 days);
        // `delete --hard <file>` permanently deletes from there.
        const result = await updateNoteRecord(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, {
          recordName,
          recordChangeTag: record.recordChangeTag ?? "",
          fields: buildNoteTrashFields(record, Date.now()),
          parentRecordName: record.parentRecordName,
        });
        if (!result.ok) {
          const detail = result.reason ? ` (${result.reason})` : "";
          console.log(chalk.red(`${entry.file}: server rejected the delete: ${result.serverErrorCode}${detail}`));
          return false;
        }
        await applyLocalNoteDeletion(targetDir, recordName, entry, state);
        rememberTrashedNote(state, recordName, entry.file);
        console.log(`Moved ${entry.file} to Recently Deleted`);
        return true;
      },
    });
  }

  const replicaId = state.replicaId ?? randomBytes(16).toString("base64");
  state.replicaId = replicaId;
  const replicaIdBytes = new Uint8Array(Buffer.from(replicaId, "base64"));
  if (replicaIdBytes.length !== 16) {
    throw new CorruptStateFileError("state.json has a malformed replicaId (expected 16 bytes, base64-encoded)");
  }

  for (const { file, localText, folderRecordName, sharedZoneOwner } of createCandidates) {
    // The document is built and decode-verified during planning (not at
    // execute time) so `status` shows a build failure as a refusal, with
    // the same fidelity the update path's plan-time gates have.
    let payloadBase64: string;
    try {
      const compressed = compressNoteDocument(encodeNoteDocument(buildInitialNoteDocument(localText, replicaIdBytes)));
      if (decodeNoteBodyText(compressed) !== localText) {
        entries.push({
          kind: "create",
          file,
          resolution: "refused",
          reason: "built document failed decode verification - refusing to create",
        });
        continue;
      }
      payloadBase64 = compressed.toString("base64");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      entries.push({ kind: "create", file, resolution: "refused", reason: message });
      continue;
    }

    const fileStat = await stat(path.join(targetDir, file));
    const modificationDateMs = Math.round(fileStat.mtimeMs);
    entries.push({
      kind: "create",
      file,
      resolution: "ready",
      execute: async () => {
        // Client-generated lowercase-UUID recordName, matching the captured
        // create (the live vault also has uppercase ones, so casing likely
        // doesn't matter - but lowercase is what the capture shows).
        const recordName = randomUUID();
        const zone = noteZone(sharedZoneOwner);
        const result = await createNoteRecord(
          session,
          ckdatabasewsUrl,
          dsid,
          zone.database,
          zone.zoneID,
          recordName,
          buildNoteCreateFields(payloadBase64, localText, modificationDateMs, folderRecordName, sharedZoneOwner),
          // A shared-folder create byte-matches the 2026-07-17 capture: the
          // record-hierarchy parent at the folder is what makes the new
          // note a member of the folder's share. The private shape (no
          // parent) stays exactly as live-verified.
          sharedZoneOwner !== undefined ? { parentRecordName: folderRecordName, createShortGUID: true } : {},
        );
        if (!result.ok) {
          const detail = result.reason ? ` (${result.reason})` : "";
          console.log(chalk.red(`${file}: server rejected the create: ${result.serverErrorCode}${detail}`));
          return false;
        }
        // Mirror what pull's "added" branch establishes for a newly-seen
        // remote note: tracking entry, base copy, file times, and the
        // version/epoch capture of what just landed.
        state.notes[recordName] = {
          file,
          recordChangeTag: result.record.recordChangeTag ?? "",
          modificationDate: modificationDateOf(result.record) || modificationDateMs,
          folderRecordName,
          sharedZoneOwner,
        };
        await writeBaseCopy(targetDir, recordName, localText);
        await applyNoteFileTimes(path.join(targetDir, file), result.record);
        const textValue = result.record.fields.TextDataEncrypted?.value;
        if (typeof textValue === "string") {
          await recordVersion(targetDir, {
            recordName,
            recordType: "Note",
            field: "TextDataEncrypted",
            recordChangeTag: result.record.recordChangeTag ?? "",
            valueBase64: textValue,
          });
        }
        await recordEpoch(targetDir, recordName, historyRecordNames(state, recordName));
        console.log(`Created ${file}`);
        return true;
      },
    });
  }

  for (const candidate of updateCandidates) {
    const { recordName, entry, localText } = candidate;
    const record = recordsByName.get(recordName);
    if (!record || record.deleted === true) {
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "conflict",
        reason: 'no longer exists remotely - run "pull" to reconcile',
      });
      continue;
    }

    // Snapshot the record's current server-side text before anything below
    // can move past it - a changed-remotely conflict (the very next check)
    // is exactly the "someone edited this outside our tool" case version
    // history exists to catch; capturing here, unconditionally, means it's
    // caught whether or not this candidate ends up conflicting.
    const noteTextValue = record.fields.TextDataEncrypted?.value;
    if (typeof noteTextValue === "string") {
      await recordVersion(targetDir, {
        recordName: record.recordName,
        recordType: "Note",
        field: "TextDataEncrypted",
        recordChangeTag: record.recordChangeTag ?? "",
        valueBase64: noteTextValue,
      });
    }

    if ((record.recordChangeTag ?? "") !== entry.recordChangeTag) {
      const classified = classifyNoteRecord(record);
      // An embed-bearing note can't be eagerly merged here: its raw body
      // text carries U+FFFC placeholders where the local file has rendered
      // tables/links/markers, so a diff3 against it would write placeholder
      // soup into the file. `pull` re-renders and merges properly.
      if (classified.status !== "ok" || classified.embedSlots.length > 0) {
        entries.push({
          kind: "update",
          file: entry.file,
          resolution: "conflict",
          reason: 'changed remotely since the last pull - run "pull" (which merges) first',
        });
        continue;
      }
      // Real 3-way merge, same machinery `pull` already uses - the file
      // ends up in exactly the state a manual `pull` would have left it in.
      // This runs during planning (not gated on actually executing a push)
      // - deliberately unchanged from `push --dry-run`'s long-standing
      // behavior, which already merges eagerly; see the "status converges
      // with push --dry-run" project notes.
      const base = (await readBaseCopy(targetDir, recordName)) ?? "";
      const outcome = mergeNoteVersions(base, localText, classified.bodyText);
      await writeFile(path.join(targetDir, entry.file), outcome.text, "utf-8");

      if (outcome.hasConflict) {
        entries.push({
          kind: "update",
          file: entry.file,
          resolution: "conflict",
          reason: "changed remotely since the last pull - merged with conflict markers, resolve manually",
        });
        // Base copy deliberately NOT advanced, matching `pull`'s own
        // discipline - the next merge needs the right common ancestor.
      } else {
        await writeBaseCopy(targetDir, recordName, outcome.text);
        state.notes[recordName] = { ...entry, recordChangeTag: record.recordChangeTag ?? entry.recordChangeTag };
        entries.push({
          kind: "update",
          file: entry.file,
          resolution: "conflict",
          reason: "merged remote changes into your local edit - re-run push to upload",
        });
      }
      continue;
    }

    const fileStat = await stat(path.join(targetDir, entry.file));
    const modificationDateMs = Math.round(fileStat.mtimeMs);

    const zone = noteZone(entry.sharedZoneOwner);
    const summary: PushSummary = { conflicts: [], refused: [] };
    const conflictsBefore = summary.conflicts.length;
    const refusedBefore = summary.refused.length;
    const trackedFileAttachmentIds = new Set(
      Object.entries(state.attachments ?? {})
        .filter(([, attachment]) => attachment.noteRecordName === recordName)
        .map(([attachmentRecordName]) => attachmentRecordName),
    );
    const prepared = await prepareUpdate(
      session,
      ckdatabasewsUrl,
      dsid,
      zone,
      targetDir,
      record,
      entry,
      localText,
      trackedFileAttachmentIds,
      replicaIdBytes,
      modificationDateMs,
      summary,
    );
    if (!prepared) {
      const newConflict = summary.conflicts[conflictsBefore];
      const newRefusal = summary.refused[refusedBefore];
      if (newConflict !== undefined) {
        entries.push({ kind: "update", file: entry.file, resolution: "conflict", reason: stripFilePrefix(newConflict, entry.file) });
      } else {
        entries.push({
          kind: "update",
          file: entry.file,
          resolution: "refused",
          reason: stripFilePrefix(newRefusal ?? "refused", entry.file),
        });
      }
      continue;
    }
    if (prepared.updates.length === 0) {
      // The table write path resolved every table's diff to a no-op and the
      // surrounding prose didn't change either - `localFileState` saw a
      // byte-level difference (e.g. cosmetic markdown formatting) but
      // there's nothing to actually send. Bring the base copy back in sync
      // so this doesn't keep re-triggering "modified" on every future push.
      entries.push({
        kind: "update",
        file: entry.file,
        resolution: "noop",
        execute: async () => {
          await writeBaseCopy(targetDir, recordName, localText);
          console.log(`${entry.file}: no server-side change needed`);
          return false;
        },
      });
      continue;
    }

    entries.push({
      kind: "update",
      file: entry.file,
      resolution: "ready",
      execute: async () => {
        const results = await updateRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, prepared.updates);
        const failure = results.find((result) => !result.ok);
        if (failure && !failure.ok) {
          const detail = failure.reason ? ` (${failure.reason})` : "";
          if (failure.serverErrorCode === "CONFLICT") {
            console.log(chalk.red(`${entry.file}: rejected by the server as a conflicting change${detail} - run "pull" first`));
          } else {
            console.log(chalk.red(`${entry.file}: server rejected the update: ${failure.serverErrorCode}${detail}`));
          }
          return false;
        }

        if (prepared.noteTextUpdated) {
          // `updates[0]` (and so `results[0]`, assuming the server preserves
          // request order in its response) is always the Note record's own
          // update when noteTextUpdated is true; the recordName check is a
          // defensive fallback in case that assumption ever doesn't hold.
          const noteResult = results[0];
          if (noteResult?.ok && noteResult.record.recordName === recordName) {
            state.notes[recordName] = {
              ...entry,
              recordChangeTag: noteResult.record.recordChangeTag ?? "",
              modificationDate: modificationDateOf(noteResult.record) || modificationDateMs,
            };
            await applyNoteFileTimes(path.join(targetDir, entry.file), noteResult.record);
          }
        }
        await writeBaseCopy(targetDir, recordName, localText);
        // A whole-note index over what just landed remotely, mirroring
        // `pull`'s own capture - see the "Whole-note coordinated version
        // epochs" investigation.
        await recordEpoch(targetDir, recordName, historyRecordNames(state, recordName));
        console.log(`Pushed ${entry.file}`);
        return true;
      },
    });
  }

  return { state, entries };
}

/**
 * Uploads locally edited notes back to iCloud, guarded three ways (per the
 * README's Phase 3 plan):
 *
 *  1. Staleness: a note whose remote recordChangeTag moved past the last
 *     clone/pull baseline is reported as a conflict, never overwritten -
 *     run `pull` (which merges) first. The server enforces the same check
 *     again at write time via the tag we send.
 *  2. Round-trip: the current remote document must re-encode byte-for-byte
 *     from our parsed model before we trust ourselves to edit it; anything
 *     we don't fully understand stays read-only.
 *  3. Verification: the rebuilt document is decoded again and must yield
 *     exactly the intended content before it's uploaded.
 *
 * As of the "full reconciler" work, `push` also creates a note for any
 * untracked top-level `.md` file, and deletes the remote note for any
 * tracked file that's gone missing locally (moving it to Recently Deleted,
 * exactly like Apple's own delete) - the everyday workflow is now "edit,
 * add, or remove files, run push", with `delete <file>` staying around as a
 * fast, explicit single-file escape hatch (and `delete --hard` for
 * permanent deletion). Run `status` first to preview exactly what a push
 * will do (including anything it would refuse) before running it for real.
 */
export async function runPush(targetDir: string, options: PushOptions = {}): Promise<void> {
  const dryRun = options.dryRun === true;
  const { state, entries } = await buildPushPlan(targetDir, { onLoginStatus: options.onLoginStatus });

  if (entries.length === 0) {
    console.log("Nothing to push.");
    return;
  }

  if (!dryRun) {
    let pushed = 0;
    for (const entry of entries) {
      if (!entry.execute) {
        continue;
      }
      const succeeded = await entry.execute();
      if (entry.resolution === "ready" && succeeded) {
        pushed += 1;
      }
    }
    await writeCloneState(targetDir, state);
    console.log(`Pushed ${pushed} note(s) from ${targetDir}`);
  }

  for (const line of renderPlan(entries, options.formatPath)) {
    console.log(line);
  }
}

/** Untracked `.md` files anywhere in the vault, as vault-root-relative
 * POSIX paths - the raw material for the create half, the local-move
 * pairing, and the loose-file/unknown-folder refusals. Skips
 * dot-directories (the state dir, .git) and the reserved per-folder
 * `attachments/` directories. */
async function listUntrackedMarkdownFiles(targetDir: string, state: CloneState): Promise<string[]> {
  const tracked = new Set(Object.values(state.notes).map((entry) => entry.file));
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(path.join(targetDir, dir), { withFileTypes: true });
    } catch (cause) {
      if (isEnoent(cause)) {
        return;
      }
      throw cause;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }
      const relative = dir === "" ? dirent.name : `${dir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (dirent.name.toLowerCase() !== "attachments") {
          await walk(relative);
        }
      } else if (dirent.isFile() && dirent.name.endsWith(".md") && !tracked.has(relative)) {
        found.push(relative);
      }
    }
  };

  await walk("");
  return found.sort();
}

/**
 * Builds and verifies every record update one candidate needs (the Note
 * record's own text, any table attachments, or both), or undefined (with
 * the reason recorded in `summary`) if any safety gate refuses. When a Note
 * text update is included, it's always `updates[0]` - callers rely on that
 * to know which result in a batch is the Note record's.
 */
async function prepareUpdate(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  zone: NoteZone,
  targetDir: string,
  record: CloudKitRecord,
  entry: CloneStateNoteEntry,
  localText: string,
  trackedFileAttachmentIds: ReadonlySet<string>,
  replicaId: Uint8Array,
  modificationDateMs: number,
  summary: PushSummary,
): Promise<PreparedCandidate | undefined> {
  const classified = classifyNoteRecord(record);
  if (classified.status !== "ok") {
    const reason = classified.status === "unsyncable" ? classified.reason : classified.status;
    summary.refused.push(`${entry.file}: remote note is no longer safely editable (${reason})`);
    return undefined;
  }
  if (!classified.publishable) {
    summary.refused.push(
      `${entry.file}: this note contains content this tool can't parse - it can't be safely edited. ` +
        `Run "icloud-notes restore ${entry.file}" to discard your local edit.`,
    );
    return undefined;
  }

  if (classified.embedSlots.length > 0) {
    return prepareEmbedCandidate(
      session,
      ckdatabasewsUrl,
      dsid,
      zone,
      targetDir,
      record,
      classified,
      entry,
      localText,
      trackedFileAttachmentIds,
      replicaId,
      modificationDateMs,
      summary,
    );
  }

  const textUpdate = prepareNoteTextUpdate(record, classified.bodyText, localText, classified.embedSlots, replicaId, entry, summary);
  if (!textUpdate) {
    return undefined;
  }
  const fields = buildNoteUpdateFields(record, textUpdate, localText, modificationDateMs);
  return {
    updates: [noteRecordUpdate(record, entry, fields)],
    noteTextUpdated: true,
  };
}

/**
 * The embed-bearing note path (tables, and - since Step 1 of the formatting
 * plan, 2026-07-17 - unrenderable embeds carried as inline markers).
 * `planEmbedRepresentations` locates each embed slot's local representation
 * (verbatim marker or rendered markdown table block, by document order,
 * matching how `resolveNoteAttachments` substituted them on read) and
 * reconstructs the placeholder-form body text. Changed tables are diffed
 * and applied; markers pass through untouched (their placeholders and
 * `attachmentInfo` runs stay exactly as they are); if the surrounding prose
 * changed too, the Note record's own text updates as well - all as one
 * atomic `records/modify` batch.
 */
async function prepareEmbedCandidate(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  zone: NoteZone,
  targetDir: string,
  record: CloudKitRecord,
  classified: OkNoteRecordResult,
  entry: CloneStateNoteEntry,
  localText: string,
  trackedFileAttachmentIds: ReadonlySet<string>,
  replicaId: Uint8Array,
  modificationDateMs: number,
  summary: PushSummary,
): Promise<PreparedCandidate | undefined> {
  const plan = planEmbedRepresentations(localText, classified.embedSlots, trackedFileAttachmentIds);
  if (!plan.ok) {
    summary.refused.push(`${entry.file}: ${plan.reason}. Run "icloud-notes restore ${entry.file}" to discard your local edit.`);
    return undefined;
  }

  const attachmentRecords =
    plan.tables.length === 0
      ? []
      : await lookupRecords(
          session,
          ckdatabasewsUrl,
          dsid,
          zone.database,
          zone.zoneID,
          plan.tables.map((table) => table.ref.attachmentIdentifier),
        );
  const attachmentByName = new Map(attachmentRecords.map((r) => [r.recordName, r]));

  // Snapshot every fetched table's current server-side bytes before the
  // per-ref loop below can move past a deleted one - matching the
  // Note-record hook above, this has to fire unconditionally, not just for
  // tables that end up getting written.
  for (const attachmentRecord of attachmentRecords) {
    if (attachmentRecord.deleted === true) {
      continue;
    }
    const mergeableValue = attachmentRecord.fields.MergeableDataEncrypted?.value;
    if (typeof mergeableValue === "string") {
      await recordVersion(targetDir, {
        recordName: attachmentRecord.recordName,
        recordType: "Attachment",
        field: "MergeableDataEncrypted",
        recordChangeTag: attachmentRecord.recordChangeTag ?? "",
        valueBase64: mergeableValue,
        noteRecordName: record.recordName,
      });
    }
  }

  const updates: RecordUpdate[] = [];
  for (const { ref, block } of plan.tables) {
    const attachmentRecord = attachmentByName.get(ref.attachmentIdentifier);
    if (!attachmentRecord || attachmentRecord.deleted === true) {
      summary.conflicts.push(`${entry.file}: a table in this note no longer exists remotely - run "pull" to reconcile`);
      return undefined;
    }
    const result = prepareTableAttachmentUpdate(attachmentRecord, block.grid, replicaId);
    if (!result.ok) {
      summary.refused.push(
        `${entry.file}: ${result.reason}. Run "icloud-notes restore ${entry.file}" to discard your local edit.`,
      );
      return undefined;
    }
    if (result.changed) {
      updates.push({
        recordName: attachmentRecord.recordName,
        recordType: "Attachment",
        recordChangeTag: attachmentRecord.recordChangeTag ?? "",
        fields: { MergeableDataEncrypted: { value: result.mergeableDataBase64 } },
        parentRecordName: attachmentRecord.parentRecordName,
      });
    }
  }

  let noteTextUpdated = false;
  if (plan.reconstructedBodyText !== classified.bodyText) {
    const textUpdate = prepareNoteTextUpdate(
      record,
      classified.bodyText,
      plan.reconstructedBodyText,
      classified.embedSlots,
      replicaId,
      entry,
      summary,
    );
    if (!textUpdate) {
      return undefined;
    }
    const fields = buildNoteUpdateFields(record, textUpdate, plan.reconstructedBodyText, modificationDateMs);
    updates.unshift(noteRecordUpdate(record, entry, fields));
    noteTextUpdated = true;
  }

  if (updates.length === 0) {
    // Every table's diff resolved to a no-op and the surrounding prose
    // didn't change either - `localFileState` said "modified", but nothing
    // about the note's actual content differs from the last sync.
    return { updates: [], noteTextUpdated: false };
  }
  return { updates, noteTextUpdated };
}

function noteRecordUpdate(record: CloudKitRecord, entry: CloneStateNoteEntry, fields: Record<string, { value: unknown }>): RecordUpdate {
  return {
    recordName: record.recordName,
    recordType: "Note",
    recordChangeTag: entry.recordChangeTag,
    fields,
    // The captured shared-zone Note updates omit the record-hierarchy
    // parent, unlike private ones (which echo it) and unlike shared
    // Attachment updates (which keep it) - see the 2026-07-17 capture.
    parentRecordName: entry.sharedZoneOwner === undefined ? record.parentRecordName : undefined,
  };
}

/**
 * Builds and verifies the new TextDataEncrypted payload for a note's own
 * text, returning it base64-encoded, or undefined (with the reason recorded
 * in `summary`) if any safety gate refuses. `currentBodyText` is what the
 * remote document is expected to currently decode to (the plain-text path
 * passes the remote's own text; the embed path passes the same, since only
 * the *desired* text differs when prose around an embed changed too).
 * `expectedSlots` is the note's embed structure, which the edit must leave
 * exactly alone: the text splice may not touch a U+FFFC placeholder, and the
 * rebuilt document must decode to the same slots it started with.
 */
function prepareNoteTextUpdate(
  record: CloudKitRecord,
  currentBodyText: string,
  desiredBodyText: string,
  expectedSlots: readonly EmbedSlot[],
  replicaId: Uint8Array,
  entry: CloneStateNoteEntry,
  summary: PushSummary,
): string | undefined {
  const textField = record.fields.TextDataEncrypted;
  if (!textField || typeof textField.value !== "string") {
    summary.refused.push(`${entry.file}: remote note has no readable text data`);
    return undefined;
  }
  if (record.fields.TextDataAsset?.value != null) {
    // Very large notes move their text into a separate asset; that write
    // path is completely unexplored, so leave those alone.
    summary.refused.push(`${entry.file}: remote note stores its text as an asset - refusing to edit`);
    return undefined;
  }

  const raw = new Uint8Array(decompressNoteDocument(Buffer.from(textField.value, "base64")));
  if (!noteDocumentRoundTrips(raw)) {
    summary.refused.push(
      `${entry.file}: the note's document doesn't round-trip byte-for-byte through our model - refusing to edit`,
    );
    return undefined;
  }

  // The single-splice diff must steer clear of every U+FFFC placeholder:
  // tombstoning one (or typing a literal one) would sever the CRDT character
  // its attachmentInfo run points at, even if the visible text ends up with
  // the right placeholder count. Embeds can't be moved through this tool.
  const splice = computeSplice(currentBodyText, desiredBodyText);
  const spliceTouchesPlaceholder =
    currentBodyText.slice(splice.start, splice.start + splice.deleteLength).includes(OBJECT_REPLACEMENT_CHARACTER) ||
    splice.insertText.includes(OBJECT_REPLACEMENT_CHARACTER);
  if (spliceTouchesPlaceholder) {
    summary.refused.push(
      `${entry.file}: this edit would delete or move an embedded object - embeds can only be edited in Notes itself. ` +
        `Run "icloud-notes restore ${entry.file}" to discard your local edit.`,
    );
    return undefined;
  }

  try {
    const doc = parseNoteDocument(raw);
    if (doc.text !== currentBodyText) {
      summary.refused.push(`${entry.file}: decoder disagreement on the note's current text - refusing to edit`);
      return undefined;
    }
    applyTextEdit(doc, desiredBodyText, { replicaId });
    const compressed = compressNoteDocument(encodeNoteDocument(doc));
    if (decodeNoteBodyText(compressed) !== desiredBodyText) {
      summary.refused.push(`${entry.file}: rebuilt document failed decode verification - refusing to push`);
      return undefined;
    }
    // The embed structure must have come through the edit untouched - same
    // slots, same order, same identities (this also backstops
    // `adjustAttributeRuns`'s never-grow-an-attachmentInfo-run guard).
    const rebuiltSlots = decodeNoteEmbedSlots(compressed);
    if (rebuiltSlots === undefined || !embedSlotsEqual(rebuiltSlots, expectedSlots)) {
      summary.refused.push(`${entry.file}: rebuilt document failed embed-structure verification - refusing to push`);
      return undefined;
    }
    return compressed.toString("base64");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    summary.refused.push(`${entry.file}: ${message}`);
    return undefined;
  }
}

function embedSlotsEqual(a: readonly EmbedSlot[], b: readonly EmbedSlot[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((slot, i) => {
    const other = b[i];
    if (!other) {
      return false;
    }
    if (slot.kind === "attachment") {
      return (
        other.kind === "attachment" &&
        slot.ref.attachmentIdentifier === other.ref.attachmentIdentifier &&
        slot.ref.typeUti === other.ref.typeUti
      );
    }
    return other.kind === "unknown" && slot.typeUti === other.typeUti;
  });
}

/** Matches the diff3 markers `pull` writes (and git's own, same format). */
function hasConflictMarkers(text: string): boolean {
  return /^(<{7}( .*)?|\|{7}( .*)?|={7}|>{7}( .*)?)$/m.test(text);
}
