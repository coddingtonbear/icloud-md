import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fetchAssetBytes,
  lookupRecords,
  type CloudKitDatabase,
  type CloudKitRecord,
  type CloudKitZoneID,
} from "../cloudkit/databaseClient.js";
import type { IcloudSession } from "../session.js";
import type { CloneStateAttachmentEntry } from "./cloneState.js";
import { uniqueFileName } from "./filename.js";
import {
  decodeAttachmentFilename,
  parseAssetField,
  renderAttachmentPlaceholders,
  type AttachmentReference,
} from "./noteAttachments.js";

export interface AttachmentAuth {
  session: IcloudSession;
  ckdatabasewsUrl: string;
  dsid: string;
}

const ATTACHMENTS_DIR = "attachments";

/** One attachment resolved to a concrete local file, ready to be written
 * (if `needsDownload`) and tracked. Pure data - no I/O has happened yet. */
export interface MatchedAttachment {
  /** The Attachment record's recordName - state.attachments' key. */
  recordName: string;
  relativeFile: string;
  needsDownload: boolean;
  downloadURL: string;
  entry: CloneStateAttachmentEntry;
}

/**
 * Given a note's attachment references and the already-fetched `Attachment`
 * records they name, returns each one's `Media` recordName - the next hop
 * to look up - or `undefined` if any reference doesn't resolve to a real
 * `Attachment` record with a `Media` reference (refusing the whole note,
 * same as any other "structure we don't understand" case).
 */
export function extractMediaRecordNames(
  refs: readonly AttachmentReference[],
  attachmentRecords: readonly CloudKitRecord[],
): string[] | undefined {
  const attachmentByName = new Map(attachmentRecords.map((record) => [record.recordName, record]));
  const mediaRecordNames: string[] = [];

  for (const ref of refs) {
    const attachmentRecord = attachmentByName.get(ref.attachmentIdentifier);
    if (!attachmentRecord || attachmentRecord.recordType !== "Attachment") {
      return undefined;
    }
    const mediaRef = attachmentRecord.fields.Media?.value;
    const mediaRecordName = isRecordRef(mediaRef) ? mediaRef.recordName : undefined;
    if (!mediaRecordName) {
      return undefined;
    }
    mediaRecordNames.push(mediaRecordName);
  }

  return mediaRecordNames;
}

/**
 * Matches each attachment reference to its `Media` record (already fetched,
 * one per ref, same order as `mediaRecordNames` from
 * `extractMediaRecordNames`) and decides a local file name and whether it
 * needs (re)downloading. Returns `undefined` if any `Media` record is
 * missing, isn't actually a `Media` record, or lacks a well-formed `Asset`
 * field - refusing the whole note.
 */
export function matchAttachmentRecords(
  refs: readonly AttachmentReference[],
  mediaRecordNames: readonly string[],
  mediaRecords: readonly CloudKitRecord[],
  noteRecordName: string,
  existingAttachments: Record<string, CloneStateAttachmentEntry>,
  usedAttachmentFileNames: Set<string>,
): MatchedAttachment[] | undefined {
  const mediaByName = new Map(mediaRecords.map((record) => [record.recordName, record]));
  const matched: MatchedAttachment[] = [];

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const mediaRecordName = mediaRecordNames[i];
    if (!ref || !mediaRecordName) {
      return undefined;
    }
    const mediaRecord = mediaByName.get(mediaRecordName);
    if (!mediaRecord || mediaRecord.recordType !== "Media") {
      return undefined;
    }
    const asset = parseAssetField(mediaRecord.fields.Asset);
    if (!asset) {
      return undefined;
    }

    const existing = existingAttachments[ref.attachmentIdentifier];
    const fileName = existing
      ? path.basename(existing.file)
      : uniqueFileName(
          decodeAttachmentFilename(mediaRecord.fields.FilenameEncrypted, ref.attachmentIdentifier, ref.typeUti),
          usedAttachmentFileNames,
        );
    usedAttachmentFileNames.add(fileName);
    const relativeFile = path.posix.join(ATTACHMENTS_DIR, fileName);

    matched.push({
      recordName: ref.attachmentIdentifier,
      relativeFile,
      needsDownload: !existing || existing.mediaFileChecksum !== asset.fileChecksum,
      downloadURL: asset.downloadURL,
      entry: { file: relativeFile, mediaRecordName, mediaFileChecksum: asset.fileChecksum, noteRecordName },
    });
  }

  return matched;
}

export interface AttachmentSyncResult {
  /** `bodyText` with each U+FFFC placeholder replaced by a markdown embed/link. */
  bodyText: string;
  /** This note's current attachments, keyed by Attachment recordName - merge into state.attachments. */
  attachments: Record<string, CloneStateAttachmentEntry>;
  /** Previously-tracked attachment recordNames for this note that are no
   * longer referenced (the note was edited to remove one) - the caller
   * should delete their files and drop these keys from state.attachments. */
  staleAttachmentRecordNames: string[];
}

/**
 * Resolves and downloads every attachment a note references, writing new or
 * changed files under `attachments/` and rendering the note's placeholders
 * into markdown pointing at them.
 *
 * Returns `undefined` - refusing the whole note, same as any other
 * "structure we don't understand" case - if any hop doesn't match what
 * we've verified live: the embedded identifier must resolve to a record of
 * type `Attachment`, its `Media` reference must resolve to a record of type
 * `Media`, and that record needs a well-formed `Asset` field. See dev
 * notes, 2026-07-13/14, for how this chain was mapped. The actual matching
 * (`extractMediaRecordNames`/`matchAttachmentRecords`) is pure and unit-
 * tested against real captures; this function is the thin network+fs
 * wrapper around it, verified live instead.
 */
export async function resolveNoteAttachments(
  auth: AttachmentAuth,
  database: CloudKitDatabase,
  zoneID: CloudKitZoneID,
  targetDir: string,
  noteRecordName: string,
  bodyText: string,
  refs: readonly AttachmentReference[],
  existingAttachments: Record<string, CloneStateAttachmentEntry>,
  usedAttachmentFileNames: Set<string>,
): Promise<AttachmentSyncResult | undefined> {
  const previousForNote = Object.keys(existingAttachments).filter(
    (recordName) => existingAttachments[recordName]?.noteRecordName === noteRecordName,
  );

  if (refs.length === 0) {
    return { bodyText, attachments: {}, staleAttachmentRecordNames: previousForNote };
  }

  const attachmentRecords = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    database,
    zoneID,
    refs.map((ref) => ref.attachmentIdentifier),
  );
  const mediaRecordNames = extractMediaRecordNames(refs, attachmentRecords);
  if (!mediaRecordNames) {
    return undefined;
  }

  const mediaRecords = await lookupRecords(
    auth.session,
    auth.ckdatabasewsUrl,
    auth.dsid,
    database,
    zoneID,
    mediaRecordNames,
  );
  const matched = matchAttachmentRecords(
    refs,
    mediaRecordNames,
    mediaRecords,
    noteRecordName,
    existingAttachments,
    usedAttachmentFileNames,
  );
  if (!matched) {
    return undefined;
  }

  const attachments: Record<string, CloneStateAttachmentEntry> = {};
  for (const attachment of matched) {
    if (attachment.needsDownload) {
      const bytes = await fetchAssetBytes(attachment.downloadURL);
      await mkdir(path.join(targetDir, ATTACHMENTS_DIR), { recursive: true });
      await writeFile(path.join(targetDir, attachment.relativeFile), bytes);
    }
    attachments[attachment.recordName] = attachment.entry;
  }

  const staleAttachmentRecordNames = previousForNote.filter((recordName) => !(recordName in attachments));
  const relativeFiles = matched.map((attachment) => attachment.relativeFile);

  return {
    bodyText: renderAttachmentPlaceholders(bodyText, refs, relativeFiles),
    attachments,
    staleAttachmentRecordNames,
  };
}

/** Deletes every attachment file tracked for a note (it was deleted, or
 * dropped from tracking entirely) and returns the recordNames removed, so
 * the caller can drop them from `state.attachments`. */
export async function removeAttachmentsForNote(
  targetDir: string,
  noteRecordName: string,
  attachments: Record<string, CloneStateAttachmentEntry>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const [recordName, entry] of Object.entries(attachments)) {
    if (entry.noteRecordName !== noteRecordName) {
      continue;
    }
    await safeUnlink(path.join(targetDir, entry.file));
    removed.push(recordName);
  }
  return removed;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await rm(filePath);
  } catch (cause) {
    if (!isEnoent(cause)) {
      throw cause;
    }
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecordRef(value: unknown): value is { recordName: string } {
  return typeof value === "object" && value !== null && typeof (value as { recordName?: unknown }).recordName === "string";
}
