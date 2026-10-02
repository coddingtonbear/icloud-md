import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { DebugLogRecord } from "../debugLog.js";
import { UntrackedFileError } from "../errors.js";
import type { CloneState } from "./cloneState.js";
import { resolveBugReportScope, scopeCloneState, scopeDebugLogEntries } from "./bugReportScope.js";

const TARGET_DIR = path.join(path.sep, "vault");

const STATE: CloneState = {
  syncToken: "token",
  sharedZoneSyncTokens: { OWNER1: "shared-token", OWNER2: "other-shared-token" },
  replicaId: "replica",
  account: { appleId: "person@example.com", dsid: "123" },
  notes: {
    NOTE1: { file: "Work/Projects/Plan.md", recordChangeTag: "1a", modificationDate: 100, folderRecordName: "PROJECTS" },
    NOTE2: { file: "Diary.md", recordChangeTag: "1b", modificationDate: 100 },
    NOTE3: { file: "sharer-home/Shared.md", recordChangeTag: "1c", modificationDate: 100, sharedZoneOwner: "OWNER1", folderRecordName: "SHAREDFOLDER" },
  },
  folders: {
    WORK: { name: "Work", dirName: "Work" },
    PROJECTS: { name: "Projects", dirName: "Projects", parentRecordName: "WORK" },
    OTHER: { name: "Other", dirName: "Other" },
    SHAREDFOLDER: { name: "Shared", dirName: "Shared", sharedZoneOwner: "OWNER1" },
  },
  sharerHomes: { OWNER1: { name: "Sharer", dirName: "sharer-home" }, OWNER2: { name: "Another", dirName: "another" } },
  attachments: {
    ATT1: { file: "Work/Projects/attachments/a.png", mediaRecordName: "MEDIA1", mediaFileChecksum: "x", noteRecordName: "NOTE1" },
    ATT2: { file: "attachments/b.png", mediaRecordName: "MEDIA2", mediaFileChecksum: "y", noteRecordName: "NOTE2" },
  },
  tableAttachments: { TABLE1: { noteRecordName: "NOTE1" }, TABLE2: { noteRecordName: "NOTE2" } },
  trashed: { GONE: { file: "Gone.md", trashedAt: 5 } },
};

test("resolveBugReportScope widens each note to the attachments, backing media, and tables it owns, deduplicating repeats", () => {
  const scope = resolveBugReportScope(STATE, [path.join(TARGET_DIR, "Work/Projects/Plan.md"), "Work/Projects/Plan.md"], TARGET_DIR);

  assert.deepEqual(scope.noteRecordNames, ["NOTE1"]);
  // MEDIA1 carries the bytes ATT1 only points at - a scoped report about a
  // failed download needs the Media response, not just the Attachment.
  assert.deepEqual([...scope.recordNames].sort(), ["ATT1", "MEDIA1", "NOTE1", "TABLE1"]);
  assert.equal(scope.recordNames.has("MEDIA2"), false);
});

test("resolveBugReportScope refuses a file that isn't a tracked note", () => {
  assert.throws(() => resolveBugReportScope(STATE, ["Nope.md"], TARGET_DIR), UntrackedFileError);
});

test("scopeCloneState keeps only the scoped notes, their attachments, their folder chain, and their sharer home", () => {
  const scope = resolveBugReportScope(STATE, ["Work/Projects/Plan.md", "sharer-home/Shared.md"], TARGET_DIR);
  const scoped = scopeCloneState(STATE, scope);

  assert.deepEqual(Object.keys(scoped.notes).sort(), ["NOTE1", "NOTE3"]);
  assert.deepEqual(Object.keys(scoped.folders ?? {}).sort(), ["PROJECTS", "SHAREDFOLDER", "WORK"]);
  assert.deepEqual(Object.keys(scoped.sharerHomes ?? {}), ["OWNER1"]);
  assert.deepEqual(Object.keys(scoped.attachments ?? {}), ["ATT1"]);
  assert.deepEqual(Object.keys(scoped.tableAttachments ?? {}), ["TABLE1"]);
  assert.deepEqual(scoped.trashed, {});
  // Vault-level scalars survive untouched.
  assert.equal(scoped.syncToken, "token");
  assert.equal(scoped.replicaId, "replica");
  // Keyed by sharer, so it is narrowed with them: OWNER2 shares nothing in
  // scope and its owner id has no business in the report.
  assert.deepEqual(scoped.sharedZoneSyncTokens, { OWNER1: "shared-token" });
  assert.deepEqual(scoped.account, STATE.account);
});

test("scopeCloneState drops every sharer's sync token when no scoped note is shared", () => {
  const scope = resolveBugReportScope(STATE, ["Diary.md"], TARGET_DIR);
  const scoped = scopeCloneState(STATE, scope);

  assert.deepEqual(scoped.sharedZoneSyncTokens, {});
  assert.deepEqual(scoped.sharerHomes, {});
  assert.doesNotMatch(JSON.stringify(scoped), /OWNER1|OWNER2/);
});

test("scopeCloneState leaves absent optional sections absent rather than inventing empty ones", () => {
  const minimal: CloneState = { syncToken: "t", notes: { NOTE1: { file: "One.md", recordChangeTag: "1", modificationDate: 1 } } };
  const scoped = scopeCloneState(minimal, resolveBugReportScope(minimal, ["One.md"], TARGET_DIR));

  assert.equal(scoped.folders, undefined);
  assert.equal(scoped.attachments, undefined);
  assert.equal(scoped.trashed, undefined);
  assert.equal(scoped.sharedZoneSyncTokens, undefined);
});

function entry(note: string, body: unknown): DebugLogRecord {
  return { timestamp: "2026-07-14T12:30:00.000Z", note, response: { status: 200, headers: {}, body } };
}

test("scopeDebugLogEntries drops out-of-scope records from nested changes/zone pages and flat lookup bodies, counting what it removed", () => {
  const scope = resolveBugReportScope(STATE, ["Work/Projects/Plan.md"], TARGET_DIR);
  const entries: DebugLogRecord[] = [
    entry("changes/zone", {
      zones: [
        {
          syncToken: "abc",
          moreComing: false,
          records: [
            { recordName: "NOTE1", recordType: "Note", fields: { TextDataEncrypted: { value: "keep" } } },
            { recordName: "NOTE2", recordType: "Note", fields: { TextDataEncrypted: { value: "secret" } } },
            { recordName: "TABLE1", recordType: "Attachment", fields: {} },
            { recordName: "FOLDERX", recordType: "Folder", fields: {} },
          ],
        },
      ],
    }),
    entry("records/lookup", { records: [{ recordName: "NOTE2", recordType: "Note", fields: {} }] }),
    entry("records/modify", { records: [{ recordName: "NOTE2", reason: "conflict", serverErrorCode: "CONFLICT" }] }),
  ];

  const { entries: scoped, recordsOmitted } = scopeDebugLogEntries(entries, scope);
  const serialized = JSON.stringify(scoped);

  assert.equal(recordsOmitted, 4);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /NOTE2|FOLDERX/);
  assert.match(serialized, /"NOTE1"/);
  assert.match(serialized, /"TABLE1"/);

  const zone = (scoped[0]?.response?.body as { zones: Record<string, unknown>[] }).zones[0];
  assert.equal((zone?.records as unknown[]).length, 2);
  assert.equal(zone?.recordsOmittedByScope, 2);
  assert.equal(zone?.syncToken, "abc");

  // Entries stay even when nothing in them survives - the call still happened.
  assert.equal(scoped.length, 3);
  assert.deepEqual(scoped[2]?.response?.body, { records: [], recordsOmittedByScope: 1 });
});

test("scopeDebugLogEntries leaves entries without records, and arrays of non-records, untouched", () => {
  const scope = resolveBugReportScope(STATE, ["Diary.md"], TARGET_DIR);
  const entries: DebugLogRecord[] = [
    { timestamp: "2026-07-14T12:30:00.000Z", note: "no response" },
    entry("validate", { dsInfo: { dsid: "123" }, headers: ["a", "b"], nested: { list: [{ notARecord: true }] } }),
  ];

  const { entries: scoped, recordsOmitted } = scopeDebugLogEntries(entries, scope);

  assert.equal(recordsOmitted, 0);
  assert.deepEqual(scoped, entries);
  assert.doesNotMatch(JSON.stringify(scoped), /OmittedByScope/);
});
