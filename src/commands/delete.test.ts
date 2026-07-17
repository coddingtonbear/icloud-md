import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { UnboundAccountError, UntrackedFileError } from "../errors.js";
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

// state() has no `account`, so reaching resolveFolderAccount throws
// UnboundAccountError - here that's the *desired* signal: an
// attachment-bearing note is no longer refused locally (deletion is now a
// trash-move update, which works regardless of attachments - see the
// 2026-07-16 lifecycle HAR analysis), so the delete proceeds toward the
// network.
test("runDelete no longer refuses a note with attachments locally - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, state());
    await assert.rejects(() => runDelete(dir, "Test Note.md"), UnboundAccountError);
  }));

// The trash registry: a note this tool already soft-deleted has no file and
// no notes entry left, but stays resolvable...
test("runDelete --hard resolves a note through the trash registry and proceeds to the network", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.notes = {};
    s.trashed = { REC1: { file: "Test Note.md", trashedAt: 123 } };
    await writeCloneState(dir, s);
    await assert.rejects(() => runDelete(dir, "Test Note.md", { hard: true }), UnboundAccountError);
  }));

// ...but only for --hard: a plain delete of an already-trashed note is a
// no-op the user should be told about, not a resolvable target.
test("runDelete without --hard refuses a note that's only in the trash registry, with a --hard hint", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.notes = {};
    s.trashed = { REC1: { file: "Test Note.md", trashedAt: 123 } };
    await writeCloneState(dir, s);
    await assert.rejects(
      () => runDelete(dir, "Test Note.md"),
      (error: unknown) => error instanceof UntrackedFileError && /delete --hard/.test(error.hint ?? ""),
    );
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
