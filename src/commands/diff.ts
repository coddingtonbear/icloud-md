import { diffComm } from "node-diff3";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import { lookupRecords } from "../cloudkit/databaseClient.js";
import { NotClonedDirectoryError, NotesUnavailableError, VersionContentUnavailableError } from "../errors.js";
import { decodeTableAttachment } from "../notes/attachmentSync.js";
import { readCloneState } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { decodeTableMarkdown } from "../notes/decodeTableRecord.js";
import { decodeNoteBodyText } from "../notes/noteText.js";
import { findSnapshotById, historyRecordNames, resolveTrackedNote } from "../notes/trackedFile.js";
import type { VersionSnapshot } from "../notes/versionHistory.js";
import type { IcloudSession } from "../session.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

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

  const { recordName } = resolveTrackedNote(state, fileArg, targetDir);
  const recordNames = historyRecordNames(state, recordName);

  const from = await findSnapshotById(targetDir, recordNames, fromId, fileArg);
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
    toText = await fetchCurrentText(auth.session, auth.ckdatabasewsUrl, auth.dsid, from.recordName, from.recordType);
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

async function fetchCurrentText(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  recordName: string,
  recordType: VersionSnapshot["recordType"],
): Promise<string> {
  const records = await lookupRecords(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, [recordName]);
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
