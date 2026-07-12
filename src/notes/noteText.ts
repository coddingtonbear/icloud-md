import { gunzipSync, inflateSync } from "node:zlib";
import { getLastBytesField, readProtoFields } from "./protobuf.js";

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
 * formatting) via root -> field 2 (Document) -> field 3 (Note) -> field 2
 * (note_text), verified against real captured notes. Attribute runs
 * (formatting, checklists, links, attachments) are intentionally not parsed
 * yet - out of scope until round-trip write support needs them.
 */
export function decodeNoteBodyText(compressedProtobuf: Buffer): string {
  const raw = decompress(compressedProtobuf);
  const root = readProtoFields(raw);

  const documentBytes = getLastBytesField(root, 2);
  if (!documentBytes) {
    throw new Error("Note protobuf missing Document field (root field 2)");
  }
  const document = readProtoFields(documentBytes);

  const noteBytes = getLastBytesField(document, 3);
  if (!noteBytes) {
    throw new Error("Note protobuf missing Note field (Document field 3)");
  }
  const note = readProtoFields(noteBytes);

  const noteTextBytes = getLastBytesField(note, 2);
  if (!noteTextBytes) {
    throw new Error("Note protobuf missing note_text field (Note field 2)");
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(noteTextBytes);
}

function decompress(buf: Buffer): Buffer {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (isGzip) {
    return gunzipSync(buf);
  }
  return inflateSync(buf);
}
