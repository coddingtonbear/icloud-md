import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listVersions, recordVersion, type VersionSnapshotInput } from "./versionHistory.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "versionhistory-test-"));
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

test("recordVersion + listVersions round-trip a single snapshot", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput());

    const versions = await listVersions(dir, "REC-1");
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.recordName, "REC-1");
    assert.equal(versions[0]?.valueBase64, "AAAA");
    assert.equal(typeof versions[0]?.id, "string");
    assert.equal(typeof versions[0]?.timestamp, "string");
  }));

test("listVersions returns an empty array when nothing has been recorded", () =>
  withTempDir(async (dir) => {
    assert.deepEqual(await listVersions(dir, "REC-NONE"), []);
  }));

test("recordVersion appends a new snapshot when the content actually changed", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ valueBase64: "AAAA", recordChangeTag: "tag-1" }));
    await recordVersion(dir, noteInput({ valueBase64: "BBBB", recordChangeTag: "tag-2" }));

    const versions = await listVersions(dir, "REC-1");
    assert.equal(versions.length, 2);
    assert.deepEqual(
      versions.map((v) => v.valueBase64),
      ["AAAA", "BBBB"],
    );
  }));

test("recordVersion is a no-op when the content is identical to the most recent snapshot", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ valueBase64: "AAAA" }));
    await recordVersion(dir, noteInput({ valueBase64: "AAAA", recordChangeTag: "tag-unchanged-content" }));

    const versions = await listVersions(dir, "REC-1");
    assert.equal(versions.length, 1);
  }));

test("recordVersion records both edges of a revert-and-forward transition (A -> B -> A)", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ valueBase64: "AAAA" }));
    await recordVersion(dir, noteInput({ valueBase64: "BBBB" }));
    await recordVersion(dir, noteInput({ valueBase64: "AAAA" }));

    const versions = await listVersions(dir, "REC-1");
    assert.deepEqual(
      versions.map((v) => v.valueBase64),
      ["AAAA", "BBBB", "AAAA"],
    );
  }));

test("recordVersion keeps snapshots for different records separate", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, noteInput({ recordName: "REC-1", valueBase64: "AAAA" }));
    await recordVersion(dir, noteInput({ recordName: "REC-2", valueBase64: "BBBB" }));

    assert.equal((await listVersions(dir, "REC-1")).length, 1);
    assert.equal((await listVersions(dir, "REC-2")).length, 1);
  }));

test("recordVersion returns true when it writes a new snapshot, false when it's a no-op", () =>
  withTempDir(async (dir) => {
    assert.equal(await recordVersion(dir, noteInput({ valueBase64: "AAAA" })), true);
    assert.equal(await recordVersion(dir, noteInput({ valueBase64: "AAAA", recordChangeTag: "tag-unchanged" })), false);
    assert.equal(await recordVersion(dir, noteInput({ valueBase64: "BBBB" })), true);
  }));

test("recordVersion tracks a table Attachment snapshot with its noteRecordName", () =>
  withTempDir(async (dir) => {
    await recordVersion(dir, {
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: "CCCC",
      noteRecordName: "REC-1",
    });

    const versions = await listVersions(dir, "ATT-1");
    assert.equal(versions[0]?.noteRecordName, "REC-1");
    assert.equal(versions[0]?.recordType, "Attachment");
  }));
