import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstZone,
  mergeLookedUpRecords,
  parseNoteDeleteResponse,
  parseNoteUpdateResponse,
  parseRecordUpdateResponse,
  parseSharedZoneList,
  type CloudKitRecord,
} from "./databaseClient.js";

test("parseSharedZoneList extracts zoneName and ownerRecordName per zone", () => {
  // Shape observed from a real `shared/changes/database` response.
  const body = {
    moreComing: false,
    syncToken: "AQAAAZ9XZ9gy",
    zones: [
      {
        zoneID: {
          zoneName: "Notes",
          ownerRecordName: "_35c0dc4416a1c75e7d98713af3f50348",
          zoneType: "REGULAR_CUSTOM_ZONE",
        },
      },
      {
        zoneID: {
          zoneName: "Notes",
          ownerRecordName: "_3ae5f00b01edbda385d0db894253c622",
          zoneType: "REGULAR_CUSTOM_ZONE",
        },
      },
    ],
  };

  assert.deepEqual(parseSharedZoneList(body), [
    { zoneName: "Notes", ownerRecordName: "_35c0dc4416a1c75e7d98713af3f50348" },
    { zoneName: "Notes", ownerRecordName: "_3ae5f00b01edbda385d0db894253c622" },
  ]);
});

test("parseSharedZoneList handles an account with no shared zones", () => {
  assert.deepEqual(parseSharedZoneList({ moreComing: false, zones: [] }), []);
});

test("parseSharedZoneList rejects responses without a zones array", () => {
  assert.throws(() => parseSharedZoneList({ syncToken: "x" }), /missing zones array/);
});

test("firstZone throws on a zone-level server error instead of returning an empty zone", () => {
  // Real response observed live: HTTP 200, but the zone entry carries an
  // error (here: from sending `reverse: true` to the shared database).
  const body = {
    zones: [
      {
        zoneID: { zoneName: "Notes", ownerRecordName: "_owner", zoneType: "REGULAR_CUSTOM_ZONE" },
        reason: "Reverse sync of share db is unsupported",
        serverErrorCode: "BAD_REQUEST",
      },
    ],
  };

  assert.throws(() => firstZone(body), /BAD_REQUEST.*Reverse sync of share db is unsupported/);
});

test("firstZone parses a deletion tombstone record instead of throwing on its missing recordType/fields", () => {
  // Real shape observed live 2026-07-16: a note deleted since the last sync
  // token comes back in `changes/zone` as `{recordName, deleted: true}`,
  // with no `recordType`/`fields` - the same shape `forceDelete` returns on
  // a successful delete (see parseNoteDeleteResponse).
  const body = {
    zones: [
      {
        zoneID: { zoneName: "Notes", zoneType: "REGULAR_CUSTOM_ZONE" },
        syncToken: "AQAAAZ9XZ9gy",
        records: [{ recordName: "deleted-note-1", deleted: true }],
      },
    ],
  };

  const zone = firstZone(body);
  assert.deepEqual(zone.records, [{ recordName: "deleted-note-1", recordType: "Note", fields: {}, deleted: true }]);
});

function makeRecord(recordName: string, fields: CloudKitRecord["fields"], changeTag?: string): CloudKitRecord {
  return { recordName, recordType: "Note", fields, recordChangeTag: changeTag };
}

test("mergeLookedUpRecords swaps listing records for their full looked-up versions", () => {
  const records = [
    makeRecord("A", { TitleEncrypted: { value: "dA==", type: "ENCRYPTED_BYTES" } }, "tag-list-a"),
    makeRecord("B", { TitleEncrypted: { value: "dQ==", type: "ENCRYPTED_BYTES" } }, "tag-list-b"),
  ];
  const lookedUp = [
    makeRecord(
      "A",
      {
        TitleEncrypted: { value: "dA==", type: "ENCRYPTED_BYTES" },
        TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" },
      },
      "tag-full-a",
    ),
  ];

  mergeLookedUpRecords(records, lookedUp);

  assert.equal(records[0]?.fields.TextDataEncrypted?.value, "Ym9keQ==");
  assert.equal(records[0]?.recordChangeTag, "tag-full-a");
  // B wasn't looked up; untouched.
  assert.equal(records[1]?.fields.TextDataEncrypted, undefined);
  assert.equal(records[1]?.recordChangeTag, "tag-list-b");
});

test("mergeLookedUpRecords keeps the listing changeTag when the lookup lacks one", () => {
  const records = [makeRecord("A", {}, "tag-list-a")];
  const lookedUp = [makeRecord("A", { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } })];

  mergeLookedUpRecords(records, lookedUp);

  assert.equal(records[0]?.recordChangeTag, "tag-list-a");
});

test("parseNoteUpdateResponse returns the updated record on success", () => {
  // Shape observed from a real records/modify response.
  const body = {
    records: [
      {
        recordName: "F90C80BA-2D47-4CB1-B000-000000000000",
        recordType: "Note",
        recordChangeTag: "25d",
        fields: {
          ModificationDate: { value: 1783880004527, type: "TIMESTAMP" },
          TextDataEncrypted: { value: "eJw=", type: "ENCRYPTED_BYTES" },
        },
        parent: { recordName: "DefaultFolder-CloudKit" },
      },
    ],
  };

  const result = parseNoteUpdateResponse(body);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.recordChangeTag, "25d");
    assert.equal(result.record.parentRecordName, "DefaultFolder-CloudKit");
    assert.equal(result.record.fields.ModificationDate?.value, 1783880004527);
  }
});

test("parseNoteUpdateResponse surfaces per-record server errors as typed refusals", () => {
  const body = {
    records: [
      {
        recordName: "F90C80BA-2D47-4CB1-B000-000000000000",
        reason: "record to update already exists with a different change tag",
        serverErrorCode: "CONFLICT",
      },
    ],
  };

  const result = parseNoteUpdateResponse(body);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.serverErrorCode, "CONFLICT");
    assert.match(result.reason ?? "", /change tag/);
  }
});

test("parseNoteUpdateResponse rejects bodies without a records array", () => {
  assert.throws(() => parseNoteUpdateResponse({}), /missing records array/);
});

test("parseNoteDeleteResponse succeeds on a real forceDelete response - no recordType/fields, unlike an update", () => {
  // Captured live 2026-07-16 - a successful forceDelete echoes back only
  // recordName + deleted:true, not the full record shape an `update`
  // response has (see the dev note this bug produced).
  const body = { records: [{ recordName: "1341629E-A0AA-46BC-A9B7-E7FF64DF5CAA", deleted: true }] };
  const result = parseNoteDeleteResponse(body);
  assert.equal(result.ok, true);
});

test("parseNoteDeleteResponse surfaces per-record server errors as typed refusals", () => {
  const body = {
    records: [
      {
        recordName: "F90C80BA-2D47-4CB1-B000-000000000000",
        reason: "record to update already exists with a different change tag",
        serverErrorCode: "CONFLICT",
      },
    ],
  };

  const result = parseNoteDeleteResponse(body);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.serverErrorCode, "CONFLICT");
    assert.match(result.reason ?? "", /change tag/);
  }
});

test("parseNoteDeleteResponse rejects bodies without a records array", () => {
  assert.throws(() => parseNoteDeleteResponse({}), /missing records array/);
});

test("parseRecordUpdateResponse returns one result per record, in order, mixing success and failure", () => {
  const body = {
    records: [
      {
        recordName: "note-1",
        recordType: "Note",
        recordChangeTag: "25d",
        fields: { TextDataEncrypted: { value: "eJw=", type: "ENCRYPTED_BYTES" } },
      },
      {
        recordName: "attachment-1",
        reason: "record to update already exists with a different change tag",
        serverErrorCode: "CONFLICT",
      },
    ],
  };

  const results = parseRecordUpdateResponse(body);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ok, true);
  if (results[0]?.ok) {
    assert.equal(results[0].record.recordName, "note-1");
  }
  assert.equal(results[1]?.ok, false);
  if (results[1] && !results[1].ok) {
    assert.equal(results[1].serverErrorCode, "CONFLICT");
  }
});

test("parseRecordUpdateResponse returns an empty array for an empty records array, unlike the single-record parser", () => {
  assert.deepEqual(parseRecordUpdateResponse({ records: [] }), []);
});

test("parseRecordUpdateResponse rejects bodies without a records array", () => {
  assert.throws(() => parseRecordUpdateResponse({}), /missing records array/);
});
