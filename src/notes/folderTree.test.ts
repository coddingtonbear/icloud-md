import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { buildFolderTree, decodeFolderRecord, sanitizeFolderDirName, type FolderInfo } from "./folderTree.js";

function folderRecord(recordName: string, title: string, parentRecordName?: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Folder",
    fields: { TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" } },
    parentRecordName,
  };
}

test("decodeFolderRecord decodes the base64 title", () => {
  const info = decodeFolderRecord(folderRecord("A", "Another Folder"));
  assert.deepEqual(info, { recordName: "A", title: "Another Folder", parentRecordName: undefined });
});

test("decodeFolderRecord reads the ParentFolder reference field (the shape observed live 2026-07-16)", () => {
  const record: CloudKitRecord = {
    recordName: "1F59CBAE-CDEF-4374-A4B8-6D1C4B8A11D2",
    recordType: "Folder",
    fields: {
      TitleEncrypted: { value: Buffer.from("Subf", "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" },
      ParentFolder: {
        value: { recordName: "EB6DBFC9-FDC1-4CE8-8C7E-7A531331280A", action: "VALIDATE" },
        type: "REFERENCE",
      },
    },
    parentRecordName: "EB6DBFC9-FDC1-4CE8-8C7E-7A531331280A",
  };
  assert.equal(decodeFolderRecord(record)?.parentRecordName, "EB6DBFC9-FDC1-4CE8-8C7E-7A531331280A");
});

test("decodeFolderRecord falls back to the record-level parent when the field is missing", () => {
  const info = decodeFolderRecord(folderRecord("B", "Nested", "A"));
  assert.equal(info?.parentRecordName, "A");
});

test("decodeFolderRecord ignores non-Folder records and the Trash folder", () => {
  assert.equal(decodeFolderRecord({ recordName: "N", recordType: "Note", fields: {} }), undefined);
  assert.equal(decodeFolderRecord(folderRecord("TrashFolder-CloudKit", "Recently Deleted")), undefined);
});

test("decodeFolderRecord tolerates a missing title field", () => {
  const info = decodeFolderRecord({ recordName: "A", recordType: "Folder", fields: {} });
  assert.equal(info?.title, "");
});

test("sanitizeFolderDirName strips unsafe characters and trailing dots", () => {
  assert.equal(sanitizeFolderDirName("Recipes: a/b?"), "Recipes ab");
  assert.equal(sanitizeFolderDirName("ends with dot."), "ends with dot");
});

test("sanitizeFolderDirName falls back for unusable titles", () => {
  assert.equal(sanitizeFolderDirName(""), "Untitled Folder");
  assert.equal(sanitizeFolderDirName("///"), "Untitled Folder");
});

function tree(folders: FolderInfo[], preferred?: ReadonlyMap<string, string>) {
  return buildFolderTree(folders, preferred);
}

function dirPath(result: ReturnType<typeof buildFolderTree>, recordName: string): string | undefined {
  return result.byRecordName.get(recordName)?.dirPath;
}

test("buildFolderTree nests children under their parents", () => {
  const result = tree([
    { recordName: "top", title: "Top" },
    { recordName: "mid", title: "Mid", parentRecordName: "top" },
    { recordName: "leaf", title: "Leaf", parentRecordName: "mid" },
  ]);
  assert.equal(dirPath(result, "leaf"), "Top/Mid/Leaf");
  assert.equal(result.roots.length, 1);
});

test("buildFolderTree uniquifies sibling names case-insensitively", () => {
  const result = tree([
    { recordName: "a", title: "recipes" },
    { recordName: "b", title: "Recipes" },
  ]);
  const names = [dirPath(result, "a"), dirPath(result, "b")].sort();
  assert.deepEqual(names, ["Recipes 2", "recipes"]);
});

test("buildFolderTree keeps equal titles apart in different sibling groups", () => {
  const result = tree([
    { recordName: "p1", title: "Parent One" },
    { recordName: "p2", title: "Parent Two" },
    { recordName: "c1", title: "Notes", parentRecordName: "p1" },
    { recordName: "c2", title: "Notes", parentRecordName: "p2" },
  ]);
  assert.equal(dirPath(result, "c1"), "Parent One/Notes");
  assert.equal(dirPath(result, "c2"), "Parent Two/Notes");
});

test("buildFolderTree keeps 'attachments' free in every sibling group", () => {
  // Attachments live per-folder, so the name is reserved at every level.
  const result = tree([
    { recordName: "a", title: "attachments" },
    { recordName: "p", title: "Parent" },
    { recordName: "nested", title: "Attachments", parentRecordName: "p" },
  ]);
  assert.equal(dirPath(result, "a"), "attachments 2");
  assert.equal(dirPath(result, "nested"), "Parent/Attachments 2");
});

test("buildFolderTree reserves '.icloud-notes-sync' at the top level only", () => {
  const result = tree([
    { recordName: "a", title: ".icloud-notes-sync" },
    { recordName: "p", title: "Parent" },
    { recordName: "nested", title: ".icloud-notes-sync", parentRecordName: "p" },
  ]);
  assert.equal(dirPath(result, "a"), ".icloud-notes-sync 2");
  assert.equal(dirPath(result, "nested"), "Parent/.icloud-notes-sync");
});

test("buildFolderTree honors preferred names even against an earlier-sorting newcomer", () => {
  // Both folders are titled "Shared", but "old" already owns the bare
  // "Shared" directory from a previous sync - the newcomer must not steal
  // it, whatever the fresh assignment order would have said.
  const result = tree(
    [
      { recordName: "new", title: "Shared" },
      { recordName: "old", title: "Shared" },
    ],
    new Map([["old", "Shared"]]),
  );
  assert.equal(dirPath(result, "old"), "Shared");
  assert.equal(dirPath(result, "new"), "Shared 2");
});

test("buildFolderTree reassigns a preferred name that is no longer available", () => {
  const result = tree(
    [
      { recordName: "a", title: "Kept" },
      { recordName: "b", title: "Wants Kept" },
    ],
    new Map([
      ["a", "Kept"],
      ["b", "Kept"],
    ]),
  );
  assert.equal(dirPath(result, "a"), "Kept");
  assert.equal(dirPath(result, "b"), "Wants Kept");
});

test("buildFolderTree promotes a folder with an unknown parent to a root", () => {
  const result = tree([{ recordName: "orphan", title: "Orphan", parentRecordName: "gone" }]);
  assert.equal(dirPath(result, "orphan"), "Orphan");
});

test("buildFolderTree breaks parent cycles instead of dropping the members", () => {
  const result = tree([
    { recordName: "a", title: "A", parentRecordName: "b" },
    { recordName: "b", title: "B", parentRecordName: "a" },
    { recordName: "child", title: "Child", parentRecordName: "b" },
  ]);
  // Every folder still lands somewhere, and the non-cycle edge survives.
  assert.equal(result.byRecordName.size, 3);
  assert.ok(dirPath(result, "child")?.endsWith("Child"));
  for (const name of ["a", "b", "child"]) {
    assert.notEqual(dirPath(result, name), "");
  }
});

test("buildFolderTree is deterministic for fresh assignments", () => {
  const folders: FolderInfo[] = [
    { recordName: "z", title: "Same" },
    { recordName: "a", title: "Same" },
  ];
  const first = tree(folders);
  const second = tree([...folders].reverse());
  assert.equal(dirPath(first, "a"), dirPath(second, "a"));
  assert.equal(dirPath(first, "a"), "Same");
  assert.equal(dirPath(first, "z"), "Same 2");
});
