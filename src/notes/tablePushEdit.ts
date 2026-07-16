/**
 * Pure logic behind `push`'s table write path - the network/fs orchestration
 * lives in `src/commands/push.ts`; everything here takes plain data in and
 * returns plain data out, so it can be unit-tested directly against the
 * real captured fixtures the way `attachmentSync.ts`'s pure helpers are.
 */

import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import {
  encodeTableDocument,
  gridFromTableDocument,
  parseTableDocument,
  tableDocumentRoundTrips,
  type MarkdownTableBlock,
} from "./decodeTableRecord.js";
import { applyTableEdit, diffTableGrid } from "./tableEdit.js";

/**
 * Un-splices each located table block back out of a locally-edited note's
 * text, replacing it with the single placeholder character
 * (`resolveNoteAttachments`'s `renderPlaceholders` did the reverse on read) -
 * recovering the "true" note body text (the shape `TextDataEncrypted`
 * actually stores) so it can be compared against the remote note's current
 * text, and diffed/pushed the normal way if the surrounding prose changed
 * too. Blocks are expected in document order, each spanning whole lines -
 * see `findMarkdownTableBlocks`.
 */
export function reconstructBodyTextWithPlaceholders(localText: string, blocks: readonly MarkdownTableBlock[]): string {
  const lines = localText.split("\n");
  for (const block of [...blocks].sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(block.startLine, block.endLine - block.startLine, OBJECT_REPLACEMENT_CHARACTER);
  }
  return lines.join("\n");
}

export type TableAttachmentUpdateResult =
  | { ok: true; changed: boolean; mergeableDataBase64: string }
  | { ok: false; reason: string };

/**
 * Builds the new `MergeableDataEncrypted` payload for one table attachment
 * record, applying the same pre/post round-trip discipline `push.ts`'s
 * plain-text path already uses for the Note record: the current remote
 * document must round-trip byte-for-byte through our model before we trust
 * ourselves to edit it, and the rebuilt document must decode back to
 * exactly the intended grid before it's trusted to push. `changed: false`
 * means the diff resolved to a no-op (surrounding prose changed but this
 * particular table didn't) - the caller should skip sending this record.
 *
 * Structural edits (row/column insert/delete) are refused below, not just
 * `unsupported` ones - a live incident (2026-07-15) showed the minimal-diff
 * `applyTableEdit`/`compactPool` machinery those plan kinds drive can
 * corrupt a real table in a way this project's own round-trip/decode
 * verification doesn't catch, because it's a real Apple client, not our own
 * decoder, that chokes on it. Cell-only edits reuse the same tombstone/
 * splice pattern the plain-text note path has trusted since 2026-07-13, so
 * they stay enabled. See the Obsidian dev log's "Table write engine
 * rewrite: wholesale rebuild instead of minimal-diff/patch" entry for the
 * planned fix - re-enable structural edits only once that lands and passes
 * its own staged live verification, not just once it's implemented.
 */
export function prepareTableAttachmentUpdate(record: CloudKitRecord, desiredGrid: string[][]): TableAttachmentUpdateResult {
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
    const currentGrid = gridFromTableDocument(doc);
    const plan = diffTableGrid(currentGrid, desiredGrid);
    if (plan.kind === "unsupported") {
      return { ok: false, reason: plan.reason };
    }
    if (plan.kind === "noop") {
      return { ok: true, changed: false, mergeableDataBase64: field.value };
    }
    if (plan.kind !== "cellEdits") {
      return {
        ok: false,
        reason:
          "inserting or deleting table rows/columns is temporarily disabled after a live incident corrupted a table - " +
          "only cell text edits are supported right now",
      };
    }

    applyTableEdit(doc, plan);
    const encoded = encodeTableDocument(doc);
    if (!tableDocumentRoundTrips(encoded)) {
      return { ok: false, reason: "rebuilt table document failed round-trip verification - refusing to push" };
    }
    const resultGrid = gridFromTableDocument(parseTableDocument(encoded));
    if (!gridsEqual(resultGrid, desiredGrid)) {
      return { ok: false, reason: "rebuilt table document failed decode verification - refusing to push" };
    }
    return { ok: true, changed: true, mergeableDataBase64: encoded.toString("base64") };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: message };
  }
}

function gridsEqual(a: readonly string[][], b: readonly string[][]): boolean {
  return a.length === b.length && a.every((row, i) => rowEqual(row, b[i] ?? []));
}

function rowEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cell, i) => cell === b[i]);
}
