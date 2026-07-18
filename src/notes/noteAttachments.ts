import path from "node:path";
import { fromBinary, isFieldSet } from "@bufbuild/protobuf";
import type { CloudKitFieldValue } from "../cloudkit/databaseClient.js";
import { decompressNoteDocument } from "./noteText.js";
import { AttachmentInfoSchema, StringSchema } from "./gen/topotext_pb.js";
import { parseVersionedDocument } from "./versionedDocument.js";

const ATTACHMENT_IDENTIFIER_FIELD = AttachmentInfoSchema.fields.find((f) => f.localName === "attachmentIdentifier")!;
const TYPE_UTI_FIELD = AttachmentInfoSchema.fields.find((f) => f.localName === "typeUTI")!;

/** One embedded attachment reference found in a note's body, in document order. */
export interface AttachmentReference {
  /** UUID that is *also* the CloudKit recordName of a separate `Attachment` record. */
  attachmentIdentifier: string;
  /** Uniform Type Identifier, e.g. "public.jpeg", "com.apple.m4a-audio". */
  typeUti: string;
}

/**
 * Extracts, in document order, every embedded attachment reference from a
 * note's protobuf body: `topotext.String.attributeRun[].attachmentInfo`,
 * when present. Each occurrence corresponds 1:1, in the same order, with one
 * U+FFFC placeholder character in the plain visible text - both walk the
 * same document left-to-right. Verified against real captured audio- and
 * image-attachment notes (dev notes, 2026-07-13/14).
 */
export function decodeNoteAttachmentRefs(compressedProtobuf: Buffer): AttachmentReference[] {
  const raw = decompressNoteDocument(compressedProtobuf);
  const { data } = parseVersionedDocument(raw);
  const str = fromBinary(StringSchema, data);

  const refs: AttachmentReference[] = [];
  for (const run of str.attributeRun) {
    const info = run.attachmentInfo;
    if (!info || !isFieldSet(info, ATTACHMENT_IDENTIFIER_FIELD) || !isFieldSet(info, TYPE_UTI_FIELD)) {
      continue;
    }
    refs.push({ attachmentIdentifier: info.attachmentIdentifier, typeUti: info.typeUTI });
  }
  return refs;
}

/**
 * One U+FFFC placeholder's worth of embed, localized by character offset
 * rather than count-correlation (the Step 1 fix from the formatting plan,
 * 2026-07-17): an `attachment` slot has a fully-identified reference; an
 * `unknown` slot is a placeholder whose `attachmentInfo` run was absent or
 * incomplete (its `typeUti` is carried when at least that much was present).
 */
export type EmbedSlot =
  | { kind: "attachment"; ref: AttachmentReference }
  | { kind: "unknown"; typeUti?: string | undefined };

/**
 * Maps every U+FFFC placeholder in a note's body to an `EmbedSlot`, in
 * document order, by computing each `attachmentInfo` run's character offset
 * from the attribute-run lengths - no count-correlation assumption.
 *
 * Returns `undefined` when the embed structure defies the model this was
 * verified against - an `attachmentInfo` run that isn't exactly one
 * character long sitting on a U+FFFC, or an attribute-run table that doesn't
 * cover the text. Those notes get the whole-note banner and stay read-only
 * (see `classifyNoteRecord`).
 */
export function decodeNoteEmbedSlots(compressedProtobuf: Buffer): EmbedSlot[] | undefined {
  const raw = decompressNoteDocument(compressedProtobuf);
  const { data } = parseVersionedDocument(raw);
  const str = fromBinary(StringSchema, data);
  const text = str.string;

  const infoByOffset = new Map<number, NonNullable<(typeof str.attributeRun)[number]["attachmentInfo"]>>();
  let offset = 0;
  for (const run of str.attributeRun) {
    if (run.attachmentInfo !== undefined) {
      if (run.length !== 1 || text[offset] !== OBJECT_REPLACEMENT_CHARACTER) {
        return undefined;
      }
      infoByOffset.set(offset, run.attachmentInfo);
    }
    offset += run.length;
  }
  if (offset > text.length) {
    // Run lengths overshoot the text, so every offset above is suspect. (An
    // *under*-covering run table is tolerated - trailing characters simply
    // carry no formatting, and a placeholder there is an unknown slot.)
    return undefined;
  }

  const slots: EmbedSlot[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== OBJECT_REPLACEMENT_CHARACTER) {
      continue;
    }
    const info = infoByOffset.get(i);
    if (info !== undefined && isFieldSet(info, ATTACHMENT_IDENTIFIER_FIELD) && isFieldSet(info, TYPE_UTI_FIELD)) {
      slots.push({ kind: "attachment", ref: { attachmentIdentifier: info.attachmentIdentifier, typeUti: info.typeUTI } });
    } else {
      slots.push({
        kind: "unknown",
        typeUti: info !== undefined && isFieldSet(info, TYPE_UTI_FIELD) ? info.typeUTI : undefined,
      });
    }
  }
  return slots;
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

/** A table is embedded the same way a file attachment is (an `Attachment`
 * record referenced via a field-12 `AttachmentInfo` run), but this UTI
 * marks it as a self-contained mergeable sub-document instead of a file -
 * see `decodeTableRecord.ts`. */
export const TABLE_UTI = "com.apple.notes.table";

export function isTableUti(typeUti: string): boolean {
  return typeUti === TABLE_UTI;
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

/** The markdown embed (images) or link (everything else) for one resolved
 * file attachment, pointing at its downloaded file under `attachments/`. */
export function formatAttachmentMarkdown(ref: AttachmentReference, relativeFile: string): string {
  const displayName = path.basename(relativeFile);
  const href = relativeFile
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return isImageUti(ref.typeUti) ? `![${displayName}](${href})` : `[${displayName}](${href})`;
}

/**
 * Replaces each U+FFFC placeholder in `bodyText`, in order, with the
 * corresponding entry of `replacements` - one per placeholder, same document
 * order. Used directly by callers that mix attachment kinds (e.g. a table
 * alongside a file attachment) and need a different replacement string per
 * placeholder; `renderAttachmentPlaceholders` below is the file-only
 * convenience wrapper most callers want.
 */
export function renderPlaceholders(bodyText: string, replacements: readonly (string | undefined)[]): string {
  if (replacements.length === 0) {
    return bodyText;
  }
  let index = 0;
  return bodyText.replaceAll(OBJECT_REPLACEMENT_CHARACTER, () => {
    const replacement = replacements[index];
    index += 1;
    // Shouldn't happen given callers verify counts match; leave unresolved
    // placeholders untouched rather than fabricate a link.
    return replacement ?? OBJECT_REPLACEMENT_CHARACTER;
  });
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
  return renderPlaceholders(
    bodyText,
    refs.map((ref, i) => {
      const relativeFile = relativeFiles[i];
      return relativeFile === undefined ? undefined : formatAttachmentMarkdown(ref, relativeFile);
    }),
  );
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
