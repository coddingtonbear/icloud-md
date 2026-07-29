import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import type { PullSummary } from "../commands/pull.js";
import { renderPullReport } from "./pullReport.js";

// Stable, non-ANSI assertions - colorized rendering itself is exercised by
// the color-specific tests below, forcing chalk back on for those cases.
chalk.level = 0;

function summaryWith(overrides: Partial<PullSummary>): PullSummary {
  return {
    added: 0,
    updated: 0,
    merged: 0,
    removed: 0,
    attachmentsDownloaded: 0,
    unpublishable: 0,
    skippedNewUnsyncable: 0,
    droppedUnsyncable: 0,
    unsharedUntracked: 0,
    changes: [],
    conflicts: [],
    notices: [],
    ...overrides,
  };
}

test('renderPullReport reports "Already up to date." for a changeless pull', () => {
  assert.deepEqual(renderPullReport(summaryWith({})), ["Already up to date."]);
});

test("renderPullReport wraps the changelist in a heading, indentation, and blank lines, with a trailing tally", () => {
  const summary = summaryWith({
    added: 1,
    updated: 1,
    removed: 1,
    changes: [
      { kind: "add", file: "New.md" },
      { kind: "update", file: "Edited.md" },
      { kind: "remove", file: "Gone.md" },
      { kind: "move", file: "Recipes/Pie.md", previousFile: "Pie.md" },
    ],
  });
  assert.deepEqual(renderPullReport(summary), [
    "Changes pulled from iCloud:",
    "",
    "        new file:  New.md",
    "        modified:  Edited.md",
    "        deleted:   Gone.md",
    "        moved:     Pie.md -> Recipes/Pie.md",
    "",
    "1 added, 1 updated, 0 auto-merged, 1 deleted, 1 moved.",
  ]);
});

test("renderPullReport indents a change's remarks under its subject", () => {
  const summary = summaryWith({
    merged: 1,
    conflicts: ["Torn.md: merged with conflict markers - resolve manually"],
    changes: [
      { kind: "merge", file: "Clean.md" },
      {
        kind: "merge",
        file: "Torn.md",
        remarks: [{ tone: "conflict", message: "merged with conflict markers - resolve manually" }],
      },
    ],
  });
  assert.deepEqual(renderPullReport(summary), [
    "Changes pulled from iCloud:",
    "",
    "        merged:    Clean.md",
    "        merged:    Torn.md",
    "                   ! merged with conflict markers - resolve manually",
    "",
    "0 added, 0 updated, 1 auto-merged, 0 deleted. (1 conflict(s))",
  ]);
});

test("renderPullReport tallies untracked notes and read-only pulls in the situational slots", () => {
  const summary = summaryWith({
    added: 1,
    unpublishable: 1,
    droppedUnsyncable: 1,
    attachmentsDownloaded: 2,
    changes: [
      {
        kind: "add",
        file: "Scanned.md",
        remarks: [{ tone: "unsyncable", message: "read-only: contains content this tool couldn't fully parse" }],
      },
      {
        kind: "untrack",
        file: "Broken.md",
        remarks: [{ tone: "unsyncable", message: "no longer syncable remotely (missing text data) - local copy left in place" }],
      },
    ],
  });
  assert.deepEqual(renderPullReport(summary), [
    "Changes pulled from iCloud:",
    "",
    "        new file:  Scanned.md",
    "                   ! read-only: contains content this tool couldn't fully parse",
    "        untracked: Broken.md",
    "                   ! no longer syncable remotely (missing text data) - local copy left in place",
    "",
    "1 added, 0 updated, 0 auto-merged, 0 deleted, 1 untracked, 2 attachment(s) downloaded. (1 read-only)",
  ]);
});

test("renderPullReport colors only the status label, leaving the filename in the terminal's own color", () => {
  const originalLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = renderPullReport(summaryWith({ added: 1, changes: [{ kind: "add", file: "New.md" }] }));
    assert.match(lines[2] ?? "", /\x1b\[32mnew file: \x1b\[39m New\.md$/);
  } finally {
    chalk.level = originalLevel;
  }
});

test("renderPullReport sets conflict remarks magenta and unsyncable remarks black-on-red, indent uncolored", () => {
  const originalLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = renderPullReport(
      summaryWith({
        changes: [
          { kind: "merge", file: "Torn.md", remarks: [{ tone: "conflict", message: "merged with conflict markers" }] },
          { kind: "add", file: "Scanned.md", remarks: [{ tone: "unsyncable", message: "read-only" }] },
        ],
      }),
    );
    assert.match(lines[3] ?? "", /^ {19}\x1b\[35m! merged with conflict markers\x1b\[39m$/);
    assert.match(lines[5] ?? "", /^ {19}\x1b\[41m\x1b\[30m! read-only\x1b\[39m\x1b\[49m$/);
  } finally {
    chalk.level = originalLevel;
  }
});

test("renderPullReport re-expresses paths through formatPath, including both halves of a move", () => {
  const summary = summaryWith({
    changes: [{ kind: "move", file: "Recipes/Pie.md", previousFile: "Pie.md" }],
  });
  const lines = renderPullReport(summary, (file) => `../${file}`);
  assert.match(lines[2] ?? "", /moved: {5}\.\.\/Pie\.md -> \.\.\/Recipes\/Pie\.md$/);
});
