import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { runRestore } from "./restore.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "restore-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATE: CloneState = {
  syncToken: "token",
  notes: {
    REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
  },
};

test("restore overwrites a locally-edited note with its base copy", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");
    await writeFile(path.join(dir, "Test Note.md"), "Some local edit that can't be pushed", "utf-8");

    await runRestore(dir, "Test Note.md");

    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), "Original synced text");
  }));

test("restore refuses a file that isn't a tracked note", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");

    await assert.rejects(() => runRestore(dir, "Nonexistent.md"), /isn't a tracked note/);
  }));

test("restore accepts a path with directory components, matching by base name", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");
    await writeFile(path.join(dir, "Test Note.md"), "edited", "utf-8");

    await runRestore(dir, path.join(dir, "Test Note.md"));

    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), "Original synced text");
  }));

test("restore refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runRestore(dir, "Test Note.md"), /doesn't look like a cloned notes directory/);
  }));

test("restore preserves local-only frontmatter while discarding the body edit", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");
    const frontmatter = "---\ntags: [recipes, weeknight]\naliases: [Pie]\n---\n\n";
    await writeFile(path.join(dir, "Test Note.md"), frontmatter + "Some local edit", "utf-8");

    await runRestore(dir, "Test Note.md");

    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), frontmatter + "Original synced text");
  }));

test("restore recreates a missing file from the base copy, with no frontmatter", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");

    await runRestore(dir, "Test Note.md");

    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), "Original synced text");
  }));

test("restore recreates a missing file with its id and the apple-note-title the last sync recorded", () =>
  withTempDir(async (dir) => {
    // Without the key, push would read its absence as a request to retitle
    // the note to its file name - "Untitled", for a note filed that way.
    const id = "5B1A2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
    await writeCloneState(dir, {
      syncToken: "token",
      titleMode: "filename",
      notes: { [id]: { file: "Untitled.md", recordChangeTag: "1a", modificationDate: 100, frontmatterTitle: "Restaurants " } },
    });
    await writeBaseCopy(dir, id, "Original synced text");

    await runRestore(dir, "Untitled.md");

    assert.equal(
      await readFile(path.join(dir, "Untitled.md"), "utf-8"),
      `---\napple-note-id: ${id}\napple-note-title: "Restaurants "\n---\n\nOriginal synced text`,
    );
  }));

test("restore puts back an apple-note-title the file removed or changed, keeping the rest of the envelope", () =>
  withTempDir(async (dir) => {
    // A removed or edited key is a pending retitle, so the file isn't back
    // to clean until the key says what the last sync recorded.
    const id = "5B1A2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
    await writeCloneState(dir, {
      syncToken: "token",
      titleMode: "filename",
      notes: { [id]: { file: "Untitled.md", recordChangeTag: "1a", modificationDate: 100, frontmatterTitle: "Restaurants " } },
    });
    await writeBaseCopy(dir, id, "Original synced text");

    for (const envelope of [`---\napple-note-id: ${id}\ntags: [a]\n---\n\n`, `---\napple-note-id: ${id}\napple-note-title: Other\ntags: [a]\n---\n\n`]) {
      await writeFile(path.join(dir, "Untitled.md"), `${envelope}edited`, "utf-8");

      await runRestore(dir, "Untitled.md");

      const restored = await readFile(path.join(dir, "Untitled.md"), "utf-8");
      assert.match(restored, /^---\napple-note-id: 5B1A2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D\n/);
      assert.match(restored, /\napple-note-title: "Restaurants "\n/);
      assert.match(restored, /\ntags: \[ ?a ?\]\n/);
      assert.match(restored, /\n---\n\nOriginal synced text$/);
    }
  }));

test("restore leaves an envelope's apple-note-title alone when state recorded none", () =>
  withTempDir(async (dir) => {
    // State that predates frontmatterTitle can't say the key is wrong.
    await writeCloneState(dir, { ...STATE, titleMode: "filename" });
    await writeBaseCopy(dir, "REC1", "Original synced text");
    await writeFile(path.join(dir, "Test Note.md"), "---\napple-note-title: Kept\n---\n\nedited", "utf-8");

    await runRestore(dir, "Test Note.md");

    assert.equal(await readFile(path.join(dir, "Test Note.md"), "utf-8"), "---\napple-note-title: Kept\n---\n\nOriginal synced text");
  }));

test("restore leaves a frontmatter-only file as envelope plus base copy", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await writeBaseCopy(dir, "REC1", "Original synced text");
    await writeFile(path.join(dir, "Test Note.md"), "---\ntags: [orphan]\n---\n", "utf-8");

    await runRestore(dir, "Test Note.md");

    assert.equal(
      await readFile(path.join(dir, "Test Note.md"), "utf-8"),
      "---\ntags: [orphan]\n---\nOriginal synced text",
    );
  }));
