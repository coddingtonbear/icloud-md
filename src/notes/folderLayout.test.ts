import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { buildVaultLayout, noteDirOf, placeNote, sharerDisplayName, type SharedZoneRecords } from "./folderLayout.js";

function folderRecord(recordName: string, title: string, parentRecordName?: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Folder",
    fields: { TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" } },
    parentRecordName,
  };
}

function noteRecord(recordName: string, folderRecordName?: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Note",
    fields: folderRecordName ? { Folder: { value: { recordName: folderRecordName }, type: "REFERENCE" } } : {},
  };
}

function shareRecord(ownerName: { givenName?: string; familyName?: string; emailAddress?: string }): CloudKitRecord {
  return {
    recordName: "Share-1",
    recordType: "cloudkit.share",
    fields: {},
    participants: [{ type: "OWNER", ...ownerName }],
  };
}

const OWN_RECORDS: CloudKitRecord[] = [
  folderRecord("DefaultFolder-CloudKit", "Notes"),
  folderRecord("F-RECIPES", "Recipes"),
  folderRecord("F-DESSERTS", "Desserts", "F-RECIPES"),
];

test("buildVaultLayout maps own folders to nested directories", () => {
  const layout = buildVaultLayout(OWN_RECORDS, []);
  assert.equal(layout.folderDirs.get("DefaultFolder-CloudKit"), "Notes");
  assert.equal(layout.folderDirs.get("F-DESSERTS"), "Recipes/Desserts");
  assert.deepEqual(layout.stateFolders["F-DESSERTS"], {
    name: "Desserts",
    parentRecordName: "F-RECIPES",
    dirName: "Desserts",
  });
});

test("buildVaultLayout gives each sharer a home named after the share's OWNER participant", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ givenName: "Hassan", familyName: "Almemari" }), noteRecord("N1")],
  };
  const layout = buildVaultLayout(OWN_RECORDS, [zone]);
  assert.equal(layout.sharerHomeDirs.get("_owner1"), "Hassan Almemari");
  assert.deepEqual(layout.stateSharerHomes._owner1, { name: "Hassan Almemari", dirName: "Hassan Almemari" });
});

test("buildVaultLayout falls back to email, then the opaque owner id, for a sharer's name", () => {
  const emailZone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ emailAddress: "pal@example.com" })],
  };
  const bareZone: SharedZoneRecords = { ownerRecordName: "_owner2", records: [noteRecord("N1")] };
  const layout = buildVaultLayout([], [emailZone, bareZone]);
  assert.equal(layout.sharerHomeDirs.get("_owner1"), "pal@example.com");
  assert.equal(layout.sharerHomeDirs.get("_owner2"), "_owner2");
});

test("buildVaultLayout roots a shared folder's tree under the sharer's home", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ givenName: "Pat" }), folderRecord("F-SHARED", "Shared Recipes")],
  };
  const layout = buildVaultLayout(OWN_RECORDS, [zone]);
  assert.equal(layout.folderDirs.get("F-SHARED"), "Pat/Shared Recipes");
  assert.equal(layout.stateFolders["F-SHARED"]?.sharedZoneOwner, "_owner1");
});

test("buildVaultLayout keeps sharer homes and own root folders in one top-level namespace", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ givenName: "Recipes" })],
  };
  const layout = buildVaultLayout(OWN_RECORDS, [zone]);
  // The own folder "Recipes" claims the name; the sharer home uniquifies.
  assert.equal(layout.folderDirs.get("F-RECIPES"), "Recipes");
  assert.equal(layout.sharerHomeDirs.get("_owner1"), "Recipes 2");
});

test("buildVaultLayout carries forward folders the server did not re-send, keeping their names", () => {
  const layout = buildVaultLayout([folderRecord("F-NEW", "Recipes")], [], {
    folders: { "F-OLD": { name: "Recipes", dirName: "Recipes" } },
    sharerHomes: {},
  });
  // The carried folder keeps its directory; the newcomer uniquifies around it.
  assert.equal(layout.folderDirs.get("F-OLD"), "Recipes");
  assert.equal(layout.folderDirs.get("F-NEW"), "Recipes 2");
});

test("buildVaultLayout drops a tombstoned folder record", () => {
  const tombstone: CloudKitRecord = { recordName: "F-GONE", recordType: "Folder", fields: {}, deleted: true };
  const layout = buildVaultLayout([tombstone], [], {
    folders: { "F-GONE": { name: "Old", dirName: "Old" } },
    sharerHomes: {},
  });
  assert.equal(layout.folderDirs.get("F-GONE"), undefined);
});

test("buildVaultLayout keeps a sharer home's previous name when the share record is not re-sent", () => {
  const zone: SharedZoneRecords = { ownerRecordName: "_owner1", records: [noteRecord("N1")] };
  const layout = buildVaultLayout([], [zone], {
    folders: {},
    sharerHomes: { _owner1: { name: "Hassan Almemari", dirName: "Hassan Almemari" } },
  });
  assert.equal(layout.sharerHomeDirs.get("_owner1"), "Hassan Almemari");
});

test("placeNote puts an own note in its folder's directory", () => {
  const layout = buildVaultLayout(OWN_RECORDS, []);
  const placement = placeNote(layout, noteRecord("N1", "F-DESSERTS"), undefined);
  assert.deepEqual(placement, { dir: "Recipes/Desserts", folderRecordName: "F-DESSERTS" });
});

test("placeNote falls back to the default folder for an unresolvable own reference", () => {
  const layout = buildVaultLayout(OWN_RECORDS, []);
  const placement = placeNote(layout, noteRecord("N1", "F-UNKNOWN"), undefined);
  assert.deepEqual(placement, { dir: "Notes", folderRecordName: undefined });
});

test("placeNote puts a shared-folder note inside that folder, with real membership", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ givenName: "Pat" }), folderRecord("F-SHARED", "Shared Recipes")],
  };
  const layout = buildVaultLayout(OWN_RECORDS, [zone]);
  const placement = placeNote(layout, noteRecord("N1", "F-SHARED"), "_owner1");
  assert.deepEqual(placement, { dir: "Pat/Shared Recipes", folderRecordName: "F-SHARED" });
});

test("placeNote drops an individually-shared note loose in the sharer's home", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [shareRecord({ givenName: "Pat" }), noteRecord("N1", "DefaultFolder-CloudKit")],
  };
  // The note's Folder reference names the *sharer's* default folder, which
  // is not a folder this vault mirrors (it collides with our own
  // DefaultFolder-CloudKit recordName only if we misattributed zones).
  const layout = buildVaultLayout(OWN_RECORDS, [zone]);
  const placement = placeNote(layout, noteRecord("N1", "DefaultFolder-CloudKit"), "_owner1");
  assert.deepEqual(placement, { dir: "Pat", folderRecordName: undefined });
});

test("noteDirOf derives the note's directory from its state file path", () => {
  assert.equal(noteDirOf("Recipes/Pie.md"), "Recipes");
  assert.equal(noteDirOf("Pie.md"), "");
});

test("sharerDisplayName reads the OWNER participant only", () => {
  const zone: SharedZoneRecords = {
    ownerRecordName: "_owner1",
    records: [
      {
        recordName: "Share-1",
        recordType: "cloudkit.share",
        fields: {},
        participants: [
          { type: "ADMINISTRATOR", givenName: "Adam", familyName: "Coddington" },
          { type: "OWNER", givenName: "Hassan", familyName: "Almemari" },
        ],
      },
    ],
  };
  assert.equal(sharerDisplayName(zone), "Hassan Almemari");
});

test("buildVaultLayout re-derives the directory name when a folder's title changed", () => {
  const layout = buildVaultLayout([folderRecord("F", "Cooking")], [], {
    folders: { F: { name: "Recipes", dirName: "Recipes" } },
    sharerHomes: {},
  });
  assert.equal(layout.folderDirs.get("F"), "Cooking");
  assert.equal(layout.stateFolders.F?.dirName, "Cooking");
});

test("buildVaultLayout keeps the directory name when only siblings changed", () => {
  const layout = buildVaultLayout([folderRecord("NEW", "Aardvark")], [], {
    folders: { F: { name: "Recipes", dirName: "Recipes" } },
    sharerHomes: {},
  });
  assert.equal(layout.folderDirs.get("F"), "Recipes");
});
