/**
 * The live integration suite: real clones of a real iCloud account, real
 * pushes and pulls, checked against both a second independent clone and what
 * Apple's own web client shows.
 *
 * Off unless ICLOUD_MD_ITEST=1. See integration/README.md.
 *
 * Subtests run sequentially and share one run context: cloning the account
 * and booting the browser are the expensive steps, so they happen once.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { RunContext } from "./harness.js";
import { plantTiedAnchorDeletion } from "./tiedAnchorDeletion.js";
import { readFrontmatterField, stripFrontmatter, type Vault } from "./vault.js";

const enabled = process.env.ICLOUD_MD_ITEST === "1";

/**
 * Retitles a note from a standard (in-body) vault, so the change arrives at
 * the vault under test as a genuinely remote one.
 *
 * Rewrites the whole file rather than just its body: the frontmatter carries
 * `apple-note-id`, and dropping it would turn a retitle into an untracked
 * file that push has to re-identify.
 */
async function retitleFromOtherVault(other: Vault, noteId: string, from: string, to: string): Promise<void> {
  await other.pull();
  const file = await other.findByNoteId(noteId);
  assert.ok(file !== undefined, `the other vault should see note ${noteId}`);

  const contents = await other.readNote(file);
  assert.ok(contents.includes(from), `expected to find the old title in ${file}`);
  await other.writeNote(file, contents.replace(from, to));

  const pushed = await other.push();
  assert.equal(pushed.exitCode, 0, `retitle push should succeed:\n${pushed.stdout}`);
}

describe("live sync against a real iCloud account", { concurrency: 1, skip: enabled ? false : "set ICLOUD_MD_ITEST=1 to run" }, () => {
  let run: RunContext;
  let vault: Vault;

  before(async () => {
    run = await RunContext.begin();
    vault = run.primary;
  });

  after(async () => {
    if (run !== undefined) {
      await run.end();
    }
  });

  it("clones the account and sees the containment folder", () => {
    assert.equal(vault.titleMode, "in-body");
    assert.ok(vault.folderDir.endsWith(run.config.folder), `expected a directory for the test folder, got ${vault.folderDir}`);
  });

  it("pushes a new note that the web client then shows, with formatting intact", async () => {
    const title = run.title("create canary");
    const fileName = "create-canary.md";
    await vault.writeNote(
      fileName,
      [`# ${title}`, "", "# A heading", "- first bullet", "- second bullet", "", "plain body line", ""].join("\n"),
    );

    const pushed = await vault.push();
    assert.equal(pushed.exitCode, 0);

    // The note is now tracked, and its id is the handle the oracle needs.
    const noteId = await vault.noteId(fileName);
    assert.match(noteId, /^[0-9A-Fa-f-]{36}$/);

    // A vault must settle after a push: hand-authored markdown gets
    // canonicalised on the way out (here, remark escapes the leading "[" of
    // the title), and a vault that never reconciles that would report the
    // file as modified forever.
    const settled = await vault.status();
    assert.equal(settled.exitCode, 0, `status should be clean after push, got:\n${settled.stdout}`);

    // Oracle 1: Apple's own client.
    const oracle = await run.oracle();
    const web = await oracle.readNote(noteId);
    assert.equal(web.title, title, "the web client should show the note's title");

    const kinds = web.paragraphs.filter((p) => p.text !== "").map((p) => `${p.kind}:${p.text}`);
    assert.deepEqual(kinds, [
      `title:${title}`,
      "title:A heading",
      "bulletList:first bullet",
      "bulletList:second bullet",
      "body:plain body line",
    ]);

    // Oracle 2: an independent clone must reconstruct the same markdown. It
    // is found by note id, not file name - a fresh clone names the file after
    // the note's title, which is not what this test called it locally. Both
    // sides are compared after a pull, so each holds the canonical rendering
    // rather than one holding this test's hand-authored spelling of it.
    await vault.pull();
    const second = await run.vault("second");
    const secondFile = await second.findByNoteId(noteId);
    assert.ok(secondFile !== undefined, `a fresh clone should contain the note (${noteId})`);
    assert.equal(
      stripFrontmatter(await second.readNote(secondFile)).trim(),
      stripFrontmatter(await vault.readNote(fileName)).trim(),
      "a fresh clone should reproduce the same markdown",
    );
  });

  it("pushes a local edit that the web client then shows", async () => {
    const title = run.title("edit canary");
    const fileName = "edit-canary.md";
    await vault.writeNote(fileName, [`# ${title}`, "", "original line", ""].join("\n"));
    await vault.push();
    const noteId = await vault.noteId(fileName);

    await vault.writeNote(fileName, [`# ${title}`, "", "edited line", "", "- added bullet", ""].join("\n"));
    await vault.push();
    await vault.pull();

    const web = await (await run.oracle()).readNote(noteId);
    assert.equal(web.title, title);
    assert.match(web.plainText, /edited line/);
    assert.doesNotMatch(web.plainText, /original line/);
    assert.ok(
      web.paragraphs.some((p) => p.kind === "bulletList" && p.text === "added bullet"),
      `expected an added bullet, got ${JSON.stringify(web.paragraphs.map((p) => `${p.kind}:${p.text}`))}`,
    );

    assert.equal((await vault.status()).exitCode, 0, "the vault should settle after pushing an edit");
  });

  it("pushes a deletion that an open web client merges into its held copy - not just re-decodes", async () => {
    // The other web-oracle tests read cold: the client decodes our stored
    // bytes, so it agrees with whatever we wrote by construction. This one
    // observes the *incremental merge* instead - the path every claim about
    // clocks and tombstone anchors is actually about, and the one where the
    // pre-#12 table bug hid (deletions that looked fine cold and were
    // discarded by any client already holding the text).
    const title = run.title("merge canary");
    const fileName = "merge-canary.md";
    await vault.writeNote(fileName, [`# ${title}`, "", "alpha bravo charlie delta", ""].join("\n"));
    assert.equal((await vault.push()).exitCode, 0);
    const noteId = await vault.noteId(fileName);

    // Open the note; the client now holds its document in memory.
    const oracle = await run.oracle();
    const before = await oracle.readNote(noteId);
    assert.match(before.plainText, /alpha bravo charlie delta/);

    // Push a mid-text deletion from the clone, behind the open client's back.
    await vault.writeNote(fileName, [`# ${title}`, "", "alpha delta", ""].join("\n"));
    assert.equal((await vault.push()).exitCode, 0);

    // Drive the client's own forced reload (`Note.load(id, true)` - the same
    // call its sync path makes when a changed record arrives without a body).
    // The reload fetches the full record and hands the body to
    // `topoTextManager.load`, whose held-copy branch is Apple's merge.
    const reloaded = await oracle.forceReloadNote(noteId);
    assert.ok(reloaded !== undefined, "the open client should know the note it is displaying");

    // The open client - no navigation, no page load - must now show the
    // deletion: our tombstone's restamped style timestamp out-ranked the
    // held run's, so the merge adopted it.
    const deadline = Date.now() + 30_000;
    let after = await oracle.rereadOpenNote(noteId);
    while (Date.now() < deadline && !/alpha delta/.test(after.plainText)) {
      after = await oracle.rereadOpenNote(noteId);
    }
    assert.match(after.plainText, /alpha delta/, "the merged copy should contain the deletion");
    assert.doesNotMatch(after.plainText, /bravo charlie/, "the deleted words should be gone from the merged copy");

    // And it must have got there by *merging*: Apple's CRDTManager records a
    // trace only on its held-copy branch (`if (!existing) store; else merge`),
    // so a trace naming both texts is the client's own testimony that it
    // merged our document into the copy it already had. A reload-and-decode
    // would leave no trace at all.
    const traces = await oracle.mergeTraces();
    assert.ok(traces !== undefined, "Apple's diagnose hook should be reachable");
    const witness = traces.topoTextMergeTraces
      .filter((trace) => trace !== null)
      .map((trace) => ({
        ours: JSON.stringify(trace.oursBefore ?? ""),
        theirs: JSON.stringify(trace.theirsBefore ?? ""),
        after: JSON.stringify(trace.oursAfter ?? ""),
      }))
      .find((trace) => trace.ours.includes("alpha bravo charlie delta") && trace.theirs.includes(title));
    assert.ok(witness, "the client should have recorded a merge whose 'ours' side is the pre-deletion text");
    assert.match(witness.theirs, /"tombstone":\s*true/, "our pushed document should carry the deletion as a tombstone");
    assert.match(witness.after, /"tombstone":\s*true/, "the merge result should have adopted the tombstone");
    assert.doesNotMatch(
      witness.after.replace(/\\n/g, " "),
      /"string":"[^"]*bravo charlie[^"]*"/,
      "the merge result's visible text should not contain the deleted words",
    );
  });

  it("pushes a tied-anchor deletion that an open web client discards - the negative control", async () => {
    // The other half of the proof above. That test shows a *correctly*
    // restamped deletion surviving the merge; on its own it only shows that
    // some deletion merges. This one pushes the same edit with one thing
    // changed - the tombstones keep their original style timestamp instead
    // of being restamped - and the client must throw it away. Same edit,
    // opposite outcome, the difference being the clock discipline alone.
    //
    // The stamp is a *tie*, not a loss: our tombstone claims exactly the
    // timestamp the client's own copy of that run carries, which is the
    // closest a wrong deletion can come to winning Apple's last-writer-wins
    // comparison without winning it. See tiedAnchorDeletion.ts.
    //
    // This note is deliberately divergent from what the account holds, so it
    // is never reused for another assertion; teardown removes it with the
    // rest of the run's fixtures.
    const title = run.title("tied anchor canary");
    const fileName = "tied-anchor-canary.md";
    await vault.writeNote(fileName, [`# ${title}`, "", "epsilon zeta eta theta", ""].join("\n"));
    assert.equal((await vault.push()).exitCode, 0);
    const noteId = await vault.noteId(fileName);

    // Open the note; the client now holds its document in memory.
    const oracle = await run.oracle();
    const before = await oracle.readNote(noteId);
    assert.match(before.plainText, /epsilon zeta eta theta/);

    // Plant the wrong deletion behind the open client's back, through the
    // same records/modify call push uses.
    const planted = await plantTiedAnchorDeletion({ vaultDir: vault.dir, noteId, deleteText: "zeta eta " });
    assert.equal(planted.result.ok, true, `planting should be accepted by CloudKit: ${JSON.stringify(planted.result)}`);
    assert.ok(planted.tiedRuns > 0, "the planted document should carry at least one tombstone");
    assert.doesNotMatch(planted.newText, /zeta eta/, "the planted document should claim the deletion happened");
    // Prove the plant is the weaker of the two shapes, not just a different
    // one: every tombstone kept a stamp a correct push would have raised.
    for (const [index, tied] of planted.tiedAnchors.entries()) {
      const correct = planted.correctAnchors[index];
      assert.ok(correct !== undefined && correct.clock > tied.clock, `tombstone ${index} should carry the losing stamp`);
    }

    // Drive the same forced reload the positive test uses, so the client
    // takes its merge path against the copy it already holds.
    const reloaded = await oracle.forceReloadNote(noteId);
    assert.ok(reloaded !== undefined, "the open client should know the note it is displaying");

    // Waiting on a clock would only ever prove "nothing had happened yet".
    // Wait on the client's own testimony instead: poll until CRDTManager
    // records a merge naming this note, which is the client saying it
    // received our document and ran it through the held-copy branch. Only
    // then is "the text is still there" evidence of a *rejected* deletion
    // rather than of a push still in flight.
    const deadline = Date.now() + 30_000;
    let witness: { ours: string; theirs: string; after: string } | undefined;
    while (Date.now() < deadline && witness === undefined) {
      const traces = await oracle.mergeTraces();
      assert.ok(traces !== undefined, "Apple's diagnose hook should be reachable");
      // `mergeTraces` only reads the client's rolling buffer (and cleans up
      // the download link it made), so polling it is safe; pace it anyway
      // rather than spinning on `diagnose()`.
      await new Promise((resolve) => setTimeout(resolve, 500));
      witness = traces.topoTextMergeTraces
        .filter((trace) => trace !== null)
        .map((trace) => ({
          ours: JSON.stringify(trace.oursBefore ?? ""),
          theirs: JSON.stringify(trace.theirsBefore ?? ""),
          after: JSON.stringify(trace.oursAfter ?? ""),
        }))
        .find((trace) => trace.ours.includes("epsilon zeta eta theta") && trace.theirs.includes(title));
    }
    assert.ok(witness, "the client should have recorded a merge whose 'ours' side is the pre-deletion text");

    // Our side really did carry the deletion...
    assert.match(witness.theirs, /"tombstone":\s*true/, "our planted document should have carried the deletion as a tombstone");
    // ...and the merge threw it away: the result still holds the words.
    assert.match(
      witness.after.replace(/\\n/g, " "),
      /"string":"[^"]*zeta eta[^"]*"/,
      "the merge result should have kept the text our losing tombstone tried to delete",
    );

    // The same conclusion from the outside, through the editor rather than
    // the debug hook: the open tab still shows the words.
    const after = await oracle.rereadOpenNote(noteId);
    assert.match(
      after.plainText,
      /epsilon zeta eta theta/,
      "the open client should have discarded the tied-anchor deletion, but the words vanished",
    );
  });

  it("creates a Notes folder for a new directory, and the note inside it", async () => {
    const folderName = run.title("new folder");
    const title = run.title("note in a new folder");
    const file = vault.inFolder(`${folderName}/note-in-new-folder.md`);

    await vault.writeVaultFile(file, [`# ${title}`, "", "inside a brand new folder", ""].join("\n"));

    // The folder shows in the plan as its own entry, ahead of the note.
    const preview = await vault.status();
    const folderEntry = preview.json.entries.find((entry) => entry.kind === "createFolder");
    assert.ok(folderEntry !== undefined, `expected a folder create in the plan, got ${JSON.stringify(preview.json.entries)}`);
    assert.equal(folderEntry.folderTitle, folderName);

    const pushed = await vault.push();
    assert.equal(pushed.exitCode, 0);
    assert.ok(
      pushed.json.entries.some((entry) => entry.kind === "createFolder" && entry.outcome?.succeeded === true),
      `the folder create should have succeeded: ${JSON.stringify(pushed.json.entries)}`,
    );

    // Apple's own client must show the note, in the new folder.
    const noteId = await vault.noteIdOf(file);
    const web = await (await run.oracle()).readNote(noteId);
    assert.equal(web.title, title);

    // And a fresh clone must reproduce the *directory*, which only happens
    // if a real Folder record now exists remotely. The file is located by
    // note id: a fresh clone names it after the note's title, not after
    // whatever this test called it locally.
    const second = await run.vault("folder-check");
    const rebuilt = await second.findFileByNoteId(noteId);
    assert.ok(rebuilt !== undefined, `a fresh clone should contain the note (${noteId})`);
    assert.equal(
      path.posix.dirname(rebuilt),
      vault.inFolder(folderName),
      `a fresh clone should place the note in "${folderName}/"`,
    );
    assert.equal((await vault.status()).exitCode, 0, "the vault should settle after creating a folder");
  });

  it("creates a nested folder tree in one push, parents before children", async () => {
    const parent = run.title("outer");
    const file = vault.inFolder(`${parent}/middle/inner/deep-note.md`);
    const title = run.title("deeply nested note");

    await vault.writeVaultFile(file, [`# ${title}`, "", "three levels down", ""].join("\n"));

    const pushed = await vault.push();
    assert.equal(pushed.exitCode, 0);

    const folderEntries = pushed.json.entries.filter((entry) => entry.kind === "createFolder");
    assert.deepEqual(
      folderEntries.map((entry) => entry.file),
      [vault.inFolder(parent), vault.inFolder(`${parent}/middle`), vault.inFolder(`${parent}/middle/inner`)],
      "folders should be created outermost first",
    );
    for (const entry of folderEntries) {
      assert.equal(entry.outcome?.succeeded, true, `${entry.file} failed: ${entry.outcome?.message}`);
    }

    // The nesting is only real if a fresh clone rebuilds the same tree.
    const noteId = await vault.noteIdOf(file);
    const second = await run.vault("nested-check");
    const rebuilt = await second.findFileByNoteId(noteId);
    assert.ok(rebuilt !== undefined, `a fresh clone should contain the nested note (${noteId})`);
    assert.equal(
      path.posix.dirname(rebuilt),
      vault.inFolder(`${parent}/middle/inner`),
      "a fresh clone should rebuild the whole nested tree",
    );
  });

  it("refuses to create a folder inside another user's shared area", async () => {
    // A sharer's home directory is not ours to add folders to. Uses whatever
    // shared area the account has; skipped when it has none.
    const shared = await vault.firstSharerHomeDir();
    if (shared === undefined) {
      return;
    }

    const file = `${shared}/${run.title("not allowed")}/note.md`;
    await vault.writeVaultFile(file, ["# nope", "", "body", ""].join("\n"));
    try {
      const preview = await vault.status();
      const entry = preview.json.entries.find((candidate) => candidate.file === file);
      assert.ok(entry !== undefined, `expected an entry for ${file}`);
      assert.equal(entry.resolution, "refused");
      assert.match(entry.reason ?? "", /shared/i);
      assert.equal(
        preview.json.entries.some((candidate) => candidate.kind === "createFolder"),
        false,
        "no folder should be planned inside someone else's share",
      );
    } finally {
      await vault.removeVaultFile(file);
    }
  });

  it("removes a note from the account when its file is deleted locally", async () => {
    const title = run.title("delete canary");
    const fileName = "delete-canary.md";
    await vault.writeNote(fileName, [`# ${title}`, "", "short lived", ""].join("\n"));
    await vault.push();
    const noteId = await vault.noteId(fileName);

    await vault.deleteNoteFile(fileName);
    await vault.push();

    // A fresh clone is the check: the note must be gone from the account, not
    // merely from this working copy.
    const after = await run.vault("after-delete");
    assert.equal(await after.findByNoteId(noteId), undefined, "the deleted note should not appear in a fresh clone");
  });
});

describe(
  "filename-as-title vaults",
  { concurrency: 1, skip: enabled ? false : "set ICLOUD_MD_ITEST=1 to run" },
  () => {
    let run: RunContext;
    /** The vault under test: titles live in file names. */
    let titled: Vault;
    /** A standard vault used to make changes that are "remote" from `titled`'s point of view. */
    let remote: Vault;

    before(async () => {
      run = await RunContext.begin();
      titled = await run.vault("titled", { filenameAsTitle: true });
      remote = run.primary;
    });

    after(async () => {
      if (run !== undefined) {
        await run.end();
      }
    });

    it("clones with titles in file names and no title line in the body", async () => {
      assert.equal(titled.titleMode, "filename");

      const title = run.title("shape check");
      const fileName = `${title}.md`;
      await titled.writeNote(fileName, ["body first line", ""].join("\n"));
      await titled.push();
      await titled.pull();

      const body = stripFrontmatter(await titled.readNote(fileName)).trim();
      assert.equal(body, "body first line", "the title must not be repeated as the body's first line");

      // Apple's own client must still show the file name as the note's title.
      const web = await (await run.oracle()).readNote(await titled.noteId(fileName));
      assert.equal(web.title, title);
    });

    it("projects characters a file name can't carry into homoglyphs, keeping the real title remote", async () => {
      // Square brackets, a colon and a slash: all legal in a note title, none
      // safe in a file name (brackets would break Obsidian wikilinks, the
      // slash is a path separator). The vault carries homoglyphs on disk while
      // the account keeps the literal characters.
      const literalTitle = run.title("brackets [x] colon: slash/ok");
      const projectedName = run.title("brackets ［x］ colon꞉ slash⁄ok");

      await titled.writeNote(`${projectedName}.md`, ["homoglyph body", ""].join("\n"));
      await titled.push();
      await titled.pull();

      assert.ok(await titled.noteExists(`${projectedName}.md`), "the file should keep its homoglyph name across a pull");

      const noteId = await titled.noteId(`${projectedName}.md`);
      const web = await (await run.oracle()).readNote(noteId);
      assert.equal(web.title, literalTitle, "the account should hold the literal characters, not the homoglyphs");
      assert.equal((await titled.status()).exitCode, 0, "the vault should settle - the projection must be stable");
    });

    it("pushes a local file rename as a remote retitle", async () => {
      const before = run.title("rename source");
      const after = run.title("rename target");
      await titled.writeNote(`${before}.md`, ["stable body", ""].join("\n"));
      await titled.push();
      const noteId = await titled.noteId(`${before}.md`);

      await titled.renameNote(`${before}.md`, `${after}.md`);
      await titled.push();

      const web = await (await run.oracle()).readNote(noteId);
      assert.equal(web.title, after, "renaming the file should retitle the note");
      assert.match(web.plainText, /stable body/, "a retitle must not disturb the body");
      assert.equal((await titled.status()).exitCode, 0, "the vault should settle after a rename push");
    });

    it("renames the file when the note is retitled remotely", async () => {
      const original = run.title("remote retitle before");
      const renamed = run.title("remote retitle after");
      await titled.writeNote(`${original}.md`, ["body text", ""].join("\n"));
      await titled.push();
      const noteId = await titled.noteId(`${original}.md`);

      // Retitle from the other vault - a genuine remote change, since that
      // vault is a separate replica with its own history.
      await retitleFromOtherVault(remote, noteId, original, renamed);

      const pulled = await titled.pull();
      assert.ok(await titled.noteExists(`${renamed}.md`), `expected the file to be renamed to "${renamed}.md"`);
      assert.equal(await titled.noteExists(`${original}.md`), false, "the old file name should be gone");

      const change = pulled.json.changes.find((entry) => entry.file.endsWith(`${renamed}.md`));
      assert.ok(change !== undefined, `the pull should report the rename, got ${JSON.stringify(pulled.json.changes)}`);
      assert.ok(change.previousFile?.endsWith(`${original}.md`), "the change should carry the previous file name");
    });

    it("--defer-renames reports the rename instead of performing it", async () => {
      const original = run.title("deferred before");
      const renamed = run.title("deferred after");
      await titled.writeNote(`${original}.md`, ["deferred body", ""].join("\n"));
      await titled.push();
      const noteId = await titled.noteId(`${original}.md`);

      await retitleFromOtherVault(remote, noteId, original, renamed);

      const deferred = await titled.pull(["--defer-renames"]);
      assert.ok(await titled.noteExists(`${original}.md`), "the file must stay put when renames are deferred");
      assert.equal(await titled.noteExists(`${renamed}.md`), false, "no rename should have been performed");

      const change = deferred.json.changes.find((entry) => entry.pendingRename !== undefined);
      assert.ok(change !== undefined, `expected a pendingRename, got ${JSON.stringify(deferred.json.changes)}`);
      assert.ok(change.pendingRename?.endsWith(`${renamed}.md`), `pendingRename should name the new title, got ${change.pendingRename}`);

      // A later plain pull performs what was left undone.
      await titled.pull();
      assert.ok(await titled.noteExists(`${renamed}.md`), "a plain pull should carry out the deferred rename");
    });

    it("pushes an apple-note-title as a retitle, and pull renames the file to match", async () => {
      const before = run.title("frontmatter retitle before");
      const after = run.title("frontmatter retitle after");
      await titled.writeNote(`${before}.md`, ["stable body", ""].join("\n"));
      await titled.push();
      const noteId = await titled.noteId(`${before}.md`);

      // The file keeps its name; only the envelope changes. That is
      // deliberately invisible to the base-copy comparison, so this also
      // proves the key is what made the note a candidate at all.
      const existing = await titled.readNote(`${before}.md`);
      await titled.writeNote(`${before}.md`, `---\napple-note-id: ${noteId}\napple-note-title: "${after}"\n---\n${stripFrontmatter(existing)}`);
      await titled.push();

      const web = await (await run.oracle()).readNote(noteId);
      assert.equal(web.title, after, "the key should have retitled the note");
      assert.match(web.plainText, /stable body/, "a retitle must not disturb the body");
      assert.ok(await titled.noteExists(`${before}.md`), "push must not rename the file - that is pull's job");

      await titled.pull();
      assert.ok(await titled.noteExists(`${after}.md`), "the pull should rename the file to the new title");
      assert.equal(await titled.noteExists(`${before}.md`), false, "the old file name should be gone");
      assert.equal(
        readFrontmatterField(await titled.readNote(`${after}.md`), "apple-note-title"),
        undefined,
        "a title the name now carries must not stay duplicated in frontmatter",
      );
      assert.equal((await titled.status()).exitCode, 0, "the vault should settle after the round trip");
    });

    it("keeps a title no file name can hold in frontmatter, and pushes it exactly once", async () => {
      const before = run.title("unrepresentable retitle");
      // Over MAX_TITLE_LENGTH, so no file name can carry it.
      const after = run.title(`a title far too long for any file name to hold ${"x".repeat(60)}`);
      await titled.writeNote(`${before}.md`, ["stable body", ""].join("\n"));
      await titled.push();
      const noteId = await titled.noteId(`${before}.md`);

      const existing = await titled.readNote(`${before}.md`);
      await titled.writeNote(`${before}.md`, `---\napple-note-id: ${noteId}\napple-note-title: "${after}"\n---\n${stripFrontmatter(existing)}`);
      await titled.push();

      const web = await (await run.oracle()).readNote(noteId);
      assert.equal(web.title, after, "the key is the only channel this title has");

      await titled.pull();
      const file = await titled.findFileByNoteId(noteId);
      assert.ok(file !== undefined, "the note should still be findable by id");
      assert.equal(
        readFrontmatterField(await titled.readVaultFile(file), "apple-note-title"),
        after,
        "a title no name can hold keeps living in frontmatter",
      );
      // The key now records the title the note already has. Pushing again
      // must read that as "nothing to do" rather than as a fresh retitle -
      // otherwise every push would rewrite the title paragraph forever.
      assert.equal((await titled.status()).exitCode, 0, "a key that merely records the title is not a pending change");
    });
  },
);
