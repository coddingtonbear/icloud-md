import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UnknownVersionSnapshotError, UntrackedFileError } from "../errors.js";
import type { CloneState } from "./cloneState.js";
import { findSnapshotById, historyRecordNames, resolveTrackedNote } from "./trackedFile.js";
import { listVersions, recordVersion } from "./versionHistory.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "trackedfile-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATE: CloneState = {
  syncToken: "token",
  notes: {
    REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
  },
  tableAttachments: {
    "ATT-1": { noteRecordName: "REC1" },
    "ATT-2": { noteRecordName: "REC-OTHER" },
  },
};

test("resolveTrackedNote finds a note by exact file name", () => {
  const { recordName, entry } = resolveTrackedNote(STATE, "Test Note.md", "/vault");
  assert.equal(recordName, "REC1");
  assert.equal(entry.file, "Test Note.md");
});

test("resolveTrackedNote matches by base name when given a path", () => {
  const { recordName } = resolveTrackedNote(STATE, "/some/path/Test Note.md", "/vault");
  assert.equal(recordName, "REC1");
});

test("resolveTrackedNote throws UntrackedFileError for an unknown file", () => {
  assert.throws(() => resolveTrackedNote(STATE, "Nonexistent.md", "/vault"), UntrackedFileError);
});

test("historyRecordNames includes the note's own recordName plus its table attachments only", () => {
  assert.deepEqual(historyRecordNames(STATE, "REC1"), ["REC1", "ATT-1"]);
});

test("historyRecordNames returns just the note's recordName when it has no table attachments", () => {
  assert.deepEqual(historyRecordNames(STATE, "REC-NO-TABLES"), ["REC-NO-TABLES"]);
});

test("findSnapshotById locates a snapshot across multiple recordNames", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, {
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag",
      valueBase64: "AAAA",
      noteRecordName: "REC1",
    });
    const [expected] = await listVersions(dir, "ATT-1");

    const found = await findSnapshotById(dir, ["REC1", "ATT-1"], expected!.id, "Test Note.md");
    assert.equal(found.recordName, "ATT-1");
    assert.equal(found.valueBase64, "AAAA");
  }));

test("findSnapshotById throws UnknownVersionSnapshotError when no recordName has a matching snapshot", () =>
  withTempDir(async (dir) => {
    await assert.rejects(
      () => findSnapshotById(dir, ["REC1", "ATT-1"], "missing-id", "Test Note.md"),
      UnknownVersionSnapshotError,
    );
  }));
