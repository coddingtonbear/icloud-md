/**
 * Per-cell, identity-preserving text edits for a table's mergeable strings
 * (`Document.DocObject.string`, the same `topotext.String` message field 10
 * used elsewhere - see `decodeTableRecord.ts`'s file header). The same
 * splice/tombstone primitives also maintain an `OrderedSet`'s hidden
 * per-character U+FFFC ordering mirror (`tableEdit.ts`), which is the same
 * message type with the same run discipline.
 *
 * A cell's CRDT run history follows the exact same tombstone/splice
 * discipline as the top-level note body (`noteDocument.ts`), with one
 * structural difference confirmed against real captures (dev notes,
 * 2026-07-15T14:51 and 2026-07-16T16:31): the per-string clock table
 * (`String.timestamp`, field 4) is always absent. Instead, every mergeable
 * string in one table - every cell and both ordering mirrors - draws its
 * `CharID` clocks from one *document-global* per-replica sequence stored in
 * `CRDT.Document.ttTimestamp`, and `CharID.replicaID` is a 1-based index
 * into that table's `clock` entries (0 is the origin/sentinel
 * pseudo-replica). Callers therefore supply a `TopotextClockSource` wired to
 * the document's own clock table (see `tableEdit.ts`'s write session);
 * nothing in this module invents clock numbering of its own. (The previous
 * revision of this module borrowed replica index 1 with per-cell local
 * numbering - the exact workaround the 2026-07-16T16:31 evidence pass
 * existed to replace.)
 */

import { create } from "@bufbuild/protobuf";
import {
  computeSplice,
  encodeTextRun,
  insertRunAt,
  isSentinel,
  parseTextRun,
  splitRunAt,
  validateChildEdges,
  type AttributeRun,
  type RunCoord,
  type TextRun,
} from "./noteDocument.js";
import { AttributeRunSchema, StringSchema, type String as GenString } from "./gen/topotext_pb.js";

const SENTINEL_CLOCK = 0xffffffff;

/**
 * A table document's shared topotext clock, scoped to one replica: the
 * writing replica's 1-based `CharID.replicaID` and its two counters (the
 * text clock - total UTF-16 units this replica has ever inserted anywhere in
 * the document - and the style clock). `take` returns the first clock of a
 * fresh `units`-unit run and advances the text counter;
 * `takeTombstoneAnchor` returns the style timestamp to stamp on a run being
 * tombstoned and advances the style counter past it. `tableEdit.ts` backs
 * both with the document's own `ttTimestamp` entry so the advances persist
 * into the encoded document.
 */
export interface TopotextClockSource {
  readonly replicaIndex: number;
  take(units: number): number;
  /**
   * Apple's deletion-bias rule from `generateIdsForLocalChanges`:
   * `max(previousClock + 8, styleClockFloor)`, where the floor is this
   * replica's style clock as of the start of the save. The same rule
   * `noteDocument.ts` applies to note bodies (PR #9) - it is one shared
   * code path in Apple's client (`TTMergeableAttributedString`), so cells
   * and ordering mirrors obey it too.
   */
  takeTombstoneAnchor(previousClock: number): number;
}

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

/** A brand-new empty cell, matching the exact shape every real capture has
 * for a freshly inserted cell (2026-07-16T16:31: an origin run, an end
 * sentinel, no attribute runs, nothing else); `applyCellTextEdit` gives it
 * real text under the caller's clock if the edit calls for any. */
export function newCellDocument(): TableCellDocument {
  return {
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
}

/**
 * Applies a plain-text edit to a cell in place, adapting
 * `noteDocument.ts`'s `applyTextEdit` splice/tombstone discipline with
 * clocks drawn from the document-global source - see file header. Returns
 * false if the text is unchanged (nothing to do).
 */
export function applyCellTextEdit(cell: TableCellDocument, newText: string, clock: TopotextClockSource): boolean {
  const oldText = cell.text;
  if (oldText === newText) {
    return false;
  }
  validateCellInvariants(cell);

  const { start, deleteLength, insertText } = computeSplice(oldText, newText);

  if (deleteLength > 0) {
    tombstoneVisibleRange(cell, start, deleteLength, clock);
  }
  if (insertText.length > 0) {
    insertVisibleText(cell, start, insertText, clock);
  }
  adjustAttributeRuns(cell, start, deleteLength, insertText.length);

  cell.text = newText;
  validateCellInvariants(cell);
  return true;
}

/** Marks the visible range [start, start+length) as tombstoned, splitting
 * runs where the range boundaries fall inside one - identical algorithm to
 * `noteDocument.ts`'s `tombstoneVisibleRange`, operating on a cell instead
 * (`splitRunAt` owns the child-edge surgery; tombstoning itself never
 * touches edges). Every newly tombstoned piece is restamped
 * `{us, takeTombstoneAnchor(old style clock)}` so Apple's merge path sees
 * the deletion (it only adopts a remote tombstone when the remote style
 * timestamp compares strictly greater). Exported for `tableEdit.ts`'s mirror
 * maintenance; does not touch `text`/attribute runs (`applyCellTextEdit`
 * owns that for cells, the mirror helper owns it there). */
export function tombstoneVisibleRange(cell: TableCellDocument, start: number, length: number, clock: TopotextClockSource): void {
  const end = start + length;
  if (end > visibleLength(cell.runs)) {
    throw new Error("Cell tombstone range extends past the end of its visible text - CRDT model out of sync");
  }
  const runs = cell.runs;
  let visible = 0;
  for (let i = 0; i < runs.length && visible < end; i += 1) {
    const run = runs[i]!;
    if (run.tombstone || run.length === 0 || isSentinel(run)) {
      continue;
    }
    const runStart = visible;
    const runEnd = runStart + run.length;
    if (runEnd <= start) {
      visible = runEnd;
      continue;
    }

    let target = run;
    let targetIndex = i;
    let targetStart = runStart;
    if (start > runStart) {
      target = splitRunAt(runs, i, start - runStart);
      targetIndex = i + 1;
      targetStart = start;
    }
    if (end < targetStart + target.length) {
      splitRunAt(runs, targetIndex, end - targetStart);
    }
    const previousClock = target.anchor.clock;
    target.tombstone = true;
    target.anchor = { replica: clock.replicaIndex, clock: clock.takeTombstoneAnchor(previousClock) };
    visible = targetStart + target.length;
    i = targetIndex;
  }
}

/** Inserts `text` at visible position `start` as a new run under the
 * caller's replica, drawing its clock range from the document-global
 * source (a cell edit is one splice per call - there's no cross-call "our
 * own trailing run" state worth tracking the way the top-level note body's
 * `insertVisibleText` does for consecutive saves). Fresh runs anchor at
 * `{ownReplica, 0}`, matching every captured insert. Exported for
 * `tableEdit.ts`'s mirror maintenance - same `text`/attribute-run caveat as
 * `tombstoneVisibleRange`. */
export function insertVisibleText(cell: TableCellDocument, start: number, text: string, clock: TopotextClockSource): void {
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
        splitRunAt(cell.runs, i, offset);
        insertIndex = i + 1;
      }
      break;
    }
    visible = runEnd;
    insertIndex = i + 1;
  }

  const coord: RunCoord = { replica: clock.replicaIndex, clock: clock.take(text.length) };
  insertRunAt(cell.runs, insertIndex, {
    coord,
    length: text.length,
    anchor: { replica: clock.replicaIndex, clock: 0 },
    tombstone: false,
    sequence: [],
  });
}

export function visibleLength(runs: readonly TextRun[]): number {
  let total = 0;
  for (const run of runs) {
    if (!run.tombstone) {
      total += run.length;
    }
  }
  return total;
}

/** Identical algorithm to `noteDocument.ts`'s `adjustAttributeRuns`. A
 * previously-empty cell gains a single `{length}` attribute run, the exact
 * shape Apple's own cell fills produce (2026-07-16T16:31 capture). */
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
  validateChildEdges(cell.runs, "cell");
}
