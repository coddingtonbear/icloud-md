import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";

// `loggedFetch` logs every request to ~/.config/icloud-md/debug.log, with the
// path fixed when `configDir.ts` loads - point HOME at a scratch dir *before*
// the dynamic import below so this file's mocked traffic doesn't land in the
// real log.
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { backfillNewPrivateNoteBodies } = await import("./privateNoteBodies.js");

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};

/** A private `changes/zone` listing record for a live Note that came through
 * without `TextDataEncrypted`. */
function bodylessNote(recordName: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: `tag-${recordName}`,
    fields: { TitleEncrypted: { value: "dGl0bGU=", type: "ENCRYPTED_BYTES" } },
  };
}

function noteWithText(recordName: string): CloudKitRecord {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: `tag-${recordName}`,
    fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
  };
}

function fullLookupEntry(recordName: string): Record<string, unknown> {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: `tag-${recordName}-lookup`,
    fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
  };
}

/** Answers private `records/lookup` with `makeLookupEntries`, recording each
 * request's database and record list; any other request fails the test. */
function installFetchMock(makeLookupEntries: (requested: string[]) => unknown[]): {
  restore: () => void;
  lookups: Array<{ href: string; recordNames: string[]; zoneID: unknown }>;
} {
  const realFetch = globalThis.fetch;
  const lookups: Array<{ href: string; recordNames: string[]; zoneID: unknown }> = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/private/records/lookup")) {
      const request = JSON.parse(String(init?.body)) as { records: Array<{ recordName: string }>; zoneID: unknown };
      const recordNames = request.records.map((entry) => entry.recordName);
      lookups.push({ href, recordNames, zoneID: request.zoneID });
      return new Response(JSON.stringify({ records: makeLookupEntries(recordNames) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    lookups,
  };
}

test("a new private note listed without its text is looked up and filled in", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const records = [noteWithText("has-text"), bodylessNote("new-note")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {});

    assert.deepEqual(pending, []);
    assert.deepEqual(
      mock.lookups.map((lookup) => lookup.recordNames),
      [["new-note"]],
    );
    assert.deepEqual(mock.lookups[0]?.zoneID, { zoneName: "Notes" });
    assert.equal(records[1]?.fields.TextDataEncrypted?.value, "Ym9keQ==");
    assert.equal(records[1]?.recordChangeTag, "tag-new-note-lookup");
  } finally {
    mock.restore();
  }
});

test("a new note the lookup can't fill is returned as pending, for the caller to store", async () => {
  const mock = installFetchMock((requested) =>
    requested.map((recordName) =>
      recordName === "still-missing"
        ? { recordName, serverErrorCode: "NOT_FOUND", reason: "record not found" }
        : fullLookupEntry(recordName),
    ),
  );
  try {
    const records = [bodylessNote("filled"), bodylessNote("still-missing")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {});

    assert.deepEqual(pending, ["still-missing"]);
    assert.equal(records[0]?.fields.TextDataEncrypted?.value, "Ym9keQ==");
    assert.equal(records[1]?.fields.TextDataEncrypted, undefined);
  } finally {
    mock.restore();
  }
});

test("a failed lookup leaves every looked-up note pending instead of failing the sync", async () => {
  const realFetch = globalThis.fetch;
  let lookupCalls = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (href.includes("/private/records/lookup")) {
      lookupCalls += 1;
      // Not a throttle status, so `fetchWithThrottleRetry` doesn't wait and retry.
      return new Response("Internal Server Error", { status: 500 });
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  try {
    const records = [noteWithText("has-text"), bodylessNote("new-a"), bodylessNote("new-b")];

    const result = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {}, [
      "carried",
    ]);

    assert.equal(lookupCalls, 1);
    assert.deepEqual(result.pending, ["new-a", "new-b", "carried"]);
    assert.match(result.lookupError ?? "", /HTTP 500/);
    assert.equal(records.length, 3);
    assert.equal(records[1]?.fields.TextDataEncrypted, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a successful lookup reports no lookup error", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const result = await backfillNewPrivateNoteBodies(
      session,
      "https://ckdatabasews.example",
      "12345",
      [bodylessNote("new-note")],
      {},
    );

    assert.deepEqual(result, { pending: [] });
  } finally {
    mock.restore();
  }
});

test("a note whose text lives in a TextDataAsset is skipped, not kept pending", async () => {
  // Its text never arrives inline, so it would be looked up on every pull
  // for good.
  const mock = installFetchMock((requested) =>
    requested.map((recordName) => ({
      recordName,
      recordType: "Note",
      recordChangeTag: `tag-${recordName}-lookup`,
      fields: { TextDataAsset: { value: { downloadURL: "https://cvws.example/asset" }, type: "ASSETID" } },
    })),
  );
  try {
    const records = [bodylessNote("large-note")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {});

    assert.deepEqual(pending, []);
    assert.equal(mock.lookups.length, 1);
  } finally {
    mock.restore();
  }
});

test("tracked, deleted, trashed and non-Note records are never looked up", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const records: CloudKitRecord[] = [
      bodylessNote("tracked"),
      { recordName: "tombstone", recordType: "Note", fields: {}, deleted: true },
      { ...bodylessNote("purged"), fields: { Deleted: { value: 1, type: "INT64" } } },
      {
        ...bodylessNote("trashed"),
        fields: { Folder: { value: { recordName: "TrashFolder-CloudKit", action: "VALIDATE" }, type: "REFERENCE" } },
      },
      { recordName: "folder", recordType: "Folder", fields: {} },
      noteWithText("has-text"),
    ];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {
      tracked: { file: "Notes/Tracked.md" },
    });

    assert.deepEqual(pending, []);
    assert.deepEqual(mock.lookups, []);
  } finally {
    mock.restore();
  }
});

test("a carried note the walk no longer lists is looked up and appended once it has its text", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    // An incremental walk past the note: nothing about it is listed.
    const records = [noteWithText("unrelated")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {}, [
      "carried",
    ]);

    assert.deepEqual(pending, []);
    assert.deepEqual(
      mock.lookups.map((lookup) => lookup.recordNames),
      [["carried"]],
    );
    assert.deepEqual(
      records.map((record) => record.recordName),
      ["unrelated", "carried"],
    );
    assert.equal(records[1]?.fields.TextDataEncrypted?.value, "Ym9keQ==");
  } finally {
    mock.restore();
  }
});

test("a carried note that still has no text stays pending, alongside newly listed ones", async () => {
  const mock = installFetchMock((requested) =>
    requested.map((recordName) => (recordName === "filled" ? fullLookupEntry(recordName) : bodylessNote(recordName))),
  );
  try {
    const records = [bodylessNote("filled"), bodylessNote("new")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {}, [
      "carried",
    ]);

    assert.deepEqual(pending, ["new", "carried"]);
    assert.deepEqual(
      mock.lookups.map((lookup) => lookup.recordNames),
      [["filled", "new", "carried"]],
    );
  } finally {
    mock.restore();
  }
});

test("a carried note that is gone, trashed or tracked by now is dropped from the list", async () => {
  const mock = installFetchMock((requested) =>
    requested.map((recordName) =>
      recordName === "gone"
        ? { recordName, serverErrorCode: "NOT_FOUND", reason: "record not found" }
        : {
            ...bodylessNote(recordName),
            fields: { Folder: { value: { recordName: "TrashFolder-CloudKit", action: "VALIDATE" }, type: "REFERENCE" } },
          },
    ),
  );
  try {
    const records: CloudKitRecord[] = [];

    const { pending } = await backfillNewPrivateNoteBodies(
      session,
      "https://ckdatabasews.example",
      "12345",
      records,
      { tracked: { file: "Notes/Tracked.md" } },
      ["gone", "trashed", "tracked"],
    );

    assert.deepEqual(pending, []);
    // The tracked one has arrived by another route, so it isn't asked for.
    assert.deepEqual(
      mock.lookups.map((lookup) => lookup.recordNames),
      [["gone", "trashed"]],
    );
  } finally {
    mock.restore();
  }
});

test("a carried note the walk lists again is looked up once, not appended a second time", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const records = [bodylessNote("carried")];

    const { pending } = await backfillNewPrivateNoteBodies(session, "https://ckdatabasews.example", "12345", records, {}, [
      "carried",
      "carried",
    ]);

    assert.deepEqual(pending, []);
    assert.deepEqual(
      mock.lookups.map((lookup) => lookup.recordNames),
      [["carried"]],
    );
    assert.equal(records.length, 1);
  } finally {
    mock.restore();
  }
});
