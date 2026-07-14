import path from "node:path";
import type { CloudKitFieldValue } from "../cloudkit/databaseClient.js";
import { decompressNoteDocument } from "./noteText.js";
import { getLastBytesField, readProtoFields } from "./protobuf.js";

/** One embedded attachment reference found in a note's body, in document order. */
export interface AttachmentReference {
  /** UUID that is *also* the CloudKit recordName of a separate `Attachment` record. */
  attachmentIdentifier: string;
  /** Uniform Type Identifier, e.g. "public.jpeg", "com.apple.m4a-audio". */
  typeUti: string;
}

/**
 * Extracts, in document order, every embedded attachment reference from a
 * note's protobuf body: root -> Document (field 2) -> Note (field 3) ->
 * AttributeRun (field 5, repeated) -> AttachmentInfo (field 12), when
 * present. Each occurrence corresponds 1:1, in the same order, with one
 * U+FFFC placeholder character in the plain note_text (Note field 2) - both
 * walk the same document left-to-right. Verified against real captured
 * audio- and image-attachment notes (dev notes, 2026-07-13/14).
 */
export function decodeNoteAttachmentRefs(compressedProtobuf: Buffer): AttachmentReference[] {
  const raw = decompressNoteDocument(compressedProtobuf);
  const root = readProtoFields(raw);

  const documentBytes = getLastBytesField(root, 2);
  if (!documentBytes) {
    return [];
  }
  const document = readProtoFields(documentBytes);

  const noteBytes = getLastBytesField(document, 3);
  if (!noteBytes) {
    return [];
  }
  const note = readProtoFields(noteBytes);

  const attributeRuns = note.get(5) ?? [];
  const refs: AttachmentReference[] = [];

  for (const run of attributeRuns) {
    if (run.wireType !== 2) {
      continue;
    }
    const runFields = readProtoFields(run.bytes);
    const infoBytes = getLastBytesField(runFields, 12);
    if (!infoBytes) {
      continue;
    }
    const info = readProtoFields(infoBytes);
    const identifierBytes = getLastBytesField(info, 1);
    const typeUtiBytes = getLastBytesField(info, 2);
    if (!identifierBytes || !typeUtiBytes) {
      continue;
    }
    refs.push({
      attachmentIdentifier: new TextDecoder("utf-8").decode(identifierBytes),
      typeUti: new TextDecoder("utf-8").decode(typeUtiBytes),
    });
  }

  return refs;
}

/** Apple's plain-text placeholder for any embedded object (attachment,
 * table, drawing, ...) that doesn't have its own literal text representation. */
export const OBJECT_REPLACEMENT_CHARACTER = "\uFFFC";

/** UTIs known to render as an image in the Notes web client; anything else
 * gets a plain link rather than an embed. Not exhaustive - deliberately
 * conservative (a wrongly-linked image is cosmetic, not unsafe). */
const IMAGE_UTIS = new Set(["public.jpeg", "public.png", "public.heic", "public.tiff", "public.gif", "public.webp"]);

export function isImageUti(typeUti: string): boolean {
  return IMAGE_UTIS.has(typeUti);
}

/** Matches a markdown link/embed pointing at `attachments/...`, i.e. the
 * exact shape `renderAttachmentPlaceholders` produces. Used by `push` to
 * catch a hand-typed reference to a file that was never actually uploaded -
 * this tool has no way to turn that into a real attachment, so pushing it
 * as literal text would silently "succeed" while doing something other than
 * what it looks like. */
const ATTACHMENT_REFERENCE_PATTERN = /!?\[[^\]]*\]\(attachments\/[^)]+\)/;

export function hasAttachmentReference(text: string): boolean {
  return ATTACHMENT_REFERENCE_PATTERN.test(text);
}

/**
 * Replaces each U+FFFC placeholder in `bodyText`, in order, with a markdown
 * embed (images) or link (everything else) pointing at the corresponding
 * downloaded file under `attachments/`. `refs` and `relativeFiles` must be
 * the same length and in the same document order as the placeholders -
 * callers are expected to have already verified the counts match
 * (see classifyNoteRecord) before calling this.
 */
export function renderAttachmentPlaceholders(
  bodyText: string,
  refs: readonly AttachmentReference[],
  relativeFiles: readonly string[],
): string {
  if (refs.length !== relativeFiles.length) {
    throw new Error(`attachment ref count (${refs.length}) doesn't match resolved file count (${relativeFiles.length})`);
  }
  if (refs.length === 0) {
    return bodyText;
  }

  let index = 0;
  return bodyText.replaceAll(OBJECT_REPLACEMENT_CHARACTER, () => {
    const ref = refs[index];
    const relativeFile = relativeFiles[index];
    index += 1;
    if (!ref || !relativeFile) {
      // Shouldn't happen given the length check above; leave unresolved
      // placeholders untouched rather than fabricate a link.
      return OBJECT_REPLACEMENT_CHARACTER;
    }
    const displayName = path.basename(relativeFile);
    const href = relativeFile
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return isImageUti(ref.typeUti) ? `![${displayName}](${href})` : `[${displayName}](${href})`;
  });
}

/** Decodes a Media record's FilenameEncrypted field, falling back to a
 * synthesized name (recordName + a guessed extension) when it's absent -
 * seen as always-present in captures so far, but the field is optional in
 * the schema and nothing guarantees it stays populated. */
export function decodeAttachmentFilename(field: CloudKitFieldValue | undefined, recordName: string, typeUti: string): string {
  if (field && typeof field.value === "string") {
    try {
      const name = Buffer.from(field.value, "base64").toString("utf-8");
      if (name.length > 0) {
        return name;
      }
    } catch {
      // fall through to the synthesized name
    }
  }
  return `${recordName}${extensionForUti(typeUti)}`;
}

const UTI_EXTENSIONS: Record<string, string> = {
  "public.jpeg": ".jpeg",
  "public.png": ".png",
  "public.heic": ".heic",
  "public.tiff": ".tiff",
  "public.gif": ".gif",
  "public.webp": ".webp",
  "com.apple.m4a-audio": ".m4a",
  "com.adobe.pdf": ".pdf",
};

function extensionForUti(typeUti: string): string {
  return UTI_EXTENSIONS[typeUti] ?? "";
}

export interface AttachmentAsset {
  downloadURL: string;
  fileChecksum: string;
}

/** Extracts the download URL + checksum out of an ASSETID-typed field
 * (e.g. a Media record's `Asset`, or an Attachment record's
 * `MergeableDataAsset`). */
export function parseAssetField(field: CloudKitFieldValue | undefined): AttachmentAsset | undefined {
  if (!field || field.type !== "ASSETID" || typeof field.value !== "object" || field.value === null) {
    return undefined;
  }
  const value = field.value as Record<string, unknown>;
  if (typeof value.downloadURL !== "string" || typeof value.fileChecksum !== "string") {
    return undefined;
  }
  return { downloadURL: value.downloadURL, fileChecksum: value.fileChecksum };
}
