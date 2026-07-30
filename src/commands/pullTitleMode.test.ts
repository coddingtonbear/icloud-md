import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renameForRemoteTitle } from "./pull.js";

/**
 * Pull's half of the filename-as-title mode: a note retitled remotely has to
 * have its *file* renamed, because the name is the only place the title
 * lives. The hazards are all about not renaming - churning a name that was
 * already fine, or landing on top of a file that isn't ours.
 */

async function withVault(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-title-test-"));
  try {
    await mkdir(path.join(dir, "Notes"), { recursive: true });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The per-directory used-names map pull seeds from tracked state. */
function used(...files: string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const names = map.get(dir) ?? new Set<string>();
    names.add(path.posix.basename(file));
    map.set(dir, names);
  }
  return map;
}

test("a note retitled remotely gets its file renamed to match", () =>
  withVault(async (dir) => {
    await writeFile(path.join(dir, "Notes/Shopping list.md"), "Milk", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Shopping list.md", "Groceries", "filename", {
      usedFileNames: used("Notes/Shopping list.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Groceries.md");
    assert.deepEqual(await readdir(path.join(dir, "Notes")), ["Groceries.md"]);
    assert.equal(await readFile(path.join(dir, file), "utf-8"), "Milk", "the rename carries the body across");
  }));

test("a file that already carries the title is left alone", () =>
  withVault(async (dir) => {
    await writeFile(path.join(dir, "Notes/Groceries.md"), "Milk", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Groceries.md", "Groceries", "filename", {
      usedFileNames: used("Notes/Groceries.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Groceries.md");
  }));

test("a uniquified name is already an acceptable spelling, so it isn't walked up on every pull", () =>
  withVault(async (dir) => {
    // The churn trap: "Groceries 2.md" is how pull spells a *second* note
    // titled "Groceries". Its stem decodes to "Groceries 2", which is not
    // the title - but renaming it would only produce "Groceries 3.md" next
    // pull, and "Groceries 4.md" after that.
    await writeFile(path.join(dir, "Notes/Groceries.md"), "Other note", "utf-8");
    await writeFile(path.join(dir, "Notes/Groceries 2.md"), "Milk", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Groceries 2.md", "Groceries", "filename", {
      usedFileNames: used("Notes/Groceries.md", "Notes/Groceries 2.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Groceries 2.md");
  }));

test("a rename never lands on top of a file the vault doesn't track", () =>
  withVault(async (dir) => {
    await writeFile(path.join(dir, "Notes/Shopping list.md"), "Milk", "utf-8");
    // Not in tracked state - something the user put there themselves.
    await writeFile(path.join(dir, "Notes/Groceries.md"), "MINE, UNTRACKED", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Shopping list.md", "Groceries", "filename", {
      usedFileNames: used("Notes/Shopping list.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Groceries 2.md");
    assert.equal(
      await readFile(path.join(dir, "Notes/Groceries.md"), "utf-8"),
      "MINE, UNTRACKED",
      "the untracked file survives untouched",
    );
    assert.equal(await readFile(path.join(dir, file), "utf-8"), "Milk");
  }));

test("a title a file name can only hold with homoglyphs is renamed to that spelling", () =>
  withVault(async (dir) => {
    await writeFile(path.join(dir, "Notes/Old.md"), "Body", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Old.md", "Pat/Alex: notes", "filename", {
      usedFileNames: used("Notes/Old.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Pat⁄Alex꞉ notes.md");
    assert.equal(await readFile(path.join(dir, file), "utf-8"), "Body");
  }));

test("a missing file is placed at its new name without a filesystem rename", () =>
  withVault(async (dir) => {
    // The file is gone locally; pull recreates it further down, and it must
    // be recreated under the note's *current* title, not its old one.
    const file = await renameForRemoteTitle(dir, "Notes/Shopping list.md", "Groceries", "filename", {
      usedFileNames: used("Notes/Shopping list.md"),
      onDisk: false,
    });

    assert.equal(file, "Notes/Groceries.md");
    assert.deepEqual(await readdir(path.join(dir, "Notes")), []);
  }));

test("an in-body vault never renames - the title is in the file, and the name is decoration", () =>
  withVault(async (dir) => {
    await writeFile(path.join(dir, "Notes/Shopping list.md"), "Groceries\n\nMilk", "utf-8");

    const file = await renameForRemoteTitle(dir, "Notes/Shopping list.md", "Groceries", "in-body", {
      usedFileNames: used("Notes/Shopping list.md"),
      onDisk: true,
    });

    assert.equal(file, "Notes/Shopping list.md");
    assert.deepEqual(await readdir(path.join(dir, "Notes")), ["Shopping list.md"]);
  }));

test("the name a rename frees is available to the next note that wants it", () =>
  withVault(async (dir) => {
    // Two notes swapping titles in one pull is the worst case: the first
    // rename must release "A.md" into the pool, or the second collides with
    // a name nothing occupies any more.
    await writeFile(path.join(dir, "Notes/A.md"), "first", "utf-8");
    await writeFile(path.join(dir, "Notes/B.md"), "second", "utf-8");
    const usedFileNames = used("Notes/A.md", "Notes/B.md");

    const first = await renameForRemoteTitle(dir, "Notes/A.md", "C", "filename", { usedFileNames, onDisk: true });
    const second = await renameForRemoteTitle(dir, "Notes/B.md", "A", "filename", { usedFileNames, onDisk: true });

    assert.equal(first, "Notes/C.md");
    assert.equal(second, "Notes/A.md");
    assert.equal(await readFile(path.join(dir, "Notes/A.md"), "utf-8"), "second");
    assert.equal(await readFile(path.join(dir, "Notes/C.md"), "utf-8"), "first");
  }));
