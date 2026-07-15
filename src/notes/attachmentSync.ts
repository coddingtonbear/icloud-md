import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fetchAssetBytes,
  lookupRecords,
  type CloudKitDatabase,
  type CloudKitRecord,
  type CloudKitZoneID,
} from "../cloudkit/databaseClient.js";
import { isEnoent } from "../fsUtil.js";
import type { IcloudSession } from "../session.js";
import type { CloneStateAttachmentEntry } from "./cloneState.js";
import { decodeTableMarkdown } from "./decodeTableRecord.js";
import { uniqueFileName } from "./filename.js";
import {
  decodeAttachmentFilename,
  formatAttachmentMarkdown,
  isTableUti,
  parseAssetField,
  renderPlaceholders,
  type AttachmentReference,
} from "./noteAttachments.js";
import { formatUnknownEmbedMarker } from "./unknownContent.js";

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
 * to look up - in the same order as `refs`. An entry is `undefined` where a
 * reference doesn't resolve to a real `Attachment` record with a `Media`
 * reference; per the Safety Guarantee Audit, that degrades just that one
 * embed (an unknown-content marker) rather than refusing the whole note.
 */
export function extractMediaRecordNames(
  refs: readonly AttachmentReference[],
  attachmentRecords: readonly CloudKitRecord[],
): (string | undefined)[] {
  const attachmentByName = new Map(attachmentRecords.map((record) => [record.recordName, record]));

  return refs.map((ref) => {
    const attachmentRecord = attachmentByName.get(ref.attachmentIdentifier);
    if (!attachmentRecord || attachmentRecord.recordType !== "Attachment") {
      return undefined;
    }
    const mediaRef = attachmentRecord.fields.Media?.value;
    return isRecordRef(mediaRef) ? mediaRef.recordName : undefined;
  });
}

/**
 * Matches each attachment reference to its `Media` record (already fetched,
 * one per ref, same order as `mediaRecordNames` from
 * `extractMediaRecordNames`) and decides a local file name and whether it
 * needs (re)downloading. An entry is `undefined` where the `Media` record is
 * missing, isn't actually a `Media` record, or lacks a well-formed `Asset`
 * field; per the Safety Guarantee Audit, that degrades just that one embed
 * rather than refusing the whole note.
 */
export function matchAttachmentRecords(
  refs: readonly AttachmentReference[],
  mediaRecordNames: readonly (string | undefined)[],
  mediaRecords: readonly CloudKitRecord[],
  noteRecordName: string,
  existingAttachments: Record<string, CloneStateAttachmentEntry>,
  usedAttachmentFileNames: Set<string>,
): (MatchedAttachment | undefined)[] {
  const mediaByName = new Map(mediaRecords.map((record) => [record.recordName, record]));
  const matched: (MatchedAttachment | undefined)[] = [];

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const mediaRecordName = mediaRecordNames[i];
    if (!ref || !mediaRecordName) {
      matched.push(undefined);
      continue;
    }
    const mediaRecord = mediaByName.get(mediaRecordName);
    if (!mediaRecord || mediaRecord.recordType !== "Media") {
      matched.push(undefined);
      continue;
    }
    const asset = parseAssetField(mediaRecord.fields.Asset);
    if (!asset) {
      matched.push(undefined);
      continue;
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
  /** Set when one or more references didn't resolve to what we've verified
   * live (a table/file shape we couldn't parse) - those got an inline
   * unknown-content marker instead. Per the Safety Guarantee Audit, this
   * note must never be pushed; the caller should record this on the note's
   * state entry. `undefined` when every reference resolved normally. */
  unpublishableReason?: string | undefined;
}

/**
 * Resolves every embedded reference a note contains - downloading file
 * attachments into `attachments/` and rendering a table's structure as a
 * markdown table inline - and rewrites the note's placeholders accordingly.
 *
 * A `com.apple.notes.table` reference is an `Attachment` record like any
 * other, but its payload lives directly on that record's own
 * `MergeableDataEncrypted` field rather than chaining through `Media` -
 * see `decodeTableRecord.ts` and dev notes, 2026-07-14T10:10/14:46.
 *
 * Per the Safety Guarantee Audit, a reference that doesn't match what we've
 * verified live - a file reference whose `Attachment`/`Media`/`Asset` chain
 * doesn't resolve, or a table whose `MergeableDataEncrypted` doesn't decode -
 * no longer refuses the whole note. Instead that one placeholder gets an
 * inline "unparsed content" admonition and `unpublishableReason` is set, so
 * the rest of the note (and any other, resolvable references) still comes
 * through. The actual matching (`extractMediaRecordNames`/
 * `matchAttachmentRecords`, `decodeTableMarkdown`) is pure and unit-tested
 * against real captures; this function is the thin network+fs wrapper
 * around it, verified live instead.
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
): Promise<AttachmentSyncResult> {
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
  const attachmentByName = new Map(attachmentRecords.map((record) => [record.recordName, record]));

  // One entry per ref, same document order as the U+FFFC placeholders;
  // filled in below as each ref (table or file) resolves.
  const replacements: (string | undefined)[] = new Array(refs.length).fill(undefined);
  const fileRefs: AttachmentReference[] = [];
  const fileRefIndexes: number[] = [];
  const unresolvedTypeUtis: string[] = [];

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    if (!ref) {
      continue;
    }
    if (isTableUti(ref.typeUti)) {
      const markdown = decodeTableAttachment(attachmentByName.get(ref.attachmentIdentifier));
      if (markdown === undefined) {
        replacements[i] = formatUnknownEmbedMarker(ref.typeUti);
        unresolvedTypeUtis.push(ref.typeUti);
      } else {
        replacements[i] = markdown;
      }
    } else {
      fileRefIndexes.push(i);
      fileRefs.push(ref);
    }
  }

  const attachments: Record<string, CloneStateAttachmentEntry> = {};
  if (fileRefs.length > 0) {
    const mediaRecordNames = extractMediaRecordNames(fileRefs, attachmentRecords);
    const knownMediaRecordNames = mediaRecordNames.filter((name): name is string => name !== undefined);

    const mediaRecords = await lookupRecords(
      auth.session,
      auth.ckdatabasewsUrl,
      auth.dsid,
      database,
      zoneID,
      knownMediaRecordNames,
    );
    const matched = matchAttachmentRecords(
      fileRefs,
      mediaRecordNames,
      mediaRecords,
      noteRecordName,
      existingAttachments,
      usedAttachmentFileNames,
    );

    for (let j = 0; j < fileRefs.length; j += 1) {
      const attachment = matched[j];
      const ref = fileRefs[j];
      const index = fileRefIndexes[j];
      if (!ref || index === undefined) {
        continue;
      }
      if (!attachment) {
        replacements[index] = formatUnknownEmbedMarker(ref.typeUti);
        unresolvedTypeUtis.push(ref.typeUti);
        continue;
      }
      if (attachment.needsDownload) {
        const bytes = await fetchAssetBytes(attachment.downloadURL);
        await mkdir(path.join(targetDir, ATTACHMENTS_DIR), { recursive: true });
        await writeFile(path.join(targetDir, attachment.relativeFile), bytes);
      }
      attachments[attachment.recordName] = attachment.entry;
      replacements[index] = formatAttachmentMarkdown(ref, attachment.relativeFile);
    }
  }

  const staleAttachmentRecordNames = previousForNote.filter((recordName) => !(recordName in attachments));
  const unpublishableReason =
    unresolvedTypeUtis.length > 0
      ? `contains embedded content this tool can't parse (${[...new Set(unresolvedTypeUtis)].join(", ")})`
      : undefined;

  return {
    bodyText: renderPlaceholders(bodyText, replacements),
    attachments,
    staleAttachmentRecordNames,
    unpublishableReason,
  };
}

/** Decodes a table reference's `MergeableDataEncrypted` payload into
 * markdown, or `undefined` if the record doesn't match what's been
 * verified live (missing/malformed, or a table shape this decoder refuses -
 * e.g. right-to-left column direction). The caller (`resolveNoteAttachments`)
 * turns `undefined` into an inline unknown-content marker for just this one
 * reference rather than guessing at its structure. */
export function decodeTableAttachment(attachmentRecord: CloudKitRecord | undefined): string | undefined {
  if (!attachmentRecord || attachmentRecord.recordType !== "Attachment") {
    return undefined;
  }
  const mergeableField = attachmentRecord.fields.MergeableDataEncrypted;
  if (!mergeableField || typeof mergeableField.value !== "string") {
    return undefined;
  }
  try {
    return decodeTableMarkdown(Buffer.from(mergeableField.value, "base64"));
  } catch {
    return undefined;
  }
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

function isRecordRef(value: unknown): value is { recordName: string } {
  return typeof value === "object" && value !== null && typeof (value as { recordName?: unknown }).recordName === "string";
}
