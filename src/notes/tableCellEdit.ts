/**
 * Per-cell, identity-preserving text edits for a table's cell-text objects
 * (`Document.DocObject.string`, the same `topotext.String` message field 10
 * used elsewhere - see `decodeTableRecord.ts`'s file header).
 *
 * A cell's CRDT run history follows the exact same tombstone/splice
 * discipline as the top-level note body (`noteDocument.ts`), with one
 * structural difference confirmed against real captures (dev notes,
 * 2026-07-15T14:51): the per-replica clock table (`String.timestamp`, field
 * 4) is always absent, so there's no stored `{replica UUID -> table index}`
 * mapping and no `replica.counters[0]` to read a "next available clock" from
 * the way `noteDocument.ts`'s `insertVisibleText` does.
 *
 * Real captures always use replica index 1 for cell edits (there's only
 * ever one editor in scope), with each brand-new cell's first insertion
 * starting from whatever clock that specific real capture session's replica
 * 1 had *globally* reached across every cell in the table at that point -
 * evidence a save's clock numbering for a given replica is shared
 * document-wide, not reset per cell. This project's own edits use a
 * simpler, self-consistent alternative instead: always replica index 1,
 * with "next available clock" derived per the plan ("scanning the cell's
 * own run list for the max `coord.clock + length`") - i.e. *per-cell*
 * local numbering, restarting at 0 for a cell we've never touched. This
 * decodes identically (this project's own decode reads `note_text`
 * directly - see `decodeTableRecord.ts`'s `resolveCellText` - never
 * reconstructing visible text from run/clock history) and never collides
 * with a run this tool itself already wrote, which is all the safety
 * property actually requires; it just means a clock this tool assigns
 * isn't necessarily unique against clocks a *different* real editor may
 * have used elsewhere in the same table under the same replica index 1 -
 * an acceptable gap given the project's explicit "own round-trip, not
 * byte-identity with Apple's client" bar (decodeTableRecord.ts's file
 * header, finding 6) and the write path's still-pending live-push
 * verification (dev notes, 2026-07-15T14:51).
 */

import { create } from "@bufbuild/protobuf";
import {
  computeSplice,
  encodeTextRun,
  isSentinel,
  parseTextRun,
  type AttributeRun,
  type RunCoord,
  type TextRun,
} from "./noteDocument.js";
import { AttributeRunSchema, StringSchema, type String as GenString } from "./gen/topotext_pb.js";

/** The replica index every edit this tool makes to a cell uses; see file header. */
const CELL_REPLICA_INDEX = 1;
const SENTINEL_CLOCK = 0xffffffff;

export interface TableCellDocument {
  text: string;
  runs: TextRun[];
  attributeRuns: AttributeRun[];
}

export function parseCellDocument(str: GenString): TableCellDocument {
  return {
    text: str.string,
    runs: str.substring.map(parseTextRun),
    attributeRuns: str.attributeRun,
  };
}

export function encodeCellDocument(doc: TableCellDocument): GenString {
  return create(StringSchema, {
    string: doc.text,
    substring: doc.runs.map(encodeTextRun),
    attributeRun: doc.attributeRuns,
  });
}

/** A brand-new cell, matching the minimal shape observed for a freshly
 * inserted (initially empty) cell in real captures: an origin run, an end
 * sentinel, and nothing else - `applyCellTextEdit` then handles giving it
 * real text if `text` is non-empty. */
export function newCellDocument(text: string): TableCellDocument {
  const doc: TableCellDocument = {
    text: "",
    runs: [
      { coord: { replica: 0, clock: 0 }, length: 0, anchor: { replica: 0, clock: 0 }, tombstone: false, sequence: [1] },
      {
        coord: { replica: 0, clock: SENTINEL_CLOCK },
        length: 0,
        anchor: { replica: 0, clock: SENTINEL_CLOCK },
        tombstone: false,
        sequence: [],
      },
    ],
    attributeRuns: [],
  };
  if (text.length > 0) {
    applyCellTextEdit(doc, text);
  }
  return doc;
}

/**
 * Applies a plain-text edit to a cell in place, adapting
 * `noteDocument.ts`'s `applyTextEdit` splice/tombstone discipline - see file
 * header for how clock derivation differs. Returns false if the text is
 * unchanged (nothing to do).
 */
export function applyCellTextEdit(cell: TableCellDocument, newText: string): boolean {
  const oldText = cell.text;
  if (oldText === newText) {
    return false;
  }
  validateCellInvariants(cell);

  const { start, deleteLength, insertText } = computeSplice(oldText, newText);

  if (deleteLength > 0) {
    tombstoneVisibleRange(cell, start, deleteLength);
  }
  if (insertText.length > 0) {
    insertVisibleText(cell, start, insertText);
  }
  adjustAttributeRuns(cell, start, deleteLength, insertText.length);
  renumberSequences(cell);

  cell.text = newText;
  validateCellInvariants(cell);
  return true;
}

function nextClockFor(runs: readonly TextRun[]): number {
  let max = 0;
  for (const run of runs) {
    if (isSentinel(run) || run.coord.replica !== CELL_REPLICA_INDEX) {
      continue;
    }
    max = Math.max(max, run.coord.clock + run.length);
  }
  return max;
}

/** Marks the visible range [start, start+length) as tombstoned, splitting
 * runs where the range boundaries fall inside one - identical algorithm to
 * `noteDocument.ts`'s `tombstoneVisibleRange`, operating on a cell instead. */
function tombstoneVisibleRange(cell: TableCellDocument, start: number, length: number): void {
  const end = start + length;
  const out: TextRun[] = [];
  let visible = 0;

  for (const run of cell.runs) {
    if (run.tombstone || run.length === 0 || isSentinel(run)) {
      out.push(run);
      continue;
    }
    const runStart = visible;
    const runEnd = visible + run.length;
    visible = runEnd;

    if (runEnd <= start || runStart >= end) {
      out.push(run);
      continue;
    }

    const overlapStart = Math.max(start, runStart);
    const overlapEnd = Math.min(end, runEnd);
    if (overlapStart > runStart) {
      out.push(pieceOf(run, 0, overlapStart - runStart, false));
    }
    out.push(pieceOf(run, overlapStart - runStart, overlapEnd - overlapStart, true));
    if (runEnd > overlapEnd) {
      out.push(pieceOf(run, overlapEnd - runStart, runEnd - overlapEnd, false));
    }
  }

  if (visible < end) {
    throw new Error("Cell tombstone range extends past the end of its visible text - CRDT model out of sync");
  }
  cell.runs = out;
}

function pieceOf(run: TextRun, offset: number, length: number, tombstone: boolean): TextRun {
  return {
    coord: { replica: run.coord.replica, clock: run.coord.clock + offset },
    length,
    anchor: { replica: run.anchor.replica, clock: run.anchor.clock },
    tombstone: tombstone || run.tombstone,
    sequence: run.sequence,
  };
}

/** Inserts `text` at visible position `start` under `CELL_REPLICA_INDEX`,
 * always as a new run (a cell edit is one splice per call - there's no
 * cross-call "our own trailing run" state worth tracking the way the
 * top-level note body's `insertVisibleText` does for consecutive saves). */
function insertVisibleText(cell: TableCellDocument, start: number, text: string): void {
  if (start > visibleLength(cell.runs)) {
    throw new Error("Cell insertion point is past the end of its visible text - CRDT model out of sync");
  }

  let visible = 0;
  let insertIndex = cell.runs.length;
  for (let i = 0; i < cell.runs.length; i += 1) {
    const run = cell.runs[i];
    if (!run) continue;
    if (isSentinel(run)) {
      insertIndex = i;
      break;
    }
    if (run.tombstone || run.length === 0) {
      insertIndex = i + 1;
      continue;
    }
    const runEnd = visible + run.length;
    if (start < runEnd) {
      const offset = start - visible;
      if (offset === 0) {
        insertIndex = i;
      } else {
        cell.runs.splice(i, 1, pieceOf(run, 0, offset, false), pieceOf(run, offset, run.length - offset, false));
        insertIndex = i + 1;
      }
      break;
    }
    visible = runEnd;
    insertIndex = i + 1;
  }

  const clock = nextClockFor(cell.runs);
  const coord: RunCoord = { replica: CELL_REPLICA_INDEX, clock };
  cell.runs.splice(insertIndex, 0, {
    coord,
    length: text.length,
    anchor: { replica: CELL_REPLICA_INDEX, clock: 0 },
    tombstone: false,
    sequence: [],
  });
}

function visibleLength(runs: readonly TextRun[]): number {
  let total = 0;
  for (const run of runs) {
    if (!run.tombstone) {
      total += run.length;
    }
  }
  return total;
}

/** Identical algorithm to `noteDocument.ts`'s `adjustAttributeRuns`. */
function adjustAttributeRuns(cell: TableCellDocument, start: number, deleteLength: number, insertLength: number): void {
  const end = start + deleteLength;
  const out: AttributeRun[] = [];
  let visible = 0;
  for (const run of cell.attributeRuns) {
    const runStart = visible;
    const runEnd = visible + run.length;
    visible = runEnd;
    const overlap = Math.max(0, Math.min(end, runEnd) - Math.max(start, runStart));
    if (run.length - overlap > 0) {
      const piece = create(AttributeRunSchema, run);
      piece.length = run.length - overlap;
      out.push(piece);
    }
  }
  if (visible < end) {
    throw new Error("Cell attribute runs are shorter than the deleted range - document model out of sync");
  }

  if (insertLength > 0) {
    let grown = false;
    let runEnd = 0;
    for (const run of out) {
      runEnd += run.length;
      if (start <= runEnd) {
        run.length += insertLength;
        grown = true;
        break;
      }
    }
    if (!grown) {
      const lastRun = out[out.length - 1];
      if (lastRun) {
        lastRun.length += insertLength;
      } else {
        out.push(create(AttributeRunSchema, { length: insertLength }));
      }
    }
  }
  cell.attributeRuns = out;
}

function renumberSequences(cell: TableCellDocument): void {
  let sequence = 1;
  for (const run of cell.runs) {
    if (isSentinel(run)) {
      continue;
    }
    run.sequence = [sequence];
    sequence += 1;
  }
}

export function validateCellInvariants(cell: TableCellDocument): void {
  const visible = cell.runs.filter((run) => !run.tombstone).reduce((sum, run) => sum + run.length, 0);
  if (visible !== cell.text.length) {
    throw new Error(
      `Cell's visible run lengths (${visible}) do not match its text length (${cell.text.length}) - refusing to touch this cell`,
    );
  }
  const attributeLength = cell.attributeRuns.reduce((sum, run) => sum + run.length, 0);
  if (attributeLength !== cell.text.length) {
    throw new Error(
      `Cell's attribute run lengths (${attributeLength}) do not match its text length (${cell.text.length}) - refusing to touch this cell`,
    );
  }
}
