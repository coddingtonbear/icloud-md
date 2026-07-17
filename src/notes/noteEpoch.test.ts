import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findEpochById, listEpochs, recordEpoch } from "./noteEpoch.js";
import { listVersions, recordVersion, type VersionSnapshotInput } from "./versionHistory.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "noteepoch-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function noteInput(overrides: Partial<VersionSnapshotInput> = {}): VersionSnapshotInput {
  return {
    recordName: "REC-1",
    recordType: "Note",
    field: "TextDataEncrypted",
    recordChangeTag: "tag-1",
    valueBase64: "AAAA",
    ...overrides,
  };
}

test("listEpochs returns an empty array when nothing has been recorded", () =>
  withTempDir(async (dir) => {
    assert.deepEqual(await listEpochs(dir, "REC-1"), []);
  }));

test("recordEpoch indexes the current snapshot id for every given recordName", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput());
    await recordVersion(dir, {
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: "BBBB",
      noteRecordName: "REC-1",
    });
    const [noteSnapshot] = await listVersions(dir, "REC-1");
    const [attSnapshot] = await listVersions(dir, "ATT-1");

    await recordEpoch(dir, "REC-1", ["REC-1", "ATT-1"]);

    const [epoch] = await listEpochs(dir, "REC-1");
    assert.equal(epoch?.noteRecordName, "REC-1");
    assert.deepEqual(epoch?.snapshots, { "REC-1": noteSnapshot!.id, "ATT-1": attSnapshot!.id });
  }));

test("recordEpoch records null for a recordName with no captured snapshot yet", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput());
    await recordEpoch(dir, "REC-1", ["REC-1", "ATT-NEVER-CAPTURED"]);

    const [epoch] = await listEpochs(dir, "REC-1");
    assert.equal(epoch?.snapshots["ATT-NEVER-CAPTURED"], null);
  }));

test("recordEpoch appends further epochs rather than overwriting", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ valueBase64: "AAAA" }));
    await recordEpoch(dir, "REC-1", ["REC-1"]);
    await recordVersion(dir, noteInput({ valueBase64: "BBBB" }));
    await recordEpoch(dir, "REC-1", ["REC-1"]);

    const epochs = await listEpochs(dir, "REC-1");
    assert.equal(epochs.length, 2);
    assert.notEqual(epochs[0]?.id, epochs[1]?.id);
  }));

test("findEpochById locates a recorded epoch by id", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput());
    await recordEpoch(dir, "REC-1", ["REC-1"]);
    const [expected] = await listEpochs(dir, "REC-1");

    const found = await findEpochById(dir, "REC-1", expected!.id);
    assert.equal(found?.id, expected!.id);
  }));

test("findEpochById returns undefined when no epoch matches", () =>
  withTempDir(async (dir) => {
    assert.equal(await findEpochById(dir, "REC-1", "missing-id"), undefined);
  }));

test("recordEpoch keeps epochs for different notes separate", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ recordName: "REC-1" }));
    await recordVersion(dir, noteInput({ recordName: "REC-2" }));
    await recordEpoch(dir, "REC-1", ["REC-1"]);
    await recordEpoch(dir, "REC-2", ["REC-2"]);

    assert.equal((await listEpochs(dir, "REC-1")).length, 1);
    assert.equal((await listEpochs(dir, "REC-2")).length, 1);
  }));
