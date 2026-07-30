import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloneState } from "./cloneState.js";
import { pendingRenameTarget, settlePendingRenames } from "./pendingRename.js";

/**
 * Deferred renames: `pull --defer-renames` records the rename it would have
 * performed, and someone else performs it. Everything here is about the
 * window in between - recognizing a rename that got done, not mistaking one
 * that didn't, and being able to finish one nobody got to.
 */

async function withVault(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pending-rename-test-"));
  try {
    await mkdir(path.join(dir, "Notes"), { recursive: true });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ids have to be UUID-shaped: `readNoteId` refuses anything else, and a
 * file whose id doesn't read back is a file with no id at all. */
const NOTE_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";

/** A note file as this vault writes them: body under an id-stamped envelope. */
async function writeNote(dir: string, file: string, id: string, body: string): Promise<void> {
  await writeFile(path.join(dir, file), `---\napple-note-id: ${id}\n---\n\n${body}\n`, "utf-8");
}

function notesWith(file: string, pendingRename?: string): CloneState["notes"] {
  return {
    [NOTE_ID]: {
      file,
      recordChangeTag: "tag",
      modificationDate: 0,
      ...(pendingRename !== undefined ? { pendingRename } : {}),
    },
  };
}

test("pendingRenameTarget resolves the recorded name against the directory the file is in now", () => {
  assert.equal(
    pendingRenameTarget({ file: "Notes/Old.md", recordChangeTag: "", modificationDate: 0, pendingRename: "New.md" }),
    "Notes/New.md",
  );
  // The reason a bare name is stored rather than a path: a pull that both
  // retitles and relocates a note moves the file after recording the rename,
  // and a stored path would still point into the folder it just left.
  assert.equal(
    pendingRenameTarget({ file: "Archive/Old.md", recordChangeTag: "", modificationDate: 0, pendingRename: "New.md" }),
    "Archive/New.md",
  );
});

test("pendingRenameTarget is nothing when the file already has the pending name", () => {
  assert.equal(
    pendingRenameTarget({ file: "Notes/New.md", recordChangeTag: "", modificationDate: 0, pendingRename: "New.md" }),
    undefined,
  );
  assert.equal(pendingRenameTarget({ file: "Notes/New.md", recordChangeTag: "", modificationDate: 0 }), undefined);
});

test("a rename the consumer performed is adopted, not re-discovered as a mystery move", () =>
  withVault(async (dir) => {
    // This is the whole point of settling before anything else runs: push's
    // id-based move pairing would otherwise read the file's new location as
    // the user retitling the note, and send a retitle back to iCloud for a
    // title that came from iCloud in the first place.
    await writeNote(dir, "Notes/Groceries.md", NOTE_ID, "Milk");
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: false });

    assert.equal(settled.changed, true);
    assert.equal(notes[NOTE_ID]?.file, "Notes/Groceries.md");
    assert.equal(notes[NOTE_ID]?.pendingRename, undefined);
    assert.deepEqual(settled.performed, []);
  }));

test("a file with the right name but the wrong note's id is never adopted", () =>
  withVault(async (dir) => {
    // "Something is at the target name" is not the same as "our note moved
    // there" - the user could have created it, or another note could have
    // drifted into it. Adopting it would point tracked state at someone
    // else's file and push that file's contents as this note.
    await writeNote(dir, "Notes/Groceries.md", OTHER_ID, "Not ours");
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: false });

    assert.equal(settled.changed, true);
    assert.equal(notes[NOTE_ID]?.file, "Notes/Shopping list.md", "the note stays where it was tracked");
    assert.equal(notes[NOTE_ID]?.pendingRename, undefined, "and the rename is moot either way");
  }));

test("an outstanding rename is left alone when nobody asked for it to be performed", () =>
  withVault(async (dir) => {
    await writeNote(dir, "Notes/Shopping list.md", NOTE_ID, "Milk");
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: false });

    assert.equal(settled.changed, false);
    assert.equal(notes[NOTE_ID]?.pendingRename, "Groceries.md");
    assert.deepEqual(await readdir(path.join(dir, "Notes")), ["Shopping list.md"]);
  }));

test("performing finishes a rename nobody got to - how a stuck vault gets unstuck", () =>
  withVault(async (dir) => {
    await writeNote(dir, "Notes/Shopping list.md", NOTE_ID, "Milk");
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: true });

    assert.deepEqual(settled.performed, [{ from: "Notes/Shopping list.md", to: "Notes/Groceries.md" }]);
    assert.equal(notes[NOTE_ID]?.file, "Notes/Groceries.md");
    assert.equal(notes[NOTE_ID]?.pendingRename, undefined);
    assert.deepEqual(await readdir(path.join(dir, "Notes")), ["Groceries.md"]);
    assert.match(await readFile(path.join(dir, "Notes/Groceries.md"), "utf-8"), /Milk/);
  }));

test("performing refuses to write over whatever arrived at the target name, and says so", () =>
  withVault(async (dir) => {
    await writeNote(dir, "Notes/Shopping list.md", NOTE_ID, "Milk");
    await writeFile(path.join(dir, "Notes/Groceries.md"), "MINE, UNTRACKED", "utf-8");
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: true });

    assert.deepEqual(settled.blocked, [{ file: "Notes/Shopping list.md", to: "Notes/Groceries.md" }]);
    assert.deepEqual(settled.performed, []);
    assert.equal(notes[NOTE_ID]?.pendingRename, "Groceries.md", "still pending, so the reader is told again next time");
    assert.equal(await readFile(path.join(dir, "Notes/Groceries.md"), "utf-8"), "MINE, UNTRACKED");
  }));

test("a pending rename to the name the file already has is just cleared", () =>
  withVault(async (dir) => {
    // Reachable when a later pull renames the file itself (a plain `pull`
    // after a deferred one), or when the note is retitled back.
    await writeNote(dir, "Notes/Groceries.md", NOTE_ID, "Milk");
    const notes = notesWith("Notes/Groceries.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: true });

    assert.equal(settled.changed, true);
    assert.equal(notes[NOTE_ID]?.pendingRename, undefined);
    assert.deepEqual(settled.performed, [], "nothing moved - the file was already there");
  }));

test("a file that went missing entirely drops its pending rename", () =>
  withVault(async (dir) => {
    // Neither at its tracked path nor at the target: deleted, or renamed to
    // something else entirely. Both are questions the ordinary missing-file
    // machinery answers, and a stale pending rename would only confuse it.
    const notes = notesWith("Notes/Shopping list.md", "Groceries.md");

    const settled = await settlePendingRenames(dir, notes, { perform: true });

    assert.equal(settled.changed, true);
    assert.equal(notes[NOTE_ID]?.file, "Notes/Shopping list.md");
    assert.equal(notes[NOTE_ID]?.pendingRename, undefined);
  }));

test("notes with nothing pending are not touched", () =>
  withVault(async (dir) => {
    const notes = notesWith("Notes/Groceries.md");
    const before = notes[NOTE_ID];

    const settled = await settlePendingRenames(dir, notes, { perform: true });

    assert.equal(settled.changed, false);
    assert.equal(notes[NOTE_ID], before, "the same object, so nothing was needlessly rewritten");
  }));
