import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { renderPlan, stripFilePrefix, type PlanEntry } from "./pushPlan.js";

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
    "new file:   New.md",
    "modified:   Edited.md",
    "deleted:    Gone.md",
    "1 to create, 1 changed, 1 to delete.",
  ]);
});

test("renderPlan shows a refused/conflict entry's label plus an indented reason line, and tallies it separately from the ready counts", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Refused.md", resolution: "refused", reason: "this note has an attachment" },
    { kind: "delete", file: "Stale.md", resolution: "conflict", reason: "changed remotely since the last pull - run \"pull\" first" },
  ];
  assert.deepEqual(renderPlan(entries), [
    "modified:   Refused.md",
    "  ! this note has an attachment",
    "deleted:    Stale.md",
    '  ! changed remotely since the last pull - run "pull" first',
    "0 to create, 0 changed, 0 to delete. (1 conflict(s), 1 refused)",
  ]);
});

test("renderPlan omits noop entries from the listing but keeps the ready/refused ones around them", () => {
  const entries: PlanEntry[] = [
    { kind: "update", file: "Clean.md", resolution: "noop" },
    { kind: "update", file: "Edited.md", resolution: "ready" },
  ];
  assert.deepEqual(renderPlan(entries), ["modified:   Edited.md", "0 to create, 1 changed, 0 to delete."]);
});

test("renderPlan actually applies color when chalk is enabled", () => {
  const originalLevel = chalk.level;
  chalk.level = 1;
  try {
    const [line] = renderPlan([{ kind: "create", file: "New.md", resolution: "ready" }]);
    assert.match(line ?? "", /\x1b\[/);
  } finally {
    chalk.level = originalLevel;
  }
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
      reason: 'this note has an attachment - run "icloud-notes restore Recipes/Pie.md" to discard your local edit',
    },
  ];
  const lines = renderPlan(entries, (file) => `../${file}`);
  assert.match(lines[0] ?? "", /modified: {3}\.\.\/Recipes\/Pie\.md/);
  assert.match(lines[1] ?? "", /restore \.\.\/Recipes\/Pie\.md/);
});
