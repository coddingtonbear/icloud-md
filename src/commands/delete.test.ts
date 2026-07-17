import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { NoteHasAttachmentsError, UntrackedFileError } from "../errors.js";
import { applyLocalNoteDeletion, runDelete } from "./delete.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "delete-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function state(): CloneState {
  return {
    syncToken: "token",
    notes: {
      REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
    },
    attachments: {
      ATT1: { file: "attachments/keep.jpg", mediaRecordName: "MEDIA1", mediaFileChecksum: "abc", noteRecordName: "REC1" },
    },
    tableAttachments: {
      "ATT-TABLE-1": { noteRecordName: "REC1" },
    },
  };
}

test("runDelete refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runDelete(dir, "Test Note.md"), /doesn't look like a cloned notes directory/);
  }));

test("runDelete refuses a file that isn't a tracked note, without touching the network", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, state());
    await assert.rejects(() => runDelete(dir, "Nonexistent.md"), UntrackedFileError);
  }));

// state() has no `account` - if either of these reached resolveFolderAccount
// it would throw UnboundAccountError instead, proving CloudKit's
// VALIDATING_REFERENCE_ERROR (confirmed live 2026-07-16: forceDelete refuses
// a Note that still has an Attachment record pointing at it) is caught
// locally, before any network round-trip.
test("runDelete refuses locally when the note has a tracked (regular) attachment", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, state());
    await assert.rejects(() => runDelete(dir, "Test Note.md"), NoteHasAttachmentsError);
  }));

test("runDelete refuses locally when the note has a tracked table attachment", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {};
    await writeCloneState(dir, s);
    await assert.rejects(() => runDelete(dir, "Test Note.md"), NoteHasAttachmentsError);
  }));

test("applyLocalNoteDeletion removes a clean local file and drops all tracking for the note", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeFile(path.join(dir, "Test Note.md"), "Synced text", "utf-8");

    const result = await applyLocalNoteDeletion(dir, "REC1", s.notes.REC1!, s);

    assert.equal(result, "clean");
    assert.equal(s.notes.REC1, undefined);
    assert.deepEqual(s.attachments, {});
    assert.deepEqual(s.tableAttachments, {});
    await assert.rejects(() => readFile(path.join(dir, "Test Note.md"), "utf-8"), /ENOENT/);
  }));

test("applyLocalNoteDeletion keeps a locally-modified file on disk but still untracks it", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeFile(path.join(dir, "Test Note.md"), "Local edit not yet pushed", "utf-8");

    const result = await applyLocalNoteDeletion(dir, "REC1", s.notes.REC1!, s);

    assert.equal(result, "modified");
    assert.equal(s.notes.REC1, undefined);
    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), "Local edit not yet pushed");
  }));

test("applyLocalNoteDeletion tolerates a local file that's already missing", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");

    const result = await applyLocalNoteDeletion(dir, "REC1", s.notes.REC1!, s);

    assert.equal(result, "missing");
    assert.equal(s.notes.REC1, undefined);
  }));

test("applyLocalNoteDeletion only removes attachments/table attachments belonging to this note", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {
      ...s.attachments,
      ATT2: { file: "attachments/other.jpg", mediaRecordName: "MEDIA2", mediaFileChecksum: "def", noteRecordName: "REC-OTHER" },
    };
    s.tableAttachments = { ...s.tableAttachments, "ATT-TABLE-2": { noteRecordName: "REC-OTHER" } };
    await writeBaseCopy(dir, "REC1", "Synced text");

    await applyLocalNoteDeletion(dir, "REC1", s.notes.REC1!, s);

    assert.deepEqual(Object.keys(s.attachments), ["ATT2"]);
    assert.deepEqual(Object.keys(s.tableAttachments), ["ATT-TABLE-2"]);
  }));
