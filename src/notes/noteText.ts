import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { fromBinary } from "@bufbuild/protobuf";
import { StringSchema } from "./gen/topotext_pb.js";
import { parseVersionedDocument } from "./versionedDocument.js";

/**
 * Decodes the plain-text body of a note from its TextDataEncrypted field, as
 * returned by the read-side CloudKit APIs (records/query, records/lookup,
 * changes/zone). Despite the field name, this isn't client-side encrypted on
 * accounts without Advanced Data Protection - see README/dev notes. The bytes
 * are compressed protobuf in the same `versioned_document.Document` shape
 * used on-device in NoteStore.sqlite.
 *
 * The compression container isn't determined by which endpoint served the
 * record - it's whatever format the data happened to be stored in, which
 * depends on whichever client last wrote it (observed both gzip, magic
 * `1f 8b`, and zlib, magic `78 9c`, coming back from the exact same
 * `changes/zone` endpoint for different records). Both are tried.
 *
 * This only extracts the plain visible-text string (title + body, no
 * formatting) via `versioned_document.Version.data` -> `topotext.String
 * .string`, verified against real captured notes (see `proto/topotext.proto`).
 * Attribute runs (formatting, checklists, links, attachments) are
 * intentionally not parsed yet - out of scope until round-trip write support
 * needs them.
 */
export function decodeNoteBodyText(compressedProtobuf: Buffer): string {
  const raw = decompressNoteDocument(compressedProtobuf);
  const { data } = parseVersionedDocument(raw);
  return fromBinary(StringSchema, data).string;
}

export function decompressNoteDocument(buf: Buffer): Buffer {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip) {
    return gunzipSync(buf);
  }
  return inflateSync(buf);
}

/**
 * Compresses a rebuilt document for upload. The write path uses a zlib
 * container specifically: every `records/modify` body in the captured web
 * client traffic is zlib (magic `78 9c`), never gzip, so we match that.
 */
export function compressNoteDocument(raw: Uint8Array): Buffer {
  return deflateSync(raw);
}
