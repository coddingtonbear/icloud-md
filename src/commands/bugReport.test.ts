import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { appendDebugLog } from "../debugLog.js";
import { recordLastError } from "../lastError.js";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { compressNoteDocument } from "../notes/noteText.js";
import { StringSchema } from "../notes/gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "../notes/gen/versioned_document_pb.js";
import { writeCloneState, type CloneState } from "../notes/cloneState.js";
import { parseSinceDuration, runBugReport, runBugReportIdentify, DISCLOSURE_WARNING } from "./bugReport.js";

function encodedNoteRecordBody(recordName: string, title: string, text: string): unknown {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, { minimumSupportedVersion: 0, data: toBinary(StringSchema, create(StringSchema, { string: text, attributeRun: [] })) }),
    ],
  });
  const compressed = compressNoteDocument(toBinary(VersionedDocumentSchema, message));
  const record: CloudKitRecord = {
    recordName,
    recordType: "Note",
    fields: {
      TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataEncrypted: { value: Buffer.from(compressed).toString("base64"), type: "ENCRYPTED_BYTES" },
    },
  };
  return { records: [record] };
}

async function withTempDirs(
  run: (paths: { targetDir: string; debugLogPath: string; lastErrorPath: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bugreport-test-"));
  try {
    await run({
      targetDir: dir,
      debugLogPath: path.join(dir, "config", "debug.log"),
      lastErrorPath: path.join(dir, "config", "last-error.json"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const STATE: CloneState = {
  syncToken: "token",
  account: { appleId: "person@example.com", dsid: "123" },
  notes: {
    REC1: { file: "Test Note.md", recordChangeTag: "1a", modificationDate: 100 },
  },
};

test("bundles environment info, last error, state, and in-range log entries into one file", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await writeCloneState(targetDir, STATE);
    await recordLastError(new Error("push failed"), lastErrorPath);
    await writeFile(
      debugLogPath,
      [
        JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", note: "tooOld" }),
        JSON.stringify({ timestamp: "2026-07-14T12:30:00.000Z", note: "inRange" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const summary = await runBugReport(targetDir, new Date("2026-07-14T12:00:00.000Z"), { debugLogPath, lastErrorPath });

    assert.equal(summary.logEntryCount, 1);
    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /# icloud-md bug report/);
    assert.match(contents, /push failed/);
    assert.match(contents, /"note": "inRange"/);
    assert.doesNotMatch(contents, /tooOld/);
  }));

test("redacts the note's real file path, the account's real appleId/dsid, and folder/sharer names", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const state: CloneState = {
      syncToken: "token",
      account: { appleId: "person@example.com", dsid: "12345" },
      notes: {
        REC1: { file: "Recipes/Bank Statement.md", recordChangeTag: "1a", modificationDate: 100, folderRecordName: "FOLDER1" },
      },
      folders: { FOLDER1: { name: "Recipes", dirName: "Recipes" } },
    };
    await writeCloneState(targetDir, state);

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const contents = await readFile(summary.outputPath, "utf-8");

    assert.doesNotMatch(contents, /person@example\.com/);
    assert.doesNotMatch(contents, /12345/);
    assert.doesNotMatch(contents, /Bank Statement/);
    assert.doesNotMatch(contents, /Recipes/);
    assert.match(contents, /"appleId": "account-\d+"/);
    assert.match(contents, /"dsid": "account-\d+"/);
    assert.match(contents, /"file": "folder-1\/note-1\.md"/);
    assert.match(contents, /## Redacted identifiers/);
  }));

test("assigns the same note the same alias across repeated runs, and different notes different aliases", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        REC1: { file: "One.md", recordChangeTag: "1a", modificationDate: 100 },
        REC2: { file: "Two.md", recordChangeTag: "1b", modificationDate: 100 },
      },
    };
    await writeCloneState(targetDir, state);

    const first = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const firstContents = await readFile(first.outputPath, "utf-8");
    assert.match(firstContents, /"file": "note-1\.md"/);
    assert.match(firstContents, /"file": "note-2\.md"/);

    const second = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const secondContents = await readFile(second.outputPath, "utf-8");
    assert.match(secondContents, /"file": "note-1\.md"/);
    assert.match(secondContents, /"file": "note-2\.md"/);
  }));

test("drops identity fields (name/email/aliases) from a captured debug-log response body", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await appendDebugLog(
      {
        note: "checkAuthentication",
        response: {
          status: 200,
          headers: {},
          body: {
            dsInfo: {
              dsid: "12345",
              appleId: "person@example.com",
              firstName: "Adam",
              lastName: "Coddington",
              primaryEmail: "person@example.com",
              appleIdAliases: ["alt@example.com"],
            },
          },
        },
      },
      debugLogPath,
    );

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const contents = await readFile(summary.outputPath, "utf-8");

    assert.doesNotMatch(contents, /Adam/);
    assert.doesNotMatch(contents, /Coddington/);
    assert.doesNotMatch(contents, /person@example\.com/);
    assert.doesNotMatch(contents, /alt@example\.com/);
    assert.match(contents, /"firstName": "\[omitted\]"/);
    assert.match(contents, /"dsid": "account-\d+"/);
  }));

test("pseudonymizes a dsid embedded in a captured request URL's query string", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await writeCloneState(targetDir, { syncToken: "token", account: { appleId: "person@example.com", dsid: "999999" }, notes: {} });
    await appendDebugLog(
      { note: "fetchZone", request: { method: "GET", url: "https://example.com/changes/zone?dsid=999999&clientId=abc", headers: {} } },
      debugLogPath,
    );

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const contents = await readFile(summary.outputPath, "utf-8");

    assert.doesNotMatch(contents, /999999/);
    assert.match(contents, /clientId=abc/);
  }));

test("scrubs a real filename and appleId quoted inside lastError's message", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const state: CloneState = {
      syncToken: "token",
      account: { appleId: "person@example.com", dsid: "12345" },
      notes: { REC1: { file: "Secret Diary.md", recordChangeTag: "1a", modificationDate: 100 } },
    };
    await writeCloneState(targetDir, state);
    await recordLastError(
      new Error('Secret Diary.md was cloned for person@example.com, but the session just authenticated is for other@example.com.'),
      lastErrorPath,
    );

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });
    const contents = await readFile(summary.outputPath, "utf-8");

    assert.doesNotMatch(contents, /Secret Diary/);
    assert.doesNotMatch(contents, /person@example\.com/);
    assert.match(contents, /note-1\.md was cloned for account-\d+/);
  }));

test("writes a decoded-content preview companion file when a log entry decodes to readable note content", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await appendDebugLog(
      { note: "records/lookup", response: { status: 200, headers: {}, body: encodedNoteRecordBody("REC1", "Bank Statement", "Balance: $42") } },
      debugLogPath,
    );

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    assert.ok(summary.contentPreviewPath);
    assert.equal(path.dirname(summary.contentPreviewPath ?? ""), targetDir);
    assert.match(path.basename(summary.contentPreviewPath ?? ""), /\.content-preview\.md$/);

    const preview = await readFile(summary.contentPreviewPath ?? "", "utf-8");
    assert.match(preview, /DO NOT ATTACH OR SHARE THIS FILE/);
    assert.match(preview, /Bank Statement/);
    assert.match(preview, /Balance: \$42/);

    // The decoded content lives only in the companion file, never in the
    // shareable report itself.
    const reportContents = await readFile(summary.outputPath, "utf-8");
    assert.doesNotMatch(reportContents, /Balance: \$42/);
  }));

test("doesn't write a content-preview file when nothing in the log window decodes", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await appendDebugLog({ note: "irrelevant", response: { status: 200, headers: {}, body: { ok: true } } }, debugLogPath);

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    assert.equal(summary.contentPreviewPath, undefined);
  }));

test("handles a directory with no state.json and no recorded error gracefully", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /No failure has been recorded/);
    assert.match(contents, /No `\.icloud-md\/state\.json` found/);
    assert.match(contents, /No debug log entries fall within this time range\./);
  }));

test("reports the disclosure warning before writing the bundle", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    const disclosures: string[] = [];
    await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath, onDisclosure: (message) => disclosures.push(message) });

    assert.ok(disclosures.includes(DISCLOSURE_WARNING));
  }));

test("writes the bundle into the target directory", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await appendDebugLog({ note: "irrelevant" }, debugLogPath);

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    assert.equal(path.dirname(summary.outputPath), targetDir);
    assert.match(path.basename(summary.outputPath), /^icloud-md-bug-report-.*\.md$/);
  }));

test("reports a corrupt state.json instead of crashing", () =>
  withTempDirs(async ({ targetDir, debugLogPath, lastErrorPath }) => {
    await mkdir(path.join(targetDir, ".icloud-md"), { recursive: true });
    await writeFile(path.join(targetDir, ".icloud-md", "state.json"), "{}", "utf-8");

    const summary = await runBugReport(targetDir, new Date(0), { debugLogPath, lastErrorPath });

    const contents = await readFile(summary.outputPath, "utf-8");
    assert.match(contents, /exists but couldn't be read/);
    assert.match(contents, /does not look like a valid state file/);
  }));

test("runBugReportIdentify prints and returns the same alias bug-report would use, stably across calls", () =>
  withTempDirs(async ({ targetDir }) => {
    const state: CloneState = {
      syncToken: "token",
      notes: {
        REC1: { file: "One.md", recordChangeTag: "1a", modificationDate: 100 },
        REC2: { file: "Two.md", recordChangeTag: "1b", modificationDate: 100 },
      },
    };
    await writeCloneState(targetDir, state);

    const first = await runBugReportIdentify(targetDir, path.join(targetDir, "Two.md"));
    const second = await runBugReportIdentify(targetDir, path.join(targetDir, "Two.md"));
    const other = await runBugReportIdentify(targetDir, path.join(targetDir, "One.md"));

    assert.equal(first.alias, second.alias);
    assert.notEqual(first.alias, other.alias);
    assert.match(first.alias, /^note-\d+$/);
  }));

test("parseSinceDuration parses minutes, hours, and days into a past Date", () => {
  const now = Date.now();

  const thirtyMinutes = parseSinceDuration("30m");
  assert.ok(thirtyMinutes);
  assert.ok(Math.abs(now - thirtyMinutes.getTime() - 30 * 60_000) < 1000);

  const sixHours = parseSinceDuration("6h");
  assert.ok(sixHours);
  assert.ok(Math.abs(now - sixHours.getTime() - 6 * 3_600_000) < 1000);

  const twoDays = parseSinceDuration("2d");
  assert.ok(twoDays);
  assert.ok(Math.abs(now - twoDays.getTime() - 2 * 86_400_000) < 1000);
});

test("parseSinceDuration rejects malformed or unsupported input", () => {
  assert.equal(parseSinceDuration(""), undefined);
  assert.equal(parseSinceDuration("since yesterday"), undefined);
  assert.equal(parseSinceDuration("1"), undefined);
  assert.equal(parseSinceDuration("m"), undefined);
  assert.equal(parseSinceDuration("1w"), undefined);
  assert.equal(parseSinceDuration("-1h"), undefined);
});
