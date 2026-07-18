import { diffComm } from "node-diff3";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords, noteZone, type NoteZone } from "../cloudkit/databaseClient.js";
import { NotClonedDirectoryError, NotesUnavailableError, UnknownVersionSnapshotError, VersionContentUnavailableError } from "../errors.js";
import { decodeTableAttachment } from "../notes/attachmentSync.js";
import { readCloneState, type CloneState } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { decodeTableMarkdown } from "../notes/decodeTableRecord.js";
import { findEpochById, type NoteEpoch } from "../notes/noteEpoch.js";
import { decodeNoteBodyText } from "../notes/noteText.js";
import { findSnapshotById, historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import { listVersions, type VersionSnapshot } from "../notes/versionHistory.js";
import type { IcloudSession } from "../session.js";

/**
 * Diffs two renderings of the same note or table attachment - `fromId` is
 * always a snapshot id; `toId` is another snapshot id, or `undefined` to
 * mean "the current remote copy" (mirroring `git diff <commit>`'s implicit
 * comparison against the working tree). Both sides are decoded through the
 * same decoders `clone`/`pull` already use and diffed as rendered text -
 * meaningful to a human, unlike a binary diff of the raw protobuf.
 */
export async function runDiff(
  targetDir: string,
  fileArg: string,
  fromId: string,
  toId: string | undefined,
  onLoginStatus?: (message: string) => void,
): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }

  const { recordName, entry } = resolveTrackedNote(state, fileArg, targetDir);
  const recordNames = historyRecordNames(state, recordName);
  // A shared note's current copy lives in its sharer's zone; its table
  // attachments live there too, so one zone covers every record diffed here.
  const zone = noteZone(entry.sharedZoneOwner);

  let from: VersionSnapshot;
  try {
    from = await findSnapshotById(targetDir, recordNames, fromId, fileArg);
  } catch (cause) {
    if (!(cause instanceof UnknownVersionSnapshotError)) {
      throw cause;
    }
    // Not a per-record snapshot id - see if it's a whole-note epoch instead
    // (Option B from the epoch investigation: this lookup stays entirely
    // separate from `findSnapshotById` rather than widening its return type).
    const epoch = await findEpochById(targetDir, recordName, fromId);
    if (!epoch) {
      throw cause;
    }
    if (toId) {
      throw new VersionContentUnavailableError(
        `epoch-vs-epoch diff ("${fromId}..${toId}") isn't supported yet - diff a specific record's snapshots instead ` +
          `(run "icloud-md history ${fileArg} --records" for their ids), or diff the epoch against the current remote copy`,
      );
    }
    console.log(await renderEpochDiff(targetDir, state, recordName, zone, epoch, onLoginStatus));
    return;
  }
  const fromText = decodeSnapshotText(from);

  let toText: string;
  let toLabel: string;
  if (toId) {
    const to = await findSnapshotById(targetDir, recordNames, toId, fileArg);
    if (to.recordName !== from.recordName) {
      throw new VersionContentUnavailableError(
        `"${fromId}" and "${toId}" belong to different records - can't diff a note's text against a table's structure`,
      );
    }
    toText = decodeSnapshotText(to);
    toLabel = toId;
  } else {
    const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: onLoginStatus });
    if (!auth.ckdatabasewsUrl) {
      throw new NotesUnavailableError();
    }
    toText = await fetchCurrentText(auth.session, auth.ckdatabasewsUrl, auth.dsid, zone, from.recordName, from.recordType);
    toLabel = "current";
  }

  console.log(renderDiff(fromText, toText, fromId, toLabel));
}

/** Decodes a snapshot's raw bytes into the same rendered text form
 * `clone`/`pull` produce, so a diff compares meaningfully to a human
 * instead of the raw protobuf. */
export function decodeSnapshotText(snapshot: VersionSnapshot): string {
  const bytes = Buffer.from(snapshot.valueBase64, "base64");
  return snapshot.field === "TextDataEncrypted" ? decodeNoteBodyText(bytes) : decodeTableMarkdown(bytes);
}

/**
 * Concatenates a per-record diff (each snapshot in the epoch vs. its
 * record's current remote content) into one rendered report, labeled by
 * record type - the epoch equivalent of `renderDiff`. Auth is resolved
 * lazily, once, only if the epoch actually has a record worth fetching
 * (an epoch consisting entirely of null/missing snapshots never needs it).
 */
async function renderEpochDiff(
  targetDir: string,
  state: CloneState,
  noteRecordName: string,
  zone: NoteZone,
  epoch: NoteEpoch,
  onLoginStatus?: (message: string) => void,
): Promise<string> {
  let resolvedAuth: { session: IcloudSession; ckdatabasewsUrl: string; dsid: string } | undefined;
  const resolveAuth = async (): Promise<{ session: IcloudSession; ckdatabasewsUrl: string; dsid: string }> => {
    if (!resolvedAuth) {
      const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: onLoginStatus });
      if (!auth.ckdatabasewsUrl) {
        throw new NotesUnavailableError();
      }
      resolvedAuth = { session: auth.session, ckdatabasewsUrl: auth.ckdatabasewsUrl, dsid: auth.dsid };
    }
    return resolvedAuth;
  };

  const sections: string[] = [];
  for (const [recordName, snapshotId] of Object.entries(epoch.snapshots)) {
    const label = recordName === noteRecordName ? "note text" : `table ${recordName}`;
    if (snapshotId === null) {
      sections.push(`=== ${label} ===\n(no snapshot was ever captured for this record at this epoch - skipped)`);
      continue;
    }
    const snapshot = (await listVersions(targetDir, recordName)).find((candidate) => candidate.id === snapshotId);
    if (!snapshot) {
      sections.push(`=== ${label} ===\n(the recorded snapshot "${snapshotId}" no longer exists locally - skipped)`);
      continue;
    }

    try {
      const { session, ckdatabasewsUrl, dsid } = await resolveAuth();
      const toText = await fetchCurrentText(session, ckdatabasewsUrl, dsid, zone, recordName, snapshot.recordType);
      sections.push(`=== ${label} ===\n${renderDiff(decodeSnapshotText(snapshot), toText, epoch.id, "current")}`);
    } catch (cause) {
      if (!(cause instanceof VersionContentUnavailableError)) {
        throw cause;
      }
      sections.push(`=== ${label} ===\n(${cause.message})`);
    }
  }

  return sections.join("\n\n");
}

async function fetchCurrentText(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  zone: NoteZone,
  recordName: string,
  recordType: VersionSnapshot["recordType"],
): Promise<string> {
  const records = await lookupRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [recordName]);
  const record = records[0];
  if (!record || record.deleted === true) {
    throw new VersionContentUnavailableError(`"${recordName}" no longer exists remotely`);
  }
  if (recordType === "Note") {
    const classified = classifyNoteRecord(record);
    if (classified.status !== "ok") {
      throw new VersionContentUnavailableError("the current remote note isn't in a readable state");
    }
    return classified.bodyText;
  }
  const markdown = decodeTableAttachment(record);
  if (markdown === undefined) {
    throw new VersionContentUnavailableError("the current remote table isn't in a readable state");
  }
  return markdown;
}

/** Renders a unified-diff-style comparison of two texts using node-diff3's
 * plain two-way `diffComm` (already a dependency via `mergeConflict.ts`'s
 * 3-way merge, so this needs nothing new). */
export function renderDiff(fromText: string, toText: string, fromLabel: string, toLabel: string): string {
  const segments = diffComm(fromText.split("\n"), toText.split("\n")) as Array<
    { common: string[] } | { buffer1: string[]; buffer2: string[] }
  >;

  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let changed = false;
  for (const segment of segments) {
    if ("common" in segment) {
      for (const line of segment.common) {
        lines.push(`  ${line}`);
      }
      continue;
    }
    changed = true;
    for (const line of segment.buffer1) {
      lines.push(`- ${line}`);
    }
    for (const line of segment.buffer2) {
      lines.push(`+ ${line}`);
    }
  }
  if (!changed) {
    lines.push("(no differences)");
  }
  return lines.join("\n");
}
