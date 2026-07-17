import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloneState } from "./cloneState.js";
import { buildVaultLayout } from "./folderLayout.js";
import { reconcileNotePlacements, removeStaleDirs } from "./folderReconcile.js";
import { writeBaseCopy, readBaseCopy } from "./baseCopy.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "folderreconcile-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function folderRecord(recordName: string, title: string, parentRecordName?: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Folder",
    fields: { TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" } },
    parentRecordName,
  };
}

async function writeVaultFile(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, "utf-8");
}

test("a remote folder rename moves the note and empties out the old directory", () =>
  withTempDir(async (root) => {
    // Previous sync: folder F titled "Recipes"; this run renames it "Cooking".
    const previous = {
      folders: {
        "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" },
        F: { name: "Recipes", dirName: "Recipes" },
      },
      sharerHomes: {},
    };
    const layout = buildVaultLayout(
      [folderRecord("DefaultFolder-CloudKit", "Notes"), folderRecord("F", "Cooking")],
      [],
      previous,
    );
    assert.equal(layout.folderDirs.get("F"), "Cooking");

    const notes: CloneState["notes"] = {
      REC: { file: "Recipes/Pie.md", recordChangeTag: "a", modificationDate: 1, folderRecordName: "F" },
    };
    await writeVaultFile(root, "Recipes/Pie.md", "pie");
    await mkdir(path.join(root, "Cooking"), { recursive: true });

    const relocations = await reconcileNotePlacements(root, layout, notes, {});
    assert.deepEqual(relocations, [{ from: "Recipes/Pie.md", to: "Cooking/Pie.md" }]);
    assert.equal(notes.REC?.file, "Cooking/Pie.md");
    assert.equal(await readFile(path.join(root, "Cooking/Pie.md"), "utf-8"), "pie");

    await removeStaleDirs(root, ["Notes", "Recipes"], new Set(layout.allDirs));
    const remaining = await readdir(root);
    assert.equal(remaining.includes("Recipes"), false);
  }));

test("a remote note-move relocates the file and its attachment together", () =>
  withTempDir(async (root) => {
    const layout = buildVaultLayout(
      [folderRecord("DefaultFolder-CloudKit", "Notes"), folderRecord("A", "Alpha"), folderRecord("B", "Beta")],
      [],
    );
    const notes: CloneState["notes"] = {
      // State already reflects the new membership (the record loop updated
      // folderRecordName); the file is still in the old place.
      REC: { file: "Alpha/Photo note.md", recordChangeTag: "a", modificationDate: 1, folderRecordName: "B" },
    };
    const attachments = {
      ATT: {
        file: "Alpha/attachments/photo.jpeg",
        mediaRecordName: "M",
        mediaFileChecksum: "c",
        noteRecordName: "REC",
      },
    };
    await writeVaultFile(root, "Alpha/Photo note.md", "![photo.jpeg](attachments/photo.jpeg)");
    await writeVaultFile(root, "Alpha/attachments/photo.jpeg", "bytes");

    const relocations = await reconcileNotePlacements(root, layout, notes, attachments);
    assert.equal(relocations.length, 1);
    assert.equal(notes.REC?.file, "Beta/Photo note.md");
    assert.equal(attachments.ATT?.file, "Beta/attachments/photo.jpeg");
    assert.equal(await readFile(path.join(root, "Beta/attachments/photo.jpeg"), "utf-8"), "bytes");
    // Link unchanged: the attachment kept its basename, and it's note-relative.
    assert.equal(
      await readFile(path.join(root, "Beta/Photo note.md"), "utf-8"),
      "![photo.jpeg](attachments/photo.jpeg)",
    );
  }));

test("a basename collision in the target directory uniquifies and stays consistent", () =>
  withTempDir(async (root) => {
    const layout = buildVaultLayout(
      [folderRecord("DefaultFolder-CloudKit", "Notes"), folderRecord("A", "Alpha"), folderRecord("B", "Beta")],
      [],
    );
    const notes: CloneState["notes"] = {
      "REC-STAY": { file: "Beta/Pie.md", recordChangeTag: "a", modificationDate: 1, folderRecordName: "B" },
      "REC-MOVE": { file: "Alpha/Pie.md", recordChangeTag: "b", modificationDate: 2, folderRecordName: "B" },
    };
    await writeVaultFile(root, "Beta/Pie.md", "staying");
    await writeVaultFile(root, "Alpha/Pie.md", "moving");

    await reconcileNotePlacements(root, layout, notes, {});
    assert.equal(notes["REC-STAY"]?.file, "Beta/Pie.md");
    assert.equal(notes["REC-MOVE"]?.file, "Beta/Pie 2.md");
    assert.equal(await readFile(path.join(root, "Beta/Pie 2.md"), "utf-8"), "moving");
  }));

test("an attachment collision rewrites the note body and base copy identically", () =>
  withTempDir(async (root) => {
    const layout = buildVaultLayout(
      [folderRecord("DefaultFolder-CloudKit", "Notes"), folderRecord("A", "Alpha"), folderRecord("B", "Beta")],
      [],
    );
    const body = "![photo.jpeg](attachments/photo.jpeg)";
    const notes: CloneState["notes"] = {
      "REC-STAY": { file: "Beta/Staying.md", recordChangeTag: "a", modificationDate: 1, folderRecordName: "B" },
      "REC-MOVE": { file: "Alpha/Moving.md", recordChangeTag: "b", modificationDate: 2, folderRecordName: "B" },
    };
    const attachments = {
      "ATT-STAY": { file: "Beta/attachments/photo.jpeg", mediaRecordName: "M1", mediaFileChecksum: "c1", noteRecordName: "REC-STAY" },
      "ATT-MOVE": { file: "Alpha/attachments/photo.jpeg", mediaRecordName: "M2", mediaFileChecksum: "c2", noteRecordName: "REC-MOVE" },
    };
    await writeVaultFile(root, "Beta/Staying.md", body);
    await writeVaultFile(root, "Beta/attachments/photo.jpeg", "staying-bytes");
    await writeVaultFile(root, "Alpha/Moving.md", body);
    await writeVaultFile(root, "Alpha/attachments/photo.jpeg", "moving-bytes");
    await writeBaseCopy(root, "REC-MOVE", body);

    await reconcileNotePlacements(root, layout, notes, attachments);

    assert.equal(attachments["ATT-MOVE"]?.file, "Beta/attachments/photo 2.jpeg");
    const movedBody = await readFile(path.join(root, "Beta/Moving.md"), "utf-8");
    assert.equal(movedBody, "![photo.jpeg](attachments/photo%202.jpeg)");
    assert.equal(await readBaseCopy(root, "REC-MOVE"), movedBody);
    // The staying note's attachment is untouched.
    assert.equal(await readFile(path.join(root, "Beta/attachments/photo.jpeg"), "utf-8"), "staying-bytes");
  }));

test("a locally-missing file is left tracked at its old path", () =>
  withTempDir(async (root) => {
    const layout = buildVaultLayout(
      [folderRecord("DefaultFolder-CloudKit", "Notes"), folderRecord("A", "Alpha"), folderRecord("B", "Beta")],
      [],
    );
    const notes: CloneState["notes"] = {
      REC: { file: "Alpha/Gone.md", recordChangeTag: "a", modificationDate: 1, folderRecordName: "B" },
    };
    await mkdir(path.join(root, "Alpha"), { recursive: true });

    const relocations = await reconcileNotePlacements(root, layout, notes, {});
    assert.deepEqual(relocations, []);
    assert.equal(notes.REC?.file, "Alpha/Gone.md");
  }));

test("removeStaleDirs leaves a directory with untracked local files in place", () =>
  withTempDir(async (root) => {
    await writeVaultFile(root, "Old/Keep me.md", "untracked");
    await removeStaleDirs(root, ["Old"], new Set(["New"]));
    assert.equal(await readFile(path.join(root, "Old/Keep me.md"), "utf-8"), "untracked");
  }));
