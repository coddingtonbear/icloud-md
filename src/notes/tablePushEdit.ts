/**
 * Pure logic behind `push`'s table write path - the network/fs orchestration
 * lives in `src/commands/push.ts`; everything here takes plain data in and
 * returns plain data out, so it can be unit-tested directly against the
 * real captured fixtures the way `attachmentSync.ts`'s pure helpers are.
 */

import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { encodeTableDocument, gridFromTableDocument, parseTableDocument, tableDocumentRoundTrips } from "./decodeTableRecord.js";
import { applyTableEdit } from "./tableEdit.js";

export type TableAttachmentUpdateResult =
  | { ok: true; changed: boolean; mergeableDataBase64: string }
  | { ok: false; reason: string };

/**
 * Diffs one table attachment record's grid against what's wanted locally
 * and, when they differ, applies the edit through `tableEdit.ts`'s
 * incremental engine (the corrected design from the table write-engine
 * investigation, dev log 2026-07-16T16:31) under the same per-clone replica
 * identity note-body edits use. Every write is triple-gated: the incoming
 * bytes must pass the byte-for-byte round-trip gate (we refuse to edit a
 * document our model didn't capture completely), the edited document must
 * pass the structural-invariant checks and decode to exactly the desired
 * grid (`applyTableEdit` enforces both), and the re-encoded bytes must
 * round-trip too. Unsupported edit shapes (both axes changed at once,
 * reorders, ...) are refused with the engine's reason, never guessed at.
 */
export function prepareTableAttachmentUpdate(
  record: CloudKitRecord,
  desiredGrid: string[][],
  replicaId: Uint8Array,
): TableAttachmentUpdateResult {
  const field = record.fields.MergeableDataEncrypted;
  if (!field || typeof field.value !== "string") {
    return { ok: false, reason: "table attachment has no readable data" };
  }
  const compressed = Buffer.from(field.value, "base64");
  if (!tableDocumentRoundTrips(compressed)) {
    return { ok: false, reason: "the table's document doesn't round-trip byte-for-byte through our model - refusing to edit" };
  }

  try {
    const doc = parseTableDocument(compressed);
    if (!applyTableEdit(doc, desiredGrid, replicaId)) {
      return { ok: true, changed: false, mergeableDataBase64: field.value };
    }
    const encoded = encodeTableDocument(doc);
    if (!tableDocumentRoundTrips(encoded)) {
      return { ok: false, reason: "the edited table failed its own round-trip gate - refusing to write it" };
    }
    return { ok: true, changed: true, mergeableDataBase64: encoded.toString("base64") };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: message };
  }
}
