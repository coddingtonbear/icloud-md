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

const { fetchAllNoteRecords } = await import("./databaseClient.js");
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
function assetBodyRecord(): Record<string, unknown> {
  return {
    recordName: "big-note",
    recordType: "Note",
    recordChangeTag: "tag-big",
    fields: {
      TitleEncrypted: { value: Buffer.from("Today").toString("base64"), type: "ENCRYPTED_BYTES" },
      TextDataAsset: {
        value: { fileChecksum: "sum", size: 123, wrappingKey: "key", downloadURL: ASSET_URL },
        type: "ASSETID",
      },
    },
  };
}

function installFetchMock(assetResponse: () => Response): {
  restore: () => void;
  desiredKeys: unknown[];
  assetDownloads: number;
} {
  const realFetch = globalThis.fetch;
  const state = { restore: () => {}, desiredKeys: [] as unknown[], assetDownloads: 0 };
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/private/changes/zone")) {
      const request = JSON.parse(String(init?.body)) as { zones: Array<{ desiredKeys: unknown[] }> };
      state.desiredKeys = request.zones[0]?.desiredKeys ?? [];
      return new Response(
        JSON.stringify({
          zones: [{ zoneID: { zoneName: "Notes" }, syncToken: "token-new", moreComing: false, records: [assetBodyRecord()] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href === ASSET_URL) {
      state.assetDownloads += 1;
      return assetResponse();
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  state.restore = () => {
    globalThis.fetch = realFetch;
  };
  return state;
}

test("fetchAllNoteRecords asks for TextDataAsset and inlines a large note's text from it", async () => {
  const bytes = noteDocumentBytes("Today\n~~~\n\n9am");
  const mock = installFetchMock(() => new Response(new Uint8Array(bytes), { status: 200 }));
  try {
    const { records, syncToken } = await fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345");

    assert.ok(mock.desiredKeys.includes("TextDataAsset"));
    assert.equal(mock.assetDownloads, 1);
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

test("fetchAllNoteRecords fails rather than passing a large note on body-less when its download fails", async () => {
  // Body-less, the note would be skipped as unsyncable while the syncToken
  // moved past it - a clean-looking sync that silently lost the note.
  const mock = installFetchMock(() => new Response("Gone", { status: 410 }));
  try {
    await assert.rejects(fetchAllNoteRecords(session, "https://ckdatabasews.example", "12345"), /HTTP 410/);
  } finally {
    mock.restore();
  }
});
