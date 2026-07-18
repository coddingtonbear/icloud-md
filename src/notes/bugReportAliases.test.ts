import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyAliasStore, readAliasStore, resolveAlias, writeAliasStore } from "./bugReportAliases.js";
import { STATE_DIR_NAME } from "./cloneState.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bugreport-aliases-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveAlias mints sequential aliases per category and is stable for a repeated key", () => {
  const store = emptyAliasStore();

  assert.equal(resolveAlias(store, "notes", "REC1"), "note-1");
  assert.equal(resolveAlias(store, "notes", "REC2"), "note-2");
  assert.equal(resolveAlias(store, "notes", "REC1"), "note-1");
  assert.equal(resolveAlias(store, "folders", "REC1"), "folder-1");
});

test("readAliasStore returns an empty store when nothing has been written yet", () =>
  withTempDir(async (dir) => {
    const store = await readAliasStore(dir);
    assert.deepEqual(store, emptyAliasStore());
  }));

test("readAliasStore returns an empty store rather than throwing on a corrupt file", () =>
  withTempDir(async (dir) => {
    await mkdir(path.join(dir, STATE_DIR_NAME), { recursive: true });
    await writeFile(path.join(dir, STATE_DIR_NAME, "bug-report-aliases.json"), "not json", "utf-8");

    const store = await readAliasStore(dir);
    assert.deepEqual(store, emptyAliasStore());
  }));

test("writeAliasStore then readAliasStore round-trips every category", () =>
  withTempDir(async (dir) => {
    const store = emptyAliasStore();
    resolveAlias(store, "notes", "REC1");
    resolveAlias(store, "folders", "FOLDER1");
    resolveAlias(store, "account", "12345");

    await writeAliasStore(dir, store);
    const reread = await readAliasStore(dir);

    assert.deepEqual(reread, store);
  }));
