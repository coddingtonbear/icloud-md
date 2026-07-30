import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNoteIds, type ResolveNoteIdsInput, type UntrackedFile } from "./noteIdPairing.js";

const A = "089D915D-C76E-4F44-AB80-2190073281A3";
const B = "001b9e8a-c474-4311-af32-abe70026b346";

function resolve(
  untracked: readonly UntrackedFile[],
  tracked: readonly string[],
  present: readonly string[] = [],
): ReturnType<typeof resolveNoteIds> {
  const input: ResolveNoteIdsInput = {
    untracked,
    trackedRecordNames: tracked,
    isTrackedFilePresent: (recordName) => present.includes(recordName),
  };
  return resolveNoteIds(input);
}

test("an id matching a tracked note whose file is gone is a move", () => {
  const result = resolve([{ file: "Recipes/Renamed.md", noteId: A }], [A]);

  assert.deepEqual(result.moves, [{ recordName: A, file: "Recipes/Renamed.md" }]);
  assert.deepEqual(result.creates, []);
});

test("a rename, a move, and an edit at once still resolve to one move", () => {
  // Nothing but the id connects these: the basename changed, the directory
  // changed, and the body no longer matches the base copy.
  const result = resolve([{ file: "Work/Totally Different.md", noteId: A }], [A]);

  assert.deepEqual(result.moves, [{ recordName: A, file: "Work/Totally Different.md" }]);
});

test("a file with no id is a create", () => {
  const result = resolve([{ file: "Recipes/Brand New.md" }], [A]);

  assert.deepEqual(result.creates, ["Recipes/Brand New.md"]);
  assert.deepEqual(result.moves, []);
});

test("a copy of a note whose original is still in place becomes a new note", () => {
  const result = resolve([{ file: "Recipes/Pie copy.md", noteId: A }], [A], [A]);

  assert.deepEqual(result.creates, ["Recipes/Pie copy.md"]);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.ambiguous, []);
});

test("several copies of a note whose original is still in place all become new notes", () => {
  const result = resolve(
    [
      { file: "Recipes/Pie copy.md", noteId: A },
      { file: "Recipes/Pie copy 2.md", noteId: A },
    ],
    [A],
    [A],
  );

  assert.deepEqual(result.creates, ["Recipes/Pie copy.md", "Recipes/Pie copy 2.md"]);
  assert.deepEqual(result.ambiguous, []);
});

test("duplicate claims with no incumbent are refused rather than guessed", () => {
  // The original was renamed *and* copied before pushing, so neither file
  // sits at the tracked path and nothing distinguishes them.
  const result = resolve(
    [
      { file: "Recipes/Pie.md", noteId: A },
      { file: "Recipes/Pie copy.md", noteId: A },
    ],
    [A],
  );

  assert.deepEqual(result.ambiguous, [{ recordName: A, files: ["Recipes/Pie.md", "Recipes/Pie copy.md"] }]);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(result.creates, [], "a refused claimant must not also plan as a create");
});

test("an id pointing at a note this vault doesn't track is a create, reported as stale", () => {
  const result = resolve([{ file: "Recipes/From Elsewhere.md", noteId: B }], [A]);

  assert.deepEqual(result.creates, ["Recipes/From Elsewhere.md"]);
  assert.deepEqual(result.staleIds, ["Recipes/From Elsewhere.md"]);
});

test("distinct ids resolve independently", () => {
  const result = resolve(
    [
      { file: "Recipes/Moved A.md", noteId: A },
      { file: "Recipes/Moved B.md", noteId: B },
      { file: "Recipes/New.md" },
    ],
    [A, B],
  );

  assert.deepEqual(result.moves, [
    { recordName: A, file: "Recipes/Moved A.md" },
    { recordName: B, file: "Recipes/Moved B.md" },
  ]);
  assert.deepEqual(result.creates, ["Recipes/New.md"]);
});

test("creates keep their input order", () => {
  const result = resolve(
    [{ file: "b.md" }, { file: "a.md" }, { file: "c.md", noteId: A }],
    [A],
  );

  assert.deepEqual(result.creates, ["b.md", "a.md"]);
});

test("no untracked files resolves to nothing at all", () => {
  const result = resolve([], [A], [A]);

  assert.deepEqual(result, { moves: [], creates: [], ambiguous: [], staleIds: [] });
});
