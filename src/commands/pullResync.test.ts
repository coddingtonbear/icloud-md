import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBaseCopy, writeBaseCopy } from "../notes/baseCopy.js";
import { writeCloneState, type CloneState, type CloneStateNoteEntry } from "../notes/cloneState.js";
import { splitFrontmatter } from "../notes/frontmatter.js";
import { readNoteId, readNoteTitle } from "../notes/noteIdFrontmatter.js";
import { uniqueFileName } from "../notes/filename.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { compressNoteDocument } from "../notes/noteText.js";
import { recordVersion } from "../notes/versionHistory.js";
import { UnboundAccountError } from "../errors.js";
import { reconcileNotesAfterResync, usedAttachmentNamesFor, type PullSummary } from "./pull.js";
import { buildPushPlan } from "./push.js";

/** Ids have to be UUID-shaped, or `readNoteId` ignores them. */
const EDITED_ID = "3F2A9C1E-7B4D-4E8A-9C61-2D5B8E0F4A17";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pull-resync-test-"));
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

async function fileExists(dir: string, file: string): Promise<boolean> {
  try {
    await access(path.join(dir, file));
    return true;
  } catch {
    return false;
  }
}

function emptySummary(): PullSummary {
  return {
    added: 0,
    updated: 0,
    merged: 0,
    removed: 0,
    attachmentsDownloaded: 0,
    unpublishable: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    unsharedUntracked: 0,
    changes: [],
    conflicts: [],
    notices: [],
  };
}

function entryFor(file: string, sharedZoneOwner?: string): CloneStateNoteEntry {
  return { file, recordChangeTag: "1a", modificationDate: 100, sharedZoneOwner };
}

// A tracked note whose record appears nowhere in a from-scratch listing was
// deleted remotely while the vault's sync token was unusable - a full resend
// carries no tombstone for it, so absence is the only signal there is.

test("a clean tracked note absent from a resynced listing is removed like a tombstoned one", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Gone.md", "body\n");
    await writeBaseCopy(dir, "REC-GONE", "body\n");
    await writeVaultFile(dir, "Notes/Kept.md", "kept body\n");
    await writeBaseCopy(dir, "REC-KEPT", "kept body\n");
    const notes: CloneState["notes"] = {
      "REC-GONE": entryFor("Notes/Gone.md"),
      "REC-KEPT": entryFor("Notes/Kept.md"),
    };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(["REC-KEPT"]), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(notes["REC-GONE"], undefined);
    assert.ok(notes["REC-KEPT"]);
    assert.equal(await fileExists(dir, "Notes/Gone.md"), false);
    assert.equal(await fileExists(dir, "Notes/Kept.md"), true);
    assert.equal(summary.removed, 1);
    assert.deepEqual(summary.changes, [{ kind: "remove", file: "Notes/Gone.md" }]);
  }));

test("an absent note with local edits is kept as a new note: untracked, id cleared, edits intact, no conflict markers", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Edited.md", `---\napple-note-id: ${EDITED_ID}\n---\n\nbody plus my local edit\n`);
    await writeBaseCopy(dir, "REC-EDITED", "body\n");
    const notes: CloneState["notes"] = { "REC-EDITED": entryFor("Notes/Edited.md") };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(notes["REC-EDITED"], undefined);
    assert.equal(await readBaseCopy(dir, "REC-EDITED"), undefined);
    // The envelope held nothing but the id, so it goes entirely; the body is
    // exactly what the user wrote.
    assert.equal(await readFile(path.join(dir, "Notes/Edited.md"), "utf-8"), "body plus my local edit\n");
    assert.deepEqual(summary.conflicts, []);
    assert.equal(summary.removed, 0);
    assert.deepEqual(summary.changes, [
      {
        kind: "untrack",
        file: "Notes/Edited.md",
        remarks: [
          {
            tone: "note",
            message:
              "deleted on another device, but has local edits - kept as a new note; " +
              "the next push creates it - delete the file first if you don't want it back",
          },
        ],
      },
    ]);
  }));

test("a kept note loses only its id: other frontmatter, including a recorded title, stays", () =>
  withTempDir(async (dir) => {
    const envelope = `---\ntags: [recipes]\napple-note-id: ${EDITED_ID}\napple-note-title: "Pie: the sequel"\n---\n\n`;
    await writeVaultFile(dir, "Notes/Pie the sequel.md", `${envelope}crust plus my local edit\n`);
    await writeBaseCopy(dir, "REC-EDITED", "crust\n");
    const notes: CloneState["notes"] = { "REC-EDITED": entryFor("Notes/Pie the sequel.md") };

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, emptySummary(), "filename");

    const written = await readFile(path.join(dir, "Notes/Pie the sequel.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(written, { filenameAsTitle: true });
    assert.equal(readNoteId(frontmatter), undefined);
    assert.equal(readNoteTitle(frontmatter), "Pie: the sequel");
    assert.match(frontmatter, /tags: \[ ?recipes ?\]/);
    assert.equal(body, "crust plus my local edit\n");
  }));

test("a kept note's attachment files stay on disk, only their tracking goes", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/WithAttachment.md", "body plus my local edit\n![](attachments/pic.png)\n");
    await writeBaseCopy(dir, "REC-NOTE", "body\n![](attachments/pic.png)\n");
    await writeVaultFile(dir, "Notes/attachments/pic.png", "png-bytes");
    const notes: CloneState["notes"] = { "REC-NOTE": entryFor("Notes/WithAttachment.md") };
    const attachments: NonNullable<CloneState["attachments"]> = {
      "REC-ATTACHMENT": {
        file: "Notes/attachments/pic.png",
        mediaRecordName: "REC-MEDIA",
        mediaFileChecksum: "checksum",
        noteRecordName: "REC-NOTE",
      },
      "REC-OTHER-ATTACHMENT": {
        file: "Notes/attachments/other.png",
        mediaRecordName: "REC-OTHER-MEDIA",
        mediaFileChecksum: "checksum",
        noteRecordName: "REC-SOME-OTHER-NOTE",
      },
    };
    const tableAttachments: NonNullable<CloneState["tableAttachments"]> = {
      "REC-TABLE": { noteRecordName: "REC-NOTE" },
    };

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, attachments, tableAttachments, emptySummary(), "in-body");

    assert.equal(attachments["REC-ATTACHMENT"], undefined);
    assert.ok(attachments["REC-OTHER-ATTACHMENT"], "another note's attachment is untouched");
    assert.equal(tableAttachments["REC-TABLE"], undefined);
    assert.equal(await fileExists(dir, "Notes/attachments/pic.png"), true);
  }));

test("the next push plans a kept note as a create instead of refusing it", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Edited.md", `---\napple-note-id: ${EDITED_ID}\n---\n\nbody plus my local edit\n`);
    await writeBaseCopy(dir, "REC-EDITED", "body\n");
    const notes: CloneState["notes"] = { "REC-EDITED": entryFor("Notes/Edited.md") };

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, emptySummary(), "in-body");
    await writeCloneState(dir, {
      syncToken: "token",
      folders: { "DefaultFolder-CloudKit": { name: "Notes", dirName: "Notes" } },
      notes,
    });

    // No `account` on state: the UnboundAccountError proves the file passed
    // every local gate - no conflict-marker or "no longer exists remotely"
    // refusal - and the plan went on to need a session for the create.
    await assert.rejects(() => buildPushPlan(dir), UnboundAccountError);
  }));

test("a note with no base copy is kept too, and the remark says it may not have been edited", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Unknown.md", "body\n");
    const notes: CloneState["notes"] = { "REC-UNKNOWN": entryFor("Notes/Unknown.md") };
    const summary = emptySummary();

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(notes["REC-UNKNOWN"], undefined);
    assert.equal(await fileExists(dir, "Notes/Unknown.md"), true);
    assert.equal(summary.changes[0]?.kind, "untrack");
    assert.match(summary.changes[0]?.remarks?.[0]?.message ?? "", /last synced copy is missing, so it may have local edits/);
  }));

test("a kept note from someone else's area says push may not be able to recreate it there", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Shared/Theirs.md", "body plus my local edit\n");
    await writeBaseCopy(dir, "REC-THEIRS", "body\n");
    const notes: CloneState["notes"] = { "REC-THEIRS": entryFor("Shared/Theirs.md", "_sharer") };
    const summary = emptySummary();

    await reconcileNotesAfterResync(dir, "_sharer", new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(notes["REC-THEIRS"], undefined);
    assert.match(summary.changes[0]?.remarks?.[0]?.message ?? "", /move it into one of your own folders/);
  }));

/** Records `text` as the last version pull saw of `recordName`, encoded the
 * way a real Note's `TextDataEncrypted` is. */
async function recordNoteText(dir: string, recordName: string, text: string): Promise<void> {
  const doc = buildInitialNoteDocument(text, new Uint8Array(16).fill(7));
  await recordVersion(dir, {
    recordName,
    recordType: "Note",
    field: "TextDataEncrypted",
    recordChangeTag: "1a",
    valueBase64: compressNoteDocument(encodeNoteDocument(doc)).toString("base64"),
  });
}

test("a kept note at a uniquified file name records its real title, so push doesn't create it as \"Groceries 2\"", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Groceries 2.md", "milk plus eggs\n");
    await writeBaseCopy(dir, "REC-GROCERIES", "milk\n");
    await recordNoteText(dir, "REC-GROCERIES", "Groceries\nmilk");
    const notes: CloneState["notes"] = { "REC-GROCERIES": entryFor("Notes/Groceries 2.md") };

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, emptySummary(), "filename");

    const { frontmatter, body } = splitFrontmatter(await readFile(path.join(dir, "Notes/Groceries 2.md"), "utf-8"), {
      filenameAsTitle: true,
    });
    // Push takes a create's title from `apple-note-title` before the file name.
    assert.equal(readNoteTitle(frontmatter), "Groceries");
    assert.equal(body, "milk plus eggs\n");
  }));

test("a kept note genuinely titled like a uniquified name gets no recorded title", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Groceries 2.md", "milk plus eggs\n");
    await writeBaseCopy(dir, "REC-GROCERIES", "milk\n");
    await recordNoteText(dir, "REC-GROCERIES", "Groceries 2\nmilk");
    const notes: CloneState["notes"] = { "REC-GROCERIES": entryFor("Notes/Groceries 2.md") };

    await reconcileNotesAfterResync(dir, undefined, new Set(), notes, {}, {}, emptySummary(), "filename");

    assert.equal(await readFile(path.join(dir, "Notes/Groceries 2.md"), "utf-8"), "milk plus eggs\n");
  }));

test("attachment names already on disk count as taken, so a download can't land on a kept note's untracked file", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/attachments/image.png", "the last copy");
    const byDir = new Map<string, Set<string>>([["Notes", new Set(["tracked.png"])]]);
    const scanned = new Set<string>();

    const names = await usedAttachmentNamesFor(dir, byDir, scanned, "Notes");

    assert.deepEqual([...names].sort(), ["image.png", "tracked.png"]);
    assert.equal(uniqueFileName("image.png", names), "image 2.png");
    // A directory with no attachments/ at all is fine, and nothing is listed twice.
    assert.deepEqual([...(await usedAttachmentNamesFor(dir, byDir, scanned, "Elsewhere"))], []);
    names.delete("image.png");
    assert.equal((await usedAttachmentNamesFor(dir, byDir, scanned, "Notes")).has("image.png"), false);
  }));

test("reconciliation is scoped to one zone: the private pass never touches shared-zone notes, nor one sharer's pass another's", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/Private.md", "private body\n");
    await writeBaseCopy(dir, "REC-PRIVATE", "private body\n");
    await writeVaultFile(dir, "Notes/SharedA.md", "shared body a\n");
    await writeBaseCopy(dir, "REC-SHARED-A", "shared body a\n");
    await writeVaultFile(dir, "Notes/SharedB.md", "shared body b\n");
    await writeBaseCopy(dir, "REC-SHARED-B", "shared body b\n");
    const notes: CloneState["notes"] = {
      "REC-PRIVATE": entryFor("Notes/Private.md"),
      "REC-SHARED-A": entryFor("Notes/SharedA.md", "_ownerA"),
      "REC-SHARED-B": entryFor("Notes/SharedB.md", "_ownerB"),
    };
    const summary = emptySummary();

    // _ownerA's zone was resynced and its listing is empty: only that zone's
    // note may be reconciled away, however absent the others are from it.
    const removed = await reconcileNotesAfterResync(dir, "_ownerA", new Set(), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(notes["REC-SHARED-A"], undefined);
    assert.ok(notes["REC-PRIVATE"]);
    assert.ok(notes["REC-SHARED-B"]);
    assert.equal(await fileExists(dir, "Notes/Private.md"), true);
    assert.equal(await fileExists(dir, "Notes/SharedB.md"), true);
  }));

test("a note present in the listing under a non-Note record type is not misread as deleted", () =>
  withTempDir(async (dir) => {
    // e.g. a note that was password-protected: same recordName, new record
    // type. The seen-set is built from every record in the listing, so it
    // still counts as present.
    await writeVaultFile(dir, "Notes/Locked.md", "locked body\n");
    await writeBaseCopy(dir, "REC-LOCKED", "locked body\n");
    const notes: CloneState["notes"] = { "REC-LOCKED": entryFor("Notes/Locked.md") };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(["REC-LOCKED"]), notes, {}, {}, summary, "in-body");

    assert.equal(removed, 0);
    assert.ok(notes["REC-LOCKED"]);
    assert.equal(await fileExists(dir, "Notes/Locked.md"), true);
    assert.deepEqual(summary.changes, []);
  }));

test("a reconciled deletion also drops the note's attachment tracking and files", () =>
  withTempDir(async (dir) => {
    await writeVaultFile(dir, "Notes/WithAttachment.md", "body\n");
    await writeBaseCopy(dir, "REC-NOTE", "body\n");
    await writeVaultFile(dir, "Notes/attachments/pic.png", "png-bytes");
    const notes: CloneState["notes"] = { "REC-NOTE": entryFor("Notes/WithAttachment.md") };
    const attachments: NonNullable<CloneState["attachments"]> = {
      "REC-ATTACHMENT": {
        file: "Notes/attachments/pic.png",
        mediaRecordName: "REC-MEDIA",
        mediaFileChecksum: "checksum",
        noteRecordName: "REC-NOTE",
      },
    };
    const summary = emptySummary();

    const removed = await reconcileNotesAfterResync(dir, undefined, new Set(), notes, attachments, {}, summary, "in-body");

    assert.equal(removed, 1);
    assert.equal(attachments["REC-ATTACHMENT"], undefined);
    assert.equal(await fileExists(dir, "Notes/attachments/pic.png"), false);
  }));
