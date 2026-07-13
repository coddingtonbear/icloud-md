import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { fetchAllNoteRecords } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName } from "../notes/filename.js";
import { writeBaseCopy } from "../notes/baseCopy.js";
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

    const decoded = classifyNoteRecord(record);
    if (decoded.status === "deleted") {
      summary.skippedDeleted += 1;
      continue;
    }
    if (decoded.status === "unsyncable") {
      if (decoded.reason === "attachment") {
        summary.skippedAttachment += 1;
      } else {
        summary.skippedUndecodable += 1;
      }
      continue;
    }

    const fileName = noteFileName(decoded.title, record.recordName);
    if (usedFileNames.has(fileName)) {
      throw new Error(`Filename collision on "${fileName}" - two different notes produced the same file name.`);
    }
    usedFileNames.add(fileName);

    await writeFile(path.join(targetDir, fileName), decoded.bodyText, "utf-8");
    await writeBaseCopy(targetDir, record.recordName, decoded.bodyText);
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
