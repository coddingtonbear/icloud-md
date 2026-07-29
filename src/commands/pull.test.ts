import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { localFileState } from "../notes/localFileState.js";
import type { CloneStateNoteEntry } from "../notes/cloneState.js";
import { mergeRemoteChangeIntoLocalFile } from "./pull.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeVaultFile(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content, "utf-8");
}

function entryFor(file: string): CloneStateNoteEntry {
  return { file, recordChangeTag: "1a", modificationDate: 100 };
}

// The state-discipline invariant (2026-07-29 device experiments, vault dev
// log): after a clean pull-merge the base copy holds the REMOTE text, so the
// local half of the merge still reads "modified" and the next push uploads it.

test("mergeRemoteChangeIntoLocalFile keeps the local half of a clean merge uploadable - base copy holds the remote text", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "line one\n\nline two\n");
    await writeVaultFile(dir, "Notes/Note.md", "line one edited locally\n\nline two\n");

    const merged = await mergeRemoteChangeIntoLocalFile(dir, "REC1", "Notes/Note.md", "line one\n\nline two edited remotely\n");

    assert.equal(merged.hasConflict, false);
    // The file holds both sides of the merge...
    assert.equal(
      await readFile(path.join(dir, "Notes/Note.md"), "utf-8"),
      "line one edited locally\n\nline two edited remotely\n",
    );
    // ...the base copy holds what the server has (the future merge ancestor)...
    assert.equal(await readBaseCopy(dir, "REC1"), "line one\n\nline two edited remotely\n");
    // ...so the local edit still reads modified for the next push to upload.
    assert.equal(await localFileState(dir, entryFor("Notes/Note.md"), "REC1"), "modified");
  }));

test("mergeRemoteChangeIntoLocalFile with a content-identical remote (tag-only change) leaves the local edit uploadable", () =>
  withTempDir(async (dir) => {
    // The live-reproduced stranding case: iOS re-uploads its replica state
    // with identical text merely because the note is open on a device.
    await writeBaseCopy(dir, "REC1", "shared text\n");
    await writeVaultFile(dir, "Notes/Note.md", "shared text plus my edit\n");

    const merged = await mergeRemoteChangeIntoLocalFile(dir, "REC1", "Notes/Note.md", "shared text\n");

    assert.equal(merged.hasConflict, false);
    assert.equal(await readFile(path.join(dir, "Notes/Note.md"), "utf-8"), "shared text plus my edit\n");
    assert.equal(await readBaseCopy(dir, "REC1"), "shared text\n");
    assert.equal(await localFileState(dir, entryFor("Notes/Note.md"), "REC1"), "modified");
  }));

test("mergeRemoteChangeIntoLocalFile preserves local-only frontmatter above the merged body", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "body\n");
    await writeVaultFile(dir, "Notes/Note.md", "---\nkeep: me\n---\n\nbody edited\n");

    await mergeRemoteChangeIntoLocalFile(dir, "REC1", "Notes/Note.md", "body\n");

    const written = await readFile(path.join(dir, "Notes/Note.md"), "utf-8");
    assert.match(written, /^---\nkeep: me\n---\n/);
    assert.match(written, /body edited\n$/);
  }));

test("mergeRemoteChangeIntoLocalFile on a genuine conflict writes markers and keeps the base copy as the merge ancestor", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, "REC1", "shared line\n");
    await writeVaultFile(dir, "Notes/Note.md", "shared line edited locally\n");

    const merged = await mergeRemoteChangeIntoLocalFile(dir, "REC1", "Notes/Note.md", "shared line edited remotely\n");

    assert.equal(merged.hasConflict, true);
    const written = await readFile(path.join(dir, "Notes/Note.md"), "utf-8");
    assert.match(written, /<<<<<<< local/);
    assert.match(written, />>>>>>> remote/);
    assert.equal(await readBaseCopy(dir, "REC1"), "shared line\n");
  }));
