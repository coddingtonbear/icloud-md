import chalk from "chalk";
import { resolveFolderAccount } from "../auth/folderAuth.js";
import type { IcloudSession } from "../session.js";
import {
  fetchAllZoneRecords,
  forceDeleteRecord,
  lookupRecords,
  updateNoteRecord,
  type CloudKitRecord,
} from "../cloudkit/databaseClient.js";
import { readCloneState, writeCloneState, type CloneState } from "../notes/cloneState.js";
import { classifyNoteRecord } from "../notes/decodeNoteRecord.js";
import {
  NoteDeleteRejectedError,
  NotClonedDirectoryError,
  NotesUnavailableError,
  ObjectDeleteNeedsConfirmationError,
  ObjectForceDeleteBlockedError,
  UnknownObjectError,
} from "../errors.js";
import { buildNotePurgeFields, buildNoteTrashFields } from "../notes/encodeNoteRecord.js";
import { noteDocumentRoundTrips } from "../notes/noteDocument.js";
import { decompressNoteDocument } from "../notes/noteText.js";
import { applyLocalNoteDeletion, isInTrash, isPurged } from "./delete.js";

const PRIVATE_NOTES_ZONE = { zoneName: "Notes" };

/**
 * The `object` command family: record-level plumbing for inspecting and
 * deleting raw CloudKit objects by ID, deliberately separate from the
 * file-path porcelain (`delete <file>`, `push`). Exists first and foremost
 * as the repair kit for broken note objects this tool may create - ones
 * that can break the Apple Notes UI itself - so nothing here ever requires
 * a record's content to parse. See the project notes (2026-07-16T11:10).
 */

export interface ObjectCommandOptions {
  onLoginStatus?: (message: string) => void;
}

export type ObjectLifecycleState = "live" | "trashed" | "purged" | "tombstone";

/** Everything `object list` derives per record - pure data, so the
 * derivation is testable without a network and `--json` is just
 * serialization. */
export interface ObjectInfo {
  recordName: string;
  recordType: string;
  state: ObjectLifecycleState;
  /** CloudKit record metadata (ms epoch) - who-wrote-when bookkeeping,
   * distinct from the Notes-level CreationDate/ModificationDate fields. */
  createdAt?: number | undefined;
  modifiedAt?: number | undefined;
  /** Decoded TitleEncrypted, when present and decodable. */
  title?: string | undefined;
  /** Outgoing references: recordNames this record points at (its folder,
   * its owning note, ...), from a generic scan of reference-shaped fields. */
  references: string[];
  /** How many other records in the zone point at this one - the count that
   * decides whether a `forceDelete` would be rejected. */
  referencedBy: number;
  /** The vault file this record corresponds to per state.json (a tracked
   * note's file, or a downloaded attachment's), if any. */
  trackedFile?: string | undefined;
  /** Note records only: whether this tool can actually make sense of the
   * record - the discovery signal for `--broken`. */
  health?: string | undefined;
}

export interface ObjectListFilters {
  type?: string | undefined;
  broken?: boolean;
  orphaned?: boolean;
  trashed?: boolean;
  untracked?: boolean;
  json?: boolean;
}

export async function runObjectList(
  targetDir: string,
  filters: ObjectListFilters = {},
  options: ObjectCommandOptions = {},
): Promise<void> {
  const { state, auth } = await resolveObjectAuth(targetDir, options);
  const records = await fetchAllZoneRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid);
  const index = buildObjectIndex(records, state);
  const filtered = applyObjectFilters(index, filters);

  if (filters.json === true) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  for (const line of renderObjectList(filtered)) {
    console.log(line);
  }
}

/** One incoming reference as `object show` reports it: enough to identify
 * the referrer and judge whether it matters (a live Attachment blocks a
 * forceDelete; a tombstone doesn't). */
export interface IncomingReference {
  recordName: string;
  recordType: string;
  title?: string | undefined;
  state: ObjectLifecycleState;
}

export async function runObjectShow(
  targetDir: string,
  recordName: string,
  options: ObjectCommandOptions = {},
): Promise<void> {
  const { state, auth } = await resolveObjectAuth(targetDir, options);
  // A full zone walk rather than a single-record lookup: `show` is the
  // "look before you shoot" step, and the question that matters before a
  // delete is "who references this?" - answerable only from the whole zone.
  const records = await fetchAllZoneRecords(auth.session, auth.ckdatabasewsUrl, auth.dsid);
  const record = records.find((candidate) => candidate.recordName === recordName);
  if (!record) {
    throw new UnknownObjectError(recordName);
  }
  const index = buildObjectIndex(records, state);
  const info = index.find((candidate) => candidate.recordName === recordName);
  console.log(
    JSON.stringify({ ...info, record, incomingReferences: findIncomingReferences(index, recordName) }, null, 2),
  );
}

/** Every record in `index` holding a reference to `recordName` - the
 * by-name answer behind `object list`'s bare `<- N ref(s)` count. Exported
 * for tests; shared by `object show` and the `--force` cascade. */
export function findIncomingReferences(index: ObjectInfo[], recordName: string): IncomingReference[] {
  return index
    .filter((info) => info.recordName !== recordName && info.references.includes(recordName))
    .map((info) => ({ recordName: info.recordName, recordType: info.recordType, title: info.title, state: info.state }));
}

export interface ObjectDeleteOptions extends ObjectCommandOptions {
  /** Required for structural record types (Folders), where a typo'd ID has
   * a blast radius beyond the record itself. */
  yes?: boolean;
  /**
   * True immediate removal via `forceDelete`, cascading over leaf-type
   * referrers - the "this record is poison, get it out of the sync stream
   * NOW" escape hatch. Unlike the default two-stage purge (which only marks
   * the record and leaves its fields in `changes/zone` until server GC), a
   * forceDelete tombstones the record immediately - the only state
   * guaranteed safe when the record's content itself crashes Notes clients.
   */
  force?: boolean;
}

/** Record types whose deletion detaches or destroys things beyond the
 * record itself - these require an explicit --yes. */
const NEEDS_CONFIRMATION_TYPES = new Set(["Folder", "Folder_UserSpecific"]);

/**
 * Record types the `--force` cascade may delete on its own to unblock the
 * target: per-note leaves whose whole existence hangs off the record being
 * deleted. A Folder or another Note showing up as a blocker is collateral,
 * not cleanup - the cascade refuses and reports instead.
 */
export function isCascadableType(recordType: string): boolean {
  return (
    recordType === "Attachment" ||
    recordType === "Media" ||
    recordType === "InlineAttachment" ||
    recordType.endsWith("_UserSpecific")
  );
}

export async function runObjectDelete(
  targetDir: string,
  recordName: string,
  options: ObjectDeleteOptions = {},
): Promise<void> {
  const { state, auth } = await resolveObjectAuth(targetDir, options);
  const { session, dsid } = auth;
  const ckdatabasewsUrl = auth.ckdatabasewsUrl;

  const records = await lookupRecords(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, [recordName]);
  const record = records[0];
  if (!record) {
    throw new UnknownObjectError(recordName, { maybeDeleted: true });
  }

  const [info] = buildObjectIndex([record], state);
  const label = `${record.recordType} ${recordName}${info?.title ? ` ("${info.title}")` : ""}`;

  if (record.deleted === true || (isPurged(record) && options.force !== true)) {
    await forgetObjectLocally(targetDir, recordName, state);
    console.log(`${label}: already permanently deleted - nothing to do remotely.`);
    return;
  }

  if (NEEDS_CONFIRMATION_TYPES.has(record.recordType) && options.yes !== true) {
    throw new ObjectDeleteNeedsConfirmationError(record.recordType, recordName);
  }

  if (options.force === true) {
    await forceDeleteWithCascade(session, ckdatabasewsUrl, dsid, state, label, record);
    await forgetObjectLocally(targetDir, recordName, state);
    return;
  }

  if (record.recordType === "Note") {
    // Apple's own two-stage deletion (trash-move update, then Deleted: 1) -
    // works regardless of attachments and never parses content, so it can't
    // be defeated by the very brokenness this command exists to clean up.
    console.log(`Deleting ${label} via Apple's two-stage purge...`);
    let current = record;
    if (!isInTrash(current)) {
      const trashResult = await updateNoteRecord(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, {
        recordName,
        recordChangeTag: current.recordChangeTag ?? "",
        fields: buildNoteTrashFields(current, Date.now()),
        parentRecordName: current.parentRecordName,
      });
      if (!trashResult.ok) {
        throw new NoteDeleteRejectedError(recordName, trashResult.serverErrorCode, trashResult.reason);
      }
      current = trashResult.record;
    }
    const purgeResult = await updateNoteRecord(session, ckdatabasewsUrl, dsid, "private", PRIVATE_NOTES_ZONE, {
      recordName,
      recordChangeTag: current.recordChangeTag ?? "",
      fields: buildNotePurgeFields(current, Date.now()),
      parentRecordName: current.parentRecordName,
    });
    if (!purgeResult.ok) {
      throw new NoteDeleteRejectedError(recordName, purgeResult.serverErrorCode, purgeResult.reason);
    }
    await forgetObjectLocally(targetDir, recordName, state);
    console.log(`Permanently deleted ${label}.`);
    return;
  }

  // Non-Note records have no captured deletion precedent - forceDelete is
  // the only primitive there is, live-verified to work when nothing still
  // references the target (the server rejects it otherwise, which is
  // surfaced as the error below rather than pre-checked).
  console.log(`Force-deleting ${label}...`);
  const result = await forceDeleteRecord(
    session,
    ckdatabasewsUrl,
    dsid,
    PRIVATE_NOTES_ZONE,
    recordName,
    record.recordType,
    record.recordChangeTag ?? "",
  );
  if (!result.ok) {
    throw rejectionWithBlockerHint(recordName, result.serverErrorCode, result.reason);
  }
  await forgetObjectLocally(targetDir, recordName, state);
  console.log(`Permanently deleted ${label}.`);
}

/**
 * A `VALIDATING_REFERENCE_ERROR` reason names the blocking record's
 * recordID (observed live 2026-07-16: "recordID=<uuid> ... Record delete
 * would violate validating reference") - so even a failed delete can tell
 * the user exactly what stands in the way and what to run next. Exported
 * for tests.
 */
export function rejectionWithBlockerHint(
  recordName: string,
  serverErrorCode: string,
  reason: string | undefined,
): NoteDeleteRejectedError {
  const error = new NoteDeleteRejectedError(recordName, serverErrorCode, reason);
  if (serverErrorCode !== "VALIDATING_REFERENCE_ERROR" || reason === undefined) {
    return error;
  }
  const blocker = /recordID=([0-9A-Za-z-]+)/.exec(reason)?.[1];
  if (!blocker) {
    return error;
  }
  return new NoteDeleteRejectedError(
    recordName,
    serverErrorCode,
    `${reason} - blocked by ${blocker}; "icloud-notes object show ${recordName}" lists every referrer, ` +
      `"icloud-notes object delete ${blocker}" removes this one`,
  );
}

/**
 * The `--force` path: `forceDelete` the target, and if the server refuses
 * because live records still reference it, delete those referrers first
 * (leaf types only - see `isCascadableType`) and retry. Sequential
 * single-record deletes throughout, staying on the one forceDelete shape
 * that's been live-verified; the referrer set comes from a fresh full zone
 * walk using the same reference scan `object show` reports.
 */
async function forceDeleteWithCascade(
  session: IcloudSession,
  ckdatabasewsUrl: string,
  dsid: string,
  state: CloneState,
  label: string,
  record: CloudKitRecord,
): Promise<void> {
  console.log(`Force-deleting ${label}...`);
  const first = await forceDeleteRecord(
    session,
    ckdatabasewsUrl,
    dsid,
    PRIVATE_NOTES_ZONE,
    record.recordName,
    record.recordType,
    record.recordChangeTag ?? "",
  );
  if (first.ok) {
    console.log(`Permanently deleted ${label}.`);
    return;
  }
  if (first.serverErrorCode !== "VALIDATING_REFERENCE_ERROR") {
    throw new NoteDeleteRejectedError(record.recordName, first.serverErrorCode, first.reason);
  }

  console.log("Blocked by validating references - walking the zone to find every referrer...");
  const records = await fetchAllZoneRecords(session, ckdatabasewsUrl, dsid);
  const index = buildObjectIndex(records, state);
  const referrers = findIncomingReferences(index, record.recordName).filter(
    (referrer) => referrer.state !== "tombstone",
  );
  const blockers = referrers.filter((referrer) => !isCascadableType(referrer.recordType));
  if (blockers.length > 0) {
    throw new ObjectForceDeleteBlockedError(record.recordName, blockers);
  }

  const recordsByName = new Map(records.map((candidate) => [candidate.recordName, candidate]));
  for (const referrer of referrers) {
    const referrerRecord = recordsByName.get(referrer.recordName);
    const result = await forceDeleteRecord(
      session,
      ckdatabasewsUrl,
      dsid,
      PRIVATE_NOTES_ZONE,
      referrer.recordName,
      referrer.recordType,
      referrerRecord?.recordChangeTag ?? "",
    );
    if (!result.ok) {
      throw rejectionWithBlockerHint(referrer.recordName, result.serverErrorCode, result.reason);
    }
    delete state.attachments?.[referrer.recordName];
    delete state.tableAttachments?.[referrer.recordName];
    console.log(`  deleted ${referrer.recordType} ${referrer.recordName}${referrer.title ? ` ("${referrer.title}")` : ""}`);
  }

  const retry = await forceDeleteRecord(
    session,
    ckdatabasewsUrl,
    dsid,
    PRIVATE_NOTES_ZONE,
    record.recordName,
    record.recordType,
    record.recordChangeTag ?? "",
  );
  if (!retry.ok) {
    throw rejectionWithBlockerHint(record.recordName, retry.serverErrorCode, retry.reason);
  }
  console.log(`Permanently deleted ${label} and ${referrers.length} referencing record(s).`);
}

async function resolveObjectAuth(targetDir: string, options: ObjectCommandOptions) {
  const state = await readCloneState(targetDir);
  if (!state) {
    throw new NotClonedDirectoryError(targetDir);
  }
  const auth = await resolveFolderAccount(targetDir, state.account, { onStatus: options.onLoginStatus });
  if (!auth.ckdatabasewsUrl) {
    throw new NotesUnavailableError();
  }
  return { state, auth: { session: auth.session, dsid: auth.dsid, ckdatabasewsUrl: auth.ckdatabasewsUrl } };
}

/** Drops whatever local tracking points at a now-deleted record: the note
 * entry (with full file cleanup), the trash-registry entry, and/or the
 * attachment entry (its downloaded file is left on disk). */
async function forgetObjectLocally(targetDir: string, recordName: string, state: CloneState): Promise<void> {
  const entry = state.notes[recordName];
  if (entry) {
    await applyLocalNoteDeletion(targetDir, recordName, entry, state);
  }
  delete state.trashed?.[recordName];
  delete state.attachments?.[recordName];
  delete state.tableAttachments?.[recordName];
  await writeCloneState(targetDir, state);
}

/** Pure derivation of everything `object list` shows - exported for tests. */
export function buildObjectIndex(records: CloudKitRecord[], state: CloneState): ObjectInfo[] {
  const referenceCounts = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const record of records) {
    const references = collectReferences(record);
    outgoing.set(record.recordName, references);
    for (const target of references) {
      referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1);
    }
  }

  return records.map((record) => ({
    recordName: record.recordName,
    recordType: record.recordType,
    state: lifecycleState(record),
    createdAt: record.created?.timestamp,
    modifiedAt: record.modified?.timestamp,
    title: decodeTitle(record),
    references: outgoing.get(record.recordName) ?? [],
    referencedBy: referenceCounts.get(record.recordName) ?? 0,
    trackedFile: state.notes[record.recordName]?.file ?? state.attachments?.[record.recordName]?.file,
    health: noteHealth(record),
  }));
}

export function applyObjectFilters(index: ObjectInfo[], filters: ObjectListFilters): ObjectInfo[] {
  const known = new Set(index.filter((info) => info.state === "live" || info.state === "trashed").map((info) => info.recordName));
  return index.filter((info) => {
    if (filters.type !== undefined && info.recordType.toLowerCase() !== filters.type.toLowerCase()) {
      return false;
    }
    if (filters.broken === true && !(info.health !== undefined && info.health !== "ok")) {
      return false;
    }
    if (filters.orphaned === true && !info.references.some((target) => !known.has(target))) {
      return false;
    }
    if (filters.trashed === true && info.state !== "trashed" && info.state !== "purged") {
      return false;
    }
    if (filters.untracked === true && !(info.recordType === "Note" && info.state === "live" && info.trackedFile === undefined)) {
      return false;
    }
    return true;
  });
}

export function renderObjectList(index: ObjectInfo[]): string[] {
  if (index.length === 0) {
    return ["No matching objects."];
  }
  const sorted = [...index].sort(
    (a, b) => a.recordType.localeCompare(b.recordType) || (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0),
  );
  const lines: string[] = [];
  for (const info of sorted) {
    const modified = info.modifiedAt !== undefined ? new Date(info.modifiedAt).toISOString().slice(0, 16) : "-".padEnd(16);
    const describe = info.trackedFile ?? (info.title !== undefined ? `"${info.title}"` : "");
    const refs =
      info.references.length > 0
        ? ` -> ${info.references.map(shortenRecordName).join(", ")}`
        : "";
    const referenced = info.referencedBy > 0 ? ` <- ${info.referencedBy} ref(s)` : "";
    lines.push(
      `${info.recordName}  ${info.recordType.padEnd(14)} ${colorState(info.state).padEnd(10)} ${modified}  ${describe}${refs}${referenced}`,
    );
    if (info.health !== undefined && info.health !== "ok") {
      lines.push(chalk.magenta(`  ! ${info.health}`));
    }
  }
  const counts = new Map<string, number>();
  for (const info of index) {
    counts.set(info.recordType, (counts.get(info.recordType) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  lines.push(`${index.length} object(s): ${summary}`);
  return lines;
}

function colorState(state: ObjectLifecycleState): string {
  switch (state) {
    case "live":
      return chalk.green(state);
    case "trashed":
      return chalk.yellow(state);
    case "purged":
    case "tombstone":
      return chalk.red(state);
  }
}

function shortenRecordName(recordName: string): string {
  return recordName.length > 12 ? `${recordName.slice(0, 8)}...` : recordName;
}

function lifecycleState(record: CloudKitRecord): ObjectLifecycleState {
  if (record.deleted === true) {
    return "tombstone";
  }
  if (isPurged(record)) {
    return "purged";
  }
  if (isInTrash(record)) {
    return "trashed";
  }
  return "live";
}

function decodeTitle(record: CloudKitRecord): string | undefined {
  const raw = record.fields.TitleEncrypted?.value;
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

/** Generic scan for reference-shaped field values ({recordName: ...} or
 * lists of them), so references show up for record types this tool has
 * never seen before - exactly the situation a diagnostic tool is for. */
function collectReferences(record: CloudKitRecord): string[] {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      const recordName = (value as Record<string, unknown>).recordName;
      if (typeof recordName === "string") {
        references.add(recordName);
      }
    }
  };
  for (const field of Object.values(record.fields)) {
    visit(field.value);
  }
  if (record.parentRecordName !== undefined) {
    references.add(record.parentRecordName);
  }
  return [...references];
}

/** Note records only: can this tool actually make sense of the record?
 * Everything short of "ok" is what `object list --broken` surfaces. */
function noteHealth(record: CloudKitRecord): string | undefined {
  if (record.recordType !== "Note" || record.deleted === true) {
    return undefined;
  }
  const classified = classifyNoteRecord(record);
  if (classified.status === "deleted") {
    // Trashed/purged but structurally still a note - health still applies.
    if (typeof record.fields.TextDataEncrypted?.value !== "string") {
      return "no readable text data";
    }
  }
  if (classified.status === "unsyncable") {
    return "undecodable: the note document doesn't parse with this tool's model";
  }
  if (classified.status === "ok" && !classified.publishable) {
    return `contains content this tool can't parse${classified.unpublishableReason ? ` (${classified.unpublishableReason})` : ""}`;
  }
  const raw = record.fields.TextDataEncrypted?.value;
  if (typeof raw === "string") {
    try {
      if (!noteDocumentRoundTrips(new Uint8Array(decompressNoteDocument(Buffer.from(raw, "base64"))))) {
        return "doesn't round-trip byte-for-byte through this tool's model";
      }
    } catch {
      return "text data fails to decompress";
    }
  }
  return "ok";
}
