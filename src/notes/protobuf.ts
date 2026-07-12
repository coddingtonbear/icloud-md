/**
 * Minimal protobuf wire-format reader - just enough to walk into a known field
 * path and pull out a length-delimited value, without a full schema/codegen
 * step. We don't have (or need, yet) a complete .proto for Apple's Notes
 * format; we only know the specific field-number path to note_text, verified
 * empirically against real captured note data (see databaseClient.ts callers
 * and the dev notes in projects/software/icloud-notes-sync.md).
 */

export type ProtoValue =
  | { wireType: 0; varint: bigint }
  | { wireType: 1; fixed64: Uint8Array }
  | { wireType: 2; bytes: Uint8Array }
  | { wireType: 5; fixed32: Uint8Array };

export function readProtoFields(buf: Uint8Array): Map<number, ProtoValue[]> {
  const fields = new Map<number, ProtoValue[]>();
  let offset = 0;

  while (offset < buf.length) {
    const [tag, tagLength] = readVarint(buf, offset);
    offset += tagLength;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);

    let value: ProtoValue;
    switch (wireType) {
      case 0: {
        const [v, len] = readVarint(buf, offset);
        offset += len;
        value = { wireType: 0, varint: v };
        break;
      }
      case 1: {
        value = { wireType: 1, fixed64: buf.slice(offset, offset + 8) };
        offset += 8;
        break;
      }
      case 2: {
        const [len, lenLength] = readVarint(buf, offset);
        offset += lenLength;
        const length = Number(len);
        value = { wireType: 2, bytes: buf.slice(offset, offset + length) };
        offset += length;
        break;
      }
      case 5: {
        value = { wireType: 5, fixed32: buf.slice(offset, offset + 4) };
        offset += 4;
        break;
      }
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType} for field ${fieldNumber}`);
    }

    const existing = fields.get(fieldNumber);
    if (existing) {
      existing.push(value);
    } else {
      fields.set(fieldNumber, [value]);
    }
  }

  return fields;
}

/** Returns the last (per proto semantics, latest wins for singular fields) length-delimited value for a field number. */
export function getLastBytesField(fields: Map<number, ProtoValue[]>, fieldNumber: number): Uint8Array | undefined {
  const values = fields.get(fieldNumber);
  if (!values || values.length === 0) {
    return undefined;
  }
  const last = values[values.length - 1];
  return last && last.wireType === 2 ? last.bytes : undefined;
}

function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;

  for (;;) {
    const byte = buf[pos];
    if (byte === undefined) {
      throw new Error("Truncated varint while reading protobuf bytes");
    }
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7n;
  }

  return [result, pos - offset];
}
