import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { extractMediaRecordNames, matchAttachmentRecords, removeAttachmentsForNote } from "./attachmentSync.js";
import type { CloneStateAttachmentEntry } from "./cloneState.js";
import type { AttachmentReference } from "./noteAttachments.js";

// Real records captured live from "Call with Janice Elkins" (audio) and
// "Test Note" (image) - see dev notes, 2026-07-13T21:54 and 2026-07-14.
const AUDIO_ATTACHMENT_RECORD: CloudKitRecord = {
  recordName: "7DAFDA6F-4AC4-41D8-9958-049373B80824",
  recordType: "Attachment",
  fields: {
    UTI: { value: "com.apple.m4a-audio", type: "STRING" },
    Media: {
      value: { recordName: "0B8509A3-A5FC-470B-A777-03BFFFDFB5F9", action: "VALIDATE" },
      type: "REFERENCE",
    },
    MergeableDataAsset: {
      value: {
        fileChecksum: "ARXoH1EL3hYxm2DAq9w4Nspo2ZYb",
        size: 225719,
        downloadURL: "https://cvws.icloud-content.com/B/audio-mergeable-data",
      },
      type: "ASSETID",
    },
  },
};
const AUDIO_MEDIA_RECORD: CloudKitRecord = {
  recordName: "0B8509A3-A5FC-470B-A777-03BFFFDFB5F9",
  recordType: "Media",
  fields: {
    Asset: {
      value: {
        fileChecksum: "AUMraefNsgNffHQpfB8oQFo5P51-",
        size: 51432744,
        downloadURL: "https://cvws.icloud-content.com/B/audio-asset",
      },
      type: "ASSETID",
    },
    FilenameEncrypted: { value: "Q2FsbCB3aXRoIEphbmljZSBFbGtpbnMubTRh", type: "ENCRYPTED_BYTES" },
  },
};

const IMAGE_ATTACHMENT_RECORD: CloudKitRecord = {
  recordName: "7ED80274-4400-4C02-87EA-F542F056FF02",
  recordType: "Attachment",
  fields: {
    UTI: { value: "public.jpeg", type: "STRING" },
    Media: {
      value: { recordName: "066C8A2E-796F-403F-AD75-A5267CBD0E18", action: "VALIDATE" },
      type: "REFERENCE",
    },
    MergeableDataAsset: { value: null, type: "ASSETID" },
    Height: { value: 3024, type: "INT64" },
    Width: { value: 4032, type: "INT64" },
  },
};
const IMAGE_MEDIA_RECORD: CloudKitRecord = {
  recordName: "066C8A2E-796F-403F-AD75-A5267CBD0E18",
  recordType: "Media",
  fields: {
    Asset: {
      value: {
        fileChecksum: "ARKf/Vy+irL9d80LorfL6M0D7FG5",
        size: 2908682,
        downloadURL: "https://cvws.icloud-content.com/B/image-asset",
      },
      type: "ASSETID",
    },
    FilenameEncrypted: { value: "XzcxMzAwOTMuanBlZw==", type: "ENCRYPTED_BYTES" },
  },
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "attachmentsync-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function entry(overrides: Partial<CloneStateAttachmentEntry> & Pick<CloneStateAttachmentEntry, "file" | "noteRecordName">): CloneStateAttachmentEntry {
  return { mediaRecordName: "MEDIA", mediaFileChecksum: "checksum", ...overrides };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("removeAttachmentsForNote deletes only the files belonging to the given note", () =>
  withTempDir(async (dir) => {
    await mkdir(path.join(dir, "attachments"), { recursive: true });
    await writeFile(path.join(dir, "attachments", "keep-mine.jpg"), "a");
    await writeFile(path.join(dir, "attachments", "keep-other.jpg"), "b");

    const attachments = {
      ATT1: entry({ file: "attachments/keep-mine.jpg", noteRecordName: "NOTE1" }),
      ATT2: entry({ file: "attachments/keep-other.jpg", noteRecordName: "NOTE2" }),
    };

    const removed = await removeAttachmentsForNote(dir, "NOTE1", attachments);

    assert.deepEqual(removed, ["ATT1"]);
    assert.equal(await exists(path.join(dir, "attachments", "keep-mine.jpg")), false);
    assert.equal(await exists(path.join(dir, "attachments", "keep-other.jpg")), true);
  }));

test("removeAttachmentsForNote tolerates a file that's already gone", () =>
  withTempDir(async (dir) => {
    const attachments = { ATT1: entry({ file: "attachments/missing.jpg", noteRecordName: "NOTE1" }) };
    const removed = await removeAttachmentsForNote(dir, "NOTE1", attachments);
    assert.deepEqual(removed, ["ATT1"]);
  }));

test("removeAttachmentsForNote returns an empty list when the note has no attachments", () =>
  withTempDir(async (dir) => {
    const removed = await removeAttachmentsForNote(dir, "NOTE1", {});
    assert.deepEqual(removed, []);
  }));

test("extractMediaRecordNames resolves the Media reference from a real Attachment record (audio)", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7DAFDA6F-4AC4-41D8-9958-049373B80824", typeUti: "com.apple.m4a-audio" },
  ];
  assert.deepEqual(extractMediaRecordNames(refs, [AUDIO_ATTACHMENT_RECORD]), [
    "0B8509A3-A5FC-470B-A777-03BFFFDFB5F9",
  ]);
});

test("extractMediaRecordNames resolves the Media reference from a real Attachment record (image)", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ];
  assert.deepEqual(extractMediaRecordNames(refs, [IMAGE_ATTACHMENT_RECORD]), [
    "066C8A2E-796F-403F-AD75-A5267CBD0E18",
  ]);
});

test("extractMediaRecordNames refuses when the identifier doesn't resolve to an Attachment record", () => {
  const refs: AttachmentReference[] = [{ attachmentIdentifier: "MISSING", typeUti: "public.jpeg" }];
  assert.equal(extractMediaRecordNames(refs, []), undefined);
  assert.equal(extractMediaRecordNames(refs, [{ ...IMAGE_ATTACHMENT_RECORD, recordName: "MISSING", recordType: "Note" }]), undefined);
});

test("matchAttachmentRecords resolves a new audio attachment's filename and download from real records", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7DAFDA6F-4AC4-41D8-9958-049373B80824", typeUti: "com.apple.m4a-audio" },
  ];
  const used = new Set<string>();
  const matched = matchAttachmentRecords(
    refs,
    ["0B8509A3-A5FC-470B-A777-03BFFFDFB5F9"],
    [AUDIO_MEDIA_RECORD],
    "NOTE1",
    {},
    used,
  );
  assert.deepEqual(matched, [
    {
      recordName: "7DAFDA6F-4AC4-41D8-9958-049373B80824",
      relativeFile: "attachments/Call with Janice Elkins.m4a",
      needsDownload: true,
      downloadURL: "https://cvws.icloud-content.com/B/audio-asset",
      entry: {
        file: "attachments/Call with Janice Elkins.m4a",
        mediaRecordName: "0B8509A3-A5FC-470B-A777-03BFFFDFB5F9",
        mediaFileChecksum: "AUMraefNsgNffHQpfB8oQFo5P51-",
        noteRecordName: "NOTE1",
      },
    },
  ]);
  assert.equal(used.has("Call with Janice Elkins.m4a"), true);
});

test("matchAttachmentRecords resolves a new image attachment's filename and download from real records", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ];
  const matched = matchAttachmentRecords(
    refs,
    ["066C8A2E-796F-403F-AD75-A5267CBD0E18"],
    [IMAGE_MEDIA_RECORD],
    "NOTE2",
    {},
    new Set(),
  );
  assert.equal(matched?.[0]?.relativeFile, "attachments/_7130093.jpeg");
  assert.equal(matched?.[0]?.needsDownload, true);
  assert.equal(matched?.[0]?.entry.mediaFileChecksum, "ARKf/Vy+irL9d80LorfL6M0D7FG5");
});

test("matchAttachmentRecords skips re-download when the tracked checksum still matches", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ];
  const existing = {
    "7ED80274-4400-4C02-87EA-F542F056FF02": {
      file: "attachments/_7130093.jpeg",
      mediaRecordName: "066C8A2E-796F-403F-AD75-A5267CBD0E18",
      mediaFileChecksum: "ARKf/Vy+irL9d80LorfL6M0D7FG5",
      noteRecordName: "NOTE2",
    },
  };
  const matched = matchAttachmentRecords(
    refs,
    ["066C8A2E-796F-403F-AD75-A5267CBD0E18"],
    [IMAGE_MEDIA_RECORD],
    "NOTE2",
    existing,
    new Set(),
  );
  assert.equal(matched?.[0]?.needsDownload, false);
  assert.equal(matched?.[0]?.relativeFile, "attachments/_7130093.jpeg");
});

test("matchAttachmentRecords re-downloads when the tracked checksum has changed", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ];
  const existing = {
    "7ED80274-4400-4C02-87EA-F542F056FF02": {
      file: "attachments/_7130093.jpeg",
      mediaRecordName: "066C8A2E-796F-403F-AD75-A5267CBD0E18",
      mediaFileChecksum: "stale-checksum",
      noteRecordName: "NOTE2",
    },
  };
  const matched = matchAttachmentRecords(
    refs,
    ["066C8A2E-796F-403F-AD75-A5267CBD0E18"],
    [IMAGE_MEDIA_RECORD],
    "NOTE2",
    existing,
    new Set(),
  );
  assert.equal(matched?.[0]?.needsDownload, true);
  // Same tracked file name is kept, even though it's re-downloaded.
  assert.equal(matched?.[0]?.relativeFile, "attachments/_7130093.jpeg");
});

test("matchAttachmentRecords refuses when the Media record has no well-formed Asset field", () => {
  const refs: AttachmentReference[] = [{ attachmentIdentifier: "A", typeUti: "public.jpeg" }];
  const brokenMedia: CloudKitRecord = { recordName: "M1", recordType: "Media", fields: {} };
  assert.equal(matchAttachmentRecords(refs, ["M1"], [brokenMedia], "NOTE1", {}, new Set()), undefined);
});

test("matchAttachmentRecords disambiguates a filename collision the same way notes do", () => {
  const refs: AttachmentReference[] = [
    { attachmentIdentifier: "7ED80274-4400-4C02-87EA-F542F056FF02", typeUti: "public.jpeg" },
  ];
  const used = new Set(["_7130093.jpeg"]);
  const matched = matchAttachmentRecords(
    refs,
    ["066C8A2E-796F-403F-AD75-A5267CBD0E18"],
    [IMAGE_MEDIA_RECORD],
    "NOTE2",
    {},
    used,
  );
  assert.equal(matched?.[0]?.relativeFile, "attachments/_7130093 2.jpeg");
});
