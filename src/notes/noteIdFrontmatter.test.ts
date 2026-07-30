import { test } from "node:test";
import assert from "node:assert/strict";
import { clearNoteId, isNoteId, readNoteId, setNoteId } from "./noteIdFrontmatter.js";

const ID = "089D915D-C76E-4F44-AB80-2190073281A3";
const OTHER_ID = "001b9e8a-c474-4311-af32-abe70026b346";

// --- reading -----------------------------------------------------------------

test("readNoteId finds the id in a plain envelope", () => {
  assert.equal(readNoteId(`---\napple-note-id: ${ID}\n---\n\n`), ID);
});

test("readNoteId accepts every way YAML can spell the string", () => {
  assert.equal(readNoteId(`---\napple-note-id: "${ID}"\n---\n`), ID);
  assert.equal(readNoteId(`---\napple-note-id: '${ID}'\n---\n`), ID);
  assert.equal(readNoteId(`---\napple-note-id: >-\n  ${ID}\n---\n`), ID);
});

test("readNoteId accepts lowercase ids, as non-Apple writers produce", () => {
  assert.equal(readNoteId(`---\napple-note-id: ${OTHER_ID}\n---\n`), OTHER_ID);
});

test("readNoteId ignores a key nested under another, not a top-level one", () => {
  const frontmatter = `---\naliases:\n  - apple-note-id: ${ID}\n---\n`;
  assert.equal(readNoteId(frontmatter), undefined);
});

test("readNoteId ignores a key that only appears inside a block scalar's text", () => {
  const frontmatter = `---\nnotes: |\n  apple-note-id: ${ID}\n---\n`;
  assert.equal(readNoteId(frontmatter), undefined);
});

test("readNoteId treats broken YAML as no id rather than throwing", () => {
  assert.equal(readNoteId(`---\ntags: [unclosed\napple-note-id: ${ID}\n---\n`), undefined);
});

test("readNoteId rejects a value that isn't UUID-shaped", () => {
  assert.equal(readNoteId("---\napple-note-id: not-a-uuid\n---\n"), undefined);
  assert.equal(readNoteId("---\napple-note-id: 12345\n---\n"), undefined);
  assert.equal(readNoteId("---\napple-note-id:\n---\n"), undefined);
});

test("readNoteId returns undefined for a file with no frontmatter at all", () => {
  assert.equal(readNoteId(""), undefined);
  assert.equal(readNoteId("# Just a note\n"), undefined);
});

// --- writing -----------------------------------------------------------------

test("setNoteId creates an envelope for a file that had none", () => {
  assert.equal(setNoteId("", ID), `---\napple-note-id: ${ID}\n---\n\n`);
});

test("setNoteId adds the id to an existing envelope, keeping other keys", () => {
  const result = setNoteId("---\ntags: [recipes]\n---\n\n", ID);
  assert.match(result, /^---\n/);
  assert.match(result, /tags:/);
  assert.equal(readNoteId(result), ID);
});

test("setNoteId preserves comments and key order in the user's block", () => {
  const result = setNoteId("---\n# my notes\ntags: [recipes]\nstatus: done\n---\n\n", ID);
  assert.match(result, /# my notes/);
  assert.ok(result.indexOf("tags:") < result.indexOf("status:"));
});

test("setNoteId returns the envelope byte-identical when the id is already right", () => {
  const frontmatter = `---\ntags: [ recipes ]   # spacing we must not touch\napple-note-id: ${ID}\n---\n\n`;
  assert.equal(setNoteId(frontmatter, ID), frontmatter);
});

test("setNoteId replaces a stale id", () => {
  const result = setNoteId(`---\napple-note-id: ${OTHER_ID}\n---\n\n`, ID);
  assert.equal(readNoteId(result), ID);
  assert.ok(!result.includes(OTHER_ID));
});

test("setNoteId leaves broken YAML alone rather than rewriting it", () => {
  const broken = "---\ntags: [unclosed\n---\n\n";
  assert.equal(setNoteId(broken, ID), broken);
});

test("setNoteId leaves a non-mapping envelope alone", () => {
  const scalar = "---\njust a bare scalar\n---\n\n";
  assert.equal(setNoteId(scalar, ID), scalar);
});

test("setNoteId keeps the blank-line separator the envelope carried", () => {
  const result = setNoteId("---\ntags: [recipes]\n---\n\n", ID);
  assert.ok(result.endsWith("---\n\n"), `expected a trailing blank line, got ${JSON.stringify(result)}`);
});

test("an envelope written by setNoteId round-trips through readNoteId", () => {
  for (const start of ["", "---\ntags: [a]\n---\n\n", `---\napple-note-id: ${OTHER_ID}\nx: 1\n---\n\n`]) {
    assert.equal(readNoteId(setNoteId(start, ID)), ID, `round trip failed for ${JSON.stringify(start)}`);
  }
});

// --- clearing ----------------------------------------------------------------

test("clearNoteId removes the id but keeps the rest of the block", () => {
  const result = clearNoteId(`---\ntags: [recipes]\napple-note-id: ${ID}\n---\n\n`);
  assert.equal(readNoteId(result), undefined);
  assert.match(result, /tags:/);
});

test("clearNoteId drops an envelope that held nothing else", () => {
  assert.equal(clearNoteId(`---\napple-note-id: ${ID}\n---\n\n`), "");
});

test("clearNoteId is a no-op when there was no id", () => {
  const frontmatter = "---\ntags: [recipes]\n---\n\n";
  assert.equal(clearNoteId(frontmatter), frontmatter);
  assert.equal(clearNoteId(""), "");
});

// --- id shape ----------------------------------------------------------------

test("isNoteId accepts real recordNames in both cases and rejects everything else", () => {
  assert.ok(isNoteId(ID));
  assert.ok(isNoteId(OTHER_ID));
  assert.ok(!isNoteId(""));
  assert.ok(!isNoteId("AccountData"));
  assert.ok(!isNoteId(`${ID}-extra`));
});

test("setNoteId refuses to write an id readNoteId wouldn't accept", () => {
  // Otherwise the two disagree forever and every pull rewrites the envelope
  // trying to set an id that never sticks.
  for (const bad of ["REC1", "", "not-a-uuid", "AccountData"]) {
    assert.equal(setNoteId("", bad), "", `setNoteId wrote ${bad}`);
    assert.equal(setNoteId("---\ntags: [a]\n---\n\n", bad), "---\ntags: [a]\n---\n\n");
  }
});
