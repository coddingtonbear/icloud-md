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

const { fetchSharedNoteRecords } = await import("./databaseClient.js");
const { CloudKitZoneFetchFailedError } = await import("../errors.js");

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

/**
 * Serves a shared `changes/database` listing of two zones, then per-zone
 * `changes/zone` responses: `_ownerA` succeeds with one full note record,
 * `_ownerB` answers a zone-level error inside an HTTP 200 (the issue #3
 * shape) with the given code.
 */
function installFetchMock(ownerBErrorCode: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/shared/changes/database")) {
      return jsonResponse({
        zones: [
          { zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA", zoneType: "REGULAR_CUSTOM_ZONE" } },
          { zoneID: { zoneName: "Notes", ownerRecordName: "_ownerB", zoneType: "REGULAR_CUSTOM_ZONE" } },
        ],
      });
    }
    if (href.includes("/shared/changes/zone")) {
      const request = JSON.parse(String(init?.body)) as { zones: [{ zoneID: { ownerRecordName: string } }] };
      const owner = request.zones[0].zoneID.ownerRecordName;
      if (owner === "_ownerA") {
        return jsonResponse({
          zones: [
            {
              zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" },
              syncToken: "token-a",
              moreComing: false,
              records: [
                {
                  recordName: "note-a",
                  recordType: "Note",
                  recordChangeTag: "tag-a",
                  fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
                },
              ],
            },
          ],
        });
      }
      return jsonResponse({
        zones: [
          {
            zoneID: { zoneName: "Notes", ownerRecordName: "_ownerB" },
            reason: "Zone does not exist",
            serverErrorCode: ownerBErrorCode,
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("fetchSharedNoteRecords skips a ZONE_NOT_FOUND zone and keeps every other zone's results", async () => {
  const restore = installFetchMock("ZONE_NOT_FOUND");
  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.equal(result.zones.length, 1);
    assert.equal(result.zones[0]?.zoneID.ownerRecordName, "_ownerA");
    assert.equal(result.zones[0]?.syncToken, "token-a");
    assert.equal(result.zones[0]?.records[0]?.recordName, "note-a");
    assert.deepEqual(result.skippedZones, [
      { zoneID: { zoneName: "Notes", ownerRecordName: "_ownerB" }, reason: "zone-not-found", serverErrorCode: "ZONE_NOT_FOUND" },
    ]);
  } finally {
    restore();
  }
});

test("fetchSharedNoteRecords stays fatal for any other zone-level error code", async () => {
  const restore = installFetchMock("INTERNAL_ERROR");
  try {
    await assert.rejects(
      fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345"),
      (error: unknown) => error instanceof CloudKitZoneFetchFailedError && error.serverErrorCode === "INTERNAL_ERROR",
    );
  } finally {
    restore();
  }
});
