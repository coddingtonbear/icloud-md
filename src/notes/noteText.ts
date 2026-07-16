import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { fromBinary } from "@bufbuild/protobuf";
import { NoteStoreProtoSchema } from "./gen/notestore_pb.js";

/**
 * Decodes the plain-text body of a note from its TextDataEncrypted field, as
 * returned by the read-side CloudKit APIs (records/query, records/lookup,
 * changes/zone). Despite the field name, this isn't client-side encrypted on
 * accounts without Advanced Data Protection - see README/dev notes. The bytes
 * are compressed protobuf in the same "NoteStoreProto" shape used on-device
 * in NoteStore.sqlite.
 *
 * The compression container isn't determined by which endpoint served the
 * record - it's whatever format the data happened to be stored in, which
 * depends on whichever client last wrote it (observed both gzip, magic
 * `1f 8b`, and zlib, magic `78 9c`, coming back from the exact same
 * `changes/zone` endpoint for different records). Both are tried.
 *
 * This only extracts the plain note_text string (title + body, no
 * formatting) via `NoteStoreProto.document.note.note_text`, verified against
 * real captured notes (see `proto/notestore.proto`). Attribute runs
 * (formatting, checklists, links, attachments) are intentionally not parsed
 * yet - out of scope until round-trip write support needs them.
 */
export function decodeNoteBodyText(compressedProtobuf: Buffer): string {
  const raw = decompressNoteDocument(compressedProtobuf);
  const message = fromBinary(NoteStoreProtoSchema, raw);

  if (!message.document) {
    throw new Error("Note protobuf missing Document field (root field 2)");
  }
  if (!message.document.note) {
    throw new Error("Note protobuf missing Note field (Document field 3)");
  }
  return message.document.note.noteText;
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
