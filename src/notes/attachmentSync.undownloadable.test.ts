import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloneStateAttachmentEntry } from "./cloneState.js";
import type { EmbedSlot } from "./noteAttachments.js";

// `loggedFetch` logs every request to ~/.config/icloud-md/debug.log, with the
// path fixed when `configDir.ts` loads - point HOME at a scratch dir *before*
// the dynamic imports below so this file's mocked traffic doesn't land in the
// real log.
const scratchHome = await mkdtemp(path.join(tmpdir(), "icloud-md-test-home-"));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const { downloadAttachmentBytes, resolveNoteAttachments, undownloadableAttachmentsNotice } = await import(
  "./attachmentSync.js"
);
const { fetchAssetBytes } = await import("../cloudkit/databaseClient.js");
const { CloudKitRequestFailedError } = await import("../errors.js");

/**
 * One attachment the server won't hand over must cost that attachment, not
 * the whole run - issue #55, where a 2016 drawing whose asset is zero bytes
 * long (and whose download URL answers HTTP 400) aborted every clone of the
 * account that held it.
 */

const ATTACHMENT_ID = "ATTACHMENT-1";
const MEDIA_ID = "MEDIA-1";
const DOWNLOAD_URL = "https://cvws.icloud-content.com/B/legacy-drawing";

const auth = {
  session: {
    cookie: "cookie",
    clientId: "client-id",
    clientBuildNumber: "build",
    clientMasteringNumber: "mastering",
    capturedAt: new Date().toISOString(),
  },
  ckdatabasewsUrl: "https://ckdatabasews.example",
  dsid: "12345",
};

const slots: EmbedSlot[] = [{ kind: "attachment", ref: { attachmentIdentifier: ATTACHMENT_ID, typeUti: "public.jpeg" } }];

/** Serves the Attachment -> Media -> asset chain for one image, with the
 * asset's listed size and the download's answer chosen by the test. */
function installFetchMock(options: { size: number; download: () => Response }): {
  restore: () => void;
  downloads: () => number;
} {
  const realFetch = globalThis.fetch;
  let downloads = 0;
  const records: Record<string, unknown> = {
    [ATTACHMENT_ID]: {
      recordName: ATTACHMENT_ID,
      recordType: "Attachment",
      fields: {
        UTI: { value: "public.jpeg", type: "STRING" },
        Media: { value: { recordName: MEDIA_ID, action: "VALIDATE" }, type: "REFERENCE" },
      },
    },
    [MEDIA_ID]: {
      recordName: MEDIA_ID,
      recordType: "Media",
      fields: {
        Asset: {
          value: { fileChecksum: "new-checksum", size: options.size, downloadURL: DOWNLOAD_URL },
          type: "ASSETID",
        },
        FilenameEncrypted: { value: Buffer.from("sketch.jpg").toString("base64"), type: "ENCRYPTED_BYTES" },
      },
    },
  };
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/records/lookup")) {
      const request = JSON.parse(String(init?.body)) as { records: Array<{ recordName: string }> };
      return new Response(JSON.stringify({ records: request.records.map((entry) => records[entry.recordName]) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href === DOWNLOAD_URL) {
      downloads += 1;
      return options.download();
    }
    throw new Error(`Unexpected fetch in test: ${href}`);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    downloads: () => downloads,
  };
}

async function withVault(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "attachment-undownloadable-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function resolve(dir: string, existing: Record<string, CloneStateAttachmentEntry> = {}) {
  return resolveNoteAttachments(
    auth,
    "private",
    { zoneName: "Notes" },
    dir,
    "NOTE-1",
    "Before ￼ after",
    slots,
    existing,
    {},
    new Set<string>(),
    "Notes",
  );
}

const refused = (status: number) => () => new Response("refused", { status });

test("an asset the server lists as empty is never asked for", async () => {
  let asked = 0;
  const result = await downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL, assetSize: 0 }, async () => {
    asked += 1;
    return Buffer.from("unexpected");
  });

  assert.deepEqual(result, { refused: "the server lists it as empty" });
  assert.equal(asked, 0);
});

for (const status of [400, 404, 410]) {
  test(`a download the server refuses with HTTP ${status} is reported, not thrown`, async () => {
    const result = await downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL, assetSize: 10 }, async () => {
      throw new CloudKitRequestFailedError(`Attachment download failed: HTTP ${status}`, { status });
    });

    assert.deepEqual(result, { refused: `the server refused the download (HTTP ${status})` });
  });
}

test("a server error, a throttle or a dropped connection still fails the download", async () => {
  for (const status of [403, 429, 500, 503]) {
    const error = new CloudKitRequestFailedError(`Attachment download failed: HTTP ${status}`, { status });
    await assert.rejects(
      downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL }, async () => {
        throw error;
      }),
      (thrown: unknown) => thrown === error,
    );
  }
  const dropped = new TypeError("fetch failed");
  await assert.rejects(
    downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL }, async () => {
      throw dropped;
    }),
    (thrown: unknown) => thrown === dropped,
  );
});

test("a download that works returns its bytes, with or without a listed size", async () => {
  const fetchBytes = async (): Promise<Buffer> => Buffer.from("bytes");

  assert.deepEqual(await downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL, assetSize: 5 }, fetchBytes), {
    bytes: Buffer.from("bytes"),
  });
  assert.deepEqual(await downloadAttachmentBytes({ downloadURL: DOWNLOAD_URL }, fetchBytes), {
    bytes: Buffer.from("bytes"),
  });
});

test("fetchAssetBytes' failure carries the HTTP status the refusal check reads", async () => {
  const mock = installFetchMock({ size: 10, download: refused(400) });
  try {
    await assert.rejects(
      fetchAssetBytes(DOWNLOAD_URL),
      (error: unknown) => error instanceof CloudKitRequestFailedError && error.status === 400,
    );
  } finally {
    mock.restore();
  }
});

test("a new attachment listed as empty leaves a marker in the note and nothing on disk or in state", () =>
  withVault(async (dir) => {
    const mock = installFetchMock({ size: 0, download: refused(400) });
    try {
      const result = await resolve(dir);

      assert.equal(result.bodyText, `Before <apple-embed type="public.jpeg" id="${ATTACHMENT_ID}">public.jpeg</apple-embed> after`);
      assert.deepEqual(result.attachments, {});
      assert.deepEqual(result.undownloadable, [{ recordName: ATTACHMENT_ID, reason: "the server lists it as empty" }]);
      assert.equal(mock.downloads(), 0);
      assert.deepEqual(await readdir(dir), []);
    } finally {
      mock.restore();
    }
  }));

test("a new attachment whose download is refused leaves a marker, and the note still resolves", () =>
  withVault(async (dir) => {
    const mock = installFetchMock({ size: 2048, download: refused(400) });
    try {
      const result = await resolve(dir);

      assert.match(result.bodyText, /^Before <apple-embed [^>]*>[^<]*<\/apple-embed> after$/);
      assert.deepEqual(result.attachments, {});
      assert.deepEqual(result.undownloadable, [
        { recordName: ATTACHMENT_ID, reason: "the server refused the download (HTTP 400)" },
      ]);
      assert.equal(mock.downloads(), 1);
    } finally {
      mock.restore();
    }
  }));

test("an attachment already on disk keeps its file, link and old entry when its new version is refused", () =>
  withVault(async (dir) => {
    const previous: CloneStateAttachmentEntry = {
      file: "Notes/attachments/sketch.jpg",
      mediaRecordName: MEDIA_ID,
      mediaFileChecksum: "old-checksum",
      noteRecordName: "NOTE-1",
    };
    await mkdir(path.join(dir, "Notes/attachments"), { recursive: true });
    await writeFile(path.join(dir, previous.file), "the copy we have");
    const mock = installFetchMock({ size: 2048, download: refused(404) });
    try {
      const result = await resolve(dir, { [ATTACHMENT_ID]: previous });

      assert.equal(result.bodyText, "Before ![sketch.jpg](attachments/sketch.jpg) after");
      // The old checksum stays, so the next change to the note tries again.
      assert.deepEqual(result.attachments, { [ATTACHMENT_ID]: previous });
      assert.deepEqual(result.staleAttachmentRecordNames, []);
      assert.equal(result.undownloadable.length, 1);
      assert.equal(await readFile(path.join(dir, previous.file), "utf-8"), "the copy we have");
    } finally {
      mock.restore();
    }
  }));

test("a server error on an attachment still fails the note, as before", () =>
  withVault(async (dir) => {
    const mock = installFetchMock({ size: 2048, download: refused(500) });
    try {
      await assert.rejects(resolve(dir), /Attachment download failed: HTTP 500/);
    } finally {
      mock.restore();
    }
  }));

test("a download that works is written and tracked, with nothing reported", () =>
  withVault(async (dir) => {
    const mock = installFetchMock({ size: 5, download: () => new Response("bytes", { status: 200 }) });
    try {
      const result = await resolve(dir);

      assert.equal(result.bodyText, "Before ![sketch.jpg](attachments/sketch.jpg) after");
      assert.deepEqual(result.undownloadable, []);
      assert.equal(result.attachments[ATTACHMENT_ID]?.mediaFileChecksum, "new-checksum");
      assert.equal(await readFile(path.join(dir, "Notes/attachments/sketch.jpg"), "utf-8"), "bytes");
    } finally {
      mock.restore();
    }
  }));

test("the warning names the note, counts the attachments and gives each distinct reason once", () => {
  assert.equal(
    undownloadableAttachmentsNotice("Notes/Sketches.md", [
      { recordName: "A", reason: "the server lists it as empty" },
      { recordName: "B", reason: "the server lists it as empty" },
      { recordName: "C", reason: "the server refused the download (HTTP 400)" },
    ]),
    "Notes/Sketches.md: 3 attachment(s) couldn't be downloaded (the server lists it as empty; the server refused " +
      "the download (HTTP 400)) - the rest of the note is here, with a placeholder where each one belongs",
  );
});
