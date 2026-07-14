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

/** One field occurrence in its original position - the unit of the ordered
 * (write-capable) API below, as opposed to the field-number-keyed map of
 * `readProtoFields`. */
export type ProtoToken = { fieldNumber: number } & ProtoValue;

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

/**
 * Reads a message as an ordered token list, preserving the position of every
 * field occurrence. Re-encoding via `encodeProtoTokens` reproduces the
 * original bytes exactly (as long as the source used minimal varint
 * encodings, which callers verify with a byte-for-byte round-trip check
 * before ever trusting an edit built on top of this).
 */
export function readProtoTokens(buf: Uint8Array): ProtoToken[] {
  const tokens: ProtoToken[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const [tag, tagLength] = readVarint(buf, offset);
    offset += tagLength;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);

    switch (wireType) {
      case 0: {
        const [v, len] = readVarint(buf, offset);
        offset += len;
        tokens.push({ fieldNumber, wireType: 0, varint: v });
        break;
      }
      case 1: {
        assertAvailable(buf, offset, 8);
        tokens.push({ fieldNumber, wireType: 1, fixed64: buf.slice(offset, offset + 8) });
        offset += 8;
        break;
      }
      case 2: {
        const [len, lenLength] = readVarint(buf, offset);
        offset += lenLength;
        const length = Number(len);
        assertAvailable(buf, offset, length);
        tokens.push({ fieldNumber, wireType: 2, bytes: buf.slice(offset, offset + length) });
        offset += length;
        break;
      }
      case 5: {
        assertAvailable(buf, offset, 4);
        tokens.push({ fieldNumber, wireType: 5, fixed32: buf.slice(offset, offset + 4) });
        offset += 4;
        break;
      }
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType} for field ${fieldNumber}`);
    }
  }

  return tokens;
}

export function encodeProtoTokens(tokens: readonly ProtoToken[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const token of tokens) {
    parts.push(encodeVarint((BigInt(token.fieldNumber) << 3n) | BigInt(token.wireType)));
    switch (token.wireType) {
      case 0:
        parts.push(encodeVarint(token.varint));
        break;
      case 1:
        parts.push(token.fixed64);
        break;
      case 2:
        parts.push(encodeVarint(BigInt(token.bytes.length)));
        parts.push(token.bytes);
        break;
      case 5:
        parts.push(token.fixed32);
        break;
    }
  }
  return concatBytes(parts);
}

export function varintToken(fieldNumber: number, value: number | bigint): ProtoToken {
  const varint = BigInt(value);
  if (varint < 0n) {
    throw new Error(`Refusing to encode negative varint ${varint} for field ${fieldNumber}`);
  }
  return { fieldNumber, wireType: 0, varint };
}

export function bytesToken(fieldNumber: number, bytes: Uint8Array): ProtoToken {
  return { fieldNumber, wireType: 2, bytes };
}

export function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`Refusing to encode negative varint ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const low = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining === 0n) {
      bytes.push(low);
      break;
    }
    bytes.push(low | 0x80);
  }
  return Uint8Array.from(bytes);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function assertAvailable(buf: Uint8Array, offset: number, length: number): void {
  if (offset + length > buf.length) {
    throw new Error("Truncated length-delimited value while reading protobuf bytes");
  }
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
