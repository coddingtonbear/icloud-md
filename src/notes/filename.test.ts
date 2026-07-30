import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNameCarriesTitle, noteFileName, uniqueFileName } from "./filename.js";

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
