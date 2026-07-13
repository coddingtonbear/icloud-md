import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNoteVersions } from "./mergeConflict.js";

test("identical local and remote merges cleanly with no markers", () => {
  const base = "title\n\nline one\nline two\n";
  const outcome = mergeNoteVersions(base, base, base);
  assert.equal(outcome.hasConflict, false);
  assert.equal(outcome.text, base);
});

test("non-overlapping edits (local appends, remote changes title) merge cleanly", () => {
  const base = "title\n\nline one\nline two\n";
  const local = "title\n\nline one\nline two\nline three\n";
  const remote = "new title\n\nline one\nline two\n";

  const outcome = mergeNoteVersions(base, local, remote);

  assert.equal(outcome.hasConflict, false);
  assert.match(outcome.text, /new title/);
  assert.match(outcome.text, /line three/);
  assert.doesNotMatch(outcome.text, /<<<<<<</);
});

test("overlapping edits to the same line produce diff3 conflict markers", () => {
  const base = "title\n\nsame line\n";
  const local = "title\n\nlocal version of the line\n";
  const remote = "title\n\nremote version of the line\n";

  const outcome = mergeNoteVersions(base, local, remote);

  assert.equal(outcome.hasConflict, true);
  assert.match(outcome.text, /<<<<<<< local/);
  assert.match(outcome.text, /\|\|\|\|\|\|\| base/);
  assert.match(outcome.text, /=======/);
  assert.match(outcome.text, />>>>>>> remote/);
  assert.match(outcome.text, /local version of the line/);
  assert.match(outcome.text, /remote version of the line/);
});

test("identical independent edits on both sides are not flagged as a false conflict", () => {
  const base = "title\n\nsame line\n";
  const localAndRemote = "title\n\nsame line, edited the same way\n";

  const outcome = mergeNoteVersions(base, localAndRemote, localAndRemote);

  assert.equal(outcome.hasConflict, false);
  assert.equal(outcome.text, localAndRemote);
});

test("remote deletion (empty remote) against a local edit conflicts and preserves local content", () => {
  const base = "title\n\nkeep me\n";
  const local = "title\n\nkeep me, but edited\n";

  const outcome = mergeNoteVersions(base, local, "");

  assert.equal(outcome.hasConflict, true);
  assert.match(outcome.text, /keep me, but edited/);
});
