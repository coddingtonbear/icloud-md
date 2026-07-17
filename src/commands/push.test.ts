import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { NotClonedDirectoryError, UnboundAccountError } from "../errors.js";
import { buildPushPlan, runPush } from "./push.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "push-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A folder-layout vault: the default "Notes" folder, an own "Recipes"
 * folder, and a sharer ("Pat") with one shared folder. */
function state(): CloneState {
  return {
    syncToken: "token",
    folders: {
      "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" },
      "F-RECIPES": { name: "Recipes", dirName: "Recipes" },
      "F-SHARED": { name: "Shared Recipes", dirName: "Shared Recipes", sharedZoneOwner: "_owner1" },
    },
    sharerHomes: { _owner1: { name: "Pat", dirName: "Pat" } },
    notes: {
      REC1: {
        file: "Notes/Tracked.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        folderRecordName: "DefaultFolder-CloudKit",
      },
    },
  };
}

/** state() minus the tracked note - for tests where any missing tracked
 * file would drag the plan to the network. */
function emptyState(): CloneState {
  return { ...state(), notes: {} };
}

async function writeVaultFile(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf-8");
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

test("buildPushPlan refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => buildPushPlan(dir), NotClonedDirectoryError);
  }));

test("buildPushPlan treats an untracked .md inside a known folder as a real create candidate - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    // No `account` on state - the UnboundAccountError proves the file passed
    // every local gate and the plan went on to need a session for the create.
    await writeCloneState(dir, state());
    await writeVaultFile(dir, "Recipes/New Note.md", "Hello");

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses a loose top-level .md locally - every note must be in a folder", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Loose.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /outside any folder/);
  }));

test("buildPushPlan refuses a .md in a directory that isn't one of the account's folders", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Brand New Folder/Note.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /"Brand New Folder\/"/);
    assert.match(entries[0]?.reason ?? "", /creating folders isn't supported yet/);
  }));

test("buildPushPlan refuses a new .md inside a sharer's area", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Pat/Shared Recipes/Mine.md", "Hello");
    await writeVaultFile(dir, "Pat/Loose.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.resolution, "refused");
      assert.match(entry.reason ?? "", /sharer's area/);
    }
  }));

test("buildPushPlan refuses an empty untracked file locally, without touching the network", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Notes/Empty.md", "");

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, [
      { kind: "create", file: "Notes/Empty.md", resolution: "refused", reason: "the file is empty - nothing to create" },
    ]);
  }));

test("buildPushPlan refuses an untracked file with conflict markers locally - same gate as a modified file", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Notes/Conflicted.md", "a\n<<<<<<< local\nb\n=======\nc\n>>>>>>> remote\n");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /conflict markers/);
  }));

test("buildPushPlan refuses an untracked file referencing attachments locally", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Notes/HasAttachment.md", "Look:\n\n![pic](attachments/pic.jpg)\n");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /attachments/);
  }));

test("buildPushPlan ignores a file already tracked in state.notes", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, []);
  }));

test("buildPushPlan ignores .md files inside attachments directories", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeVaultFile(dir, "Notes/attachments/Nested.md", "Hello");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, []);
  }));

test("buildPushPlan requires a live check for a missing tracked file (a delete candidate) - reaches the network and fails without a bound account", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    // Notes/Tracked.md deliberately not written - "missing" locally.
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan pairs a missing tracked file with an identical untracked one as a move - it proceeds to the network, not to delete+create", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    // Tracked.md is gone from Notes/ and sits, byte-identical, in Recipes/.
    await writeVaultFile(dir, "Recipes/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    // A valid move target needs the live staleness check - the
    // UnboundAccountError proves the pair got that far.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses a local move into an unknown directory, locally, as a move (not a delete + create)", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Nowhere/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.previousFile, "Notes/Tracked.md");
    assert.equal(entries[0]?.file, "Nowhere/Tracked.md");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /isn't one of the account's folders/);
  }));

test("buildPushPlan pairs a moved-and-edited note by unique basename", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    // Same basename, different content (edited after the move), in an
    // unknown directory so the pairing outcome is visible without network.
    await writeVaultFile(dir, "Nowhere/Tracked.md", "Edited after moving");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.previousFile, "Notes/Tracked.md");
  }));

test("buildPushPlan refuses moving a note that has tracked attachments, locally", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {
      ATT1: {
        file: "Notes/attachments/pic.jpg",
        mediaRecordName: "MEDIA1",
        mediaFileChecksum: "abc",
        noteRecordName: "REC1",
      },
    };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Recipes/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /has attachments/);
  }));

// Deletion is a trash-move update as of the 2026-07-16 HAR analysis, which
// works regardless of attachments - so an attachment-bearing delete
// candidate is no longer refused locally. state() has no `account`, so the
// UnboundAccountError proves the plan proceeds toward the network instead
// of resolving to a local refusal.
test("buildPushPlan no longer refuses deleting a note with a tracked attachment - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.attachments = {
      ATT1: {
        file: "Notes/attachments/keep.jpg",
        mediaRecordName: "MEDIA1",
        mediaFileChecksum: "abc",
        noteRecordName: "REC1",
      },
    };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan no longer refuses deleting a note with a tracked table attachment - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    const s = state();
    s.tableAttachments = { "ATT-TABLE-1": { noteRecordName: "REC1" } };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("runPush prints \"Nothing to push.\" and doesn't rewrite state.json when the plan is empty", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const { lines, restore } = captureLogs();
    try {
      await runPush(dir);
    } finally {
      restore();
    }

    assert.deepEqual(lines, ["Nothing to push."]);
  }));
