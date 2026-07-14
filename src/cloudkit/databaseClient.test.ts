import { test } from "node:test";
import assert from "node:assert/strict";
import { firstZone, mergeLookedUpRecords, parseSharedZoneList, type CloudKitRecord } from "./databaseClient.js";

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
