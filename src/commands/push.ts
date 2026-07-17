import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import type { IcloudSession } from "../session.js";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdate } from "../cloudkit/databaseClient.js";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { classifyNoteRecord, type NoteDecodeResult } from "../notes/decodeNoteRecord.js";
import { CorruptStateFileError, NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { buildNoteUpdateFields } from "../notes/encodeNoteRecord.js";
import { findMarkdownTableBlocks } from "../notes/decodeTableRecord.js";
import { mergeNoteVersions } from "../notes/mergeConflict.js";
import { hasAttachmentReference, isTableUti } from "../notes/noteAttachments.js";
import { hasUnknownContentMarker } from "../notes/unknownContent.js";
import { localFileState } from "../notes/localFileState.js";
import { recordEpoch } from "../notes/noteEpoch.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { compressNoteDocument, decodeNoteBodyText, decompressNoteDocument } from "../notes/noteText.js";
import { prepareTableAttachmentUpdate, reconstructBodyTextWithPlaceholders } from "../notes/tablePushEdit.js";
import { historyRecordNames } from "../notes/trackedFile.js";
import { recordVersion } from "../notes/versionHistory.js";
import {
  applyTextEdit,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
} from "../notes/noteDocument.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface PushOptions {
  /** Report what would be pushed without sending anything or touching state. */
  dryRun?: boolean;
  /** Routes any headless-recovery login status messages; defaults to staying silent (see `resolveFolderAccount`). */
  onLoginStatus?: (message: string) => void;
}

interface PushCandidate {
  recordName: string;
  entry: CloneStateNoteEntry;
  localText: string;
}

interface PushSummary {
  pushed: number;
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

/**
 * Uploads locally edited notes back to iCloud, guarded three ways (per the
 * README's Phase 3 plan):
 *
 *  1. Staleness: a note whose remote recordChangeTag moved past the last
 *     clone/pull baseline is reported as a conflict, never overwritten -
 *     run `pull` (which merges) first. The server enforces the same check
 *     again at write time via the tag we send. A table attachment record
 *     has no stored baseline changeTag to pre-check (tables aren't tracked
 *     in state.attachments - see `attachmentSync.ts`), so it's fetched
 *     fresh and submitted with that same fresh tag, letting the server's
 *     own optimistic-concurrency check catch a real conflict at write time.
 *  2. Round-trip: the current remote document must re-encode byte-for-byte
 *     from our parsed model before we trust ourselves to edit it; anything
 *     we don't fully understand stays read-only. Applies separately to the
 *     Note record's text and to each table attachment's own document.
 *  3. Verification: the rebuilt document is decoded again and must yield
 *     exactly the intended content before it's uploaded.
 */
export async function runPush(targetDir: string, options: PushOptions = {}): Promise<void> {
  const dryRun = options.dryRun === true;
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const summary: PushSummary = { pushed: 0, conflicts: [], refused: [] };
  const candidates: PushCandidate[] = [];

  for (const [recordName, entry] of Object.entries(state.notes)) {
    if ((await localFileState(targetDir, entry, recordName)) !== "modified") {
      continue;
    }
    const localText = await readFile(path.join(targetDir, entry.file), "utf-8");

    if (entry.sharedZoneOwner) {
      summary.refused.push(`${entry.file}: writing back to notes shared by someone else isn't supported yet`);
      continue;
    }
    if (hasConflictMarkers(localText)) {
      summary.conflicts.push(`${entry.file}: still contains diff3 conflict markers - resolve them before pushing`);
      continue;
    }
    if (localText === "") {
      summary.refused.push(`${entry.file}: pushing a fully emptied note isn't supported yet - edit it in Notes instead`);
      continue;
    }
    if (hasUnknownContentMarker(localText)) {
      summary.refused.push(
        `${entry.file}: this note contains content this tool can't parse and can never be pushed - ` +
          `run "icloud-notes restore ${entry.file}" to discard your local edit.`,
      );
      continue;
    }
    // A note that doesn't already have a tracked attachment but whose text
    // now contains an "attachments/..." reference was hand-typed (or
    // copy-pasted), not produced by `clone`/`pull` - there's no real file to
    // upload behind it, so pushing it as literal text would silently
    // "succeed" while doing something other than what it looks like. A note
    // that *does* already have a tracked attachment is caught more
    // specifically below, once we have the remote record to point at. Table
    // attachments aren't tracked in state.attachments at all (see
    // `attachmentSync.ts`), so this check never fires for them - a table's
    // own markdown never matches the "attachments/..." link/embed pattern.
    const notePreviouslyHadAttachments = Object.values(state.attachments ?? {}).some(
      (attachment) => attachment.noteRecordName === recordName,
    );
    if (!notePreviouslyHadAttachments && hasAttachmentReference(localText)) {
      summary.refused.push(
        `${entry.file}: contains an "attachments/..." reference, but this tool can't upload new attachments - ` +
          `remove it, or run "icloud-notes restore ${entry.file}" to discard the edit.`,
      );
      continue;
    }
    candidates.push({ recordName, entry, localText });
  }

  if (candidates.length === 0) {
    console.log("Nothing to push.");
    reportLists(summary);
    return;
  }

  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }

  // Fresh lookup of every candidate: both the staleness check and the
  // document we build the edit on top of come from the server's current
  // state, not from anything cached locally.
  const records = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    "private",
    PRIVATE_NOTES_ZONE,
    candidates.map((candidate) => candidate.recordName),
  );
  const recordsByName = new Map(records.map((record) => [record.recordName, record]));

  const replicaId = state.replicaId ?? randomBytes(16).toString("base64");
  state.replicaId = replicaId;
  const replicaIdBytes = new Uint8Array(Buffer.from(replicaId, "base64"));
  if (replicaIdBytes.length !== 16) {
    throw new CorruptStateFileError("state.json has a malformed replicaId (expected 16 bytes, base64-encoded)");
  }

  for (const candidate of candidates) {
    const { recordName, entry, localText } = candidate;
    const record = recordsByName.get(recordName);
    if (!record || record.deleted === true) {
      summary.conflicts.push(`${entry.file}: no longer exists remotely - run "pull" to reconcile`);
      continue;
    }

    // Snapshot the record's current server-side text before anything below
    // can `continue` past it - a changed-remotely conflict (the very next
    // check) is exactly the "someone edited this outside our tool" case
    // version history exists to catch; capturing here, unconditionally,
    // means it's caught whether or not this candidate ends up conflicting.
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
      if (classified.status !== "ok") {
        summary.conflicts.push(`${entry.file}: changed remotely since the last pull - run "pull" (which merges) first`);
        continue;
      }
      // Real 3-way merge, same machinery `pull` already uses - the file
      // ends up in exactly the state a manual `pull` would have left it in,
      // without a separate command. Per-candidate: one conflicting note
      // doesn't block the others in this same push from going through.
      const base = (await readBaseCopy(targetDir, recordName)) ?? "";
      const outcome = mergeNoteVersions(base, localText, classified.bodyText);
      await writeFile(path.join(targetDir, entry.file), outcome.text, "utf-8");

      if (outcome.hasConflict) {
        summary.conflicts.push(
          `${entry.file}: changed remotely since the last pull - merged with conflict markers, resolve manually`,
        );
        // Base copy deliberately NOT advanced, matching `pull`'s own
        // discipline - the next merge needs the right common ancestor.
      } else {
        await writeBaseCopy(targetDir, recordName, outcome.text);
        state.notes[recordName] = { ...entry, recordChangeTag: record.recordChangeTag ?? entry.recordChangeTag };
        console.log(`${entry.file}: merged remote changes into your local edit - re-run push to upload`);
      }
      continue;
    }

    const fileStat = await stat(path.join(targetDir, entry.file));
    const modificationDateMs = Math.round(fileStat.mtimeMs);

    const prepared = await prepareUpdate(
      auth.session,
      auth.ckdatabasewsUrl,
      auth.dsid,
      targetDir,
      record,
      entry,
      localText,
      replicaIdBytes,
      modificationDateMs,
      summary,
    );
    if (!prepared) {
      continue;
    }
    if (prepared.updates.length === 0) {
      // The table write path resolved every table's diff to a no-op and the
      // surrounding prose didn't change either - `localFileState` saw a
      // byte-level difference (e.g. cosmetic markdown formatting) but
      // there's nothing to actually send. Bring the base copy back in sync
      // so this doesn't keep re-triggering "modified" on every future push,
      // without claiming a server write happened.
      if (!dryRun) {
        await writeBaseCopy(targetDir, recordName, localText);
      }
      console.log(`${entry.file}: no server-side change needed`);
      continue;
    }

    if (dryRun) {
      console.log(`Would push ${entry.file} (${localText.length} chars)`);
      summary.pushed += 1;
      continue;
    }

    const results = await updateRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid, PRIVATE_NOTES_ZONE, prepared.updates);
    const failure = results.find((result) => !result.ok);
    if (failure && !failure.ok) {
      const detail = failure.reason ? ` (${failure.reason})` : "";
      if (failure.serverErrorCode === "CONFLICT") {
        summary.conflicts.push(`${entry.file}: rejected by the server as a conflicting change${detail} - run "pull" first`);
      } else {
        summary.refused.push(`${entry.file}: server rejected the update: ${failure.serverErrorCode}${detail}`);
      }
      continue;
    }

    if (prepared.noteTextUpdated) {
      // `updates[0]` (and so `results[0]`, assuming the server preserves
      // request order in its response - unverified against a real
      // multi-operation records/modify call, see dev notes) is always the
      // Note record's own update when noteTextUpdated is true; the
      // recordName check is a defensive fallback in case that assumption
      // ever doesn't hold - the server-side write already happened either
      // way, this only guards *local* state bookkeeping from picking up
      // the wrong record's result.
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
    // A whole-note index over what just landed remotely, mirroring `pull`'s
    // own capture - see the "Whole-note coordinated version epochs"
    // investigation. Deliberately only reached after a real server-side
    // write succeeded, not on the staleness pre-check's incidental snapshot
    // capture above (which fires whether or not this push actually goes
    // through).
    await recordEpoch(targetDir, recordName, historyRecordNames(state, recordName));
    summary.pushed += 1;
    console.log(`Pushed ${entry.file}`);
  }

  if (!dryRun) {
    await writeCloneState(targetDir, state);
  }

  console.log(`${dryRun ? "Would push" : "Pushed"} ${summary.pushed} note(s) from ${targetDir}`);
  reportLists(summary);
}

/**
 * Builds and verifies every record update one candidate needs (the Note
 * record's own text, any table attachments, or both), or undefined (with
 * the reason recorded in `summary`) if any safety gate refuses. When a Note
 * text update is included, it's always `updates[0]` - `runPush` relies on
 * that to know which result in the batch is the Note record's.
 */
async function prepareUpdate(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  targetDir: string,
  record: CloudKitRecord,
  entry: CloneStateNoteEntry,
  localText: string,
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

  if (classified.attachments.length > 0) {
    if (!classified.attachments.every((ref) => isTableUti(ref.typeUti))) {
      summary.refused.push(
        `${entry.file}: this note has an attachment - it can't be safely edited through this tool and will stay ` +
          `read-only. Run "icloud-notes restore ${entry.file}" to discard your local edit and match the synced copy.`,
      );
      return undefined;
    }
    return prepareTableCandidate(
      session,
      ckdatabasewsUrl,
      dsid,
      targetDir,
      record,
      classified,
      entry,
      localText,
      replicaId,
      modificationDateMs,
      summary,
    );
  }

  const textUpdate = prepareNoteTextUpdate(record, classified.bodyText, localText, replicaId, entry, summary);
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
 * The table write path (plan step 4): loosens the blanket attachment
 * refusal above for the "every attachment is a table" case. Locates each
 * table's rendered markdown block in the local text (by document order,
 * matching how `resolveNoteAttachments` substituted them on read - see
 * `findMarkdownTableBlocks`), diffs and applies each one that actually
 * changed, and - only if the surrounding prose changed too - also updates
 * the Note record's own text, all as one atomic `records/modify` batch.
 */
async function prepareTableCandidate(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  targetDir: string,
  record: CloudKitRecord,
  classified: OkNoteRecordResult,
  entry: CloneStateNoteEntry,
  localText: string,
  replicaId: Uint8Array,
  modificationDateMs: number,
  summary: PushSummary,
): Promise<PreparedCandidate | undefined> {
  const blocks = findMarkdownTableBlocks(localText);
  if (blocks.length !== classified.attachments.length) {
    summary.refused.push(
      `${entry.file}: can't tell which table(s) changed (found ${blocks.length} table-shaped block(s) locally, ` +
        `expected ${classified.attachments.length}) - run "icloud-notes restore ${entry.file}" to discard the edit.`,
    );
    return undefined;
  }

  const attachmentRecords = await lookupRecords(
    session,
    ckdatabasewsUrl,
    dsid,
    "private",
    PRIVATE_NOTES_ZONE,
    classified.attachments.map((ref) => ref.attachmentIdentifier),
  );
  const attachmentByName = new Map(attachmentRecords.map((r) => [r.recordName, r]));

  // Snapshot every fetched table's current server-side bytes before the
  // per-ref loop below can `continue`/return past a deleted one - matching
  // the Note-record hook above, this has to fire unconditionally, not just
  // for tables that end up getting written.
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
  for (let i = 0; i < classified.attachments.length; i += 1) {
    const ref = classified.attachments[i];
    const block = blocks[i];
    if (!ref || !block) {
      continue;
    }
    const attachmentRecord = attachmentByName.get(ref.attachmentIdentifier);
    if (!attachmentRecord || attachmentRecord.deleted === true) {
      summary.conflicts.push(`${entry.file}: a table in this note no longer exists remotely - run "pull" to reconcile`);
      return undefined;
    }
    const result = prepareTableAttachmentUpdate(attachmentRecord, block.grid);
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

  const reconstructedBodyText = reconstructBodyTextWithPlaceholders(localText, blocks);
  let noteTextUpdated = false;
  if (reconstructedBodyText !== classified.bodyText) {
    const textUpdate = prepareNoteTextUpdate(record, classified.bodyText, reconstructedBodyText, replicaId, entry, summary);
    if (!textUpdate) {
      return undefined;
    }
    const fields = buildNoteUpdateFields(record, textUpdate, reconstructedBodyText, modificationDateMs);
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
    parentRecordName: record.parentRecordName,
  };
}

/**
 * Builds and verifies the new TextDataEncrypted payload for a note's own
 * text, returning it base64-encoded, or undefined (with the reason recorded
 * in `summary`) if any safety gate refuses. `currentBodyText` is what the
 * remote document is expected to currently decode to (the plain-text path
 * passes the remote's own text; the table path passes the same, since only
 * the *desired* text differs when prose around a table changed too).
 */
function prepareNoteTextUpdate(
  record: CloudKitRecord,
  currentBodyText: string,
  desiredBodyText: string,
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
    return compressed.toString("base64");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    summary.refused.push(`${entry.file}: ${message}`);
    return undefined;
  }
}

/** Matches the diff3 markers `pull` writes (and git's own, same format). */
function hasConflictMarkers(text: string): boolean {
  return /^(<{7}( .*)?|\|{7}( .*)?|={7}|>{7}( .*)?)$/m.test(text);
}

function reportLists(summary: PushSummary): void {
  if (summary.conflicts.length > 0) {
    console.log(`${summary.conflicts.length} conflict(s):`);
    for (const conflict of summary.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }
  if (summary.refused.length > 0) {
    console.log(`${summary.refused.length} note(s) refused for safety:`);
    for (const refusal of summary.refused) {
      console.log(`  - ${refusal}`);
    }
  }
}
