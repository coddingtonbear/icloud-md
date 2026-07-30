import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNameCarriesTitle, noteFileName, noteFileNameFor, titleNeedingFrontmatter, uniqueFileName } from "./filename.js";

test("noteFileName derives a plain name from the title's first line", () => {
  assert.equal(noteFileName("Grocery list\nmilk, eggs"), "Grocery list.md");
});

test("noteFileName falls back to Untitled for an empty title", () => {
  assert.equal(noteFileName(""), "Untitled.md");
});

test("noteFileName strips characters that are unsafe in file names", () => {
  assert.equal(noteFileName("a/b:c*d?e\"f<g>h|i"), "abcdefghi.md");
});

test("uniqueFileName returns the candidate unchanged when it's free", () => {
  assert.equal(uniqueFileName("New Note.md", new Set()), "New Note.md");
});

test("uniqueFileName appends a Finder-style counter on collision", () => {
  const used = new Set(["New Note.md"]);
  assert.equal(uniqueFileName("New Note.md", used), "New Note 2.md");
});

test("uniqueFileName keeps counting past multiple collisions", () => {
  const used = new Set(["New Note.md", "New Note 2.md", "New Note 3.md"]);
  assert.equal(uniqueFileName("New Note.md", used), "New Note 4.md");
});

test("fileNameCarriesTitle accepts the name a title derives", () => {
  assert.equal(fileNameCarriesTitle("Groceries.md", "Groceries"), true);
  assert.equal(fileNameCarriesTitle("Pat⁄Alex.md", "Pat/Alex"), true);
});

test("fileNameCarriesTitle accepts a uniquified spelling, so pull doesn't walk it up on every run", () => {
  assert.equal(fileNameCarriesTitle("Groceries 2.md", "Groceries"), true);
  assert.equal(fileNameCarriesTitle("Groceries 17.md", "Groceries"), true);
});

test("fileNameCarriesTitle rejects a name for a different title", () => {
  assert.equal(fileNameCarriesTitle("Shopping list.md", "Groceries"), false);
  // " 1" is not a suffix the uniquifier ever produces (it starts at 2), and
  // a note titled "Groceries 1" would match the exact comparison instead.
  assert.equal(fileNameCarriesTitle("Groceries 1.md", "Groceries"), false);
  assert.equal(fileNameCarriesTitle("Groceries draft.md", "Groceries"), false);
});

test("fileNameCarriesTitle accepts an exactly-matching name that looks uniquified", () => {
  // A note genuinely titled "Groceries 2" belongs at "Groceries 2.md".
  assert.equal(fileNameCarriesTitle("Groceries 2.md", "Groceries 2"), true);
});

test("fileNameCarriesTitle accepts the Untitled fallback for a title no name can hold", () => {
  // Over-length titles land at "Untitled.md" with the real title in
  // frontmatter; that name must not read as a retitle on every pull.
  const huge = "x".repeat(200);
  assert.equal(fileNameCarriesTitle("Untitled.md", huge), true);
  assert.equal(fileNameCarriesTitle("Untitled 3.md", huge), true);
});

test("titleNeedingFrontmatter names only the titles a file name genuinely can't hold", () => {
  // The list is short because homoglyph substitution handles illegal
  // characters - those stay in the name, readable and reversible.
  assert.equal(titleNeedingFrontmatter("Groceries", "filename"), undefined);
  assert.equal(titleNeedingFrontmatter("Pat/Alex: notes", "filename"), undefined);

  assert.equal(titleNeedingFrontmatter("x".repeat(200), "filename"), "x".repeat(200));
  assert.equal(titleNeedingFrontmatter(".hidden", "filename"), ".hidden");
  assert.equal(titleNeedingFrontmatter("Trailing space ", "filename"), "Trailing space ");
  assert.equal(titleNeedingFrontmatter("CON", "filename"), "CON");
});

test("titleNeedingFrontmatter records nothing for a genuinely untitled note", () => {
  // "Untitled.md" is the whole truth there, and a key holding "" would be
  // read back as absent anyway - so it would be rewritten on every pull.
  assert.equal(titleNeedingFrontmatter("", "filename"), undefined);
  assert.equal(titleNeedingFrontmatter("   ", "filename"), undefined);
});

test("titleNeedingFrontmatter is never anything in an in-body vault", () => {
  // There the name is decoration and the title is in the file, so there is
  // nothing a name failing to hold it could cost.
  assert.equal(titleNeedingFrontmatter(".hidden", "in-body"), undefined);
  assert.equal(titleNeedingFrontmatter("x".repeat(200), "in-body"), undefined);
});

test("titleNeedingFrontmatter and noteFileNameFor agree on which titles fall back", () => {
  // Two answers to one question; a disagreement would either lose a title or
  // duplicate a representable one into frontmatter for nothing.
  for (const title of ["Groceries", "Pat/Alex", ".hidden", "CON", "x".repeat(200), "Trailing space "]) {
    const needsFrontmatter = titleNeedingFrontmatter(title, "filename") !== undefined;
    assert.equal(noteFileNameFor(title, "filename") === "Untitled.md", needsFrontmatter, `disagreed about: ${title}`);
  }

  // The one deliberate exception: an untitled note is filed as "Untitled.md"
  // and records nothing, because that name is already the whole truth.
  assert.equal(noteFileNameFor("", "filename"), "Untitled.md");
  assert.equal(titleNeedingFrontmatter("", "filename"), undefined);
});
