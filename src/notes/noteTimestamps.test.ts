import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { applyNoteFileTimes, creationDateOf, modificationDateOf } from "./noteTimestamps.js";

function recordWithDates(creation: number | undefined, modification: number | undefined): CloudKitRecord {
  return {
    recordName: "REC",
    recordType: "Note",
    fields: {
      ...(creation !== undefined ? { CreationDate: { value: creation, type: "TIMESTAMP" } } : {}),
      ...(modification !== undefined ? { ModificationDate: { value: modification, type: "TIMESTAMP" } } : {}),
    },
  };
}

async function withTempFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "notetimestamps-test-"));
  try {
    const filePath = path.join(dir, "note.md");
    await writeFile(filePath, "hello", "utf-8");
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("modificationDateOf/creationDateOf read the record's date fields", () => {
  const record = recordWithDates(1000, 2000);
  assert.equal(creationDateOf(record), 1000);
  assert.equal(modificationDateOf(record), 2000);
});

test("modificationDateOf/creationDateOf default to 0 when absent", () => {
  const record = recordWithDates(undefined, undefined);
  assert.equal(creationDateOf(record), 0);
  assert.equal(modificationDateOf(record), 0);
});

test("applyNoteFileTimes sets mtime/atime from the record's dates", () =>
  withTempFile(async (filePath) => {
    const record = recordWithDates(1_700_000_000_000, 1_750_000_000_000);
    await applyNoteFileTimes(filePath, record);

    const stats = await stat(filePath);
    assert.equal(stats.mtime.getTime(), 1_750_000_000_000);
    assert.equal(stats.atime.getTime(), 1_700_000_000_000);
  }));

test("applyNoteFileTimes falls back atime to mtime when there's no CreationDate", () =>
  withTempFile(async (filePath) => {
    const record = recordWithDates(undefined, 1_750_000_000_000);
    await applyNoteFileTimes(filePath, record);

    const stats = await stat(filePath);
    assert.equal(stats.mtime.getTime(), 1_750_000_000_000);
    assert.equal(stats.atime.getTime(), 1_750_000_000_000);
  }));

test("applyNoteFileTimes is a no-op when there's no ModificationDate", () =>
  withTempFile(async (filePath) => {
    const before = await stat(filePath);
    const record = recordWithDates(1_700_000_000_000, undefined);
    await applyNoteFileTimes(filePath, record);

    const after = await stat(filePath);
    assert.equal(after.mtime.getTime(), before.mtime.getTime());
  }));
