import { test } from "node:test";
import assert from "node:assert/strict";
import type { DebugLogRecord } from "../debugLog.js";
import { emptyAliasStore } from "./bugReportAliases.js";
import type { CloneState } from "./cloneState.js";
import { buildTextReplacements, discoverAccountScalars, redactCloneState, redactDebugLogEntries, redactLastError } from "./bugReportRedaction.js";

test("redactCloneState rebuilds a nested folder path from the record graph, not by string-matching names", () => {
  const state: CloneState = {
    syncToken: "token",
    notes: {
      NOTE1: { file: "Temp/Subf/Fiery.md", recordChangeTag: "1a", modificationDate: 100, folderRecordName: "SUBF" },
    },
    folders: {
      TEMP: { name: "Temp", dirName: "Temp" },
      SUBF: { name: "Subf", parentRecordName: "TEMP", dirName: "Subf" },
    },
  };
  const store = emptyAliasStore();

  const { state: redacted } = redactCloneState(state, store);

  assert.equal(redacted.notes.NOTE1?.file, "folder-1/folder-2/note-1.md");
  assert.doesNotMatch(JSON.stringify(redacted), /Temp|Subf|Fiery/);
});

test("redactCloneState prefixes a shared note's path with its sharer's alias, and a shared-folder note with sharer + folder", () => {
  const state: CloneState = {
    syncToken: "token",
    notes: {
      LOOSE: { file: "Hassan Almemari/Travel Wish List.md", recordChangeTag: "1a", modificationDate: 100, sharedZoneOwner: "OWNER1" },
      INFOLDER: {
        file: "Hassan Almemari/Shared Recipes/Rice.md",
        recordChangeTag: "1b",
        modificationDate: 100,
        sharedZoneOwner: "OWNER1",
        folderRecordName: "RECIPES",
      },
    },
    folders: { RECIPES: { name: "Shared Recipes", dirName: "Shared Recipes", sharedZoneOwner: "OWNER1", permission: "READ_WRITE" } },
    sharerHomes: { OWNER1: { name: "Hassan Almemari", dirName: "Hassan Almemari" } },
  };
  const store = emptyAliasStore();

  const { state: redacted } = redactCloneState(state, store);

  assert.equal(redacted.notes.LOOSE?.file, "sharer-1/note-1.md");
  assert.equal(redacted.notes.INFOLDER?.file, "sharer-1/folder-1/note-2.md");
  assert.doesNotMatch(JSON.stringify(redacted), /Hassan|Almemari|Recipes|Rice|Travel/);
});

test("redactCloneState places an attachment alongside its owning note's aliased folder", () => {
  const state: CloneState = {
    syncToken: "token",
    notes: { NOTE1: { file: "Notes/Call with Janice.md", recordChangeTag: "1a", modificationDate: 100, folderRecordName: "NOTES" } },
    folders: { NOTES: { name: "Notes", dirName: "Notes" } },
    attachments: {
      ATT1: {
        file: "Notes/attachments/Call with Janice.m4a",
        mediaRecordName: "MEDIA1",
        mediaFileChecksum: "abc",
        noteRecordName: "NOTE1",
      },
    },
  };
  const store = emptyAliasStore();

  const { state: redacted } = redactCloneState(state, store);

  assert.equal(redacted.attachments?.ATT1?.file, "folder-1/attachments/attachment-1.m4a");
  assert.doesNotMatch(JSON.stringify(redacted), /Janice/);
});

test("redactCloneState assigns the same alias to the same recordName reused across categories in one pass", () => {
  const state: CloneState = {
    syncToken: "token",
    notes: {
      A: { file: "Notes/A.md", recordChangeTag: "1", modificationDate: 100, folderRecordName: "NOTES" },
      B: { file: "Notes/B.md", recordChangeTag: "1", modificationDate: 100, folderRecordName: "NOTES" },
    },
    folders: { NOTES: { name: "Notes", dirName: "Notes" } },
  };
  const store = emptyAliasStore();

  const { state: redacted } = redactCloneState(state, store);

  assert.equal(redacted.notes.A?.file, "folder-1/note-1.md");
  assert.equal(redacted.notes.B?.file, "folder-1/note-2.md");
});

test("discoverAccountScalars finds dsid/appleId from state, a dsInfo-shaped body, and a bare dsid query param", () => {
  const state: CloneState = { syncToken: "token", account: { appleId: "person@example.com", dsid: "111" }, notes: {} };
  const logEntries: DebugLogRecord[] = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      note: "checkAuthentication",
      response: { status: 200, headers: {}, body: { dsInfo: { dsid: "222", appleId: "other@example.com" } } },
    },
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      note: "fetchZone",
      request: { method: "GET", url: "https://example.com/zone?dsid=333&clientId=abc", headers: {} },
    },
  ];

  const found = discoverAccountScalars(state, logEntries);

  assert.deepEqual([...found].sort(), ["111", "222", "333", "other@example.com", "person@example.com"].sort());
});

test("redactDebugLogEntries drops identity fields and pseudonymizes account scalars wherever they appear", () => {
  const logEntries: DebugLogRecord[] = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      note: "checkAuthentication",
      request: { method: "GET", url: "https://example.com/validate?dsid=111", headers: {} },
      response: {
        status: 200,
        headers: {},
        body: { dsInfo: { dsid: "111", appleId: "person@example.com", firstName: "Adam", primaryEmail: "person@example.com" } },
      },
    },
  ];
  const accountAliasMap = new Map([
    ["111", "account-1"],
    ["person@example.com", "account-2"],
  ]);

  const [redacted] = redactDebugLogEntries(logEntries, accountAliasMap);

  assert.equal(redacted?.request?.url, "https://example.com/validate?dsid=account-1");
  const body = redacted?.response?.body as { dsInfo: Record<string, unknown> };
  assert.equal(body.dsInfo.dsid, "account-1");
  assert.equal(body.dsInfo.appleId, "account-2");
  assert.equal(body.dsInfo.firstName, "[omitted]");
  assert.equal(body.dsInfo.primaryEmail, "[omitted]");
});

test("redactLastError scrubs a real file path (and its basename) and account scalars from free-text message/hint", () => {
  const fileReplacements = new Map([["Notes/Secret Diary.md", "folder-1/note-1.md"]]);
  const accountAliasMap = new Map([["person@example.com", "account-1"]]);
  const replacements = buildTextReplacements(fileReplacements, accountAliasMap);

  const redacted = redactLastError(
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      message: '"Secret Diary.md" was cloned for person@example.com, but the session just authenticated is for other@example.com.',
      hint: "Run icloud-notes history Secret Diary.md to see available snapshot ids.",
    },
    replacements,
  );

  assert.doesNotMatch(redacted?.message ?? "", /Secret Diary|person@example\.com/);
  assert.match(redacted?.message ?? "", /"note-1\.md" was cloned for account-1/);
  assert.doesNotMatch(redacted?.hint ?? "", /Secret Diary/);
});

test("redactLastError passes undefined through unchanged", () => {
  assert.equal(redactLastError(undefined, []), undefined);
});
