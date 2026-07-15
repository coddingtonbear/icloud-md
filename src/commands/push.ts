import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ensureAuthenticated } from "../auth/ensureAuthenticated.js";
import { lookupRecords, updateNoteRecord, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { CorruptStateFileError, NotClonedDirectoryError, NotesUnavailableError } from "../errors.js";
import { buildNoteUpdateFields } from "../notes/encodeNoteRecord.js";
import { hasAttachmentReference } from "../notes/noteAttachments.js";
import { hasUnknownContentMarker } from "../notes/unknownContent.js";
import { localFileState } from "../notes/localFileState.js";
import { applyNoteFileTimes, modificationDateOf } from "../notes/noteTimestamps.js";
import { compressNoteDocument, decodeNoteBodyText, decompressNoteDocument } from "../notes/noteText.js";
import {
  applyTextEdit,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
} from "../notes/noteDocument.js";
import type { IcloudSession } from "../session.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

export interface PushOptions {
  /** Report what would be pushed without sending anything or touching state. */
  dryRun?: boolean;
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
 *     exactly the local file's text before it's uploaded.
 */
export async function runPush(session: IcloudSession, targetDir: string, options: PushOptions = {}): Promise<void> {
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
    // specifically below, once we have the remote record to point at.
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

  const auth = await ensureAuthenticated(session);
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
    if ((record.recordChangeTag ?? "") !== entry.recordChangeTag) {
      summary.conflicts.push(`${entry.file}: changed remotely since the last pull - run "pull" (which merges) first`);
      continue;
    }

    const prepared = prepareUpdate(record, entry, localText, replicaIdBytes, summary);
    if (!prepared) {
      continue;
    }

    const fileStat = await stat(path.join(targetDir, entry.file));
    const modificationDateMs = Math.round(fileStat.mtimeMs);
    const fields = buildNoteUpdateFields(record, prepared, localText, modificationDateMs);

    if (dryRun) {
      console.log(`Would push ${entry.file} (${localText.length} chars)`);
      summary.pushed += 1;
      continue;
    }

    const result = await updateNoteRecord(auth.session, auth.ckdatabasewsUrl, auth.dsid, PRIVATE_NOTES_ZONE, {
      recordName,
      recordChangeTag: entry.recordChangeTag,
      fields,
      parentRecordName: record.parentRecordName,
    });

    if (!result.ok) {
      const detail = result.reason ? ` (${result.reason})` : "";
      if (result.serverErrorCode === "CONFLICT") {
        summary.conflicts.push(`${entry.file}: rejected by the server as a conflicting change${detail} - run "pull" first`);
      } else {
        summary.refused.push(`${entry.file}: server rejected the update: ${result.serverErrorCode}${detail}`);
      }
      continue;
    }

    state.notes[recordName] = {
      ...entry,
      recordChangeTag: result.record.recordChangeTag ?? "",
      modificationDate: modificationDateOf(result.record) || modificationDateMs,
    };
    await writeBaseCopy(targetDir, recordName, localText);
    await applyNoteFileTimes(path.join(targetDir, entry.file), result.record);
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
 * Builds and verifies the new TextDataEncrypted payload for one note,
 * returning it base64-encoded, or undefined (with the reason recorded in
 * `summary`) if any safety gate refuses.
 */
function prepareUpdate(
  record: CloudKitRecord,
  entry: CloneStateNoteEntry,
  localText: string,
  replicaId: Uint8Array,
  summary: PushSummary,
): string | undefined {
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
    summary.refused.push(
      `${entry.file}: this note has an attachment - it can't be safely edited through this tool and will stay ` +
        `read-only. Run "icloud-notes restore ${entry.file}" to discard your local edit and match the synced copy.`,
    );
    return undefined;
  }

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
    if (doc.text !== classified.bodyText) {
      summary.refused.push(`${entry.file}: decoder disagreement on the note's current text - refusing to edit`);
      return undefined;
    }
    applyTextEdit(doc, localText, { replicaId });
    const compressed = compressNoteDocument(encodeNoteDocument(doc));
    if (decodeNoteBodyText(compressed) !== localText) {
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
