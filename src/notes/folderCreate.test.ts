import { test } from "node:test";
import assert from "node:assert/strict";
import { dirOfFile, planFolderCreates } from "./folderCreate.js";
import type { StateDirInfo } from "./folderLayout.js";

/** A deterministic id source, so plans are assertable. */
function counterNames(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

function index(entries: Record<string, StateDirInfo>): Map<string, StateDirInfo> {
  return new Map(Object.entries(entries));
}

const NOTES_FOLDER: StateDirInfo = { kind: "folder", folderRecordName: "DefaultFolder-CloudKit" };

test("plans nothing when every wanted directory already exists", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Notes"],
    dirIndex: index({ Notes: NOTES_FOLDER }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.dirToRecordName.get("Notes"), "DefaultFolder-CloudKit");
});

test("plans one top-level folder, with no parent", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Recipes"],
    dirIndex: index({ Notes: NOTES_FOLDER }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, [{ recordName: "new-1", title: "Recipes", dirPath: "Recipes" }]);
  assert.equal(plan.dirToRecordName.get("Recipes"), "new-1");
});

test("plans a nested folder parent-first, chaining the parent's record name", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Recipes/Desserts/Cakes"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, [
    { recordName: "new-1", title: "Recipes", dirPath: "Recipes" },
    { recordName: "new-2", title: "Desserts", dirPath: "Recipes/Desserts", parentRecordName: "new-1" },
    { recordName: "new-3", title: "Cakes", dirPath: "Recipes/Desserts/Cakes", parentRecordName: "new-2" },
  ]);
});

test("nests a new folder under an existing one", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Notes/Archive"],
    dirIndex: index({ Notes: NOTES_FOLDER }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, [
    { recordName: "new-1", title: "Archive", dirPath: "Notes/Archive", parentRecordName: "DefaultFolder-CloudKit" },
  ]);
});

test("plans a shared parent exactly once for sibling directories", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Recipes/Desserts", "Recipes/Mains"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(
    plan.folders.map((folder) => folder.dirPath),
    ["Recipes", "Recipes/Desserts", "Recipes/Mains"],
  );
  const parent = plan.folders[0]!;
  assert.equal(plan.folders[1]!.parentRecordName, parent.recordName);
  assert.equal(plan.folders[2]!.parentRecordName, parent.recordName);
});

test("orders parents before children regardless of input order", () => {
  const plan = planFolderCreates({
    wantedDirs: ["A/B/C", "A", "A/B"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(
    plan.folders.map((folder) => folder.dirPath),
    ["A", "A/B", "A/B/C"],
  );
});

test("refuses a hidden directory - editor metadata is never note content", () => {
  const plan = planFolderCreates({
    wantedDirs: [".obsidian/plugins"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0]!.reason, /hidden directory/);
});

test("refuses the reserved attachments directory at any depth", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Notes/attachments"],
    dirIndex: index({ Notes: NOTES_FOLDER }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.match(plan.refusals[0]!.reason, /downloaded attachments/);
});

test("refuses to create a folder inside another user's shared area", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Someone Else/New Folder"],
    dirIndex: index({ "Someone Else": { kind: "sharerHome", sharedZoneOwner: "_owner" } }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.match(plan.refusals[0]!.reason, /another user's shared area/);
});

test("refuses to create a folder inside a shared folder", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Someone Else/Shared Recipes/Sub"],
    dirIndex: index({
      "Someone Else": { kind: "sharerHome", sharedZoneOwner: "_owner" },
      "Someone Else/Shared Recipes": { kind: "folder", folderRecordName: "shared-1", sharedZoneOwner: "_owner" },
    }),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.match(plan.refusals[0]!.reason, /shared folder/);
});

test("a refusal deep in a tree leaves no half-planned ancestors behind", () => {
  // "Recipes" is only wanted as the road to a refused child, so planning it
  // would create an empty folder nobody asked for.
  const plan = planFolderCreates({
    wantedDirs: ["Recipes/attachments"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(plan.folders, []);
  assert.equal(plan.dirToRecordName.has("Recipes"), false);
  assert.equal(plan.refusals.length, 1);
});

test("an ancestor still wanted by a sibling survives a refused branch", () => {
  const plan = planFolderCreates({
    wantedDirs: ["Recipes/attachments", "Recipes/Mains"],
    dirIndex: index({}),
    newRecordName: counterNames(),
  });
  assert.deepEqual(
    plan.folders.map((folder) => folder.dirPath),
    ["Recipes", "Recipes/Mains"],
  );
  assert.equal(plan.refusals.length, 1);
  assert.equal(plan.refusals[0]!.dirPath, "Recipes/attachments");
});

test("ignores the vault root", () => {
  const plan = planFolderCreates({ wantedDirs: ["", ""], dirIndex: index({}), newRecordName: counterNames() });
  assert.deepEqual(plan.folders, []);
  assert.deepEqual(plan.refusals, []);
});

test("dirOfFile returns an empty string at the vault root", () => {
  assert.equal(dirOfFile("loose.md"), "");
  assert.equal(dirOfFile("Notes/note.md"), "Notes");
  assert.equal(dirOfFile("A/B/note.md"), "A/B");
});
