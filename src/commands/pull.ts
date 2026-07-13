import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkAuthentication } from "../cloudkit/setupClient.js";
import { fetchAllNoteRecords, type CloudKitRecord } from "../cloudkit/databaseClient.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import { noteFileName } from "../notes/filename.js";
import { mergeNoteVersions } from "../notes/mergeConflict.js";
import { readBaseCopy, removeBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { readCloneState, writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import type { IcloudSession } from "../session.js";

interface PullSummary {
  added: number;
  updated: number;
  merged: number;
  removed: number;
  skippedNewUnsyncable: number;
  droppedUnsyncable: number;
  conflicts: string[];
}

/**
 * Whether a tracked note's local file still matches its base copy (the last
 * known synced/merged content). "missing" is distinguished from "modified"
 * so callers can treat a vanished file (nothing to lose) differently from a
 * hand-edited one (something to protect via a real 3-way merge).
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
    merged: 0,
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
      await handleRemoteDeletion(targetDir, record, existing, notes, summary);
      continue;
    }

    if (decoded.status === "unsyncable") {
      if (!existing) {
        summary.skippedNewUnsyncable += 1;
        continue;
      }
      const local = await localFileState(targetDir, existing, record.recordName);
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
      await removeBaseCopy(targetDir, record.recordName);
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
      await writeBaseCopy(targetDir, record.recordName, decoded.bodyText);
      notes[record.recordName] = {
        file: fileName,
        recordChangeTag: record.recordChangeTag ?? "",
        modificationDate: modificationDateOf(record),
      };
      summary.added += 1;
      continue;
    }

    const local = await localFileState(targetDir, existing, record.recordName);
    if (local === "clean" || local === "missing") {
      await writeFile(path.join(targetDir, existing.file), decoded.bodyText, "utf-8");
      await writeBaseCopy(targetDir, record.recordName, decoded.bodyText);
      if (local === "missing") {
        console.log(`Recreated ${existing.file} (was missing locally)`);
      }
      notes[record.recordName] = {
        ...existing,
        recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
        modificationDate: modificationDateOf(record),
      };
      summary.updated += 1;
      continue;
    }

    // local === "modified": real 3-way merge against the base copy.
    const base = (await readBaseCopy(targetDir, record.recordName)) ?? "";
    const localContent = await readFile(path.join(targetDir, existing.file), "utf-8");
    const outcome = mergeNoteVersions(base, localContent, decoded.bodyText);

    await writeFile(path.join(targetDir, existing.file), outcome.text, "utf-8");
    notes[record.recordName] = {
      ...existing,
      recordChangeTag: record.recordChangeTag ?? existing.recordChangeTag,
      modificationDate: modificationDateOf(record),
    };

    if (outcome.hasConflict) {
      summary.conflicts.push(`${existing.file}: merged with conflict markers - resolve manually`);
      // Base copy deliberately NOT advanced: it stays the merge ancestor
      // until the conflict markers are actually resolved, so the next pull
      // (if this note changes again) merges against the right common point.
    } else {
      await writeBaseCopy(targetDir, record.recordName, outcome.text);
      summary.merged += 1;
    }
  }

  await writeCloneState(targetDir, { syncToken, notes });

  console.log(
    `Pulled into ${targetDir}: ${summary.added} added, ${summary.updated} updated, ${summary.merged} auto-merged, ` +
      `${summary.removed} removed`,
  );
  if (summary.skippedNewUnsyncable > 0 || summary.droppedUnsyncable > 0) {
    console.log(
      `${summary.skippedNewUnsyncable} new unsyncable note(s) skipped, ${summary.droppedUnsyncable} note(s) ` +
        "dropped from tracking (no longer syncable)",
    );
  }
  if (summary.conflicts.length > 0) {
    console.log(`${summary.conflicts.length} conflict(s) - resolve manually:`);
    for (const conflict of summary.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }
}

async function handleRemoteDeletion(
  targetDir: string,
  record: CloudKitRecord,
  existing: CloneStateNoteEntry,
  notes: CloneState["notes"],
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
    summary.removed += 1;
    return;
  }

  // A delete/modify conflict is never auto-resolved either direction - merge
  // against an empty remote so the markers show exactly what local kept.
  const base = (await readBaseCopy(targetDir, record.recordName)) ?? "";
  const localContent = await readFile(path.join(targetDir, existing.file), "utf-8");
  const outcome = mergeNoteVersions(base, localContent, "");

  await writeFile(path.join(targetDir, existing.file), outcome.text, "utf-8");
  summary.conflicts.push(`${existing.file}: deleted remotely, but has local edits - merged with conflict markers, resolve manually`);
  // Keep tracking (state entry + base copy) so this doesn't silently drop
  // out of state.json; there's no new recordChangeTag to advance to since
  // the record no longer exists remotely.
}

async function localFileState(
  targetDir: string,
  entry: CloneStateNoteEntry,
  recordName: string,
): Promise<LocalFileState> {
  let content: string;
  try {
    content = await readFile(path.join(targetDir, entry.file), "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return "missing";
    }
    throw cause;
  }

  const base = await readBaseCopy(targetDir, recordName);
  if (base === undefined) {
    // No base copy on disk for a tracked note shouldn't normally happen, but
    // if it does, we can't verify cleanliness - treat conservatively.
    return "modified";
  }
  return content === base ? "clean" : "modified";
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

function modificationDateOf(record: CloudKitRecord): number {
  const field = record.fields.ModificationDate;
  return typeof field?.value === "number" ? field.value : 0;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
