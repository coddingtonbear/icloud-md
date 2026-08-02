/**
 * Test-only: plants a deliberately WRONG deletion on a live note record.
 *
 * The negative half of the merge proof. PR 14's live test shows that a
 * deletion whose tombstones are restamped per the PR 9/12 style-clock rule
 * survives Apple's incremental merge. On its own that only proves *a*
 * deletion merges - not that the restamping is what makes it merge. The
 * counterexample needs a deletion that is identical in every respect except
 * the clock discipline, and the client must throw it away.
 *
 * `applyTextEdit` now always restamps correctly:
 *
 *     assigned = max(run.anchor.clock + 8, styleClockFloor)
 *     run.tombstone = true
 *     run.anchor = { replica: ours, clock: assigned }
 *
 * so the wrong shape cannot be produced through the normal write path. This
 * module builds it by letting the production codec do the correct edit and
 * then *reverting only the stamps*: every run the edit newly tombstoned gets
 * its original style timestamp back, and the replica's style counter is
 * rolled back to what it was. Everything else - the run splits, the child
 * edges, the attribute runs, the visible text, the compression, the record
 * fields - is byte-identical to what a real push would have sent.
 *
 * Deriving the corrupt document by reverting the production edit, rather
 * than hand-rolling a second tombstoning path, is what makes this a
 * controlled negative: the two documents differ in exactly one dimension.
 *
 * The resulting shape is a *tie*, not a loss: the tombstone carries the same
 * (clock, replica) style timestamp the receiver's own copy of that run
 * carries. That is the closest a wrong deletion can get to winning Apple's
 * last-writer-wins comparison without winning it, so a client that discards
 * this one discards every weaker variant too - including the historical
 * pre-PR-9 shape, which stamped tombstones with our replica at its own low
 * op number (usually 0) and therefore ranked at or below this one.
 *
 * Nothing here is importable by production code, and nothing in `src/` grows
 * a corrupt-document writer: this file lives in `integration/` and is only
 * ever reached from the live suite and its own unit test.
 */

import { Buffer } from "node:buffer";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdateResult } from "../src/cloudkit/databaseClient.js";
import { buildNoteUpdateFields } from "../src/notes/encodeNoteRecord.js";
import { resolveHarnessAccount } from "./harnessAccount.js";
import {
  applyTextEdit,
  computeSplices,
  encodeNoteDocument,
  parseNoteDocument,
  type NoteDocument,
  type RunCoord,
  type TextRun,
} from "../src/notes/noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";

/** What one run looked like before the edit, for restoring its stamp after. */
interface PreEditRun {
  coord: RunCoord;
  length: number;
  anchor: RunCoord;
  tombstone: boolean;
}

export interface TiedAnchorDeletion {
  /** The corrupted document, uncompressed - ready for `encodeNoteDocument`'s output contract. */
  raw: Uint8Array;
  /** How many runs were tombstoned and then had their original stamp restored. */
  tiedRuns: number;
  /** The style timestamps those runs kept, for the caller to assert on. */
  tiedAnchors: RunCoord[];
  /** What a correct push would have stamped them with instead - the thing we
   * deliberately did not do, reported so tests can prove the two differ. */
  correctAnchors: RunCoord[];
}

/**
 * Produces the tied-anchor form of a pure deletion.
 *
 * `newText` must be `originalRaw`'s visible text with characters removed and
 * none added: an insertion would also advance the replica's *text* clock and
 * add runs, which the stamp-reverting below is not designed to undo, and
 * which would stop the experiment being a controlled one.
 */
export function buildTiedAnchorDeletion(originalRaw: Uint8Array, newText: string, replicaId: Uint8Array): TiedAnchorDeletion {
  const doc = parseNoteDocument(originalRaw);

  const splices = computeSplices(doc.text, newText);
  if (splices.length === 0) {
    throw new Error("buildTiedAnchorDeletion: the text is unchanged - there is no deletion to corrupt");
  }
  for (const splice of splices) {
    if (splice.insertText.length > 0) {
      throw new Error(
        `buildTiedAnchorDeletion: only pure deletions are supported, but this edit inserts ${JSON.stringify(splice.insertText)}`,
      );
    }
  }

  const before = snapshotRuns(doc);
  const beforeCounters = new Map(doc.replicas.map((replica) => [hex(replica.id), [...replica.counters]] as const));
  // What `ensureReplica` seeds a replica joining this document with - the
  // resting value for our own entry if the edit is what introduced it.
  const seedStyleClock = Math.max(0, ...doc.replicas.map((replica) => replica.counters[1] ?? 0));

  if (!applyTextEdit(doc, newText, { replicaId })) {
    throw new Error("buildTiedAnchorDeletion: applyTextEdit reported no change");
  }

  // Revert the stamps, and only the stamps.
  const tiedAnchors: RunCoord[] = [];
  const correctAnchors: RunCoord[] = [];
  for (const run of doc.runs) {
    if (!run.tombstone) {
      continue;
    }
    const original = coveringRun(before, run.coord);
    if (original === undefined || original.tombstone) {
      // Already dead before this edit (an earlier deletion), or not a run
      // this edit touched. Either way its stamp is not ours to change.
      continue;
    }
    correctAnchors.push({ ...run.anchor });
    run.anchor = { ...original.anchor };
    tiedAnchors.push({ ...run.anchor });
  }

  if (tiedAnchors.length === 0) {
    throw new Error("buildTiedAnchorDeletion: the edit tombstoned nothing - refusing to push a document that proves nothing");
  }

  // Roll the style clock back too. Leaving it advanced would describe a
  // document no version of this tool ever wrote: a replica table claiming
  // restyling that none of the stamps reflect. Reverting undoes exactly what
  // the edit did - a replica that existed goes back to its own prior value,
  // and one the edit introduced rests at the seed `ensureReplica` gave it
  // rather than at an invented zero.
  for (const replica of doc.replicas) {
    replica.counters[1] = beforeCounters.get(hex(replica.id))?.[1] ?? seedStyleClock;
  }

  return { raw: encodeNoteDocument(doc), tiedRuns: tiedAnchors.length, tiedAnchors, correctAnchors };
}

/** Every run as it stands now, so stamps can be restored after the edit. */
function snapshotRuns(doc: NoteDocument): PreEditRun[] {
  return doc.runs.map((run: TextRun) => ({
    coord: { ...run.coord },
    length: run.length,
    anchor: { ...run.anchor },
    tombstone: run.tombstone,
  }));
}

/**
 * The pre-edit run whose charID range covers `coord`.
 *
 * Splitting a run gives both halves the same replica and contiguous clocks
 * (`splitRunAt` derives the tail's clock as head clock + offset) and copies
 * the anchor to both, so a post-edit piece's original stamp is the stamp of
 * whichever pre-edit run its coord falls inside.
 */
function coveringRun(runs: readonly PreEditRun[], coord: RunCoord): PreEditRun | undefined {
  return runs.find(
    (run) => run.coord.replica === coord.replica && coord.clock >= run.coord.clock && coord.clock < run.coord.clock + run.length,
  );
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export interface PlantTiedAnchorDeletionOptions {
  /** A clone bound to the account that owns the note - the source of both the session and the replica id. */
  vaultDir: string;
  /** The note's CloudKit record name (a file's `apple-note-id`). */
  noteId: string;
  /**
   * The exact substring to delete from the note's *stored* visible text.
   *
   * Taken as a substring rather than a whole replacement text so the caller
   * never has to predict how its markdown was turned into note text - the
   * deletion is computed against whatever the record actually holds, and a
   * substring that is absent (or ambiguous) is an error rather than a
   * silently different edit.
   */
  deleteText: string;
}

export interface PlantedTiedAnchorDeletion extends TiedAnchorDeletion {
  /** The record as it stood before the plant. */
  record: CloudKitRecord;
  /** The note's visible text before and after the planted deletion. */
  oldText: string;
  newText: string;
  result: RecordUpdateResult;
}

/**
 * Fetches the note, builds the tied-anchor deletion, and writes it back
 * through the ordinary `records/modify` update path with the record's own
 * change tag - the same call `push` makes, carrying a document `push` would
 * never produce.
 *
 * Private-database notes only: a note shared from another account lives in a
 * different zone, and this is a test fixture, not a general writer.
 */
export async function plantTiedAnchorDeletion(options: PlantTiedAnchorDeletionOptions): Promise<PlantedTiedAnchorDeletion> {
  // Resolved in-process, and deliberately without the ability to log in
  // interactively - see `harnessAccount.ts` for why that matters mid-run.
  const { session, ckdatabasewsUrl, dsid, zone, replicaId } = await resolveHarnessAccount(options.vaultDir);

  const [record] = await lookupRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [options.noteId]);
  if (!record) {
    throw new Error(`Note record ${options.noteId} was not found`);
  }
  const changeTag = record.recordChangeTag;
  if (changeTag === undefined) {
    throw new Error(`Note record ${options.noteId} came back without a recordChangeTag`);
  }
  const textData = record.fields.TextDataEncrypted?.value;
  if (typeof textData !== "string") {
    throw new Error(`Note record ${options.noteId} has no readable TextDataEncrypted`);
  }

  const raw = decompressNoteDocument(Buffer.from(textData, "base64"));
  const oldText = parseNoteDocument(raw).text;
  const occurrences = oldText.split(options.deleteText).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected ${JSON.stringify(options.deleteText)} to appear exactly once in the note, found ${occurrences} ` +
        `(note text: ${JSON.stringify(oldText)})`,
    );
  }
  const newText = oldText.replace(options.deleteText, "");

  const corrupted = buildTiedAnchorDeletion(raw, newText, replicaId);

  const fields = buildNoteUpdateFields(record, compressNoteDocument(corrupted.raw).toString("base64"), newText, Date.now());
  const [result] = await updateRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [
    { recordName: options.noteId, recordType: "Note", recordChangeTag: changeTag, fields },
  ]);
  if (!result) {
    throw new Error("records/modify returned no result for the planted deletion");
  }

  return { ...corrupted, record, oldText, newText, result };
}
