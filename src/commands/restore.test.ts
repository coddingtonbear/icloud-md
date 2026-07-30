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
