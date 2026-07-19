import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "./baseCopy.js";
import type { CloneStateNoteEntry } from "./cloneState.js";
import { localFileState } from "./localFileState.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "localfilestate-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REC = "REC1";
const ENTRY: CloneStateNoteEntry = { file: "Note.md", recordChangeTag: "1a", modificationDate: 100 };
const BODY = "# Title\nbody line";

async function seed(dir: string, fileContent: string): Promise<void> {
  await mkdir(path.join(dir, path.dirname(ENTRY.file)), { recursive: true });
  await writeFile(path.join(dir, ENTRY.file), fileContent, "utf-8");
  await writeBaseCopy(dir, REC, BODY);
}

test("a file matching the base copy is clean", () =>
  withTempDir(async (dir) => {
    await seed(dir, BODY);
    assert.equal(await localFileState(dir, ENTRY, REC), "clean");
  }));

test("adding local-only frontmatter leaves the note clean (not a pushable edit)", () =>
  withTempDir(async (dir) => {
    await seed(dir, `---\ntags: [personal]\n---\n${BODY}`);
    assert.equal(await localFileState(dir, ENTRY, REC), "clean");
  }));

test("frontmatter with a blank-line separator is still clean", () =>
  withTempDir(async (dir) => {
    await seed(dir, `---\ntags: [personal]\n---\n\n${BODY}`);
    assert.equal(await localFileState(dir, ENTRY, REC), "clean");
  }));

test("editing the body under frontmatter is modified", () =>
  withTempDir(async (dir) => {
    await seed(dir, `---\ntags: [personal]\n---\n# Title\nan edited body line`);
    assert.equal(await localFileState(dir, ENTRY, REC), "modified");
  }));

test("editing the body with no frontmatter is modified", () =>
  withTempDir(async (dir) => {
    await seed(dir, "# Title\nan edited body line");
    assert.equal(await localFileState(dir, ENTRY, REC), "modified");
  }));

test("a missing file is missing", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, REC, BODY);
    assert.equal(await localFileState(dir, ENTRY, REC), "missing");
  }));
