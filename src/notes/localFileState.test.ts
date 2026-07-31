import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "./baseCopy.js";
import type { CloneStateNoteEntry } from "./cloneState.js";
import { localFileState, readLocalNote } from "./localFileState.js";
import { composeNoteFile } from "./noteIdFrontmatter.js";

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
/** `composeNoteFile` stamps an id, and only a UUID-shaped one reads back. */
const NOTE_ID = "089D915D-C76E-4F44-AB80-2190073281A3";

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

test("a filename-as-title note whose body starts blank is clean, exactly as cloned", () =>
  withTempDir(async (dir) => {
    // Reported live (2026-07-30): every note in a freshly cloned
    // filename-as-title vault read as modified. Apple's editors leave an empty
    // paragraph under a note's title, so once the title moves into the file
    // *name* the body's own first line is blank - and splitting the file
    // without the vault's shape in mind folded that line into the envelope,
    // so the body could never equal the base copy `clone` had just written.
    const body = "\n**Yield:** 8 servings";
    await mkdir(path.join(dir, path.dirname(ENTRY.file)), { recursive: true });
    // Composed the way `clone` composes it, so this can't drift from reality.
    await writeFile(path.join(dir, ENTRY.file), composeNoteFile("", body, NOTE_ID), "utf-8");
    await writeBaseCopy(dir, REC, body);

    assert.equal(await localFileState(dir, ENTRY, REC, "filename"), "clean");
  }));

test("trimming that leading blank line is a real edit, and reads as one", () =>
  withTempDir(async (dir) => {
    // The flip side, and why this can't be papered over by normalizing: the
    // blank line is the note's own empty paragraph, so a user who deletes it
    // has deleted something, and push should say so.
    await mkdir(path.join(dir, path.dirname(ENTRY.file)), { recursive: true });
    await writeFile(path.join(dir, ENTRY.file), composeNoteFile("", "**Yield:** 8 servings", NOTE_ID), "utf-8");
    await writeBaseCopy(dir, REC, "\n**Yield:** 8 servings");

    assert.equal(await localFileState(dir, ENTRY, REC, "filename"), "modified");
  }));

// --- The split the state was judged on, handed back ---------------------------
//
// `push` needs both halves of every tracked file it looks at - the body to
// compare and send, and the envelope to read `apple-note-title` out of - and
// reading the same file twice to get them is how the two can drift apart.

test("readLocalNote hands back the frontmatter a clean file carries", () =>
  withTempDir(async (dir) => {
    await seed(dir, `---\napple-note-title: A very long title\n---\n${BODY}`);

    const local = await readLocalNote(dir, ENTRY, REC);

    assert.notEqual(local.status, "missing");
    if (local.status === "missing") {
      throw new Error("unreachable");
    }
    assert.equal(local.status, "clean", "a frontmatter-only difference is still clean");
    assert.equal(local.body, BODY);
    assert.match(local.frontmatter, /apple-note-title: A very long title/);
  }));

test("readLocalNote splits with the vault's shape, so a blank first body line survives", () =>
  withTempDir(async (dir) => {
    const body = "\n**Yield:** 8 servings";
    await mkdir(path.join(dir, path.dirname(ENTRY.file)), { recursive: true });
    await writeFile(path.join(dir, ENTRY.file), composeNoteFile("", body, NOTE_ID), "utf-8");
    await writeBaseCopy(dir, REC, body);

    const local = await readLocalNote(dir, ENTRY, REC, "filename");

    assert.notEqual(local.status, "missing");
    if (local.status === "missing") {
      throw new Error("unreachable");
    }
    assert.equal(local.status, "clean");
    assert.equal(local.body, body, "the note's own empty first paragraph is body, not envelope");
  }));

test("readLocalNote reports a vanished file as missing, with no content to offer", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, REC, BODY);

    assert.deepEqual(await readLocalNote(dir, ENTRY, REC), { status: "missing" });
  }));
