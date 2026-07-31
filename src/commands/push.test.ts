import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { localFileState } from "../notes/localFileState.js";
import { NotClonedDirectoryError, UnboundAccountError } from "../errors.js";
import { buildPushPlan, planRemoteChangedMerge, runPush } from "./push.js";

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

/** emptyState() with the shared folder's stored share permission set. */
function emptyStateWithSharedPermission(permission: string): CloneState {
  const base = emptyState();
  return {
    ...base,
    folders: {
      ...base.folders,
      "F-SHARED": { name: "Shared Recipes", dirName: "Shared Recipes", sharedZoneOwner: "_owner1", permission },
    },
  };
}

async function writeVaultFile(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf-8");
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

test("buildPushPlan treats a .md in an unknown directory as a real change, not a local refusal", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Brand New Folder/Note.md", "Hello");

    // The directory now becomes a Notes folder, so this is something to
    // push rather than something to refuse - which means it needs the
    // network, and an unbound vault can no longer answer locally. What the
    // folder plan itself contains is covered by folderCreate.test.ts.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses a new .md loose at the top of a sharer's home locally", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Pat/Loose.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /loose at the top of a sharer's area/);
  }));

test("buildPushPlan treats a new .md inside a shared folder as a real create candidate - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    // Same UnboundAccountError proof as the own-folder create test: the
    // shared-folder file passed every local gate (including the permission
    // one - F-SHARED's permission is unknown, which is attempted, not
    // refused) and the plan went on to need a session.
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Pat/Shared Recipes/Mine.md", "Hello");

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses a new .md in a READ_ONLY shared folder locally", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyStateWithSharedPermission("READ_ONLY"));
    await writeVaultFile(dir, "Pat/Shared Recipes/Mine.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /read access/);
  }));

test("buildPushPlan refuses an edit to a note in a READ_ONLY shared folder locally", () =>
  withTempDir(async (dir) => {
    const shared = emptyStateWithSharedPermission("READ_ONLY");
    shared.notes = {
      SH1: {
        file: "Pat/Shared Recipes/Theirs.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        folderRecordName: "F-SHARED",
        sharedZoneOwner: "_owner1",
      },
    };
    await writeCloneState(dir, shared);
    await writeBaseCopy(dir, "SH1", "Hello");
    await writeVaultFile(dir, "Pat/Shared Recipes/Theirs.md", "Hello edited");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "update");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /read-only for you/);
  }));

test("buildPushPlan treats an edit to a note in a writable shared folder as a real update candidate - it proceeds to the network", () =>
  withTempDir(async (dir) => {
    const shared = emptyStateWithSharedPermission("READ_WRITE");
    shared.notes = {
      SH1: {
        file: "Pat/Shared Recipes/Theirs.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        folderRecordName: "F-SHARED",
        sharedZoneOwner: "_owner1",
      },
    };
    await writeCloneState(dir, shared);
    await writeBaseCopy(dir, "SH1", "Hello");
    await writeVaultFile(dir, "Pat/Shared Recipes/Theirs.md", "Hello edited");

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan refuses an edit to an individually-shared note loose in a sharer's home", () =>
  withTempDir(async (dir) => {
    const shared = emptyState();
    shared.notes = {
      LOOSE1: {
        file: "Pat/Travel List.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        sharedZoneOwner: "_owner1",
      },
    };
    await writeCloneState(dir, shared);
    await writeBaseCopy(dir, "LOOSE1", "Hello");
    await writeVaultFile(dir, "Pat/Travel List.md", "Hello edited");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /individually-shared/);
  }));

test("buildPushPlan refuses a locally-deleted shared note without touching the network - never 'already deleted remotely'", () =>
  withTempDir(async (dir) => {
    const shared = emptyState();
    shared.notes = {
      SH1: {
        file: "Pat/Shared Recipes/Theirs.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        folderRecordName: "F-SHARED",
        sharedZoneOwner: "_owner1",
      },
    };
    await writeCloneState(dir, shared);
    // File deliberately never written - it reads as locally deleted.

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "delete");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /deleting notes shared by someone else isn't supported/);
    assert.match(entries[0]?.reason ?? "", /restore/);
  }));

test("buildPushPlan pairs a renamed shared-note file into a refused move - not a refused delete plus a duplicate create", () =>
  withTempDir(async (dir) => {
    const shared = emptyState();
    shared.notes = {
      SH1: {
        file: "Pat/Shared Recipes/Theirs.md",
        recordChangeTag: "1a",
        modificationDate: 100,
        folderRecordName: "F-SHARED",
        sharedZoneOwner: "_owner1",
      },
    };
    await writeCloneState(dir, shared);
    await writeBaseCopy(dir, "SH1", "Hello");
    await writeVaultFile(dir, "Pat/Shared Recipes/Renamed.md", "Hello");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.resolution, "refused");
    assert.equal(entries[0]?.previousFile, "Pat/Shared Recipes/Theirs.md");
    assert.match(entries[0]?.reason ?? "", /renaming or moving notes shared by someone else/);
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

test("buildPushPlan refuses a local move into a sharer's area, locally, as a move (not a delete + create)", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Pat/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.previousFile, "Notes/Tracked.md");
    assert.equal(entries[0]?.file, "Pat/Tracked.md");
    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /sharer's area/);
  }));

test("buildPushPlan pairs a moved-and-edited note by unique basename", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    // Same basename, different content (edited after the move), in an
    // unknown directory so the pairing outcome is visible without network.
    await writeVaultFile(dir, "Pat/Tracked.md", "Edited after moving");
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

// --- planRemoteChangedMerge: the remote-changed eager-merge state discipline
// (2026-07-29 device experiments - see the vault dev log). The invariant
// under test: the base copy always holds the REMOTE text afterward, so the
// merged file still reads "modified" and the re-run push actually uploads.

test("planRemoteChangedMerge keeps the merged file 'modified' - base copy holds the remote text, not the merged text", () =>
  withTempDir(async (dir) => {
    const s = state();
    const entry = s.notes.REC1!;
    await writeBaseCopy(dir, "REC1", "line one\n\nline two\n");
    await writeVaultFile(dir, "Notes/Tracked.md", "line one edited locally\n\nline two\n");

    const planEntry = await planRemoteChangedMerge(dir, s, "REC1", entry, "", "line one edited locally\n\nline two\n", {
      remoteText: "line one\n\nline two edited remotely\n",
      remoteTag: "2b",
    });

    assert.equal(planEntry.resolution, "conflict");
    assert.match(planEntry.reason ?? "", /re-run push to upload/);
    // The file holds the merged result of both sides...
    assert.equal(
      await readFile(path.join(dir, "Notes/Tracked.md"), "utf-8"),
      "line one edited locally\n\nline two edited remotely\n",
    );
    // ...the base copy holds what the SERVER has (the future merge ancestor)...
    assert.equal(await readBaseCopy(dir, "REC1"), "line one\n\nline two edited remotely\n");
    // ...so the note still reads modified and the re-run push uploads it.
    assert.equal(await localFileState(dir, s.notes.REC1!, "REC1"), "modified");
    assert.equal(s.notes.REC1?.recordChangeTag, "2b");
  }));

test("planRemoteChangedMerge with a tag-only remote bump (note open on a device) still leaves the local edit uploadable", () =>
  withTempDir(async (dir) => {
    // The live-reproduced stranding case: iOS re-uploaded its replica state
    // with IDENTICAL text (tag bump only) merely because the note was open.
    // The old code wrote the merged (= local) text as base, making the edit
    // read clean - it then never uploaded, and the next merge deleted it.
    const s = state();
    const entry = s.notes.REC1!;
    await writeBaseCopy(dir, "REC1", "shared text\n");
    await writeVaultFile(dir, "Notes/Tracked.md", "shared text plus my edit\n");

    await planRemoteChangedMerge(dir, s, "REC1", entry, "", "shared text plus my edit\n", {
      remoteText: "shared text\n",
      remoteTag: "2b",
    });

    assert.equal(await readFile(path.join(dir, "Notes/Tracked.md"), "utf-8"), "shared text plus my edit\n");
    assert.equal(await readBaseCopy(dir, "REC1"), "shared text\n");
    assert.equal(await localFileState(dir, s.notes.REC1!, "REC1"), "modified");
    assert.equal(s.notes.REC1?.recordChangeTag, "2b");
  }));

test("planRemoteChangedMerge preserves local-only frontmatter above the merged body", () =>
  withTempDir(async (dir) => {
    const s = state();
    const entry = s.notes.REC1!;
    await writeBaseCopy(dir, "REC1", "body\n");
    await writeVaultFile(dir, "Notes/Tracked.md", "---\nkeep: me\n---\n\nbody edited\n");

    await planRemoteChangedMerge(dir, s, "REC1", entry, "---\nkeep: me\n---\n\n", "body edited\n", {
      remoteText: "body\n",
      remoteTag: "2b",
    });

    const written = await readFile(path.join(dir, "Notes/Tracked.md"), "utf-8");
    assert.match(written, /^---\nkeep: me\n---\n/);
    assert.match(written, /body edited\n$/);
  }));

test("planRemoteChangedMerge on a genuine conflict writes markers and keeps the base copy as the merge ancestor", () =>
  withTempDir(async (dir) => {
    const s = state();
    const entry = s.notes.REC1!;
    await writeBaseCopy(dir, "REC1", "shared line\n");
    await writeVaultFile(dir, "Notes/Tracked.md", "shared line edited locally\n");

    const planEntry = await planRemoteChangedMerge(dir, s, "REC1", entry, "", "shared line edited locally\n", {
      remoteText: "shared line edited remotely\n",
      remoteTag: "2b",
    });

    assert.equal(planEntry.resolution, "conflict");
    assert.match(planEntry.reason ?? "", /conflict markers/);
    const written = await readFile(path.join(dir, "Notes/Tracked.md"), "utf-8");
    assert.match(written, /<<<<<<< local/);
    assert.match(written, />>>>>>> remote/);
    // The ancestor is untouched: the next merge needs the right common point.
    assert.equal(await readBaseCopy(dir, "REC1"), "shared line\n");
    // But the tag advances: once the markers are resolved, the next push must
    // take the plain upload path - re-entering the merge here overwrote the
    // user's resolution with fresh conflict markers, forever.
    assert.equal(s.notes.REC1?.recordChangeTag, "2b");
  }));

test("buildPushPlan never re-merges a file that still carries conflict markers - the resolution flow is marker gate, resolve, upload", () =>
  withTempDir(async (dir) => {
    // With the conflict-path tag advanced, a still-unresolved file must be
    // held at the marker gate (never merged again, never uploaded) - this is
    // what makes writing markers + advancing the tag safe.
    const s = state();
    await writeBaseCopy(dir, "REC1", "shared line\n");
    await writeVaultFile(
      dir,
      "Notes/Tracked.md",
      "<<<<<<< local\nshared line edited locally\n=======\nshared line edited remotely\n>>>>>>> remote\n",
    );
    await writeCloneState(dir, s);

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.resolution, "conflict");
    assert.match(entries[0]?.reason ?? "", /still contains diff3 conflict markers/);
    assert.equal(entries[0]?.execute, undefined);
  }));

test("runPush returns no entries and a zero pushed count when the plan is empty", () =>
  withTempDir(async (dir) => {
    const s = state();
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeCloneState(dir, s);

    const result = await runPush(dir);

    assert.deepEqual(result, { dryRun: false, pushed: 0, entries: [], unchanged: 1, notices: [] });
  }));

// --- id-in-frontmatter pairing -------------------------------------------
//
// The cases these cover are exactly the ones the content-equality and
// unique-basename heuristics can't reach, so each is written to resolve
// locally (via the sharer's "Pat/" area, which push refuses without a
// login) and prove which way the plan went without needing the network.

const NOTE_ID = "089D915D-C76E-4F44-AB80-2190073281A3";
const OTHER_NOTE_ID = "001b9e8a-c474-4311-af32-abe70026b346";

/** state() with REC1 keyed by a real note id. */
function idState(): CloneState {
  const base = state();
  return {
    ...base,
    notes: { [NOTE_ID]: base.notes.REC1! },
  };
}

function withId(id: string, body: string): string {
  return `---\napple-note-id: ${id}\n---\n\n${body}`;
}

test("an id pairs a note renamed, moved, and edited all at once - which no heuristic can", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    // Different directory, different basename, different content: nothing
    // but the id connects this file to Notes/Tracked.md.
    await writeVaultFile(dir, "Pat/Totally Different.md", withId(NOTE_ID, "Edited after renaming"));
    await writeCloneState(dir, idState());

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "move");
    assert.equal(entries[0]?.previousFile, "Notes/Tracked.md");
    assert.equal(entries[0]?.file, "Pat/Totally Different.md");
  }));

test("a file with its envelope stripped falls back to delete plus create", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    // No id, different basename, different content: nothing left for either
    // the id path or the heuristics to pair on. This is the degradation the
    // heuristics can't rescue, and it must not silently pick a wrong note.
    await writeVaultFile(dir, "Pat/Totally Different.md", "Edited after renaming");
    await writeCloneState(dir, idState());

    // The unpaired missing file becomes a delete candidate, which needs the
    // live record - reaching the network at all proves nothing paired.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("a copy of a note whose original is still in place plans as a create, not a move", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    // Duplicated in Obsidian: same id, still carrying the original's.
    await writeVaultFile(dir, "Pat/Tracked copy.md", withId(NOTE_ID, "Synced text"));
    await writeCloneState(dir, idState());

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(entries[0]?.file, "Pat/Tracked copy.md");
  }));

test("duplicate id claims with no original left in place are refused, not guessed", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    // The tracked file is gone and two files claim its id - neither can be
    // shown to be the original.
    await writeVaultFile(dir, "Recipes/Pie.md", withId(NOTE_ID, "Synced text"));
    await writeVaultFile(dir, "Recipes/Pie copy.md", withId(NOTE_ID, "Synced text"));
    await writeCloneState(dir, idState());

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.resolution, "refused");
      assert.match(entry.reason ?? "", /apple-note-id/);
      assert.match(entry.reason ?? "", /remove the .* line from every copy but one/);
    }
    assert.ok(!entries.some((entry) => entry.kind === "move"), "a refused claim must not also plan as a move");
    // The note's own file is missing, so without holding it back the plan
    // would refuse both copies *and* send the original to Recently Deleted.
    assert.ok(
      !entries.some((entry) => entry.kind === "delete"),
      "an ambiguous claim must not let the note itself plan as a delete",
    );
  }));

test("an id from another vault plans as a new note, with a notice saying so", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeVaultFile(dir, "Pat/From Elsewhere.md", withId(OTHER_NOTE_ID, "Someone else's note"));
    await writeCloneState(dir, idState());

    const { entries, notices } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.message ?? "", /doesn't track - pushing it as a new note/);
  }));

test("a tracked file whose frontmatter was stripped is still that note, by path", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    // No envelope at all, but it sits where the note is tracked: it must
    // resolve by path rather than becoming a duplicate.
    await writeVaultFile(dir, "Notes/Tracked.md", "Edited, and the id is gone");
    await writeCloneState(dir, idState());

    // An update candidate needs the live record; reaching for it proves the
    // file was treated as the tracked note, not as an untracked create.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("a malformed id is ignored rather than failing the push", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, NOTE_ID, "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "Synced text");
    await writeVaultFile(dir, "Pat/Broken.md", "---\napple-note-id: not-a-uuid\n---\n\nA new note");
    await writeCloneState(dir, idState());

    const { entries, notices } = await buildPushPlan(dir);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "create");
    assert.deepEqual(notices, [], "a malformed id is not a stale id - there's nothing to report");
  }));

// --- Filename-as-title vaults, where the file name carries the note's title
// and the file itself holds only the body. The reconstruction that makes a
// whole note out of that pair is unit-tested in pushTitleMode.test.ts; these
// cover the plan-level decisions, which are what a user meets first.

/** state() as a filename-as-title vault. */
function titleModeState(): CloneState {
  return { ...state(), titleMode: "filename" };
}

test("an empty file is a title-only note in a filename-as-title vault, not nothing to create", () =>
  withTempDir(async (dir) => {
    // The title still exists - it's the file's name - so there is a real
    // note to create, and the plan proceeds to the network for it.
    await writeCloneState(dir, { ...titleModeState(), notes: {} });
    await writeVaultFile(dir, "Recipes/Sourdough.md", "");

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("an empty file in an in-body vault is still nothing to create", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, emptyState());
    await writeVaultFile(dir, "Recipes/Sourdough.md", "");

    const { entries } = await buildPushPlan(dir);

    assert.equal(entries[0]?.resolution, "refused");
    assert.match(entries[0]?.reason ?? "", /the file is empty/);
  }));

test("emptying a note's body in a filename-as-title vault is an ordinary edit, not an emptied note", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "");
    await writeCloneState(dir, titleModeState());

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("renaming a note that has attachments in place is allowed - only relocating it isn't", () =>
  withTempDir(async (dir) => {
    // Attachments live in an `attachments/` directory per folder, named
    // after the attachment: a rename inside the same directory moves no
    // attachment file and breaks no link the note already holds.
    const s = titleModeState();
    s.attachments = {
      ATT1: { file: "Notes/attachments/pic.jpg", mediaRecordName: "MEDIA1", mediaFileChecksum: "abc", noteRecordName: "REC1" },
    };
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Renamed.md", "Synced text");
    await writeCloneState(dir, s);

    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

// --- `apple-note-title` as a retitle request ---------------------------------
//
// A frontmatter-only edit is invisible to the base-copy comparison by design.
// The one key push does read out of the envelope is the exception, because
// under filename-as-title it says something no body ever could.

/** state(), as a filename-as-title vault. */
function filenameTitleState(): CloneState {
  return { ...state(), titleMode: "filename" };
}

test("buildPushPlan takes a clean file's apple-note-title to the network - it may be asking for a retitle", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", '---\napple-note-title: "A new title"\n---\nSynced text');
    await writeCloneState(dir, filenameTitleState());

    // Whether it differs from the note's real title can only be settled
    // against the live record; the UnboundAccountError proves it got there.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("buildPushPlan leaves an in-body vault's apple-note-title alone - the title is the first line there", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", '---\napple-note-title: "A new title"\n---\nSynced text');
    await writeCloneState(dir, state());

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, [], "no candidate, and so no network");
  }));

test("buildPushPlan still ignores ordinary frontmatter on a clean file", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "Synced text");
    await writeVaultFile(dir, "Notes/Tracked.md", "---\ntags: [personal]\n---\nSynced text");
    await writeCloneState(dir, filenameTitleState());

    const { entries } = await buildPushPlan(dir);

    assert.deepEqual(entries, []);
  }));
