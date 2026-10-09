/**
 * Test-only: rewrites some of a live note's LF separators as CR or CRLF.
 *
 * Notes with carriage returns in their text are real - pasting into Apple
 * Notes keeps a source's bare CRs, and Apple's editors keep them across an
 * edit and save (issue #34) - but this tool can never produce one: every
 * local file is normalized to LF before it is parsed, so a push always
 * writes LF. The live CR tests therefore need a note planted by other means.
 *
 * The planting goes through the production codec rather than around it:
 * `applyTextEdit` performs the separator swap exactly as it would any other
 * one-character replacement, so the CRDT surgery, the attribute-run
 * adjustment and the record fields are what a real push would send. The
 * swapped character inherits the attribute run it replaces, so a CR inside a
 * bullet or heading carries that paragraph's style - the shape the decoder's
 * paragraph-start rule has to cope with.
 *
 * Nothing here is importable by production code: this file lives in
 * `integration/` and is only reached from the live suite and its own unit test.
 */

import { Buffer } from "node:buffer";
import { lookupRecords, updateRecords, type CloudKitRecord, type RecordUpdateResult } from "../src/cloudkit/databaseClient.js";
import { buildNoteUpdateFields } from "../src/notes/encodeNoteRecord.js";
import { applyTextEdit, encodeNoteDocument, parseNoteDocument } from "../src/notes/noteDocument.js";
import { compressNoteDocument, decompressNoteDocument } from "../src/notes/noteText.js";
import { resolveHarnessAccount, type HarnessAccount } from "./harnessAccount.js";

/**
 * One substitution in the note's stored text. `find` must occur exactly once,
 * so a fixture whose text came out differently than the test expected is an
 * error rather than a silently different plant.
 */
export interface SeparatorReplacement {
  find: string;
  replace: string;
}

/** The visible text with every replacement applied, or an error naming the first that does not match exactly once. */
export function applySeparatorReplacements(text: string, replacements: readonly SeparatorReplacement[]): string {
  let out = text;
  for (const { find, replace } of replacements) {
    const occurrences = out.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Expected ${JSON.stringify(find)} to appear exactly once in the note, found ${occurrences} ` +
          `(note text: ${JSON.stringify(out)})`,
      );
    }
    out = out.replace(find, replace);
  }
  return out;
}

/** The planted document, uncompressed, and the visible text it carries. */
export function buildSeparatorPlant(
  originalRaw: Uint8Array,
  replacements: readonly SeparatorReplacement[],
  replicaId: Uint8Array,
): { raw: Uint8Array; oldText: string; newText: string } {
  const doc = parseNoteDocument(originalRaw);
  const oldText = doc.text;
  const newText = applySeparatorReplacements(oldText, replacements);
  if (!applyTextEdit(doc, newText, { replicaId })) {
    throw new Error("buildSeparatorPlant: applyTextEdit reported no change");
  }
  return { raw: encodeNoteDocument(doc), oldText, newText };
}

/** The note's stored visible text, straight off the record - for asserting what iCloud holds, not what a clone rendered. */
export async function readStoredNoteText(vaultDir: string, noteId: string): Promise<string> {
  const record = await fetchNote(await resolveHarnessAccount(vaultDir), noteId);
  return parseNoteDocument(decompressNoteDocument(noteTextData(record, noteId))).text;
}

export interface PlantSeparatorsOptions {
  /** A clone bound to the account that owns the note - the source of both the session and the replica id. */
  vaultDir: string;
  /** The note's CloudKit record name (a file's `apple-note-id`). */
  noteId: string;
  replacements: readonly SeparatorReplacement[];
}

export interface PlantedSeparators {
  oldText: string;
  newText: string;
  result: RecordUpdateResult;
}

/**
 * Fetches the note, swaps its separators, and writes it back through the
 * ordinary `records/modify` update path with the record's own change tag -
 * the same call `push` makes.
 *
 * Private-database notes only: this is a test fixture, not a general writer.
 */
export async function plantSeparators(options: PlantSeparatorsOptions): Promise<PlantedSeparators> {
  // Resolved in-process, without the ability to log in interactively - see
  // `harnessAccount.ts` for why that matters mid-run.
  const account = await resolveHarnessAccount(options.vaultDir);
  const { session, ckdatabasewsUrl, dsid, zone, replicaId } = account;
  const record = await fetchNote(account, options.noteId);
  const changeTag = record.recordChangeTag;
  if (changeTag === undefined) {
    throw new Error(`Note record ${options.noteId} came back without a recordChangeTag`);
  }

  const raw = decompressNoteDocument(noteTextData(record, options.noteId));
  const planted = buildSeparatorPlant(raw, options.replacements, replicaId);

  const fields = buildNoteUpdateFields(record, compressNoteDocument(planted.raw).toString("base64"), planted.newText, Date.now());
  const [result] = await updateRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [
    { recordName: options.noteId, recordType: "Note", recordChangeTag: changeTag, fields },
  ]);
  if (!result) {
    throw new Error("records/modify returned no result for the planted separators");
  }
  return { oldText: planted.oldText, newText: planted.newText, result };
}

async function fetchNote({ session, ckdatabasewsUrl, dsid, zone }: HarnessAccount, noteId: string): Promise<CloudKitRecord> {
  const [record] = await lookupRecords(session, ckdatabasewsUrl, dsid, zone.database, zone.zoneID, [noteId]);
  if (!record) {
    throw new Error(`Note record ${noteId} was not found`);
  }
  return record;
}

function noteTextData(record: CloudKitRecord, noteId: string): Buffer {
  const textData = record.fields.TextDataEncrypted?.value;
  if (typeof textData !== "string") {
    throw new Error(`Note record ${noteId} has no readable TextDataEncrypted`);
  }
  return Buffer.from(textData, "base64");
}
