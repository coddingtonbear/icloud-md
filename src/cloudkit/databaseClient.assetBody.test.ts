import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";

// Point HOME at a scratch dir before the dynamic imports below, so this
// file's mocked traffic doesn't land in the real debug log (see
// databaseClient.bodyLookup.test.ts).
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { fetchAllNoteRecords, fetchSharedNoteRecords } = await import("./databaseClient.js");
const { classifyNoteRecord } = await import("../notes/decodeNoteRecord.js");
const { compressNoteDocument } = await import("../notes/noteText.js");
const { StringSchema } = await import("../notes/gen/topotext_pb.js");
const { DocumentSchema: VersionedDocumentSchema, VersionSchema } = await import(
  "../notes/gen/versioned_document_pb.js"
);

const session = {
  cookie: "cookie",
  clientId: "client-id",
  clientBuildNumber: "build",
  clientMasteringNumber: "mastering",
  capturedAt: new Date().toISOString(),
};

const ASSET_URL = "https://cvws.icloud-content.example/B/asset-1";
const FRESH_ASSET_URL = "https://cvws.icloud-content.example/B/asset-1-fresh";

/** The gzipped NoteStoreProto document a `TextDataAsset` download returns -
 * the same bytes `TextDataEncrypted` would carry inline. */
function noteDocumentBytes(text: string): Buffer {
  const message = create(VersionedDocumentSchema, {
    version: [
      create(VersionSchema, {
        minimumSupportedVersion: 0,
        data: toBinary(StringSchema, create(StringSchema, { string: text, attributeRun: [] })),
      }),
    ],
  });
  return compressNoteDocument(toBinary(VersionedDocumentSchema, message));
}

/** A private `changes/zone` listing record for a note too large to keep its
 * text inline: no `TextDataEncrypted`, a `TextDataAsset` instead (the shape
 * of a real ~830 KB note, 2026-09-26). */
function assetBodyRecord(asset: Record<string, unknown> = { downloadURL: ASSET_URL }): Record<string, unknown> {
  return {
    recordName: "big-note",
    recordType: "Note",
    recordChangeTag: "tag-big",
    fields: {
      TitleEncrypted: { value: Buffer.from("Today").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataAsset: {
        value: { fileChecksum: "sum", size: 123, wrappingKey: "key", ...asset },
        type: "ASSETID",
      },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface FetchMock {
  restore: () => void;
  desiredKeys: unknown[];
  /** Every asset URL fetched, in order. */
  assetDownloads: string[];
  lookups: number;
}

/**
 * Serves one zone's `changes/zone` listing (`listed`), a `records/lookup`
 * answering with `lookedUp` (or nothing), and asset downloads through
 * `assetResponse`. `database` picks the private zone, or a single shared
 * zone owned by `_owner1`.
 */
function installFetchMock(options: {
  database: "private" | "shared";
  listed: Record<string, unknown>;
  lookedUp?: Record<string, unknown> | undefined;
  assetResponse: (url: string) => Response;
}): FetchMock {
  const realFetch = globalThis.fetch;
  const zoneID =
    options.database === "private" ? { zoneName: "Notes" } : { zoneName: "Notes", ownerRecordName: "_owner1" };
  const state: FetchMock = { restore: () => {}, desiredKeys: [], assetDownloads: [], lookups: 0 };
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes(`/${options.database}/changes/database`)) {
      return jsonResponse({ zones: [{ zoneID: { ...zoneID, zoneType: "REGULAR_CUSTOM_ZONE" } }] });
    }
    if (href.includes(`/${options.database}/changes/zone`)) {
      const request = JSON.parse(String(init?.body)) as { zones: Array<{ desiredKeys: unknown[] }> };
      state.desiredKeys = request.zones[0]?.desiredKeys ?? [];
      return jsonResponse({ zones: [{ zoneID, syncToken: "token-new", moreComing: false, records: [options.listed] }] });
    }
    if (href.includes(`/${options.database}/records/lookup`)) {
      state.lookups += 1;
      return jsonResponse({ records: options.lookedUp ? [options.lookedUp] : [] });
    }
    if (href.startsWith("https://cvws.icloud-content.example/")) {
      state.assetDownloads.push(href);
      return options.assetResponse(href);
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  state.restore = () => {
    globalThis.fetch = realFetch;
  };
  return state;
}

const HOST = "https://ckdatabasews.example";

test("fetchAllNoteRecords asks for TextDataAsset and inlines a large note's text from it", async () => {
  const bytes = noteDocumentBytes("Today\n~~~\n\n9am");
  const mock = installFetchMock({
    database: "private",
    listed: assetBodyRecord(),
    assetResponse: () => new Response(new Uint8Array(bytes), { status: 200 }),
  });
  try {
    const { records, syncToken } = await fetchAllNoteRecords(session, HOST, "12345");

    assert.ok(mock.desiredKeys.includes("TextDataAsset"));
    assert.deepEqual(mock.assetDownloads, [ASSET_URL]);
    assert.equal(mock.lookups, 0);
    assert.equal(syncToken, "token-new");
    const [record] = records;
    assert.ok(record);
    assert.equal(record.fields.TextDataEncrypted?.value, bytes.toString("base64"));
    const decoded = classifyNoteRecord(record);
    assert.equal(decoded.status, "ok");
    assert.equal(decoded.status === "ok" ? decoded.titleLine : undefined, "Today");
    // Readable, but never pushed: writing it back would mean uploading an asset.
    assert.equal(decoded.status === "ok" ? decoded.publishable : undefined, false);
    assert.match(decoded.status === "ok" ? (decoded.unpublishableReason ?? "") : "", /separate file/);
  } finally {
    mock.restore();
  }
});

test("fetchAllNoteRecords re-looks-up a note for a fresh URL when its listed asset URL has expired", async () => {
  const bytes = noteDocumentBytes("Today\n~~~\n\n9am");
  const mock = installFetchMock({
    database: "private",
    listed: assetBodyRecord(),
    lookedUp: assetBodyRecord({ downloadURL: FRESH_ASSET_URL }),
    assetResponse: (url) =>
      url === FRESH_ASSET_URL ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response("Gone", { status: 410 }),
  });
  try {
    const { records } = await fetchAllNoteRecords(session, HOST, "12345");

    assert.deepEqual(mock.assetDownloads, [ASSET_URL, FRESH_ASSET_URL]);
    assert.equal(mock.lookups, 1);
    assert.equal(records[0]?.fields.TextDataEncrypted?.value, bytes.toString("base64"));
  } finally {
    mock.restore();
  }
});

test("fetchAllNoteRecords fails rather than passing a large note on body-less when its download fails twice", async () => {
  // Body-less, the note would be skipped as unsyncable while the syncToken
  // moved past it - a clean-looking sync that silently lost the note.
  const mock = installFetchMock({
    database: "private",
    listed: assetBodyRecord(),
    lookedUp: assetBodyRecord({ downloadURL: FRESH_ASSET_URL }),
    assetResponse: () => new Response("Gone", { status: 410 }),
  });
  try {
    await assert.rejects(fetchAllNoteRecords(session, HOST, "12345"), /HTTP 410/);
    assert.equal(mock.lookups, 1);
    assert.deepEqual(mock.assetDownloads, [ASSET_URL, FRESH_ASSET_URL]);
  } finally {
    mock.restore();
  }
});

test("fetchAllNoteRecords treats a TextDataAsset with no download URL as a failed download, not a body-less note", async () => {
  const mock = installFetchMock({
    database: "private",
    listed: assetBodyRecord({ downloadURL: undefined }),
    lookedUp: assetBodyRecord({ downloadURL: undefined }),
    assetResponse: () => new Response("unreachable", { status: 500 }),
  });
  try {
    await assert.rejects(fetchAllNoteRecords(session, HOST, "12345"), /no download URL/);
    assert.equal(mock.lookups, 1);
    assert.deepEqual(mock.assetDownloads, []);
  } finally {
    mock.restore();
  }
});

/** A shared `changes/zone` listing record: like every shared note, it comes
 * back without its text, so `fetchSharedNoteRecords` looks it up. */
function bodylessSharedRecord(): Record<string, unknown> {
  return {
    recordName: "big-note",
    recordType: "Note",
    recordChangeTag: "tag-big",
    fields: { TitleEncrypted: { value: Buffer.from("Today").toString("base64"), type: "ENCRYPTED_BYTES" } },
  };
}

test("fetchSharedNoteRecords inlines the asset text of a large note the body lookup returns", async () => {
  const bytes = noteDocumentBytes("Today\n~~~\n\n9am");
  const mock = installFetchMock({
    database: "shared",
    listed: bodylessSharedRecord(),
    lookedUp: assetBodyRecord(),
    assetResponse: () => new Response(new Uint8Array(bytes), { status: 200 }),
  });
  try {
    const { zones, skippedZones } = await fetchSharedNoteRecords(session, HOST, "12345");

    assert.deepEqual(skippedZones, []);
    assert.equal(zones.length, 1);
    assert.equal(zones[0]?.syncToken, "token-new");
    assert.equal(zones[0]?.records[0]?.fields.TextDataEncrypted?.value, bytes.toString("base64"));
    assert.deepEqual(mock.assetDownloads, [ASSET_URL]);
  } finally {
    mock.restore();
  }
});

test("fetchSharedNoteRecords holds back only the zone whose large-note download fails, instead of aborting the pull", async () => {
  const mock = installFetchMock({
    database: "shared",
    listed: bodylessSharedRecord(),
    lookedUp: assetBodyRecord(),
    assetResponse: () => new Response("Gone", { status: 410 }),
  });
  try {
    const { zones, skippedZones } = await fetchSharedNoteRecords(session, HOST, "12345");

    // Skipped as missing-note-bodies: no records processed, old token kept.
    assert.deepEqual(zones, []);
    assert.deepEqual(skippedZones, [
      {
        zoneID: { zoneName: "Notes", ownerRecordName: "_owner1" },
        reason: "missing-note-bodies",
        missingRecordNames: ["big-note"],
      },
    ]);
    // The body lookup, then one fresh lookup before giving up.
    assert.equal(mock.lookups, 2);
    assert.equal(mock.assetDownloads.length, 2);
  } finally {
    mock.restore();
  }
});
