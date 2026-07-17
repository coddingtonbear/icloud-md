import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AmbiguousTrackedFileError, UnknownVersionSnapshotError, UntrackedFileError } from "../errors.js";
import type { CloneState } from "./cloneState.js";
import { findSnapshotById, historyRecordNames, matchTrackedFile, resolveTrackedNote } from "./trackedFile.js";
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

const NESTED_STATE: CloneState = {
  syncToken: "token",
  notes: {
    "REC-PIE": { file: "Recipes/Pie.md", recordChangeTag: "1a", modificationDate: 100 },
    "REC-STANDUP": { file: "Work/Standup.md", recordChangeTag: "1b", modificationDate: 100 },
    "REC-NOTES-1": { file: "Recipes/Shared.md", recordChangeTag: "1c", modificationDate: 100 },
    "REC-NOTES-2": { file: "Work/Shared.md", recordChangeTag: "1d", modificationDate: 100 },
  },
};

test("matchTrackedFile resolves a bare name against the current directory, git-style", () => {
  const match = matchTrackedFile(NESTED_STATE.notes, "Pie.md", "/vault", "/vault/Recipes");
  assert.equal(match?.[0], "REC-PIE");
});

test("matchTrackedFile resolves a ../ path from a sibling directory", () => {
  const match = matchTrackedFile(NESTED_STATE.notes, "../Work/Standup.md", "/vault", "/vault/Recipes");
  assert.equal(match?.[0], "REC-STANDUP");
});

test("matchTrackedFile prefers the cwd-exact match when a bare name is also ambiguous elsewhere", () => {
  const match = matchTrackedFile(NESTED_STATE.notes, "Shared.md", "/vault", "/vault/Work");
  assert.equal(match?.[0], "REC-NOTES-2");
});

test("matchTrackedFile falls back to a unique basename from anywhere", () => {
  const match = matchTrackedFile(NESTED_STATE.notes, "Standup.md", "/vault", "/somewhere/else");
  assert.equal(match?.[0], "REC-STANDUP");
});

test("matchTrackedFile throws AmbiguousTrackedFileError when a bare name matches several notes", () => {
  assert.throws(
    () => matchTrackedFile(NESTED_STATE.notes, "Shared.md", "/vault", "/somewhere/else"),
    AmbiguousTrackedFileError,
  );
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
