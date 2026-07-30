import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { countUnchangedNotes, renderPlan, serializePlanEntry, stripFilePrefix, type PlanEntry } from "./pushPlan.js";

// Stable, non-ANSI assertions - colorized rendering itself is exercised by
// the color-specific test below, forcing chalk back on for that one case.
chalk.level = 0;

test("renderPlan reports \"Nothing to push.\" for an empty plan", () => {
  assert.deepEqual(renderPlan([]), ["Nothing to push."]);
});

test("renderPlan reports \"Nothing to push.\" when every entry is a noop", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Clean.md", resolution: "noop" },
    { kind: "update", file: "AlsoClean.md", resolution: "noop" },
  ];
  assert.deepEqual(renderPlan(entries), ["Nothing to push."]);
});

test("renderPlan lists one line per ready entry, plus a create/update/delete summary", () => {
  const entries: PlanEntry[] = [
    { kind: "create", file: "New.md", resolution: "ready" },
    { kind: "update", file: "Edited.md", resolution: "ready" },
    { kind: "delete", file: "Gone.md", resolution: "ready" },
  ];
  assert.deepEqual(renderPlan(entries), [
    "",
    "        new file: New.md",
    "        modified: Edited.md",
    "        deleted:  Gone.md",
    "",
    "1 to create, 1 changed, 1 to delete.",
  ]);
});

test("renderPlan shows a refused/conflict entry's label plus an indented reason line, and tallies it separately from the ready counts", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Refused.md", resolution: "refused", reason: "this note has an attachment" },
    { kind: "delete", file: "Stale.md", resolution: "conflict", reason: "changed remotely since the last pull - run \"pull\" first" },
  ];
  assert.deepEqual(renderPlan(entries), [
    "",
    "        modified: Refused.md",
    "                  ! this note has an attachment",
    "        deleted:  Stale.md",
    '                  ! changed remotely since the last pull - run "pull" first',
    "",
    "0 to create, 0 changed, 0 to delete. (1 conflict(s), 1 refused)",
  ]);
});

test("renderPlan omits noop entries from the listing but keeps the ready/refused ones around them", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Clean.md", resolution: "noop" },
    { kind: "update", file: "Edited.md", resolution: "ready" },
  ];
  assert.deepEqual(renderPlan(entries), ["", "        modified: Edited.md", "", "0 to create, 1 changed, 0 to delete."]);
});

test("renderPlan colors only the status label, leaving the filename in the terminal's own color", () => {
  const originalLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = renderPlan([{ kind: "create", file: "New.md", resolution: "ready" }]);
    assert.match(lines[1] ?? "", /\x1b\[32mnew file:\x1b\[39m New\.md$/);
  } finally {
    chalk.level = originalLevel;
  }
});

test("renderPlan sets refusal reasons black-on-red and conflict reasons magenta", () => {
  const originalLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = renderPlan([
      { kind: "update", file: "Refused.md", resolution: "refused", reason: "this note has an attachment" },
      { kind: "update", file: "Stale.md", resolution: "conflict", reason: "changed remotely" },
    ]);
    // Black text on a red background, with the indent left uncolored so the
    // background starts at the text.
    assert.match(lines[2] ?? "", /^ {18}\x1b\[41m\x1b\[30m! this note has an attachment\x1b\[39m\x1b\[49m$/);
    assert.match(lines[4] ?? "", /^ {18}\x1b\[35m! changed remotely\x1b\[39m$/);
  } finally {
    chalk.level = originalLevel;
  }
});

test("renderPlan's preview mode wraps the listing in a heading, next-step hints, indentation, and an unchanged remark", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Edited.md", resolution: "ready" },
    { kind: "update", file: "Refused.md", resolution: "refused", reason: "this note has an attachment" },
  ];
  assert.deepEqual(renderPlan(entries, undefined, { preview: true, unchanged: 41 }), [
    "Changes not yet pushed to iCloud:",
    '  (use "icloud-md push" to send them)',
    '  (use "icloud-md restore <file>" to discard a local edit)',
    "",
    "        modified: Edited.md",
    "        modified: Refused.md",
    "                  ! this note has an attachment",
    "",
    "0 to create, 1 changed, 0 to delete. (1 refused)",
    "41 other notes match the last pull.",
  ]);
});

test("renderPlan says which single note matches the last pull grammatically", () => {
  const entries: PlanEntry[] = [{ kind: "update", file: "Edited.md", resolution: "ready" }];
  const lines = renderPlan(entries, undefined, { unchanged: 1 });
  assert.equal(lines.at(-1), "1 other note matches the last pull.");
});

test("renderPlan omits the unchanged remark when nothing else is tracked", () => {
  const entries: PlanEntry[] = [{ kind: "update", file: "Edited.md", resolution: "ready" }];
  const lines = renderPlan(entries, undefined, { preview: true, unchanged: 0 });
  assert.equal(lines.at(-1), "0 to create, 1 changed, 0 to delete.");
});

test("renderPlan folds the unchanged count into \"Nothing to push\" for a clean vault", () => {
  assert.deepEqual(renderPlan([], undefined, { preview: true, unchanged: 42 }), [
    "Nothing to push; all 42 notes match the last pull.",
  ]);
  assert.deepEqual(renderPlan([], undefined, { preview: true, unchanged: 1 }), [
    "Nothing to push; all 1 note matches the last pull.",
  ]);
  assert.deepEqual(renderPlan([], undefined, { preview: true, unchanged: 0 }), ["Nothing to push."]);
});

test("countUnchangedNotes counts tracked notes untouched by the plan, treating creates as untracked and noops as unchanged", () => {
  const entries: PlanEntry[] = [
    { kind: "create", file: "New.md", resolution: "ready" },
    { kind: "update", file: "Edited.md", resolution: "ready" },
    { kind: "update", file: "Cosmetic.md", resolution: "noop" },
    { kind: "delete", file: "Gone.md", resolution: "conflict", reason: "changed remotely" },
  ];
  assert.equal(countUnchangedNotes(entries, 10), 8);
  assert.equal(countUnchangedNotes([], 10), 10);
});

test("stripFilePrefix removes a leading \"<file>: \" prefix", () => {
  assert.equal(stripFilePrefix("Note.md: changed remotely", "Note.md"), "changed remotely");
});

test("stripFilePrefix leaves a message alone when it doesn't start with the file's own prefix", () => {
  assert.equal(stripFilePrefix("something else entirely", "Note.md"), "something else entirely");
});

test("renderPlan re-expresses paths through formatPath, including inside reason lines", () => {
  const entries: PlanEntry[] = [
    {
      kind: "update",
      file: "Recipes/Pie.md",
      resolution: "refused",
      reason: 'this note has an attachment - run "icloud-md restore Recipes/Pie.md" to discard your local edit',
    },
  ];
  const lines = renderPlan(entries, (file) => `../${file}`);
  assert.match(lines[1] ?? "", /modified: \.\.\/Recipes\/Pie\.md/);
  assert.match(lines[2] ?? "", /restore \.\.\/Recipes\/Pie\.md/);
});

test("renderPlan shows a pending rename as \"file -> target\" and tallies it as a conflict", () => {
  // The one entry kind push won't act on: a rename `pull --defer-renames`
  // handed off and nobody performed. It belongs on the status screen anyway,
  // because it's work the reader still owes.
  const entries: PlanEntry[] = [
    {
      kind: "rename",
      file: "Notes/Shopping list.md",
      pendingRename: "Notes/Groceries.md",
      resolution: "conflict",
      reason: "rename deferred by a previous pull and not yet performed",
    },
  ];
  assert.deepEqual(renderPlan(entries), [
    "",
    "        rename:   Notes/Shopping list.md -> Notes/Groceries.md",
    "                  ! rename deferred by a previous pull and not yet performed",
    "",
    "0 to create, 0 changed, 0 to delete. (1 conflict(s))",
  ]);
});

test("countUnchangedNotes ignores a pending rename, which can sit alongside a real change to the same note", () => {
  // What's out of step there is the name, not the note - and counting both
  // entries would make the tally describe more notes than the vault has.
  const entries: PlanEntry[] = [
    { kind: "rename", file: "Edited.md", pendingRename: "Renamed.md", resolution: "conflict", reason: "pending" },
    { kind: "update", file: "Edited.md", resolution: "ready" },
  ];
  assert.equal(countUnchangedNotes(entries, 10), 9);
});

test("renders a folder create with a trailing slash and counts it separately", () => {
  const lines = renderPlan([
    { kind: "createFolder", file: "Recipes", folderTitle: "Recipes", resolution: "ready" },
    { kind: "create", file: "Recipes/cake.md", resolution: "ready" },
  ]);

  assert.ok(
    lines.some((line) => line.includes("new dir:") && line.includes("Recipes/")),
    `expected a folder line, got ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => line.includes("1 to create, 0 changed, 0 to delete, 1 new folder.")),
    `expected the folder count in the summary, got ${JSON.stringify(lines)}`,
  );
});

test("omits the folder count when no folder is being created", () => {
  const lines = renderPlan([{ kind: "create", file: "Notes/a.md", resolution: "ready" }]);
  assert.ok(lines.some((line) => line.includes("1 to create, 0 changed, 0 to delete.")));
  assert.ok(!lines.some((line) => line.includes("new folder")));
});

test("serializePlanEntry carries folderTitle only for a folder create", () => {
  assert.deepEqual(
    serializePlanEntry({ kind: "createFolder", file: "Recipes", folderTitle: "Recipes", resolution: "ready" }),
    { kind: "createFolder", file: "Recipes", resolution: "ready", folderTitle: "Recipes" },
  );
  assert.equal(
    "folderTitle" in serializePlanEntry({ kind: "create", file: "Notes/a.md", resolution: "ready" }),
    false,
  );
});
