import { test } from "node:test";
import assert from "node:assert/strict";
import { noteFileName, uniqueFileName } from "./filename.js";

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
