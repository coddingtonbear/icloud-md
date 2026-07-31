import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import type { CloneState, CloneStateNoteEntry } from "../notes/cloneState.js";
import { reconcileNotesAfterResync, type PullSummary } from "./pull.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-resync-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeVaultFile(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf-8");
}

async function fileExists(dir: string, file: string): Promise<boolean> {
  try {
    await access(path.join(dir, file));
    return true;
  } catch {
    return false;
  }
}

function emptySummary(): PullSummary {
  return {
    added: 0,
    updated: 0,
    merged: 0,
    removed: 0,
    attachmentsDownloaded: 0,
    unpublishable: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    unsharedUntracked: 0,
    changes: [],
    conflicts: [],
    notices: [],
  };
}

function entryFor(file: string, sharedZoneOwner?: string): CloneStateNoteEntry {
  return { file, recordChangeTag: "1a", modificationDate: 100, sharedZoneOwner };
}

// A tracked note whose record appears nowhere in a from-scratch listing was
// deleted remotely while the vault's sync token was unusable - a full resend
// carries no tombstone for it, so absence is the only signal there is.

test("a clean tracked note absent from a resynced listing is removed like a tombstoned one", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Gone.md", "body\n");
    await writeBaseCopy(dir, "REC-GONE", "body\n");
    await writeVaultFile(dir, "Notes/Kept.md", "kept body\n");
    await writeBaseCopy(dir, "REC-KEPT", "kept body\n");
    const notes: CloneState["notes"] = {
      "REC-GONE": entryFor("Notes/Gone.md"),
      "REC-KEPT": entryFor("Notes/Kept.md"),
    };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(["REC-KEPT"]), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(notes["REC-GONE"], undefined);
    assert.ok(notes["REC-KEPT"]);
    assert.equal(await fileExists(dir, "Notes/Gone.md"), false);
    assert.equal(await fileExists(dir, "Notes/Kept.md"), true);
    assert.equal(summary.removed, 1);
    assert.deepEqual(summary.changes, [{ kind: "remove", file: "Notes/Gone.md" }]);
  }));

test("an absent note with local edits becomes a delete/modify conflict and stays tracked", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Edited.md", "body plus my local edit\n");
    await writeBaseCopy(dir, "REC-EDITED", "body\n");
    const notes: CloneState["notes"] = { "REC-EDITED": entryFor("Notes/Edited.md") };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    // Still tracked, file still present, conflict surfaced - never a silent
    // discard of local edits.
    assert.ok(notes["REC-EDITED"]);
    assert.equal(await fileExists(dir, "Notes/Edited.md"), true);
    const written = await readFile(path.join(dir, "Notes/Edited.md"), "utf-8");
    assert.match(written, /<<<<<<< local/);
    assert.equal(summary.conflicts.length, 1);
    assert.match(summary.conflicts[0] ?? "", /deleted remotely/);
  }));

test("reconciliation is scoped to one zone: the private pass never touches shared-zone notes, nor one sharer's pass another's", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Private.md", "private body\n");
    await writeBaseCopy(dir, "REC-PRIVATE", "private body\n");
    await writeVaultFile(dir, "Notes/SharedA.md", "shared body a\n");
    await writeBaseCopy(dir, "REC-SHARED-A", "shared body a\n");
    await writeVaultFile(dir, "Notes/SharedB.md", "shared body b\n");
    await writeBaseCopy(dir, "REC-SHARED-B", "shared body b\n");
    const notes: CloneState["notes"] = {
      "REC-PRIVATE": entryFor("Notes/Private.md"),
      "REC-SHARED-A": entryFor("Notes/SharedA.md", "_ownerA"),
      "REC-SHARED-B": entryFor("Notes/SharedB.md", "_ownerB"),
    };
    const summary = emptySummary();

    // _ownerA's zone was resynced and its listing is empty: only that zone's
    // note may be reconciled away, however absent the others are from it.
    const removed = await reconcileNotesAfterResync(dir, "_ownerA", new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(notes["REC-SHARED-A"], undefined);
    assert.ok(notes["REC-PRIVATE"]);
    assert.ok(notes["REC-SHARED-B"]);
    assert.equal(await fileExists(dir, "Notes/Private.md"), true);
    assert.equal(await fileExists(dir, "Notes/SharedB.md"), true);
  }));

test("a note present in the listing under a non-Note record type is not misread as deleted", () =>
  withTempDir(async (dir) => {
    // e.g. a note that was password-protected: same recordName, new record
    // type. The seen-set is built from every record in the listing, so it
    // still counts as present.
    await writeVaultFile(dir, "Notes/Locked.md", "locked body\n");
    await writeBaseCopy(dir, "REC-LOCKED", "locked body\n");
    const notes: CloneState["notes"] = { "REC-LOCKED": entryFor("Notes/Locked.md") };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(["REC-LOCKED"]), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 0);
    assert.ok(notes["REC-LOCKED"]);
    assert.equal(await fileExists(dir, "Notes/Locked.md"), true);
    assert.deepEqual(summary.changes, []);
  }));

test("a reconciled deletion also drops the note's attachment tracking and files", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/WithAttachment.md", "body\n");
    await writeBaseCopy(dir, "REC-NOTE", "body\n");
    await writeVaultFile(dir, "Notes/attachments/pic.png", "png-bytes");
    const notes: CloneState["notes"] = { "REC-NOTE": entryFor("Notes/WithAttachment.md") };
    const attachments: NonNullable<CloneState["attachments"]> = {
      "REC-ATTACHMENT": {
        file: "Notes/attachments/pic.png",
        mediaRecordName: "REC-MEDIA",
        mediaFileChecksum: "checksum",
        noteRecordName: "REC-NOTE",
      },
    };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(), notes, attachments, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(attachments["REC-ATTACHMENT"], undefined);
    assert.equal(await fileExists(dir, "Notes/attachments/pic.png"), false);
  }));
