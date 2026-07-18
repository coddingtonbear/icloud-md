import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { recordEpoch } from "../notes/noteEpoch.js";
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

test("history reports no version history when nothing has been recorded", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    const result = await runHistory(dir, "Test Note.md");
    assert.deepEqual(result, { mode: "epochs", epochs: [] });
  }));

test("history --records lists snapshots for the note and its table attachments, newest first", () =>
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

    const result = await runHistory(dir, "Test Note.md", { records: true });
    assert.equal(result.mode, "records");
    if (result.mode !== "records") {
      return;
    }

    assert.equal(result.records.length, 3);
    assert.ok(result.records.some((row) => row.label === "table ATT-1"));
    // Newest-first within a single record is a real guarantee (even under a
    // same-millisecond capture tie); ordering *between* two different
    // records that tie on timestamp isn't, so this only checks the note's
    // own two snapshots relative to each other, not against the table's.
    const tag1Index = result.records.findIndex((row) => row.label === "note" && row.recordChangeTag === "tag-1");
    const tag2Index = result.records.findIndex((row) => row.label === "note" && row.recordChangeTag === "tag-2");
    assert.notEqual(tag1Index, -1);
    assert.notEqual(tag2Index, -1);
    assert.ok(tag2Index < tag1Index, "the more recently captured note snapshot should list first");
  }));

test("history defaults to an epoch timeline, newest first, noting changed vs. carried-over records", () =>
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
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: "CCCC",
      noteRecordName: "REC1",
    });
    await recordEpoch(dir, "REC1", ["REC1", "ATT-1"]);

    // Second epoch: only the note's own text changes - the table carries
    // over its previous snapshot.
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-2",
      valueBase64: "BBBB",
    });
    await recordEpoch(dir, "REC1", ["REC1", "ATT-1"]);

    const result = await runHistory(dir, "Test Note.md");
    assert.equal(result.mode, "epochs");
    if (result.mode !== "epochs") {
      return;
    }

    assert.equal(result.epochs.length, 2);
    // Newest-first: the second epoch (note changed, table carried over) prints first.
    assert.deepEqual(result.epochs[0]?.changed, ["note"]);
    assert.deepEqual(result.epochs[0]?.carriedOver, ["table ATT-1"]);
    assert.deepEqual(result.epochs[1]?.changed, ["note", "table ATT-1"]);
    assert.deepEqual(result.epochs[1]?.carriedOver, []);
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
