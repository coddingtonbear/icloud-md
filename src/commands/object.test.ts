import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { CloneState } from "../notes/cloneState.js";
import { applyObjectFilters, buildObjectIndex, findIncomingReferences, isCascadableType, rejectionWithBlockerHint, renderObjectList, type ObjectInfo } from "./object.js";

function record(overrides: Partial<CloudKitRecord> & Pick<CloudKitRecord, "recordName" | "recordType">): CloudKitRecord {
  return { fields: {}, recordChangeTag: "1a", ...overrides };
}

function state(overrides: Partial<CloneState> = {}): CloneState {
  return { syncToken: "token", notes: {}, ...overrides };
}

const TRASH_REF = { recordName: "TrashFolder-CloudKit", zoneID: { zoneName: "Notes" } };

test("buildObjectIndex derives lifecycle state from tombstones, Deleted, and the Trash folder", () => {
  const index = buildObjectIndex(
    [
      record({ recordName: "LIVE", recordType: "Note", fields: { Folder: { value: { recordName: "DefaultFolder-CloudKit" }, type: "REFERENCE" } } }),
      record({ recordName: "TRASHED", recordType: "Note", fields: { Folder: { value: TRASH_REF, type: "REFERENCE" } } }),
      record({
        recordName: "PURGED",
        recordType: "Note",
        fields: { Folder: { value: TRASH_REF, type: "REFERENCE" }, Deleted: { value: 1, type: "INT64" } },
      }),
      record({ recordName: "GONE", recordType: "Note", deleted: true }),
    ],
    state(),
  );

  assert.deepEqual(
    index.map((info) => [info.recordName, info.state]),
    [
      ["LIVE", "live"],
      ["TRASHED", "trashed"],
      ["PURGED", "purged"],
      ["GONE", "tombstone"],
    ],
  );
});

test("buildObjectIndex collects references in both directions, including from unknown record types", () => {
  const index = buildObjectIndex(
    [
      record({ recordName: "NOTE-1", recordType: "Note", fields: { Folder: { value: { recordName: "FOLDER-1" }, type: "REFERENCE" } } }),
      record({
        recordName: "ATT-1",
        recordType: "Attachment",
        fields: { Note: { value: { recordName: "NOTE-1", action: "VALIDATE" }, type: "REFERENCE" } },
      }),
      record({
        recordName: "MYSTERY-1",
        recordType: "SomeFutureType",
        fields: { Things: { value: [{ recordName: "NOTE-1" }, { recordName: "FOLDER-1" }], type: "REFERENCE_LIST" } },
      }),
      record({ recordName: "FOLDER-1", recordType: "Folder" }),
    ],
    state(),
  );
  const byName = new Map(index.map((info) => [info.recordName, info]));

  assert.deepEqual(byName.get("ATT-1")?.references, ["NOTE-1"]);
  assert.deepEqual(byName.get("MYSTERY-1")?.references.sort(), ["FOLDER-1", "NOTE-1"]);
  assert.equal(byName.get("NOTE-1")?.referencedBy, 2);
  assert.equal(byName.get("FOLDER-1")?.referencedBy, 2);
  assert.equal(byName.get("ATT-1")?.referencedBy, 0);
});

test("buildObjectIndex maps records to tracked vault files and decodes titles", () => {
  const index = buildObjectIndex(
    [
      record({
        recordName: "NOTE-1",
        recordType: "Note",
        fields: { TitleEncrypted: { value: Buffer.from("Groceries").toString("base64"), type: "ENCRYPTED_BYTES" } },
      }),
      record({ recordName: "ATT-1", recordType: "Attachment" }),
    ],
    state({
      notes: { "NOTE-1": { file: "Groceries.md", recordChangeTag: "1a", modificationDate: 1 } },
      attachments: {
        "ATT-1": { file: "attachments/pic.jpg", mediaRecordName: "M1", mediaFileChecksum: "c", noteRecordName: "NOTE-1" },
      },
    }),
  );

  assert.equal(index[0]?.trackedFile, "Groceries.md");
  assert.equal(index[0]?.title, "Groceries");
  assert.equal(index[1]?.trackedFile, "attachments/pic.jpg");
});

test("buildObjectIndex flags a Note whose text data fails to decompress as broken", () => {
  const index = buildObjectIndex(
    [
      record({
        recordName: "BROKEN",
        recordType: "Note",
        fields: { TextDataEncrypted: { value: Buffer.from("not zlib at all").toString("base64"), type: "ENCRYPTED_BYTES" } },
      }),
      record({ recordName: "ATT-1", recordType: "Attachment" }),
    ],
    state(),
  );

  assert.equal(index[0]?.health !== undefined && index[0].health !== "ok", true);
  // Health is a Note-only concept.
  assert.equal(index[1]?.health, undefined);
});

function info(overrides: Partial<ObjectInfo> & Pick<ObjectInfo, "recordName" | "recordType">): ObjectInfo {
  return { state: "live", references: [], referencedBy: 0, ...overrides };
}

test("applyObjectFilters composes type/broken/orphaned/trashed/untracked filters", () => {
  const index = [
    info({ recordName: "N1", recordType: "Note", health: "ok" }),
    info({ recordName: "N2", recordType: "Note", health: "undecodable", trackedFile: "A.md" }),
    info({ recordName: "N3", recordType: "Note", health: "ok", state: "trashed" }),
    info({ recordName: "A1", recordType: "Attachment", references: ["N-GONE"] }),
    info({ recordName: "A2", recordType: "Attachment", references: ["N1"] }),
  ];

  assert.deepEqual(applyObjectFilters(index, { type: "attachment" }).map((i) => i.recordName), ["A1", "A2"]);
  assert.deepEqual(applyObjectFilters(index, { broken: true }).map((i) => i.recordName), ["N2"]);
  // A1 points at a record that isn't in the listing at all - orphaned.
  assert.deepEqual(applyObjectFilters(index, { orphaned: true }).map((i) => i.recordName), ["A1"]);
  assert.deepEqual(applyObjectFilters(index, { trashed: true }).map((i) => i.recordName), ["N3"]);
  // N1 is a live untracked note; N2 is tracked, N3 isn't live.
  assert.deepEqual(applyObjectFilters(index, { untracked: true }).map((i) => i.recordName), ["N1"]);
  assert.deepEqual(applyObjectFilters(index, { type: "Note", broken: true }).map((i) => i.recordName), ["N2"]);
});

test("renderObjectList prints one line per object, health annotations, and a type summary", () => {
  const previousLevel = chalk.level;
  chalk.level = 0;
  try {
    const lines = renderObjectList([
      info({ recordName: "N1", recordType: "Note", health: "ok", trackedFile: "A.md", modifiedAt: 1784216556668 }),
      info({ recordName: "N2", recordType: "Note", health: "undecodable", title: "Broken one" }),
      info({ recordName: "A1", recordType: "Attachment", references: ["N1"], referencedBy: 0 }),
    ]);

    assert.equal(lines.some((line) => line.startsWith("N1") && line.includes("A.md")), true);
    assert.equal(lines.some((line) => line.trim() === "! undecodable"), true);
    assert.equal(lines.at(-1), "3 object(s): 1 Attachment, 2 Note");
  } finally {
    chalk.level = previousLevel;
  }
});

test("renderObjectList says so when nothing matches", () => {
  assert.deepEqual(renderObjectList([]), ["No matching objects."]);
});

test("findIncomingReferences names each referrer, excluding the record itself", () => {
  const index = [
    info({ recordName: "NOTE-1", recordType: "Note", references: ["FOLDER-1", "NOTE-1"] }),
    info({ recordName: "ATT-1", recordType: "Attachment", references: ["NOTE-1"], title: "Table", state: "live" }),
    info({ recordName: "US-1", recordType: "Note_UserSpecific", references: ["NOTE-1"], state: "trashed" }),
    info({ recordName: "OTHER", recordType: "Note", references: ["FOLDER-1"] }),
  ];

  assert.deepEqual(findIncomingReferences(index, "NOTE-1"), [
    { recordName: "ATT-1", recordType: "Attachment", title: "Table", state: "live" },
    { recordName: "US-1", recordType: "Note_UserSpecific", title: undefined, state: "trashed" },
  ]);
  assert.deepEqual(findIncomingReferences(index, "NOBODY"), []);
});

test("isCascadableType allows per-note leaves and refuses structural types", () => {
  assert.equal(isCascadableType("Attachment"), true);
  assert.equal(isCascadableType("Media"), true);
  assert.equal(isCascadableType("InlineAttachment"), true);
  assert.equal(isCascadableType("Note_UserSpecific"), true);
  assert.equal(isCascadableType("PasswordProtectedNote_UserSpecific"), true);
  assert.equal(isCascadableType("Note"), false);
  assert.equal(isCascadableType("Folder"), false);
  assert.equal(isCascadableType("SomeFutureType"), false);
});

test("rejectionWithBlockerHint extracts the blocking recordID from a real-shaped reason", () => {
  const error = rejectionWithBlockerHint(
    "NOTE-1",
    "VALIDATING_REFERENCE_ERROR",
    "Field=Note, recordID=92df3572-aaaa-bbbb-cccc-1234567890ab, title=Record delete would violate validating reference, rejecting update",
  );

  assert.match(error.message, /blocked by 92df3572-aaaa-bbbb-cccc-1234567890ab/);
  assert.match(error.message, /object delete 92df3572-aaaa-bbbb-cccc-1234567890ab/);
  assert.match(error.message, /object show NOTE-1/);
});

test("rejectionWithBlockerHint leaves other errors and unparseable reasons untouched", () => {
  const other = rejectionWithBlockerHint("N", "CONFLICT", "changeTag mismatch");
  assert.equal(other.message.includes("blocked by"), false);

  const unparseable = rejectionWithBlockerHint("N", "VALIDATING_REFERENCE_ERROR", "no id here");
  assert.equal(unparseable.message.includes("blocked by"), false);

  const noReason = rejectionWithBlockerHint("N", "VALIDATING_REFERENCE_ERROR", undefined);
  assert.equal(noReason.message.includes("blocked by"), false);
});
