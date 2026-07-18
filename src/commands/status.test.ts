import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState } from "../notes/cloneState.js";
import { NotClonedDirectoryError, UnboundAccountError } from "../errors.js";
import { runStatus } from "./status.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "status-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runStatus refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runStatus(dir), NotClonedDirectoryError);
  }));

test("runStatus returns no entries for an already-clean, untracked-file-free directory", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, { syncToken: "token", notes: {} });

    const result = await runStatus(dir);

    assert.deepEqual(result.entries, []);
  }));

test("runStatus reports an untracked file's local refusal exactly like push --dry-run would, without needing a bound account", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, {
      syncToken: "token",
      notes: {},
      folders: { "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" } },
    });
    await mkdir(path.join(dir, "Notes"), { recursive: true });
    await writeFile(path.join(dir, "Notes", "Empty Note.md"), "", "utf-8");

    const result = await runStatus(dir);

    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.kind, "create");
    assert.equal(result.entries[0]?.resolution, "refused");
    assert.match(result.entries[0]?.file ?? "", /Empty Note\.md/);
    assert.match(result.entries[0]?.reason ?? "", /the file is empty - nothing to create/);
  }));

test("runStatus requires the same live check push does for a creatable untracked file - reaches the network and fails without a bound account", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, {
      syncToken: "token",
      notes: {},
      folders: { "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" } },
    });
    await mkdir(path.join(dir, "Notes"), { recursive: true });
    await writeFile(path.join(dir, "Notes", "New Note.md"), "Hello", "utf-8");

    await assert.rejects(() => runStatus(dir), UnboundAccountError);
  }));

test("runStatus requires the same live check push does for a missing tracked file - reaches the network and fails without a bound account", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, {
      syncToken: "token",
      notes: { REC1: { file: "Tracked.md", recordChangeTag: "1a", modificationDate: 100 } },
    });

    await assert.rejects(() => runStatus(dir), UnboundAccountError);
  }));
