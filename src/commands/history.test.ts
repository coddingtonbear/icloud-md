import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { recordVersion } from "../notes/versionHistory.js";
import { runHistory } from "./history.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "history-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATE: CloneState = {
  syncToken: "token",
  notes: {
    REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
  },
  tableAttachments: {
    "ATT-1": { noteRecordName: "REC1" },
  },
};

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => { console.log = original; } };
}

test("history reports no version history when nothing has been recorded", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    const { lines, restore } = captureLogs();
    try {
      await runHistory(dir, "Test Note.md");
    } finally {
      restore();
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /No version history recorded yet/);
  }));

test("history lists snapshots for the note and its table attachments, newest first", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: "AAAA",
    });
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-2",
      valueBase64: "BBBB",
    });
    await recordVersion(dir, {
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: "CCCC",
      noteRecordName: "REC1",
    });

    const { lines, restore } = captureLogs();
    try {
      await runHistory(dir, "Test Note.md");
    } finally {
      restore();
    }

    assert.equal(lines.length, 3);
    assert.ok(lines.some((line) => /table ATT-1/.test(line)));
    // Newest-first within a single record is a real guarantee (even under a
    // same-millisecond capture tie); ordering *between* two different
    // records that tie on timestamp isn't, so this only checks the note's
    // own two snapshots relative to each other, not against the table's.
    const tag1Index = lines.findIndex((line) => /\bnote\b.*tag-1/.test(line));
    const tag2Index = lines.findIndex((line) => /\bnote\b.*tag-2/.test(line));
    assert.notEqual(tag1Index, -1);
    assert.notEqual(tag2Index, -1);
    assert.ok(tag2Index < tag1Index, "the more recently captured note snapshot should list first");
  }));

test("history refuses a file that isn't a tracked note", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await assert.rejects(() => runHistory(dir, "Nonexistent.md"), /isn't a tracked note/);
  }));

test("history refuses when there's no cloned state at all", () =>
  withTempDir(async (dir) => {
    await assert.rejects(() => runHistory(dir, "Test Note.md"), /doesn't look like a cloned notes directory/);
  }));
