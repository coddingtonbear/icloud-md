import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

const { fetchSharedNoteRecords, lookupRecords } = await import("./databaseClient.js");

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

/** A shared `changes/zone` listing record: a live Note without
 * `TextDataEncrypted`, the shape the shared database always returns and
 * `records/lookup` is expected to fill in. */
function bodylessListingRecord(recordName: string): Record<string, unknown> {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: `tag-${recordName}`,
    fields: { TitleEncrypted: { value: "dGl0bGU=", type: "ENCRYPTED_BYTES" } },
  };
}

/**
 * Serves one shared zone (`_ownerA`) whose listing returns two body-less
 * Note records, then answers `records/lookup` with `makeLookupEntries`. The
 * returned counter records every lookup request's record list.
 */
function installFetchMock(
  makeLookupEntries: (requested: string[]) => unknown[],
): { restore: () => void; lookupBatches: string[][] } {
  const realFetch = globalThis.fetch;
  const lookupBatches: string[][] = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/shared/changes/database")) {
      return jsonResponse({
        zones: [{ zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA", zoneType: "REGULAR_CUSTOM_ZONE" } }],
      });
    }
    if (href.includes("/shared/changes/zone")) {
      return jsonResponse({
        zones: [
          {
            zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" },
            syncToken: "token-a-new",
            moreComing: false,
            records: [bodylessListingRecord("note-1"), bodylessListingRecord("note-2")],
          },
        ],
      });
    }
    if (href.includes("/shared/records/lookup")) {
      const request = JSON.parse(String(init?.body)) as { records: Array<{ recordName: string }> };
      const requested = request.records.map((entry) => entry.recordName);
      lookupBatches.push(requested);
      return jsonResponse({ records: makeLookupEntries(requested) });
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    lookupBatches,
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

test("fetchSharedNoteRecords fills listing bodies via records/lookup and returns the zone", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(result.skippedZones, []);
    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0]?.syncToken, "token-a-new");
    for (const record of result.zones[0]?.records ?? []) {
      assert.equal(record.fields.TextDataEncrypted?.value, "Ym9keQ==");
    }
  } finally {
    mock.restore();
  }
});

test("fetchSharedNoteRecords skips a zone whose bodies are still missing after lookup, instead of returning it", async () => {
  // The finding-1 scenario (adversarial sync review, 2026-07-31): a
  // throttled/failed per-record lookup used to leave the body-less listing
  // record in the zone's results, where pull would classify the note
  // unsyncable and permanently untrack it while advancing the syncToken.
  // The zone must come back as skipped - no records, no new token.
  const mock = installFetchMock((requested) =>
    requested.map((recordName) =>
      recordName === "note-2"
        ? { recordName, serverErrorCode: "NOT_FOUND", reason: "record not found" }
        : fullLookupEntry(recordName),
    ),
  );
  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(result.zones, []);
    assert.deepEqual(result.skippedZones, [
      {
        zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" },
        reason: "missing-note-bodies",
        missingRecordNames: ["note-2"],
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("lookupRecords chunks large record-name lists into 200-record requests", async () => {
  const mock = installFetchMock((requested) => requested.map(fullLookupEntry));
  try {
    const names = Array.from({ length: 450 }, (_, index) => `note-${index}`);
    const records = await lookupRecords(
      session,
      "https://ckdatabasews.example",
      "12345",
      "shared",
      { zoneName: "Notes", ownerRecordName: "_ownerA" },
      names,
    );

    assert.deepEqual(
      mock.lookupBatches.map((batch) => batch.length),
      [200, 200, 50],
    );
    assert.deepEqual(
      records.map((record) => record.recordName),
      names,
    );
  } finally {
    mock.restore();
  }
});

test("lookupRecords with no names makes no request at all", async () => {
  const mock = installFetchMock(() => []);
  try {
    const records = await lookupRecords(
      session,
      "https://ckdatabasews.example",
      "12345",
      "shared",
      { zoneName: "Notes", ownerRecordName: "_ownerA" },
      [],
    );
    assert.deepEqual(records, []);
    assert.deepEqual(mock.lookupBatches, []);
  } finally {
    mock.restore();
  }
});
