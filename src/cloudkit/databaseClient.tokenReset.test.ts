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

const { fetchAllNoteRecords, fetchSharedNoteRecords } = await import("./databaseClient.js");
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

function noteRecord(recordName: string, tag: string): unknown {
  return {
    recordName,
    recordType: "Note",
    recordChangeTag: tag,
    fields: { TextDataEncrypted: { value: "Ym9keQ==", type: "ENCRYPTED_BYTES" } },
  };
}

// The zone-level rejection an unusable sync token actually produces, observed
// live 2026-07-31: BAD_REQUEST inside an HTTP 200 ("Unknown sync continuation
// type" for a malformed token, "Invalid continuation format" for a corrupted
// one).
function tokenRejection(): unknown {
  return {
    zones: [{ zoneID: { zoneName: "Notes" }, serverErrorCode: "BAD_REQUEST", reason: "Unknown sync continuation type" }],
  };
}

/**
 * Serves scripted private `changes/zone` responses in order, recording each
 * request's zone entry so tests can assert what token (if any) was sent.
 */
function installFetchMock(responses: unknown[]): { restore: () => void; zoneRequests: Record<string, unknown>[] } {
  const zoneRequests: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (!href.includes("/changes/zone")) {
      throw new Error(`Unexpected fetch in test: ${href}`);
    }
    const body = JSON.parse(String(init?.body)) as { zones: Record<string, unknown>[] };
    zoneRequests.push(body.zones[0] ?? {});
    const response = responses[zoneRequests.length - 1];
    if (response === undefined) {
      throw new Error(`Unexpected extra changes/zone request (#${zoneRequests.length})`);
    }
    return jsonResponse(response);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    zoneRequests,
  };
}

test("a rejected sync token falls back to a full refetch and reports resyncedFromScratch", async () => {
  const { restore, zoneRequests } = installFetchMock([
    tokenRejection(),
    {
      zones: [
        {
          zoneID: { zoneName: "Notes" },
          moreComing: true,
          syncToken: "fresh-1",
          records: [noteRecord("note-1", "tag-1")],
        },
      ],
    },
    {
      zones: [
        {
          zoneID: { zoneName: "Notes" },
          moreComing: false,
          syncToken: "fresh-2",
          records: [noteRecord("note-2", "tag-2")],
        },
      ],
    },
  ]);
  try {
    const result = await fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345", "stale-token");

    assert.equal(result.resyncedFromScratch, true);
    assert.deepEqual(
      result.records.map((record) => record.recordName),
      ["note-1", "note-2"],
    );
    assert.equal(result.syncToken, "fresh-2");
    // First request carried the stored token; the fallback walk starts bare
    // and then pages on the server's own fresh tokens.
    assert.equal(zoneRequests[0]?.syncToken, "stale-token");
    assert.equal(zoneRequests[1]?.syncToken, undefined);
    assert.equal(zoneRequests[2]?.syncToken, "fresh-1");
  } finally {
    restore();
  }
});

test("an accepted sync token stays incremental: resyncedFromScratch is false", async () => {
  const { restore } = installFetchMock([
    {
      zones: [
        { zoneID: { zoneName: "Notes" }, moreComing: false, syncToken: "next", records: [noteRecord("note-1", "tag-1")] },
      ],
    },
  ]);
  try {
    const result = await fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345", "still-good");

    assert.equal(result.resyncedFromScratch, false);
    assert.equal(result.syncToken, "next");
  } finally {
    restore();
  }
});

test("BAD_REQUEST with no stored token propagates - there is nothing to fall back from", async () => {
  const { restore, zoneRequests } = installFetchMock([tokenRejection()]);
  try {
    await assert.rejects(
      fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345"),
      (error: unknown) => error instanceof CloudKitZoneFetchFailedError && error.serverErrorCode === "BAD_REQUEST",
    );
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("a non-BAD_REQUEST zone error does not trigger the fallback, even with a stored token", async () => {
  const { restore, zoneRequests } = installFetchMock([
    { zones: [{ zoneID: { zoneName: "Notes" }, serverErrorCode: "THROTTLED", reason: "slow down" }] },
  ]);
  try {
    await assert.rejects(
      fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345", "stale-token"),
      (error: unknown) => error instanceof CloudKitZoneFetchFailedError && error.serverErrorCode === "THROTTLED",
    );
    assert.equal(zoneRequests.length, 1);
  } finally {
    restore();
  }
});

test("a BAD_REQUEST that persists without the token propagates - the token was not the problem", async () => {
  const { restore, zoneRequests } = installFetchMock([tokenRejection(), tokenRejection()]);
  try {
    await assert.rejects(
      fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345", "stale-token"),
      (error: unknown) => error instanceof CloudKitZoneFetchFailedError && error.serverErrorCode === "BAD_REQUEST",
    );
    assert.equal(zoneRequests.length, 2);
  } finally {
    restore();
  }
});

test("fetchSharedNoteRecords carries a zone's resync through to its SharedZoneChanges entry", async () => {
  const realFetch = globalThis.fetch;
  let ownerARequests = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/shared/changes/database")) {
      return jsonResponse({
        moreComing: false,
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
        // First request (stored token) is rejected; the bare retry succeeds.
        ownerARequests += 1;
        if (ownerARequests === 1) {
          return jsonResponse({
            zones: [
              {
                zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" },
                serverErrorCode: "BAD_REQUEST",
                reason: "Unknown sync continuation type",
              },
            ],
          });
        }
        return jsonResponse({
          zones: [
            {
              zoneID: { zoneName: "Notes", ownerRecordName: "_ownerA" },
              moreComing: false,
              syncToken: "fresh-a",
              records: [noteRecord("note-a", "tag-a")],
            },
          ],
        });
      }
      return jsonResponse({
        zones: [
          {
            zoneID: { zoneName: "Notes", ownerRecordName: "_ownerB" },
            moreComing: false,
            syncToken: "token-b",
            records: [noteRecord("note-b", "tag-b")],
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;

  try {
    const result = await fetchSharedNoteRecords(session, "https://ckdatabasews.example", "12345", {
      _ownerA: "stale-token-a",
      _ownerB: "good-token-b",
    });

    assert.equal(result.skippedZones.length, 0);
    const zoneA = result.zones.find((zone) => zone.zoneID.ownerRecordName === "_ownerA");
    const zoneB = result.zones.find((zone) => zone.zoneID.ownerRecordName === "_ownerB");
    assert.equal(zoneA?.resyncedFromScratch, true);
    assert.equal(zoneA?.syncToken, "fresh-a");
    assert.equal(zoneB?.resyncedFromScratch, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
