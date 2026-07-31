import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { CloneStateNoteEntry } from "../notes/cloneState.js";
import { classifyNoteRecord, type OkNoteDecodeResult } from "../notes/decodeNoteRecord.js";
import { buildInitialNoteDocument, encodeNoteDocument } from "../notes/noteDocument.js";
import { decodeNoteFormat } from "../notes/noteFormat.js";
import { compressNoteDocument, decodeNoteString } from "../notes/noteText.js";
import { parseNoteMarkdown } from "../notes/parseNoteMarkdown.js";
import { reconcileNoteFormat } from "../notes/formatReconcile.js";
import { prepareRetitle, restoreStrippedTitle, titleExpressedByFile } from "./push.js";

/**
 * Push's write path for a filename-as-title vault, where the working file
 * holds the note's *body* and its name holds the title. Every test here is
 * about the same hazard: a body-only file must become a whole note again
 * before its text is spliced or its formatting reconciled, and the title
 * that goes back on has to be the right one.
 */

const REPLICA = new Uint8Array(16).fill(7);

/** A Note record carrying a real, round-trippable document - built the same
 * way push's own create path builds one, so the payload these tests decode
 * is the payload shape the tool actually writes. */
function noteRecord(markdown: string, recordChangeTag = "1a"): CloudKitRecord {
  const parsed = parseNoteMarkdown(markdown);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") {
    throw new Error("unreachable");
  }
  const doc = buildInitialNoteDocument(parsed.text, REPLICA);
  const reconciled = reconcileNoteFormat(doc, parsed.paragraphs, REPLICA);
  assert.ok(reconciled.ok);
  const compressed = compressNoteDocument(encodeNoteDocument(doc));
  return {
    recordName: "REC1",
    recordType: "Note",
    recordChangeTag,
    fields: {
      TitleEncrypted: {
        value: Buffer.from(parsed.text.split("\n")[0] ?? "", "utf-8").toString("base64"),
        type: "ENCRYPTED_BYTES",
      },
      TextDataEncrypted: { value: compressed.toString("base64"), type: "ENCRYPTED_BYTES" },
    },
  };
}

/** A Note record built from raw text rather than markdown - for titles the
 * markdown parser would alter, like one ending in whitespace (a line-end
 * space isn't markdown content, but it *is* Apple Notes title content). */
function rawNoteRecord(text: string, recordChangeTag = "1a"): CloudKitRecord {
  const doc = buildInitialNoteDocument(text, REPLICA);
  const compressed = compressNoteDocument(encodeNoteDocument(doc));
  return {
    recordName: "REC1",
    recordType: "Note",
    recordChangeTag,
    fields: {
      TitleEncrypted: {
        value: Buffer.from(text.split("\n")[0] ?? "", "utf-8").toString("base64"),
        type: "ENCRYPTED_BYTES",
      },
      TextDataEncrypted: { value: compressed.toString("base64"), type: "ENCRYPTED_BYTES" },
    },
  };
}

function classifyOk(record: CloudKitRecord, titleMode: "in-body" | "filename"): OkNoteDecodeResult {
  const classified = classifyNoteRecord(record, { titleMode });
  assert.equal(classified.status, "ok");
  if (classified.status !== "ok") {
    throw new Error("unreachable");
  }
  return classified;
}

function parsedBody(markdown: string) {
  const parsed = parseNoteMarkdown(markdown);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") {
    throw new Error("unreachable");
  }
  return { text: parsed.text, paragraphs: parsed.paragraphs };
}

/** What the payload a push would send actually decodes to on the wire. */
function decodePayload(payloadBase64: string): { text: string; firstParagraphKind: string | undefined } {
  const decoded = decodeNoteString(Buffer.from(payloadBase64, "base64"));
  const format = decodeNoteFormat(decoded.string, decoded.attributeRun);
  return {
    text: decoded.string,
    firstParagraphKind: format.status === "ok" ? format.paragraphs[0]?.kind : undefined,
  };
}

const ENTRY: CloneStateNoteEntry = {
  file: "Notes/Shopping list.md",
  recordChangeTag: "1a",
  modificationDate: 100,
  folderRecordName: "DefaultFolder-CloudKit",
};

const SUMMARY = () => ({ conflicts: [] as string[], refused: [] as string[] });

test("an edited body-only file is made whole again with the note's own title paragraph", () => {
  const record = noteRecord("# Shopping list\n\nMilk\nEggs");
  const classified = classifyOk(record, "filename");
  assert.equal(classified.titleStripped, true, "a filename-as-title vault strips the title on the way out");

  // The file on disk after the user adds a line - no title anywhere in it.
  const restored = restoreStrippedTitle(classified, parsedBody("\nMilk\nEggs\nBread"), ENTRY, SUMMARY());

  assert.ok(restored);
  assert.equal(restored.text, "Shopping list\n\nMilk\nEggs\nBread");
  assert.equal(restored.paragraphs[0]?.kind, "title", "the remote paragraph's own style comes back with it");
  assert.deepEqual(
    restored.paragraphs.map((paragraph) => paragraph.start),
    [0, 14, 15, 20, 25],
  );
});

test("an unrenamed note keeps the title the record has, never one re-derived from the file name", () => {
  // The trap: pull's collision uniquifier put a note genuinely titled
  // "Shopping list" at "Shopping list 2.md". Pushing an edit to it must not
  // retitle the note to "Shopping list 2".
  const record = noteRecord("Shopping list\n\nMilk");
  const classified = classifyOk(record, "filename");

  const restored = restoreStrippedTitle(
    classified,
    parsedBody("\nMilk\nEggs"),
    { ...ENTRY, file: "Notes/Shopping list 2.md" },
    SUMMARY(),
  );

  assert.equal(restored?.text, "Shopping list\n\nMilk\nEggs");
});

test("an in-body vault's file already carries its title, so nothing is prepended", () => {
  const record = noteRecord("Shopping list\n\nMilk");
  const classified = classifyOk(record, "in-body");
  const parsed = parsedBody("Shopping list\n\nMilk\nEggs");

  const restored = restoreStrippedTitle(classified, parsed, ENTRY, SUMMARY());

  assert.deepEqual(restored, parsed, "the parse is handed straight back");
});

test("a renamed file pushes its new title and leaves the body exactly as it was", () => {
  const record = noteRecord("# Shopping list\n\nMilk\nEggs");

  const prepared = prepareRetitle(
    record,
    { entry: ENTRY, toFile: "Notes/Groceries.md", newTitle: "Groceries" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.ok(prepared.retitle);
  assert.equal(prepared.retitle.plainText, "Groceries\n\nMilk\nEggs");
  const sent = decodePayload(prepared.retitle.payloadBase64);
  assert.equal(sent.text, "Groceries\n\nMilk\nEggs", "the document on the wire is the retitled note");
  assert.equal(sent.firstParagraphKind, "title");
});

test("a title a file name can only spell with homoglyphs comes back as the character it stands for", () => {
  const record = noteRecord("Shopping list\n\nMilk");

  const prepared = prepareRetitle(
    record,
    // What the user typed as "Pat/Alex" - the slash their filesystem won't
    // take, written with U+2044 and read back here.
    { entry: ENTRY, toFile: "Notes/Pat⁄Alex.md", newTitle: "Pat/Alex" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.equal(prepared.retitle?.plainText, "Pat/Alex\n\nMilk");
});

test("renaming a file to the title the note already has sends nothing at all", () => {
  // "Shopping list 2.md" is how pull spells a second note titled "Shopping
  // list"; renaming it back to "Shopping list.md" is the local name catching
  // up with the real title, not a retitle.
  const record = noteRecord("Shopping list\n\nMilk");

  const prepared = prepareRetitle(
    record,
    { entry: { ...ENTRY, file: "Notes/Shopping list 2.md" }, toFile: "Notes/Shopping list.md", newTitle: "Shopping list" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.equal(prepared.retitle, undefined);
});

test("a name spelling the trimmed form of a trailing-whitespace title sends nothing - the remote spelling wins", () => {
  // A file name only ever carries a title's trimmed spelling (see
  // `carriedTitleSpelling`), so this note lives at "Shopping list.md" while
  // being titled "Shopping list " - and a rename landing on exactly that
  // name expresses no new title. Without the equivalence, any rename or
  // move of such a note would silently strip the space from a title nobody
  // touched.
  const record = rawNoteRecord("Shopping list \n\nMilk");
  assert.equal(classifyOk(record, "filename").format?.[0]?.text, "Shopping list ", "the space survives into the title");

  const prepared = prepareRetitle(
    record,
    { entry: { ...ENTRY, file: "Notes/Shopping list 2.md" }, toFile: "Notes/Shopping list.md", newTitle: "Shopping list" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.equal(prepared.retitle, undefined);
});

test("a rename to a genuinely different name still retitles a trailing-whitespace note", () => {
  // The equivalence is exactly one spelling wide: anything but the trimmed
  // form of the current title is a real retitle, whitespace or not.
  const record = rawNoteRecord("Shopping list \n\nMilk");

  const prepared = prepareRetitle(
    record,
    { entry: ENTRY, toFile: "Notes/Groceries.md", newTitle: "Groceries" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.equal(prepared.retitle?.plainText, "Groceries\n\nMilk");
});

test("a rename is refused rather than guessed at when the note can't be safely edited", () => {
  const record = noteRecord("Shopping list\n\nMilk");
  record.fields.TextDataEncrypted = { value: "bm90IGEgbm90ZQ==", type: "ENCRYPTED_BYTES" };

  const prepared = prepareRetitle(
    record,
    { entry: ENTRY, toFile: "Notes/Groceries.md", newTitle: "Groceries" },
    REPLICA,
    "filename",
  );

  assert.equal(prepared.ok, false);
  if (prepared.ok) {
    return;
  }
  assert.equal(prepared.resolution, "refused");
  assert.match(prepared.reason, /no longer safely editable/);
  assert.match(prepared.reason, /rename the file back to Shopping list\.md/, "the refusal says how to undo it");
});

test("a genuine retitle normalizes the title paragraph to Title style", () => {
  // The deliberate drift `titleParagraphFromFilename` documents: a file name
  // carries no styling, so a new title arrives as plain Title-styled text
  // even if the paragraph it replaces was body-styled. It applies only to a
  // title that actually changed - see the test above, where the same name
  // spelling a title the note already has sends nothing.
  const record = noteRecord("Shopping list\n\nMilk");
  const before = classifyOk(record, "filename");
  assert.equal(before.format?.[0]?.kind, "body");

  const prepared = prepareRetitle(
    record,
    { entry: ENTRY, toFile: "Notes/Groceries.md", newTitle: "Groceries" },
    REPLICA,
    "filename",
  );

  assert.ok(prepared.ok);
  assert.equal(decodePayload(prepared.retitle?.payloadBase64 ?? "").firstParagraphKind, "title");
});

test("a recorded title outranks the file name, so an Untitled.md file isn't retitled to \"Untitled\"", () => {
  // `apple-note-title` exists exactly because this name couldn't hold the
  // title. Reading the name at face value would replace a real title with
  // "Untitled" the first time the user moved or copied the file.
  const long = "A title far too long for any file name to hold, ".repeat(3);
  const recorded = new Map([["Notes/Untitled.md", long]]);

  assert.equal(titleExpressedByFile("Notes/Untitled.md", recorded), long);
  assert.equal(titleExpressedByFile("Notes/Untitled 2.md", recorded), "Untitled 2", "only the file that carries the key");
  assert.equal(titleExpressedByFile("Notes/Groceries.md", new Map()), "Groceries");
});

test("a note whose title only a name can hold takes it from the name, homoglyphs decoded", () => {
  assert.equal(titleExpressedByFile("Notes/Pat⁄Alex.md", new Map()), "Pat/Alex");
});

// --- Retitling through `apple-note-title` ------------------------------------
//
// The one retitle a file name can't express: a title no name can hold. The
// key states it outright, and push sends it as an ordinary text update -
// leaving the *file* alone, because renaming is pull's job.

test("a frontmatter title the note doesn't have yet is pushed as the note's new title", () => {
  const record = noteRecord("# Shopping list\n\nMilk\nEggs");
  const classified = classifyOk(record, "filename");
  const long = "A title far too long for any file name to hold, ".repeat(3).trimEnd();

  const restored = restoreStrippedTitle(classified, parsedBody("\nMilk\nEggs"), ENTRY, SUMMARY(), long);

  assert.ok(restored);
  assert.equal(restored.text, `${long}\n\nMilk\nEggs`);
  assert.equal(restored.paragraphs[0]?.kind, "title");
  assert.deepEqual(
    restored.paragraphs.map((paragraph) => paragraph.start),
    [0, long.length + 1, long.length + 2, long.length + 7],
    "every following offset shifts by the new title's length, not the old one's",
  );
});

test("a frontmatter title equal to the note's own is left alone, styling and all", () => {
  // The common case, and the one that must not churn: `apple-note-title` on an
  // Untitled.md file normally just *records* the title the note already has.
  // Rebuilding the paragraph for it would restyle a title nobody touched,
  // and would do so on every push forever.
  const record = noteRecord("Shopping list\n\nMilk");
  const classified = classifyOk(record, "filename");
  assert.equal(classified.format?.[0]?.kind, "body", "the remote title paragraph is body-styled");

  const restored = restoreStrippedTitle(classified, parsedBody("\nMilk"), ENTRY, SUMMARY(), "Shopping list");

  assert.equal(restored?.text, "Shopping list\n\nMilk");
  assert.equal(restored?.paragraphs[0]?.kind, "body", "the record's own paragraph came back, not a rebuilt one");
});

test("an in-body vault ignores the key entirely - its title is the first line", () => {
  const record = noteRecord("Shopping list\n\nMilk");
  const classified = classifyOk(record, "in-body");
  const parsed = parsedBody("Shopping list\n\nMilk");

  // push never reads the key outside a filename-as-title vault, so this is
  // the shape `restoreStrippedTitle` is always called with there.
  const restored = restoreStrippedTitle(classified, parsed, ENTRY, SUMMARY());

  assert.deepEqual(restored, parsed);
});

test("a note whose title holds an embedded object refuses the retitle instead of dropping it", () => {
  // The one note a filename-as-title vault leaves title-in-body: nothing
  // about it can express a new title, and silently ignoring the key would
  // look like the push had done what was asked.
  const record = noteRecord("Shopping list\n\nMilk");
  const classified = classifyOk(record, "in-body");
  assert.notEqual(classified.titleStripped, true);
  const summary = SUMMARY();

  const restored = restoreStrippedTitle(classified, parsedBody("Shopping list\n\nMilk"), ENTRY, summary, "Groceries");

  assert.equal(restored, undefined);
  assert.match(summary.refused[0] ?? "", /apple-note-title.*can't retitle it/);
});
