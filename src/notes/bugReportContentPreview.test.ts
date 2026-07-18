import { test } from "node:test";
import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import type { DebugLogRecord } from "../debugLog.js";
import { compressNoteDocument } from "./noteText.js";
import { StringSchema } from "./gen/topotext_pb.js";
import { DocumentSchema as VersionedDocumentSchema, VersionSchema } from "./gen/versioned_document_pb.js";
import { TABLE_FIRST_REVISION } from "./realFixtures.js";
import { buildContentPreview, renderContentPreview } from "./bugReportContentPreview.js";

function encodeTextField(text: string): CloudKitRecord["fields"][string] {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, {
        minimumSupportedVersion: 0,
        data: toBinary(StringSchema, create(StringSchema, { string: text, attributeRun: [] })),
      }),
    ],
  });
  const compressed = compressNoteDocument(toBinary(VersionedDocumentSchema, message));
  return { value: Buffer.from(compressed).toString("base64"), type: "ENCRYPTED_BYTES" };
}

function makeNoteRecord(recordName: string, title: string, text: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Note",
    fields: {
      TitleEncrypted: { value: Buffer.from(title, "utf-8").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataEncrypted: encodeTextField(text),
    },
  };
}

function logEntryWithBody(body: unknown): DebugLogRecord {
  return { timestamp: "2026-01-01T00:00:00.000Z", note: "test", response: { status: 200, headers: {}, body } };
}

test("buildContentPreview decodes a note's title/body out of a records/lookup-shaped response", () => {
  const record = makeNoteRecord("REC1", "Bank Statement", "Balance: $42");
  const previews = buildContentPreview([logEntryWithBody({ records: [record] })]);

  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0], { recordName: "REC1", recordType: "Note", kind: "note", title: "Bank Statement", bodyText: "Balance: $42" });
});

test("buildContentPreview finds records nested under changes/zone's zones[].records shape too", () => {
  const record = makeNoteRecord("REC1", "Title", "Body");
  const body = { zones: [{ zoneID: { zoneName: "Notes" }, moreComing: false, syncToken: "tok", records: [record] }] };
  const previews = buildContentPreview([logEntryWithBody(body)]);

  assert.equal(previews.length, 1);
  assert.equal(previews[0]?.recordName, "REC1");
});

test("buildContentPreview decodes a table's MergeableDataEncrypted via decodeTableMarkdown", () => {
  const record: CloudKitRecord = {
    recordName: "TABLE1",
    recordType: "Attachment",
    fields: { MergeableDataEncrypted: { value: TABLE_FIRST_REVISION, type: "ENCRYPTED_BYTES" } },
  };
  const previews = buildContentPreview([logEntryWithBody({ records: [record] })]);

  assert.equal(previews.length, 1);
  assert.equal(previews[0]?.kind, "table");
  assert.match(previews[0]?.tableMarkdown ?? "", /\| A0 \| B0 \|/);
});

test("buildContentPreview skips a record whose bytes don't decode, without throwing", () => {
  const record: CloudKitRecord = {
    recordName: "BROKEN",
    recordType: "Note",
    fields: { TextDataEncrypted: { value: Buffer.from("not real protobuf").toString("base64"), type: "ENCRYPTED_BYTES" } },
  };

  const previews = buildContentPreview([logEntryWithBody({ records: [record] })]);

  assert.deepEqual(previews, []);
});

test("buildContentPreview skips a record with neither decodable field", () => {
  const record: CloudKitRecord = { recordName: "PLAIN", recordType: "Folder", fields: { TitleEncrypted: { value: "aGk=", type: "ENCRYPTED_BYTES" } } };

  const previews = buildContentPreview([logEntryWithBody({ records: [record] })]);

  assert.deepEqual(previews, []);
});

test("buildContentPreview dedupes the same record's identical content seen across two log entries", () => {
  const record = makeNoteRecord("REC1", "Title", "Body");
  const previews = buildContentPreview([logEntryWithBody({ records: [record] }), logEntryWithBody({ records: [record] })]);

  assert.equal(previews.length, 1);
});

test("buildContentPreview keeps both versions when the same recordName's content actually changed between captures", () => {
  const before = makeNoteRecord("REC1", "Title", "Before edit");
  const after = makeNoteRecord("REC1", "Title", "After edit");

  const previews = buildContentPreview([logEntryWithBody({ records: [before] }), logEntryWithBody({ records: [after] })]);

  assert.equal(previews.length, 2);
  assert.deepEqual(
    previews.map((preview) => preview.bodyText),
    ["Before edit", "After edit"],
  );
});

test("buildContentPreview never looks at a request - only response bodies are ever logged", () => {
  const entry: DebugLogRecord = {
    timestamp: "2026-01-01T00:00:00.000Z",
    note: "test",
    request: { method: "GET", url: "https://example.com", headers: {} },
  };

  assert.deepEqual(buildContentPreview([entry]), []);
});

test("renderContentPreview carries a do-not-share warning and renders decoded note/table content", () => {
  const rendered = renderContentPreview(
    [
      { recordName: "REC1", recordType: "Note", kind: "note", title: "Secret", bodyText: "Body text" },
      { recordName: "TABLE1", recordType: "Attachment", kind: "table", tableMarkdown: "| A | B |" },
    ],
    new Date("2026-01-01T00:00:00.000Z"),
  );

  assert.match(rendered, /DO NOT ATTACH OR SHARE THIS FILE/);
  assert.match(rendered, /Secret/);
  assert.match(rendered, /Body text/);
  assert.match(rendered, /\| A \| B \|/);
});

test("renderContentPreview says plainly when nothing decoded", () => {
  const rendered = renderContentPreview([], new Date("2026-01-01T00:00:00.000Z"));
  assert.match(rendered, /Nothing in this report's debug-log entries decoded/);
});
