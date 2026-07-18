import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { listEpochs, recordEpoch } from "../notes/noteEpoch.js";
import { REAL_PLAIN_NOTE } from "../notes/realFixtures.js";
import { recordVersion, type VersionSnapshot } from "../notes/versionHistory.js";
import { decodeSnapshotText, renderDiff, runDiff } from "./diff.js";

// Same real capture attachmentSync.test.ts uses for "Test Table Note (2)"
// (dev notes, 2026-07-14T10:46/14:41).
const TABLE_MERGEABLE_DATA_BASE64 =
  "eJzt1E9oFFccwPGZyWZ39iWNr5OahofQdgxJjHZdB5tDxUOTqKTEoJtNemghxHW0u2x2ZXdFI3opiBcPihRLyUULObVNm4stNFQwSslhD+k/Dy0UNNAiEimoB7H27SbVbLKhh1JP32GH3/x+7/d5895jd23D+fq2ZRvSUF/etoQtgvrZbDZUX+ptO6BabcNx3Vej/3KpoG06VtTUsUbHGh1rdbR1DOr4gqoXQgRKM+vMUq+nNtumarMtZ6P7WncsPnIg7Xdn00dHMz3JnJ8oJLOZPv9QIZ6NJQ+/X1A/mx+Y35tiwhQnRJ8TXPj2G/1RsjxhaeHl2G6WK6auWKoc2y3VJGw99kRf63Tf0+cOyzZLt/OS3p7cOhuev3dhr3F5z0yxMXq+S1dNR16fbL6/M198PD98LRG5dHXKaReOsKKlbQXU02Mq10K6FnxWW9ZZW6Uz9Kym6lPCtvQhBRxLmhWZVZHVVGSB//tE7vRfnPbnHtxtGZ+9NTbUsLB4Ilc2dY7sOntj/5mBybbQw9S2pX0Kvafwin3W61rdqhMpdYoqnfVrnEhtRRasyEIVma06vMV31On5Gla8I6xrLy57xz+9pa/muhW9eraoXNa7O9bjWG9F/+PZWioS2+IYVWZZw1Ss0amyxsaVa+x67mt07eRBP1NIFsbcpkSu2o/YDeT99CE3mMjFssfybnhwsLenN3PQP+6GE7nF3rxbl/DT6aWk4+VEdjQycuRI2o90x3rikf6B/qOjB/xclYGBQi6ZOdyxftVA6S3L+zPZgp+PLP3NrB7o7V5jAIFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAVApPnmycaYlt/u6jYzt+/OlU17vvePLED198dfOT7WO/zQ21npuO/uHJ65PN93fmi4/nh68lIpeuTnnSP9V2OvDhGxOfnpt69PFfG+Ke3Dobnr93Ya9xec9MsTF6vsuTEyd794nxz4Y7fy/KP9XufZ68sqlzZNfZG/vPDEy2hR6mtnnyvdZXZFPdo19v/mLEPo8PbvTknf6L0/7cg7st47O3xoYaFt7cIJRYtUrHsi19m38DuMWS1w==";

test("decodeSnapshotText decodes a Note TextDataEncrypted snapshot the same way clone/pull do", () => {
  const snapshot: VersionSnapshot = {
    id: "id-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    recordName: "REC1",
    recordType: "Note",
    field: "TextDataEncrypted",
    recordChangeTag: "tag",
    valueBase64: REAL_PLAIN_NOTE,
  };
  assert.equal(decodeSnapshotText(snapshot), "Test Note\nThis is a test note used for testing out `icloud-notes-sync`\n");
});

test("decodeSnapshotText decodes an Attachment MergeableDataEncrypted (table) snapshot as markdown", () => {
  const snapshot: VersionSnapshot = {
    id: "id-2",
    timestamp: "2026-01-01T00:00:00.000Z",
    recordName: "ATT-1",
    recordType: "Attachment",
    field: "MergeableDataEncrypted",
    recordChangeTag: "tag",
    valueBase64: TABLE_MERGEABLE_DATA_BASE64,
    noteRecordName: "REC1",
  };
  assert.equal(decodeSnapshotText(snapshot), ["| A0 | B0 |", "| - | - |", "| | |"].join("\n"));
});

test("renderDiff shows no differences for identical text", () => {
  const rendered = renderDiff("a\nb\nc", "a\nb\nc", "old", "new");
  assert.equal(rendered.text, ["--- old", "+++ new", "  a", "  b", "  c", "(no differences)"].join("\n"));
  assert.equal(rendered.hasDifferences, false);
});

test("renderDiff shows added and removed lines", () => {
  const rendered = renderDiff("a\nb\nc", "a\nx\nc", "old", "new");
  assert.equal(rendered.text.split("\n")[0], "--- old");
  assert.equal(rendered.text.split("\n")[1], "+++ new");
  assert.match(rendered.text, /^- b$/m);
  assert.match(rendered.text, /^\+ x$/m);
  assert.doesNotMatch(rendered.text, /no differences/);
  assert.equal(rendered.hasDifferences, true);
});

test("renderDiff treats an empty 'from' as everything added", () => {
  const rendered = renderDiff("", "new line", "old", "new");
  assert.match(rendered.text, /^\+ new line$/m);
  assert.equal(rendered.hasDifferences, true);
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "diff-test-"));
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
};

test("diff rejects a ref that matches neither a snapshot nor an epoch", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await assert.rejects(
      () => runDiff(dir, "Test Note.md", "missing-id", undefined),
      /No version snapshot with id "missing-id" found/,
    );
  }));

test("diff refuses the <from>..<to> form when <from> is an epoch id, without touching the network", () =>
  withTempDir(async (dir) => {
    await writeCloneState(dir, STATE);
    await recordVersion(dir, {
      recordName: "REC1",
      recordType: "Note",
      field: "TextDataEncrypted",
      recordChangeTag: "tag-1",
      valueBase64: REAL_PLAIN_NOTE,
    });
    await recordEpoch(dir, "REC1", ["REC1"]);
    const [epoch] = await listEpochs(dir, "REC1");

    // No `account` on STATE, so reaching resolveFolderAccount would throw
    // UnboundAccountError - a clean, specific rejection here proves the
    // refusal fires before any network call.
    await assert.rejects(
      () => runDiff(dir, "Test Note.md", epoch!.id, "some-other-id"),
      /epoch-vs-epoch diff .* isn't supported yet/,
    );
  }));
