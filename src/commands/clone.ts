import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { fetchAllNoteRecords, type CloudKitFieldValue, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import { decodeNoteBodyText } from "../notes/noteText.js";
import { noteFileName } from "../notes/filename.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import type { IcloudSession } from "../session.js";

interface CloneSummary {
  written: number;
  skippedAttachment: number;
  skippedDeleted: number;
  skippedUndecodable: number;
}

export async function runClone(session: IcloudSession, targetDir: string): Promise<void> {
  const auth = await checkAuthentication(session);
  if (!auth.ok) {
    throw new Error(`Not authenticated (HTTP ${auth.status}): ${auth.error}`);
  }
  if (!auth.ckdatabasewsUrl) {
    throw new Error("Authenticated, but the account reported no ckdatabasews host - can't reach Notes.");
  }

  await mkdir(targetDir, { recursive: true });

  const { records, syncToken } = await fetchAllNoteRecords(session, auth.ckdatabasewsUrl, auth.dsid);

  const summary: CloneSummary = { written: 0, skippedAttachment: 0, skippedDeleted: 0, skippedUndecodable: 0 };
  const notes: CloneState["notes"] = {};
  const usedFileNames = new Set<string>();

  for (const record of records) {
    if (record.recordType !== "Note") {
      continue;
    }
    if (isDeleted(record)) {
      summary.skippedDeleted += 1;
      continue;
    }
    if (hasAttachment(record)) {
      summary.skippedAttachment += 1;
      continue;
    }

    const textField = record.fields.TextDataEncrypted;
    if (!textField || typeof textField.value !== "string") {
      summary.skippedUndecodable += 1;
      continue;
    }

    let bodyText: string;
    try {
      bodyText = decodeNoteBodyText(Buffer.from(textField.value, "base64"));
    } catch {
      summary.skippedUndecodable += 1;
      continue;
    }

    const title = decodeTitleField(record.fields.TitleEncrypted);
    const fileName = noteFileName(title, record.recordName);
    if (usedFileNames.has(fileName)) {
      throw new Error(`Filename collision on "${fileName}" - two different notes produced the same file name.`);
    }
    usedFileNames.add(fileName);

    await writeFile(path.join(targetDir, fileName), bodyText, "utf-8");
    summary.written += 1;

    const modificationField = record.fields.ModificationDate;
    const modificationDate = typeof modificationField?.value === "number" ? modificationField.value : 0;

    notes[record.recordName] = {
      file: fileName,
      recordChangeTag: record.recordChangeTag ?? "",
      modificationDate,
    };
  }

  await writeCloneState(targetDir, { syncToken, notes });

  console.log(`Cloned ${summary.written} notes into ${targetDir}`);
  console.log(
    `Skipped: ${summary.skippedAttachment} with attachments, ${summary.skippedDeleted} deleted, ` +
      `${summary.skippedUndecodable} undecodable`,
  );
}

const TRASH_FOLDER_RECORD_NAME = "TrashFolder-CloudKit";

function isDeleted(record: CloudKitRecord): boolean {
  if (record.deleted === true) {
    return true;
  }
  const deletedField = record.fields.Deleted;
  if (typeof deletedField?.value === "number" && deletedField.value !== 0) {
    return true;
  }
  // A note sitting in Trash isn't marked Deleted=1 until it's purged, but it's
  // not a live note either - treat it the same way for clone purposes.
  const folderField = record.fields.Folder;
  const folder = isRecord(folderField?.value) ? folderField.value : undefined;
  return folder?.recordName === TRASH_FOLDER_RECORD_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasAttachment(record: CloudKitRecord): boolean {
  return Object.values(record.fields).some((field) => field.type === "ASSETID");
}

function decodeTitleField(field: CloudKitFieldValue | undefined): string {
  if (!field || typeof field.value !== "string") {
    return "";
  }
  return Buffer.from(field.value, "base64").toString("utf-8");
}
