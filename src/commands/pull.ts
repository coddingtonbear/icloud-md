import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { fetchAllNoteRecords } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName } from "../notes/filename.js";
import { hashNoteContent } from "../notes/contentHash.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import type { IcloudSession } from "../session.js";

interface PullSummary {
  added: number;
  updated: number;
  removed: number;
  skippedNewUnsyncable: number;
  droppedUnsyncable: number;
  conflicts: string[];
}

/**
 * Whether a tracked note's local file still matches what we last wrote.
 * "missing" is distinguished from "modified" so callers can treat a
 * vanished file (nothing to lose) differently from a hand-edited one
 * (something to protect).
 */
type LocalFileState = "clean" | "modified" | "missing";

export async function runPull(session: IcloudSession, targetDir: string): Promise<void> {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new Error(
      `${targetDir} doesn't look like a cloned notes directory (no .icloud-notes-sync/state.json) - run "clone" first.`,
    );
  }

  const auth = await checkAuthentication(session);
  if (!auth.ok) {
    throw new Error(`Not authenticated (HTTP ${auth.status}): ${auth.error}`);
  }
  if (!auth.ckdatabasewsUrl) {
    throw new Error("Authenticated, but the account reported no ckdatabasews host - can't reach Notes.");
  }

  const { records, syncToken } = await fetchAllNoteRecords(session, auth.ckdatabasewsUrl, auth.dsid, state.syncToken);

  const notes: CloneState["notes"] = { ...state.notes };
  const usedFileNames = new Set(Object.values(state.notes).map((entry) => entry.file));
  const summary: PullSummary = {
    added: 0,
    updated: 0,
    removed: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    conflicts: [],
  };

  for (const record of records) {
    if (record.recordType !== "Note") {
      continue;
    }

    const existing = notes[record.recordName];
    const decoded = classifyNoteRecord(record);

    if (decoded.status === "deleted") {
      if (!existing) {
        continue;
      }
      const local = await localFileState(targetDir, existing);
      if (local === "modified") {
        summary.conflicts.push(`${existing.file}: deleted remotely, but has local edits - left in place, untracked`);
        delete notes[record.recordName];
        continue;
      }
      if (local === "clean") {
        await safeUnlink(path.join(targetDir, existing.file));
      }
      delete notes[record.recordName];
      summary.removed += 1;
      continue;
    }

    if (decoded.status === "unsyncable") {
      if (!existing) {
        summary.skippedNewUnsyncable += 1;
        continue;
      }
      const local = await localFileState(targetDir, existing);
      if (local === "modified") {
        summary.conflicts.push(
          `${existing.file}: became unsyncable remotely (${decoded.reason}), and has local edits - left in place, untracked`,
        );
      } else {
        summary.droppedUnsyncable += 1;
        if (local === "clean") {
          console.warn(
            `${existing.file}: no longer syncable remotely (${decoded.reason}) - leaving existing local copy but no longer tracking it`,
          );
        }
      }
      delete notes[record.recordName];
      continue;
    }

    // decoded.status === "ok"
    if (!existing) {
      const fileName = noteFileName(decoded.title, record.recordName);
      if (usedFileNames.has(fileName)) {
        throw new Error(`Filename collision on "${fileName}" while pulling a new note.`);
      }
      usedFileNames.add(fileName);

      await writeFile(path.join(targetDir, fileName), decoded.bodyText, "utf-8");
      notes[record.recordName] = {
        file: fileName,
        recordChangeTag: record.recordChangeTag ?? "",
        modificationDate: modificationDateOf(record),
        contentHash: hashNoteContent(decoded.bodyText),
      };
      summary.added += 1;
      continue;
    }

    const local = await localFileState(targetDir, existing);
    if (local === "modified") {
      summary.conflicts.push(`${existing.file}: changed both locally and remotely - left local copy untouched`);
      continue;
    }

    await writeFile(path.join(targetDir, existing.file), decoded.bodyText, "utf-8");
    if (local === "missing") {
      console.log(`Recreated ${existing.file} (was missing locally)`);
    }
    notes[record.recordName] = {
      ...existing,
      recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
      modificationDate: modificationDateOf(record),
      contentHash: hashNoteContent(decoded.bodyText),
    };
    summary.updated += 1;
  }

  await writeCloneState(targetDir, { syncToken, notes });

  console.log(`Pulled into ${targetDir}: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed`);
  if (summary.skippedNewUnsyncable > 0 || summary.droppedUnsyncable > 0) {
    console.log(
      `${summary.skippedNewUnsyncable} new unsyncable note(s) skipped, ${summary.droppedUnsyncable} note(s) dropped from tracking (no longer syncable)`,
    );
  }
  if (summary.conflicts.length > 0) {
    console.log(`${summary.conflicts.length} conflict(s) - left untouched, resolve manually:`);
    for (const conflict of summary.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }
}

async function localFileState(targetDir: string, entry: CloneStateNoteEntry): Promise<LocalFileState> {
  let content: string;
  try {
    content = await readFile(path.join(targetDir, entry.file), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return "missing";
    }
    throw cause;
  }
  return hashNoteContent(content) === entry.contentHash ? "clean" : "modified";
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

function modificationDateOf(record: { fields: Record<string, { value: unknown } | undefined> }): number {
  const field = record.fields.ModificationDate;
  return typeof field?.value === "number" ? field.value : 0;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
