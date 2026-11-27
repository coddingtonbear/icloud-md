import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBaseCopy } from "../notes/baseCopy.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { CloneStateNoteEntry } from "../notes/cloneState.js";
import { isAlreadyAtTrackedVersion, isResyncedRecordApplied, trackedEntryMatches, type DerivedNoteFields } from "./pull.js";

// The record `push` just wrote comes straight back on the next incremental
// pull. When nothing about it differs from what the vault tracks, pull must
// leave the file alone instead of rewriting it as an "update".

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-already-at-version-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RECORD_NAME = "REC-1";
/** Pull's own rendering of the record - what the base copy holds once a
 * pull has applied it. */
const BODY = "Groceries\nmilk\n";

function record(recordChangeTag: string | undefined): CloudKitRecord {
  return { recordName: RECORD_NAME, recordType: "Note", fields: {}, ...(recordChangeTag !== undefined ? { recordChangeTag } : {}) };
}

function entry(overrides: Partial<CloneStateNoteEntry> = {}): CloneStateNoteEntry {
  return { file: "Notes/Groceries.md", recordChangeTag: "2b", modificationDate: 100, folderRecordName: "FOLDER-1", ...overrides };
}

function derived(overrides: Partial<DerivedNoteFields> = {}): DerivedNoteFields {
  return {
    titleLine: "Groceries",
    folderRecordName: "FOLDER-1",
    frontmatterTitle: undefined,
    unpublishableReason: undefined,
    ...overrides,
  };
}

/** A tracked note on disk whose body matches its base copy. */
async function writeCleanNote(dir: string, file: string, body: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body, "utf-8");
  await writeBaseCopy(dir, RECORD_NAME, body);
}

test("a re-delivered record at the tracked tag, with nothing else changed, is already applied", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {}), true);
  }));

test("local edits don't stop the skip - an incremental pull that never saw the record wouldn't touch them either", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    await writeFile(path.join(dir, "Notes/Groceries.md"), "Groceries\nmilk\neggs\n", "utf-8");
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {}), true);
  }));

test("a file still carrying conflict markers isn't skipped - pull is where they're reported", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    await writeFile(
      path.join(dir, "Notes/Groceries.md"),
      "Groceries\n<<<<<<< local\neggs\n=======\nbread\n>>>>>>> remote\n",
      "utf-8",
    );
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {}), false);
  }));

test("a different change tag is a real remote change", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("3c"), entry(), derived(), BODY, "in-body", {}), false);
  }));

test("a record with no change tag is never treated as already applied", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record(undefined), entry({ recordChangeTag: "" }), derived(), BODY, "in-body", {}),
      false,
    );
  }));

// `push` writes the text the user typed as the base copy; pull renders the
// same note in its own notation. The re-delivery after a push is what puts
// pull's rendering back as the merge ancestor, so it mustn't be skipped
// while the two differ.

test("a base copy in the user's notation rather than pull's isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\n* milk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "Groceries\n- milk\n", "in-body", {}),
      false,
    );
  }));

test("a record with embeds, which can't be rendered without its attachments, isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), undefined, "in-body", {}), false);
  }));

// `push`/`status` can adopt a remote change (merging its text, advancing the
// tag) without updating anything else that came with it. The re-delivery is
// what brings those fields up to date, so it must not be skipped.

test("a folder move adopted with the tag isn't skipped - the note still has to move", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ folderRecordName: "FOLDER-2" }), BODY, "in-body", {}),
      false,
    );
  }));

test("a changed read-only flag isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ unpublishableReason: "unknown embed" }), BODY, "in-body", {}),
      false,
    );
  }));

test("a changed frontmatter title isn't skipped", () =>
  withTempDir(async (dir) => {
    // The file name carries the title line, so the frontmatter title is the
    // only thing that differs.
    await writeCleanNote(dir, "Notes/Untitled.md", "milk\n");
    const untitled = entry({ file: "Notes/Untitled.md", frontmatterTitle: "a/b" });
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), untitled, derived({ titleLine: "Untitled", frontmatterTitle: "a/c" }), "milk\n", "filename", {}),
      false,
    );
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), untitled, derived({ titleLine: "Untitled", frontmatterTitle: "a/b" }), "milk\n", "filename", {}),
      true,
    );
  }));

test("in a filename-as-title vault, a retitle the file name doesn't reflect yet isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "milk\n");
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived({ titleLine: "Shopping" }), "milk\n", "filename", {}),
      false,
    );
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), "milk\n", "filename", {}), true);
  }));

test("a note with a rename still pending isn't skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry({ pendingRename: "Shopping.md" }), derived(), BODY, "in-body", {}),
      false,
    );
  }));

test("a missing local file isn't skipped - pull recreates it", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, RECORD_NAME, BODY);
    assert.equal(await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {}), false);
  }));

test("a note with tables isn't skipped - their snapshots are taken while resolving attachments", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {
        "TABLE-1": { noteRecordName: RECORD_NAME },
      }),
      false,
    );
    assert.equal(
      await isAlreadyAtTrackedVersion(dir, record("2b"), entry(), derived(), BODY, "in-body", {
        "TABLE-2": { noteRecordName: "SOME-OTHER-NOTE" },
      }),
      true,
    );
  }));

// A resync re-delivers every record and skips the ones already applied. The
// entry still has to match, or a folder move `status` adopted would never
// reach the file.

test("the resync skip still requires the tracked entry to match", () => {
  assert.equal(trackedEntryMatches(entry(), derived(), "in-body"), true);
  assert.equal(trackedEntryMatches(entry(), derived({ folderRecordName: "FOLDER-2" }), "in-body"), false);
  assert.equal(trackedEntryMatches(entry(), derived({ titleLine: "Shopping" }), "filename"), false);
  assert.equal(trackedEntryMatches(entry(), derived({ titleLine: "Shopping" }), "in-body"), true);
});

test("a resynced record at the tracked tag with nothing else changed is skipped", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", BODY);
    assert.equal(await isResyncedRecordApplied(dir, record("2b"), entry(), derived(), BODY, "in-body"), true);
    assert.equal(await isResyncedRecordApplied(dir, record("3c"), entry(), derived(), BODY, "in-body"), false);
    assert.equal(
      await isResyncedRecordApplied(dir, record("2b"), entry(), derived({ folderRecordName: "FOLDER-2" }), BODY, "in-body"),
      false,
    );
  }));

// The resync right after a push is the same re-delivery the incremental skip
// guards: if it's skipped while the base copy is still in the user's
// notation, the next remote edit conflicts on lines nobody touched.

test("a resynced record isn't skipped while the base copy is in the user's notation rather than pull's", () =>
  withTempDir(async (dir) => {
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\n* milk\n");
    assert.equal(await isResyncedRecordApplied(dir, record("2b"), entry(), derived(), "Groceries\n- milk\n", "in-body"), false);
  }));

// Looser than the incremental skip: an incremental pull that never saw the
// record wouldn't touch local edits, a missing file, or a note with embeds.

test("a resynced record is skipped despite local edits, a missing file, or embeds", () =>
  withTempDir(async (dir) => {
    await writeBaseCopy(dir, RECORD_NAME, BODY);
    assert.equal(await isResyncedRecordApplied(dir, record("2b"), entry(), derived(), BODY, "in-body"), true);
    await writeCleanNote(dir, "Notes/Groceries.md", "Groceries\n* milk\n");
    await writeFile(path.join(dir, "Notes/Groceries.md"), "Groceries\n* milk\n* eggs\n", "utf-8");
    assert.equal(await isResyncedRecordApplied(dir, record("2b"), entry(), derived(), undefined, "in-body"), true);
  }));
