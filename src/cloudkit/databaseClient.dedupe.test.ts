import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `loggedFetch` logs every request to ~/.config/icloud-md/debug.log, with the
// path fixed when `configDir.ts` loads - point HOME at a scratch dir *before*
// the dynamic imports below so this file's mocked traffic doesn't land in the
// real log. (The test runner gives each test file its own process, so the
// override can't leak into other files.)
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { dedupeZoneRecords, fetchAllNoteRecords, fetchAllZoneRecords, fetchSharedNoteRecords, fetchSharedZoneIds } =
  await import("./databaseClient.js");
type CloudKitRecord = import("./databaseClient.js").CloudKitRecord;

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function record(recordName: string, tag: string, modified?: number): CloudKitRecord {
  return {
    recordName,
    recordType: "Note",
    fields: {},
    recordChangeTag: tag,
    ...(modified === undefined ? {} : { modified: { timestamp: modified } }),
  };
}

function tombstone(recordName: string): CloudKitRecord {
  return { recordName, recordType: "Note", fields: {}, deleted: true };
}

function wireNote(recordName: string, tag: string, modified: number): unknown {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: tag,
    modified: { timestamp: modified },
    fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
  };
}

function zonePage(records: unknown[], syncToken: string, moreComing: boolean, ownerRecordName?: string): unknown {
  return { zones: [{ zoneID: { zoneName: "Notes", ownerRecordName }, moreComing, syncToken, records }] };
}

/** Serves scripted `changes/zone` (and, for shared walks, `changes/database`)
 * responses in request order. */
function installFetchMock(responses: unknown[]): () => void {
  let served = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (!href.includes("/changes/zone") && !href.includes("/changes/database")) {
      throw new Error(`Unexpected fetch in test: ${href}`);
    }
    const response = responses[served];
    served += 1;
    if (response === undefined) {
      throw new Error(`Unexpected extra request (#${served}): ${href}`);
    }
    return jsonResponse(response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("dedupeZoneRecords keeps the occurrence with the newer modified timestamp, in either listing order", () => {
  const older = record("note-1", "tag-old", 1_000);
  const newer = record("note-1", "tag-new", 2_000);

  assert.deepEqual(dedupeZoneRecords([older, newer]), [newer]);
  assert.deepEqual(dedupeZoneRecords([newer, older]), [newer]);
});

test("dedupeZoneRecords falls back to the later occurrence only on an exact tie", () => {
  assert.deepEqual(dedupeZoneRecords([record("n", "a", 1_000), record("n", "b", 1_000)]), [record("n", "b", 1_000)]);
  assert.deepEqual(dedupeZoneRecords([record("n", "a"), record("n", "b")]), [record("n", "b")]);
});

test("dedupeZoneRecords ranks a live copy without a timestamp below one with a timestamp, in either order", () => {
  assert.deepEqual(dedupeZoneRecords([record("n", "a"), record("n", "b", 5)]), [record("n", "b", 5)]);
  assert.deepEqual(dedupeZoneRecords([record("n", "a", 5), record("n", "b")]), [record("n", "a", 5)]);
});

test("dedupeZoneRecords lets a tombstone win over a live copy, in either order", () => {
  assert.deepEqual(dedupeZoneRecords([record("n", "a", 1_000), tombstone("n")]), [tombstone("n")]);
  assert.deepEqual(dedupeZoneRecords([tombstone("n"), record("n", "a", 1_000)]), [tombstone("n")]);
});

test("dedupeZoneRecords picks the same winner from three copies in every listing order", () => {
  const copies = [record("n", "newest", 5), record("n", "untimed"), record("n", "older", 3)];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders) {
    const listed = order.map((index) => copies[index]).filter((entry) => entry !== undefined);
    assert.deepEqual(
      dedupeZoneRecords(listed).map((entry) => entry.recordChangeTag),
      ["newest"],
      `listing order ${order.join(",")}`,
    );
  }
});

test("dedupeZoneRecords puts the winner at the first occurrence's position and leaves distinct records alone", () => {
  const result = dedupeZoneRecords([
    record("a", "a1", 1),
    record("b", "b1", 1),
    record("a", "a2", 2),
    record("c", "c1", 1),
  ]);

  assert.deepEqual(
    result.map((entry) => [entry.recordName, entry.recordChangeTag]),
    [
      ["a", "a2"],
      ["b", "b1"],
      ["c", "c1"],
    ],
  );
});

test("a record repeated across pages of one private walk comes back once", async () => {
  const restore = installFetchMock([
    zonePage([wireNote("note-1", "tag-1", 1_000), wireNote("note-2", "tag-2", 1_000)], "t1", true),
    zonePage([wireNote("note-1", "tag-1", 1_000), wireNote("note-3", "tag-3", 1_000)], "t2", false),
  ]);
  try {
    const result = await fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(
      result.records.map((entry) => entry.recordName),
      ["note-1", "note-2", "note-3"],
    );
    assert.equal(result.syncToken, "t2");
  } finally {
    restore();
  }
});

test("an incremental private walk lets a tombstone on one page win over a live copy on a later one", async () => {
  const restore = installFetchMock([
    zonePage([{ recordName: "note-1", deleted: true }], "t1", true),
    zonePage([wireNote("note-1", "tag-1", 1_000)], "t2", false),
  ]);
  try {
    const result = await fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345", "t0");

    assert.deepEqual(
      result.records.map((entry) => [entry.recordName, entry.deleted === true]),
      [["note-1", true]],
    );
    assert.equal(result.syncToken, "t2");
  } finally {
    restore();
  }
});

test("a record repeated across pages of one shared zone comes back once", async () => {
  const restore = installFetchMock([
    { moreComing: false, zones: [{ zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" } }] },
    zonePage([wireNote("note-1", "tag-old", 1_000), wireNote("note-2", "tag-2", 1_000)], "t1", true, "_ownerA"),
    zonePage([wireNote("note-1", "tag-new", 2_000)], "t2", false, "_ownerA"),
  ]);
  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(
      result.zones.map((zone) => zone.records.map((entry) => [entry.recordName, entry.recordChangeTag])),
      [
        [
          ["note-1", "tag-new"],
          ["note-2", "tag-2"],
        ],
      ],
    );
  } finally {
    restore();
  }
});

test("fetchAllZoneRecords collapses a repeated record too", async () => {
  const restore = installFetchMock([
    zonePage([wireNote("note-1", "tag-old", 1_000)], "t1", true),
    zonePage([wireNote("note-1", "tag-new", 2_000)], "t2", false),
  ]);
  try {
    const records = await fetchAllZoneRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(
      records.map((entry) => [entry.recordName, entry.recordChangeTag]),
      [["note-1", "tag-new"]],
    );
  } finally {
    restore();
  }
});

test("a walk that collapses a repeat records it in the debug log", async () => {
  const restore = installFetchMock([
    zonePage([wireNote("note-repeated", "tag-1", 1_000)], "t1", true),
    zonePage([wireNote("note-repeated", "tag-1", 1_000)], "t2", false),
  ]);
  try {
    await fetchAllZoneRecords(session, "https://ckdatabasews.example", "12345");
  } finally {
    restore();
  }

  const log = await readFile(path.join(scratchHome, ".config", "icloud-md", "debug.log"), "utf8");
  assert.match(log, /fetchAllZoneRecords: collapsed 1 repeated record listing\(s\) in one walk: note-repeated x2/);
});

test("fetchSharedZoneIds returns a zone listed on two pages once", async () => {
  const zone = (owner: string): unknown => ({
    zoneID: { zoneName: "Notes", ownerRecordName: owner, zoneType: "REGULAR_CUSTOM_ZONE" },
  });
  const restore = installFetchMock([
    { moreComing: true, syncToken: "p1", zones: [zone("_ownerA"), zone("_ownerB")] },
    { moreComing: false, syncToken: "p2", zones: [zone("_ownerA")] },
  ]);
  try {
    const zoneIds = await fetchSharedZoneIds(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(zoneIds, [
      { zoneName: "Notes", ownerRecordName: "_ownerA" },
      { zoneName: "Notes", ownerRecordName: "_ownerB" },
    ]);
  } finally {
    restore();
  }
});

test("the same recordName in two different shared zones is not collapsed", async () => {
  const restore = installFetchMock([
    {
      moreComing: false,
      zones: [
        { zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" } },
        { zoneID: { zoneName: "Notes", ownerRecordName: "_ownerB" } },
      ],
    },
    zonePage([wireNote("note-1", "tag-a", 1_000)], "ta", false, "_ownerA"),
    zonePage([wireNote("note-1", "tag-b", 1_000)], "tb", false, "_ownerB"),
  ]);
  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(
      result.zones.map((zone) => [zone.zoneID.ownerRecordName, zone.records.map((entry) => entry.recordChangeTag)]),
      [
        ["_ownerA", ["tag-a"]],
        ["_ownerB", ["tag-b"]],
      ],
    );
  } finally {
    restore();
  }
});
