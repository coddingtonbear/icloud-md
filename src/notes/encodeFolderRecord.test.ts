import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFolderCreateFields } from "./encodeFolderRecord.js";

test("a top-level folder carries exactly one field: its base64 title", () => {
  const { fields, parentRecordName } = buildFolderCreateFields("Recipes");

  // Matches a folder created by Apple's own web client, dumped 2026-07-30:
  // TitleEncrypted and nothing else.
  assert.deepEqual(Object.keys(fields), ["TitleEncrypted"]);
  assert.equal(parentRecordName, undefined);

  const value = (fields.TitleEncrypted as { value: string }).value;
  assert.equal(Buffer.from(value, "base64").toString("utf-8"), "Recipes", "ENCRYPTED_BYTES carries plain UTF-8 from the client");
});

test("a title's non-ASCII characters survive the base64 round trip", () => {
  const title = "Ricette – Dolci 🍰";
  const { fields } = buildFolderCreateFields(title);
  const value = (fields.TitleEncrypted as { value: string }).value;
  assert.equal(Buffer.from(value, "base64").toString("utf-8"), title);
});

test("a nested folder adds ParentFolder and the matching record-level parent", () => {
  const { fields, parentRecordName } = buildFolderCreateFields("Desserts", "parent-record");

  assert.deepEqual(Object.keys(fields).sort(), ["ParentFolder", "TitleEncrypted"]);
  assert.equal(parentRecordName, "parent-record", "the record-level parent mirrors the field");
  assert.deepEqual((fields.ParentFolder as { value: unknown }).value, {
    recordName: "parent-record",
    action: "VALIDATE",
    zoneID: { zoneName: "Notes" },
  });
});
