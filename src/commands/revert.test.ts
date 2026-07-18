import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { listEpochs, recordEpoch } from "../notes/noteEpoch.js";
import { REAL_PLAIN_NOTE } from "../notes/realFixtures.js";
import { recordVersion } from "../notes/versionHistory.js";
import { renderRevertResult, runRevert } from "./revert.js";

// Same real capture attachmentSync.test.ts/diff.test.ts use for "Test Table
// Note (2)" (dev notes, 2026-07-14T10:46/14:41) - decodes cleanly as a table,
// so it's safe fixture data for the round-trip verification gate.
const TABLE_MERGEABLE_DATA_BASE64 =
  "eJzt1E9oFFccwPGZyWZ39iWNr5OahofQdgxJjHZdB5tDxUOTqKTEoJtNemghxHW0u2x2ZXdFI3opiBcPihRLyUULObVNm4stNFQwSslhD+k/Dy0UNNAiEimoB7H27SbVbLKhh1JP32GH3/x+7/d5895jd23D+fq2ZRvSUF/etoQtgvrZbDZUX+ptO6BabcNx3Vej/3KpoG06VtTUsUbHGh1rdbR1DOr4gqoXQgRKM+vMUq+nNtumarMtZ6P7WncsPnIg7Xdn00dHMz3JnJ8oJLOZPv9QIZ6NJQ+/X1A/mx+Y35tiwhQnRJ8TXPj2G/1RsjxhaeHl2G6WK6auWKoc2y3VJGw99kRf63Tf0+cOyzZLt/OS3p7cOhuev3dhr3F5z0yxMXq+S1dNR16fbL6/M198PD98LRG5dHXKaReOsKKlbQXU02Mq10K6FnxWW9ZZW6Uz9Kym6lPCtvQhBRxLmhWZVZHVVGSB//tE7vRfnPbnHtxtGZ+9NTbUsLB4Ilc2dY7sOntj/5mBybbQw9S2pX0Kvafwin3W61rdqhMpdYoqnfVrnEhtRRasyEIVma06vMV31On5Gla8I6xrLy57xz+9pa/muhW9eraoXNa7O9bjWG9F/+PZWioS2+IYVWZZw1Ss0amyxsaVa+x67mt07eRBP1NIFsbcpkSu2o/YDeT99CE3mMjFssfybnhwsLenN3PQP+6GE7nF3rxbl/DT6aWk4+VEdjQycuRI2o90x3rikf6B/qOjB/xclYGBQi6ZOdyxftVA6S3L+zPZgp+PLP3NrB7o7V5jAIFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAVApPnmycaYlt/u6jYzt+/OlU17vvePLED198dfOT7WO/zQ21npuO/uHJ65PN93fmi4/nh68lIpeuTnnSP9V2OvDhGxOfnpt69PFfG+Ke3Dobnr93Ya9xec9MsTF6vsuTEyd794nxz4Y7fy/KP9XufZ68sqlzZNfZG/vPDEy2hR6mtnnyvdZXZFPdo19v/mLEPo8PbvTknf6L0/7cg7st47O3xoYaFt7cIJRYtUrHsi19m38DuMWS1w==";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "revert-test-"));
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

test("revert rejects an id that matches neither a snapshot nor an epoch", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await assert.rejects(
      () => runRevert(dir, "Test Note.md", "missing-id", { confirmed: false }),
      /No version snapshot with id "missing-id" found/,
    );
  }));

test("revert refuses an individually-shared note before any snapshot or network work", () =>
  withTempDir(async (dir) => {
    const shared: CloneState = {
      syncToken: "token",
      notes: {
        LOOSE1: { file: "Pat/Travel List.md", recordChangeTag: "1a", modificationDate: 100, sharedZoneOwner: "_owner1" },
      },
      sharerHomes: { _owner1: { name: "Pat", dirName: "Pat" } },
    };
    await writeCloneState(dir, shared);
    await assert.rejects(
      () => runRevert(dir, "Pat/Travel List.md", "any-id", { confirmed: false }),
      /individually-shared/,
    );
  }));

test("revert refuses a note in a READ_ONLY shared folder before any snapshot or network work", () =>
  withTempDir(async (dir) => {
    const shared: CloneState = {
      syncToken: "token",
      notes: {
        SH1: {
          file: "Pat/Shared Recipes/Theirs.md",
          recordChangeTag: "1a",
          modificationDate: 100,
          folderRecordName: "F-SHARED",
          sharedZoneOwner: "_owner1",
        },
      },
      folders: {
        "F-SHARED": { name: "Shared Recipes", dirName: "Shared Recipes", sharedZoneOwner: "_owner1", permission: "READ_ONLY" },
      },
      sharerHomes: { _owner1: { name: "Pat", dirName: "Pat" } },
    };
    await writeCloneState(dir, shared);
    await assert.rejects(
      () => runRevert(dir, "Pat/Shared Recipes/Theirs.md", "any-id", { confirmed: false }),
      /read-only for you/,
    );
  }));

test("revert lets a note in a writable shared folder through the policy gate (fails later on the unknown id, not the gate)", () =>
  withTempDir(async (dir) => {
    const shared: CloneState = {
      syncToken: "token",
      notes: {
        SH1: {
          file: "Pat/Shared Recipes/Theirs.md",
          recordChangeTag: "1a",
          modificationDate: 100,
          folderRecordName: "F-SHARED",
          sharedZoneOwner: "_owner1",
        },
      },
      folders: {
        "F-SHARED": { name: "Shared Recipes", dirName: "Shared Recipes", sharedZoneOwner: "_owner1", permission: "READ_WRITE" },
      },
      sharerHomes: { _owner1: { name: "Pat", dirName: "Pat" } },
    };
    await writeCloneState(dir, shared);
    await assert.rejects(
      () => runRevert(dir, "Pat/Shared Recipes/Theirs.md", "missing-id", { confirmed: false }),
      /No version snapshot with id "missing-id" found/,
    );
  }));

test("revert (unconfirmed, epoch id) reports what it would do without any network call", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: REAL_PLAIN_NOTE,
    });
    await recordVersion(dir, {
      recordName: "ATT-1",
      recordType: "Attachment",
      field: "MergeableDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: TABLE_MERGEABLE_DATA_BASE64,
      noteRecordName: "REC1",
    });
    await recordEpoch(dir, "REC1", ["REC1", "ATT-1"]);
    const [epoch] = await listEpochs(dir, "REC1");

    // No `account` on STATE - if this reached resolveFolderAccount it would
    // throw UnboundAccountError, so a clean result proves the unconfirmed
    // epoch path never touches the network.
    const result = await runRevert(dir, "Test Note.md", epoch!.id, { confirmed: false });
    assert.equal(result.mode, "epoch");
    assert.equal(result.confirmed, false);
    assert.equal(result.nothingToRevert, undefined);
    assert.ok(result.entries?.some((entry) => entry.label === "the note's own text"));
    assert.ok(result.entries?.some((entry) => entry.label === "table ATT-1"));
    const lines = renderRevertResult("Test Note.md", result);
    assert.ok(lines.some((line) => /Would revert Test Note\.md to the whole-note epoch/.test(line)));
    assert.ok(lines.some((line) => /the note's own text, to the snapshot captured/.test(line)));
    assert.ok(lines.some((line) => /table ATT-1, to the snapshot captured/.test(line)));
    assert.ok(lines.some((line) => /Re-run with --yes/.test(line)));
  }));

test("revert (unconfirmed, epoch id) notes tables added after the epoch and never-captured records", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: REAL_PLAIN_NOTE,
    });
    // Epoch captured before ATT-1 existed for this note.
    await recordEpoch(dir, "REC1", ["REC1"]);
    const [epoch] = await listEpochs(dir, "REC1");

    const result = await runRevert(dir, "Test Note.md", epoch!.id, { confirmed: false });
    assert.ok(result.notices?.some((notice) => /table ATT-1: wasn't part of this epoch/.test(notice)));
  }));

test("revert (unconfirmed, epoch id) reports nothing to revert when every record is skippable", () =>
  withTempDir(async (dir) => {
    const stateWithoutTable: CloneState = { ...STATE, tableAttachments: {} };
    await writeCloneState(dir, stateWithoutTable);
    // No recordVersion call at all - every entry in this epoch is null,
    // e.g. a pull that predates history tracking for this note.
    await recordEpoch(dir, "REC1", ["REC1"]);
    const [epoch] = await listEpochs(dir, "REC1");

    const result = await runRevert(dir, "Test Note.md", epoch!.id, { confirmed: false });
    assert.equal(result.nothingToRevert, "locally-skipped");
    const lines = renderRevertResult("Test Note.md", result);
    assert.ok(lines.some((line) => /Nothing to revert for Test Note\.md at epoch/.test(line)));
    assert.ok(lines.some((line) => /no snapshot was ever captured/.test(line)));
  }));
