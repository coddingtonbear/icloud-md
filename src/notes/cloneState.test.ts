import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CorruptStateFileError, UnsupportedVaultLayoutError } from "../errors.js";
import { readCloneState, writeCloneState, type CloneState } from "./cloneState.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "clonestate-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("round-trips shared-zone owners and per-zone syncTokens", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "private-token",
      sharedZoneSyncTokens: { _owner1: "shared-token-1" },
      notes: {
        "REC-PRIVATE": { file: "Own Note (REC).md", recordChangeTag: "a", modificationDate: 1 },
        "REC-SHARED": {
          file: "Cooking Recipes (REC).md",
          recordChangeTag: "b",
          modificationDate: 2,
          sharedZoneOwner: "_owner1",
        },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.deepEqual(readBack?.sharedZoneSyncTokens, { _owner1: "shared-token-1" });
    assert.equal(readBack?.notes["REC-SHARED"]?.sharedZoneOwner, "_owner1");
    assert.equal(readBack?.notes["REC-PRIVATE"]?.sharedZoneOwner, undefined);
    assert.equal(readBack?.syncToken, "private-token");
  }));

test("round-trips unpublishableReason, absent means fully publishable", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        "REC-DEGRADED": {
          file: "Table Note (REC).md",
          recordChangeTag: "a",
          modificationDate: 1,
          unpublishableReason: "contains embedded content this tool can't parse (com.apple.notes.table)",
        },
        "REC-CLEAN": { file: "Plain Note (REC).md", recordChangeTag: "b", modificationDate: 2 },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.equal(
      readBack?.notes["REC-DEGRADED"]?.unpublishableReason,
      "contains embedded content this tool can't parse (com.apple.notes.table)",
    );
    assert.equal(readBack?.notes["REC-CLEAN"]?.unpublishableReason, undefined);
  }));

test("reads a pre-shared-notes state file (no shared fields) without error", () =>
  withTempDir(async (dir) => {
    // Exactly what writeCloneState produced before shared-note support existed.
    const legacy: CloneState = {
      syncToken: "old-token",
      notes: {
        "REC-1": { file: "Note (REC1).md", recordChangeTag: "tag", modificationDate: 5 },
      },
    };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.sharedZoneSyncTokens, undefined);
    assert.equal(readBack?.notes["REC-1"]?.sharedZoneOwner, undefined);
    assert.equal(readBack?.notes["REC-1"]?.file, "Note (REC1).md");
  }));

test("round-trips the bound account", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      account: { appleId: "me@example.com", dsid: "1234" },
      syncToken: "token",
      notes: {},
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.deepEqual(readBack?.account, { appleId: "me@example.com", dsid: "1234" });
  }));

test("reads a pre-account-binding state file (no account field) without error", () =>
  withTempDir(async (dir) => {
    const legacy: CloneState = { syncToken: "old-token", notes: {} };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.account, undefined);
  }));

test("refuses a pre-folder-layout vault loudly, telling the user to re-clone", () =>
  withTempDir(async (dir) => {
    // Exactly what a real vault cloned before folder support looks like:
    // a valid state file with no layoutVersion field.
    const stateDir = path.join(dir, ".icloud-notes-sync");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({ syncToken: "old", notes: { "REC-1": { file: "Note.md", recordChangeTag: "t", modificationDate: 1 } } }),
      "utf-8",
    );

    await assert.rejects(readCloneState(dir), UnsupportedVaultLayoutError);
  }));

test("throws CorruptStateFileError for a malformed account field", () =>
  withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".icloud-notes-sync");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({ layoutVersion: 2, notes: {}, account: { appleId: "me@example.com" } }),
      "utf-8",
    );

    await assert.rejects(readCloneState(dir), CorruptStateFileError);
  }));

test("round-trips table attachments", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        "REC-TABLE": { file: "Table Note (REC).md", recordChangeTag: "a", modificationDate: 1 },
      },
      tableAttachments: {
        "ATT-1": { noteRecordName: "REC-TABLE" },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.deepEqual(readBack?.tableAttachments, { "ATT-1": { noteRecordName: "REC-TABLE" } });
  }));

test("reads a pre-table-history state file (no tableAttachments field) without error", () =>
  withTempDir(async (dir) => {
    const legacy: CloneState = { syncToken: "old-token", notes: {} };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.tableAttachments, undefined);
  }));

test("throws CorruptStateFileError for a malformed table attachment entry", () =>
  withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".icloud-notes-sync");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({ layoutVersion: 2, notes: {}, tableAttachments: { "ATT-1": {} } }),
      "utf-8",
    );

    await assert.rejects(readCloneState(dir), CorruptStateFileError);
  }));

test("round-trips the folder tree and per-note folder membership", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        "REC-1": {
          file: "Recipes/Pie.md",
          recordChangeTag: "a",
          modificationDate: 1,
          folderRecordName: "FOLDER-1",
        },
        "REC-SHARED": { file: "Cooking Recipes.md", recordChangeTag: "b", modificationDate: 2 },
      },
      folders: {
        "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" },
        "FOLDER-1": { name: "Recipes", dirName: "Recipes" },
        "FOLDER-2": { name: "Desserts", parentRecordName: "FOLDER-1", dirName: "Desserts" },
      },
    };

    await writeCloneState(dir, state);
    const readBack = await readCloneState(dir);

    assert.equal(readBack?.folders?.["FOLDER-1"]?.dirName, "Recipes");
    assert.equal(readBack?.folders?.["FOLDER-1"]?.parentRecordName, undefined);
    assert.equal(readBack?.folders?.["FOLDER-2"]?.parentRecordName, "FOLDER-1");
    assert.equal(readBack?.folders?.["DefaultFolder-CloudKit"]?.name, "Notes");
    assert.equal(readBack?.notes["REC-1"]?.folderRecordName, "FOLDER-1");
    assert.equal(readBack?.notes["REC-SHARED"]?.folderRecordName, undefined);
  }));

test("reads a pre-folder-support state file (no folders field) without error", () =>
  withTempDir(async (dir) => {
    const legacy: CloneState = { syncToken: "old-token", notes: {} };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.folders, undefined);
  }));

test("throws CorruptStateFileError for a malformed folder entry", () =>
  withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".icloud-notes-sync");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({ layoutVersion: 2, notes: {}, folders: { "FOLDER-1": { name: "Recipes" } } }),
      "utf-8",
    );

    await assert.rejects(readCloneState(dir), CorruptStateFileError);
  }));

test("round-trips the trash registry", () =>
  withTempDir(async (dir) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {},
      trashed: { "REC-1": { file: "Gone.md", trashedAt: 1784216572571 } },
    };
    await writeCloneState(dir, state);

    const readBack = await readCloneState(dir);
    assert.deepEqual(readBack?.trashed, { "REC-1": { file: "Gone.md", trashedAt: 1784216572571 } });
  }));

test("reads a pre-trash-registry state file (no trashed field) without error", () =>
  withTempDir(async (dir) => {
    const legacy: CloneState = { syncToken: "old-token", notes: {} };
    await writeCloneState(dir, legacy);

    const readBack = await readCloneState(dir);
    assert.equal(readBack?.trashed, undefined);
  }));

test("throws CorruptStateFileError for a malformed trashed entry", () =>
  withTempDir(async (dir) => {
    const stateDir = path.join(dir, ".icloud-notes-sync");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "state.json"),
      JSON.stringify({ layoutVersion: 2, notes: {}, trashed: { "REC-1": { file: "Gone.md" } } }),
      "utf-8",
    );

    await assert.rejects(readCloneState(dir), CorruptStateFileError);
  }));
