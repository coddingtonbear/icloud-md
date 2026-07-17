/**
 * Pure logic behind `push`'s table write path - the network/fs orchestration
 * lives in `src/commands/push.ts`; everything here takes plain data in and
 * returns plain data out, so it can be unit-tested directly against the
 * real captured fixtures the way `attachmentSync.ts`'s pure helpers are.
 */

import type { CloudKitRecord } from "../cloudkit/databaseClient.js";
import { OBJECT_REPLACEMENT_CHARACTER } from "./noteAttachments.js";
import { gridFromTableDocument, parseTableDocument, tableDocumentRoundTrips } from "./decodeTableRecord.js";
import type { MarkdownTableBlock } from "./markdownTable.js";

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
 * Checks whether one table attachment record's grid matches what's wanted
 * locally - and refuses if it doesn't, rather than writing it. Table writes
 * (via `tableEdit.ts`'s `buildFreshTableDocument` rebuild) are known-unsafe:
 * they corrupted a live note during their own verification pass. See the
 * Obsidian dev log's "Table write engine rewrite" investigation (Additional
 * Investigation) and its 2026-07-16 addendum for the open root cause. Tables
 * stay readable (via `clone`/`pull`) but not writable until that's fixed -
 * `changed: false` means the grid already matches, so there's nothing to
 * refuse or push; a genuine local edit is a hard refusal, not an attempt.
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
    const currentGrid = gridFromTableDocument(parseTableDocument(compressed));
    if (gridsEqual(currentGrid, desiredGrid)) {
      return { ok: true, changed: false, mergeableDataBase64: field.value };
    }
    return {
      ok: false,
      reason:
        "this table was edited locally, but table writes aren't safe yet (see the open table write-engine investigation) - this tool can currently only read tables, not push changes to them",
    };
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
