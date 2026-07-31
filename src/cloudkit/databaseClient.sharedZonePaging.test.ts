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

const { fetchSharedZoneIds } = await import("./databaseClient.js");
const { CloudKitRequestFailedError } = await import("../errors.js");

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
 * Serves a paged shared `changes/database` listing: each entry in `pages` is
 * one response body, keyed by the syncToken the request must carry to get it
 * (the first request carries none). Records every request body for
 * assertions.
 */
function installFetchMock(pages: unknown[]): { restore: () => void; requestBodies: Record<string, unknown>[] } {
  const requestBodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (!href.includes("/shared/changes/database")) {
      throw new Error(`Unexpected fetch in test: ${href}`);
    }
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const page = pages[requestBodies.length - 1];
    if (page === undefined) {
      throw new Error(`Unexpected extra changes/database request (#${requestBodies.length})`);
    }
    return jsonResponse(page);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    requestBodies,
  };
}

function zoneEntry(ownerRecordName: string): unknown {
  return { zoneID: { zoneName: "Notes", ownerRecordName, zoneType: "REGULAR_CUSTOM_ZONE" } };
}

test("fetchSharedZoneIds follows moreComing across pages, resuming each request from the prior syncToken", async () => {
  const { restore, requestBodies } = installFetchMock([
    { moreComing: true, syncToken: "page-1", zones: [zoneEntry("_ownerA")] },
    { moreComing: true, syncToken: "page-2", zones: [zoneEntry("_ownerB")] },
    { moreComing: false, syncToken: "page-3", zones: [zoneEntry("_ownerC")] },
  ]);
  try {
    const zoneIds = await fetchSharedZoneIds(session, "https://ckdatabasews.example", "12345");

    assert.deepEqual(zoneIds, [
      { zoneName: "Notes", ownerRecordName: "_ownerA" },
      { zoneName: "Notes", ownerRecordName: "_ownerB" },
      { zoneName: "Notes", ownerRecordName: "_ownerC" },
    ]);
    assert.deepEqual(requestBodies, [{}, { syncToken: "page-1" }, { syncToken: "page-2" }]);
  } finally {
    restore();
  }
});

test("fetchSharedZoneIds fails loudly when moreComing arrives without a syncToken, instead of looping", async () => {
  const { restore } = installFetchMock([{ moreComing: true, zones: [zoneEntry("_ownerA")] }]);
  try {
    await assert.rejects(
      fetchSharedZoneIds(session, "https://ckdatabasews.example", "12345"),
      (error: unknown) => error instanceof CloudKitRequestFailedError && /moreComing/.test(error.message),
    );
  } finally {
    restore();
  }
});

test("fetchSharedZoneIds fails loudly when the server repeats the same syncToken with moreComing", async () => {
  const { restore } = installFetchMock([
    { moreComing: true, syncToken: "page-1", zones: [zoneEntry("_ownerA")] },
    { moreComing: true, syncToken: "page-1", zones: [zoneEntry("_ownerA")] },
  ]);
  try {
    await assert.rejects(
      fetchSharedZoneIds(session, "https://ckdatabasews.example", "12345"),
      (error: unknown) => error instanceof CloudKitRequestFailedError && /same page/.test(error.message),
    );
  } finally {
    restore();
  }
});
